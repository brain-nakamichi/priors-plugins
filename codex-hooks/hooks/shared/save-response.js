'use strict';
// Canonical success parser. Projection only: no logging, candidate acknowledgement, or network.
const SUBTHEME_SAVE_TOOLS = ['subtheme_memory_add', 'subtheme_memory_append', 'subtheme_memory_revise', 'subtheme_memory_replace'];
const SAVE_TOOLS = ['remember', 'summary_record', 'amend', 'capture', 'work_create', 'work_event', ...SUBTHEME_SAVE_TOOLS];
const TOOLS = new Set(SAVE_TOOLS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBTHEME_ACTION = { subtheme_memory_add: 'write', subtheme_memory_append: 'append', subtheme_memory_revise: 'revise', subtheme_memory_replace: 'replace' };
// A subtheme memory write answers {contract: 1, action, item_id, version, ...}; its saved reference is "<item_id>@<version>".
function subthemeSavedRefs(name, response) {
  if (response.contract !== 1 || response.action !== SUBTHEME_ACTION[name] || !UUID.test(String(response.item_id))
    || !Number.isSafeInteger(response.version) || response.version <= 0) return null;
  return [`${response.item_id}@${response.version}`];
}
function parseSavedResponse(toolName, toolResponse) {
  const name = typeof toolName === 'string' && toolName.startsWith('mcp__priors__') ? toolName.slice(13) : '';
  if (!TOOLS.has(name)) return null;
  let response = toolResponse;
  if (!response || typeof response !== 'object' || response.isError === true) return null;
  if (Array.isArray(response)) response = { content: response };
  if (response.structuredContent) response = response.structuredContent;
  else if (Array.isArray(response.content)) {
    const text = response.content.filter((item) => item.type === 'text');
    if (text.length !== 1 || typeof text[0].text !== 'string') return null;
    try { response = JSON.parse(text[0].text); } catch { return null; }
  }
  if (!response || response.replayed === true || response.__server_replayed === true) return null;
  if (SUBTHEME_SAVE_TOOLS.includes(name)) {
    const ids = subthemeSavedRefs(name, response);
    return ids ? { name, response, ids } : null;
  }
  if (!response || !(response.operation === name || name === 'amend' && /^amend\.(revise|supersede|dispute)$/.test(response.operation)) || !(response.outcome_code === 'recorded' || ['capture','amend','summary_record'].includes(name) && response.outcome_code === 'applied') || !Array.isArray(response.resource_ids) || !response.resource_ids.length || response.resource_ids.length > 20) return null;
  const ids = [];
  for (const ref of response.resource_ids) {
    if (!ref || typeof ref.id !== 'string' || !/^[A-Z][A-Z0-9]{1,7}-(?:c|w)?[0-9]+$/.test(ref.id)) return null;
    if (['primary','created','updated'].includes(ref.role)) {
      if (!Number.isSafeInteger(ref.version) || ref.version <= 0) return null;
    } else if (!(name === 'amend' && ['superseded','disputed'].includes(ref.role)
      && (ref.version === undefined || Number.isSafeInteger(ref.version) && ref.version > 0))) return null;
    if (!['primary','created','updated'].includes(ref.role)) continue;
    if (name === 'capture' && (!Array.isArray(response.items) || !response.items.some((item) => item.outcome_code === 'recorded' && item.id === ref.id && item.version === ref.version))) return null;
    ids.push(ref.id + '@' + ref.version);
  }
  return { name, response, ids: [...new Set(ids)] };
}
module.exports={parseSavedResponse,SAVE_TOOLS,SUBTHEME_SAVE_TOOLS};
