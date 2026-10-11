#!/usr/bin/env node
'use strict';

/** Read-free discovery hook. Every Priors read and write is chosen by AI per task. */
function emit(additionalContext, systemMessage) {
  process.stdout.write(JSON.stringify({
    systemMessage,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  }));
}

if (process.argv.includes('--selftest')) {
  process.stdout.write('Priors SessionStart is discovery-only; it does not read memory or connect to MCP.\n');
} else {
  const message = 'Priorsで過去の決定・経緯・制約を検索し、必要な記憶を個別読取・関係探索できます。使うか、機能をどう組み合わせるかはAIが問いごとに判断し、使わない選択も有効です。';
  emit(message, 'Priors: 必要なときにAIが利用を選びます（自動読取なし）');
}
