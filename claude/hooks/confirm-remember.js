#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { confirmRememberCandidate } = require('./proactive-candidates.js');

let raw = '';
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { input = null; }
  let fileInput = null;
  const payloadFile = arg('--payload-file');
  if (payloadFile) {
    try { fileInput = JSON.parse(fs.readFileSync(payloadFile, 'utf8')); } catch { fileInput = null; }
  }
  const candidateId = arg('--candidate-id') || (fileInput && fileInput.candidate_id) || (input && input.candidate_id);
  const payload = (fileInput && (fileInput.payload || fileInput)) || (input && input.payload);
  const result = confirmRememberCandidate(candidateId, payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
});
