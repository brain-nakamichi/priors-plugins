'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPromptOutput } = require('../hooks/user-prompt-submit.js');

test('each submitted prompt receives retention and timely Recall guidance as model context', () => {
  const output = buildPromptOutput({ prompt: 'private prompt text' });
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /明示依頼を待たず/);
  assert.match(output.hookSpecificOutput.additionalContext, /依存する前に必要な範囲を Recall/);
  assert.match(output.hookSpecificOutput.additionalContext, /固定手順は不要/);
  assert.doesNotMatch(JSON.stringify(output), /private prompt text/);
});
