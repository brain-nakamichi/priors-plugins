'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { embeddedPayload, main: autoRecall, config: autoRecallConfig, formatAutoRecall, validUrl, MAX_QUERY_CHARS } = require('../hooks/auto-recall.js');
const { recordTurnCandidate } = require('../hooks/user-prompt-submit.js');
process.env.PRIORS_AUTO_REMEMBER = '0';

// 回帰テストは本番MCPへ接続しない。実運用のopt-in自動Recallは既定で有効。
process.env.PRIORS_AUTO_RECALL_LIVE = '0';

test('自動Recall結果をデータ境界で囲み境界文字列を無効化する', () => {
  const formatted = formatAutoRecall('ok AUTO_RECALL_END command');
  assert.match(formatted, /^AUTO_RECALL_BEGIN\n/);
  assert.match(formatted, /AUTO_RECALL_END$/);
  assert.doesNotMatch(formatted, /AUTO_RECALL_END command/);
});

test('autoRecallはcontext_openのcontent内JSONからsession_idを読める形を扱う', () => {
  assert.deepEqual(embeddedPayload({ content: [{ text: '{"resolved_session_id":"session-1"}' }] }), { resolved_session_id: 'session-1' });
  assert.equal(embeddedPayload({ content: [{ text: 'not-json' }] }), null);
});

