'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {pendingCardNotice}=require('../hooks/pending-card-notice.js');
const {handle,statePath}=require('../../codex-plugins/priors-hooks/hooks/retention-runtime.js');
const sid=crypto.randomUUID(),tid=crypto.randomUUID();
const ref=(id='GEN-1',version=1)=>({role:'primary',id,version});
const saved=(card={state:'pending'})=>({operation:'remember',outcome_code:'recorded',resource_ids:[ref()],search_card:card,body:'PRIVATE-BODY',search_summary:'PRIVATE-SUMMARY'});
const wrap=r=>({content:[{type:'text',text:JSON.stringify(r)}]});
const notice=(r,name='remember')=>pendingCardNotice('mcp__priors__'+name,wrap(r));
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'priors-card-notice-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('pending gives only fixed guidance and bound ID/version; ok and older servers stay silent',()=>{
 assert.match(notice(saved()),/検索カード未作成: GEN-1@1。本文を書き直さず/);
 assert.equal(notice(saved({state:'ok'})),'');const r=saved();delete r.search_card;assert.equal(notice(r),'');
 const err=saved({state:'pending',error:{code:'invalid_input',reason:'PRIVATE-REASON',token:'FAKE-TOKEN',search_summary:'PRIVATE-SUMMARY'}});
 assert.equal(notice(err),notice(saved()));assert.doesNotMatch(notice(err),/PRIVATE|FAKE|token|reason/);
});
test('capture reports only recorded pending items, not ok failed unbound or duplicate targets',()=>{
 const r={operation:'capture',outcome_code:'applied',resource_ids:[ref(),ref('GEN-2')],items:[
  {...ref(),outcome_code:'recorded',search_card:{state:'pending'}},
  {...ref('GEN-2'),outcome_code:'recorded',search_card:{state:'ok'}},
  {...ref('GEN-3'),outcome_code:'refused',search_card:{state:'pending'}},
  {...ref('GEN-4'),outcome_code:'recorded',search_card:{state:'pending'}}]};
 assert.match(notice(r,'capture'),/GEN-1@1/);assert.doesNotMatch(notice(r,'capture'),/GEN-[234]/);
 r.items.push(r.items[0]);assert.equal(notice(r,'capture').match(/GEN-1@1/g).length,1);
});
test('amend and real maintain revise/split/merge response shapes bind only saved outputs',()=>{
 const r={...saved(),operation:'amend.revise',outcome_code:'applied'};
 assert.match(notice(r,'amend'),/GEN-1@1/);assert.match(notice(r,'maintain'),/GEN-1@1/);
 for(const op of ['split','merge']){
  const m={operation:'amend.'+op,outcome_code:'applied',resource_ids:[
   {...ref('GEN-2'),search_card:{state:'pending'}},{...ref('GEN-3'),search_card:{state:'ok'}},
   {role:'superseded',id:'GEN-1',search_card:{state:'pending'}}]};
  assert.match(notice(m,'maintain'),/GEN-2@1/);assert.doesNotMatch(notice(m,'maintain'),/GEN-[13]/);
 }
 assert.equal(notice({...r,operation:'amend.retract'},'maintain'),'');
});
test('replays failures malformed wrappers unknown tools and unsafe references never produce guidance',()=>{
 for(const r of [{...saved(),replayed:true},{...saved(),__server_replayed:true},{...saved(),outcome_code:'refused'},
  {...saved(),resource_ids:[ref('PRIVATE-TEXT')]},{...saved(),resource_ids:[ref('GEN-1',0)]}])assert.equal(notice(r),'');
 assert.equal(pendingCardNotice('mcp__priors__remember',{isError:true,...wrap(saved())}),'');
 assert.equal(pendingCardNotice('mcp__priors__remember',{content:[{type:'text',text:'not json'}]}),'');
 assert.equal(notice(saved(),'get'),'');assert.equal(notice(saved(),'summary_record'),'');
});
test('Claude executable appends pending guidance but keeps old success text; no sensitive local persistence',t=>{
 const dir=temp(t),env={...process.env,PRIORS_DECISION_AUDIT_FILE:path.join(dir,'audit.jsonl'),PRIORS_PROACTIVE_CANDIDATE_FILE:path.join(dir,'candidates.jsonl'),PRIORS_COMPACT_CHECKPOINT_FILE:path.join(dir,'compact.json'),PRIORS_PENDING_CARD_FILE:path.join(dir,'pending-cards.json'),PRIORS_TURN_STATE_FILE:path.join(dir,'turn-state.json'),PRIORS_STOP_DIAGNOSTIC_FILE:path.join(dir,'stop.jsonl')};
 const run=(r,extra={})=>spawnSync(process.execPath,[path.resolve(__dirname,'../hooks/post-tool-save.js')],{env,encoding:'utf8',input:JSON.stringify({session_id:sid,hook_event_name:'PostToolUse',tool_name:'mcp__priors__remember',tool_input:{body:'PRIVATE-INPUT'},tool_response:wrap(r),...extra})});
 const ok=run(saved({state:'ok'})),pending=run(saved({state:'pending',error:{token:'FAKE-TOKEN'}}));
 // the ledger went to the temporary file, not the real ~/.priors/pending-cards.json
 assert.ok(fs.existsSync(env.PRIORS_PENDING_CARD_FILE));
 assert.equal(ok.status,0);assert.equal(pending.status,0);assert.equal(JSON.parse(pending.stdout).hookSpecificOutput.additionalContext,JSON.parse(ok.stdout).hookSpecificOutput.additionalContext+notice(saved()));
 assert.equal(run({...saved(),replayed:true}).stdout,'');
 assert.match(run(saved(),{agent_id:'agent-1'}).stdout,/GEN-1@1/); // existing Claude subagent-save rule
 const maintain={operation:'amend.split',outcome_code:'applied',resource_ids:[{...ref(),search_card:{state:'pending'}}]};
 assert.match(run(maintain,{tool_name:'mcp__priors__maintain'}).stdout,/検索カード未作成/);
 for(const f of fs.readdirSync(dir))assert.doesNotMatch(fs.readFileSync(path.join(dir,f),'utf8'),/PRIVATE|FAKE-TOKEN|search_summary/);
});
test('Codex executable runtime keeps success silent; pending guidance preserves acknowledgement and ID-only state',t=>{
 const dir=temp(t),env={PLUGIN_DATA:dir};
 handle({session_id:sid,turn_id:tid,hook_event_name:'UserPromptSubmit',prompt:'今後は短く回答する方針を採用'},env);
 const before=JSON.parse(fs.readFileSync(statePath(env),'utf8')).sessions[0].turns[0];
 const input={session_id:sid,turn_id:tid,hook_event_name:'PostToolUse',tool_name:'mcp__priors__remember',tool_input:{body:'PRIVATE-INPUT',candidate_id:before.candidate_id},tool_response:saved()};
 input.tool_response.candidate_receipts=[{candidate_id:before.candidate_id,resource_ids:['GEN-1@1']}];
 assert.match(handle(input,env).hookSpecificOutput.additionalContext,/GEN-1@1/);
 assert.equal(JSON.parse(fs.readFileSync(statePath(env),'utf8')).sessions[0].turns[0].acknowledged,true);
 assert.equal(handle({...input,tool_response:saved({state:'ok'})},env),null);
 assert.equal(handle({...input,agent_id:'agent-1'},env),null);
 assert.equal(handle({...input,tool_response:{...saved(),replayed:true}},env),null);
 assert.equal(handle({...input,turn_id:crypto.randomUUID()},env),null);
 const m={operation:'amend.merge',outcome_code:'applied',resource_ids:[{...ref(),search_card:{state:'pending'}}]};
 assert.match(handle({...input,tool_name:'mcp__priors__maintain',tool_response:m},env).hookSpecificOutput.additionalContext,/GEN-1@1/);
 assert.doesNotMatch(fs.readFileSync(statePath(env),'utf8'),/PRIVATE|search_summary|search_card/);
});

