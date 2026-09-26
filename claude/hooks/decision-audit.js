'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DECISIONS = new Set(['pending', 'use-read', 'write-candidate', 'skip']);
const PHASES = new Set(['unknown', 'turn-start', 'conversation-end']);

function auditPath(env = process.env) {
  const configured = env.PRIORS_DECISION_AUDIT_FILE;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.priors', 'decision-audit.jsonl');
}

function stopDiagnosticPath(env = process.env) {
  const configured = env.PRIORS_STOP_DIAGNOSTIC_FILE;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.priors', 'stop-hook.jsonl');
}

function hashPrompt(prompt) {
  return crypto.createHash('sha256').update(String(prompt || ''), 'utf8').digest('hex');
}

function recordDecision({ decision, client, promptHash, source = 'explicit', phase = 'unknown' }, env = process.env) {
  if (!DECISIONS.has(decision)) throw new Error('invalid decision');
  if (!PHASES.has(phase)) throw new Error('invalid phase');
  const file = auditPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const event = {
    schema: 'priors.decision-audit.v1',
    recorded_at: new Date().toISOString(),
    decision,
    client: typeof client === 'string' && client ? client : 'unknown',
    source,
    phase,
    ...(typeof promptHash === 'string' && /^[0-9a-f]{64}$/.test(promptHash)
      ? { prompt_sha256: promptHash } : {}),
  };
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
  return { file, event };
}

function recordStopInvocation({ stopHookActive = false } = {}, env = process.env) {
  const file = stopDiagnosticPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const event = {
    schema: 'priors.stop-hook-diagnostic.v1',
    recorded_at: new Date().toISOString(),
    event: 'stop_invoked',
    client: 'claude',
    stop_hook_active: stopHookActive === true,
  };
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
  return { file, event };
}

function lastAuditEvent(env = process.env) {
  const file = auditPath(env);
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

module.exports = {
  DECISIONS, PHASES, auditPath, stopDiagnosticPath, hashPrompt,
  recordDecision, recordStopInvocation, lastAuditEvent,
};
