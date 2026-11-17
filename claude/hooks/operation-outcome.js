#!/usr/bin/env node
'use strict';
// GEN-2414 Q3 stage 1 (design: docs/retention-event-and-handoff-hints-design-20261027.md A, and
// docs/work-ledger-continuity-and-hints-design-20261029.md §3 work_checkpoint).
// After a Bash/PowerShell tool call, recognise a few state-changing operations whose success the
// tool output itself confirms (git push, a push to the public plugin repository, vercel deploy --prod,
// apply-NNN.ts --execute) and name each one at most once as an optional "save the result / update the
// work ledger" hint. It never runs anything, never evaluates the shell, and keeps only a safe reference
// (repository name, ref, short commit, deploy host, stage number), never the command text or output.
// Default mode is shadow: candidates are recorded locally and not shown, so that the rate of hints and
// false positives can be measured before the user decides to show them (PRIORS_OPERATION_HINTS=on).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_ENTRIES = 200, MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LABEL = { git_push: 'push', plugin_publish: 'プラグインの公開', production_deploy: '本番の配備', sql_apply: 'SQL の適用' };

function hintMode(env = process.env) {
  const v = typeof env.PRIORS_OPERATION_HINTS === 'string' ? env.PRIORS_OPERATION_HINTS.trim().toLowerCase() : '';
  return v === 'on' || v === 'off' ? v : 'shadow';
}

function outputText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (!toolResponse || typeof toolResponse !== 'object') return '';
  return ['stdout', 'stderr', 'output'].map((k) => (typeof toolResponse[k] === 'string' ? toolResponse[k] : '')).join('\n');
}

