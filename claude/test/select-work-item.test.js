'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectWorkItem } = require('../hooks/select-work-item.js');

test('目的の語が一致する未解決workを自動選択する', () => {
  const result = selectWorkItem('自動Recallの評価を実装する', [
    { work_id: 'GEN-w1', objective: '古いDB作業', status: 'in_progress' },
    { work_id: 'GEN-w2', objective: '自動Recallの評価を測定する', status: 'in_progress' },
  ]);
  assert.deepEqual(result, { work_id: 'GEN-w2', method: 'objective-match', score: 2 });
});

test('明示work IDは一致を優先する', () => {
  assert.deepEqual(selectWorkItem('別目的', [{ work_id: 'GEN-w3', objective: 'x' }], 'GEN-w3'), {
    work_id: 'GEN-w3', method: 'explicit', score: 0,
  });
});

test('一致がなければwork_create候補へ進む', () => {
  assert.equal(selectWorkItem('新しい目的', [{ work_id: 'GEN-w4', objective: '無関係' }]), null);
});

test('resolved/cancelled workは自動選択しない', () => {
  assert.equal(selectWorkItem('自動Recallの評価', [
    { work_id: 'GEN-w5', objective: '自動Recallの評価', status: 'resolved' },
    { work_id: 'GEN-w6', objective: '自動Recallの評価', status: 'cancelled' },
  ]), null);
});

test('active work wins before similarity so resolved rows cannot shadow it', () => {
  assert.deepEqual(selectWorkItem('自動Recallの評価', [
    { work_id: 'GEN-w7', objective: '自動Recallの評価を完了', status: 'resolved' },
    { work_id: 'GEN-w8', objective: '自動Recallの評価を続ける', status: 'in_progress' },
  ]), { work_id: 'GEN-w8', method: 'objective-match', score: 2 });
});
