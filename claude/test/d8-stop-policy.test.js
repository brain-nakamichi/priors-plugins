'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordDecision, currentTurnAudit, activeTurnId, recordStopInvocation } = require('../hooks/decision-audit.js');
const {
  recordProactiveCandidate,
  pendingProactiveCandidates,
  candidateReceiptForSave,
  acknowledgeProactiveCandidates,
  acknowledgeProactiveCandidateIds,
} = require('../hooks/proactive-candidates.js');
const { reminderPayload } = require('../hooks/conversation-end.js');
const { recordTurnCandidate, proactiveSignals, proactiveConfidence } = require('../hooks/user-prompt-submit.js');
const { postToolSaveObservation, recordSaveObservation } = require('../hooks/post-tool-save.js');
const { run: runRecordDecision } = require('../hooks/record-decision.js');
const { run: runAcknowledgeCandidates } = require('../hooks/acknowledge-proactive-candidates.js');

const SESSION = '11111111-1111-4111-8111-111111111111';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-d8-'));
  const env = {
    ...process.env,
    PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
    PRIORS_STOP_DIAGNOSTIC_FILE: path.join(dir, 'stop.jsonl'),
    PRIORS_TURN_STATE_FILE: path.join(dir, 'turn-state.json'),
    PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl'),
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, env };
}

function turn(env, sessionId = SESSION, turnId = cryptoId()) {
  recordDecision({ decision: 'pending', client: 'claude', source: 'hook', phase: 'turn-start', invocationKind: 'client-hook', sessionId, turnId }, env);
  return turnId;
}

function cryptoId() {
  return require('node:crypto').randomUUID();
}

function candidate(env, turnId, category, promptHash = require('node:crypto').randomBytes(32).toString('hex')) {
  return recordProactiveCandidate({ promptHash, signals: [category], confidence: 'high', turnId }, env).event;
}

test('D8: no candidate means no Stop prompt', () => {
  assert.equal(reminderPayload({ pendingCandidateCount: 0 }), null);
  assert.equal(reminderPayload({ pendingCandidateCount: 0, invalidLines: 0 }), null);
});

test('D8: 20 ordinary turns create no candidate or Stop prompt in autonomous mode', (t) => {
  const { env } = fixture(t);
  for (let index = 0; index < 20; index++) {
    const turnId = turn(env);
    const hash = require('node:crypto').createHash('sha256').update(`ordinary question ${index}`).digest('hex');
    assert.equal(recordTurnCandidate(hash, [], 'low', turnId, env), null);
    assert.equal(fs.existsSync(env.PRIORS_PROACTIVE_CANDIDATE_FILE), false);
    assert.equal(reminderPayload({ pendingCandidateCount: pendingProactiveCandidates(env).length }), null);
  }
});

test('D8: important-decision candidate is recorded in autonomous mode without body text', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const privatePrompt = '今後もこの判断を使う。秘密値は保存しない';
  const hash = require('node:crypto').createHash('sha256').update(privatePrompt).digest('hex');
  const signals = proactiveSignals(privatePrompt);
  assert.ok(signals.includes('remember-candidate'));
  assert.ok(signals.includes('continuing-request-candidate'));
  const result = recordTurnCandidate(hash, signals, proactiveConfidence(privatePrompt, signals), turnId, env);
  assert.equal(result.event.turn_id, turnId);
  assert.deepEqual(result.event.categories, ['remember-candidate', 'continuing-request-candidate']);
  const stored = fs.readFileSync(env.PRIORS_PROACTIVE_CANDIDATE_FILE, 'utf8');
  assert.doesNotMatch(stored, /今後もこの判断|秘密値/);
  assert.match(stored, new RegExp(`"turn_id":"${turnId}"`));
  assert.notEqual(reminderPayload({ pendingCandidateCount: pendingProactiveCandidates(env).length }), null);
});

test('D8: 20 candidate turns explicitly marked no-save produce no candidate-only Stop prompts', (t) => {
  const { env } = fixture(t);
  for (let index = 0; index < 20; index++) {
    const turnId = turn(env);
    candidate(env, turnId, 'remember-candidate');
    const state = recordDecision({ decision: 'skip', client: 'claude', phase: 'conversation-end', sessionId: SESSION, turnId }, env).event;
    assert.equal(state.turn_id, turnId);
    acknowledgeProactiveCandidates('skip', env, turnId);
    const pending = pendingProactiveCandidates(env).length;
    assert.equal(reminderPayload({ pendingCandidateCount: pending }), null, `turn ${index + 1}`);
  }
  assert.equal(pendingProactiveCandidates(env).length, 0);
});

