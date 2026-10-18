#!/usr/bin/env node
'use strict';

/** Read-free discovery hook. Every Priors read and write is chosen by AI per task. */
function emit(additionalContext, systemMessage) {
  // Exit as soon as the output is flushed: an aborted update check can leave a socket
  // connecting for ~10 s (undici connect timeout), which would hold the hook process open.
  process.stdout.write(JSON.stringify({
    systemMessage,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  }), () => process.exit(0));
}

async function main() {
  const message = 'Priorsで過去の決定・経緯・制約を検索し、必要な記憶を個別読取・関係探索できます。使うか、機能をどう組み合わせるかはAIが問いごとに判断し、使わない選択も有効です。';
  const systemMessage = 'Priors: 必要なときにAIが利用を選びます（自動読取なし）';
  // A read-only GitHub check for a newer published plugin (no memory, token or MCP access).
  // At most once a day per version; any failure stays silent.
  let notice = null;
  try { notice = await require('./plugin-update-check.js').checkPluginUpdate(process.env); } catch { /* silent */ }
  emit(notice ? `${message}\n${notice}` : message, notice ? `${systemMessage}\n${notice}` : systemMessage);
}

if (process.argv.includes('--selftest')) {
  process.stdout.write('Priors SessionStart is discovery-only; it does not read memory or connect to MCP.\n');
} else {
  // Hooks must never fail the session: any error ends silently with exit 0.
  main().catch(() => process.exit(0));
}
