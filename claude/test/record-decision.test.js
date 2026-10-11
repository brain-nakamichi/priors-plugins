'use strict';
// GEN-554 / GEN-556: the conversation-end record carries the save outcome; "recorded" needs a valid id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SCRIPT = path.join(__dirname, '..', 'hooks', 'record-decision.js');

function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-rd-'));
  const file = path.join(dir, 'audit.jsonl');
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, PRIORS_DECISION_AUDIT_FILE: file, PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'c.json') }, encoding: 'utf8' });
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()), events: lines.map((l) => JSON.parse(l)) };
}

test('recorded with ids is written to the audit line (no body, no token)', () => {
  const r = run(['--decision', 'write-candidate', '--client', 'claude', '--phase', 'conversation-end', '--save-result', 'recorded', '--saved', 'GEN-12@3,cache:abc-1']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.out.save, { outcome: 'recorded', ids: ['GEN-12@3', 'cache:abc-1'] });
  assert.deepEqual(r.events.at(-1).save, { outcome: 'recorded', ids: ['GEN-12@3', 'cache:abc-1'] });
});
test('recorded without an id is invalid_input (a decision to save is not a save)', () => {
  const r = run(['--decision', 'write-candidate', '--client', 'claude', '--phase', 'conversation-end', '--save-result', 'recorded']);
  assert.equal(r.status, 2);
  assert.equal(r.out.ok, false);
  assert.equal(r.events.length, 0);
});
test('an invalid id is rejected, not silently dropped', () => {
  const r = run(['--decision', 'write-candidate', '--client', 'claude', '--phase', 'conversation-end', '--save-result', 'recorded', '--saved', 'GEN-12@3,bad id with spaces']);
  assert.equal(r.status, 2);
  assert.equal(r.events.length, 0);
});
test('failed / not_needed may carry no id; an unknown outcome is rejected', () => {
  assert.deepEqual(run(['--decision', 'skip', '--client', 'claude', '--phase', 'conversation-end', '--save-result', 'not_needed']).out.save, { outcome: 'not_needed', ids: [] });
  assert.deepEqual(run(['--decision', 'write-candidate', '--client', 'claude', '--phase', 'conversation-end', '--save-result', 'failed']).out.save, { outcome: 'failed', ids: [] });
  assert.equal(run(['--decision', 'skip', '--client', 'claude', '--phase', 'conversation-end', '--save-result', 'maybe']).status, 2);
});
test('a record without --save-result stays as before (no save field)', () => {
  const r = run(['--decision', 'skip', '--client', 'claude', '--phase', 'conversation-end']);
  assert.equal(r.status, 0);
  assert.equal(r.events.at(-1).save, undefined);
});

test('GEN983: manual recorder declares explicit helper without changing source', () => {
  const r = run(['--decision', 'skip', '--phase', 'conversation-end']);
  assert.equal(r.events[0].source, 'explicit');
  assert.equal(r.events[0].invocation_kind, 'explicit-helper');
});
test('GEN983: fixed hook declaration is optional and validated before writing', () => {
  const { recordDecision } = require('../hooks/decision-audit.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-invocation-'));
  const file = path.join(dir, 'audit.jsonl');
  const env = { PRIORS_DECISION_AUDIT_FILE: file };
  try {
    const base = { decision: 'pending', client: 'claude', phase: 'turn-start', source: 'hook' };
    const legacy = recordDecision(base, env).event;
    assert.equal(Object.hasOwn(legacy, 'invocation_kind'), false);
    const event = recordDecision({ ...base, invocationKind: 'client-hook' }, env).event;
    assert.equal(event.source, 'hook');
    assert.equal(event.invocation_kind, 'client-hook');
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => recordDecision({ ...base, invocationKind: 'not-a-kind' }, env));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
