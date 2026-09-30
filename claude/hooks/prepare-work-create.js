#!/usr/bin/env node
/** Build a validated work_create payload from an autonomous work objective. */
'use strict';
const crypto = require('node:crypto');

function prepareWorkCreate(input = {}) {
  const theme = typeof input.theme === 'string' ? input.theme.trim() : '';
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  const targetEnvironment = typeof input.target_environment === 'string' && input.target_environment.trim()
    ? input.target_environment.trim() : 'unspecified';
  const criteria = Array.isArray(input.completion_criteria)
    ? input.completion_criteria.map(value => {
      if (typeof value === 'string' && value.trim()) return { criterion: value.trim(), state: 'implementation', required: 'completed' };
      if (value && typeof value === 'object' && typeof value.criterion === 'string' && value.criterion.trim()) {
        const state = typeof value.state === 'string' ? value.state : (typeof value.field === 'string' ? value.field : 'implementation');
        const required = typeof value.required === 'string' ? value.required : (typeof value.expected === 'string' ? value.expected : (state === 'verification' || state === 'verification_state' ? 'passed' : 'completed'));
        return { ...value, criterion: value.criterion.trim(), state, required };
      }
      return null;
    }).filter(Boolean)
    : [];
  if (!/^[A-Z][A-Z0-9]{1,31}$/u.test(theme)) throw new Error('invalid_theme');
  if (!objective || objective.length > 2000) throw new Error('invalid_objective');
  if (criteria.length === 0 || criteria.length > 20) throw new Error('invalid_completion_criteria');
  if (typeof input.session_id !== 'string' || !input.session_id.trim()) throw new Error('missing_session_id');
  const canonical = JSON.stringify({ theme, objective, target_environment: targetEnvironment, completion_criteria: criteria, next_action: input.next_action || '' });
  const idempotencyKey = typeof input.idempotency_key === 'string' && input.idempotency_key.trim()
    ? input.idempotency_key.trim() : `work-create-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
  const payload = {
    theme, objective, target_environment: targetEnvironment, completion_criteria: criteria,
    ...(typeof input.next_action === 'string' && input.next_action.trim() ? { next_action: input.next_action.trim() } : {}),
    idempotency_key: idempotencyKey, session_id: input.session_id.trim(),
    ...(input.confirm_theme_switch === true ? { confirm_theme_switch: true } : {}),
  };
  return { payload, source: typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'conversation-objective' };
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(prepareWorkCreate(JSON.parse(require('node:fs').readFileSync(0, 'utf8') || '{}')))); }
  catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid_input' })); process.exitCode = 1; }
}

module.exports = { prepareWorkCreate };
