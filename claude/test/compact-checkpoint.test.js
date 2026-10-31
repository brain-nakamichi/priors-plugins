'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const core=require('../hooks/compact-checkpoint.js');
const session='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const id='pc-123456abcdef-11111111-remember-candidate';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'priors-compact-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {PLUGIN_DATA:dir};}
for(const client of ['claude','codex']) {
 test(`${client}: empty and repeated compact notifications stay silent`,t=>{const env=fixture(t);core.preCompact(client,session,env);assert.equal(core.afterCompact(client,session,env),null);assert.equal(core.afterCompact(client,session,env),null);});
 test(`${client}: only the preceding interval; receipt acknowledgement and once-only delivery`,t=>{
  const env=fixture(t);core.recordCandidate(client,session,{id,categories:['remember-candidate'],body:'DO_NOT_PERSIST'},env);
  core.recordSave(client,session,['GEN-1@2'],[id],env);core.preCompact(client,session,env);
  core.recordSave(client,session,['GEN-2@1'],[],env);
  const text=core.afterCompact(client,session,env);assert.match(text,/候補 0 件/);assert.match(text,/GEN-1@2/);assert.doesNotMatch(text,/GEN-2|DO_NOT_PERSIST/);
  assert.equal(core.afterCompact(client,session,env),null);core.preCompact(client,session,env);const next=core.afterCompact(client,session,env);
  assert.match(next,/GEN-2@1/);assert.doesNotMatch(next,/GEN-1@2/);
  assert.doesNotMatch(fs.readFileSync(core.statePath(client,env),'utf8'),/DO_NOT_PERSIST|body|transcript|prompt/);
 });
 test(`${client}: pending candidate, cancelled/repeated precompact, session isolation`,t=>{
  const env=fixture(t);core.recordCandidate(client,session,{id,categories:['unresolved-candidate']},env);core.preCompact(client,session,env);
  core.recordSave(client,session,['GEN-3@1'],[],env);core.preCompact(client,session,env);
  assert.equal(core.afterCompact(client,other,env),null);const text=core.afterCompact(client,session,env);
  assert.match(text,/候補 1 件/);assert.match(text,/unresolved-candidate/);assert.match(text,/GEN-3@1/);
 });
 test(`${client}: bounded metadata, explicit overflow and fail-soft lock/corruption`,t=>{
  const env=fixture(t);for(let n=1;n<=core.LIMIT+2;n++)core.recordSave(client,session,[`GEN-${n}@1`],[],env);
  core.preCompact(client,session,env);assert.match(core.afterCompact(client,session,env),/上限による省略/);
  const file=core.statePath(client,env);assert.ok(fs.statSync(file).size<core.MAX_BYTES);
  fs.mkdirSync(file+'.lock');assert.equal(core.afterCompact(client,session,env),null);fs.rmdirSync(file+'.lock');
  const original='{"schema":1,"sessions":[],"body":"not accepted"}';fs.writeFileSync(file,original);
  assert.equal(core.preCompact(client,session,env),null);assert.equal(fs.readFileSync(file,'utf8'),original);
 });
 test(`${client}: expires seven-day local state and rejects invalid references`,t=>{
  const env=fixture(t);core.recordSave(client,session,['GEN-1@1'],[],env);const file=core.statePath(client,env),s=JSON.parse(fs.readFileSync(file));
  s.sessions[0].at=Date.now()-8*86400000;fs.writeFileSync(file,JSON.stringify(s));core.preCompact(client,session,env);assert.equal(core.afterCompact(client,session,env),null);
  core.recordSave(client,session,['SECRET_VALUE'],[],env);core.preCompact(client,session,env);assert.equal(core.afterCompact(client,session,env),null);
 });
}
test('Codex real runtime feeds metadata and excludes harness/secret/subagent inputs',t=>{
 const env=fixture(t),{handle}=require('../../codex-plugins/priors-hooks/hooks/retention-runtime.js');
 const input={hook_event_name:'UserPromptSubmit',session_id:session,turn_id:other,prompt:'次からは日本語で短く説明してほしい'};
 assert.ok(handle(input,env));core.preCompact('codex',session,env);assert.match(core.afterCompact('codex',session,env),/候補 1 件/);
 for(const extra of [{agent_id:'synthetic'},{source:'system'},{prompt:'Message Type: FINAL_ANSWER'},{prompt:'次から sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 を使って'}])handle({...input,...extra,turn_id:'33333333-3333-4333-8333-333333333333'},env);
 core.preCompact('codex',session,env);assert.equal(core.afterCompact('codex',session,env),null);
});
test('compact adapters ignore transcript path, subagents and unrelated events',t=>{
 for(const client of ['claude','codex']){
  const env=fixture(t),adapter=require(client==='claude'?'../hooks/compact.js':'../../codex-plugins/priors-hooks/hooks/compact.js');
  core.recordSave(client,session,['GEN-5@1'],[],env);
  adapter.handle({hook_event_name:'PreCompact',session_id:session,transcript_path:'Z:/NEVER_READ',prompt:'NEVER_PERSIST'},env);
  assert.equal(adapter.handle({hook_event_name:'SessionStart',source:'compact',session_id:session,agent_id:'x'},env),null);
  assert.equal(adapter.handle({hook_event_name:'PostCompact',session_id:session},env),null);
  const result=adapter.handle({hook_event_name:'SessionStart',source:'compact',session_id:session},env);
  assert.match(result.hookSpecificOutput.additionalContext,/GEN-5@1/);assert.equal(result.decision,undefined);assert.equal(result.continue,undefined);
  assert.equal(adapter.handle({hook_event_name:'SessionStart',source:'compact',session_id:session},env),null);
 }
});
