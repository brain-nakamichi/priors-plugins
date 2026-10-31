#!/usr/bin/env node
'use strict';
const {readHookInput}=require('./shared/bounded-input.js');
const checkpoint=require('./shared/compact-checkpoint.js');
function handle(input,env=process.env) {
  env=require('./state-environment.js').stateEnvironment(env);
  if (!input || input.agent_id || input.agent_type) return null;
  if(input.hook_event_name==='PreCompact') { checkpoint.preCompact('codex',input.session_id,env); return null; }
  if(input.hook_event_name==='SessionStart' && input.source==='compact') {
    const text=checkpoint.afterCompact('codex',input.session_id,env);
    return text ? {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:text}} : null;
  }
  return null;
}
if(require.main===module)try{const r=readHookInput(0,false);if(r.ok){const output=handle(r.input);if(output)process.stdout.write(JSON.stringify(output)+'\n');}}catch{}
module.exports={handle};