test('D8: an important same-turn candidate remains actionable until saved or explicitly declined', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  candidate(env, turnId, 'remember-candidate');
  assert.equal(reminderPayload({ pendingCandidateCount: pendingProactiveCandidates(env).length })
    .hookSpecificOutput.hookEventName, 'Stop');
});

test('D8: use-read is not treated as a no-save decision for a Remember candidate', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const current = candidate(env, turnId, 'remember-candidate');
  recordDecision({ decision: 'use-read', client: 'claude', phase: 'conversation-end', sessionId: SESSION, turnId }, env);
  assert.equal(acknowledgeProactiveCandidates('use-read', env, turnId), 0);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [current.candidate_id]);
  assert.notEqual(reminderPayload({ pendingCandidateCount: 1 }), null);
});

test('D8: actual PostToolUse generic save leaves candidates; explicit resource receipt clears only its candidate', (t) => {
  const { env } = fixture(t);
  const oldId = turn(env, SESSION);
  const old = candidate(env, oldId, 'remember-candidate');
  const currentId = turn(env, SESSION);
  const current = candidate(env, currentId, 'remember-candidate');
  const unrelated = candidate(env, currentId, 'work-item-candidate');

  assert.equal(activeTurnId(SESSION, 'claude', env), currentId);
  const input = {
    session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'mcp__priors__remember',
    tool_input: { candidate_id: current.candidate_id },
    tool_response: { operation: 'remember', outcome_code: 'recorded', resource_ids: [{ role: 'primary', id: 'GEN-12', version: 1 }] },
  };
  const generic = postToolSaveObservation(input, env);
  assert.deepEqual(generic.save.candidate_receipts || [], []);
  recordDecision({ decision: 'write-candidate', client: 'claude', source: 'hook', phase: 'tool-save', sessionId: generic.sessionId, turnId: generic.turnId, save: generic.save }, env);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [old.candidate_id, current.candidate_id, unrelated.candidate_id]);

  input.tool_response.candidate_receipts = [{ candidate_id: current.candidate_id, resource_ids: ['GEN-12@1'] }];
  const matched = postToolSaveObservation(input, env);
  assert.deepEqual(matched.save.candidate_receipts, [{ candidate_id: current.candidate_id, resource_ids: ['GEN-12@1'] }]);
  recordDecision({ decision: 'write-candidate', client: 'claude', source: 'hook', phase: 'tool-save', sessionId: matched.sessionId, turnId: matched.turnId, save: matched.save }, env);
  const state = currentTurnAudit(SESSION, 'claude', env);
  assert.equal(state.turn_id, currentId);
  assert.equal(state.saves.length, 1);
  const receipt = state.saves[0].save.candidate_receipts;
  assert.deepEqual(receipt, [{ candidate_id: current.candidate_id, resource_ids: ['GEN-12@1'] }]);
  const validated = candidateReceiptForSave(currentId, state.saves[0].save.tool, receipt, state.saves[0].save.ids, env);
  acknowledgeProactiveCandidateIds(validated.map((item) => item.candidate_id), 'write-candidate', env);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [old.candidate_id, unrelated.candidate_id]);
  assert.notEqual(reminderPayload({ pendingCandidateCount: 1 }), null, 'legacy/older unresolved candidate remains visible');
});

test('D8: a validated receipt resolves its candidate at PostToolUse, so a new turn before Stop does not lose it', (t) => {
  const { env } = fixture(t);
  const savedTurn = turn(env, SESSION);
  const saved = candidate(env, savedTurn, 'remember-candidate');
  const other = candidate(env, savedTurn, 'work-item-candidate');
  const observation = postToolSaveObservation({
    session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'mcp__priors__remember',
    tool_input: { candidate_id: saved.candidate_id },
    tool_response: { operation: 'remember', outcome_code: 'recorded', resource_ids: [{ role: 'primary', id: 'GEN-13', version: 1 }],
      candidate_receipts: [{ candidate_id: saved.candidate_id, resource_ids: ['GEN-13@1'] }] },
  }, env);
  assert.equal(recordSaveObservation(observation, env), 1);
  // A background agent's report arrives as a new prompt before Stop ran for the saved turn.
  turn(env, SESSION);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [other.candidate_id]);
});

