'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inspectSensitiveInput, hasDisclosureReport, MAX_PROMPT_BYTES, MAX_CANDIDATE_CHARS } = require('../hooks/sensitive-input.js');
const { MAX_RAW_BYTES, readHookInput } = require('../hooks/bounded-input.js');
const { main: autoRecall } = require('../hooks/auto-recall.js');
const { proactiveSignals, proactiveGuidance, proactiveConfidence } = require('../hooks/user-prompt-submit.js');
const ROOT = path.join(__dirname, '..');
const DEV_CODEX = path.join(ROOT, '..', 'codex-plugins', 'priors');
const CODEX = fs.existsSync(DEV_CODEX) ? DEV_CODEX : path.join(ROOT, '..', 'codex');

// All values are synthetic, built here. Tests never read a live credential.
const cases = [
  ['credential_prefix', 'pv1h' + 'q'.repeat(59)],
  ['credential_prefix', 'pv1a' + 'q'.repeat(8)],
  ['credential_prefix', 'sbp_' + 'q'.repeat(8)],
  ['authorization_value', 'Authorization: Bearer q'],
  ['authorization_value', '"Authorization": "Bearer qqqqqqqq"'],
  ['jwt_shape', 'q'.repeat(16) + '.' + 'r'.repeat(8) + '.' + 's'.repeat(8)],
  ['credential_assignment', 'TOKEN=q'],
  ['credential_assignment', '"api_key": "synthetic-example"'],
  ['credential_assignment', 'PRIORS_TOKEN_CODEX_V1=synthetic-example'],
  ['connection_password', 'postgresql://dummy:synthetic-example@example.invalid/database'],
  ['credential_prefix', 'sk-ant-' + 'q'.repeat(8)],
  ['credential_prefix', 'sk-proj-' + 'q'.repeat(8)],
  ['credential_prefix', 'sk-' + 'q'.repeat(20)],
  ['credential_prefix', 'ghp_' + 'q'.repeat(8)],
  ['credential_prefix', 'github_pat_' + 'q'.repeat(8)],
  ['credential_assignment', 'SUPABASE_ACCESS_TOKEN=synthetic-example'],
  ['credential_assignment', 'VERCEL_TOKEN=synthetic-example'],
  ['credential_assignment', 'PGPASSWORD=synthetic-example'],
];
for (const [index, [code, prompt]] of cases.entries()) test(`local detector: ${code} fixture ${index}`, () => {
  const result = inspectSensitiveInput(prompt);
  assert.equal(result.state, 'suspected');
  assert.equal(result.suppress_auto_recall, true);
  assert.ok(result.codes.includes(code));
  assert.deepEqual(Object.keys(result), ['state', 'codes', 'suppress_auto_recall']);
  assert.ok(!JSON.stringify(result).includes(prompt));
});

test('whole placeholders and unrelated IDs remain clear; mixed placeholders do not', () => {
  for (const prompt of ['token=<TOKEN>', 'password="${ENV_NAME}"', 'Bearer REDACTED', 'Authorization: Bearer YOUR_TOKEN', 'secret=*****', 'password=xxxx', 'sk-example', 'sk-ant-<TOKEN>', 'ghp_<TOKEN>', 'github_pat_***', 'https://example.invalid/path', 'dpl_' + 'q'.repeat(32), '00000000-0000-0000-0000-000000000000', '後回しにしない', '前回の仕様を再開']) {
    assert.equal(inspectSensitiveInput(prompt).state, 'clear');
  }
  for (const prompt of ['token=<TOKEN>suffix', 'Bearer dummy-but-real-shaped', 'token=part…', 'token=part...', 'secret="prefix ${ENV_NAME}"']) {
    assert.equal(inspectSensitiveInput(prompt).state, 'suspected');
  }
});

