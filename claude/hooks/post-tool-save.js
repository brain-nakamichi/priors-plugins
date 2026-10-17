#!/usr/bin/env node
'use strict';
const { readHookInput } = require('./bounded-input.js');
const { recordDecision, validSession, activeTurnId } = require('./decision-audit.js');
const { candidateReceiptForSave } = require('./proactive-candidates.js');
const TOOLS = new Set(['remember','amend','capture','work_create','work_event']);
function parseSaveResponse(input) {
  if (!validSession(input?.session_id) || input.hook_event_name !== 'PostToolUse') return null;
  const name = typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__priors__') ? input.tool_name.slice(13) : '';
  if (!TOOLS.has(name)) return null;
  let response = input.tool_response;
  if (!response || typeof response !== 'object' || response.isError === true) return null;
  if (Array.isArray(response)) response = { content: response };
  if (response.structuredContent) response = response.structuredContent;
  else if (Array.isArray(response.content)) {
    const text = response.content.filter((item) => item.type === 'text');
    if (text.length !== 1 || typeof text[0].text !== 'string') return null;
    try { response = JSON.parse(text[0].text); } catch { return null; }
  }
  if (!response || response.replayed === true || response.__server_replayed === true) return null;
  if (!response || !(response.operation === name || name === 'amend' && /^amend\.(revise|supersede|dispute)$/.test(response.operation)) || !(response.outcome_code === 'recorded' || ['capture','amend'].includes(name) && response.outcome_code === 'applied') || !Array.isArray(response.resource_ids) || !response.resource_ids.length || response.resource_ids.length > 20) return null;
  const ids = [];
  for (const ref of response.resource_ids) {
    if (!ref || typeof ref.id !== 'string' || !/^[A-Z][A-Z0-9]{1,7}-(?:c|w)?[0-9]+$/.test(ref.id)) return null;
    if (['primary','created','updated'].includes(ref.role)) {
      if (!Number.isSafeInteger(ref.version) || ref.version <= 0) return null;
    } else if (!(name === 'amend' && ['superseded','disputed'].includes(ref.role)
      && (ref.version === undefined || Number.isSafeInteger(ref.version) && ref.version > 0))) return null;
    if (!['primary','created','updated'].includes(ref.role)) continue;
    if (name === 'capture' && (!Array.isArray(response.items) || !response.items.some((item) => item.outcome_code === 'recorded' && item.id === ref.id && item.version === ref.version))) return null;
    ids.push(ref.id + '@' + ref.version);
  }
  return { name, response, ids: [...new Set(ids)] };
}
function savedRefs(input) {
  return parseSaveResponse(input)?.ids || null;
}
function postToolSaveObservation(input, env = process.env) {
  const parsed = parseSaveResponse(input);
  if (!parsed) return null;
  const requestedCandidateId = input?.tool_input && typeof input.tool_input === 'object'
    ? input.tool_input.candidate_id : undefined;
  const responseReceipts = parsed.response.candidate_receipts;
  const matchedReceipts = Array.isArray(responseReceipts) && typeof requestedCandidateId === 'string'
    ? responseReceipts.filter((receipt) => receipt?.candidate_id === requestedCandidateId) : [];
  const turnId = activeTurnId(input.session_id, 'claude', env);
  const candidateReceipts = turnId
    ? candidateReceiptForSave(turnId, parsed.name, matchedReceipts, parsed.ids, env)
    : [];
  return {
    sessionId: input.session_id,
    turnId,
    save: { outcome: 'recorded', ids: parsed.ids, tool: parsed.name, ...(candidateReceipts.length ? { candidate_receipts: candidateReceipts } : {}) },
  };
}
function main() {
  try {
    const read = readHookInput(0, false); const observation = read.ok && postToolSaveObservation(read.input);
    if (!observation) return;
    recordDecision({ decision: 'write-candidate', client: 'claude', source: 'hook', invocationKind: 'client-hook', phase: 'tool-save', sessionId: observation.sessionId, turnId: observation.turnId, save: observation.save });
    process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'Priors: 成功応答の保存ID・版をローカル監査に記録しました。CLIでの追加記録は不要です。保存済みと報告できるのは、Priorsの成功応答で確認したID・版だけです。'}}));
  } catch { process.stdout.write(JSON.stringify({systemMessage:'Priors: 保存観測を記録できません。終端では従来どおりIDと版を明示してください。'})); }
}
if (require.main === module) main();
module.exports = { savedRefs, parseSaveResponse, postToolSaveObservation };
