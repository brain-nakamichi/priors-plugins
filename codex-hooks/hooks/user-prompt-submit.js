#!/usr/bin/env node
'use strict';
const {readHookInput}=require('./shared/bounded-input.js');
const {handle}=require('./retention-runtime.js');
const {healthNotice}=require('./hook-health.js');
function buildPromptOutput(input,env=process.env){
 const output=handle(input,env);
 if(input?.hook_event_name!=='UserPromptSubmit'||input.agent_id||input.agent_type)return output;
 const notice=healthNotice(env);if(!notice)return output;
 const result=output||{hookSpecificOutput:{hookEventName:'UserPromptSubmit'}};
 result.systemMessage=notice;
 result.hookSpecificOutput.additionalContext=[result.hookSpecificOutput.additionalContext,notice].filter(Boolean).join('\n');
 return result;
}
if(require.main===module){try{const r=readHookInput(0,false);if(r.ok&&r.input.hook_event_name==='UserPromptSubmit'){const output=buildPromptOutput(r.input);if(output)process.stdout.write(JSON.stringify(output)+'\n');}}catch{/* Fail softly; never print raw input or errors. */}}
module.exports={buildPromptOutput};
