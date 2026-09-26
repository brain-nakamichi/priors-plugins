'use strict';
const fs = require('node:fs');
const { hashPrompt, recordDecision } = require('./decision-audit.js');
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* use empty input */ }
const promptHash = typeof input.prompt === 'string' ? hashPrompt(input.prompt) : undefined;
try { recordDecision({ decision: 'pending', client: 'codex', source: 'hook', phase: 'turn-start', promptHash }); } catch { /* hooks never block a turn */ }
process.stdout.write(JSON.stringify({ systemMessage: 'Priors: この入力で Recall / Remember候補が必要か判定してください。', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Priors判定（毎回）: use-read / write-candidate / skip を --phase turn-start で記録する。' } }));
