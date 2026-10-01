#!/usr/bin/env node
'use strict';

const { recordDecision } = require('./decision-audit.js');
const { acknowledgeProactiveCandidates } = require('./proactive-candidates.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  const decision = arg('--decision');
  const client = arg('--client') || 'unknown';
  const promptHash = arg('--prompt-sha256');
  const phase = arg('--phase') || 'unknown';
  // GEN-554: --save-result recorded|failed|not_needed [--saved GEN-12@1,GEN-w3@2,cache:...] — what the server
  // actually answered, so "decided to save" and "saved" stay distinguishable in the audit log
  const saveResult = arg('--save-result');
  const savedIds = (arg('--saved') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const save = saveResult ? { outcome: saveResult, ids: savedIds } : undefined;
  const { event } = recordDecision({ decision, client, promptHash, phase, save });
  const acknowledged = event.source === 'explicit' && event.phase === 'conversation-end'
    ? acknowledgeProactiveCandidates(event.decision)
    : 0;
  process.stdout.write(JSON.stringify({ ok: true, schema: event.schema, decision: event.decision, phase: event.phase, acknowledged_candidates: acknowledged, ...(event.save ? { save: event.save } : {}) }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: 'invalid_input' }) + '\n');
  process.exitCode = 2;
}
