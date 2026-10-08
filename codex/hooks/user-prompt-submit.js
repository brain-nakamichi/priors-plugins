'use strict';
const { hashPrompt, recordDecision } = require('./decision-audit.js');
let read; let inspection; let guidance = ''; let reported = false;
try {
  read = require('./bounded-input.js').readHookInput();
  const safety = require('./sensitive-input.js');
  inspection = read.ok ? safety.inspectSensitiveInput(read.input.prompt) : null;
  reported = inspection?.state === 'clear' && safety.hasDisclosureReport(read.input.prompt);
  if (!inspection || inspection.suppress_auto_recall) guidance = safety.sensitiveGuidance(inspection?.state);
  else if (reported) guidance = safety.sensitiveGuidance('reported');
} catch { guidance = 'Priors: 入力を検査できないため本文由来のhashと候補は保存しません。値を含まない要旨で必要なworkを確認してください。'; }
const promptHash = inspection?.state === 'clear' ? hashPrompt(read.input.prompt) : undefined;
try { recordDecision({ decision: 'pending', client: 'codex', source: 'hook', phase: 'turn-start', promptHash, inputSafety: inspection?.state === 'clear' ? (reported ? 'reported' : undefined) : (inspection?.state === 'suspected' ? 'suspected' : 'uninspectable') }); } catch { /* hooks never block a turn */ }
// This hook remains unregistered: Codex's ordinary route is the explicit SKILL.
process.stdout.write(JSON.stringify({ systemMessage: 'Priors: この入力で Recall / Remember候補が必要か判定してください。', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: guidance + ' Priors判定（毎回）: use-read / write-candidate / skip を --phase turn-start で記録する。本人が「次から」「今後は」「毎回」など、このテーマで続けてほしい要望を言ったら、この回答から従い、作業の終わりまで延ばさず guard → remember（refs.continuing_request）で保存する。' } }));
