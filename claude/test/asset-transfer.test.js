const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { safeName, mediaType, MAX_BYTES } = require('../scripts/asset-transfer.js');
const run = promisify(execFile);

test('asset transfer keeps safe filenames and known media types', () => {
  assert.equal(safeName('folder/report.md'), 'report.md');
  assert.equal(mediaType('report.md'), 'text/markdown');
  assert.equal(mediaType('sheet.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(MAX_BYTES, 4_500_000);
  assert.throws(() => safeName('bad:name.txt'), /invalid_filename/);
});

test('asset transfer publish/fetch roundtrip preserves bytes', async () => {
  const assetId = 'asset-test-1';
  let bytes = Buffer.alloc(0);
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === '/begin' && req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ upload_id: 'upload-test-1' })); return; }
    if (req.url === '/upload-test-1/upload' && req.method === 'PUT') { bytes = Buffer.concat(chunks); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ asset_id: assetId, state: 'available' })); return; }
    if (req.url === `/${assetId}/status` && req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ asset_id: assetId, state: 'available', byte_size: bytes.length, original_filename: 'probe.md', content_hash: require('node:crypto').createHash('sha256').update(bytes).digest('hex') })); return; }
    if (req.url === `/${assetId}/content` && req.method === 'GET') { res.setHeader('content-type', 'text/markdown'); res.end(bytes); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-test-'));
  const source = path.join(dir, 'probe.md'); const target = path.join(dir, 'download.md'); const state = path.join(dir, 'state.json');
  await fs.writeFile(source, Buffer.from('roundtrip\n', 'utf8'));
  const port = server.address().port;
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: `http://127.0.0.1:${port}`, PRIORS_ASSET_TOKEN: 'test-token', PRIORS_ASSET_TRANSFER_STATE: state };
  try {
    await run(process.execPath, ['scripts/asset-transfer.js', 'publish', source, 'theme-test', 'op-test'], { cwd: path.resolve(__dirname, '..'), env });
    await run(process.execPath, ['scripts/asset-transfer.js', 'fetch', assetId, target], { cwd: path.resolve(__dirname, '..'), env });
    assert.deepEqual(await fs.readFile(source), await fs.readFile(target));
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset fetch requires an explicit destination and refuses existing paths before network access', async (t) => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.statusCode = 500; res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-fetch-path-'));
  const existing = path.join(dir, 'existing.md'); const state = path.join(dir, 'state.json');
  await fs.writeFile(existing, 'keep this file');
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: 'http://127.0.0.1:' + server.address().port, PRIORS_ASSET_TOKEN: 'fetch-token', PRIORS_ASSET_TRANSFER_STATE: state };
  const fetch = (args) => run(process.execPath, ['scripts/asset-transfer.js', 'fetch', 'asset-fetch', ...args], { cwd: path.resolve(__dirname, '..'), env });
  try {
    await assert.rejects(fetch([]), /asset_destination_required/);
    await assert.rejects(fetch([existing]), /asset_destination_exists/);
    assert.equal(await fs.readFile(existing, 'utf8'), 'keep this file');
    assert.equal(requests, 0);

    const sentinel = path.join(dir, 'sentinel.md'); const link = path.join(dir, 'link.md');
    await fs.writeFile(sentinel, 'symlink target stays unchanged');
    try { await fs.symlink(sentinel, link, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { t.skip('symlink creation is not permitted here'); return; }
      throw error;
    }
    await assert.rejects(fetch([link]), /asset_destination_exists/);
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'symlink target stays unchanged');
    assert.equal(requests, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset fetch rejects Windows reserved metadata names before downloading content', async () => {
  const reserved = ['CON', 'prn', 'nul.txt', 'Aux.tar.gz', 'COM1.md', 'COM9.old.ext', 'lpt1', 'lpt9.', 'con .txt'];
  let contentRequests = 0;
  let filename = reserved[0];
  const server = http.createServer((req, res) => {
    if (req.url === '/asset-reserved/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ state: 'available', byte_size: 1, original_filename: filename }));
      return;
    }
    if (req.url === '/asset-reserved/content') contentRequests++;
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-reserved-'));
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: 'http://127.0.0.1:' + server.address().port, PRIORS_ASSET_TOKEN: 'fetch-token', PRIORS_ASSET_TRANSFER_STATE: path.join(dir, 'state.json') };
  try {
    for (let index = 0; index < reserved.length; index++) {
      filename = reserved[index];
      const target = path.join(dir, 'download-' + index + '.bin');
      await assert.rejects(run(process.execPath, ['scripts/asset-transfer.js', 'fetch', 'asset-reserved', target], { cwd: path.resolve(__dirname, '..'), env }), /invalid_filename/);
      assert.equal(await fs.stat(target).then(() => true, () => false), false);
    }
    assert.equal(contentRequests, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset fetch exclusively installs output and removes its temp file after a destination race', async () => {
  let target = '';
  const body = Buffer.from('download bytes');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/asset-race/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ state: 'available', byte_size: body.length, original_filename: 'remote.md' }));
      return;
    }
    if (req.url === '/asset-race/content') {
      await fs.writeFile(target, 'raced-in file');
      res.end(body);
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-race-'));
  target = path.join(dir, 'download.md');
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: 'http://127.0.0.1:' + server.address().port, PRIORS_ASSET_TOKEN: 'fetch-token', PRIORS_ASSET_TRANSFER_STATE: path.join(dir, 'state.json') };
  try {
    await assert.rejects(run(process.execPath, ['scripts/asset-transfer.js', 'fetch', 'asset-race', target], { cwd: path.resolve(__dirname, '..'), env }), /asset_destination_exists/);
    assert.equal(await fs.readFile(target, 'utf8'), 'raced-in file');
    assert.deepEqual((await fs.readdir(dir)).filter((name) => name.includes('.tmp-')), []);
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset transfer does not mark a failed scan as available', async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/begin' && req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ upload_id: 'upload-failed-1' })); return; }
    if (req.url === '/upload-failed-1/upload' && req.method === 'PUT') { for await (const _chunk of req) {} res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ asset_id: 'asset-failed-1', state: 'failed' })); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-failed-'));
  const source = path.join(dir, 'probe.md'); const state = path.join(dir, 'state.json');
  await fs.writeFile(source, Buffer.from('blocked\n', 'utf8'));
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: `http://127.0.0.1:${server.address().port}`, PRIORS_ASSET_TOKEN: 'test-token', PRIORS_ASSET_TRANSFER_STATE: state };
  try {
    await assert.rejects(run(process.execPath, ['scripts/asset-transfer.js', 'publish', source, 'theme-test', 'op-failed'], { cwd: path.resolve(__dirname, '..'), env }), /asset_not_available/);
    const saved = JSON.parse(await fs.readFile(state, 'utf8'));
    assert.equal(saved['op-failed'].stage, 'failed');
    assert.equal(saved['op-failed'].failure_state, 'failed');
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset transfer replay and resume require the original scope and payload', async () => {
  let begins = 0; let uploads = 0; let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests++;
    if (req.url === '/begin' && req.method === 'POST') {
      begins++; for await (const _chunk of req) {}
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ upload_id: `upload-${begins}` })); return;
    }
    if (req.url.endsWith('/upload') && req.method === 'PUT') {
      uploads++; for await (const _chunk of req) {}
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ asset_id: 'asset-bound', state: 'available' })); return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-binding-'));
  const source = path.join(dir, 'original.md'); const renamed = path.join(dir, 'renamed.md'); const state = path.join(dir, 'state.json');
  await fs.writeFile(source, 'same bytes\n'); await fs.writeFile(renamed, 'same bytes\n');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: endpoint, PRIORS_ASSET_TOKEN: 'binding-token-a', PRIORS_ASSET_TRANSFER_STATE: state };
  const publish = (file, theme, token = 'binding-token-a', target = endpoint) => run(process.execPath,
    ['scripts/asset-transfer.js', 'publish', file, theme, 'op-bound'], { cwd: path.resolve(__dirname, '..'), env: { ...env, PRIORS_ASSET_TOKEN: token, PRIORS_ASSET_ENDPOINT: target } });
  const resume = (theme, token = 'binding-token-a', target = endpoint) => run(process.execPath,
    ['scripts/asset-transfer.js', 'resume', 'op-bound', theme], { cwd: path.resolve(__dirname, '..'), env: { ...env, PRIORS_ASSET_TOKEN: token, PRIORS_ASSET_ENDPOINT: target } });
  try {
    const first = await publish(source, 'theme-a');
    assert.equal(first.stdout.includes('credential_fingerprint'), false);
    assert.equal(first.stdout.includes('endpoint_fingerprint'), false);
    const saved = JSON.parse(await fs.readFile(state, 'utf8'))['op-bound'];
    assert.equal(saved.credential_fingerprint.includes('binding-token-a'), false);
    assert.equal(JSON.stringify(saved).includes('binding-token-a'), false);
    await publish(source, 'theme-a');
    await assert.rejects(publish(source, 'theme-b'), /asset_transfer_scope_mismatch/);
    await assert.rejects(publish(source, 'theme-a', 'binding-token-b'), /asset_transfer_scope_mismatch/);
    await assert.rejects(publish(source, 'theme-a', 'binding-token-a', 'http://127.0.0.1:1'), /asset_transfer_scope_mismatch/);
    await assert.rejects(publish(renamed, 'theme-a'), /asset_transfer_payload_mismatch/);
    await assert.rejects(resume('theme-b'), /asset_transfer_scope_mismatch/);
    await assert.rejects(resume('theme-a', 'binding-token-b'), /asset_transfer_scope_mismatch/);
    await assert.rejects(resume('theme-a', 'binding-token-a', 'http://127.0.0.1:1'), /asset_transfer_scope_mismatch/);
    await resume('theme-a');
    for (const malformed of [endpoint + '#fragment', endpoint + '#', endpoint + '?mode=other', endpoint + '?']) {
      const before = requests;
      await assert.rejects(publish(source, 'theme-a', 'binding-token-a', malformed), /asset_transfer_config_invalid/);
      await assert.rejects(resume('theme-a', 'binding-token-a', malformed), /asset_transfer_config_invalid/);
      assert.equal(requests, before, 'invalid endpoint made a request');
    }
    await fs.writeFile(source, 'edited bytes\n');
    await assert.rejects(resume('theme-a'), /asset_transfer_payload_mismatch/);
    assert.equal(begins, 1); assert.equal(uploads, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset transfer refuses legacy unbound state rows', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-legacy-'));
  const source = path.join(dir, 'probe.md'); const state = path.join(dir, 'state.json');
  await fs.writeFile(source, 'legacy\n');
  await fs.writeFile(state, JSON.stringify({ old: { operation_id: 'old', stage: 'available', sha256: 'anything', local_path: source } }));
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: 'http://127.0.0.1:1', PRIORS_ASSET_TOKEN: 'legacy-test', PRIORS_ASSET_TRANSFER_STATE: state };
  try { await assert.rejects(run(process.execPath, ['scripts/asset-transfer.js', 'publish', source, 'theme-test', 'old'], { cwd: path.resolve(__dirname, '..'), env }), /asset_transfer_legacy_binding_missing/); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset transfer never falls back to a client memory token', async () => {
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: 'http://127.0.0.1:1', PRIORS_ASSET_TOKEN: '', PRIORS_TOKEN_CLAUDE_V1: 'client-token', PRIORS_TOKEN_CODEX_V1: 'other-client-token' };
  await assert.rejects(run(process.execPath, ['scripts/asset-transfer.js', 'publish', 'missing.md', 'theme-test', 'op-token'], { cwd: path.resolve(__dirname, '..'), env }), /ENOENT/);
  // The helper checks its explicit Asset token before making a request once a file exists.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-token-')); const source = path.join(dir, 'probe.md');
  await fs.writeFile(source, 'token boundary\n');
  try { await assert.rejects(run(process.execPath, ['scripts/asset-transfer.js', 'publish', source, 'theme-test', 'op-token'], { cwd: path.resolve(__dirname, '..'), env }), /asset_transfer_config_missing/); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