test('normalization, one ASCII escape pass and code ordering', () => {
  for (const prompt of ['ｔｏｋｅｎ＝synthetic-example', 'to\u200bken=synthetic-example', '\\u0074oken=synthetic-example', 'postgresql:\\/\\/dummy:synthetic-example@example.invalid/db']) {
    assert.equal(inspectSensitiveInput(prompt).state, 'suspected');
  }
  const result = inspectSensitiveInput(cases.map(x => x[1]).join('\n'));
  assert.deepEqual(result.codes, ['connection_password', 'credential_prefix', 'authorization_value', 'jwt_shape']);
});

test('GEN-940 redacted output and shell variable references remain clear on both clients', () => {
  const clear = [
    '"Authorization": "[REDACTED]"',
    'Authorization: Bearer [REDACTED]',
    '"Authorization": "Bearer $t"',
    'Bearer $t',
    'Bearer $TOKEN_2',
    'token=$t',
    'password="[REDACTED]"',
    '$t = (Get-Clipboard).Trim(); claude mcp add priors --header "Authorization: Bearer $t"; $t = $null',
  ];
  const suspect = [
    'Bearer [REDACTED]suffix',
    'Bearer prefix[REDACTED]',
    'Bearer $t-suffix',
    'Bearer $t.synthetic',
    'Bearer $t$other',
    'token="prefix $t"',
    '"Authorization": "[REDACTED]", "SUPABASE_ACCESS_TOKEN": "sbp_' + 'q'.repeat(40) + '"',
    'Bearer $t\nAuthorization: Bearer synthetic-sensitive-example',
  ];
  for (const root of [ROOT, CODEX]) {
    const inspect = require(path.join(root, 'hooks', 'sensitive-input.js')).inspectSensitiveInput;
    for (const prompt of clear) assert.deepEqual(inspect(prompt), { state: 'clear', codes: [], suppress_auto_recall: false });
    for (const prompt of suspect) {
      assert.equal(inspect(prompt).state, 'suspected');
      assert.equal(inspect(prompt).suppress_auto_recall, true);
    }
  }
});

test('prompt and candidate bounds are inclusive; oversized input cannot pass', () => {
  for (const count of [MAX_PROMPT_BYTES - 1, MAX_PROMPT_BYTES]) assert.equal(inspectSensitiveInput('z'.repeat(count)).state, 'clear');
  assert.equal(inspectSensitiveInput('z'.repeat(MAX_PROMPT_BYTES + 1)).state, 'uninspectable');
  assert.equal(inspectSensitiveInput('あ'.repeat(Math.ceil(MAX_PROMPT_BYTES / 3))).state, 'uninspectable');
  for (const count of [MAX_CANDIDATE_CHARS - 1, MAX_CANDIDATE_CHARS, MAX_CANDIDATE_CHARS + 1]) {
    assert.equal(inspectSensitiveInput('token=' + 'q'.repeat(count)).state, 'suspected');
  }
  for (const prompt of [null, {}, 7, undefined]) assert.equal(inspectSensitiveInput(prompt).state, 'uninspectable');
  assert.equal(inspectSensitiveInput('').state, 'clear');
});

