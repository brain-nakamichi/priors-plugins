#!/usr/bin/env node
'use strict';

const { confirmWorkItemCandidate } = require('./proactive-candidates.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function finish(candidateId, workId) {
  const result = confirmWorkItemCandidate(candidateId, workId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const flagCandidateId = arg('--candidate-id');
const flagWorkId = arg('--work-id');
if (flagCandidateId && flagWorkId) {
  finish(flagCandidateId, flagWorkId);
} else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
  let input = null;
  try { input = JSON.parse(raw || '{}'); } catch { /* flags remain available */ }
    finish(flagCandidateId || input?.candidate_id, flagWorkId || input?.work_id);
  });
}
