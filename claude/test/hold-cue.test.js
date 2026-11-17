'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const signals = require('../hooks/retention-signals.js');
const candidates = require('../hooks/proactive-candidates.js');
const codexRoot = fs.existsSync(path.join(root, '../codex-hooks'))
  ? path.join(root, '../codex-hooks') : path.join(root, '../codex-plugins/priors-hooks');
const codex = require(path.join(codexRoot, 'hooks/retention-runtime.js'));
const sid = crypto.randomUUID();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-hold-cue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { ...process.env, PLUGIN_DATA: dir, PRIORS_AUTO_REMEMBER: '1',
    PRIORS_AUTO_RECALL: '0', PRIORS_AUTO_RECALL_LIVE: '0',
    PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl'),
    PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
    PRIORS_STOP_DIAGNOSTIC_FILE: path.join(dir, 'stop.jsonl'),
    PRIORS_COMPACT_CHECKPOINT_FILE: path.join(dir, 'compact.json'),
    PRIORS_TURN_STATE_FILE: path.join(dir, 'turn-state.json') } };
}
function claude(name, input, env, args = []) {
  const child = spawnSync(process.execPath, [path.join(root, 'hooks', name), ...args],
    { env, input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout ? JSON.parse(child.stdout) : null;
}
const prompt = (turn, text, extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: sid, turn_id: turn, prompt: text, ...extra });
const stop = turn => ({ hook_event_name: 'Stop', session_id: sid, turn_id: turn });

test('hold detects undecided questions; confidence is low unless question and topic words coexist', () => {
  for (const [text, confidence] of [
    ['地図の方式はどうですか', 'low'], ['この仕組みできますか', 'low'],
    ['詳しく教えてください', 'low'], ['改善案ありますか', 'high'],
    ['A案とB案はどちらがよいですか', 'high'], ['別の方法の可能性を相談したいです', 'low'],
  ]) {
    const s = signals.proactiveSignals(text);
    assert.ok(s.includes('hold-candidate'), text);
    assert.equal(signals.proactiveConfidence(text, s), confidence, text);
  }
});

test('hold excludes decisions, directives, short replies and complete harness reports', () => {
  for (const text of ['案Aの採用を決定しました。どうですか？', '改善案を実装してください',
    'この方法で進めてください', '比較を記録してください', '比較の資料を読みました', '相談の結果を待っています', 'はい', 'ありがとう', 'こんにちは',
    '<task-notification>\n改善案ありますか\n</task-notification>',
    '<agent-message from="worker">\n比較案はどうですか\n</agent-message>']) {
    assert.equal(signals.proactiveSignals(text).includes('hold-candidate'), false, text);
  }
  assert.ok(signals.proactiveSignals('案Aの採用を決定しました').includes('remember-candidate'));
});

test('Claude hold metadata, prompt/Stop cue, same-turn skip and no input/transcript persistence', t => {
  const x = fixture(t), text = 'PRIVATE-HOLD-MARKER この改善案はどうですか';
  const out = claude('user-prompt-submit.js', { session_id: sid, prompt: text }, x.env);
  assert.match(out.hookSpecificOutput.additionalContext, /控え候補:/);
  assert.equal(out.hookSpecificOutput.additionalContext.split('控え候補:').length, 2);
  const p = candidates.pendingProactiveCandidates(x.env);
  assert.equal(p.length, 1);
  assert.ok(p[0].categories.includes('hold-candidate'));
  const end = claude('conversation-end.js', { session_id: sid, transcript: 'NEVER-READ-TRANSCRIPT' }, x.env);
  assert.match(end.hookSpecificOutput.additionalContext, /未処理の控え候補 1 件/);
  assert.match(end.hookSpecificOutput.additionalContext, /valid_to=.*90日後/);
  for (const file of fs.readdirSync(x.dir).filter(f => fs.statSync(path.join(x.dir, f)).isFile())) {
    assert.doesNotMatch(fs.readFileSync(path.join(x.dir, file), 'utf8'), /PRIVATE-HOLD-MARKER|NEVER-READ-TRANSCRIPT|この改善案/);
  }
  claude('record-decision.js', {}, x.env, ['--decision', 'skip', '--client', 'claude', '--phase', 'conversation-end', '--turn-id', p[0].turn_id]);
  assert.equal(candidates.pendingProactiveCandidates(x.env).length, 0);
  assert.equal(claude('conversation-end.js', { session_id: sid }, x.env), null);
});

test('Claude hold is excluded for secret-like input, harness and subagent provenance', t => {
  for (const input of [
    { prompt: 'この方法できますか TOKEN=sk-proj-clearlyfake12345678901234567890' },
    { prompt: '<task-notification>\n改善案ありますか\n</task-notification>' },
    { prompt: '改善案ありますか', agent_id: 'worker' },
    { prompt: '改善案ありますか', source: 'subagent' },
  ]) {
    const x = fixture(t);
    const out = claude('user-prompt-submit.js', { session_id: sid, ...input }, x.env);
    assert.doesNotMatch(JSON.stringify(out), /控え候補:/);
    assert.equal(candidates.pendingProactiveCandidates(x.env).some(c => c.categories.includes('hold-candidate')), false);
    if (fs.existsSync(x.env.PRIORS_PROACTIVE_CANDIDATE_FILE))
      assert.doesNotMatch(fs.readFileSync(x.env.PRIORS_PROACTIVE_CANDIDATE_FILE, 'utf8'), /sk-proj|clearlyfake/);
  }
});

test('hold confidence cannot itself trigger Claude autoRecall', t => {
  const x = fixture(t);
  // Run the actual entry point with autoRecall enabled, but replace its child process with a counter.
  // No network request or provider is reachable even if this regression test fails.
  const script = `let calls=0;require('node:child_process').spawnSync=()=>{calls++;return {status:0,stdout:'{}'}};require(${JSON.stringify(path.join(root, 'hooks/user-prompt-submit.js'))}).main();process.stderr.write(String(calls));`;
  const child = spawnSync(process.execPath, ['-e', script], { env: { ...x.env, PRIORS_AUTO_RECALL: '1', PRIORS_AUTO_RECALL_LIVE: '1' },
    input: JSON.stringify({ session_id: sid, prompt: '本番の改善案はどうですか' }), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0);
  assert.match(JSON.parse(child.stdout).hookSpecificOutput.additionalContext, /控え候補:/);
  assert.equal(child.stderr, '0', 'hold confidence must not start an autoRecall child');
});

test('Codex hold gives one prompt cue and Stop count, with once-only carry and no forced turn', t => {
  const x = fixture(t), turn = crypto.randomUUID();
  const out = codex.handle(prompt(turn, 'PRIVATE-HOLD-MARKER 改善案ありますか'), x.env);
  assert.match(out.hookSpecificOutput.additionalContext, /控え候補:/);
  const raw = fs.readFileSync(codex.statePath(x.env), 'utf8');
  assert.doesNotMatch(raw, /PRIVATE-HOLD-MARKER|改善案|prompt|transcript|sha256/);
  assert.ok(JSON.parse(raw).sessions[0].turns[0].categories.includes('hold-candidate'));
  const end = codex.handle(stop(turn), x.env);
  assert.deepEqual(Object.keys(end), ['systemMessage']);
  assert.match(end.systemMessage, /控え候補 1 件/);
  assert.equal(codex.handle(stop(turn), x.env), null);
  assert.match(codex.handle(prompt(crypto.randomUUID(), 'こんにちは'), x.env).hookSpecificOutput.additionalContext, /前ターン/);
  assert.equal(codex.handle(prompt(crypto.randomUUID(), 'こんにちは'), x.env), null);
});

test('Codex excludes secret, agent and harness hold inputs without recording state', t => {
  const x = fixture(t);
  for (const [text, extra] of [
    ['改善案ありますか TOKEN=sk-proj-clearlyfake12345678901234567890', {}],
    ['改善案ありますか', { agent_id: 'worker' }],
    ['改善案ありますか', { source: 'subagent' }],
    ['<task-notification>\n改善案ありますか\n</task-notification>', {}],
  ]) assert.equal(codex.handle(prompt(crypto.randomUUID(), text, extra), x.env), null);
  assert.equal(fs.existsSync(codex.statePath(x.env)), false);
});

test('hold save receipt clears only matched success; replay and failures remain pending in both clients', t => {
  const x = fixture(t), turn = crypto.randomUUID();
  codex.handle(prompt(turn, '改善案ありますか'), x.env);
  const id = JSON.parse(fs.readFileSync(codex.statePath(x.env))).sessions[0].turns[0].candidate_id;
  const result = { operation: 'remember', outcome_code: 'recorded', resource_ids: [{ role: 'primary', id: 'ZZ-1', version: 1 }],
    candidate_receipts: [{ candidate_id: id, resource_ids: ['ZZ-1@1'] }] };
  const save = value => codex.handle({ hook_event_name: 'PostToolUse', session_id: sid, turn_id: turn,
    tool_name: 'mcp__priors__remember', tool_input: { candidate_id: id }, tool_response: value }, x.env);
  save({ ...result, replayed: true });
  save({ ...result, outcome_code: 'failed' });
  assert.equal(JSON.parse(fs.readFileSync(codex.statePath(x.env))).sessions[0].turns[0].acknowledged, false);
  save(result);
  assert.equal(codex.handle(stop(turn), x.env), null);
  const c = candidates.recordProactiveCandidate({ promptHash: 'b'.repeat(64), signals: ['hold-candidate'], turnId: turn }, x.env).event;
  const receipts = [{ candidate_id: c.candidate_id, resource_ids: ['ZZ-1@1'] }];
  assert.deepEqual(candidates.candidateReceiptForSave(turn, 'remember', receipts, ['ZZ-1@1'], x.env), receipts);
  candidates.acknowledgeProactiveCandidateIds([c.candidate_id], 'write-candidate', x.env);
  assert.equal(candidates.summarizeProactiveCandidates(x.env).categories['hold-candidate'], 0);
});
