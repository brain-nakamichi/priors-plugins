'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {inspectSensitiveInput}=require('./shared/sensitive-input.js');
const {proactiveSignals,isHarnessMessage}=require('./shared/retention-signals.js');
const {parseSavedResponse}=require('./shared/save-response.js');
const checkpoint=require('./shared/compact-checkpoint.js');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES=65536,MAX_SESSIONS=16,MAX_TURNS=8,MAX_SAVES=20,TTL=7*86400000;
const CATEGORIES=['remember-candidate','continuing-request-candidate','unresolved-candidate'];
const SAVE_REF=/^(?:[A-Z][A-Z0-9]{1,7}-(?:c|w)?[0-9]+|[0-9a-f-]{36})@[1-9][0-9]{0,9}$/i;
const CANDIDATE=/^pc-[0-9a-f]{12}-[0-9a-f]{8}-[a-z-]{1,120}$/;
function statePath(env){env=require('./state-environment.js').stateEnvironment(env);return env.PRIORS_CODEX_HOOK_STATE_FILE?path.resolve(env.PRIORS_CODEX_HOOK_STATE_FILE):
 path.join(env.PLUGIN_DATA||path.join(os.homedir(),'.priors','codex'),'retention-state.json');}
function ownKeys(v,keys){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));}
function validState(s){return ownKeys(s,['schema','sessions'])&&s.schema===1&&Array.isArray(s.sessions)&&s.sessions.length<=MAX_SESSIONS&&s.sessions.every(x=>
 ownKeys(x,['session_id','turns'])&&UUID.test(x.session_id)&&Array.isArray(x.turns)&&x.turns.length<=MAX_TURNS&&x.turns.every(t=>
 ownKeys(t,['turn_id','at','candidate_id','categories','acknowledged','stop_notified','next_notified','saves'])&&UUID.test(t.turn_id)&&Number.isFinite(t.at)&&
 (!t.candidate_id||CANDIDATE.test(t.candidate_id))&&Array.isArray(t.categories)&&t.categories.every(c=>CATEGORIES.includes(c))&&
 ['acknowledged','stop_notified','next_notified'].every(k=>typeof t[k]==='boolean')&&Array.isArray(t.saves)&&t.saves.length<=MAX_SAVES&&t.saves.every(r=>
 ownKeys(r,['tool','ids'])&&/^[a-z_]{1,48}$/.test(r.tool)&&Array.isArray(r.ids)&&r.ids.length<=20&&r.ids.every(id=>SAVE_REF.test(id)))));}
