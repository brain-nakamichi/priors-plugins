'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

test('Claude and Codex do not register prompt-level automatic Priors behavior', () => {
  for (const client of ['claude', 'codex']) {
    const hooksDir = path.join(ROOT, client, 'hooks');
    const promptHook = require(path.join(hooksDir, 'user-prompt-submit.js'));
    const endHook = require(path.join(hooksDir, 'conversation-end.js'));
    assert.ok(promptHook);
    assert.ok(endHook);
    const config = JSON.parse(fs.readFileSync(path.join(hooksDir, 'hooks.json'), 'utf8'));
    assert.equal(Object.hasOwn(config.hooks, 'Stop'), false);
    assert.equal(Object.hasOwn(config.hooks, 'UserPromptSubmit'), false);
  }
});

test('Codex documentation describes model-directed optional use without automatic Recall', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'codex', 'README.md'), 'utf8');
  assert.match(readme, /AIが現在の問いと将来の再利用価値を見て判断/);
  assert.doesNotMatch(readme, /PRIORS_AUTO_RECALL/);
});
