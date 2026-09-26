'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const DECISIONS = new Set(['pending', 'use-read', 'write-candidate', 'skip']);
const PHASES = new Set(['unknown', 'turn-start', 'conversation-end']);
function auditPath(env = process.env) {
  const configured = env.PRIORS_DECISION_AUDIT_FILE;
  return typeof configured === 'string' && configured.trim() ? path.resolve(configured) : path.join(os.homedir(), '.priors', 'decision-audit.jsonl');
}
function hashPrompt(prompt) { return crypto.createHash('sha256').update(String(prompt || ''), 'utf8').digest('hex'); }
function append(event, env = process.env) {
  const file = auditPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  return { file, event };
}
function recordDecision({ decision, client = 'codex', promptHash, source = 'explicit', phase = 'unknown' }, env = process.env) {
  if (!DECISIONS.has(decision) || !PHASES.has(phase) || !['explicit', 'hook'].includes(source)) throw new Error('invalid input');
  return append({ schema: 'priors.decision-audit.v1', recorded_at: new Date().toISOString(), decision, client, source, phase, ...(typeof promptHash === 'string' && /^[0-9a-f]{64}$/.test(promptHash) ? { prompt_sha256: promptHash } : {}) }, env);
}
function lastAuditEvent(env = process.env) {
  try { const lines = fs.readFileSync(auditPath(env), 'utf8').trim().split(/\r?\n/).filter(Boolean); return lines.length ? JSON.parse(lines.at(-1)) : null; } catch { return null; }
}
module.exports = { hashPrompt, recordDecision, lastAuditEvent };
