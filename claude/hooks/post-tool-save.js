#!/usr/bin/env node
'use strict';
const { readHookInput } = require('./bounded-input.js');
const { recordDecision, validSession } = require('./decision-audit.js');
const TOOLS = new Set(['remember','amend','capture','work_create','work_event']);
function savedRefs(input) {
  if (!validSession(input?.session_id) || input.hook_event_name !== 'PostToolUse') return null;
  const name = typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__priors__') ? input.tool_name.slice(13) : '';
  if (!TOOLS.has(name)) return null;
  let response = input.tool_response;
  if (!response || typeof response !== 'object' || response.isError === true) return null;
  if (Array.isArray(response)) response = { content: response };
  if (response.structuredContent) response = response.structuredContent;
  else if (Array.isArray(response.content)) {
    const text = response.content.filter((item) => item.type === 'text');
    if (text.length !== 1 || typeof text[0].text !== 'string') return null;
    try { response = JSON.parse(text[0].text); } catch { return null; }
  }
  if (!response || !(response.operation === name || name === 'amend' && /^amend\.(revise|supersede|dispute)$/.test(response.operation)) || !(response.outcome_code === 'recorded' || ['capture','amend'].includes(name) && response.outcome_code === 'applied') || !Array.isArray(response.resource_ids) || !response.resource_ids.length || response.resource_ids.length > 20) return null;
  const ids = [];
  for (const ref of response.resource_ids) {
    if (!ref || !['primary','created','updated'].includes(ref.role) || typeof ref.id !== 'string' || !/^[A-Z][A-Z0-9]{1,7}-(?:c|w)?[0-9]+$/.test(ref.id) || !Number.isSafeInteger(ref.version) || ref.version <= 0) return null;
    if (name === 'capture' && (!Array.isArray(response.items) || !response.items.some((item) => item.outcome_code === 'recorded' && item.id === ref.id && item.version === ref.version))) return null;
    ids.push(ref.id + '@' + ref.version);
  }
  return [...new Set(ids)];
}
function main() {
  try {
    const read = readHookInput(0, false); const ids = read.ok && savedRefs(read.input);
    if (!ids) return;
    recordDecision({ decision: 'write-candidate', client: 'claude', source: 'hook', phase: 'tool-save', sessionId: read.input.session_id, save: { outcome: 'recorded', ids } });
    process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'Priors: 保存IDを監査へ観測しました。終端判断は未実施です。終端CLIで --client claude --session-id ' + read.input.session_id + ' --phase conversation-end --decision write-candidate --save-result recorded を使うと、このターンの観測IDを利用できます。'}}));
  } catch { process.stdout.write(JSON.stringify({systemMessage:'Priors: 保存観測を記録できません。終端では従来どおりIDと版を明示してください。'})); }
}
if (require.main === module) main();
module.exports = { savedRefs };
