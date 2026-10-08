#!/usr/bin/env node
'use strict';
const { recordDecision } = require('../hooks/decision-audit.js');
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--kind' || !['suspected', 'uninspectable', 'reported'].includes(args[1])) throw new Error();
  recordDecision({ decision: 'skip', client: 'codex', source: 'explicit-safety', phase: 'unknown', inputSafety: args[1] });
  process.stdout.write(JSON.stringify({ ok: true }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: 'invalid_input' }) + '\n');
  process.exitCode = 2;
}
