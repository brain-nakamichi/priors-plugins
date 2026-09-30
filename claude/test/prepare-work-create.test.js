'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareWorkCreate } = require('../hooks/prepare-work-create.js');

test('work_create payloadを決定的に生成する', () => {
  const result = prepareWorkCreate({
    theme: 'GEN', objective: '自動Recall評価を実装する', target_environment: 'production',
    completion_criteria: ['テストが通る', '配備を確認する'], session_id: 'session-1', source: 'conversation-objective',
  });
  assert.equal(result.payload.theme, 'GEN');
  assert.equal(result.payload.idempotency_key, 'work-create-988398f4984c37f64d34b4695117d7e7');
  assert.equal(result.source, 'conversation-objective');
});

test('必須の目的・完了条件・session_idが無ければ拒否する', () => {
  assert.throws(() => prepareWorkCreate({ theme: 'GEN', objective: 'x' }), /invalid_completion_criteria/);
  assert.throws(() => prepareWorkCreate({ theme: 'GEN', objective: 'x', completion_criteria: ['done'] }), /missing_session_id/);
});

test('入力からtokenや本文以外の秘密を取り込まない', () => {
  const result = prepareWorkCreate({ theme: 'GEN', objective: 'x', completion_criteria: ['done'], session_id: 's', token: 'secret' });
  assert.equal('token' in result.payload, false);
});