/** Split one simple command into words. Returns null for anything that is not a single plain command. */
const UNSAFE = /[|;`<>\n\r&$]|^#/;
function simpleWords(command) {
  let text = command.trim().replace(/\s+2>&1$/, '');
  // One leading change of directory is allowed: "cd <dir> &&" (shells) or "cd <dir>;" / "Set-Location <dir>;"
  // (PowerShell 5.1 has no &&). Any other chaining is out of scope. The directory itself must be plain too.
  const lead = text.match(/^\s*(?:cd|Set-Location)\s+("[^"]*"|'[^']*'|[^\s"']+)\s*(?:&&|;)\s*(.*)$/s);
  if (lead) {
    if (UNSAFE.test(lead[1])) return null;
    text = lead[2].trim();
  }
  if (!text || UNSAFE.test(text)) return null;
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

// PowerShell 5.1 with 2>&1 wraps each stderr line as "git : <line>"; read the line underneath.
const unwrapPs = (output) => output.replace(/^git : /gm, '');

function repoFrom(output) {
  const m = output.match(/^To\s+(\S+)\s*$/m);
  if (!m) return null;
  const url = m[1].replace(/^[a-z+]+:\/\/[^/@]*@/i, (s) => s.slice(0, s.indexOf('://') + 3));
  const r = url.match(/[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return r ? `${r[1]}/${r[2]}` : null;
}

// The registered public plugin entrypoint: only its main branch is a publish (docs/deployment.md).
const PLUGIN_REPO = 'brain-nakamichi/priors-plugins';
function classifyPush(words, rawOutput) {
  let i = 1;
  if (words[i] === '-C') i += 2;
  if (words[i] !== 'push') return null;
  // dry run in any spelling git accepts: -n, combined short flags (-nv), --dry-run and its abbreviations (--dry)
  if (words.slice(i + 1).some((w) => /^-[A-Za-z]*n[A-Za-z]*$/.test(w) || /^--dry/.test(w) || w === '--help')) return null;
  const output = unwrapPs(rawOutput);
  if (/error:|fatal:|rejected\]|Everything up-to-date/.test(output)) return null;
  const repo = repoFrom(output);
  if (!repo) return null;
  const update = output.match(/^\s*\+?\s*[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)\s*(?:\(forced update\))?\s*$/m);
  // a new branch or tag, or a deleted ref, changes state too; its commit is not printed, so none is guessed
  const other = update ? null : output.match(/^\s*([*-])\s+\[(new branch|new tag|deleted)\]\s+(?:\S+\s+->\s+)?(\S+)\s*$/m);
  if (!update && !other) return null;
  const ref = (update ? update[2] : other[3]).replace(/^refs\/heads\//, '');
  const op = { kind: repo === PLUGIN_REPO && ref === 'main' ? 'plugin_publish' : 'git_push', repo, ref };
  if (update) op.commit = update[1].slice(0, 8);
  if (other) op.change = other[2] === 'deleted' ? 'deleted' : 'created';
  return op;
}

function classifyDeploy(words, output) {
  if (words[1] !== 'deploy') return null;
  if (!words.some((w) => w === '--prod' || w === '--production' || w === '--target=production')) return null;
  // a start that does not wait for the deployment is not a confirmed completion
  if (words.includes('--no-wait')) return null;
  if (/\bError\b/.test(output)) return null;
  const m = output.match(/Production:\s+https:\/\/([A-Za-z0-9.-]+)/);
  return m ? { kind: 'production_deploy', host: m[1] } : null;
}

function classifyApply(words, output) {
  const script = words.map((w) => w.match(/(?:^|[\\/])apply-(\d{3})\.ts$/)).find(Boolean);
  // --test applies to the TEST database: not a production state change, so not a candidate here.
  // A rollback is left to the AI's own judgement (design A lists rollback on the suppressed side).
  if (!script || !words.includes('--execute') || words.includes('--help') || words.includes('--test')
    || words.includes('--rollback')) return null;
  for (const m of output.matchAll(/\{[^{}]*"postcheck"\s*:\s*"passed"[^{}]*\}/g)) {
    try {
      const r = JSON.parse(m[0]);
      if (r.mode === 'execute' && r.stage === Number(script[1]) && r.action === 'apply') {
        return { kind: 'sql_apply', stage: r.stage, action: r.action, environment: 'production' };
      }
    } catch { /* not a receipt */ }
  }
  return null;
}

/** Pure: the confirmed operation of one shell tool call, or null. */
function classifyOperation(toolName, toolInput, toolResponse) {
  if (!SHELL_TOOLS.has(toolName) || !toolInput || typeof toolInput !== 'object' || typeof toolInput.command !== 'string') return null;
  const output = outputText(toolResponse);
  if (!output) return null;
  const words = simpleWords(toolInput.command);
  if (!words || !words.length) return null;
  if (words[0] === 'git') return classifyPush(words, output);
  if (words[0] === 'vercel') return classifyDeploy(words, output);
  if (['node', 'npx', 'tsx'].includes(words[0])) return classifyApply(words, output);
  return null;
}

function ledgerPath(env = process.env) {
  const configured = env.PRIORS_OPERATION_HINT_FILE;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.priors', 'operation-hints.json');
}

function readLedger(env) {
  try {
    const data = JSON.parse(fs.readFileSync(ledgerPath(env), 'utf8'));
    if (data && data.schema === 'priors.operation-hints.v1' && Array.isArray(data.entries)) return data;
  } catch { /* missing or damaged: start clean */ }
  return { schema: 'priors.operation-hints.v1', entries: [] };
}

function writeLedger(data, env, nowMs) {
  const entries = data.entries.filter((e) => e && nowMs - Number(e.at_ms || 0) <= MAX_AGE_MS).slice(-MAX_ENTRIES);
  const file = ledgerPath(env), temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ schema: 'priors.operation-hints.v1', entries }), { encoding: 'utf8', mode: 0o600 });
  // Concurrent hooks are best effort: a lost entry only thins the shadow measurement. Do not leave a temp file behind.
  try { fs.renameSync(temporary, file); } catch (e) { try { fs.unlinkSync(temporary); } catch { /* already gone */ } throw e; }
}

/**
 * Record the operation once per session. Returns true when it was new, or (when shown is requested) when it was
 * recorded earlier only in shadow and has not been shown yet, so switching shadow to on still shows it once.
 */
function recordOperation(sessionId, op, env = process.env, shown = false, nowMs = Date.now()) {
  if (!op || !SESSION.test(String(sessionId)) || hintMode(env) === 'off') return false;
  const key = `${sessionId}|${JSON.stringify(op)}`;
  const data = readLedger(env);
  const existing = data.entries.find((e) => e && e.key === key);
  if (existing) {
    if (!shown || existing.shown) return false;
    existing.shown = true;
  } else {
    data.entries.push({ key, ...op, mode: hintMode(env), shown, at_ms: nowMs });
  }
  writeLedger(data, env, nowMs);
  return true;
}

function refText(op) {
  if (op.kind === 'production_deploy') return op.host;
  if (op.kind === 'sql_apply') return `${op.stage} ${op.action}`;
  const change = op.change === 'created' ? ' 新規' : op.change === 'deleted' ? ' 削除' : '';
  return `${op.repo} ${op.ref}${op.commit ? `@${op.commit}` : ''}${change}`;
}

/** In mode on, the one-line hint for a new operation (recording it); otherwise ''. */
function operationHint(sessionId, op, env = process.env) {
  if (!op || hintMode(env) !== 'on') return '';
  if (!recordOperation(sessionId, op, env, true)) return '';
  return `Priors: ${LABEL[op.kind]}（${refText(op)}）の成功を確認しました。既存の記録になければ結果を保存し、`
    + '対応する作業台帳があれば work_event で反映できます（任意。AI が判断する）。';
}

function main() {
  try {
    const { readHookInput } = require('./bounded-input.js');
    const read = readHookInput(0, false);
    const input = read.ok ? read.input : null;
    if (!input || input.hook_event_name !== 'PostToolUse' || !SESSION.test(String(input.session_id))) return;
    const mode = hintMode();
    if (mode === 'off') return;
    const op = classifyOperation(input.tool_name, input.tool_input, input.tool_response);
    if (!op) return;
    if (mode === 'shadow') { recordOperation(input.session_id, op); return; }
    const hint = operationHint(input.session_id, op);
    if (hint) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hint } }));
  } catch { /* advisory only: never block or alter the tool result */ }
}
if (require.main === module) main();
module.exports = { classifyOperation, operationHint, recordOperation, hintMode, ledgerPath };
