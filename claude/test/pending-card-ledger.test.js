'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {cardChanges,recordToolResult,pendingCardStopNotice,ledgerPath,MAX_NOTICES,SHOWN}=require('../hooks/pending-card-ledger.js');
const {reminderPayload}=require('../hooks/conversation-end.js');
const sid=crypto.randomUUID();
const wrap=r=>({content:[{type:'text',text:JSON.stringify(r)}]});
const T=n=>'mcp__priors__'+n;
const remembered=(id,version,card)=>wrap({operation:'remember',outcome_code:'recorded',resource_ids:[{role:'primary',id,version}],...(card?{search_card:card}:{}),body:'PRIVATE-BODY'});
const revised=(id,version,card)=>wrap({operation:'amend.revise',outcome_code:'applied',resource_ids:[{role:'primary',id,version}],...(card?{search_card:card}:{})});
const carded=(id,version,state='ok')=>wrap({operation:'search_card',outcome_code:'recorded',id,card:{entry_version:version,card_seq:2,state}});
function env(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'priors-card-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return{PRIORS_PENDING_CARD_FILE:path.join(dir,'pending-cards.json')};}

test('a save without a card is listed; a save with a card is not',t=>{
 const e=env(t);
 assert.equal(recordToolResult(sid,T('remember'),{},remembered('GEN-1',1,{state:'ok'}),e),false);
 assert.equal(pendingCardStopNotice(sid,e),'');
 assert.equal(recordToolResult(sid,T('remember'),{},remembered('GEN-2',1,{state:'pending'}),e),true);
 assert.match(pendingCardStopNotice(sid,e),/^検索カードがまだ無い記憶 1 件: GEN-2@1。本文は書き直さず/);
});

test('a revise without a summary is listed for a check; with a summary and a card it is not',t=>{
 const e=env(t);
 assert.deepEqual(cardChanges(T('amend'),{id:'GEN-3',mode:'revise'},revised('GEN-3',4)).add,[{id:'GEN-3',version:4,reason:'check'}]);
 assert.deepEqual(cardChanges(T('amend'),{search_summary:'given'},revised('GEN-3',4,{state:'ok'})).add,[]);
 // a summary that the server rejected leaves the card pending
 assert.deepEqual(cardChanges(T('amend'),{search_summary:'given'},revised('GEN-3',4,{state:'pending'})).add,[{id:'GEN-3',version:4,reason:'pending'}]);
 recordToolResult(sid,T('amend'),{id:'GEN-3',mode:'revise'},revised('GEN-3',4),e);
 assert.match(pendingCardStopNotice(sid,e),/GEN-3@4/);
});

test('writing the card, a newer version with a card, and a retraction each clear the entry',t=>{
 const e=env(t);
 for(const id of['GEN-10','GEN-11','GEN-12','GEN-13'])recordToolResult(sid,T('remember'),{},remembered(id,1,{state:'pending'}),e);
 recordToolResult(sid,T('search_card'),{},carded('GEN-10',1),e);
 recordToolResult(sid,T('amend'),{search_summary:'given'},revised('GEN-11',2,{state:'ok'}),e);
 recordToolResult(sid,T('amend'),{},wrap({operation:'amend.retract',outcome_code:'applied',resource_ids:[{role:'primary',id:'GEN-12',version:2}]}),e);
 const line=pendingCardStopNotice(sid,e);
 assert.match(line,/1 件: GEN-13@1。/);assert.doesNotMatch(line,/GEN-1[012]@/);
 // a card that is still not ok does not clear it, and a card for an older version does not clear a newer one
 recordToolResult(sid,T('search_card'),{},carded('GEN-13',1,'pending'),e);
 recordToolResult(sid,T('amend'),{},revised('GEN-13',2),e);recordToolResult(sid,T('search_card'),{},carded('GEN-13',1),e);
 assert.match(pendingCardStopNotice(sid,e),/GEN-13@2/);
 recordToolResult(sid,T('search_card'),{},carded('GEN-13',2),e);
 assert.equal(pendingCardStopNotice(sid,e),'');
 assert.equal(Object.keys(JSON.parse(fs.readFileSync(ledgerPath(e),'utf8')).sessions).length,0);
});

test('the notice shows at most ten IDs, repeats at most three times for the same list, and starts again when the list changes',t=>{
 const e=env(t);
 for(let i=1;i<=SHOWN+3;i++)recordToolResult(sid,T('remember'),{},remembered('GEN-'+i,1,{state:'pending'}),e);
 const first=pendingCardStopNotice(sid,e);
 assert.match(first,new RegExp('^検索カードがまだ無い記憶 '+(SHOWN+3)+' 件: '));assert.match(first,/ほか 3 件。/);assert.equal((first.match(/GEN-\d+@1/g)||[]).length,SHOWN);
 for(let i=1;i<MAX_NOTICES;i++)assert.notEqual(pendingCardStopNotice(sid,e),'');
 assert.equal(pendingCardStopNotice(sid,e),'','silent after the cap');
 recordToolResult(sid,T('search_card'),{},carded('GEN-1',1),e);
 assert.match(pendingCardStopNotice(sid,e),new RegExp((SHOWN+2)+' 件'),'a changed list is announced again');
});

test('lists are per conversation, hold IDs and versions only, and a damaged or missing file is harmless',t=>{
 const e=env(t),other=crypto.randomUUID();
 recordToolResult(sid,T('remember'),{search_summary:'PRIVATE-SUMMARY',title:'PRIVATE-TITLE'},remembered('GEN-5',1,{state:'pending',error:{reason:'PRIVATE-REASON',token:'FAKE-TOKEN'}}),e);
 assert.equal(pendingCardStopNotice(other,e),'');
 const raw=fs.readFileSync(ledgerPath(e),'utf8');assert.doesNotMatch(raw,/PRIVATE|FAKE-TOKEN/);
 assert.deepEqual(Object.keys(JSON.parse(raw).sessions[sid].items['GEN-5']).sort(),['reason','version']);
 fs.writeFileSync(ledgerPath(e),'{not json');assert.equal(pendingCardStopNotice(sid,e),'');
 assert.equal(recordToolResult(sid,T('remember'),{},remembered('GEN-6',1,{state:'pending'}),e),true);assert.match(pendingCardStopNotice(sid,e),/GEN-6@1/);
 assert.equal(recordToolResult('not-a-session',T('remember'),{},remembered('GEN-7',1,{state:'pending'}),e),false);
 assert.equal(recordToolResult(sid,T('recall'),{},wrap({items:[]}),e),false);
 assert.equal(recordToolResult(sid,T('remember'),{},{isError:true,content:[{type:'text',text:'PRIVATE-ERROR'}]},e),false);
});

test('summary_record and capture are covered; a replayed response changes nothing',()=>{
 assert.deepEqual(cardChanges(T('summary_record'),{},wrap({operation:'summary_record',outcome_code:'recorded',resource_ids:[{role:'primary',id:'GEN-20',version:1}],search_card:{state:'pending'}})).add,[{id:'GEN-20',version:1,reason:'pending'}]);
 assert.deepEqual(cardChanges(T('capture'),{},wrap({operation:'capture',outcome_code:'recorded',resource_ids:[{role:'created',id:'GEN-21',version:1}],items:[{outcome_code:'recorded',id:'GEN-21',version:1,search_card:{state:'pending'}}]})).add,[{id:'GEN-21',version:1,reason:'pending'}]);
 const replay=cardChanges(T('remember'),{},wrap({replayed:true,operation:'remember',outcome_code:'recorded',resource_ids:[{role:'primary',id:'GEN-22',version:1}],search_card:{state:'pending'}}));
 assert.deepEqual(replay,{add:[],settle:[],drop:[]});
});

test('the stop reminder carries the line, and the hooks run end to end without touching the save message',t=>{
 const e=env(t);
 assert.equal(reminderPayload({pendingCandidateCount:0}),null);
 assert.match(reminderPayload({pendingCandidateCount:0,pendingCardLine:'検索カードがまだ無い記憶 1 件: GEN-1@1。'}).hookSpecificOutput.additionalContext,/GEN-1@1/);
 const dir=path.dirname(e.PRIORS_PENDING_CARD_FILE),child={...process.env,...e,PRIORS_DECISION_AUDIT_FILE:path.join(dir,'audit.jsonl'),PRIORS_TURN_STATE_FILE:path.join(dir,'turn.json'),PRIORS_STOP_DIAGNOSTIC_FILE:path.join(dir,'stop.json'),HOME:dir,USERPROFILE:dir};
 const run=(file,input)=>spawnSync(process.execPath,[path.join(__dirname,'..','hooks',file)],{input:JSON.stringify(input),encoding:'utf8',env:child});
 const post=run('post-tool-save.js',{session_id:sid,hook_event_name:'PostToolUse',tool_name:T('remember'),tool_input:{},tool_response:remembered('GEN-30',1,{state:'pending'})});
 assert.equal(post.status,0);assert.match(post.stdout,/成功応答の保存ID・版をローカル監査に記録しました/);
 const stop=run('conversation-end.js',{session_id:sid,hook_event_name:'Stop'});
 assert.equal(stop.status,0);assert.match(JSON.parse(stop.stdout).hookSpecificOutput.additionalContext,/検索カードがまだ無い記憶 1 件: GEN-30@1/);
 const fixed=run('post-tool-save.js',{session_id:sid,hook_event_name:'PostToolUse',tool_name:T('search_card'),tool_input:{},tool_response:carded('GEN-30',1)});
 assert.equal(fixed.status,0);assert.equal(fixed.stdout,'','search_card adds no message of its own');
 const quiet=run('conversation-end.js',{session_id:sid,hook_event_name:'Stop'});assert.equal(quiet.status,0);assert.doesNotMatch(quiet.stdout,/検索カードがまだ無い/);
 const matcher=JSON.parse(fs.readFileSync(path.join(__dirname,'..','hooks','hooks.json'),'utf8')).hooks.PostToolUse[0].matcher;
 assert.ok(new RegExp(matcher).test(T('search_card')));
});
