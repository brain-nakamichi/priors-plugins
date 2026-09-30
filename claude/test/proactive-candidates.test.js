'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  pendingProactiveCandidates,
  summarizeProactiveCandidates,
  acknowledgeProactiveCandidates,
  materializeRememberCandidate,
  pendingRememberCandidates,
  listProactiveCandidates,
  materializeCheckpointCandidate,
  pendingCheckpointCandidates,
  confirmCheckpointCandidate,
  confirmRememberCandidate,
  materializeWorkItemCandidate,
  pendingWorkItemCandidates,
  confirmWorkItemCandidate,
  prepareWorkEvent,
  recordProactiveCandidate,
} = require('../hooks/proactive-candidates.js');

test('候補journalの壊れた行や別schemaを新規記録で消去しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-candidate-preserve-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  const other = JSON.stringify({ schema: 'priors.remember-candidate.v1', candidate_id: 'rc-keep' });
  fs.writeFileSync(file, `${other}\n{broken-json\n`);
  const result = recordProactiveCandidate({ promptHash: '9'.repeat(64), signals: ['remember-candidate'] }, env);
  assert.ok(result && result.event);
  const stored = fs.readFileSync(file, 'utf8');
  assert.match(stored, /rc-keep/);
  assert.match(stored, /broken-json/);
  assert.match(stored, /priors\.proactive-candidate\.v1/);
});

