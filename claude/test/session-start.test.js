'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'session-start.js');
const HOOKS = path.join(__dirname, '..', 'hooks', 'hooks.json');

test('the plugin registers start/end prompts while preserving optional-use discovery', () => {
  const config = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
  assert.deepEqual(Object.keys(config.hooks), ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse']);
  assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.js"');
  assert.equal(config.hooks.Stop[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/conversation-end.js"');
  assert.equal(config.hooks.PostToolUse[0].matcher, '^mcp__priors__(remember|amend|capture|work_create|work_event)$');
  assert.equal(config.hooks.PostToolUse[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-save.js"');
  assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].timeout, 15);
  assert.equal(config.hooks.Stop[0].hooks[0].timeout, 15);
  assert.equal(config.hooks.PostToolUse[0].hooks[0].timeout, 15);
});

test('SessionStart only advertises optional Priors use and never reads memory', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRIORS_STARTUP_PREVIEW: '1',
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

test('selftest documents the read-free hook contract without inspecting credentials', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--selftest'], {
    env: { ...process.env, PRIORS_HOOK_TOKEN_V1: 'synthetic-token-that-must-not-be-used' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /does not read memory or connect to MCP/);
  assert.doesNotMatch(result.stdout, /synthetic-token/);
});
