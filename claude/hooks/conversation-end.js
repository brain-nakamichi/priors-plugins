#!/usr/bin/env node
/** Claude end-of-turn reminder. It records no conversation text and never
 * writes to Priors; it only requires an explicit local decision before the
 * assistant considers the turn complete.
 */
'use strict';

const { lastAuditEvent, recordStopInvocation } = require('./decision-audit.js');

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
  process.stdout.write(JSON.stringify({
    systemMessage: 'Priors: 会話終了時の判定を行ってください（use-read / write-candidate / skip）。',
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: [
        'Priors終了時判定（必須）: この会話で残すべき確定事項があるか判断する。',
        'use-read / write-candidate / skip のいずれかを選び、record-decision.js --phase conversation-end でローカル監査ログへ記録する。',
        'write-candidate の場合だけ、次回応答で context_open → recall → guard → remember/amend を実行する。',
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
