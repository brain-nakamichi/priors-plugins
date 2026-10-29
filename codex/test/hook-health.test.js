'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const { inspectHooks, healthNotice, contentHash, declarationHashes, parseUserState } = require('../hooks/hook-health.js');
function fixture(t, existingRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = existingRoot || path.join(dir, 'plugin'), home = path.join(dir, 'config-input-fixture'), data = path.join(dir, 'data');
  fs.mkdirSync(home);
  if (!existingRoot) {
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../hooks/hooks.json'), path.join(root, 'hooks/hooks.json'));
    fs.writeFileSync(path.join(root, 'script.js'), 'synthetic bundle\n');
  }
  const config = path.join(home, 'config.toml');
  const x = { root, home, data, config, env: { CODEX_HOME: home, PLUGIN_ROOT: root, PLUGIN_DATA: data } };
  // Plain diagnostic input, never passed to a Codex process or used to authorize hook execution.
  x.write = (change = () => {}) => {
    const content = contentHash(root);
    const rows = declarationHashes(root).map(d => ({ key: d.key, trusted_hash: d.hash, trusted_content_hash: content, enabled: true }));
    change(rows);
    fs.writeFileSync(config, '[mcp_servers.fixture]\nsecret = "FAKE_ONLY_NOT_A_REAL_TOKEN"\n' + rows.map(r =>
      `[hooks.state.${JSON.stringify(r.key)}]\n` + Object.entries(r).filter(([k]) => k !== 'key').map(([k, v]) => `${k} = ${JSON.stringify(v)}\n`).join('')).join(''));
  };
  x.write(); return x;
}
test('healthy approvals stay silent; diagnosis never writes user configuration', t => {
  const x = fixture(t), original = fs.readFileSync(x.config);
  assert.ok(inspectHooks(x.env, x.root).every(r => r.reason === null));
  assert.equal(healthNotice(x.env, x.root), null);
  assert.deepEqual(fs.readFileSync(x.config), original);
  assert.equal(fs.existsSync(x.data), false);
});
test('one disabled hook has a short fixed-label notice, once per state per day across entry points', t => {
  const x = fixture(t); x.write(rows => { rows.find(r => r.key.includes('post_tool_use')).enabled = false; });
  const original = fs.readFileSync(x.config), now = 2000000000000;
  const n = healthNotice(x.env, x.root, now);
  assert.match(n, /PostToolUse（無効）/); assert.match(n, /\/hooks/); assert.equal(n.split('\n').length, 2);
  assert.doesNotMatch(n, /FAKE_ONLY|sha256|config-input-fixture|trusted_hash/);
  assert.equal(healthNotice(x.env, x.root, now + 1), null);
  assert.ok(healthNotice(x.env, x.root, now + 86400001));
  assert.deepEqual(fs.readFileSync(x.config), original);
  x.write(); assert.equal(healthNotice(x.env, x.root, now + 86400002), null);
});
test('missing approval, changed declaration, changed bundle and a second state are distinguished', t => {
  const x = fixture(t), now = Date.now();
  x.write(rows => { delete rows[0].trusted_hash; });
  assert.equal(inspectHooks(x.env, x.root)[0].reason, 'untrusted'); assert.ok(healthNotice(x.env, x.root, now));
  x.write(rows => { rows[0].trusted_hash = 'sha256:' + '0'.repeat(64); });
  assert.equal(inspectHooks(x.env, x.root)[0].reason, 'definition_changed'); assert.ok(healthNotice(x.env, x.root, now + 1));
  x.write(); fs.appendFileSync(path.join(x.root, 'script.js'), 'changed');
  assert.ok(inspectHooks(x.env, x.root).every(r => r.reason === 'contents_changed'));
});
test('unknown TOML, absent legacy baseline, unknown hook syntax or inaccessible files stay silent', t => {
  const x = fixture(t);
  const invalid = ['[hooks.state]\nstate = {}', '[hooks.state."x"]\nenabled = "false"',
    '[hooks.state."x"]\ntrusted_hash = "not-a-hash"', 'instructions="""\n[hooks.state."x"]\n"""',
    '[hooks.state."x"]\nenabled=false\nenabled=true', '[profiles.example.hooks.state]\nx=true'];
  for (const text of invalid) { fs.writeFileSync(x.config, text); assert.equal(inspectHooks(x.env, x.root), null); assert.equal(healthNotice(x.env, x.root), null); }
  x.write(rows => { for (const r of rows) delete r.trusted_content_hash; });
  assert.equal(inspectHooks(x.env, x.root), null); // Do not initialize a legacy trust baseline.
  assert.equal(fs.existsSync(path.join(x.home, '.hook-trust')), false);
  x.write(); const hookFile = path.join(x.root, 'hooks/hooks.json'); const h = JSON.parse(fs.readFileSync(hookFile));
  h.hooks.Stop[0].hooks[0].timeout = 11; fs.writeFileSync(hookFile, JSON.stringify(h));
  assert.equal(inspectHooks(x.env, x.root), null);
  fs.unlinkSync(x.config); assert.equal(inspectHooks(x.env, x.root), null);
});
test('TOML generated single/literal keys, comments and escaped quotes are read without reflecting values', () => {
  const state = parseUserState("[hooks.state.'priors@priors:hooks/hooks.json:stop:0:0'] # comment\nenabled = false # comment\n");
  assert.equal(state.values().next().value.enabled, false);
  assert.throws(() => parseUserState('[[hooks.state]]\nx=true'));
});
test('bundle digest matches an independent ASCII fixture vector and ignores only specified artifacts', t => {
  const x = fixture(t), one = contentHash(x.root);
  fs.mkdirSync(path.join(x.root, '__pycache__')); fs.writeFileSync(path.join(x.root, '__pycache__/ignored'), 'ignored');
  fs.writeFileSync(path.join(x.root, 'ignored.pyc'), 'ignored'); assert.equal(contentHash(x.root), one);
  fs.writeFileSync(path.join(x.root, 'README.md'), 'changed'); assert.notEqual(contentHash(x.root), one);
  // config/fingerprint.rs canonical JSON, for a known normalized Stop command.
  const d = declarationHashes(x.root).find(v => v.event === 'Stop');
  const canonical = '{"event_name":"stop","hooks":[{"async":false,"command":"node \\\"${PLUGIN_ROOT}/hooks/conversation-end.js\\\"","timeout":10,"type":"command"}]}';
  assert.equal(d.hash, 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex'));
});
test('no plugin launch context, malformed notice state or busy lock cannot create misleading guidance', t => {
  const x = fixture(t); x.write(rows => { rows[0].enabled = false; });
  assert.equal(healthNotice({ CODEX_HOME: x.home }, x.root), null);
  fs.mkdirSync(x.data); const file = path.join(x.data, 'hook-health-notice.json');
  fs.writeFileSync(file, '{bad'); assert.equal(healthNotice(x.env, x.root), null);
  fs.unlinkSync(file); fs.mkdirSync(file + '.lock'); assert.equal(healthNotice(x.env, x.root), null);
});
test('UserPromptSubmit adds health guidance once without dropping its independent save candidate', t => {
  const root = path.resolve(__dirname, '..'), x = fixture(t, root);
  x.write(rows => { rows.find(r => r.key.includes('post_tool_use')).enabled = false; });
  const { buildPromptOutput } = require('../hooks/user-prompt-submit.js');
  const input = { hook_event_name: 'UserPromptSubmit', session_id: crypto.randomUUID(), turn_id: crypto.randomUUID(), prompt: '今後は日本語で簡潔に回答する' };
  const first = buildPromptOutput(input, x.env);
  assert.match(first.systemMessage, /PostToolUse（無効）/);
  assert.match(first.hookSpecificOutput.additionalContext, /保存候補/);
  assert.equal(buildPromptOutput(input, x.env), null);
});
