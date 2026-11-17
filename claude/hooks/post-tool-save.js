#!/usr/bin/env node
'use strict';
const { readHookInput } = require('./bounded-input.js');
const { recordDecision, validSession, activeTurnId, SAVE_TOOLS, SUBTHEME_SAVE_TOOLS } = require('./decision-audit.js');
const { candidateReceiptForSave, acknowledgeProactiveCandidateIds } = require('./proactive-candidates.js');
const {parseSavedResponse}=require('./save-response.js');
const {pendingCardNotice}=require('./pending-card-notice.js');
function parseSaveResponse(input) {
 if(!validSession(input?.session_id)||input.hook_event_name!=='PostToolUse')return null;
 return parseSavedResponse(input.tool_name,input.tool_response);
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
    // a subagent's save still settles candidates as before; only the compact period record leaves it out
    fromSubagent: Boolean(input?.agent_id || input?.agent_type),
    save: { outcome: 'recorded', ids: parsed.ids, tool: parsed.name, ...(candidateReceipts.length ? { candidate_receipts: candidateReceipts } : {}) },
  };
}
// Resolve the candidates whose server receipt was already validated against this turn.
// Doing it here, not only at Stop, keeps the receipt when another prompt (for example a
// background agent's report) starts a new turn before Stop runs and replaces the turn state.
function recordSaveObservation(observation, env = process.env) {
  recordDecision({ decision: 'write-candidate', client: 'claude', source: 'hook', invocationKind: 'client-hook', phase: 'tool-save', sessionId: observation.sessionId, turnId: observation.turnId, save: observation.save }, env);
  const ids = (observation.save.candidate_receipts || []).map((receipt) => receipt.candidate_id);
  if (!observation.fromSubagent) require('./compact-checkpoint.js').recordSave('claude', observation.sessionId, observation.save.ids, ids, env);
  return ids.length ? acknowledgeProactiveCandidateIds(ids, 'write-candidate', env) : 0;
}
function main() {
  try {
    const read = readHookInput(0, false);
    if (!read.ok || !validSession(read.input?.session_id) || read.input.hook_event_name !== 'PostToolUse') return;
    // GEN-2374 (A): keep the per-conversation list of memories that still need a search card. Best effort;
    // a failure here must never change the save audit or its message.
    try { require('./pending-card-ledger.js').recordToolResult(read.input.session_id, read.input.tool_name, read.input.tool_input, read.input.tool_response); } catch { /* list is advisory */ }
    const observation = postToolSaveObservation(read.input);
    const notice = pendingCardNotice(read.input.tool_name, read.input.tool_response);
    // maintain is guidance-only: do not expand the existing save audit's tool contract.
    if (!observation) {
      if (notice) process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:notice}}));
      return;
    }
    recordSaveObservation(observation);
    process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'Priors: 成功応答の保存ID・版をローカル監査に記録しました。CLIでの追加記録は不要です。保存済みと報告できるのは、Priorsの成功応答で確認したID・版だけです。'+notice}}));
  } catch { process.stdout.write(JSON.stringify({systemMessage:'Priors: 保存観測を記録できません。終端では従来どおりIDと版を明示してください。'})); }
}
if (require.main === module) main();
module.exports = { savedRefs, parseSaveResponse, postToolSaveObservation, recordSaveObservation };
