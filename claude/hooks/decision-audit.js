'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DECISIONS = new Set(['pending', 'use-read', 'write-candidate', 'skip']);
const PHASES = new Set(['unknown', 'turn-start', 'conversation-end', 'tool-save']);

function auditPath(env = process.env) {
  const configured = env.PRIORS_DECISION_AUDIT_FILE;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.priors', 'decision-audit.jsonl');
}

function stopDiagnosticPath(env = process.env) {
  const configured = env.PRIORS_STOP_DIAGNOSTIC_FILE;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.priors', 'stop-hook-state.json');
}

function turnStatePath(env = process.env) {
  const configured = env.PRIORS_TURN_STATE_FILE;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.priors', 'active-turn-state.json');
}

function hashPrompt(prompt) {
  return crypto.createHash('sha256').update(String(prompt || ''), 'utf8').digest('hex');
}

// GEN-554: a decision to save is not a save. The conversation-end record may carry what the server actually
// answered: the outcome and the ids (memory id@version, cache id) — never bodies, tokens or connection strings.
const SAVE_OUTCOMES = new Set(['recorded', 'failed', 'not_needed']);
const SAVE_ID = /^[A-Za-z0-9_:@.-]{1,80}$/;
const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_ID = /^pc-[0-9a-f]{12}(?:-[0-9a-f]{8})?-[a-z-]{1,120}$/i;
function normalizeSave(save) {
  if (save === undefined || save === null) return undefined;
  if (typeof save !== 'object') throw new Error('invalid save');
  if (!SAVE_OUTCOMES.has(save.outcome)) throw new Error('invalid save outcome');
  const ids = Array.isArray(save.ids) ? save.ids : [];
  if (ids.length > 20 || ids.some((x) => typeof x !== 'string' || !SAVE_ID.test(x))) throw new Error('invalid save id');
  // GEN-556: "recorded" is only meaningful with the reference the server returned (memory id@version / cache id)
  if (save.outcome === 'recorded' && ids.length === 0) throw new Error('recorded requires a saved id');
  const candidateReceipts = Array.isArray(save.candidate_receipts) ? save.candidate_receipts : [];
  if (candidateReceipts.length > 20) throw new Error('invalid candidate receipt');
  for (const receipt of candidateReceipts) {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.candidate_id !== 'string' || !CANDIDATE_ID.test(receipt.candidate_id)
      || !Array.isArray(receipt.resource_ids) || receipt.resource_ids.length < 1 || receipt.resource_ids.length > 20
      || receipt.resource_ids.some((id) => typeof id !== 'string' || !SAVE_ID.test(id) || !ids.includes(id))) throw new Error('invalid candidate receipt');
  }
  const tool = save.tool;
  if (tool !== undefined && !['remember', 'amend', 'capture', 'work_create', 'work_event'].includes(tool)) throw new Error('invalid save tool');
  return { outcome: save.outcome, ids, ...(tool ? { tool } : {}),
    ...(candidateReceipts.length ? { candidate_receipts: candidateReceipts.map((receipt) => ({ candidate_id: receipt.candidate_id, resource_ids: [...new Set(receipt.resource_ids)] })) } : {}),
  };
}

const MAX_TURN_STATE_BYTES = 64 * 1024;
const MAX_TURN_SESSIONS = 16;
const MAX_TURN_RECEIPTS = 8;
const MAX_AUDIT_TAIL_BYTES = 4 * 1024 * 1024;
const TURN_STATE_TTL_MS = 24 * 60 * 60 * 1000;
function isFreshTurnStart(timestamp, nowMs = Date.now()) {
  const recordedAt = Date.parse(timestamp);
  return Number.isFinite(recordedAt) && recordedAt <= nowMs && nowMs - recordedAt < TURN_STATE_TTL_MS;
}
function readTail(file, maximumBytes = MAX_AUDIT_TAIL_BYTES) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maximumBytes);
  const length = stat.size - start;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}
function readTurnState(env = process.env, nowMs = Date.now()) {
  try {
    const file = turnStatePath(env);
    if (fs.statSync(file).size > MAX_TURN_STATE_BYTES) return null;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state?.schema !== 'priors.active-turn-state.v1' || !Array.isArray(state.sessions) || state.sessions.length > MAX_TURN_SESSIONS) return null;
    // This file tracks only active prompt turns; it is not the durable
    // proactive-candidate queue, which has its own lifecycle and TTL.
    return { ...state, sessions: state.sessions.filter((item) => isFreshTurnStart(item?.updated_at, nowMs)) };
  } catch (error) {
    return error?.code === 'ENOENT' ? { schema: 'priors.active-turn-state.v1', sessions: [] } : null;
  }
}

