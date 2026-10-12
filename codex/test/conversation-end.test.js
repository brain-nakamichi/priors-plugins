'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStopOutput } = require('../hooks/conversation-end.js');

test('Stop adds concise guidance without blocking or forcing another model turn', () => {
  const output = buildStopOutput({ hook_event_name: 'Stop', last_assistant_message: 'private transcript text' });
  assert.equal(typeof output.systemMessage, 'string');
  assert.match(output.systemMessage, /明示依頼を待たず/);
  assert.match(output.systemMessage, /Recall/);
  assert.equal(Object.hasOwn(output, 'decision'), false);
  assert.equal(Object.hasOwn(output, 'reason'), false);
  assert.doesNotMatch(JSON.stringify(output), /private transcript text/);
});

test('Stop re-entry stays advisory and does not request a continuation', () => {
  const output = buildStopOutput({ hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(Object.hasOwn(output, 'decision'), false);
  assert.equal(Object.hasOwn(output, 'continue'), false);
  assert.equal(typeof output.systemMessage, 'string');
});
