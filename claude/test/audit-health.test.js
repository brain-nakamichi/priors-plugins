const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordDecision, auditHealth } = require('../hooks/decision-audit.js');

test('auditHealth counts unresolved pending decisions without exposing hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-audit-health-'));
  const env = { PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl') };
  recordDecision({ decision: 'pending', client: 'claude', phase: 'turn-start' }, env);
  recordDecision({ decision: 'skip', client: 'claude', phase: 'turn-start' }, env);
  recordDecision({ decision: 'pending', client: 'claude', phase: 'turn-start' }, env);
  fs.appendFileSync(env.PRIORS_DECISION_AUDIT_FILE, '{broken}\n');
  const health = auditHealth(env);
  assert.equal(health.pending_turn_starts, 1);
  assert.equal(health.invalid_lines, 1);
  assert.equal(Object.hasOwn(health, 'prompt_sha256'), false);
});

test('auditHealth expires unresolved turn-start warnings at 24 hours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-audit-expiry-'));
  const env = { PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl') };
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const ttl = 24 * 60 * 60 * 1000;
  const event = (recordedAt) => JSON.stringify({
    schema: 'priors.decision-audit.v1', decision: 'pending', client: 'claude',
    source: 'hook', phase: 'turn-start', recorded_at: new Date(recordedAt).toISOString(),
  });
  fs.writeFileSync(env.PRIORS_DECISION_AUDIT_FILE, [
    event(now - ttl + 1), // just under 24 hours remains actionable
    event(now - ttl - 1), // just over 24 hours is stale
  ].join('\n') + '\n');
  assert.equal(auditHealth(env, 256, now).pending_turn_starts, 1);
});

test('auditHealth resolves the identified stale turn without decrementing a newer pending turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-audit-pairing-'));
  const env = { PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl') };
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const staleTurnId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const freshTurnId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const event = (decision, phase, recordedAt, turnId, source = 'hook') => JSON.stringify({
    schema: 'priors.decision-audit.v1', decision, client: 'claude', source, phase,
    session_id: sessionId, turn_id: turnId, recorded_at: new Date(recordedAt).toISOString(),
  });
  fs.writeFileSync(env.PRIORS_DECISION_AUDIT_FILE, [
    event('pending', 'turn-start', now - 25 * 60 * 60 * 1000, staleTurnId),
    event('pending', 'turn-start', now - 60 * 60 * 1000, freshTurnId),
    event('skip', 'turn-start', now - 30 * 60 * 1000, staleTurnId, 'explicit'),
  ].join('\n') + '\n');
  assert.equal(auditHealth(env, 256, now).pending_turn_starts, 1);
});
