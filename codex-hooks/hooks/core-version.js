import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// Read metadata only, never import/require or run another package. Unknown layouts fail silently.
const numeric=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
function readVersion(root){
 const file=path.join(root,'.codex-plugin/plugin.json'),s=fs.lstatSync(file);
 if(!s.isFile()||s.isSymbolicLink()||s.size>65536)return null;
 const data=JSON.parse(fs.readFileSync(file,'utf8'));
 return data.name==='priors'&&numeric.test(data.version)?data.version:null;
}
export function coreVersion(env=process.env){
 try{
  const base=path.join(env.CODEX_HOME||path.join(os.homedir(),'.codex'),'plugins/cache/priors/priors');
  const root=fs.lstatSync(base);if(!root.isDirectory()||root.isSymbolicLink())return null;
  const dirs=fs.readdirSync(base,{withFileTypes:true}).filter(x=>x.isDirectory());if(dirs.length>128)return null;
  // Codex 0.165 core-plugin-common/installed.rs prefers local, otherwise the greatest version.
  if(dirs.some(x=>x.name==='local'))return readVersion(path.join(base,'local'));
  if(dirs.some(x=>!numeric.test(x.name)))return null;
  dirs.sort((a,b)=>{const x=a.name.split('.').map(Number),y=b.name.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];});
  return dirs.length?readVersion(path.join(base,dirs.at(-1).name)):null;
 }catch{return null;}
}
