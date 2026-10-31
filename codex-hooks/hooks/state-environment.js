'use strict';
const path=require('node:path');
// Keep the legacy metadata location on Codex 0.165. No copying, no code loading, no trust/config writes.
// core-plugins/store.rs: plugins/data/{plugin_name}-{marketplace_name}.
function stateEnvironment(env=process.env){
 const data=env.PLUGIN_DATA;
 if(typeof data!=='string'||path.basename(data)!=='priors-hooks-priors'||path.basename(path.dirname(data))!=='data')return env;
 return {...env,PLUGIN_DATA:path.join(path.dirname(data),'priors-priors')};
}
module.exports={stateEnvironment};
