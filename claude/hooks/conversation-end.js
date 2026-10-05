#!/usr/bin/env node
/** Claude end-of-turn reminder. It records no conversation text and never
 * writes to Priors; it only requires an explicit local decision before the
 * assistant considers the turn complete.
 */
'use strict';

const { lastAuditEvent, recordStopInvocation, auditHealth } = require('./decision-audit.js');
const {
  summarizeProactiveCandidates,
  materializeRememberCandidate,
  pendingRememberCandidates,
  materializeWorkItemCandidate,
  pendingWorkItemCandidates,
  materializeCheckpointCandidate,
  pendingCheckpointCandidates,
} = require('./proactive-candidates.js');

function candidateGuidance(summary) {
  const steps = [];
  if (summary.high_confidence > 0) steps.push('高確度候補を先に確認');
  if (summary.categories['recall-likely'] > 0) steps.push('Recall候補: context_open → recall');
  if (summary.categories['remember-candidate'] > 0) steps.push('Remember候補: 出所確認 → guard → remember/amend');
  if (summary.categories['unresolved-candidate'] > 0) steps.push('未解決候補: checkpoint または問いの確認');
  if (summary.categories['work-item-candidate'] > 0) steps.push('作業台帳候補: briefで目的・完了条件が最も一致するworkを自動選択し、該当がなければwork_createを検討');
  return steps.length > 0 ? `候補別の次の確認: ${steps.join('、')}。` : '';
}

function explicitDecisionRecorded() {
  const event = lastAuditEvent();
  return event?.source === 'explicit'
    && event.phase === 'conversation-end'
    && ['use-read', 'write-candidate', 'skip'].includes(event.decision);
}

try {
  const input = (() => {
    try { return JSON.parse(require('node:fs').readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
  })();
  // Keep only a sanitized invocation counter. Never persist transcript, prompt,
  // token, or the complete hook input.
  try { recordStopInvocation({ stopHookActive: input.stop_hook_active === true }); } catch { /* diagnostics are best effort */ }
  // Claude may invoke Stop again while continuing after a hook. Do not emit
  // another reminder in that re-entrant path.
  if (input.stop_hook_active === true || explicitDecisionRecorded()) process.exit(0);
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
  const rememberReady = pendingRememberCandidates().length;
  const workReady = pendingWorkItemCandidates().length;
  const checkpointReady = pendingCheckpointCandidates().length;
  process.stdout.write(JSON.stringify({
    systemMessage: autonomousRemember
      ? 'Priors: 自律Rememberモード。次の会話で役立つ内容（相談・比較案・仮説・未決定を含む）を保存し、成功応答の ID・版を確認して記録します。'
      : 'Priors: 会話終了時の判定を行ってください（use-read / write-candidate / skip）。',
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: [
        autonomousRemember
          ? 'Priors自律Remember（必須）: 質問・要望とこの応答を合わせて「次の会話で覚えていると役立つか」を点検し、役立つなら「記憶して」を待たずに context_open → recall → guard → remember/amend（長期）または working_cache_write（今回だけの途中経過）で保存する。未決定の相談・比較案・仮説も対象。要旨は「求めたこと／AIの提案・判断／未決定の点／再開の手がかり」で、提案を決定として書かない。Tier Aのプログラム修正記憶を省略しない。'
          : 'Priors終了時判定（必須）: この会話で残すべき確定事項があるか判断する。',
        'use-read / write-candidate / skip のいずれかを選び、record-decision.js --phase conversation-end でローカル監査ログへ記録する。保存したときは成功応答の ID・版を確認してから --save-result recorded --saved <id@version,...> を添える。失敗は --save-result failed として残し本来の回答は続ける。保存不要なら --save-result not_needed。「保存する」と記録しただけでは完了にしない。',
        'write-candidate の場合は、下記の候補別手順だけを確認し、該当しない操作を連鎖させない。',
        '継続要望（GEN-670）: 本人がこのテーマで次からも続けてほしいと言った要望（回答の言語・長さ・形式など）があったターンは、remember の refs.continuing_request で保存したか（ID・版）、保存に失敗したか（failed）を記録する。skip だけではその保存を済ませたことにしない。既に同じ要望がある・引用や今回限りの依頼なら保存しない。',
        candidateSummary.total > 0
          ? `本文を保存しない自動候補キューが ${candidateSummary.total} 件あります（高確度 ${candidateSummary.high_confidence} 件、Recall候補 ${candidateSummary.categories['recall-likely']} 件、Remember候補 ${candidateSummary.categories['remember-candidate']} 件、未解決候補 ${candidateSummary.categories['unresolved-candidate']} 件、作業台帳候補 ${candidateSummary.categories['work-item-candidate']} 件）。${rememberReady > 0 ? `会話終了Remember候補を ${rememberReady} 件生成しました。` : ''}${workReady > 0 ? `作業台帳候補を ${workReady} 件生成しました。` : ''}${checkpointReady > 0 ? `checkpoint候補を ${checkpointReady} 件生成しました。` : ''}出所と不確実性を確認し、必要な候補だけを通常手順で扱う。`
          : '自動候補キューは空です。未検出は不要の証明ではないため、再利用価値を短く点検する。',
        candidateGuidance(candidateSummary),
        (health.pending_turn_starts > 0 || health.invalid_lines > 0)
          ? `監査ログ診断: 未確定turn-start ${health.pending_turn_starts}件、壊れた行 ${health.invalid_lines}件。警告のみで会話やPriors書込は停止しない。`
          : '',
        '会話本文・token・接続情報は監査ログやPriors本文へ写さない。',
      ].join('\n'),
    },
  }));
} catch {
  // A reminder must never prevent the conversation from closing.
  process.stdout.write(JSON.stringify({
    systemMessage: 'Priors: 会話終了時の利用要否を判断してください（監査ログは保留）。',
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: 'Priors終了時判定（必須）: use-read / write-candidate / skip のいずれかを選ぶ。',
    },
  }));
}
