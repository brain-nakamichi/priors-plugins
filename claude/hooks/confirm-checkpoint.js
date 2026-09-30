#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { confirmCheckpointCandidate } = require('./proactive-candidates.js');
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = null; try { input = JSON.parse(raw || '{}'); } catch { input = null; }
  const file = arg('--payload-file');
  if (file) { try { input = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { input = null; } }
  const candidateId = arg('--candidate-id') || input?.candidate_id;
  const payload = input?.payload || input;
  const result = confirmCheckpointCandidate(candidateId, payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
});
