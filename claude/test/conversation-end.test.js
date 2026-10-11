'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Stop hook is silent and creates no audit, candidate, or invocation records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-silent-stop-'));
  try {
    const env = {
      ...process.env,
      PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
      PRIORS_STOP_DIAGNOSTIC_FILE: path.join(dir, 'stop.jsonl'),
      PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl'),
    };
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'conversation-end.js')], {
      env, input: JSON.stringify({ transcript: 'private content' }), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude plugin does not register a Stop hook', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(Object.hasOwn(config.hooks, 'Stop'), false);
});
