#!/usr/bin/env node
'use strict';

function buildStopOutput(input = {}) {
  if (input.stop_hook_active === true) return { continue: true };
  return {
    decision: 'block',
    reason: '会話終了前にPriorsを確認してください。今後に役立つ重要な利用者指示・決定や制約・却下案・未完了の約束・重大な運用結果・重要な訂正があれば、出所と認可を確認し、必要なguardを通して通常のRememberで保存してください。保存した場合は成功応答の記憶IDと版を確認してください。保存不要ならその判断で構いません。過去の決定や制約が今回の回答・重要操作を左右し、現在の文脈に不足する場合は必要な情報だけRecallしてください。毎ターン検索や固定のツール手順は不要です。'
  };
}

if (require.main === module) {
  const fs = require('node:fs');
  let output;
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    output = buildStopOutput(input);
  } catch {
    // Fail open when Codex provides malformed hook input.
    output = { continue: true };
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}

module.exports = { buildStopOutput };
