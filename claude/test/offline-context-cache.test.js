'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {makeCache,scopeOf,TTL_MS,MAX_FILES}=require('../hooks/offline-context-cache.js');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'priors-offline-test-'));
test.after(()=>{assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(base,{recursive:true,force:true});});
const secret='Z'.repeat(43);const token='pv1a'+'A'.repeat(16)+secret;
const actor='00000000-0000-4000-8000-000000000001';
function payload(){return {actor_id:actor,frames:{pinned:{items:[{id:'GEN-1',version:1,tier:'A',title:'rule',body:'規'.repeat(500)},{id:'GEN-2',version:1,tier:'B',title:'extra',body:'unused'}]},unresolved:{items:[{id:'GEN-3',version:2,title:'question',body:'private details'}]},recent:{items:[{id:'GEN-4',body:'not copied'}]}}};}
let n=0;function fixture(overrides={}){const home=path.join(base,String(++n));fs.mkdirSync(home);let time=100000000;const opts={home,env:{PRIORS_CONTEXT_CACHE:'1'},endpoint:'https://priors-brain9.vercel.app/mcp',token,theme:'GEN',now:()=>time,...overrides};return {home,opts,cache:makeCache(opts),setTime:v=>time=v,files:()=>fs.readdirSync(path.join(home,'.priors','context-cache')).filter(v=>v.endsWith('.json'))};}
test('opt-in absent does not inspect token or create files',()=>{const o={env:{}};Object.defineProperty(o,'token',{get(){throw Error('access');}});assert.equal(makeCache(o),null);});
test('scope contains only public key and rejects unsupported token or secret-bearing URL',()=>{
 const s=scopeOf('https://priors-brain9.vercel.app/mcp',token,'GEN',['review']);assert.equal(s.key_id,'A'.repeat(16));assert.equal(s.mode,'a');assert.ok(!JSON.stringify(s).includes(secret));
 for(const url of ['https://u:p@host/mcp','https://host/mcp?token=synthetic','https://host/mcp#secret'])assert.equal(scopeOf(url,token,'GEN'),null);
 assert.equal(scopeOf('https://host/mcp','bad','GEN'),null);
});
test('copy retains bounded Tier A and metadata-only unresolved, no raw extra frames',()=>{const x=fixture();assert.equal(x.cache.save(payload()),true);const got=x.cache.load();assert.equal(got.frames.pinned.items.length,1);assert.equal([...got.frames.pinned.items[0].body].length,400);assert.ok(!JSON.stringify(got).includes('private details'));assert.ok(!JSON.stringify(got).includes('not copied'));assert.equal(got.frames.unresolved.items[0].version,2);const disk=fs.readFileSync(path.join(x.home,'.priors','context-cache',x.files()[0]),'utf8');assert.ok(!disk.includes(secret));assert.ok(!disk.includes(token));assert.ok(!disk.includes(x.home));});
test('cache splits endpoint theme work kinds and public key or mode',()=>{const x=fixture();x.cache.save(payload());for(const change of [{endpoint:'https://another.example/mcp'},{theme:'TEST2'},{workKinds:['deploy']},{token:'pv1a'+'B'.repeat(16)+secret},{token:'pv1i'+'A'.repeat(16)+secret}])assert.equal(makeCache({...x.opts,...change}).load(),null);});
test('seven day expiry and future timestamps reject',()=>{const x=fixture();x.cache.save(payload());x.setTime(100000000+TTL_MS);assert.ok(x.cache.load());x.setTime(100000001+TTL_MS);assert.equal(x.cache.load(),null);x.setTime(99999999);assert.equal(x.cache.load(),null);});
test('secret beyond copied excerpt redacts only affected item',()=>{
 const x=fixture();const p=payload();p.frames.pinned.items[0].body='normal'.repeat(100)+' '+token;
 assert.equal(x.cache.save(p),true);const got=x.cache.load();
 assert.equal(got.frames.pinned.items[0].body,'秘密らしい文字列のため省略');
 assert.equal(got.frames.pinned.items[0].title,'秘密らしい文字列のため省略');
 assert.equal(got.frames.pinned.items[0].sensitive_omitted,true);
 assert.equal(got.frames.unresolved.items[0].title,'question');
 assert.ok(!fs.readFileSync(path.join(x.home,'.priors','context-cache',x.files()[0]),'utf8').includes(token));
});
test('ordinary credential discussion redacts its item while safe copy remains',()=>{
 const x=fixture();const p=payload();
 p.frames.unresolved.items.push({id:'GEN-5',version:3,title:'Authorization の Bearer と SUPABASE_ACCESS_TOKEN が並ぶ設定の出力'});
 assert.equal(x.cache.save(p),true);const got=x.cache.load();
 assert.equal(got.frames.unresolved.items[1].title,'秘密らしい文字列のため省略');
 assert.equal(got.frames.unresolved.items[1].id,'GEN-5');assert.equal(got.frames.unresolved.items[1].version,3);
 assert.equal(got.frames.unresolved.items[0].title,'question');assert.equal(got.frames.pinned.items[0].title,'rule');
});
test('discarded fields cannot prevent safe projection or enter disk',()=>{
 const x=fixture();const p=payload();p.extra=token;p.frames.recent.items[0].body=token;
 p.frames.unresolved.items[0].body=token;p.frames.pinned.items[1].body=token;
 assert.equal(x.cache.save(p),true);assert.equal(x.cache.load().frames.unresolved.items[0].title,'question');
 assert.ok(!fs.readFileSync(path.join(x.home,'.priors','context-cache',x.files()[0]),'utf8').includes(token));
});
test('missing actor refuses store; uninspectable retained field redacts its item',()=>{
 const x=fixture();const p=payload();delete p.actor_id;assert.equal(x.cache.save(p),false);
 assert.equal(fs.existsSync(path.join(x.home,'.priors')),false);p.actor_id=actor;
 p.frames.pinned.items[0].body='x'.repeat(300000);assert.equal(x.cache.save(p),true);
 assert.equal(x.cache.load().frames.pinned.items[0].sensitive_omitted,true);
});
test('scope tamper malformed oversized and untrusted secret text reject',()=>{const x=fixture();x.cache.save(payload());const file=path.join(x.home,'.priors','context-cache',x.files()[0]);const data=JSON.parse(fs.readFileSync(file,'utf8'));data.scope.theme='TEST2';fs.writeFileSync(file,JSON.stringify(data));assert.equal(x.cache.load(),null);fs.writeFileSync(file,'{');assert.equal(x.cache.load(),null);fs.writeFileSync(file,'x'.repeat(65537));assert.equal(x.cache.load(),null);x.cache.save(payload());const d=JSON.parse(fs.readFileSync(file,'utf8'));d.extra=token;fs.writeFileSync(file,JSON.stringify(d));assert.equal(x.cache.load(),null);});
test('remove invalidates only matching copy',()=>{const x=fixture();x.cache.save(payload());const other=makeCache({...x.opts,theme:'TEST2'});other.save(payload());x.cache.remove();assert.equal(x.cache.load(),null);assert.ok(other.load());});
test('bounded cache count and temp cleanup',()=>{const x=fixture();for(let i=0;i<MAX_FILES+3;i++)makeCache({...x.opts,workKinds:[String(i)]}).save(payload());assert.equal(x.files().length,MAX_FILES);assert.ok(fs.readdirSync(path.join(x.home,'.priors','context-cache')).every(v=>v.endsWith('.json')));});
test('cache directory symlink cannot escape profile',()=>{const x=fixture();fs.mkdirSync(path.join(x.home,'.priors'));const outside=path.join(base,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(x.home,'.priors','context-cache'),process.platform==='win32'?'junction':'dir');assert.equal(x.cache.save(payload()),false);assert.equal(x.cache.load(),null);assert.equal(fs.readdirSync(outside).length,0);});
test('cached file symlink is not read',()=>{const x=fixture();x.cache.save(payload());const file=path.join(x.home,'.priors','context-cache',x.files()[0]);const other=path.join(x.home,'other.json');fs.renameSync(file,other);fs.symlinkSync(other,file);assert.equal(x.cache.load(),null);});
test('public mode/key scope does not prove live authorization or secret validity',()=>{const x=fixture();x.cache.save(payload());assert.ok(makeCache({...x.opts,token:'pv1a'+'A'.repeat(16)+'Y'.repeat(43)}).load());});