test('D8: PostToolUse without a matching receipt resolves nothing', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env, SESSION);
  const current = candidate(env, turnId, 'remember-candidate');
  const observation = postToolSaveObservation({
    session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'mcp__priors__remember',
    tool_input: { candidate_id: current.candidate_id },
    tool_response: { operation: 'remember', outcome_code: 'recorded', resource_ids: [{ role: 'primary', id: 'GEN-14', version: 1 }],
      candidate_receipts: [{ candidate_id: current.candidate_id, resource_ids: ['GEN-99@1'] }] },
  }, env);
  assert.equal(recordSaveObservation(observation, env), 0);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [current.candidate_id]);
});

test('D8: explicit save without matching candidate receipt does not clear queue', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const current = candidate(env, turnId, 'remember-candidate');
  recordDecision({
    decision: 'write-candidate', client: 'claude', source: 'hook', invocationKind: 'client-hook',
    phase: 'tool-save', sessionId: SESSION, turnId,
    save: { outcome: 'recorded', ids: ['GEN-99@1'], tool: 'remember' },
  }, env);
  const state = currentTurnAudit(SESSION, 'claude', env);
  assert.equal(state.saves.length, 0);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [current.candidate_id]);
});

test('D8: unscoped legacy queue remains visible and unscoped decision cannot clear it', (t) => {
  const { env } = fixture(t);
  const old = candidate(env, undefined, 'remember-candidate');
  recordDecision({ decision: 'skip', client: 'claude', phase: 'conversation-end' }, env);
  assert.equal(pendingProactiveCandidates(env).length, 1);
  assert.notEqual(reminderPayload({ pendingCandidateCount: 1 }), null);
  assert.ok(old.candidate_id);
});

test('D8: record-decision CLI wiring does not let an unscoped skip clear current or old candidates', (t) => {
  const { env } = fixture(t);
  const oldTurn = turn(env);
  const old = candidate(env, oldTurn, 'remember-candidate');
  const activeTurn = turn(env);
  const current = candidate(env, activeTurn, 'unresolved-candidate');
  const result = runRecordDecision(['--decision', 'skip', '--client', 'claude', '--phase', 'conversation-end'], env);
  assert.equal(result.exitCode, 0);
  assert.equal(result.payload.acknowledged_candidates, 0);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [old.candidate_id, current.candidate_id]);

  const scopedOnlyToSession = runRecordDecision(['--decision', 'skip', '--client', 'claude', '--phase', 'conversation-end', '--session-id', SESSION], env);
  assert.equal(scopedOnlyToSession.exitCode, 0);
  assert.equal(scopedOnlyToSession.payload.acknowledged_candidates, 0);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [old.candidate_id, current.candidate_id]);
});

test('D8: receipt-less write-candidate CLI decision cannot clear candidates', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const current = candidate(env, turnId, 'remember-candidate');
  const result = runAcknowledgeCandidates(['--decision', 'write-candidate', '--turn-id', turnId], env);
  assert.equal(result.exitCode, 2);
  assert.equal(result.payload.error, 'invalid_decision');
  assert.equal(acknowledgeProactiveCandidates('write-candidate', env, turnId), 0);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [current.candidate_id]);
});

test('D8: same-turn no-save decision leaves an older unresolved queue item intact', (t) => {
  const { env } = fixture(t);
  const olderTurn = turn(env);
  const old = candidate(env, olderTurn, 'remember-candidate');
  const currentTurn = turn(env);
  candidate(env, currentTurn, 'remember-candidate');
  recordDecision({ decision: 'skip', client: 'claude', phase: 'conversation-end', sessionId: SESSION, turnId: currentTurn }, env);
  assert.equal(acknowledgeProactiveCandidates('skip', env, currentTurn), 1);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [old.candidate_id]);
  assert.notEqual(reminderPayload({ pendingCandidateCount: 1 }), null);
});

test('D8: invalid-line diagnostic repeats only when its count changes', (t) => {
  const { env } = fixture(t);
  assert.equal(recordStopInvocation({ invalidLines: 2 }, env).invalidLinesChanged, true);
  assert.equal(recordStopInvocation({ invalidLines: 2 }, env).invalidLinesChanged, false);
  assert.equal(recordStopInvocation({ invalidLines: 3 }, env).invalidLinesChanged, true);
  assert.equal(reminderPayload({ pendingCandidateCount: 0, invalidLines: 2, invalidLinesChanged: false }), null);
  assert.notEqual(reminderPayload({ pendingCandidateCount: 0, invalidLines: 3, invalidLinesChanged: true }), null);
  for (let index = 0; index < 500; index++) recordStopInvocation({ invalidLines: index % 4 }, env);
  assert.ok(fs.statSync(env.PRIORS_STOP_DIAGNOSTIC_FILE).size < 2048, 'diagnostic state stays a single bounded snapshot');
});

