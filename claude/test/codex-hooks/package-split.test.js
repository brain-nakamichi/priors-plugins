'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const hooks=fs.existsSync(path.resolve(__dirname,'../../../codex-hooks'))?path.resolve(__dirname,'../../../codex-hooks'):path.resolve(__dirname,'../../../codex-plugins/priors-hooks');
const core=fs.existsSync(path.resolve(__dirname,'../../../codex'))?path.resolve(__dirname,'../../../codex'):path.resolve(__dirname,'../../../codex-plugins/priors');
const {contentHash}=require(path.join(hooks,'hooks/hook-health.js'));
function temporary(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'priors-package-split-'));t.after(()=>{assert.ok(path.resolve(d).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(d).startsWith('priors-package-split-'));fs.rmSync(d,{recursive:true,force:true});});return d;}
test('core has no explicit or implicit hooks; hook package contains only its runtime closure',()=>{
 const main=JSON.parse(fs.readFileSync(path.join(core,'.codex-plugin/plugin.json')));
 assert.equal(main.hooks,undefined);assert.equal(fs.existsSync(path.join(core,'hooks')),false);
 assert.equal(main.mcpServers,'./.mcp.json');assert.equal(main.skills,'./skills/');
 assert.deepEqual(fs.readdirSync(hooks).sort(),['.codex-plugin','hooks']);
 const visit=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);assert.equal(e.isSymbolicLink(),false);if(e.isDirectory())visit(p);else if(p.endsWith('.js')){
  const s=fs.readFileSync(p,'utf8');for(const m of s.matchAll(/(?:require\(|from\s+)["']([^"']+)["']/g)){
   const dep=m[1];if(dep.startsWith('node:'))continue;assert.ok(dep.startsWith('./')||dep.startsWith('../'),dep);
   const target=path.resolve(path.dirname(p),dep);assert.ok(target.startsWith(hooks+path.sep),dep);assert.ok(fs.existsSync(target),dep);
  }
 }} };visit(path.join(hooks,'hooks'));
});
test('unrelated core documentation/version changes leave hook hash unchanged; any runtime change requires review',t=>{
 const d=temporary(t),h=path.join(d,'hooks'),c=path.join(d,'core');fs.cpSync(hooks,h,{recursive:true});fs.cpSync(core,c,{recursive:true});
 const original=contentHash(h);fs.appendFileSync(path.join(c,'skills/priors/SKILL.md'),'\nSynthetic documentation-only update.\n');
 const file=path.join(c,'.codex-plugin/plugin.json'),m=JSON.parse(fs.readFileSync(file));m.version='0.1.999';fs.writeFileSync(file,JSON.stringify(m));
 assert.equal(contentHash(h),original);fs.appendFileSync(path.join(h,'hooks/shared/save-response.js'),'\n// synthetic runtime change\n');assert.notEqual(contentHash(h),original);
});
test('split preserves the legacy metadata location without moving files or touching trust',t=>{
 const d=temporary(t),data=path.join(d,'plugins/data/priors-hooks-priors'),legacy=path.join(d,'plugins/data/priors-priors');
 const {stateEnvironment}=require(path.join(hooks,'hooks/state-environment.js'));
 assert.equal(stateEnvironment({PLUGIN_DATA:data}).PLUGIN_DATA,legacy);
 const {handle,statePath}=require(path.join(hooks,'hooks/retention-runtime.js'));const session='11111111-1111-4111-8111-111111111111',turn='22222222-2222-4222-8222-222222222222';
 handle({hook_event_name:'UserPromptSubmit',session_id:session,turn_id:turn,prompt:'今後は日本語で簡潔に回答してほしい'},{PLUGIN_DATA:legacy});
 const file=statePath({PLUGIN_DATA:legacy}),before=fs.readFileSync(file,'utf8');
 assert.equal(statePath({PLUGIN_DATA:data}),file);assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.equal(fs.existsSync(data),false);assert.doesNotMatch(before,/日本語|prompt|token|trusted_hash/);
});
test('core version is inert metadata, independent of hook version and unknown layouts are not guessed',async t=>{
 const d=temporary(t),base=path.join(d,'plugins/cache/priors/priors'),root=path.join(base,'0.1.76');fs.mkdirSync(path.join(root,'.codex-plugin'),{recursive:true});
 fs.writeFileSync(path.join(root,'.codex-plugin/plugin.json'),JSON.stringify({name:'priors',version:'0.1.76'}));
 const {coreVersion}=await import(pathToFileURL(path.join(hooks,'hooks/core-version.js')).href);
 assert.equal(coreVersion({CODEX_HOME:d}),'0.1.76');fs.mkdirSync(path.join(base,'unknown'));assert.equal(coreVersion({CODEX_HOME:d}),null);
 const local=path.join(base,'local/.codex-plugin');fs.mkdirSync(local,{recursive:true});fs.writeFileSync(path.join(local,'plugin.json'),JSON.stringify({name:'priors',version:'0.1.77'}));
 assert.equal(coreVersion({CODEX_HOME:d}),'0.1.77');assert.equal(coreVersion({CODEX_HOME:path.join(d,'missing')}),null);
});
test('hook and core update notices use their own versions and suppress independently',async t=>{
 const d=temporary(t),root=path.join(d,'plugins/cache/priors/priors/0.1.76/.codex-plugin');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'plugin.json'),JSON.stringify({name:'priors',version:'0.1.76'}));
 const old=global.fetch;t.after(()=>{global.fetch=old;});const calls=[];
 global.fetch=async u=>{calls.push(String(u));return {ok:true,text:async()=>JSON.stringify({version:String(u).includes('/codex-hooks/')?'0.1.1':'0.1.77'})};};
 const mod=await import(pathToFileURL(path.join(hooks,'hooks/plugin-update-check.js')).href),env={CODEX_HOME:d,PRIORS_PLUGIN_UPDATE_STATE_FILE:path.join(d,'state.json')};
 assert.match(await mod.checkPluginUpdate(env),/Priors Hooks.*0\.1\.0 → 0\.1\.1/);
 assert.match(await mod.checkCoreUpdate(env),/Priors本体.*0\.1\.76 → 0\.1\.77/);
 assert.equal(await mod.checkPluginUpdate(env),null);assert.equal(await mod.checkCoreUpdate(env),null);
 assert.ok(calls.some(u=>u.includes('/codex-hooks/'))&&calls.some(u=>u.includes('/codex/')));
});