function transact(env,fn){
 const file=statePath(env),lock=file+'.lock',tmp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';let held=false;
 try{
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.mkdirSync(lock,{mode:0o700});held=true;
  let state={schema:1,sessions:[]};
  if(fs.existsSync(file)){
   const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>MAX_BYTES)return null;
   state=JSON.parse(fs.readFileSync(file,'utf8'));if(!validState(state))return null;
  }
  for(const s of state.sessions)s.turns=s.turns.filter(t=>t.at<=Date.now()&&t.at>Date.now()-TTL);
  state.sessions=state.sessions.filter(s=>s.turns.length);
  const output=fn(state);
  const text=JSON.stringify(state);if(Buffer.byteLength(text)>MAX_BYTES||!validState(state))return null;
  fs.writeFileSync(tmp,text+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});fs.renameSync(tmp,file);
  try{fs.chmodSync(file,0o600);}catch{/* Windows ACLs remain host-controlled. */}
  return output;
 }catch{return null;}finally{
  try{fs.unlinkSync(tmp);}catch{}if(held)try{fs.rmdirSync(lock);}catch{}
 }
}
// Do not inspect transcripts or last_assistant_message. Event provenance is checked before classification.
function humanPrompt(input){
 if(input.agent_id||input.agent_type||input.source&& !['user','human'].includes(input.source)||
 input.origin&& !['user','human'].includes(input.origin)||typeof input.prompt!=='string')return null;
 let p=input.prompt.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,'')
  .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/g,'').trim();
 if(!p||isHarnessMessage(p)||/^\s*(?:<|Message Type:|\[SYSTEM NOTIFICATION|Agent status:|The agent task\b)/.test(p))return null;
 // Quoted code and blockquotes are data, not the user's new continuing instruction.
 p=p.replace(/```[\s\S]*?```/g,'').replace(/^\s*>.*$/gm,'').trim();
 if(!p||inspectSensitiveInput(p).state!=='clear')return null;return p;
}
function current(state,input){return state.sessions.find(s=>s.session_id===input.session_id)?.turns.find(t=>t.turn_id===input.turn_id);}
function prompt(input,env){
 const p=humanPrompt(input);if(p===null)return null;
 const categories=proactiveSignals(p).filter(c=>CATEGORIES.includes(c));
 return transact(env,state=>{
  let s=state.sessions.find(s=>s.session_id===input.session_id);
  if(!s){s={session_id:input.session_id,turns:[]};state.sessions.push(s);state.sessions=state.sessions.slice(-MAX_SESSIONS);}
  if(s.turns.some(t=>t.turn_id===input.turn_id))return null;
  const previous=s.turns.findLast(t=>t.candidate_id&&!t.acknowledged&&!t.next_notified);
  if(previous)previous.next_notified=true;
  const t={turn_id:input.turn_id,at:Date.now(),categories,acknowledged:false,stop_notified:false,next_notified:false,saves:[]};
  if(categories.length)t.candidate_id=`pc-${crypto.randomBytes(6).toString('hex')}-${input.turn_id.slice(0,8)}-${categories.join('-')}`;
  if(t.candidate_id)checkpoint.recordCandidate('codex',input.session_id,{id:t.candidate_id,categories},env);
  s.turns.push(t);s.turns=s.turns.slice(-MAX_TURNS);
  const lines=[];
  if(previous)lines.push('Priors: 前ターンの保存候補が未確認です。必要なら出所を確認して扱い、保存済みと推測しないでください。');
  if(t.candidate_id)lines.push(`Priors: 保存候補（${categories.join(' / ')}）。重要なものだけ判断して保存し、成功ID・版を確認してください。今回の候補に対応する保存だけ candidate_id=${t.candidate_id} を指定できます。`);
  return lines.length?{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:lines.join('\n')}}:null;
 });
}
function save(input,env){
 if(input.agent_id||input.agent_type)return null;
 const parsed=parseSavedResponse(input.tool_name,input.tool_response);if(!parsed||!parsed.ids.length)return null;
 return transact(env,state=>{
  const t=current(state,input);if(!t)return null;
  if(!t.saves.some(s=>s.tool===parsed.name&&JSON.stringify(s.ids)===JSON.stringify(parsed.ids)))
   t.saves=[...t.saves,{tool:parsed.name,ids:parsed.ids}].slice(-MAX_SAVES);
  const id=input.tool_input?.candidate_id;
  // Save success is not a coverage claim: only explicit same-turn server-bound receipts resolve this candidate.
  if(t.candidate_id===id&&Array.isArray(parsed.response.candidate_receipts)&&parsed.response.candidate_receipts.some(r=>
   r?.candidate_id===id&&Array.isArray(r.resource_ids)&&r.resource_ids.length>0&&r.resource_ids.every(x=>parsed.ids.includes(x))))t.acknowledged=true;
  checkpoint.recordSave('codex',input.session_id,parsed.ids,t.acknowledged?[id]:[],env);
  return null; // No same success message after every tool.
 });
}
function stop(input,env){
 if(input.stop_hook_active===true||input.agent_id||input.agent_type)return null;
 return transact(env,state=>{
  const t=current(state,input);if(!t||!t.candidate_id||t.acknowledged||t.stop_notified)return null;
  t.stop_notified=true;
  // Informational only. Never block, fabricate a user turn, or automatically write memory.
  return {systemMessage:'Priors: このターンに未確認の保存候補があります。必要なものが残ったか、成功応答のID・版で確認してください。候補は保存済みの証明ではありません。'};
 });
}
function handle(input,env=process.env){
 env=require('./state-environment.js').stateEnvironment(env);
 if(!input||!UUID.test(input.session_id)||!UUID.test(input.turn_id))return null;
 if(input.hook_event_name==='UserPromptSubmit')return prompt(input,env);
 if(input.hook_event_name==='PostToolUse')return save(input,env);
 if(input.hook_event_name==='Stop')return stop(input,env);return null;
}
module.exports={handle,humanPrompt,statePath,MAX_BYTES,MAX_SESSIONS,MAX_TURNS,TTL};