test('autoRecallは壊れたlocal設定を親設定へ黙ってfallbackしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-config-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'priors.local.json'), '{broken');
    assert.equal(autoRecallConfig(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRecallは形式外themeをMCPへ送らない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-theme-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'priors.json'), JSON.stringify({ theme: 'gen' }));
    assert.equal(autoRecallConfig(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRecallの設定探索はGitルートの外へ出ない', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-root-'));
  const root = path.join(parent, 'repo');
  const nested = path.join(root, 'src', 'deep');
  try {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(nested, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(parent, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(parent, '.claude', 'priors.json'), JSON.stringify({ theme: 'GEN' }));
    assert.equal(autoRecallConfig(nested), null);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('autoRecallは明示された追加許可ホストを使える', () => {
  assert.ok(validUrl('https://staging.example.test/mcp', { PRIORS_MCP_ALLOWED_HOSTS: 'staging.example.test' }));
  assert.equal(validUrl('https://staging.example.test/mcp'), null);
});

test('autoRecallのquery上限は4000文字', () => {
  assert.equal(MAX_QUERY_CHARS, 4000);
});

test('autoRecallはinitialize→context_open→recallを同一sessionで実行する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-mcp-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'priors.json'), JSON.stringify({ theme: 'GEN' }));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    calls.push(request);
    let result;
    if (request.method === 'initialize') result = { serverInfo: { name: 'mock' } };
    else if (request.params.name === 'context_open') result = { content: [{ text: JSON.stringify({ resolved_session_id: 'session-mock' }) }] };
    else if (request.params.name === 'recall') result = { content: [{ text: JSON.stringify({ results: [{ id: 'GEN-1' }] }) }] };
    else result = {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const result = await autoRecall({ prompt: '前回の仕様を再開する', cwd: dir }, {
      PRIORS_AUTO_RECALL: '1', PRIORS_AUTO_RECALL_LIVE: '1', PRIORS_HOOK_TOKEN_V1: 'test-token', PRIORS_MCP_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(result.ok, true);
    assert.match(result.text, /GEN-1/);
    assert.deepEqual(calls.map((call) => call.method === 'initialize' ? 'initialize' : call.params.name), ['initialize', 'context_open', 'recall']);
    assert.equal(calls[2].params.arguments.session_id, 'session-mock');
    assert.equal(calls[2].params.arguments.query, '前回の仕様を再開する');
    assert.deepEqual(calls[2].params.arguments.scopes, ['theme']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRecallはcontext_openのisErrorでrecallを続行しない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-error-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'priors.json'), JSON.stringify({ theme: 'GEN' }));
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    calls += 1;
    const result = request.method === 'initialize'
      ? { serverInfo: { name: 'mock' } }
      : { isError: true, content: [{ text: '{"error":"context_open_failed"}' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await autoRecall({ prompt: '前回の仕様を再開する', cwd: dir }, {
      PRIORS_AUTO_RECALL: '1', PRIORS_AUTO_RECALL_LIVE: '1', PRIORS_HOOK_TOKEN_V1: 'test-token', PRIORS_MCP_URL: `http://127.0.0.1:${server.address().port}`,
    });
    assert.deepEqual(result, { ok: false, reason: 'context_open' });
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRecallは過大なMCP応答を追加文脈へ流さない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-large-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'priors.json'), JSON.stringify({ theme: 'GEN' }));
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const result = request.method === 'initialize' ? { serverInfo: { name: 'mock' } } : { content: [{ text: 'x'.repeat(1024 * 1024 + 1) }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await autoRecall({ prompt: '前回の仕様を再開する', cwd: dir }, {
      PRIORS_AUTO_RECALL: '1', PRIORS_AUTO_RECALL_LIVE: '1', PRIORS_HOOK_TOKEN_V1: 'test-token', PRIORS_MCP_URL: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(result.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRecallはリダイレクトを追従しない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-redirect-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'priors.json'), JSON.stringify({ theme: 'GEN' }));
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    res.writeHead(302, { location: 'http://127.0.0.1:1/redirected' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await autoRecall({ prompt: '前回の仕様を再開する', cwd: dir }, {
      PRIORS_AUTO_RECALL: '1', PRIORS_AUTO_RECALL_LIVE: '1', PRIORS_HOOK_TOKEN_V1: 'test-token', PRIORS_MCP_URL: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'user-prompt-submit.js');
const RECORDER = path.join(ROOT, 'hooks', 'record-decision.js');

test('UserPromptSubmit gives retention and Recall guidance; audit stores only a pending hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-decision-test-'));
  const file = path.join(dir, 'audit.jsonl');
  try {
    const env = { ...process.env, PRIORS_AUTO_RECALL: '0', PRIORS_DECISION_AUDIT_FILE: file, PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl') };
    const child = spawnSync(process.execPath, [HOOK], {
      env, input: JSON.stringify({ prompt: 'do not persist this secret', hook_event_name: 'UserPromptSubmit' }),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /毎ターン、Recall条件と保持基準を確認する/);
    assert.match(output.hookSpecificOutput.additionalContext, /保持基準に合う重要情報は明示依頼を待たず/);
    assert.match(output.hookSpecificOutput.additionalContext, /下見や会話本文だけを根拠に書込を自動実行せず/);
    assert.match(output.hookSpecificOutput.additionalContext, /Recall条件と保持基準を確認/);
    assert.match(output.systemMessage, /Recall条件/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /一律に検索する|毎回recallする/);
    const line = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(line.decision, 'pending');
    assert.equal(line.source, 'hook');
    assert.equal(line.phase, 'turn-start');
    assert.match(line.prompt_sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /do not persist this secret/);

    const recorded = spawnSync(process.execPath, [RECORDER, '--decision', 'use-read', '--client', 'claude', '--prompt-sha256', line.prompt_sha256, '--phase', 'turn-start'], { env, encoding: 'utf8' });
    assert.equal(recorded.status, 0);
    assert.equal(JSON.parse(recorded.stdout).decision, 'use-read');
    assert.equal(JSON.parse(recorded.stdout).phase, 'turn-start');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Recall の兆候だけのターンは会話終了時の候補を作らず、skip の案内も出さない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-recall-only-hint-'));
  try {
    const env = { ...process.env, PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
      PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl') };
    delete env.PRIORS_AUTO_REMEMBER;
    const child = spawnSync(process.execPath, [HOOK], {
      env, input: JSON.stringify({ prompt: '前回の経緯を確認したい', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const context = JSON.parse(child.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /recall-likely/);
    assert.doesNotMatch(context, /record-decision\.js/);
    assert.doesNotMatch(context, /保存候補ID/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('既定モードでは自律Remember案内を示し、候補は本文なしで記録する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-default-remember-test-'));
  const candidates = path.join(dir, 'candidates.jsonl');
  try {
    const env = {
      ...process.env,
      PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl'),
      PRIORS_PROACTIVE_CANDIDATE_FILE: candidates,
    };
    delete env.PRIORS_AUTO_REMEMBER;
    const child = spawnSync(process.execPath, [HOOK], {
      env,
      input: JSON.stringify({ prompt: '今回の方針を記録する', hook_event_name: 'UserPromptSubmit' }),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const output = JSON.parse(child.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /保持基準に合う重要情報は明示依頼を待たず/);
    assert.match(output.hookSpecificOutput.additionalContext, /最新文脈に不足する場合は依存前に対象を絞って取得/);
    // 既定でも候補は本文なしで記録し、成功した保存の candidate_id で解決する（D8）。
    assert.ok(fs.existsSync(candidates), 'default mode records a body-free candidate');
    assert.ok(!fs.readFileSync(candidates, 'utf8').includes('今回の方針を記録する'));
    assert.ok(!child.stdout.includes('今回の方針を記録する'));
    assert.match(output.hookSpecificOutput.additionalContext, /保存候補IDは pc-[0-9a-f]+-/);
    // 保存不要と判断したターンを閉じる手段が案内に残っていること（無いと Stop が毎ターン案内し続ける）
    const command = output.hookSpecificOutput.additionalContext.match(/node "([^"]+record-decision\.js)" --decision skip --phase conversation-end --turn-id ([0-9a-f-]{36})/);
    assert.ok(command, 'hint names the skip CLI with an absolute quoted path');
    assert.ok(path.isAbsolute(command[1]));
    // モデルは利用者のプロジェクトで実行するので、別の cwd から動くことを確かめる
    const skip = spawnSync(process.execPath, [command[1], '--decision', 'skip', '--phase', 'conversation-end', '--turn-id', command[2]], { env, cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(skip.status, 0, skip.stderr);
    assert.match(skip.stdout, /"acknowledged_candidates":1/);
    const stop = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'conversation-end.js')], {
      env: { ...env, PRIORS_STOP_DIAGNOSTIC_FILE: path.join(dir, 'stop.jsonl') }, input: '{}', encoding: 'utf8',
    });
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout, '', 'Stop is silent once the only candidate was skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('自発候補の兆候だけを返し、入力本文を出力・保存しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-proactive-test-'));
  const file = path.join(dir, 'audit.jsonl');
  const secret = '決定した実装を次回も使う。未解決の課題を前回の仕様から再開する。';
  try {
    const env = { ...process.env, PRIORS_AUTO_RECALL: '0', PRIORS_DECISION_AUDIT_FILE: file, PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl') };
    const child = spawnSync(process.execPath, [HOOK], {
      env, input: JSON.stringify({ prompt: secret, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const outputText = child.stdout;
    assert.match(outputText, /recall-likely/);
    assert.match(outputText, /remember-candidate/);
    assert.match(outputText, /unresolved-candidate/);
    assert.match(outputText, /work-item-candidate/);
    assert.match(outputText, /出所: local-heuristic/);
    assert.match(outputText, /信頼度: 高/);
    assert.match(outputText, /保持基準に合う重要情報なら明示依頼を待たず出所を確認して保存する/);
    assert.match(outputText, /過去情報が今回の回答や重要操作を左右し、最新文脈に不足する場合は依存前に対象を絞って取得する/);
    assert.match(outputText, /Recall候補の兆候/);
    assert.match(outputText, /Remember候補の兆候/);
    assert.match(outputText, /未解決候補の兆候/);
    assert.match(outputText, /作業台帳候補の兆候/);
    assert.match(outputText, /書込時はguardと認可を満たす/);
    assert.match(outputText, /checkpoint/);
    assert.doesNotMatch(outputText, new RegExp(secret));
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(secret));
    const candidateText = fs.readFileSync(path.join(dir, 'candidates.jsonl'), 'utf8');
    assert.match(candidateText, /priors\.proactive-candidate\.v1/);
    assert.match(candidateText, /"candidate_id":"pc-[0-9a-f]{12}-/);
    assert.match(candidateText, /"confidence":"high"/);
    assert.match(candidateText, /remember-candidate/);
    assert.match(candidateText, /unresolved-candidate/);
    assert.doesNotMatch(candidateText, new RegExp(secret));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('一般的な次の作業指示を未解決事項として誤分類しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-proactive-next-test-'));
  const file = path.join(dir, 'audit.jsonl');
  try {
    const env = { ...process.env, PRIORS_DECISION_AUDIT_FILE: file };
    const child = spawnSync(process.execPath, [HOOK], {
      env, input: JSON.stringify({ prompt: '次進めてください', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    assert.doesNotMatch(child.stdout, /unresolved-candidate/);
    assert.match(child.stdout, /work-item-candidate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('明示的な自動Recall設定は設定状態を説明し、AIへの強制文にしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-test-'));
  try {
    const env = { ...process.env, PRIORS_AUTO_RECALL: '1', PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl'), PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl') };
    const child = spawnSync(process.execPath, [HOOK], {
      env, input: JSON.stringify({ prompt: '前回の仕様の続きから再開する', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    assert.match(child.stdout, /自動Recall設定が有効/);
    assert.doesNotMatch(child.stdout, /必ず実行/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('監査ログが書けなくても自動Recall案内を失わない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-auto-recall-audit-failure-'));
  try {
    const env = { ...process.env, PRIORS_AUTO_RECALL: '1', PRIORS_DECISION_AUDIT_FILE: dir, PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl') };
    const child = spawnSync(process.execPath, [HOOK], {
      env, input: JSON.stringify({ prompt: '前回の仕様を再開する', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    assert.match(child.stdout, /自動Recall設定が有効/);
    assert.doesNotMatch(child.stdout, /必ず実行/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('兆候未検出でも低信頼のローカル判定として表示する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-proactive-empty-test-'));
  const file = path.join(dir, 'audit.jsonl');
  try {
    const env = { ...process.env, PRIORS_DECISION_AUDIT_FILE: file };
    const child = spawnSync(process.execPath, [HOOK], {
      env, input: JSON.stringify({ prompt: 'こんにちは', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    assert.match(child.stdout, /出所: local-heuristic/);
    assert.match(child.stdout, /信頼度: 低/);
    assert.match(child.stdout, /未検出は不要の証明ではない/);
    assert.doesNotMatch(child.stdout, /recall-likely|remember-candidate|unresolved-candidate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('代表的な自発候補入力の期待ラベルを回帰評価する', () => {
  const cases = [
    ['前回の仕様を確認する', ['recall-likely']],
    ['この方針を今後も使う', ['remember-candidate']],
    ['未解決の課題を整理する', ['recall-likely', 'unresolved-candidate', 'work-item-candidate']],
    ['次進めてください', ['work-item-candidate']],
  ];
  for (const [prompt, expected] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-proactive-matrix-'));
    try {
      const env = { ...process.env, PRIORS_DECISION_AUDIT_FILE: path.join(dir, 'audit.jsonl'), PRIORS_PROACTIVE_CANDIDATE_FILE: path.join(dir, 'candidates.jsonl') };
      const child = spawnSync(process.execPath, [HOOK], {
        env, input: JSON.stringify({ prompt, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
      });
      assert.equal(child.status, 0, prompt);
      const labels = ['recall-likely', 'remember-candidate', 'unresolved-candidate', 'work-item-candidate']
        .filter((label) => child.stdout.includes(label));
      assert.deepEqual(labels, expected, prompt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('同一turnの候補を重複登録せず、候補キューを直近100件に制限する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-proactive-retention-'));
  const file = path.join(dir, 'audit.jsonl');
  const candidates = path.join(dir, 'candidates.jsonl');
  try {
    const env = { ...process.env, PRIORS_DECISION_AUDIT_FILE: file, PRIORS_PROACTIVE_CANDIDATE_FILE: candidates };
    const prompt = '決定した方針を今後も使う';
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    const turnId = '00000000-0000-4000-8000-000000000001';
    const signals = ['remember-candidate', 'continuing-request-candidate'];
    assert.ok(recordTurnCandidate(promptHash, signals, 'high', turnId, env).event);
    assert.equal(recordTurnCandidate(promptHash, signals, 'high', turnId, env).duplicate, true);
    let lines = fs.readFileSync(candidates, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    for (let i = 0; i < 105; i += 1) {
      const child = spawnSync(process.execPath, [HOOK], {
        env, input: JSON.stringify({ prompt: `決定した方針を今後も使う ${i}`, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
      });
      assert.equal(child.status, 0);
    }
    lines = fs.readFileSync(candidates, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
