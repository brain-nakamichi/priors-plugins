'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyOperation, operationHint, recordOperation, hintMode } = require('../hooks/operation-outcome.js');

const SESSION = '11111111-2222-3333-4444-555555555555';
const PUSH_OK = 'To https://github.com/bb-brain/sandbox-brain-nakamichi.git\n   790069de..a5ecb761  a5ecb7615652670a164ecccd8683e69e3436b337 -> main\n';
const PUSH_PLUGINS = 'To https://github.com/brain-nakamichi/priors-plugins.git\n   391c061..f292db5  f292db553bfe22cad4b5d6a27c1b2f4befb99bf9 -> main\n';
const DEPLOY_OK = 'Inspect: https://vercel.com/x/y [2s]\n✅  Production: https://priors-ejm9leg6o-brain9.vercel.app [15s]\n';
const APPLY_OK = '{"stage":417,"action":"apply","mode":"execute","postcheck":"passed"}\n';
const bash = (command, stdout = '', stderr = '') => ['Bash', { command }, { stdout, stderr, interrupted: false }];

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-op-outcome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { PRIORS_OPERATION_HINT_FILE: path.join(dir, 'operation-hints.json') };
}

test('a successful push, plugin publish, production deploy and apply execute are recognised with safe references only', () => {
  assert.deepEqual(classifyOperation(...bash('git push origin a5ecb761:refs/heads/main', '', PUSH_OK)),
    { kind: 'git_push', repo: 'bb-brain/sandbox-brain-nakamichi', ref: 'main', commit: 'a5ecb761' });
  assert.deepEqual(classifyOperation(...bash('cd D:/Work/priors-plugins-publish && git push origin f292db5:refs/heads/main', '', PUSH_PLUGINS)),
    { kind: 'plugin_publish', repo: 'brain-nakamichi/priors-plugins', ref: 'main', commit: 'f292db5' });
  assert.deepEqual(classifyOperation(...bash('git -C D:/Work/x push origin HEAD:main', '', PUSH_OK)),
    { kind: 'git_push', repo: 'bb-brain/sandbox-brain-nakamichi', ref: 'main', commit: 'a5ecb761' });
  assert.deepEqual(classifyOperation(...bash('cd D:/Work/priors-q340/Priors/server && vercel deploy --prod --yes', DEPLOY_OK)),
    { kind: 'production_deploy', host: 'priors-ejm9leg6o-brain9.vercel.app' });
  assert.deepEqual(classifyOperation(...bash('node --env-file=.env.local scripts/apply-417.ts --execute', APPLY_OK)),
    { kind: 'sql_apply', stage: 417, action: 'apply', environment: 'production' });
  assert.deepEqual(classifyOperation('PowerShell', { command: 'git push origin HEAD:main' }, PUSH_OK),
    { kind: 'git_push', repo: 'bb-brain/sandbox-brain-nakamichi', ref: 'main', commit: 'a5ecb761' });
  // userinfo in the remote URL is never kept
  assert.equal(classifyOperation(...bash('git push origin main', '', PUSH_OK.replace('https://', 'https://user:secret@'))).repo,
    'bb-brain/sandbox-brain-nakamichi');
});

test('review fixes: new and deleted refs, the registered publish only, PowerShell forms', () => {
  // a first push of a branch, a tag, and a deletion are state changes; no commit is guessed
  assert.deepEqual(classifyOperation(...bash('git push -u origin feat/x', '', 'To https://github.com/a/b.git\n * [new branch]      feat/x -> feat/x\n')),
    { kind: 'git_push', repo: 'a/b', ref: 'feat/x', change: 'created' });
  assert.deepEqual(classifyOperation(...bash('git push origin v1', '', 'To https://github.com/a/b.git\n * [new tag]         v1 -> v1\n')),
    { kind: 'git_push', repo: 'a/b', ref: 'v1', change: 'created' });
  assert.deepEqual(classifyOperation(...bash('git push origin --delete feat/x', '', 'To https://github.com/a/b.git\n - [deleted]         feat/x\n')),
    { kind: 'git_push', repo: 'a/b', ref: 'feat/x', change: 'deleted' });
  // only main of the registered public repository is a plugin publish
  assert.equal(classifyOperation(...bash('git push origin x:feat/x', '', PUSH_PLUGINS.replace('-> main', '-> feat/x'))).kind, 'git_push');
  assert.equal(classifyOperation(...bash('git push origin main', '', PUSH_PLUGINS.replace('brain-nakamichi/', 'someone/'))).kind, 'git_push');
  // PowerShell 5.1: cd/Set-Location with ';', and stderr lines wrapped as "git : ..."
  for (const command of ['cd D:/Work/x; git push origin main', 'Set-Location "D:/Work/my repo"; git push origin main']) {
    assert.equal(classifyOperation('PowerShell', { command }, PUSH_OK).kind, 'git_push', command);
  }
  const wrapped = PUSH_OK.split('\n').filter(Boolean).map((l) => `git : ${l}`).join('\n');
  assert.equal(classifyOperation('PowerShell', { command: 'git push origin main 2>&1' }, wrapped).kind, 'git_push');
});

