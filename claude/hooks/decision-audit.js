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

// GEN-554: a decision to save is not a save. The conversation-end record may carry what the server actually
// answered: the outcome and the ids (memory id@version, cache id) — never bodies, tokens or connection strings.
const SAVE_OUTCOMES = new Set(['recorded', 'failed', 'not_needed']);
const SAVE_ID = /^[A-Za-z0-9_:@.-]{1,80}$/;
function normalizeSave(save) {
  if (save === undefined || save === null) return undefined;
  if (typeof save !== 'object') throw new Error('invalid save');
  if (!SAVE_OUTCOMES.has(save.outcome)) throw new Error('invalid save outcome');
  const ids = Array.isArray(save.ids) ? save.ids : [];
  if (ids.length > 20 || ids.some((x) => typeof x !== 'string' || !SAVE_ID.test(x))) throw new Error('invalid save id');
  // GEN-556: "recorded" is only meaningful with the reference the server returned (memory id@version / cache id)
  if (save.outcome === 'recorded' && ids.length === 0) throw new Error('recorded requires a saved id');
  return { outcome: save.outcome, ids };
}

function recordDecision({ decision, client, promptHash, source = 'explicit', phase = 'unknown', save }, env = process.env) {
  if (!DECISIONS.has(decision)) throw new Error('invalid decision');
  if (!PHASES.has(phase)) throw new Error('invalid phase');
  const saveRecord = normalizeSave(save);
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
    ...(saveRecord ? { save: saveRecord } : {}),
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

function auditHealth(env = process.env, maxLines = 256) {
  const file = auditPath(env);
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-maxLines); }
  catch { return { events: 0, invalid_lines: 0, pending_turn_starts: 0, pending_conversation_end: 0 }; }
  let invalid = 0; let events = 0; let turnPending = 0; let endPending = 0;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { invalid++; continue; }
    if (!event || event.schema !== 'priors.decision-audit.v1' || !DECISIONS.has(event.decision) || !PHASES.has(event.phase)) { invalid++; continue; }
    events++;
    if (event.decision === 'pending') {
      if (event.phase === 'turn-start') turnPending++;
      if (event.phase === 'conversation-end') endPending++;
    } else if (event.source === 'explicit') {
      if (event.phase === 'turn-start' && turnPending > 0) turnPending--;
      if (event.phase === 'conversation-end' && endPending > 0) endPending--;
    }
  }
  return { events, invalid_lines: invalid, pending_turn_starts: turnPending, pending_conversation_end: endPending };
}

module.exports = {
  DECISIONS, PHASES, auditPath, stopDiagnosticPath, hashPrompt,
  recordDecision, recordStopInvocation, lastAuditEvent, auditHealth,
};
