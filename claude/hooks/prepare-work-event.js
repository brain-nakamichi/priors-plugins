#!/usr/bin/env node
'use strict';

const { prepareWorkEvent } = require('./proactive-candidates.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let basis = [];
try { basis = JSON.parse(arg('--basis') || '[]'); } catch { basis = null; }
const result = prepareWorkEvent(arg('--candidate-id'), arg('--work-id'), {
  expected_work_version: Number(arg('--expected-work-version')),
  event_type: arg('--event-type'),
  summary: arg('--summary'),
  target_environment: arg('--target-environment'),
  implementation_state: arg('--implementation-state'),
  deployment_state: arg('--deployment-state'),
  verification_state: arg('--verification-state'),
  verification_environment: arg('--verification-environment'),
  verification_method: arg('--verification-method'),
  verification_target: (() => { try { return JSON.parse(arg('--verification-target') || ''); } catch { return undefined; } })(),
  verification_tool_output: (() => { try { return JSON.parse(arg('--verification-tool-output') || ''); } catch { return undefined; } })(),
  verification_assessment: (() => { try { return JSON.parse(arg('--verification-assessment') || ''); } catch { return undefined; } })(),
  verification_executed_at: arg('--verification-executed-at'),
  verification_source: (() => { try { return JSON.parse(arg('--verification-source') || ''); } catch { return undefined; } })(),
  next_action: arg('--next-action'),
  basis,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exitCode = 2;
