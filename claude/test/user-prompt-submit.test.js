'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'user-prompt-submit.js');
const RECORDER = path.join(ROOT, 'hooks', 'record-decision.js');

test('UserPromptSubmit reminds every turn and logs only a pending hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-decision-test-'));
  const file = path.join(dir, 'audit.jsonl');
  try {
    const env = { ...process.env, PRIORS_DECISION_AUDIT_FILE: file };
    const child = spawnSync(process.execPath, [HOOK], {
      env, input: JSON.stringify({ prompt: 'do not persist this secret', hook_event_name: 'UserPromptSubmit' }),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /use-read/);
    const line = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(line.decision, 'pending');
    assert.equal(line.source, 'hook');
    assert.equal(line.phase, 'turn-start');
    assert.match(line.prompt_sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /do not persist this secret/);

    const recorded = spawnSync(process.execPath, [RECORDER, '--decision', 'use-read', '--client', 'claude', '--prompt-sha256', line.prompt_sha256, '--phase', 'turn-start'], { env, encoding: 'utf8' });
    assert.equal(recorded.status, 0);
    assert.equal(JSON.parse(recorded.stdout).decision, 'use-read');
    assert.equal(JSON.parse(recorded.stdout).phase, 'turn-start');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