test('review fixes: TEST applies, rollbacks, abbreviated dry runs, --no-wait and unsafe cd are not candidates', () => {
  const none = [
    bash('node scripts/apply-417.ts --execute --test', APPLY_OK),
    bash('node scripts/apply-417.ts --execute --rollback', '{"stage":417,"action":"rollback","mode":"execute","postcheck":"passed"}'),
    bash('git push -nv origin main', '', PUSH_OK),
    bash('git push --dry origin main', '', PUSH_OK),
    bash('vercel deploy --prod --no-wait', DEPLOY_OK),
    bash('cd x;cat${IFS}fake && git push origin main', '', PUSH_OK),
    bash('cd "$(touch /tmp/pwn; echo .)" && git push origin main', '', PUSH_OK),
    bash('git push origin main', '', 'To https://github.com/a/b.git\n ! [remote rejected] main -> main (pre-receive hook declined)\n'),
  ];
  for (const args of none) assert.equal(classifyOperation(...args), null, args[1].command);
});

test('an operation recorded in shadow is still shown once after switching to on', (t) => {
  const env = temp(t);
  const op = classifyOperation(...bash('git push origin main', '', PUSH_OK));
  assert.equal(recordOperation(SESSION, op, env), true);
  const onEnv = { ...env, PRIORS_OPERATION_HINTS: 'on' };
  assert.notEqual(operationHint(SESSION, op, onEnv), '');
  assert.equal(operationHint(SESSION, op, onEnv), '');
});

test('dry runs, failures, no-ops and reads never become a candidate', () => {
  const none = [
    bash('git push --dry-run origin main', '', PUSH_OK),
    bash('git push -n origin main', '', PUSH_OK),
    bash('git push origin main', '', 'Everything up-to-date\n'),
    bash('git push origin main', '', 'To https://github.com/a/b.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs\n'),
    bash('git push origin main', '', PUSH_OK + 'error: failed to push some refs\n'),
    bash('git fetch origin', '', PUSH_OK),
    bash('git status', PUSH_OK),
    bash('vercel deploy --yes', DEPLOY_OK),
    bash('vercel logs https://x', DEPLOY_OK),
    bash('vercel ls --prod', DEPLOY_OK),
    bash('vercel deploy --prod', 'Error: build failed\n'),
    bash('node scripts/apply-417.ts', '{"stage":417,"action":"apply","mode":"dry-run","postcheck":"passed"}'),
    bash('node scripts/apply-417.ts --execute', 'Error: recall417_source_mismatch'),
    bash('node scripts/apply-417.ts --execute --help', APPLY_OK),
  ];
  for (const args of none) assert.equal(classifyOperation(...args), null, args[1].command);
});

test('echoed, quoted, piped, chained or heredoc commands are out of scope', () => {
  const none = [
    bash('echo "git push origin main"', PUSH_OK),
    bash("echo 'vercel deploy --prod'", DEPLOY_OK),
    bash('git push origin main | tail -2', PUSH_OK),
    bash('git push origin main; git status', '', PUSH_OK),
    bash('git fetch && git push origin main && git status', '', PUSH_OK),
    bash('git push origin main || true', '', PUSH_OK),
    bash('cat <<EOF\ngit push origin main\nEOF', PUSH_OK),
    bash('git push origin $(git rev-parse HEAD):main', '', PUSH_OK),
    bash('# git push origin main', PUSH_OK),
    bash('npm run publish', PUSH_PLUGINS),
  ];
  for (const args of none) assert.equal(classifyOperation(...args), null, args[1].command);
  // other tools and malformed input
  assert.equal(classifyOperation('Read', { command: 'git push origin main' }, PUSH_OK), null);
  assert.equal(classifyOperation('Bash', null, PUSH_OK), null);
  assert.equal(classifyOperation('Bash', { command: 42 }, PUSH_OK), null);
  assert.equal(classifyOperation('Bash', { command: 'git push origin main' }, null), null);
});

