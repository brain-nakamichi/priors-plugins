'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'user-prompt-submit.js');

test('UserPromptSubmit is not registered and its compatibility entry point is inert', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(Object.hasOwn(config.hooks, 'UserPromptSubmit'), false);

  const result = spawnSync(process.execPath, [HOOK], {
    env: { ...process.env, PRIORS_AUTO_RECALL: '1', PRIORS_HOOK_TOKEN_V1: 'synthetic-token' },
    input: JSON.stringify({ prompt: '前回の仕様を再開する' }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
