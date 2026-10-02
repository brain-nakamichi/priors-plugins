#!/usr/bin/env node
'use strict';

// Local Markdown ⇄ Priors document sync (GEN-574 §8). Explicit commands only: no watcher, no scan of the disk, no
// upload on every turn. The ledger remembers, per local file, which document / version / hash it was last synced
// with, so the four cases (unchanged / local changed / remote changed / both changed) are told apart and nothing
// is overwritten without a decision.
//
//   node document-sync.js status  <path>
//   node document-sync.js publish <path> --theme T [--key K --title X]     (create when the file is not tracked)
//   node document-sync.js fetch   <path> --theme T (--key K | --id ID) [--version N]
//
// Environment: PRIORS_DOCUMENT_TOKEN (a Priors token of this client; never another client's) and optionally
// PRIORS_MCP_URL (default https://priors-brain9.vercel.app/mcp), PRIORS_DOCUMENT_SYNC_STATE (ledger file),
// PRIORS_DOCUMENT_ROOT (files must be under it; default the current directory).
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const INLINE_LIMIT = 128 * 1024;
const MAX_BYTES = 1048576;
const mcpUrl = () => String(process.env.PRIORS_MCP_URL || 'https://priors-brain9.vercel.app/mcp');
const origin = () => new URL(mcpUrl()).origin;
const token = () => process.env.PRIORS_DOCUMENT_TOKEN || '';
const ledgerFile = () => process.env.PRIORS_DOCUMENT_SYNC_STATE || path.join(os.homedir(), '.priors', 'document-sync.json');
const allowedRoot = () => path.resolve(process.env.PRIORS_DOCUMENT_ROOT || process.cwd());
const fail = (code, extra) => { const e = new Error(code); e.code = code; if (extra) e.extra = extra; throw e; };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function safePath(p) {
  const abs = path.resolve(p);
  const root = allowedRoot();
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) fail('path_outside_root');
  // no symlink / junction anywhere on the way down from the root
  let cur = root;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    try { if (fs.lstatSync(cur).isSymbolicLink()) fail('symlink_refused'); } catch (e) { if (e.code === 'symlink_refused') throw e; break; }
  }
  return abs;
}

