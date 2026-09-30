'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'conversation-end.js');
const RECORDER = path.join(ROOT, 'hooks', 'record-decision.js');

test('conversation end reminds and records only a pending local decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-end-test-'));
  const file = path.join(dir, 'audit.jsonl');
  const stopFile = path.join(dir, 'stop-hook.jsonl');
  try {
    const candidates = path.join(dir, 'candidates.jsonl');
    fs.writeFileSync(candidates, [
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), prompt_sha256: 'b'.repeat(64), categories: ['unresolved-candidate'], source: 'local-heuristic', confidence: 'low' },
      { schema: 'priors.proactive-candidate.v1', recorded_at: new Date().toISOString(), prompt_sha256: 'a'.repeat(64), categories: ['recall-likely', 'remember-candidate', 'work-item-candidate'], source: 'local-heuristic', confidence: 'high', candidate_id: 'pc-' + 'a'.repeat(12) + '-recall-likely-remember-candidate-work-item-candidate' },
    ].map(JSON.stringify).join('\n') + '\n');
    const env = { ...process.env, PRIORS_AUTO_REMEMBER: '0', PRIORS_DECISION_AUDIT_FILE: file, PRIORS_STOP_DIAGNOSTIC_FILE: stopFile, PRIORS_PROACTIVE_CANDIDATE_FILE: candidates };
    const child = spawnSync(process.execPath, [HOOK], {
      env,
      input: JSON.stringify({ transcript: 'do not persist this secret' }),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'Stop');
    assert.match(output.hookSpecificOutput.additionalContext, /write-candidate/);
    assert.match(output.hookSpecificOutput.additionalContext, /高確度/);
    assert.match(output.hookSpecificOutput.additionalContext, /高確度候補を先に確認/);
    assert.match(output.hookSpecificOutput.additionalContext, /自動候補キューが 1 件/);
    assert.match(output.hookSpecificOutput.additionalContext, /会話終了Remember候補を 1 件生成しました/);
    assert.match(output.hookSpecificOutput.additionalContext, /作業台帳候補を 1 件生成しました/);
    assert.match(output.hookSpecificOutput.additionalContext, /Recall候補 1 件/);
    assert.match(output.hookSpecificOutput.additionalContext, /Remember候補 1 件/);
    assert.match(output.hookSpecificOutput.additionalContext, /Recall候補: context_open → recall/);
    assert.match(output.hookSpecificOutput.additionalContext, /Remember候補: 出所確認 → guard → remember\/amend/);
    assert.match(output.hookSpecificOutput.additionalContext, /作業台帳候補: brief/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /a{64}/);
    assert.match(output.hookSpecificOutput.additionalContext, /\n/);
    assert.equal(fs.existsSync(file), false);
    const generated = fs.readFileSync(candidates, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const remember = generated.find((event) => event.schema === 'priors.remember-candidate.v1');
    assert.ok(remember);
    assert.match(remember.candidate_id, /^rc-[0-9a-f]{16}$/);
    assert.deepEqual(remember.source_candidate_ids, ['pc-' + 'a'.repeat(12) + '-recall-likely-remember-candidate-work-item-candidate']);
    assert.equal(remember.confirmation_state, 'pending');
    assert.equal(remember.requires_confirmation, true);
    assert.equal(Object.hasOwn(remember, 'body'), false);
    const work = generated.find((event) => event.schema === 'priors.work-item-candidate.v1');
    assert.ok(work);
    assert.equal(work.confirmation_state, 'pending');
    assert.equal(work.work_selection, 'required');
    const stopEvent = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
    assert.equal(stopEvent.event, 'stop_invoked');
    assert.equal(stopEvent.stop_hook_active, false);
    assert.equal(Object.hasOwn(stopEvent, 'transcript'), false);

    const turnStart = spawnSync(process.execPath, [RECORDER, '--decision', 'skip', '--client', 'claude', '--phase', 'turn-start'], { env, encoding: 'utf8' });
    assert.equal(turnStart.status, 0);
    const afterTurnStart = spawnSync(process.execPath, [HOOK], { env, input: '{}', encoding: 'utf8' });
    assert.equal(afterTurnStart.status, 0);
    assert.notEqual(afterTurnStart.stdout, '');

    const recorded = spawnSync(process.execPath, [RECORDER, '--decision', 'skip', '--client', 'claude', '--phase', 'conversation-end'], { env, encoding: 'utf8' });
    assert.equal(recorded.status, 0);
    assert.equal(JSON.parse(recorded.stdout).phase, 'conversation-end');
    assert.equal(JSON.parse(recorded.stdout).acknowledged_candidates, 1);
    const acknowledged = fs.readFileSync(candidates, 'utf8');
    assert.match(acknowledged, /reviewed_at/);
    assert.match(acknowledged, /review_decision":"skip/);
    const repeated = spawnSync(process.execPath, [HOOK], { env, input: '{}', encoding: 'utf8' });
    assert.equal(repeated.status, 0);
    assert.equal(repeated.stdout, '');

    const reentrant = spawnSync(process.execPath, [HOOK], { env, input: JSON.stringify({ stop_hook_active: true }), encoding: 'utf8' });
    assert.equal(reentrant.status, 0);
    assert.equal(reentrant.stdout, '');
    const stopEvents = fs.readFileSync(stopFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(stopEvents.length, 4);
    assert.equal(stopEvents[3].stop_hook_active, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('自律Rememberモードでは受信箱候補を生成せず直接remember手順を促す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-remember-end-'));
  const file = path.join(dir, 'candidates.jsonl');
  try {
    const env = { ...process.env, PRIORS_AUTO_REMEMBER: '1', PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl'), PRIORS_STOP_DIAGNOSTIC_FILE: path.join(dir, 'stop.jsonl'), PRIORS_PROACTIVE_CANDIDATE_FILE: file };
    const child = spawnSync(process.execPath, [HOOK], {
      env,
      input: '{}',
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.match(output.systemMessage, /自律Remember/);
    assert.match(output.hookSpecificOutput.additionalContext, /context_open → recall → guard → remember\/amend/);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