test('候補journalの壊れた行が有効なpending候補を隠さない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-candidate-read-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    fs.writeFileSync(file, `{broken-json\n${JSON.stringify({
      schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(),
      prompt_sha256: 'a'.repeat(64), categories: ['recall-likely'], source: 'local-heuristic', confidence: 'low',
    })}\n`);
    assert.equal(pendingProactiveCandidates(env).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('壊れた行がRemember/Checkpoint/Work候補の既存記録を消さない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-candidate-materialize-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    const source = { schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(),
      prompt_sha256: 'b'.repeat(64), candidate_id: 'pc-b', categories: ['remember-candidate'], confidence: 'low' };
    const keep = { schema: 'priors.remember-candidate.v1', candidate_id: 'rc-keep', confirmation_state: 'pending', generated_at: new Date().toISOString() };
    fs.writeFileSync(file, `${JSON.stringify(source)}\n{broken-json\n${JSON.stringify(keep)}\n`);
    const result = materializeRememberCandidate(env);
    assert.ok(result.candidate);
    assert.match(fs.readFileSync(file, 'utf8'), /rc-keep/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('確認済み・期限切れ候補はpending要約から除外される', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-candidate-state-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    fs.writeFileSync(file, [
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(), prompt_sha256: 'a'.repeat(64), categories: ['recall-likely'], source: 'local-heuristic', confidence: 'low' },
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(), prompt_sha256: 'b'.repeat(64), categories: ['remember-candidate'], source: 'local-heuristic', confidence: 'low', reviewed_at: new Date().toISOString(), review_decision: 'skip' },
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), prompt_sha256: 'c'.repeat(64), categories: ['unresolved-candidate'], source: 'local-heuristic', confidence: 'low' },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(pendingProactiveCandidates(env).length, 1);
    assert.deepEqual(summarizeProactiveCandidates(env), {
      total: 1,
      high_confidence: 0,
      categories: { 'recall-likely': 1, 'remember-candidate': 0, 'unresolved-candidate': 0, 'work-item-candidate': 0 },
    });
    assert.equal(acknowledgeProactiveCandidates('skip', env), 1);
    assert.equal(pendingProactiveCandidates(env).length, 0);
    const stored = fs.readFileSync(file, 'utf8');
    assert.match(stored, /review_decision":"skip/);
    assert.doesNotMatch(stored, /a{64}.*secret/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('use-readはRecall候補だけを確認済みにする', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-candidate-read-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    fs.writeFileSync(file, [
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(), prompt_sha256: 'd'.repeat(64), categories: ['recall-likely'], source: 'local-heuristic', confidence: 'low' },
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(), prompt_sha256: 'e'.repeat(64), categories: ['remember-candidate'], source: 'local-heuristic', confidence: 'low' },
    ].map(JSON.stringify).join('\n') + '\n');
    assert.equal(acknowledgeProactiveCandidates('use-read', env), 1);
    const pending = pendingProactiveCandidates(env);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].categories, ['remember-candidate']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会話終了時に本文なしのRemember候補を一件へ集約する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-remember-materialize-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    fs.writeFileSync(file, [
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(), prompt_sha256: 'f'.repeat(64), candidate_id: 'pc-f', categories: ['remember-candidate'], source: 'local-heuristic', confidence: 'high' },
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(), prompt_sha256: '1'.repeat(64), candidate_id: 'pc-1', categories: ['recall-likely'], source: 'local-heuristic', confidence: 'low' },
    ].map(JSON.stringify).join('\n') + '\n');
    const first = materializeRememberCandidate(env);
    assert.equal(first.duplicate, false);
    assert.equal(first.candidate.schema, 'priors.remember-candidate.v1');
    assert.equal(first.candidate.confirmation_state, 'pending');
    assert.equal(first.candidate.requires_confirmation, true);
    assert.deepEqual(pendingRememberCandidates(env).map((item) => item.candidate_id), [first.candidate.candidate_id]);
    assert.equal(materializeRememberCandidate(env).duplicate, true);
    const stored = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(stored, /conversation secret/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会話終了時にwork IDを推測しない作業台帳候補を集約する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-work-materialize-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    fs.writeFileSync(file, JSON.stringify({
      schema: 'priors.proactive-candidate.v1',
      recorded_at: new Date().toISOString(),
      prompt_sha256: '2'.repeat(64),
      candidate_id: 'pc-2',
      categories: ['work-item-candidate'],
      source: 'local-heuristic',
      confidence: 'high',
    }) + '\n');
    const result = materializeWorkItemCandidate(env);
    assert.equal(result.duplicate, false);
    assert.equal(result.candidate.schema, 'priors.work-item-candidate.v1');
    assert.equal(result.candidate.work_selection, 'required');
    assert.equal(result.candidate.confirmation_state, 'pending');
    assert.equal(pendingWorkItemCandidates(env).length, 1);
    assert.match(result.candidate.next_action, /brief/);
    assert.doesNotMatch(JSON.stringify(result.candidate), /GEN-w\d+/);
    const confirmed = confirmWorkItemCandidate(result.candidate.candidate_id, 'GEN-w12', env);
    assert.deepEqual(confirmed, { ok: true, candidate_id: result.candidate.candidate_id, work_id: 'GEN-w12' });
    assert.equal(pendingWorkItemCandidates(env).length, 0);
    const stored = fs.readFileSync(file, 'utf8');
    assert.match(stored, /"confirmation_state":"confirmed"/);
    assert.match(stored, /"confirmed_work_id":"GEN-w12"/);
    assert.equal(confirmWorkItemCandidate(result.candidate.candidate_id, 'GEN-w12', env).error, 'candidate_not_pending');
    assert.equal(confirmWorkItemCandidate(result.candidate.candidate_id, 'GEN-12', env).error, 'invalid_id');

    const request = prepareWorkEvent(result.candidate.candidate_id, 'GEN-w12', {
      expected_work_version: 1,
      event_type: 'verification_recorded',
      verification_state: 'passed',
      verification_environment: 'plugin-test',
      verification_method: 'node:test',
      verification_target: { type: 'work', id: 'GEN-w12', version: 1 },
      verification_tool_output: { status: 'passed', tests: 64 },
      verification_assessment: { decision: 'pass', reason: 'all checks passed' },
      verification_executed_at: '2026-09-28T00:00:00Z',
      verification_source: { type: 'command', reference: 'npm test' },
      basis: [{ type: 'test', detail: '64/64' }],
    }, env);
    assert.equal(request.ok, true);
    assert.equal(request.payload.work_id, 'GEN-w12');
    assert.equal(request.payload.expected_work_version, 1);
    assert.deepEqual(request.payload.basis, [{ type: 'test', detail: '64/64' }]);
    assert.deepEqual(request.payload.verification_target, { type: 'work', id: 'GEN-w12', version: 1 });
    assert.equal(request.payload.verification_tool_output.status, 'passed');
    assert.equal(prepareWorkEvent(result.candidate.candidate_id, 'GEN-w12', {
      expected_work_version: 1, event_type: 'resolve', basis: [],
    }, env).error, 'basis_required');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Remember候補はレビュー済みpayloadを明示確認してからrememberへ渡せる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-remember-confirm-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    fs.writeFileSync(file, JSON.stringify({
      schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(),
      prompt_sha256: '3'.repeat(64), candidate_id: 'pc-3', categories: ['remember-candidate'],
      source: 'local-heuristic', confidence: 'high',
    }) + '\n');
    const result = materializeRememberCandidate(env);
    const payload = {
      namespace: 'GEN', kind: 'decision', memory_type: 'semantic',
      title: 'レビュー済み決定', body: '会話から人間が確認した内容',
      idempotency_key: 'remember-confirm-1', evidence: [{ type: 'conversation_hash', sha256: '3'.repeat(64) }],
    };
    const confirmed = confirmRememberCandidate(result.candidate.candidate_id, payload, env);
    assert.equal(confirmed.ok, true);
    assert.deepEqual(confirmed.payload, payload);
    assert.equal(pendingRememberCandidates(env).length, 0);
    const stored = fs.readFileSync(file, 'utf8');
    assert.match(stored, /"confirmation_state":"confirmed"/);
    assert.match(stored, /"confirmed_payload_sha256":"[0-9a-f]{64}"/);
    assert.doesNotMatch(stored, /レビュー済み決定|会話から人間/);
    assert.equal(confirmRememberCandidate(result.candidate.candidate_id, payload, env).error, 'candidate_not_pending');
    assert.equal(confirmRememberCandidate(result.candidate.candidate_id, { ...payload, body: '' }, env).error, 'invalid_payload');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('候補一覧はrouting metadataだけを返し本文とhashを含めない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-candidate-list-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    fs.writeFileSync(file, JSON.stringify({
      schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(),
      prompt_sha256: '4'.repeat(64), candidate_id: 'pc-4', categories: ['recall-likely'],
      source: 'local-heuristic', confidence: 'high',
    }) + '\n');
    const listing = listProactiveCandidates(env);
    assert.equal(listing.total, 1);
    assert.equal(listing.candidates[0].candidate_id, 'pc-4');
    assert.equal(listing.candidates[0].confidence, 'high');
    assert.equal(Object.hasOwn(listing.candidates[0], 'prompt_sha256'), false);
    assert.doesNotMatch(JSON.stringify(listing), /4{64}/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未解決候補はレビュー済みcheckpoint payloadを明示確認できる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-checkpoint-confirm-'));
  const file = path.join(dir, 'candidates.jsonl');
  const env = { ...process.env, PRIORS_PROACTIVE_CANDIDATE_FILE: file };
  try {
    fs.writeFileSync(file, JSON.stringify({
      schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(),
      prompt_sha256: '5'.repeat(64), candidate_id: 'pc-5', categories: ['unresolved-candidate'],
      source: 'local-heuristic', confidence: 'high',
    }) + '\n');
    const result = materializeCheckpointCandidate(env);
    assert.match(result.candidate.candidate_id, /^cp-[0-9a-f]{16}$/);
    assert.equal(pendingCheckpointCandidates(env).length, 1);
    const payload = {
      theme: 'GEN', session_id: '11111111-1111-4111-8111-111111111111', phase: 'stop',
      summary: 'レビュー済みの未解決事項', idempotency_key: 'checkpoint-1',
      next_actions: ['次の作業を確認'], open_threads: ['問いを明示する'],
    };
    const confirmed = confirmCheckpointCandidate(result.candidate.candidate_id, payload, env);
    assert.equal(confirmed.ok, true);
    assert.deepEqual(confirmed.payload, payload);
    assert.equal(pendingCheckpointCandidates(env).length, 0);
    const stored = fs.readFileSync(file, 'utf8');
    assert.match(stored, /"confirmation_state":"confirmed"/);
    assert.doesNotMatch(stored, /レビュー済みの未解決事項/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
