'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

test('Claude reminds each turn; both clients keep important information and retrieve relevant history without fixed flow', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude', 'hooks', 'hooks.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'codex', 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(Object.hasOwn(claude.hooks, 'UserPromptSubmit'));
  assert.ok(Object.hasOwn(claude.hooks, 'Stop'));
  assert.ok(Object.hasOwn(claude.hooks, 'PostToolUse'));
  const claudeSkill = fs.readFileSync(path.join(ROOT, 'claude', 'skills', 'priors', 'SKILL.md'), 'utf8');
  const codexSkill = fs.readFileSync(path.join(ROOT, 'codex', 'skills', 'priors', 'SKILL.md'), 'utf8');
  assert.match(claudeSkill, /明示的な保存依頼を待たず/);
  assert.match(claudeSkill, /依存する前に/);
  assert.match(claudeSkill, /成功応答/);
  assert.match(codexSkill, /without waiting for an explicit/);
  assert.match(codexSkill, /before relying on it/);
  assert.match(codexSkill, /Report a save only after the success response returns/);
  assert.match(claudeSkill, /A→B→Cの話題移行検出や一括再構成は行わない/);
  assert.match(claudeSkill, /Recall条件が満たされるときはAIが必要な取得機能を選ぶ/);
  assert.match(codexSkill, /A→B→C topic-switch/);
  assert.equal(Object.hasOwn(codex.hooks, 'UserPromptSubmit'), false);
  assert.equal(Object.hasOwn(codex.hooks, 'Stop'), false);
});

test('Codex documentation describes retention criteria and relevant-time Recall', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'codex', 'README.md'), 'utf8');
  assert.match(readme, /明示的な保存依頼を待たず保持/);
  assert.match(readme, /依存前に対象を絞ってRecall/);
  assert.doesNotMatch(readme, /PRIORS_AUTO_RECALL/);
});
