#!/usr/bin/env node
'use strict';

const TURN_GUIDANCE = 'Priors: 継続指示・重要な決定や制約・未完了の約束・重大な運用結果・重要な訂正など、保持基準に合う情報は明示依頼を待たず認可された Remember で保存してください。過去情報が今回の回答や重要操作を左右し、現在の文脈に不足する場合は、依存する前に必要な範囲を Recall してください。無関係なターンの検索や固定手順は不要です。';

function buildPromptOutput() {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: TURN_GUIDANCE,
    },
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(buildPromptOutput()) + '\n');
}

module.exports = { buildPromptOutput };
