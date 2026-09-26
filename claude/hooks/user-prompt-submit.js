#!/usr/bin/env node
/** Claude UserPromptSubmit: every turn asks for a Priors use decision.
 * It never sends the prompt or a token to Priors. Only a SHA-256 and the
 * explicit decision recorded later by record-decision.js enter the local log.
 */
'use strict';

const fs = require('node:fs');
const { hashPrompt, recordDecision } = require('./decision-audit.js');

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

try {
  const input = readInput();
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const promptHash = hashPrompt(prompt);
  recordDecision({ decision: 'pending', client: 'claude', promptHash, source: 'hook', phase: 'turn-start' });
  const context = [
    'Priors判定（毎回）: このターンで Priors を使うか先に判断する。',
    '使うなら use-read（context_open → recall/get 等）または write-candidate（guard → remember/amend）。',
    '使わないなら skip。判断結果を record-decision.js --phase turn-start でローカル監査ログへ記録し、Priors本文には書かない。',
    '下見や会話本文を根拠に書込を自動実行せず、書込前の guard を省略しない。',
  ].join('\n');
  process.stdout.write(JSON.stringify({
    systemMessage: 'Priors: このターンの利用要否を判断し、結果をローカル監査ログへ記録してください',
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
} catch {
  // Hooks must not stop the conversation.
  process.stdout.write(JSON.stringify({
    systemMessage: 'Priors: 利用要否を判断してください（監査ログは保留）',
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Priors判定（毎回）: use-read / write-candidate / skip のいずれかを判断する。' },
  }));
}
