#!/usr/bin/env node
'use strict';
// One maintained source, two self-contained distributable packages. Never require outside an installed plugin.
const fs=require('node:fs'),path=require('node:path');
const SOURCE=path.resolve(__dirname,'../hooks');
const devTarget=path.resolve(__dirname,'../../codex-plugins/priors-hooks');
const TARGET=path.join(fs.existsSync(devTarget)?devTarget:path.resolve(__dirname,'../../codex-hooks'),'hooks/shared');
const FILES=['bounded-input.js','sensitive-input.js','retention-signals.js','save-response.js','compact-checkpoint.js'];
function sync(check=false){
 for(const file of FILES){const source=fs.readFileSync(path.join(SOURCE,file),'utf8').replace(/\r\n?/g,'\n');
  if(check){if(!fs.existsSync(path.join(TARGET,file))||fs.readFileSync(path.join(TARGET,file),'utf8').replace(/\r\n?/g,'\n')!==source)throw Error('shared_hook_core_outdated');}
  else{fs.mkdirSync(TARGET,{recursive:true});fs.writeFileSync(path.join(TARGET,file),source,'utf8');}
 }
}
if(require.main===module)sync(process.argv.includes('--check'));
module.exports={sync,FILES};