test('D8: exact PostToolUse receipt still works after the decision audit exceeds 4 MiB', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const savedCandidate = candidate(env, turnId, 'remember-candidate');
  fs.writeFileSync(env.PRIORS_DECISION_AUDIT_FILE, Buffer.alloc(4 * 1024 * 1024 + 8, 0x78));
  const input = {
    session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'mcp__priors__remember',
    tool_input: { candidate_id: savedCandidate.candidate_id },
    tool_response: {
      operation: 'remember', outcome_code: 'recorded', resource_ids: [{ role: 'primary', id: 'GEN-13', version: 1 }],
      candidate_receipts: [{ candidate_id: savedCandidate.candidate_id, resource_ids: ['GEN-13@1'] }],
    },
  };
  const observation = postToolSaveObservation(input, env);
  assert.deepEqual(observation.save.candidate_receipts, [{ candidate_id: savedCandidate.candidate_id, resource_ids: ['GEN-13@1'] }]);
  recordDecision({ decision: 'write-candidate', client: 'claude', source: 'hook', phase: 'tool-save', sessionId: SESSION, turnId, save: observation.save }, env);
  const state = currentTurnAudit(SESSION, 'claude', env);
  assert.equal(state.turn_id, turnId);
  assert.deepEqual(state.saves[0].save.candidate_receipts, [{ candidate_id: savedCandidate.candidate_id, resource_ids: ['GEN-13@1'] }]);
  const validReceipts = candidateReceiptForSave(turnId, state.saves[0].save.tool, state.saves[0].save.candidate_receipts, state.saves[0].save.ids, env);
  assert.deepEqual(validReceipts.map((receipt) => receipt.candidate_id), [savedCandidate.candidate_id]);
});

test('D8: receipt requires matching tool input and rejects replayed responses', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const pending = candidate(env, turnId, 'remember-candidate');
  const base = {
    session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'mcp__priors__remember',
    tool_input: { candidate_id: pending.candidate_id },
    tool_response: {
      operation: 'remember', outcome_code: 'recorded', resource_ids: [{ role: 'primary', id: 'GEN-14', version: 1 }],
      candidate_receipts: [{ candidate_id: pending.candidate_id, resource_ids: ['GEN-14@1'] }],
    },
  };
  assert.ok(postToolSaveObservation(base, env));
  assert.deepEqual(postToolSaveObservation({ ...base, tool_input: { candidate_id: 'pc-aaaaaaaaaaaa-00000000-other-candidate' } }, env).save.candidate_receipts || [], []);
  assert.deepEqual(postToolSaveObservation({ ...base, tool_input: {} }, env).save.candidate_receipts || [], []);
  assert.equal(postToolSaveObservation({ ...base, tool_response: { ...base.tool_response, replayed: true } }, env), null);
  assert.equal(postToolSaveObservation({ ...base, tool_response: { structuredContent: { ...base.tool_response, replayed: true } } }, env), null);
});

test('D8: amend supersede and dispute companion refs do not block the saved-primary receipt', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const supersedeCandidate = candidate(env, turnId, 'remember-candidate', 'c'.repeat(64));
  const disputeCandidate = candidate(env, turnId, 'remember-candidate', 'd'.repeat(64));
  const observation = (candidateId, operation, companion) => postToolSaveObservation({
    session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'mcp__priors__amend',
    tool_input: { candidate_id: candidateId },
    tool_response: {
      operation, outcome_code: 'applied',
      resource_ids: [{ role: 'primary', id: 'GEN-15', version: 2 }, companion],
      candidate_receipts: [{ candidate_id: candidateId, resource_ids: ['GEN-15@2'] }],
    },
  }, env);
  const supersede = observation(supersedeCandidate.candidate_id, 'amend.supersede', { role: 'superseded', id: 'GEN-10', version: 1 });
  assert.deepEqual(supersede.save.ids, ['GEN-15@2']);
  assert.deepEqual(supersede.save.candidate_receipts, [{ candidate_id: supersedeCandidate.candidate_id, resource_ids: ['GEN-15@2'] }]);
  const dispute = observation(disputeCandidate.candidate_id, 'amend.dispute', { role: 'disputed', id: 'GEN-11' });
  assert.deepEqual(dispute.save.ids, ['GEN-15@2']);
  assert.deepEqual(dispute.save.candidate_receipts, [{ candidate_id: disputeCandidate.candidate_id, resource_ids: ['GEN-15@2'] }]);
});