// --- ledger with a lock file and atomic replace (several agents may run this at once) ---
async function withLedger(fn) {
  const file = ledgerFile(); await fsp.mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try { const h = await fsp.open(lock, 'wx'); await h.close(); break; } catch (e) {
      if (e.code !== 'EEXIST' || i > 50) fail('ledger_locked');
      try { const st = await fsp.stat(lock); if (Date.now() - st.mtimeMs > 30_000) await fsp.rm(lock, { force: true }); } catch { /* gone */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    let state = {}; try { state = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { state = {}; }
    const out = await fn(state);
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await fsp.rename(tmp, file);
    return out;
  } finally { await fsp.rm(lock, { force: true }); }
}

// --- Priors calls ---
async function rpc(method, params) {
  if (!token()) fail('document_token_missing');
  const res = await fetch(mcpUrl(), { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  if (!res.ok) fail(`mcp_http_${res.status}`);
  const body = await res.json();
  if (body.error) fail('mcp_error', { code: body.error.code });
  const text = body.result?.content?.[0]?.text;
  const out = text ? JSON.parse(text) : null;
  if (body.result?.isError) fail(out?.error || 'tool_error', out?.details ? { details: out.details } : undefined);
  return out;
}
const tool = (name, args) => rpc('tools/call', { name, arguments: args });
async function session(theme) { const o = await tool('context_open', { theme, budget_tokens: 850 }); return o.resolved_session_id; }
async function remoteHead(theme, target) {
  const r = await tool('document', { action: 'read', theme, ...target, max_bytes: 1, offset_bytes: 0 });
  return { document_id: r.document_id, document_key: r.document_key, version: r.head_version, sha256: null, title: r.title, state: r.state };
}
async function remoteVersionMeta(theme, id, version) {
  const r = await tool('document', { action: 'read', theme, document_id: id, ...(version ? { version } : {}), max_bytes: 1, offset_bytes: 0 });
  return r;
}
async function download(theme, id, version) {
  const res = await fetch(`${origin()}/documents/${id}/content?theme=${encodeURIComponent(theme)}${version ? `&version=${version}` : ''}`,
    { redirect: 'error', headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) fail(`document_http_${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const expect = res.headers.get('x-priors-sha256');
  if (!expect || sha256(bytes) !== expect) fail('document_hash_mismatch');
  return { bytes, version: Number(res.headers.get('x-priors-version')), sha256: expect };
}

async function writeRemote(theme, sid, args, bytes) {
  const opId = args.operation_id;
  const send = async () => {
    if (bytes.length <= INLINE_LIMIT) {
      return tool('document', { action: 'write', theme, session_id: sid, ...args, source_base64: bytes.toString('base64') });
    }
    const { document_id: _id, ...metaArgs } = args; // the id travels in the path, never in the meta header
    const meta = Buffer.from(JSON.stringify({ theme, session_id: sid, ...metaArgs }), 'utf8').toString('base64url');
    const url = args.document_id ? `${origin()}/documents/${args.document_id}/content` : `${origin()}/documents/content`;
    const res = await fetch(url, { method: args.document_id ? 'PUT' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'text/markdown; charset=utf-8', 'x-priors-document-meta': meta },
      body: bytes });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) fail(out.error || `document_http_${res.status}`, out.details ? { details: out.details } : undefined);
    return out;
  };
  // a timeout / lost reply: ask again with the same operation_id (the server answers from its receipt), at most twice
  for (let attempt = 0; ; attempt++) {
    try { return await send(); } catch (e) {
      const transient = e.name === 'TypeError' || /^mcp_http_5|^document_http_5/.test(e.code || '');
      if (!transient || attempt >= 2) { if (transient) fail('result_unknown', { operation_id: opId }); throw e; }
    }
  }
}

function classify(row, localSha, remoteHeadVersion) {
  if (!row) return 'untracked';
  if (localSha === null) return 'local_missing';
  const localChanged = localSha !== row.base_sha256;
  const remoteChanged = remoteHeadVersion === null ? null : remoteHeadVersion !== row.base_version;
  if (remoteChanged === null) return localChanged ? 'local_changed_remote_unknown' : 'unknown';
  if (!localChanged && !remoteChanged) return 'up_to_date';
  if (localChanged && !remoteChanged) return 'local_changed';
  if (!localChanged && remoteChanged) return 'remote_changed';
  return 'conflict';
}
async function readLocal(p) { try { return await fsp.readFile(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

async function status(p) {
  const abs = safePath(p);
  const row = await withLedger(async (s) => s[abs]);
  const local = await readLocal(abs);
  let head = null; let reachable = true;
  if (row) { try { head = (await remoteHead(row.theme, { document_id: row.document_id })).version; } catch { reachable = false; } }
  return { path: abs, state: classify(row, local === null ? null : sha256(local), head), tracked: !!row, ...(row ? { document_id: row.document_id,
    document_key: row.document_key, base_version: row.base_version, remote_head: head, last_synced_at: row.synced_at } : {}),
    ...(reachable ? {} : { offline: true, note: 'Priors was not reachable; the local copy is not known to be current' }) };
}

async function publish(p, opts) {
  const abs = safePath(p);
  const bytes = await readLocal(abs); if (bytes === null) fail('local_missing');
  if (bytes.length > MAX_BYTES) fail('document_too_large');
  const row = await withLedger(async (s) => s[abs]);
  const theme = opts.theme || row?.theme; if (!theme) fail('theme_required');
  const localSha = sha256(bytes);
  if (row) {
    const head = await remoteVersionMeta(theme, row.document_id, null);
    const state = classify(row, localSha, head.head_version);
    if (state === 'up_to_date') return { path: abs, state, document_id: row.document_id, version: row.base_version, published: false };
    if (state !== 'local_changed') fail(state === 'conflict' ? 'conflict' : `not_publishable_${state}`, { remote_head: head.head_version, base_version: row.base_version });
  }
  const sid = await session(theme);
  const opId = `docsync-${crypto.randomUUID()}`;
  await withLedger(async (s) => { s[abs] = { ...(s[abs] || {}), theme, stage: 'publishing', operation_id: opId, local_sha256: localSha, updated_at: new Date().toISOString() }; });
  const args = row
    ? { operation_id: opId, document_id: row.document_id, expected_version: row.base_version, expected_sha256: row.base_sha256 }
    : { operation_id: opId, document_key: opts.key || fail('key_required'), title: opts.title || path.basename(abs), expected_version: 0 };
  let out;
  try { out = await writeRemote(theme, sid, args, bytes); } catch (e) {
    await withLedger(async (s) => { s[abs] = { ...(s[abs] || {}), stage: e.code === 'result_unknown' ? 'unknown' : 'failed', last_error: e.code || 'error', updated_at: new Date().toISOString() }; });
    throw e;
  }
  if (out.sha256 !== localSha) fail('document_hash_mismatch');
  await withLedger(async (s) => { s[abs] = { theme, document_id: out.document_id, document_key: out.document_key, base_version: out.version,
    base_sha256: out.sha256, local_sha256: localSha, remote_head: out.version, synced_at: new Date().toISOString(), stage: 'synced' }; });
  return { path: abs, state: 'up_to_date', published: true, document_id: out.document_id, version: out.version, sha256: out.sha256, replayed: !!out.replayed };
}

async function fetchDoc(p, opts) {
  const abs = safePath(p);
  const row = await withLedger(async (s) => s[abs]);
  const theme = opts.theme || row?.theme; if (!theme) fail('theme_required');
  const target = opts.id ? { document_id: opts.id } : opts.key ? { document_key: opts.key } : row ? { document_id: row.document_id } : fail('document_required');
  const meta = await remoteVersionMeta(theme, target.document_id || (await remoteHead(theme, target)).document_id, opts.version || null);
  const got = await download(theme, meta.document_id, meta.version);
  const local = await readLocal(abs);
  const localChanged = local !== null && (!row ? sha256(local) !== got.sha256 : sha256(local) !== row.base_sha256);
  let target_path = abs; let conflict = false;
  if (localChanged) {
    // keep both: the local edit stays where it is, the remote version goes next to it (§8)
    target_path = `${abs}.priors-v${got.version}${path.extname(abs) || '.md'}`; conflict = true;
  }
  await fsp.mkdir(path.dirname(target_path), { recursive: true });
  const tmp = `${target_path}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, got.bytes, { mode: 0o600 });
  if (sha256(await fsp.readFile(tmp)) !== got.sha256) { await fsp.rm(tmp, { force: true }); fail('document_hash_mismatch'); }
  await fsp.rename(tmp, target_path);
  if (!conflict) {
    await withLedger(async (s) => { s[abs] = { theme, document_id: meta.document_id, document_key: meta.document_key, base_version: got.version,
      base_sha256: got.sha256, local_sha256: got.sha256, remote_head: meta.head_version, synced_at: new Date().toISOString(), stage: 'synced' }; });
  }
  return { path: target_path, state: conflict ? 'conflict' : 'up_to_date', document_id: meta.document_id, version: got.version, sha256: got.sha256,
    ...(conflict ? { local_kept: abs, note: 'the local file differs from the last synced base; the remote version was saved next to it' } : {}) };
}

function parse(argv) {
  const [cmd, file, ...rest] = argv; const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]; const v = rest[i + 1];
    if (!/^--(theme|key|title|id|version)$/.test(k || '') || v === undefined) fail('usage');
    o[k.slice(2)] = k === '--version' ? Number(v) : v;
  }
  return { cmd, file, o };
}
async function main(argv) {
  const { cmd, file, o } = parse(argv);
  if (!file) fail('usage');
  if (cmd === 'status') return status(file);
  if (cmd === 'publish') return publish(file, o);
  if (cmd === 'fetch') return fetchDoc(file, o);
  fail('usage');
}
module.exports = { classify, safePath, sha256 };
if (require.main === module) {
  main(process.argv.slice(2)).then((v) => process.stdout.write(JSON.stringify(v) + '\n'))
    .catch((e) => { process.stderr.write(JSON.stringify({ error: e.code || 'document_sync_failed', ...(e.extra || {}) }) + '\n'); process.exitCode = 1; });
}
