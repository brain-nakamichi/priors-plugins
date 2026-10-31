'use strict';
// Metadata only. Never accepts a prompt, transcript, title, body, or tool payload.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^(?:[A-Z][A-Z0-9]{1,7}-(?:c|w)?[0-9]+|[0-9a-f-]{36})@[1-9][0-9]{0,9}$/i;
const CANDIDATE = /^pc-[0-9a-f]{12}(?:-[0-9a-f]{8})?-[a-z-]{1,120}$/;
const CATEGORIES = ['remember-candidate','continuing-request-candidate','unresolved-candidate','work-item-candidate'];
const LIMIT = 256, MAX_BYTES = 262144, TTL = 7 * 86400000;
function statePath(client, env) {
  const override=client==='codex'?env.PRIORS_CODEX_HOOK_STATE_FILE:env.PRIORS_DECISION_AUDIT_FILE;
  if(override)return path.resolve(override)+'.compact.json';
  return path.join(env.PLUGIN_DATA || path.join(os.homedir(), '.priors', client), 'compact-checkpoint.json');
}
function empty(at) { return { start: at, candidates: [], saves: [], overflow: 0 }; }
function keys(x, allowed) { return x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).every(k=>allowed.includes(k)); }
function validPeriod(p) {
  return keys(p,['start','end','candidates','saves','overflow']) && Number.isFinite(p.start) && Number.isInteger(p.overflow) && p.overflow >= 0 &&
    Array.isArray(p.candidates) && p.candidates.length <= LIMIT && p.candidates.every(c =>
      keys(c,['id','at','categories']) && CANDIDATE.test(c.id) && Number.isFinite(c.at) && Array.isArray(c.categories) && c.categories.every(k => CATEGORIES.includes(k))) &&
    Array.isArray(p.saves) && p.saves.length <= LIMIT && p.saves.every(s => keys(s,['id','at']) && REF.test(s.id) && Number.isFinite(s.at));
}
function validState(s) {
  return keys(s,['schema','sessions']) && s.schema === 1 && Array.isArray(s.sessions) && s.sessions.length <= 16 && s.sessions.every(x =>
    keys(x,['session','at','active','pending']) && UUID.test(x.session) && Number.isFinite(x.at) && validPeriod(x.active) &&
    (x.pending === null || validPeriod(x.pending) && Number.isFinite(x.pending.end)));
}
function change(client, session, env, action, now = Date.now()) {
  if (!['claude','codex'].includes(client) || !UUID.test(session || '')) return null;
  const file = statePath(client, env), lock = file + '.lock', tmp = file + '.' + crypto.randomBytes(6).toString('hex'); let held = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.mkdirSync(lock); held = true;
    let state = { schema: 1, sessions: [] };
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return null;
      state = JSON.parse(fs.readFileSync(file, 'utf8')); if (!validState(state)) return null;
    }
    state.sessions = state.sessions.filter(s => s.at > now - TTL && s.at <= now);
    let s = state.sessions.find(s => s.session === session);
    if (!s) { if (state.sessions.length === 16) return null; s = { session, at: now, active: empty(now), pending: null }; state.sessions.push(s); }
    s.at = now; const result = action(s, now);
    const text = JSON.stringify(state); if (!validState(state) || Buffer.byteLength(text) > MAX_BYTES) return null;
    fs.writeFileSync(tmp, text + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file);
    return result;
  } catch { return null; } finally { try { fs.unlinkSync(tmp); } catch {} if (held) try { fs.rmdirSync(lock); } catch {} }
}
function recordCandidate(client, session, candidate, env = process.env) {
  if (!CANDIDATE.test(candidate?.id || '') || !Array.isArray(candidate.categories)) return null;
  const categories = [...new Set(candidate.categories.filter(k => CATEGORIES.includes(k)))]; if (!categories.length) return null;
  return change(client, session, env, (s, at) => {
    if (s.active.candidates.some(c => c.id === candidate.id)) return;
    if (s.active.candidates.length === LIMIT) { s.active.overflow++; return; }
    s.active.candidates.push({ id: candidate.id, categories, at });
  });
}
function recordSave(client, session, ids, acknowledged = [], env = process.env) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every(id => REF.test(id))) return null;
  return change(client, session, env, (s, at) => {
    for (const p of [s.active, s.pending].filter(Boolean)) p.candidates = p.candidates.filter(c => !acknowledged.includes(c.id));
    for (const id of ids) if (!s.active.saves.some(r => r.id === id)) {
      if (s.active.saves.length === LIMIT) s.active.overflow++; else s.active.saves.push({ id, at });
    }
  });
}
function preCompact(client, session, env = process.env, pendingIds) {
  return change(client, session, env, (s, at) => {
    if(Array.isArray(pendingIds))for(const p of [s.active,s.pending].filter(Boolean))p.candidates=p.candidates.filter(c=>pendingIds.includes(c.id));
    // Repeated/cancelled PreCompact must not discard an undelivered interval.
    if (s.pending) {
      for (const key of ['candidates','saves']) {
        for (const item of s.active[key]) if (!s.pending[key].some(x => x.id === item.id)) {
          if (s.pending[key].length < LIMIT) s.pending[key].push(item); else s.pending.overflow++;
        }
      }
      s.pending.overflow += s.active.overflow; s.pending.end = at;
    } else s.pending = { ...s.active, end: at };
    s.active = empty(at);
  });
}
function afterCompact(client, session, env = process.env) {
  return change(client, session, env, s => {
    const p = s.pending; if (!p) return null;
    s.pending = null; // At most once. A crash after commit may lose a notice, never force another turn.
    if (!p.candidates.length && !p.saves.length && !p.overflow) return null;
    const categories = [...new Set(p.candidates.flatMap(c => c.categories))].join(' / ');
    const refs = p.saves.slice(0, 12).map(s => s.id).join(', ');
    return `Priors: コンパクト前の期間に未確認候補 ${p.candidates.length} 件${categories ? `（${categories}）` : ''}、保存 ${p.saves.length} 件${refs ? `（${refs}${p.saves.length > 12 ? '、ほか' : ''}）` : ''}。${p.overflow ? '記録上限による省略あり。' : ''}\n要約にある決定・約束・未完了で保存が無く、保持基準に合うものは保存を検討できます。必要なら記憶担当へ、要約から抽出した事実・保存ID@版・触ったサブテーマ項目だけを渡して簡易点検を依頼できます。会話原文は渡さず、保存や起動は自動で行いません。`;
  });
}
module.exports = { recordCandidate, recordSave, preCompact, afterCompact, statePath, LIMIT, MAX_BYTES };
