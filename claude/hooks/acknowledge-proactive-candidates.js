#!/usr/bin/env node
'use strict';

const { acknowledgeProactiveCandidates } = require('./proactive-candidates.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const decision = arg('--decision');
const count = acknowledgeProactiveCandidates(decision);
if (!['use-read', 'write-candidate', 'skip'].includes(decision)) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'invalid_decision' })}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, decision, acknowledged: count })}\n`);
}
