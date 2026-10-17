'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Works in both layouts: the monorepo (Priors/plugin + Priors/codex-plugins/priors) and the public mirror (claude/ + codex/).
const PLUGIN = path.join(__dirname, '..');
const MIRROR_CODEX = path.join(PLUGIN, '..', 'codex');
const CODEX = fs.existsSync(MIRROR_CODEX) ? MIRROR_CODEX : path.join(PLUGIN, '..', 'codex-plugins', 'priors');

test('Claude gives turn-start guidance and a conditional Stop; both clients keep important information and retrieve relevant history without fixed flow', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(CODEX, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(Object.hasOwn(claude.hooks, 'UserPromptSubmit'));
  assert.ok(Object.hasOwn(claude.hooks, 'Stop'));
  assert.ok(Object.hasOwn(claude.hooks, 'PostToolUse'));
  const claudeSkill = fs.readFileSync(path.join(PLUGIN, 'skills', 'priors', 'SKILL.md'), 'utf8');
  const codexSkill = fs.readFileSync(path.join(CODEX, 'skills', 'priors', 'SKILL.md'), 'utf8');
  assert.match(claudeSkill, /明示的な保存依頼を待たず/);
  assert.match(claudeSkill, /依存する前に/);
  assert.match(claudeSkill, /成功応答/);
  assert.match(codexSkill, /without waiting for an explicit/);
  assert.match(codexSkill, /before relying on it/);
  assert.match(codexSkill, /(?:Report|Claim) a save only after the success response returns/);
  assert.match(claudeSkill, /A→B→Cの話題移行検出や一括再構成は行わない/);
  assert.match(claudeSkill, /Recall条件が満たされるときはAIが必要な取得機能を選ぶ/);
  assert.match(codexSkill, /A→B→C topic-switch/);
  // Codex gives turn-start guidance through UserPromptSubmit but has no blocking Stop hook.
  assert.ok(Object.hasOwn(codex.hooks, 'UserPromptSubmit'));
  assert.equal(Object.hasOwn(codex.hooks, 'Stop'), false);
});

test('Codex documentation describes retention criteria and relevant-time Recall', () => {
  const readme = fs.readFileSync(path.join(CODEX, 'README.md'), 'utf8');
  assert.match(readme, /明示的な保存依頼を待たず保持/);
  assert.match(readme, /依存前に対象を絞ってRecall/);
  assert.doesNotMatch(readme, /PRIORS_AUTO_RECALL/);
});