function writeTurnState(state, env = process.env) {
  const file = turnStatePath(env);
  const data = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(data, 'utf8') > MAX_TURN_STATE_BYTES) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    return false;
  }
}

function updateTurnState(event, env = process.env) {
  const sessionId = event?.session_id;
  const turnId = event?.turn_id;
  if (!validSession(sessionId) || !TURN_ID.test(turnId || '') || !['claude', 'codex'].includes(event.client)) return false;
  const state = readTurnState(env);
  if (!state) return false;
  let index = state.sessions.findIndex((item) => item.client === event.client && item.session_id === sessionId);
  if (event.phase === 'turn-start' && event.source === 'hook') {
    const next = { client: event.client, session_id: sessionId, turn_id: turnId, updated_at: new Date().toISOString(), saves: [] };
    if (index >= 0) state.sessions.splice(index, 1);
    state.sessions.push(next);
  } else {
    if (index < 0 || state.sessions[index].turn_id !== turnId) return false;
    const active = state.sessions[index];
    active.updated_at = new Date().toISOString();
    if (event.phase === 'tool-save' && event.source === 'hook' && event.save?.outcome === 'recorded'
      && Array.isArray(event.save.candidate_receipts) && event.save.candidate_receipts.length) {
      const storedReceipts = event.save.candidate_receipts.flatMap((receipt) => receipt.resource_ids.map((resourceId) => ({
        candidate_id: receipt.candidate_id,
        resource_id: resourceId,
      })));
      const seen = new Set(active.saves.flatMap((entry) => (entry.save?.candidate_receipts || []).map((receipt) => `${receipt.candidate_id}\0${receipt.resource_id}`)));
      const additions = storedReceipts.filter((receipt) => !seen.has(`${receipt.candidate_id}\0${receipt.resource_id}`));
      const existingCount = active.saves.reduce((count, entry) => count + (entry.save?.candidate_receipts?.length || 0), 0);
      // Keep only a small, fixed number of candidate→resource pairs per active
      // turn. Generic save refs are not retained here.
      const remaining = Math.max(0, MAX_TURN_RECEIPTS - existingCount);
      const bounded = additions.slice(0, remaining);
      if (bounded.length) {
        active.saves.push({ save: { outcome: 'recorded', tool: event.save.tool, ids: [...new Set(bounded.map((receipt) => receipt.resource_id))], candidate_receipts: bounded } });
        active.saves = active.saves.slice(-20);
      }
    }
    if (event.phase === 'conversation-end' && event.source === 'explicit') active.decision = event.decision;
    state.sessions.splice(index, 1);
    state.sessions.push(active);
  }
  state.sessions.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  state.sessions = state.sessions.slice(-MAX_TURN_SESSIONS);
  return writeTurnState(state, env);
}

function recordDecision({ decision, client, promptHash, source = 'explicit', phase = 'unknown', save, inputSafety, sessionId, invocationKind, turnId }, env = process.env) {
  if (!DECISIONS.has(decision)) throw new Error('invalid decision');
  if (!PHASES.has(phase)) throw new Error('invalid phase');
  if (invocationKind !== undefined && !['explicit-helper', 'client-hook'].includes(invocationKind)) throw new Error('invalid invocation kind');
  const saveRecord = normalizeSave(save);
  const resolvedTurnId = TURN_ID.test(turnId || '') ? turnId : undefined;
  const file = auditPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const event = {
    schema: 'priors.decision-audit.v1',
    recorded_at: new Date().toISOString(),
    decision,
    client: typeof client === 'string' && client ? client : 'unknown',
    source,
    phase,
    ...(invocationKind ? { invocation_kind: invocationKind } : {}),
    ...(validSession(sessionId) ? { session_id: sessionId } : {}),
    ...(resolvedTurnId ? { turn_id: resolvedTurnId } : {}),
    ...(['suspected', 'uninspectable', 'reported'].includes(inputSafety)
      ? { input_safety: inputSafety, safety_notice_id: crypto.randomUUID() } : {}),
    ...(!['suspected', 'uninspectable'].includes(inputSafety) && typeof promptHash === 'string' && /^[0-9a-f]{64}$/.test(promptHash)
      ? { prompt_sha256: promptHash } : {}),
    ...(saveRecord ? { save: saveRecord } : {}),
  };
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
  try { updateTurnState(event, env); } catch { /* turn receipts are best effort */ }
  return { file, event };
}