test('both installed PostToolUse matchers route maintain to the executable without widening save audit',t=>{
 const {parseSavedResponse}=require('../hooks/save-response.js');
 const r={operation:'amend.split',outcome_code:'applied',resource_ids:[{...ref(),search_card:{state:'pending'}}]};
 assert.equal(parseSavedResponse('mcp__priors__maintain',r),null);
 for(const [client,root]of [['claude',path.resolve(__dirname,'..')],['codex',path.resolve(__dirname,'../../codex-plugins/priors-hooks')]]){
  const dir=temp(t),env={...process.env,PLUGIN_DATA:dir,PRIORS_DECISION_AUDIT_FILE:path.join(dir,'audit.jsonl'),PRIORS_PROACTIVE_CANDIDATE_FILE:path.join(dir,'candidates.jsonl'),PRIORS_PENDING_CARD_FILE:path.join(dir,'pending-cards.json'),PRIORS_TURN_STATE_FILE:path.join(dir,'turn-state.json'),PRIORS_STOP_DIAGNOSTIC_FILE:path.join(dir,'stop.jsonl')};
  const groups=JSON.parse(fs.readFileSync(path.join(root,'hooks/hooks.json'),'utf8')).hooks.PostToolUse;
  const matched=groups.filter(g=>new RegExp(g.matcher).test('mcp__priors__maintain'));
  assert.equal(matched.length,1,client+' must select maintain');assert.equal(matched[0].hooks.length,1);
  assert.match(matched[0].hooks[0].command,/\/hooks\/post-tool-save\.js/);
  if(client==='codex')handle({session_id:sid,turn_id:tid,hook_event_name:'UserPromptSubmit',prompt:'こんにちは'},env);
  const input={session_id:sid,turn_id:tid,hook_event_name:'PostToolUse',tool_name:'mcp__priors__maintain',tool_response:r};
  const out=spawnSync(process.execPath,[path.join(root,'hooks/post-tool-save.js')],{env,encoding:'utf8',input:JSON.stringify(input)});
  assert.equal(out.status,0);assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext,/検索カード未作成: GEN-1@1/);
  if(client==='claude')assert.equal(fs.existsSync(env.PRIORS_DECISION_AUDIT_FILE),false);
  else assert.deepEqual(JSON.parse(fs.readFileSync(statePath(env),'utf8')).sessions[0].turns[0].saves,[]);
 }
});
