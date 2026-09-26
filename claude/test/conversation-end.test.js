'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'conversation-end.js');
const RECORDER = path.join(ROOT, 'hooks', 'record-decision.js');

test('conversation end reminds and records only a pending local decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-end-test-'));
  const file = path.join(dir, 'audit.jsonl');
  const stopFile = path.join(dir, 'stop-hook.jsonl');
  try {
    const env = { ...process.env, PRIORS_DECISION_AUDIT_FILE: file, PRIORS_STOP_DIAGNOSTIC_FILE: stopFile };
    const child = spawnSync(process.execPath, [HOOK], {
      env,
      input: JSON.stringify({ transcript: 'do not persist this secret' }),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'Stop');
    assert.match(output.hookSpecificOutput.additionalContext, /write-candidate/);
    assert.match(output.hookSpecificOutput.additionalContext, /\n/);
    assert.equal(fs.existsSync(file), false);
    const stopEvent = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
    assert.equal(stopEvent.event, 'stop_invoked');
    assert.equal(stopEvent.stop_hook_active, false);
    assert.equal(Object.hasOwn(stopEvent, 'transcript'), false);

    const turnStart = spawnSync(process.execPath, [RECORDER, '--decision', 'skip', '--client', 'claude', '--phase', 'turn-start'], { env, encoding: 'utf8' });
    assert.equal(turnStart.status, 0);
    const afterTurnStart = spawnSync(process.execPath, [HOOK], { env, input: '{}', encoding: 'utf8' });
    assert.equal(afterTurnStart.status, 0);
    assert.notEqual(afterTurnStart.stdout, '');

    const recorded = spawnSync(process.execPath, [RECORDER, '--decision', 'skip', '--client', 'claude', '--phase', 'conversation-end'], { env, encoding: 'utf8' });
    assert.equal(recorded.status, 0);
    assert.equal(JSON.parse(recorded.stdout).phase, 'conversation-end');
    const repeated = spawnSync(process.execPath, [HOOK], { env, input: '{}', encoding: 'utf8' });
    assert.equal(repeated.status, 0);
    assert.equal(repeated.stdout, '');

    const reentrant = spawnSync(process.execPath, [HOOK], { env, input: JSON.stringify({ stop_hook_active: true }), encoding: 'utf8' });
    assert.equal(reentrant.status, 0);
    assert.equal(reentrant.stdout, '');
    const stopEvents = fs.readFileSync(stopFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(stopEvents.length, 4);
    assert.equal(stopEvents[3].stop_hook_active, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
