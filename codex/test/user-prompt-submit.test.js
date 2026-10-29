'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {handle,statePath,MAX_BYTES,MAX_SESSIONS,MAX_TURNS}=require('../hooks/retention-runtime.js');
const sid=crypto.randomUUID(),turn=()=>crypto.randomUUID();
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'priors-codex-retention-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,env:{PLUGIN_DATA:dir},read(){return JSON.parse(fs.readFileSync(statePath({PLUGIN_DATA:dir}),'utf8'));}};}
const start=(id,prompt,extra={})=>({hook_event_name:'UserPromptSubmit',session_id:sid,turn_id:id,prompt,...extra});
const end=id=>({hook_event_name:'Stop',session_id:sid,turn_id:id});
function saved(id,candidate){return {hook_event_name:'PostToolUse',session_id:sid,turn_id:id,tool_name:'mcp__priors__remember',tool_input:{candidate_id:candidate},
 tool_response:{content:[{type:'text',text:JSON.stringify({operation:'remember',outcome_code:'recorded',resource_ids:[{role:'primary',id:'GEN-9',version:2}],
 candidate_receipts:candidate?[{candidate_id:candidate,resource_ids:['GEN-9@2']}]:[],body:'DO-NOT-STORE'})}]}};}
test('Codex queues relevant local metadata, silent ordinary prompts, no text or hash persistence',t=>{
 const x=fixture(t),a=turn();assert.equal(handle(start(a,'こんにちは'),x.env),null);
 const b=turn(),out=handle(start(b,'今後は日本語で簡潔に回答する方針を採用します。PRIVATE-SENTENCE'),x.env);
 assert.match(out.hookSpecificOutput.additionalContext,/保存候補/);const raw=fs.readFileSync(statePath(x.env),'utf8');
 assert.doesNotMatch(raw,/PRIVATE-SENTENCE|日本語|prompt|sha256/);assert.equal(x.read().sessions[0].turns.length,2);
 assert.equal(handle(start(b,'今後は保存する'),x.env),null);
});
test('Codex excludes agent/harness/ambient/code inputs and secret values before recording',t=>{
 const x=fixture(t);
 for(const input of [start(turn(),'今後は方針を採用',{agent_id:'agent-1'}),start(turn(),'今後は方針を採用',{source:'subagent'}),
 start(turn(),'<subagent_notification>今後は方針を採用</subagent_notification>'),start(turn(),'Message Type: FINAL_ANSWER\n今後は方針を採用'),
 start(turn(),'<environment_context>今後は保存</environment_context>'),start(turn(),'```\n今後は保存\n```'),
 start(turn(),'今後は TOKEN=sk-proj-abcdefghijklmnopqrstuvwx を保存する')])assert.equal(handle(input,x.env),null);
 assert.equal(fs.existsSync(statePath(x.env)),false);
});
test('Codex exact successful receipt records only ID/version and suppresses that candidate Stop',t=>{
 const x=fixture(t),id=turn();handle(start(id,'今後は日本語で回答する方針を採用'),x.env);const candidate=x.read().sessions[0].turns[0].candidate_id;
 handle(saved(id,candidate),x.env);const s=x.read().sessions[0].turns[0];assert.equal(s.acknowledged,true);assert.deepEqual(s.saves,[{tool:'remember',ids:['GEN-9@2']}]);
 assert.equal(handle(end(id),x.env),null);assert.doesNotMatch(fs.readFileSync(statePath(x.env),'utf8'),/DO-NOT-STORE|resource_ids|tool_response/);
});
test('Codex unrelated saves, failures, replays, wrong turns or versions never resolve a cue',t=>{
 const x=fixture(t),id=turn();handle(start(id,'今後は日本語で回答する方針を採用'),x.env);const candidate=x.read().sessions[0].turns[0].candidate_id;
 handle(saved(id),x.env);handle(saved(turn(),candidate),x.env);
 for(const mutate of [p=>p.tool_response.isError=true,p=>p.tool_response.structuredContent={operation:'remember',outcome_code:'recorded',resource_ids:[{id:'GEN-9',role:'primary',version:0}]},
 p=>{const v=JSON.parse(p.tool_response.content[0].text);v.replayed=true;p.tool_response.content[0].text=JSON.stringify(v);},
 p=>{const v=JSON.parse(p.tool_response.content[0].text);v.candidate_receipts[0].resource_ids=['GEN-9@1'];p.tool_response.content[0].text=JSON.stringify(v);}]){
 const p=saved(id,candidate);mutate(p);handle(p,x.env);}
 assert.equal(x.read().sessions[0].turns[0].acknowledged,false);assert.ok(handle(end(id),x.env));assert.equal(handle(end(id),x.env),null);
});
test('Codex Stop is advisory, bounded, reentry silent; carry-over is once, never a synthetic user continuation',t=>{
 const x=fixture(t),id=turn();handle(start(id,'重要な方針を採用する'),x.env);
 assert.equal(handle({...end(id),stop_hook_active:true},x.env),null);
 const out=handle(end(id),x.env);assert.deepEqual(Object.keys(out),['systemMessage']);assert.ok(out.systemMessage.length<180);
 assert.equal(handle(end(id),x.env),null);assert.match(handle(start(turn(),'こんにちは'),x.env).hookSpecificOutput.additionalContext,/前ターン/);
 assert.equal(handle(start(turn(),'こんにちは'),x.env),null);
});
test('Codex native turn identity, 7 day expiry, corrupt/busy state and bounds fail softly',t=>{
 const x=fixture(t);assert.equal(handle({...start(turn(),'方針採用'),turn_id:undefined},x.env),null);
 for(let n=0;n<MAX_TURNS+3;n++)handle(start(turn(),'こんにちは'),x.env);
 assert.equal(x.read().sessions[0].turns.length,MAX_TURNS);assert.ok(fs.statSync(statePath(x.env)).size<MAX_BYTES);
 const s=x.read();s.sessions[0].turns[0].at=0;fs.writeFileSync(statePath(x.env),JSON.stringify(s));handle(start(turn(),'こんにちは'),x.env);
 assert.ok(x.read().sessions[0].turns.every(t=>t.at>0));
 fs.mkdirSync(statePath(x.env)+'.lock');const before=fs.readFileSync(statePath(x.env),'utf8');assert.equal(handle(start(turn(),'方針採用'),x.env),null);
 assert.equal(fs.readFileSync(statePath(x.env),'utf8'),before);fs.rmdirSync(statePath(x.env)+'.lock');
 fs.writeFileSync(statePath(x.env),'corrupt');assert.equal(handle(start(turn(),'方針採用'),x.env),null);assert.equal(fs.readFileSync(statePath(x.env),'utf8'),'corrupt');
 assert.equal(MAX_SESSIONS,16);
});
