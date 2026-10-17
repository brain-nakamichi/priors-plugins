'use strict';
// SKILL.md の規律検査（docs/claude-plugin-design.md 4 節「server が正本の事実を書かない」）。
// 版ずれの主因になる 3 種だけを機械的に弾く:
//   1. テーマ prefix の実例（`theme: "GEN"` や `GEN-3` のような実 ID）
//   2. 接頭辞つきの tool 名（mcp__…）
//   3. 部分列挙になりやすい enum の値をコードスパンで並べる書き方（kind / memory_type / phase の値）
// 完全列挙か部分列挙かは機械で判定できないので、enum の値そのものを禁止語にする。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL = path.join(__dirname, '..', 'skills', 'priors', 'SKILL.md');
// monorepo（Priors/plugin + Priors/codex-plugins/priors）と公開ミラー（claude/ + codex/）の両方で動かす
const MIRROR_CODEX = path.join(__dirname, '..', '..', 'codex');
const CODEX_ROOT = fs.existsSync(MIRROR_CODEX) ? MIRROR_CODEX : path.join(__dirname, '..', '..', 'codex-plugins', 'priors');
const CODEX_SKILL = path.join(CODEX_ROOT, 'skills', 'priors', 'SKILL.md');
const CODEX_SKILL_DIR = path.dirname(CODEX_SKILL);
const text = fs.readFileSync(SKILL, 'utf8').replace(/\r\n?/g, '\n');
const body = text.replace(/^---[\s\S]*?---\n/, ''); // frontmatter を除く

test('SKILL.md exists with frontmatter name/description', () => {
  assert.match(text, /^---\nname: priors\ndescription: .+\n---\n/);
});

test('no theme prefix examples (theme argument or real short IDs)', () => {
  // theme: "GEN" / theme: 'GEN' の形（<prefix> プレースホルダは許す）
  assert.doesNotMatch(body, /theme:\s*["'][A-Z][A-Z0-9]{1,7}["']/);
  // 実 ID（GEN-3 / GEN-c12）。ZZPROBE は評価専用テーマとして設計文書が名指ししているので許す
  const ids = body.match(/\b[A-Z][A-Z0-9]{1,7}-c?\d+\b/g) || [];
  assert.deepEqual(ids, [], `real short IDs found: ${ids.join(', ')}`);
  const prefixes = (body.match(/\b[A-Z][A-Z0-9]{1,7}\b/g) || [])
    .filter((w) => !['ZZPROBE', 'ID', 'MCP', 'JSON', 'CLAUDE', 'DB', 'AI', 'UUID', 'A', 'B'].includes(w));
  assert.deepEqual(prefixes, [], `possible theme prefixes found: ${prefixes.join(', ')}`);
});

test('no prefixed tool names (mcp__…) except the rule that forbids them', () => {
  const hits = (body.match(/mcp__[A-Za-z0-9_]*/g) || []);
  // 7 節の禁止規則の 1 箇所（`mcp__…`）だけ許す
  assert.deepEqual(hits, ['mcp__'], `prefixed tool names found: ${hits.join(', ')}`);
});

test('no enum values written as code spans (kind / memory_type / phase / amend mode)', () => {
  const banned = [
    'goal', 'rule', 'decision', 'experiment', 'finding', 'hypothesis', 'retraction', 'question', 'answer', 'handoff',
    'episodic', 'semantic', 'procedural', 'profile', 'working',
    'precompact', 'stop', 'session_end', 'manual',
    'revise', 'supersede', 'retract', 'dispute', 'accept', 'reject', 'unpin',
  ];
  const found = banned.filter((v) => new RegExp('`' + v + '`').test(body));
  assert.deepEqual(found, [], `enum values in code spans: ${found.join(', ')}`);
});

test('states the rules the design requires', () => {
  assert.match(body, /context_open/);
  assert.match(body, /resolved_session_id/);
  assert.match(body, /idempotency_key/);
  assert.match(body, /theme_switch_required/);
  assert.match(body, /利用者に提示/);
  assert.match(body, /ZZPROBE/);
  // hook input の session_id はクライアント側の識別子で、Priors tool へ渡すと別セッション扱いになる
  assert.match(body, /hook input の `session_id`.*渡さない/);
});

test('Codex/Claude 共通の保持・Recall基準と機能合成を明記する', () => {
  assert.match(body, /自発的に考えるための手掛かり（Claude \/ Codex 共通）/);
  assert.match(body, /Recall候補/);
  assert.match(body, /Remember候補/);
  assert.match(body, /未解決候補/);
  assert.match(body, /明示的な保存依頼を待たず会話完了前/);
  assert.match(body, /過去情報が今回の回答や重要操作を左右し、最新文脈に不足する場合/);
  assert.match(body, /必要に応じて検索・本文取得・関係辿り・出典付き保存を組み合わせられる/);
  assert.match(body, /A→B→Cの話題移行検出や一括再構成は行わない/);
  assert.match(body, /work_item.*resolve.*reopen/);
  assert.match(body, /曖昧な候補は提示して選択を待つ/);
  assert.match(body, /work_item/);
  assert.match(body, /未検出は不要の証明ではない/);
});

test('length stays within a reasonable budget for a skill loaded on demand', () => {
  const lines = body.split('\n').length;
  assert.ok(lines <= 120, `SKILL.md has ${lines} lines`);
  assert.ok(text.length <= 8000, `SKILL.md has ${text.length} chars`);
});

test('Codex skill stays within the shared 8,000-character / 120-line budget', () => {
  const codexText = fs.readFileSync(CODEX_SKILL, 'utf8').replace(/\r\n?/g, '\n');
  const codexBody = codexText.replace(/^---[\s\S]*?---\n/, '');
  assert.ok(codexBody.split('\n').length <= 120,
    `Codex SKILL.md has ${codexBody.split('\n').length} lines`);
  assert.ok(codexText.length <= 8000,
    `Codex SKILL.md has ${codexText.length} chars`);
  // Rules that apply on every turn must stay in the always-loaded body, not only in on-demand references.
  assert.match(codexBody, /`guard`/, 'Codex SKILL.md body requires an explicit guard before material changes');
  assert.match(codexBody, /PRIORS_TOKEN_CODEX_V1/, 'Codex SKILL.md body keeps the token-handling rule');
  assert.match(codexBody, /Keep the active theme explicit/, 'Codex SKILL.md body keeps the explicit-theme rule');
  assert.match(codexBody, /human-protected/, 'Codex SKILL.md body keeps the human-protected boundary');
  for (const reference of [
    'daily-cross-client-route.md', 'theme-organization.md',
    'retention-and-search-cards.md',
    'working-cache.md', 'deferred-work.md', 'search-card-recovery.md',
  ]) {
    assert.ok(fs.existsSync(path.join(CODEX_SKILL_DIR, reference)),
      `missing Codex skill reference: ${reference}`);
  }
});