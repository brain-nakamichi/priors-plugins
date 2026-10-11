'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

test('Claude offers per-turn optional prompts while Codex keeps model-directed discovery', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude', 'hooks', 'hooks.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'codex', 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(Object.hasOwn(claude.hooks, 'UserPromptSubmit'));
  assert.ok(Object.hasOwn(claude.hooks, 'Stop'));
  assert.ok(Object.hasOwn(claude.hooks, 'PostToolUse'));
  assert.equal(Object.hasOwn(codex.hooks, 'UserPromptSubmit'), false);
  assert.equal(Object.hasOwn(codex.hooks, 'Stop'), false);
});

test('Codex documentation describes model-directed optional use without automatic Recall', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'codex', 'README.md'), 'utf8');
  assert.match(readme, /AIが現在の問いと将来の再利用価値を見て判断/);
  assert.doesNotMatch(readme, /PRIORS_AUTO_RECALL/);
});