// Prompt-independent notices for the latest turn. Completion of an ordinary
// save is not proof that credential work exists, so retain the notice at Stop.
// A new turn after an explicit end starts a new reminder window.
function inputSafetySummary(env = process.env, client = 'claude') {
  const counts = { suspected: 0, uninspectable: 0, reported: 0 };
  try {
    const lines = readTail(auditPath(env)).trim().split(/\r?\n/).slice(-256);
    let ended = false;
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event?.schema !== 'priors.decision-audit.v1' || event.client !== client) continue;
      if (ended && event.phase === 'turn-start') {
        counts.suspected = counts.uninspectable = counts.reported = 0;
        ended = false;
      }
      if (Object.hasOwn(counts, event.input_safety)) counts[event.input_safety]++;
      if (event.phase === 'conversation-end' && event.source === 'explicit') ended = true;
    }
  } catch { /* do not echo errors */ }
  return counts;
}

function inputSafetyGuidance(counts) {
  return counts.suspected + counts.uninspectable + counts.reported > 0
    ? `認証情報対応の確認: このターンの秘密疑い ${counts.suspected}件、検査不能 ${counts.uninspectable}件、露出申告 ${counts.reported}件。値を含まない作業項目があるか確認してください。同じ事象は既存workを再利用し、不要なら理由を残す。件数はローカルの印であり漏えい・保存不足の証明ではありません。`
    : '';
}

function recordStopInvocation({ stopHookActive = false, invalidLines = 0 } = {}, env = process.env) {
  const file = stopDiagnosticPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let previousInvalidLines;
  try {
    if (fs.statSync(file).size <= 2048) {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (previous?.schema === 'priors.stop-hook-diagnostic.v1' && Number.isSafeInteger(previous.invalid_lines)) previousInvalidLines = previous.invalid_lines;
    }
  } catch { /* first invocation */ }
  const invalidLinesChanged = Number.isSafeInteger(invalidLines) && invalidLines >= 0
    && (previousInvalidLines === undefined ? invalidLines > 0 : previousInvalidLines !== invalidLines);
  const event = {
    schema: 'priors.stop-hook-diagnostic.v1',
    recorded_at: new Date().toISOString(),
    client: 'claude',
    stop_hook_active: stopHookActive === true,
    invalid_lines: Number.isSafeInteger(invalidLines) && invalidLines >= 0 ? invalidLines : 0,
  };
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(event), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    return { file, event: null, invalidLinesChanged: false };
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
  return { file, event, invalidLinesChanged };
}

// Read the bounded local audit journal to resolve the current prompt turn.
// This stores only opaque UUIDs and validated save references, never prompt text.
function auditEvents(env = process.env, maximumBytes = 4 * 1024 * 1024) {
  try {
    const file = auditPath(env);
    if (fs.statSync(file).size > maximumBytes) return null;
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((event) => event?.schema === 'priors.decision-audit.v1');
  } catch { return []; }
}

function activeTurnId(sessionId, client = 'claude', env = process.env, nowMs = Date.now()) {
  if (!validSession(sessionId)) return undefined;
  const state = readTurnState(env, nowMs);
  if (!state) return undefined;
  const active = state.sessions.find((item) => item.client === client && item.session_id === sessionId);
  return TURN_ID.test(active?.turn_id || '') ? active.turn_id : undefined;
}

function currentTurnAudit(sessionId, client = 'claude', env = process.env, nowMs = Date.now()) {
  if (!validSession(sessionId)) return { known: false, turn_id: undefined, prompt_sha256: undefined, saves: [], decision: undefined };
  const state = readTurnState(env, nowMs);
  if (!state) return { known: false, turn_id: undefined, prompt_sha256: undefined, saves: [], decision: undefined };
  const active = state.sessions.find((item) => item.client === client && item.session_id === sessionId);
  if (!active || !TURN_ID.test(active.turn_id || '')) return { known: false, turn_id: undefined, prompt_sha256: undefined, saves: [], decision: undefined };
  const saves = (active.saves || []).map((entry) => {
    const byCandidate = new Map();
    for (const receipt of entry.save?.candidate_receipts || []) {
      if (!byCandidate.has(receipt.candidate_id)) byCandidate.set(receipt.candidate_id, []);
      byCandidate.get(receipt.candidate_id).push(receipt.resource_id);
    }
    return { save: { ...entry.save, candidate_receipts: [...byCandidate].map(([candidate_id, resource_ids]) => ({ candidate_id, resource_ids })) } };
  });
  return { known: true, turn_id: active.turn_id, prompt_sha256: undefined, saves, decision: active.decision ? { decision: active.decision } : undefined };
}

