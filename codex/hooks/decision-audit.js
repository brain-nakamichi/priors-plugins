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
function recordDecision({ decision, client = 'codex', promptHash, source = 'explicit', phase = 'unknown', inputSafety }, env = process.env) {
  if (!DECISIONS.has(decision) || !PHASES.has(phase) || !['explicit', 'hook', 'explicit-safety'].includes(source)) throw new Error('invalid input');
  return append({ schema: 'priors.decision-audit.v1', recorded_at: new Date().toISOString(), decision, client, source, phase,
    ...(['suspected', 'uninspectable', 'reported'].includes(inputSafety) ? { input_safety: inputSafety, safety_notice_id: crypto.randomUUID() } : {}),
    ...(!['suspected', 'uninspectable'].includes(inputSafety) && typeof promptHash === 'string' && /^[0-9a-f]{64}$/.test(promptHash) ? { prompt_sha256: promptHash } : {}),
  }, env);
}
function lastAuditEvent(env = process.env) {
  try { const lines = fs.readFileSync(auditPath(env), 'utf8').trim().split(/\r?\n/).filter(Boolean); return lines.length ? JSON.parse(lines.at(-1)) : null; } catch { return null; }
}
function auditHealth(env = process.env, maxLines = 256) {
  let lines;
  try { lines = fs.readFileSync(auditPath(env), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-maxLines); }
  catch { return { events: 0, invalid_lines: 0, pending_turn_starts: 0, pending_conversation_end: 0 }; }
  let invalid_lines = 0; let events = 0; let pending_turn_starts = 0; let pending_conversation_end = 0;
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { invalid_lines++; continue; }
    if (!event || event.schema !== 'priors.decision-audit.v1' || !DECISIONS.has(event.decision) || !PHASES.has(event.phase)) { invalid_lines++; continue; }
    events++;
    if (event.decision === 'pending') {
      if (event.phase === 'turn-start') pending_turn_starts++;
      if (event.phase === 'conversation-end') pending_conversation_end++;
    } else if (event.source === 'explicit') {
      if (event.phase === 'turn-start' && pending_turn_starts > 0) pending_turn_starts--;
      if (event.phase === 'conversation-end' && pending_conversation_end > 0) pending_conversation_end--;
    }
  }
  return { events, invalid_lines, pending_turn_starts, pending_conversation_end };
}
function inputSafetySummary(env = process.env, client = 'codex') {
  const counts = { suspected: 0, uninspectable: 0, reported: 0 };
  try {
    const lines = fs.readFileSync(auditPath(env), 'utf8').trim().split(/\r?\n/).slice(-256);
    let ended = false;
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event?.schema !== 'priors.decision-audit.v1' || event.client !== client) continue;
      if (ended && event.phase === 'turn-start') { counts.suspected = counts.uninspectable = counts.reported = 0; ended = false; }
      if (Object.hasOwn(counts, event.input_safety)) counts[event.input_safety]++;
      if (event.phase === 'conversation-end' && event.source === 'explicit') ended = true;
    }
  } catch { /* no raw errors */ }
  return counts;
}
function inputSafetyGuidance(counts) {
  return counts.suspected + counts.uninspectable + counts.reported > 0
    ? `認証情報対応の確認: このターンの秘密疑い ${counts.suspected}件、検査不能 ${counts.uninspectable}件、露出申告 ${counts.reported}件。値を含まない作業項目があるか確認してください。同じ事象は既存workを再利用し、不要なら理由を残す。件数はローカルの印であり漏えい・保存不足の証明ではありません。`
    : '';
}
module.exports = { hashPrompt, recordDecision, lastAuditEvent, auditHealth, inputSafetySummary, inputSafetyGuidance };