test('bounded reader rejects malformed, missing, non-string and invalid UTF8', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-bounded-'));
  function read(data) {
    const file = path.join(dir, 'input'); fs.writeFileSync(file, data);
    const fd = fs.openSync(file, 'r');
    try { return readHookInput(fd); } finally { fs.closeSync(fd); }
  }
  try {
    for (const data of ['', '{broken', '{}', '{"prompt":4}', '[]', Buffer.from([0xff])]) assert.equal(read(data).reason, 'invalid_input');
    assert.deepEqual(read('{"prompt":""}'), { ok: true, input: { prompt: '' } });
    for (const size of [MAX_RAW_BYTES - 1, MAX_RAW_BYTES]) assert.equal(read('{"prompt":""}' + ' '.repeat(size - 13)).ok, true);
    assert.deepEqual(read('z'.repeat(MAX_RAW_BYTES + 1)), { ok: false, reason: 'input_too_large' });
    assert.deepEqual(readHookInput(-1), { ok: false, reason: 'invalid_input' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('standalone recall blocks before env, cwd, token/config and fetch access', async () => {
  const saved = global.fetch;
  let calls = 0;
  global.fetch = () => { calls++; throw new Error('must not fetch'); };
  const env = new Proxy({}, { get() { throw new Error('must not read environment'); } });
  try {
    for (const prompt of [...cases.map(x => x[1]), 'z'.repeat(MAX_PROMPT_BYTES + 1), undefined]) {
      const input = { prompt, get cwd() { throw new Error('must not read config'); } };
      const result = await autoRecall(input, env);
      assert.equal(result.ok, false);
      assert.ok(['input_suspected_sensitive', 'input_uninspectable'].includes(result.reason));
    }
    assert.equal(calls, 0);
  } finally { global.fetch = saved; }
});

test('both prompt hooks suppress spawn, prompt/hash/candidate writes and raw errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-sensitive-hook-'));
  const preload = path.join(dir, 'preload.js');
  fs.writeFileSync(preload, "require('node:child_process').spawnSync = () => { require('node:fs').writeFileSync(process.env.SPAWN_MARKER, 'called'); throw new Error('synthetic-raw-error'); };\n");
  try {
    for (const root of [ROOT, CODEX]) for (const remember of ['0', '1']) {
      const audit = path.join(dir, 'audit'); const candidate = path.join(dir, 'candidate'); const marker = path.join(dir, 'spawn');
      for (const file of [audit, candidate, marker]) fs.rmSync(file, { force: true });
      const prompt = '前回の仕様を再開する。 token=synthetic-sensitive-example';
      const hash = crypto.createHash('sha256').update(prompt).digest('hex');
      const child = spawnSync(process.execPath, ['--require', preload, path.join(root, 'hooks', 'user-prompt-submit.js')], { input: JSON.stringify({ prompt }), encoding: 'utf8', env: { ...process.env, PRIORS_AUTO_RECALL: '1', PRIORS_AUTO_RECALL_LIVE: '1', PRIORS_AUTO_REMEMBER: remember, PRIORS_DECISION_AUDIT_FILE: audit, PRIORS_PROACTIVE_CANDIDATE_FILE: candidate, SPAWN_MARKER: marker } });
      assert.equal(child.status, 0);
      assert.match(JSON.parse(child.stdout).hookSpecificOutput.additionalContext, /hash/);
      const event = JSON.parse(fs.readFileSync(audit, 'utf8'));
      assert.equal(event.decision, 'pending'); assert.equal(event.prompt_sha256, undefined);
      assert.equal(fs.existsSync(candidate), false); assert.equal(fs.existsSync(marker), false);
      for (const text of [child.stdout, child.stderr, fs.readFileSync(audit, 'utf8')]) {
        for (const value of [prompt, 'synthetic-sensitive-example', hash, 'synthetic-raw-error']) assert.ok(!text.includes(value));
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing detector/reader and CLI malformed input fail closed with fixed output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-sensitive-fault-'));
  try {
    fs.cpSync(path.join(ROOT, 'hooks'), path.join(dir, 'hooks'), { recursive: true });
    const env = { ...process.env, PRIORS_AUTO_RECALL: '1', PRIORS_AUTO_RECALL_LIVE: '1', PRIORS_AUTO_REMEMBER: '0', PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit'), PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidate') };
    for (const fault of ['malformed', 'sensitive-input.js', 'bounded-input.js']) {
      if (fault !== 'malformed') fs.rmSync(path.join(dir, 'hooks', fault));
      for (const name of ['user-prompt-submit.js', 'auto-recall.js']) {
        const child = spawnSync(process.execPath, [path.join(dir, 'hooks', name)], { env, input: fault === 'malformed' ? '{bad' : '{"prompt":"前回の仕様を再開"}', encoding: 'utf8' });
        assert.equal(child.status, 0); assert.equal(child.stderr, '');
        const result = JSON.parse(child.stdout);
        if (name === 'auto-recall.js') assert.deepEqual(result, { ok: false, reason: 'input_uninspectable' });
        else assert.match(result.hookSpecificOutput.additionalContext, /検査できない|検査できないため/);
      }
    }
    assert.equal(fs.existsSync(path.join(dir, 'candidate')), false);
    assert.ok(!fs.readFileSync(path.join(dir, 'audit'), 'utf8').includes('prompt_sha256'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deferred cues use existing categories and shared guidance; hand alone is low', () => {
  for (const prompt of ['対応は後回しにする', 'あとで交換する', '修正を延期します']) {
    const signals = proactiveSignals(prompt);
    assert.ok(signals.includes('unresolved-candidate')); assert.ok(signals.includes('work-item-candidate'));
    assert.equal(proactiveConfidence(prompt, signals), 'high');
    assert.match(proactiveGuidance(signals, prompt), /否定・引用・完了報告/);
  }
  const prompt = 'お手元に資料があります';
  assert.equal(proactiveConfidence(prompt, proactiveSignals(prompt)), 'low');
  for (const prompt of ['後回しにしないで対応する', '引用「あとで対応する」', '延期した対応は完了した']) {
    assert.match(proactiveGuidance(proactiveSignals(prompt), prompt), /否定・引用・完了報告/);
  }
});

test('Codex helper copies match; prompt event remains unregistered', () => {
  for (const name of ['sensitive-input.js', 'bounded-input.js']) assert.equal(fs.readFileSync(path.join(ROOT, 'hooks', name), 'utf8'), fs.readFileSync(path.join(CODEX, 'hooks', name), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(CODEX, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit, undefined);
  for (const root of [ROOT, CODEX]) {
    const skill = fs.readFileSync(path.join(root, 'skills', 'priors', 'SKILL.md'), 'utf8') + (root === ROOT ? fs.readFileSync(path.join(ROOT, 'skills', 'priors', 'deferred-work.md'), 'utf8') : '');
    assert.match(skill, /UUID/); assert.match(skill, /full brief/); assert.match(skill, /idempotency_key/);
  }
});

test('October 6 config-output shape uses synthetic Authorization and PAT fixtures', () => {
  const prompt = JSON.stringify({ projects: { 'unrelated-example': { mcpServers: { priors: { headers: { Authorization: 'Bearer ' + 'pv1i' + 'q'.repeat(59) } }, supabase: { env: { SUPABASE_ACCESS_TOKEN: 'sbp_' + 'q'.repeat(40) } } } } } });
  const result = inspectSensitiveInput(prompt);
  assert.equal(result.state, 'suspected');
  assert.ok(result.codes.includes('credential_prefix'));
  assert.ok(result.codes.includes('authorization_value'));
  assert.ok(result.codes.includes('credential_assignment'));
});

test('value-free reports are work cues, not an automatic search veto', () => {
  for (const prompt of ['認証情報を貼ってしまったので対応します', '漏洩した可能性のあるパスワード']) {
    assert.equal(hasDisclosureReport(prompt), true);
    assert.equal(inspectSensitiveInput(prompt).suppress_auto_recall, false);
  }
  assert.equal(inspectSensitiveInput('トークンを貼った token=synthetic-example').suppress_auto_recall, true);
});

test('safe random audit notices survive end decision and trigger both Stop reminders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-safe-notice-'));
  try {
    for (const root of [ROOT, CODEX]) {
      const audit = require(path.join(root, 'hooks', 'decision-audit.js'));
      const env = { ...process.env, PRIORS_AUTO_REMEMBER: '1', PRIORS_DECISION_AUDIT_FILE: path.join(dir, path.basename(root) + '-audit'), PRIORS_STOP_DIAGNOSTIC_FILE: path.join(dir, 'stop'), PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidate') };
      const client = root === ROOT ? 'claude' : 'codex';
      const notice = audit.recordDecision({ decision: 'pending', client, phase: 'turn-start', source: 'hook', inputSafety: 'suspected', promptHash: 'a'.repeat(64) }, env);
      assert.equal(notice.event.prompt_sha256, undefined);
      assert.match(notice.event.safety_notice_id, /^[0-9a-f-]{36}$/);
      audit.recordDecision({ decision: 'skip', client, phase: 'conversation-end' }, env);
      assert.equal(audit.inputSafetySummary(env).suspected, 1);
      const stop = spawnSync(process.execPath, [path.join(root, 'hooks', 'conversation-end.js')], { env, input: '{}', encoding: 'utf8' });
      assert.equal(stop.status, 0); assert.match(stop.stdout, /秘密疑い 1件/); assert.match(stop.stdout, /作業項目があるか/);
      audit.recordDecision({ decision: 'pending', client, phase: 'turn-start', source: 'hook' }, env);
      assert.equal(audit.inputSafetySummary(env).suspected, 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit I/O failures never echo sensitive input; CLI oversize drains and emits fixed output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-sensitive-io-'));
  try {
    const blocker = path.join(dir, 'blocker'); fs.writeFileSync(blocker, 'not a directory');
    const env = { ...process.env, PRIORS_AUTO_RECALL: '1', PRIORS_AUTO_REMEMBER: '0', PRIORS_DECISION_AUDIT_FILE: path.join(blocker, 'audit'), PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidate') };
    for (const input of [JSON.stringify({ prompt: 'token=synthetic-error-case' }), ' '.repeat(MAX_RAW_BYTES + 1)]) {
      for (const name of ['user-prompt-submit.js', 'auto-recall.js']) {
        const result = spawnSync(process.execPath, [path.join(ROOT, 'hooks', name)], { env, input, encoding: 'utf8' });
        assert.equal(result.status, 0); assert.equal(result.error, undefined); assert.equal(result.stderr, '');
        assert.ok(!result.stdout.includes('synthetic-error-case')); assert.ok(!result.stdout.includes(blocker));
        const parsed = JSON.parse(result.stdout);
        if (name === 'auto-recall.js') assert.equal(parsed.ok, false);
      }
    }
    assert.equal(fs.existsSync(path.join(dir, 'candidate')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Codex explicit safety recorder accepts only fixed categories and counts without extra pending decisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-codex-safety-cli-'));
  try {
    const env = { ...process.env, PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit') };
    const script = path.join(CODEX, 'scripts', 'record-input-safety.js');
    const good = spawnSync(process.execPath, [script, '--kind', 'reported'], { env, encoding: 'utf8' });
    assert.equal(good.status, 0);
    const audit = require(path.join(CODEX, 'hooks', 'decision-audit.js'));
    assert.equal(audit.inputSafetySummary(env).reported, 1);
    assert.equal(audit.auditHealth(env).pending_turn_starts, 0);
    const bad = spawnSync(process.execPath, [script, '--kind', 'synthetic-sensitive-value'], { env, encoding: 'utf8' });
    assert.equal(bad.status, 2); assert.ok(!bad.stdout.includes('synthetic-sensitive-value'));
    assert.equal(fs.readFileSync(env.PRIORS_DECISION_AUDIT_FILE, 'utf8').trim().split('\n').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('other client decisions cannot clear or contaminate a safety notice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-client-notice-'));
  try {
    const env = { PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit') };
    const audit = require('../hooks/decision-audit.js');
    audit.recordDecision({ decision: 'pending', client: 'claude', phase: 'turn-start', inputSafety: 'suspected' }, env);
    audit.recordDecision({ decision: 'skip', client: 'codex', phase: 'conversation-end', inputSafety: 'reported' }, env);
    audit.recordDecision({ decision: 'pending', client: 'codex', phase: 'turn-start' }, env);
    assert.deepEqual(audit.inputSafetySummary(env), { suspected: 1, reported: 0, uninspectable: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
