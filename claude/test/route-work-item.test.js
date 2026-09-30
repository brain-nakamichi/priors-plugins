'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeWorkItem } = require('../hooks/route-work-item.js');

test('一致workがあればwork_eventルートを返す', () => {
  const result = routeWorkItem({
    objective: '自動Recall評価を実装する',
    work_candidates: [{ work_id: 'GEN-w2', objective: '自動Recallの評価を測定する', status: 'in_progress' }],
  });
  assert.equal(result.action, 'work_event');
  assert.equal(result.selection.work_id, 'GEN-w2');
});

test('一致workがなければwork_create payloadルートを返す', () => {
  const result = routeWorkItem({
    theme: 'GEN', objective: '新しい評価を実装する', target_environment: 'local',
    completion_criteria: ['テストが通る'], session_id: 'session-1',
    work_candidates: [{ work_id: 'GEN-w3', objective: '無関係なDB作業', status: 'in_progress' }],
  });
  assert.equal(result.action, 'work_create');
  assert.equal(result.create.payload.theme, 'GEN');
});

test('作成情報が不足していれば安全に失敗する', () => {
  assert.throws(() => routeWorkItem({ objective: '新規', work_candidates: [] }), /invalid_theme/);
});

test('unknown explicit work ID does not fall back to duplicate work_create', () => {
  const result = routeWorkItem({
    theme: 'GEN', objective: '既存作業を更新する', work_id: 'GEN-w99',
    completion_criteria: ['テストが通る'], session_id: 'session-1', work_candidates: [],
  });
  assert.deepEqual(result, { action: 'work_event', error: 'explicit_work_not_found', work_id: 'GEN-w99' });
});
