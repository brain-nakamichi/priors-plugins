#!/usr/bin/env node
'use strict';

const { recordDecision, observedSaves } = require('./decision-audit.js');
const { acknowledgeProactiveCandidates } = require('./proactive-candidates.js');

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function run(args = process.argv.slice(2), env = process.env) {
  try {
    const decision = arg(args, '--decision');
    const client = arg(args, '--client') || 'unknown';
    const promptHash = arg(args, '--prompt-sha256');
    const phase = arg(args, '--phase') || 'unknown';
    const turnId = arg(args, '--turn-id');
    // GEN-554: --save-result recorded|failed|not_needed [--saved GEN-12@1,GEN-w3@2,cache:...] — what the server
    // actually answered, so "decided to save" and "saved" stay distinguishable in the audit log.
    const saveResult = arg(args, '--save-result');
    const sessionId = arg(args, '--session-id');
    let savedIds = (arg(args, '--saved') || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (saveResult === 'recorded' && arg(args, '--saved') === undefined && phase === 'conversation-end' && decision === 'write-candidate') savedIds = observedSaves(sessionId, client);
    const save = saveResult ? { outcome: saveResult, ids: savedIds } : undefined;
    // A session can contain multiple turns. Never infer that an unscoped
    // conversation-end skip applies to whichever turn is currently active.
    const { event } = recordDecision({ decision, client, promptHash, phase, save, sessionId, turnId, invocationKind: 'explicit-helper' }, env);
    // A skip clears only candidates explicitly attached to this turn. Missing
    // turn scope is intentionally a no-op, preserving all queued candidates.
    const acknowledges = event.source === 'explicit' && event.phase === 'conversation-end'
      && event.turn_id && event.decision === 'skip';
    const acknowledged = acknowledges
      ? acknowledgeProactiveCandidates(event.decision, env, event.turn_id)
      : 0;
    return { exitCode: 0, payload: { ok: true, schema: event.schema, decision: event.decision, phase: event.phase, acknowledged_candidates: acknowledged, ...(event.save ? { save: event.save } : {}) } };
  } catch {
    return { exitCode: 2, payload: { ok: false, error: 'invalid_input' } };
  }
}

if (require.main === module) {
  const result = run();
  process.stdout.write(`${JSON.stringify(result.payload)}\n`);
  process.exitCode = result.exitCode;
}
module.exports = { run };
