#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const allowed = new Set(['pending', 'use-read', 'write-candidate', 'skip']);
const phases = new Set(['unknown', 'turn-start', 'conversation-end']);
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
try {
  const decision = arg('--decision');
  if (!allowed.has(decision)) throw new Error('invalid decision');
  const client = arg('--client') || 'codex';
  const promptHash = arg('--prompt-sha256');
  const phase = arg('--phase') || 'unknown';
  const source = arg('--source') || 'explicit';
  if (!['explicit', 'hook'].includes(source)) throw new Error('invalid source');
  if (!phases.has(phase)) throw new Error('invalid phase');
  // GEN-554/556: --save-result recorded|failed|not_needed [--saved <id@version,...>]. "recorded" needs at least one
  // valid reference the server returned; an invalid reference is an error, never silently dropped
  const saveResult = arg('--save-result');
  let save;
  if (saveResult !== undefined) {
    if (!['recorded', 'failed', 'not_needed'].includes(saveResult)) throw new Error('invalid save outcome');
    const ids = (arg('--saved') || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (ids.length > 20 || ids.some((x) => !/^[A-Za-z0-9_:@.-]{1,80}$/.test(x))) throw new Error('invalid save id');
    if (saveResult === 'recorded' && ids.length === 0) throw new Error('recorded requires a saved id');
    save = { outcome: saveResult, ids };
  }
  const file = path.resolve(process.env.PRIORS_DECISION_AUDIT_FILE || path.join(os.homedir(), '.priors', 'decision-audit.jsonl'));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const event = {
    schema: 'priors.decision-audit.v1', recorded_at: new Date().toISOString(),
    decision, client, source, phase,
    ...(typeof promptHash === 'string' && /^[0-9a-f]{64}$/.test(promptHash)
      ? { prompt_sha256: promptHash } : {}),
    ...(save ? { save } : {}),
  };
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  process.stdout.write(JSON.stringify({ ok: true, decision, phase, source, ...(save ? { save } : {}) }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: 'invalid_input' }) + '\n');
  process.exitCode = 2;
}
