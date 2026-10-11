'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveConfig, searchDirs } = require('../hooks/config-resolver.js');
const { config } = require('../hooks/auto-recall.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-config-test-'));
test.after(() => {
  assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(base, { recursive: true, force: true });
});
let count = 0;
function setup() {
  const dir = path.join(base, String(++count)); fs.mkdirSync(dir);
  const cwd = path.join(dir, 'project'); fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, '.git'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const userConfigFile = path.join(home, 'config.json');
  const options = { home, userConfigFile };
  return { cwd, home, userConfigFile, options, write: (data) => fs.writeFileSync(userConfigFile, typeof data === 'string' ? data : JSON.stringify(data)) };
}
function project(cwd, data, name = 'priors.json') {
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', name), typeof data === 'string' ? data : JSON.stringify(data));
}
test('project wins without parsing malformed user settings', () => {
  const x = setup(); x.write('{'); project(x.cwd, { theme: 'GEN' });
  assert.equal(resolveConfig(x.cwd,x.options).source,'project');
});
test('invalid local project blocks valid project and user defaults', () => {
  const x=setup(); project(x.cwd,'{','priors.local.json'); project(x.cwd,{theme:'GEN'}); x.write({schema_version:1,default_theme:'TEST2'});
  assert.equal(resolveConfig(x.cwd,x.options).kind,'invalid');
});
test('user default is explicit and absence stays none', () => {
  const x=setup(); assert.equal(resolveConfig(x.cwd,x.options).kind,'none');
  x.write({schema_version:1}); assert.equal(resolveConfig(x.cwd,x.options).kind,'none');
  x.write({schema_version:1,default_theme:'TEST2'}); assert.equal(resolveConfig(x.cwd,x.options).theme,'TEST2');
});
test('longest root wins over default and ancestor', () => {
  const x=setup(); const child=path.join(x.cwd,'nested');fs.mkdirSync(child);
  x.write({schema_version:1,default_theme:'TEST2',projects:[{root:x.cwd,theme:'GEN'},{root:child,theme:'TEST',work_kinds:['verify']}]});
  const r=resolveConfig(child,x.options); assert.equal(r.theme,'TEST');assert.deepEqual(r.workKinds,['verify']);
});
test('same-name sibling is not a prefix match', () => {
  const x=setup(); const sibling=x.cwd+'-old';fs.mkdirSync(sibling);
  x.write({schema_version:1,projects:[{root:x.cwd,theme:'GEN'}]});assert.equal(resolveConfig(sibling,x.options).kind,'none');
});
test('duplicate normalized roots fail even when not selected', () => {
  const x=setup();x.write({schema_version:1,default_theme:'TEST2',projects:[{root:x.cwd,theme:'GEN'},{root:x.cwd+path.sep,theme:'TEST'}]});
  assert.equal(resolveConfig(x.cwd,x.options).reason,'duplicate_root');
});
test('junction realpath matches and aliases cannot duplicate', () => {
  const x=setup();const link=path.join(x.home,'alias');fs.symlinkSync(x.cwd,link,process.platform==='win32'?'junction':'dir');
  x.write({schema_version:1,projects:[{root:x.cwd,theme:'GEN'}]});assert.equal(resolveConfig(link,x.options).theme,'GEN');
  x.write({schema_version:1,projects:[{root:x.cwd,theme:'GEN'},{root:link,theme:'TEST'}]});assert.equal(resolveConfig(link,x.options).reason,'duplicate_root');
});
test('missing realpath keeps lexical choice without switching to default', () => {
  const x=setup();const missing=path.join(x.cwd,'missing');x.write({schema_version:1,default_theme:'TEST2',projects:[{root:missing,theme:'GEN'}]});
  assert.equal(resolveConfig(missing,x.options).theme,'GEN');
});
test('Windows casing and separators normalize', { skip: process.platform!=='win32' }, () => {
  const x=setup();x.write({schema_version:1,projects:[{root:x.cwd.toUpperCase().replaceAll('\\','/'),theme:'GEN'}]});
  assert.equal(resolveConfig(x.cwd,x.options).theme,'GEN');
});
test('user schema rejects unknown keys and invalid entries instead of fallback', () => {
  const x=setup();for(const data of [{schema_version:2,default_theme:'GEN'},{schema_version:1,default_theme:'GEN',token:'synthetic'},{schema_version:1,default_theme:'GEN',projects:[{root:'relative',theme:'GEN'}]},{schema_version:1,default_theme:'GEN',projects:[{root:x.cwd,theme:'bad'}]},{schema_version:1,default_theme:'GEN',projects:[{root:x.cwd,theme:'GEN',work_kinds:4}]}]) {
    x.write(data);assert.equal(resolveConfig(x.cwd,x.options).kind,'invalid');
  }
});
test('invalid JSON and oversized config reject', () => {
  const x=setup();x.write('{');assert.equal(resolveConfig(x.cwd,x.options).reason,'json_parse_error');
  x.write(' '.repeat(65537));assert.equal(resolveConfig(x.cwd,x.options).reason,'config_too_large');
});
test('broken config symlink is not missing', () => {
  const x=setup();fs.symlinkSync(path.join(x.home,'missing'),x.userConfigFile);
  assert.equal(resolveConfig(x.cwd,x.options).reason,'unreadable');
});
test('git boundary stops parent project search', () => {
  const x=setup();project(path.dirname(x.cwd),{theme:'TEST2'});assert.equal(resolveConfig(x.cwd,x.options).kind,'none');
});
test('no git explores only cwd plus three parents and excludes home and filesystem root', () => {
  const x=setup();const child=path.join(x.home,'one','two','three','four');fs.mkdirSync(child,{recursive:true});
  const dirs=searchDirs(child,x.home);assert.equal(dirs.length,4);assert.ok(!dirs.includes(x.home));
  assert.ok(dirs.every(d=>path.dirname(d)!==d));
  project(x.home,{theme:'GEN'});assert.equal(resolveConfig(child,x.options).kind,'none');
});
test('auto-recall uses the same user defaults and invalid-setting stop', () => {
  const x=setup();const env={PRIORS_USER_CONFIG_FILE:x.userConfigFile};x.write({schema_version:1,default_theme:'TEST2'});
  assert.equal(config(x.cwd,env).theme,'TEST2');project(x.cwd,'{');assert.equal(config(x.cwd,env),null);
});
