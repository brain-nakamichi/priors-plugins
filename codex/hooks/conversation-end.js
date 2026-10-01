'use strict';
const fs = require('node:fs');
const { lastAuditEvent, auditHealth } = require('./decision-audit.js');
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* use empty input */ }
const last = lastAuditEvent();
const endRecorded = last?.source === 'explicit' && last.phase === 'conversation-end' && ['use-read', 'write-candidate', 'skip'].includes(last.decision);
if (input.stop_hook_active === true || endRecorded) process.exit(0);
const health = auditHealth();
const healthLine = health.pending_turn_starts > 0 || health.invalid_lines > 0
  ? `監査ログ診断: 未確定turn-start ${health.pending_turn_starts}件、壊れた行 ${health.invalid_lines}件。警告のみ。` : '';
process.stdout.write(JSON.stringify({ systemMessage: 'Priors: 会話終了時に「次の会話で役立つか」で保存要否を判定してください。', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: [
  'Priors終了時判定（必須）: 質問・要望とこの応答を合わせて「次の会話で覚えていると役立つか」を点検し、役立つなら「記憶して」を待たずに保存する（未決定の相談・比較案・仮説も対象。長期は remember、今回だけの途中経過は working_cache_write）。要旨は「求めたこと／AIの提案・判断／未決定の点／再開の手がかり」で、提案を決定として書かない。',
  'use-read / write-candidate / skip を選び、record-decision.js --phase conversation-end で記録する。保存したときは成功応答の ID・版を確認して --save-result recorded --saved <id@version,...> を添える。失敗は failed、不要は not_needed。',
  'write-candidate の場合も、この hook 自体は書込を行わず、次の応答で guard を実行する。',
  healthLine,
].join('\n') } }));
