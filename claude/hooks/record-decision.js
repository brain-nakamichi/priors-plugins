#!/usr/bin/env node
'use strict';

const { recordDecision } = require('./decision-audit.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  const decision = arg('--decision');
  const client = arg('--client') || 'unknown';
  const promptHash = arg('--prompt-sha256');
  const phase = arg('--phase') || 'unknown';
  const { event } = recordDecision({ decision, client, promptHash, phase });
  process.stdout.write(JSON.stringify({ ok: true, schema: event.schema, decision: event.decision, phase: event.phase }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: 'invalid_input' }) + '\n');
  process.exitCode = 2;
}
