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
const text = fs.readFileSync(SKILL, 'utf8');
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
    .filter((w) => !['ZZPROBE', 'ID', 'MCP', 'JSON', 'CLAUDE', 'DB', 'A', 'B'].includes(w));
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
});

test('length stays within a reasonable budget for a skill loaded on demand', () => {
  const lines = body.split('\n').length;
  assert.ok(lines <= 120, `SKILL.md has ${lines} lines`);
  assert.ok(text.length <= 8000, `SKILL.md has ${text.length} chars`);
});
