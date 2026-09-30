#!/usr/bin/env node
/** Route an autonomous work objective to an existing work or a safe create payload. */
'use strict';
const { selectWorkItem } = require('./select-work-item.js');
const { prepareWorkCreate } = require('./prepare-work-create.js');

function routeWorkItem(input = {}) {
  const selected = selectWorkItem(input.objective, input.work_candidates || input.work || [], input.work_id);
  if (selected) return { action: 'work_event', selection: selected };
  if (typeof input.work_id === 'string' && input.work_id.trim()) {
    return { action: 'work_event', error: 'explicit_work_not_found', work_id: input.work_id.trim() };
  }
  return { action: 'work_create', create: prepareWorkCreate(input) };
}

if (require.main === module) {
  try {
    const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8') || '{}');
    process.stdout.write(JSON.stringify(routeWorkItem(input)));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid_input' }));
    process.exitCode = 1;
  }
}

module.exports = { routeWorkItem };
