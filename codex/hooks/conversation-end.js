#!/usr/bin/env node
'use strict';

const STOP_GUIDANCE = 'Priors: 保持基準に合う重要な利用者指示・決定・制約・未完了の約束・重要な訂正は、明示依頼を待たず認可された Remember で保存してください。過去情報が今回の回答や重要操作を左右し、現在の文脈に不足する場合は、必要な範囲を Recall してください。';

function buildStopOutput() {
  // Stop supports systemMessage as a non-blocking UI advisory. Do not return
  // decision:block: that would force an additional model continuation.
  return { systemMessage: STOP_GUIDANCE };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(buildStopOutput()) + '\n');
}

module.exports = { buildStopOutput };
