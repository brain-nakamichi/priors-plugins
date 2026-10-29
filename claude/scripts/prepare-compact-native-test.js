#!/usr/bin/env node
'use strict';
// Creates only a NEW isolated fixture. Never writes hook trust or the normal CODEX_HOME.
const fs=require('node:fs'),path=require('node:path');
function prepare(dir) {
 const base=path.resolve(dir);if(fs.existsSync(base))throw Error('fixture_must_be_new');
 const repo=path.resolve(__dirname,'../../..'),root=path.join(repo,'Priors/codex-plugins/priors');
 fs.mkdirSync(path.join(base,'home'),{recursive:true});fs.mkdirSync(path.join(base,'workspace'));fs.mkdirSync(path.join(base,'data'));
 const config='cli_auth_credentials_store="file"\nmcp_oauth_credentials_store="file"\nmodel="compact-local-test"\nmodel_provider="loopback"\n[model_providers.loopback]\nname="loopback"\nbase_url="http://127.0.0.1:18871/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\nplugins=false\nhooks=true\nremote_plugin=false\n[analytics]\nenabled=false\n';
 fs.writeFileSync(path.join(base,'home/config.toml'),config);
 const hooks={hooks:{PreCompact:[{hooks:[{type:'command',command:`node "${path.join(base,'observer.cjs').replaceAll('\\','/')}"`,timeout:10}]}],SessionStart:[{matcher:'compact',hooks:[{type:'command',command:`node "${path.join(base,'observer.cjs').replaceAll('\\','/')}"`,timeout:10}]}]}};
 fs.writeFileSync(path.join(base,'home/hooks.json'),JSON.stringify(hooks,null,2)+'\n');
 const observer=`'use strict';\nconst fs=require('fs');const {readHookInput}=require(${JSON.stringify(path.join(root,'hooks/shared/bounded-input.js'))});const compact=require(${JSON.stringify(path.join(root,'hooks/compact.js'))});const r=readHookInput(0,false);if(r.ok){const p=r.input;if(['PreCompact','SessionStart'].includes(p.hook_event_name)){fs.appendFileSync(${JSON.stringify(path.join(base,'events.jsonl'))},JSON.stringify({event:p.hook_event_name,source:p.source==='compact'?'compact':'other'})+'\\n');const o=compact.handle(p,{PLUGIN_DATA:${JSON.stringify(path.join(base,'data'))}});if(o)process.stdout.write(JSON.stringify(o));}}\n`;
 fs.writeFileSync(path.join(base,'observer.cjs'),observer);
 fs.writeFileSync(path.join(base,'fixture.json'),JSON.stringify({schema:1,repo},null,2));
 return base;
}
if(require.main===module){try{console.log(JSON.stringify({fixture:prepare(process.argv[2])}));}catch{console.error('isolated_fixture_preparation_failed');process.exitCode=1;}}
module.exports={prepare};
