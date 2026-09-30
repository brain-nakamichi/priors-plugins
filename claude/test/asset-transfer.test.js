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

test('asset transfer never falls back to a client memory token', async () => {
  const env = { ...process.env, PRIORS_ASSET_ENDPOINT: 'http://127.0.0.1:1', PRIORS_ASSET_TOKEN: '', PRIORS_TOKEN_CLAUDE_V1: 'client-token', PRIORS_TOKEN_CODEX_V1: 'other-client-token' };
  await assert.rejects(run(process.execPath, ['scripts/asset-transfer.js', 'publish', 'missing.md', 'theme-test', 'op-token'], { cwd: path.resolve(__dirname, '..'), env }), /ENOENT/);
  // The helper checks its explicit Asset token before making a request once a file exists.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'priors-asset-token-')); const source = path.join(dir, 'probe.md');
  await fs.writeFile(source, 'token boundary\n');
  try { await assert.rejects(run(process.execPath, ['scripts/asset-transfer.js', 'publish', source, 'theme-test', 'op-token'], { cwd: path.resolve(__dirname, '..'), env }), /asset_transfer_config_missing/); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
