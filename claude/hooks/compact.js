#!/usr/bin/env node
'use strict';
const {readHookInput}=require('./bounded-input.js');
const checkpoint=require('./compact-checkpoint.js');
function handle(input,env=process.env) {
  if (!input || input.agent_id || input.agent_type) return null;
  if(input.hook_event_name==='PreCompact') {
    let pending;
    try {
      const candidates=require('./proactive-candidates.js');
      const fs=require('node:fs'),file=candidates.candidatePath(env);
      if(fs.statSync(file).size<=2*1024*1024)pending=candidates.pendingProactiveCandidates(env).map(c=>c.candidate_id);
    } catch { /* Keep unresolved metadata if reconciliation is unavailable. */ }
    checkpoint.preCompact('claude',input.session_id,env,pending); return null;
  }
  if(input.hook_event_name==='SessionStart' && input.source==='compact') {
    const text=checkpoint.afterCompact('claude',input.session_id,env);
    return text ? {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:text}} : null;
  }
  return null;
}
if(require.main===module)try{const r=readHookInput(0,false);if(r.ok){const output=handle(r.input);if(output)process.stdout.write(JSON.stringify(output)+'\n');}}catch{}
module.exports={handle};
