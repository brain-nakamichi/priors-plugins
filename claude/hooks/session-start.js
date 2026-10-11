#!/usr/bin/env node
'use strict';

/** SessionStart is discovery-only: it does not read configuration, credentials, MCP, or memory. */
const message = 'Priorsで過去の決定・経緯・制約を検索し、必要な記憶を個別読取・関係探索できます。使うか、機能をどう組み合わせるかはAIが問いごとに判断し、使わない選択も有効です。';
const systemMessage = 'Priors: 必要なときにAIが利用を選びます（自動読取なし）';

try {
  process.stdout.write(JSON.stringify({
    systemMessage,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
  }));
} catch { /* Hooks must never interrupt the conversation. */ }
