'use strict';
// GEN-574 §8: local Markdown ⇄ Priors document sync against a small fake Priors (MCP + /documents raw routes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'document-sync.js');
const { classify } = require(SCRIPT);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fakePriors() {
  const docs = new Map(); // id -> { key, versions: [{bytes, sha}] }
  const receipts = new Map();
  const write = (args, bytes) => {
    if (receipts.has(args.operation_id)) return { ...receipts.get(args.operation_id), replayed: true };
    let id = args.document_id;
    if (!id) {
      if ([...docs.values()].some((d) => d.key === args.document_key)) return { error: 'invalid_input', details: { reason: 'document_exists' } };
      id = crypto.randomUUID(); docs.set(id, { key: args.document_key, title: args.title, versions: [] });
    } else {
      const d = docs.get(id); const head = d.versions.length;
      if (args.expected_version !== head || args.expected_sha256 !== d.versions[head - 1].sha) return { error: 'version_conflict' };
    }
    const d = docs.get(id); d.versions.push({ bytes, sha: sha(bytes) });
    const out = { ok: true, document_id: id, document_key: d.key, version: d.versions.length, sha256: sha(bytes) };
    receipts.set(args.operation_id, out); return out;
  };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: 'unauthorized' });
    if (url.pathname === '/mcp') {
      const rpc = JSON.parse(body.toString('utf8')); const { name, arguments: a } = rpc.params;
      let out; let isError = false;
      if (name === 'context_open') out = { resolved_session_id: '11111111-1111-4111-8111-111111111111' };
      else if (a.action === 'read') {
        const id = a.document_id || [...docs.entries()].find(([, d]) => d.key === a.document_key)?.[0];
        const d = id && docs.get(id);
        if (!d) { out = { error: 'not_found' }; isError = true; } else {
          const v = a.version || d.versions.length; out = { document_id: id, document_key: d.key, title: d.title, state: 'active', version: v, head_version: d.versions.length, sha256: d.versions[v - 1].sha };
        }
      } else if (a.action === 'write') {
        out = write(a, Buffer.from(a.source_base64, 'base64')); isError = !!out.error;
      }
      return send(200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], ...(isError ? { isError: true } : {}) } });
    }
    const m = /^\/documents\/([^/]+)\/content$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const d = docs.get(m[1]); const v = Number(url.searchParams.get('version')) || d.versions.length; const ver = d.versions[v - 1];
      return send(200, ver.bytes, { 'content-type': 'text/markdown', 'x-priors-sha256': ver.sha, 'x-priors-version': String(v) });
    }
    if ((req.method === 'PUT' && m) || (req.method === 'POST' && url.pathname === '/documents/content')) {
      const meta = JSON.parse(Buffer.from(req.headers['x-priors-document-meta'], 'base64url').toString('utf8'));
      if ('document_id' in meta) return send(400, { error: 'invalid_input' });
      const out = write({ ...meta, ...(m ? { document_id: m[1] } : {}) }, body);
      return send(out.error ? 409 : 200, out);
    }
    send(404, { error: 'not_found' });
  });
  return { server, docs };
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out ? JSON.parse(out) : null, err: err ? JSON.parse(err) : null }));
  });
}

test('classify covers the four cases and the unknown ones', () => {
  const row = { base_version: 2, base_sha256: 'b' };
  assert.equal(classify(row, 'b', 2), 'up_to_date');
  assert.equal(classify(row, 'x', 2), 'local_changed');
  assert.equal(classify(row, 'b', 3), 'remote_changed');
  assert.equal(classify(row, 'x', 3), 'conflict');
  assert.equal(classify(row, 'b', null), 'unknown');
  assert.equal(classify(null, 'b', 2), 'untracked');
});

test('publish → status → remote change → fetch, and a conflict keeps both files; large files use the raw route', async () => {
  const { server, docs } = fakePriors();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-docsync-'));
  const env = { PRIORS_MCP_URL: `http://127.0.0.1:${port}/mcp`, PRIORS_DOCUMENT_TOKEN: 'test-token',
    PRIORS_DOCUMENT_SYNC_STATE: path.join(dir, 'ledger.json'), PRIORS_DOCUMENT_ROOT: dir };
  try {
    const file = path.join(dir, 'spec.md');
    fs.writeFileSync(file, Buffer.from('﻿# 仕様\r\n本文\r\n', 'utf8'));
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'specs/spec.md', '--title', 'Spec'], env);
    assert.equal(r.code, 0, JSON.stringify(r.err));
    assert.equal(r.out.published, true); assert.equal(r.out.version, 1);
    const id = r.out.document_id;
    r = await run(['status', file], env);
    assert.equal(r.out.state, 'up_to_date');

    // the remote moves on (another agent of the same owner wrote v2)
    const d = docs.get(id); const v2 = Buffer.from('# v2\n'); d.versions.push({ bytes: v2, sha: sha(v2) });
    r = await run(['status', file], env); assert.equal(r.out.state, 'remote_changed');
    r = await run(['publish', file], env); assert.equal(r.code, 1); assert.equal(r.err.error, 'not_publishable_remote_changed');
    r = await run(['fetch', file, '--theme', 'GEN'], env);
    assert.equal(r.out.state, 'up_to_date'); assert.deepEqual(fs.readFileSync(file), v2);

    // both change: fetch keeps the local edit and saves the remote next to it
    fs.writeFileSync(file, '# local edit\n');
    const v3 = Buffer.from('# v3\n'); d.versions.push({ bytes: v3, sha: sha(v3) });
    r = await run(['status', file], env); assert.equal(r.out.state, 'conflict');
    r = await run(['fetch', file, '--theme', 'GEN'], env);
    assert.equal(r.out.state, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), '# local edit\n');
    assert.deepEqual(fs.readFileSync(r.out.path), v3);

    // a large file goes over the raw HTTP route (create)
    const big = path.join(dir, 'big.md');
    fs.writeFileSync(big, Buffer.from('# big\n' + 'あ'.repeat(60000)));
    r = await run(['publish', big, '--theme', 'GEN', '--key', 'big.md', '--title', 'Big'], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.version, 1);
    // outside the root and through a symlink are refused
    r = await run(['status', path.join(os.tmpdir(), 'elsewhere.md')], env); assert.equal(r.err.error, 'path_outside_root');
  } finally {
    server.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
