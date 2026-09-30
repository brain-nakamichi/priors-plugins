#!/usr/bin/env node
/** Select an existing work item from a brief projection without creating or resolving work. */
'use strict';

function terms(value) {
  return new Set(String(value || '').toLocaleLowerCase().match(/[a-z0-9_]+|[\u3040-\u30ff\u3400-\u9fff]{2,}/giu) || []);
}

function selectWorkItem(objective, candidates, explicitWorkId = '') {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (explicitWorkId) {
    const exact = rows.find(row => row && row.work_id === explicitWorkId);
    return exact ? { work_id: explicitWorkId, method: 'explicit', score: 0 } : null;
  }
  const query = terms(objective);
  if (query.size === 0) return null;
  const ranked = rows.map((row, index) => {
    if (!row || typeof row.work_id !== 'string') return null;
    const text = [row.objective, row.next_action, row.status].join(' ');
    const overlap = [...query].filter(term => terms(text).has(term)).length;
    const active = row.status === 'open' || row.status === 'in_progress'
      || row.status === 'blocked' || row.status === 'reopened' ? 1 : 0;
    return { row, index, score: overlap, active };
  }).filter(Boolean).sort((a, b) => b.active - a.active || b.score - a.score || a.index - b.index);
  const winner = ranked[0];
  return winner && winner.score > 0 && winner.active === 1
    ? { work_id: winner.row.work_id, method: 'objective-match', score: winner.score }
    : null;
}

if (require.main === module) {
  try {
    const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8') || '{}');
    const result = selectWorkItem(input.objective, input.work_candidates || input.work || [], input.work_id);
    process.stdout.write(JSON.stringify({ selected: result, create_required: !result }));
  } catch {
    process.stdout.write(JSON.stringify({ selected: null, create_required: true }));
  }
}

module.exports = { selectWorkItem };
