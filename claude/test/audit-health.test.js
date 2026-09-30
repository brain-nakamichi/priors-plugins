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