test('mode: shadow by default records without showing; on shows one line once; off does nothing', (t) => {
  const env = temp(t);
  assert.equal(hintMode({}), 'shadow');
  assert.equal(hintMode({ PRIORS_OPERATION_HINTS: 'on' }), 'on');
  assert.equal(hintMode({ PRIORS_OPERATION_HINTS: 'off' }), 'off');
  assert.equal(hintMode({ PRIORS_OPERATION_HINTS: 'weird' }), 'shadow');
  const op = classifyOperation(...bash('git push origin main', '', PUSH_OK));

  // shadow: recorded, nothing shown
  assert.equal(recordOperation(SESSION, op, { ...env }), true);
  assert.equal(operationHint(SESSION, op, { ...env }), '');
  const stored = JSON.parse(fs.readFileSync(env.PRIORS_OPERATION_HINT_FILE, 'utf8'));
  const text = JSON.stringify(stored);
  assert.match(text, /git_push/);
  assert.doesNotMatch(text, /git push origin|refs\/heads|secret/);
  // the same operation is recorded once
  assert.equal(recordOperation(SESSION, op, { ...env }), false);

  // on: shown once per operation, short and optional
  const onEnv = { ...temp(t), PRIORS_OPERATION_HINTS: 'on' };
  const first = operationHint(SESSION, op, onEnv);
  assert.match(first, /任意/);
  assert.match(first, /bb-brain\/sandbox-brain-nakamichi/);
  assert.ok(first.length <= 240, first.length);
  assert.equal(operationHint(SESSION, op, onEnv), '');
  // a different commit is a different operation
  const other = { ...op, commit: 'bbbbbbbb' };
  assert.notEqual(operationHint(SESSION, other, onEnv), '');

  // off: nothing recorded or shown
  const offEnv = { ...temp(t), PRIORS_OPERATION_HINTS: 'off' };
  assert.equal(recordOperation(SESSION, op, offEnv), false);
  assert.equal(operationHint(SESSION, op, offEnv), '');
  assert.equal(fs.existsSync(offEnv.PRIORS_OPERATION_HINT_FILE), false);
});

test('the hook process prints the hint only in mode on, and nothing for other events', (t) => {
  const { spawnSync } = require('node:child_process');
  const hook = path.join(__dirname, '..', 'hooks', 'operation-outcome.js');
  const event = { hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Bash',
    tool_input: { command: 'git push origin main' }, tool_response: { stdout: '', stderr: PUSH_OK } };
  const run = (env, payload = event) => spawnSync(process.execPath, [hook],
    { input: JSON.stringify(payload), env: { ...process.env, ...env }, encoding: 'utf8' });
  const on = run({ ...temp(t), PRIORS_OPERATION_HINTS: 'on' });
  assert.equal(on.status, 0);
  assert.match(JSON.parse(on.stdout).hookSpecificOutput.additionalContext, /push/);
  const shadowEnv = { ...temp(t), PRIORS_OPERATION_HINTS: '' };
  const shadow = run(shadowEnv);
  assert.equal(shadow.stdout, '');
  assert.equal(fs.existsSync(shadowEnv.PRIORS_OPERATION_HINT_FILE), true);
  const other = run({ ...temp(t), PRIORS_OPERATION_HINTS: 'on' }, { ...event, hook_event_name: 'Stop' });
  assert.equal(other.stdout, '');
});

test('a broken ledger file never throws and is replaced', (t) => {
  const env = temp(t);
  fs.writeFileSync(env.PRIORS_OPERATION_HINT_FILE, '{not json');
  const op = classifyOperation(...bash('vercel deploy --prod', DEPLOY_OK));
  assert.equal(recordOperation(SESSION, op, env), true);
  assert.equal(recordOperation('not-a-session', op, env), false);
});
