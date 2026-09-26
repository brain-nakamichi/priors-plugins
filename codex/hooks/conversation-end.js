'use strict';
const fs = require('node:fs');
const { lastAuditEvent } = require('./decision-audit.js');
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* use empty input */ }
const last = lastAuditEvent();
const endRecorded = last?.source === 'explicit' && last.phase === 'conversation-end' && ['use-read', 'write-candidate', 'skip'].includes(last.decision);
if (input.stop_hook_active === true || endRecorded) process.exit(0);
process.stdout.write(JSON.stringify({ systemMessage: 'Priors: 会話終了時の Remember 要否を判定してください。', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: [
  'Priors終了時判定（必須）: use-read / write-candidate / skip を選ぶ。',
  'record-decision.js --phase conversation-end でローカル監査ログへ記録する。',
  'write-candidate の場合も、この hook 自体は書込を行わず、次の応答で guard を実行する。',
].join('\n') } }));
