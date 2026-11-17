'use strict';
// GEN-2374 (A): a local, per-conversation list of saved memories whose search card is still missing, and the
// end-of-turn notice built from it. IDs and versions only: no title, body, summary, error text or network.
// Every failure is swallowed by the callers; this file never blocks a save or a stop.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSavedResponse, unwrapSaveResponse } = require('./save-response.js');
const { pendingCardNotice } = require('./pending-card-notice.js');

const ID = /^[A-Z][A-Z0-9]{1,7}-[0-9]+$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 200, MAX_SESSIONS = 50, MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SHOWN = 10, MAX_NOTICES = 3;
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const prefix = 'mcp__priors__';

function ledgerPath(env = process.env) {
  const configured = env.PRIORS_PENDING_CARD_FILE;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.priors', 'pending-cards.json');
}

function readLedger(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(ledgerPath(env), 'utf8'));
    if (data && data.schema === 'priors.pending-cards.v1' && data.sessions && typeof data.sessions === 'object') return data;
  } catch { /* missing or damaged: start clean */ }
  return { schema: 'priors.pending-cards.v1', sessions: {} };
}

function writeLedger(data, env = process.env, nowMs = Date.now()) {
  const entries = Object.entries(data.sessions)
    .filter(([id, s]) => SESSION.test(id) && s && typeof s === 'object' && nowMs - Number(s.updated_at_ms || 0) <= MAX_AGE_MS
      && s.items && Object.keys(s.items).length > 0)
    .sort((a, b) => Number(b[1].updated_at_ms) - Number(a[1].updated_at_ms)).slice(0, MAX_SESSIONS);
  const file = ledgerPath(env), temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ schema: 'priors.pending-cards.v1', sessions: Object.fromEntries(entries) }), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** What one tool result means for the list: {add:[{id,version,reason}], settle:[{id,version}], drop:[id]}. Pure. */
function cardChanges(toolName, toolInput, toolResponse) {
  const name = typeof toolName === 'string' && toolName.startsWith(prefix) ? toolName.slice(prefix.length) : '';
  const out = { add: [], settle: [], drop: [] };
  const response = unwrapSaveResponse(toolResponse);
  if (!name || !response) return out;
  if (name === 'search_card') {
    // A written card settles that version (and anything older of the same memory).
    if (response.operation === 'search_card' && response.outcome_code === 'recorded' && ID.test(String(response.id))
      && positive(response.card?.entry_version) && ['ok', 'inherited'].includes(response.card?.state)) {
      out.settle.push({ id: response.id, version: response.card.entry_version });
    }
    return out;
  }
  if (name === 'amend' && response.operation === 'amend.retract' && response.outcome_code === 'applied' && Array.isArray(response.resource_ids)) {
    for (const ref of response.resource_ids.slice(0, 20)) if (ref && ID.test(String(ref.id))) out.drop.push(ref.id);
    return out;
  }
  const pending = new Map();
  // The fixed notice of pending-card-notice.js already names the bound id@version pairs (remember, amend, capture, maintain).
  for (const m of pendingCardNotice(toolName, toolResponse).matchAll(/([A-Z][A-Z0-9]{1,7}-[0-9]+)@([0-9]+)/g)) pending.set(m[1], Number(m[2]));
  const parsed = parseSavedResponse(toolName, toolResponse);
  if (parsed) {
    const refs = parsed.ids.map((x) => { const i = x.lastIndexOf('@'); return { id: x.slice(0, i), version: Number(x.slice(i + 1)) }; })
      .filter((r) => ID.test(r.id) && positive(r.version));
    // summary_record answers like remember; the shared notice does not cover it.
    if (name === 'summary_record' && refs.length === 1 && response.search_card?.state === 'pending') pending.set(refs[0].id, refs[0].version);
    const summaryGiven = typeof toolInput?.search_summary === 'string' && toolInput.search_summary.trim() !== '';
    for (const r of refs) {
      if (pending.has(r.id)) continue;
      // A revise without a summary carries no card field: the new version may fall back to a provisional card.
      if (name === 'amend' && response.operation === 'amend.revise' && !summaryGiven && response.search_card === undefined && refs.length === 1) {
        out.add.push({ ...r, reason: 'check' });
      } else {
        // A newer version with a card (or of unknown state) replaces what the list held for the older version.
        out.settle.push({ id: r.id, version: r.version - 1 });
      }
    }
  }
  for (const [id, version] of pending) if (ID.test(id) && positive(version)) out.add.push({ id, version, reason: 'pending' });
  return out;
}

function applyChanges(session, changes, nowMs) {
  const items = session.items && typeof session.items === 'object' ? session.items : {};
  let changed = false;
  for (const id of changes.drop) if (items[id]) { delete items[id]; changed = true; }
  for (const s of changes.settle) if (items[s.id] && items[s.id].version <= s.version) { delete items[s.id]; changed = true; }
  for (const a of changes.add) {
    const old = items[a.id];
    if (!old || old.version < a.version || old.version === a.version && old.reason !== a.reason) { items[a.id] = { version: a.version, reason: a.reason }; changed = true; }
  }
  const ids = Object.keys(items);
  if (ids.length > MAX_ITEMS) for (const id of ids.slice(0, ids.length - MAX_ITEMS)) delete items[id];
  session.items = items;
  if (changed) { session.updated_at_ms = nowMs; delete session.notice; }
  return changed;
}

/** PostToolUse: fold one tool result into the list of this conversation. Returns true when the list changed. */
function recordToolResult(sessionId, toolName, toolInput, toolResponse, env = process.env, nowMs = Date.now()) {
  if (!SESSION.test(String(sessionId))) return false;
  const changes = cardChanges(toolName, toolInput, toolResponse);
  if (!changes.add.length && !changes.settle.length && !changes.drop.length) return false;
  const data = readLedger(env);
  if (!data.sessions[sessionId] && !changes.add.length) return false;
  const session = data.sessions[sessionId] || { items: {}, updated_at_ms: nowMs };
  data.sessions[sessionId] = session;
  const changed = applyChanges(session, changes, nowMs);
  if (changed) writeLedger(data, env, nowMs);
  return changed;
}

/** Stop: one fixed line naming the memories that still need a card, at most MAX_NOTICES times for the same list. */
function pendingCardStopNotice(sessionId, env = process.env, nowMs = Date.now()) {
  if (!SESSION.test(String(sessionId))) return '';
  const data = readLedger(env), session = data.sessions[sessionId];
  if (!session || !session.items) return '';
  const refs = Object.entries(session.items)
    .filter(([id, item]) => ID.test(id) && item && positive(item.version))
    .sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
  if (!refs.length) return '';
  const key = refs.map(([id, item]) => `${id}@${item.version}`).join(',');
  const count = session.notice && session.notice.key === key ? Number(session.notice.count) || 0 : 0;
  if (count >= MAX_NOTICES) return '';
  session.notice = { key, count: count + 1 };
  // Keep the age clock on the last save, not on the reminder.
  writeLedger(data, env, nowMs);
  const shown = refs.slice(0, SHOWN).map(([id, item]) => `${id}@${item.version}`).join('、');
  const rest = refs.length > SHOWN ? ` ほか ${refs.length - SHOWN} 件` : '';
  return `検索カードがまだ無い記憶 ${refs.length} 件: ${shown}${rest}。本文は書き直さず、search_card（本文の主張だけ）で各 1 回書く。改訂で要約を渡さなかった版は、get で search_card の状態を確かめてから書く。`;
}

module.exports = { ledgerPath, cardChanges, recordToolResult, pendingCardStopNotice, MAX_NOTICES, SHOWN };
