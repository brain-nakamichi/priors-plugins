'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStopOutput } = require('../hooks/conversation-end.js');

test('first Stop pass asks for a retention and relevant Recall check without forcing a save', () => {
  const output = buildStopOutput({ hook_event_name: 'Stop', last_assistant_message: 'ordinary response' });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /重要な利用者指示/);
  assert.match(output.reason, /保存不要ならその判断で構いません/);
  assert.match(output.reason, /必要な情報だけRecall/);
  assert.doesNotMatch(JSON.stringify(output), /ordinary response/);
});

test('Stop re-entry does not issue another continuation', () => {
  assert.deepEqual(buildStopOutput({ hook_event_name: 'Stop', stop_hook_active: true }), { continue: true });
});
