#!/usr/bin/env node
'use strict';

const { acknowledgeProactiveCandidates } = require('./proactive-candidates.js');

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function run(args = process.argv.slice(2), env = process.env) {
  const decision = arg(args, '--decision');
  const turnId = arg(args, '--turn-id');
  if (!['use-read', 'skip'].includes(decision)) return { exitCode: 2, payload: { ok: false, error: 'invalid_decision' } };
  if (!turnId) return { exitCode: 2, payload: { ok: false, error: 'turn_id_required' } };
  const acknowledged = acknowledgeProactiveCandidates(decision, env, turnId);
  return { exitCode: 0, payload: { ok: true, decision, acknowledged } };
}

if (require.main === module) {
  const result = run();
  process.stdout.write(`${JSON.stringify(result.payload)}\n`);
  process.exitCode = result.exitCode;
}
module.exports = { run };
