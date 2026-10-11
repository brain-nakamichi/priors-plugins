'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'session-start.js');

test('SessionStart advertises optional composition without reading Priors', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      PRIORS_AUTO_RECALL: '1',
      PRIORS_HOOK_TOKEN_V1: 'synthetic-token-that-must-not-be-used',
      PRIORS_MCP_URL: 'http://127.0.0.1:1/mcp',
    },
    input: JSON.stringify({ cwd: process.cwd(), session_id: 'synthetic-session' }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /自動読取なし/);
  assert.match(output.hookSpecificOutput.additionalContext, /使わない選択も有効/);
  assert.doesNotMatch(result.stdout, /synthetic-token|synthetic-session/);
});
