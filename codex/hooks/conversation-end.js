#!/usr/bin/env node
'use strict';
const {readHookInput}=require('./shared/bounded-input.js');
const {handle}=require('./retention-runtime.js');
function buildPromptOutput(input,env=process.env){return handle(input,env);}
if(require.main===module){try{const r=readHookInput(0,false);if(r.ok&&r.input.hook_event_name==='Stop'){const output=handle(r.input);if(output)process.stdout.write(JSON.stringify(output)+'\n');}}catch{/* Fail softly; never print raw input or errors. */}}
module.exports={buildPromptOutput};