test('D8: active-turn receipt storage stays below its 64 KiB cap at the maximum session count', (t) => {
  const { env } = fixture(t);
  for (let sessionIndex = 0; sessionIndex < 16; sessionIndex++) {
    const sessionId = require('node:crypto').randomUUID();
    const turnId = turn(env, sessionId);
    const candidateReceipts = [];
    const ids = [];
    for (let receiptIndex = 0; receiptIndex < 20; receiptIndex++) {
      const resourceId = `GEN-${sessionIndex * 100 + receiptIndex + 1}@1`;
      ids.push(resourceId);
      candidateReceipts.push({ candidate_id: `pc-${String(sessionIndex).padStart(12, 'a')}-${String(receiptIndex).padStart(8, '0')}-remember-candidate`, resource_ids: [resourceId] });
    }
    recordDecision({ decision: 'write-candidate', client: 'claude', source: 'hook', phase: 'tool-save', sessionId, turnId,
      save: { outcome: 'recorded', tool: 'remember', ids, candidate_receipts: candidateReceipts } }, env);
  }
  assert.ok(fs.statSync(env.PRIORS_TURN_STATE_FILE).size < 64 * 1024);
  const state = JSON.parse(fs.readFileSync(env.PRIORS_TURN_STATE_FILE, 'utf8'));
  assert.equal(state.sessions.length, 16);
  assert.ok(state.sessions.every((session) => session.saves.reduce((count, save) => count + save.save.candidate_receipts.length, 0) <= 8));
});

test('D8: repeated and multiple same-turn receipts are deduplicated and bounded', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const candidateA = candidate(env, turnId, 'remember-candidate');
  const candidateB = candidate(env, turnId, 'unresolved-candidate', 'b'.repeat(64));
  const save = {
    outcome: 'recorded', tool: 'remember', ids: ['GEN-21@1', 'GEN-22@1'],
    candidate_receipts: [
      { candidate_id: candidateA.candidate_id, resource_ids: ['GEN-21@1'] },
      { candidate_id: candidateB.candidate_id, resource_ids: ['GEN-22@1'] },
    ],
  };
  for (let index = 0; index < 20; index++) {
    recordDecision({ decision: 'write-candidate', client: 'claude', source: 'hook', phase: 'tool-save', sessionId: SESSION, turnId, save }, env);
  }
  const state = currentTurnAudit(SESSION, 'claude', env);
  const receipts = state.saves.flatMap((entry) => entry.save.candidate_receipts);
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map((receipt) => receipt.candidate_id).sort(), [candidateA.candidate_id, candidateB.candidate_id].sort());
  assert.ok(fs.statSync(env.PRIORS_TURN_STATE_FILE).size < 64 * 1024);
});

test('D9: stale active turn state expires after 24 hours without expiring candidate queue entries', (t) => {
  const { env } = fixture(t);
  const turnId = turn(env);
  const pending = candidate(env, turnId, 'remember-candidate');
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const ttl = 24 * 60 * 60 * 1000;
  const state = JSON.parse(fs.readFileSync(env.PRIORS_TURN_STATE_FILE, 'utf8'));
  state.sessions[0].updated_at = new Date(now - ttl + 1).toISOString();
  fs.writeFileSync(env.PRIORS_TURN_STATE_FILE, JSON.stringify(state));
  assert.equal(activeTurnId(SESSION, 'claude', env, now), turnId, 'state just under 24 hours remains active');
  assert.equal(currentTurnAudit(SESSION, 'claude', env, now).known, true);

  state.sessions[0].updated_at = new Date(now - ttl - 1).toISOString();
  fs.writeFileSync(env.PRIORS_TURN_STATE_FILE, JSON.stringify(state));
  assert.equal(activeTurnId(SESSION, 'claude', env, now), undefined, 'state just over 24 hours expires');
  assert.equal(currentTurnAudit(SESSION, 'claude', env, now).known, false);
  assert.deepEqual(pendingProactiveCandidates(env).map((item) => item.candidate_id), [pending.candidate_id]);
});
