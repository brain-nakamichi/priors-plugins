#!/usr/bin/env node
/** Claude end-of-turn helper. It records no conversation text and never
 * writes to Priors; any candidate guidance is optional.
 */
'use strict';

const { recordStopInvocation, auditHealth, inputSafetySummary, inputSafetyGuidance, currentTurnAudit } = require('./decision-audit.js');
const {
  summarizeProactiveCandidates,
  materializeRememberCandidate,
  pendingRememberCandidates,
  materializeWorkItemCandidate,
  pendingWorkItemCandidates,
  materializeCheckpointCandidate,
  pendingCheckpointCandidates,
  acknowledgeProactiveCandidateIds,
  acknowledgeProactiveCandidates,
  candidateReceiptForSave,
} = require('./proactive-candidates.js');

function candidateGuidance(summary) {
  const steps = [];
  if (summary.categories['recall-likely'] > 0) steps.push('Recall候補は手掛かりとして扱い、過去情報が今回を左右し最新文脈に不足する場合は、必要な読取機能を選んで取得する（固定順序なし）');
  if (summary.categories['remember-candidate'] > 0) steps.push('Remember候補は手掛かりとして扱い、保持基準に合う重要情報は出所を確認して保存する（書込時はguardと認可を満たす）');
  if (summary.categories['unresolved-candidate'] > 0) steps.push('未解決候補は、引継ぎが役立つ場合だけ checkpoint 等で残せる');
  if (summary.categories['work-item-candidate'] > 0) steps.push('作業台帳候補は、継続管理が役立つ場合だけ brief で確認でき、曖昧な候補は自動選択しない');
  return steps.length > 0 ? `候補の兆候: ${steps.join('。')}。候補検出は網羅性の証明ではない。` : '';
}

function reminderPayload({ pendingCandidateCount, safetyGuidance = '', invalidLines = 0, invalidLinesChanged = false }) {
  const lines = [];
  if (pendingCandidateCount > 0) lines.push(`未処理候補 ${pendingCandidateCount} 件。今回に関係し保持基準に合うものだけ確認し、保存した場合は成功応答のID・版を確かめてください。`);
  if (safetyGuidance) lines.push(safetyGuidance);
  if (invalidLinesChanged && invalidLines > 0) lines.push(`ローカル監査ログの形式不正行が ${invalidLines} 件あります（状態が変わった時だけ通知）。`);
  if (lines.length === 0) return null;
  return {
    systemMessage: 'Priors: 未処理の確認事項がある場合だけ確認してください。',
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: lines.join('\n') },
  };
}

function main() {
try {
  const input = (() => {
    try { return JSON.parse(require('node:fs').readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
  })();
  // Claude may invoke Stop again while continuing after a hook. Do not emit
  // another reminder in that re-entrant path.
  const safetyGuidance = inputSafetyGuidance(inputSafetySummary());
  if (input.stop_hook_active === true) process.exit(0);
  // Autonomous Remember mode is the default. Setting the variable to 0 keeps
  // the legacy candidate-queue behavior; neither mode forces a write.
  const autonomousRemember = process.env.PRIORS_AUTO_REMEMBER !== '0';
  // Generate one session-scoped Remember candidate from the pending local
  // signals.  This stores hashes/provenance only and never auto-confirms it.
  if (!autonomousRemember) {
    try { materializeRememberCandidate(); } catch { /* candidate generation is best effort */ }
    try { materializeWorkItemCandidate(); } catch { /* candidate generation is best effort */ }
    try { materializeCheckpointCandidate(); } catch { /* candidate generation is best effort */ }
  }
  const candidateSummary = summarizeProactiveCandidates();
  const health = auditHealth();
  let turnState = currentTurnAudit(input.session_id, 'claude');
  let acknowledgedDecisionCandidates = false;
  // An explicit decision resolves only heuristic candidates attached to this
  // exact prompt turn. A legacy/unscoped queue is intentionally preserved.
  if (turnState.turn_id && turnState.decision?.decision === 'skip') {
    acknowledgedDecisionCandidates = acknowledgeProactiveCandidates(turnState.decision.decision, process.env, turnState.turn_id) > 0;
  }
  // Only IDs explicitly bound to this same prompt turn by PostToolUse can
  // resolve candidate records. A session-level save never clears older work.
  let acknowledgedSaveCandidates = false;
  for (const save of turnState.saves || []) {
    const receipts = candidateReceiptForSave(turnState.turn_id, save.save?.tool, save.save?.candidate_receipts, save.save?.ids);
    if (receipts.length) {
      acknowledgedSaveCandidates = acknowledgeProactiveCandidateIds(receipts.map((receipt) => receipt.candidate_id), 'write-candidate') > 0 || acknowledgedSaveCandidates;
    }
  }
  const refreshedSummary = acknowledgedDecisionCandidates || acknowledgedSaveCandidates
    ? summarizeProactiveCandidates()
    : candidateSummary;
  const rememberReady = pendingRememberCandidates().length;
  const workReady = pendingWorkItemCandidates().length;
  const checkpointReady = pendingCheckpointCandidates().length;
  const pendingCandidateCount = refreshedSummary.total + rememberReady + workReady + checkpointReady;
  // Persist only a numeric diagnostic state; do not log hook input or prompt.
  let invalidLinesChanged = false;
  try { invalidLinesChanged = recordStopInvocation({ stopHookActive: false, invalidLines: health.invalid_lines }).invalidLinesChanged; } catch { /* diagnostics are best effort */ }
  // UserPromptSubmit already provides the policy each turn. Stop is a
  // backstop only when there is an actionable candidate or safety issue.
  const output = reminderPayload({ pendingCandidateCount, safetyGuidance, invalidLines: health.invalid_lines, invalidLinesChanged });
  if (!output) process.exit(0);
  process.stdout.write(JSON.stringify(output));
} catch {
  // An inspection failure must not create an unconditional empty turn.
  process.exit(0);
}
}

if (require.main === module) main();
module.exports = { reminderPayload, candidateGuidance };
