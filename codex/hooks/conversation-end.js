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
  '記憶は 1 主題 1 件で書く（GEN-711）: 配備報告・レビュー・残件対応のように複数の主題を 1 件にまとめると、どの主題の質問でも本文の要点が薄まり検索で見つからない（例: GEN-629 / GEN-661 型）。主題ごとに記憶を分け、配備や作業の記録は短い 1 件にして relates_to で束ねる。既にある記憶へ主題を足すときも同じ。',
  '継続要望（GEN-670）: 本人がこのテーマで次からも続けてほしいと言った要望（回答の言語・長さ・形式など）があったターンは、remember の refs.continuing_request（contract priors.continuing-request.v1・key・action set|withdraw・summary・source {type user_utterance, quote}・変えるときは previous）で保存し、ID・版か failed を記録する。skip だけでは済ませたことにしない。引用・第三者の発言・今回だけの依頼は保存しない。',
  healthLine,
].join('\n') } }));