function lastAuditEvent(env = process.env) {
  const file = auditPath(env);
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    return lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((event) => event && event.phase !== 'tool-save').at(-1) || null;
  } catch {
    return null;
  }
}

function auditHealth(env = process.env, maxLines = 256, nowMs = Date.now()) {
  const file = auditPath(env);
  let lines;
  try { lines = readTail(file).trim().split(/\r?\n/).filter(Boolean).slice(-maxLines); }
  catch { return { events: 0, invalid_lines: 0, pending_turn_starts: 0, pending_conversation_end: 0 }; }
  let invalid = 0; let events = 0; const pendingTurns = []; let endPending = 0;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { invalid++; continue; }
    if (!event || event.schema !== 'priors.decision-audit.v1' || !DECISIONS.has(event.decision) || !PHASES.has(event.phase)) { invalid++; continue; }
    events++;
    if (event.decision === 'pending') {
      if (event.phase === 'turn-start') pendingTurns.push(event);
      if (event.phase === 'conversation-end') endPending++;
    } else if (event.source === 'explicit') {
      if (event.phase === 'turn-start') {
        const matchIndex = findPendingTurn(pendingTurns, event);
        if (matchIndex >= 0) pendingTurns.splice(matchIndex, 1);
      }
      if (event.phase === 'conversation-end' && endPending > 0) endPending--;
    }
  }
  const turnPending = pendingTurns.filter((event) => isFreshTurnStart(event.recorded_at, nowMs)).length;
  return { events, invalid_lines: invalid, pending_turn_starts: turnPending, pending_conversation_end: endPending };
}

function findPendingTurn(pendingTurns, resolvedEvent) {
  const hasTurnId = typeof resolvedEvent.turn_id === 'string';
  const hasSessionId = validSession(resolvedEvent.session_id);
  for (let index = pendingTurns.length - 1; index >= 0; index--) {
    const pending = pendingTurns[index];
    if (pending.client !== resolvedEvent.client) continue;
    if (hasTurnId && pending.turn_id !== resolvedEvent.turn_id) continue;
    if (hasSessionId && pending.session_id !== resolvedEvent.session_id) continue;
    // Identified events resolve only their matching turn/session. Legacy
    // explicit events without either identifier retain the prior LIFO pairing.
    return index;
  }
  return -1;
}

function validSession(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function observedSaves(sessionId, client, env = process.env) {
  if (!validSession(sessionId)) throw new Error('manual_references_required');
  // Bound audit reading; do not silently treat a truncated window as complete.
  const stat = fs.statSync(auditPath(env));
  if (stat.size > 4 * 1024 * 1024) throw new Error('manual_references_required');
  const lines = fs.readFileSync(auditPath(env), 'utf8').trim().split(/\r?\n/);
  let found = false; const ids = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = JSON.parse(lines[i]);
    if (event.schema !== 'priors.decision-audit.v1') throw new Error('manual_references_required');
    if (event.client !== client || event.session_id !== sessionId) continue;
    if (event.phase === 'turn-start' && event.source === 'hook') { found = true; break; }
    if (event.phase === 'tool-save') {
      const save = normalizeSave(event.save);
      if (!save || save.outcome !== 'recorded' || event.source !== 'hook') throw new Error('manual_references_required');
      for (const id of save.ids) ids.add(id);
      if (ids.size > 20) throw new Error('manual_references_required');
    }
  }
  if (!found || !ids.size) throw new Error('manual_references_required');
  return [...ids];
}
module.exports = { validSession, observedSaves, activeTurnId, currentTurnAudit,
  DECISIONS, PHASES, auditPath, stopDiagnosticPath, turnStatePath, hashPrompt,
  recordDecision, recordStopInvocation, lastAuditEvent, auditHealth,
  inputSafetySummary, inputSafetyGuidance,
};
