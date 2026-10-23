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
const { execFileSync } = require('node:child_process');

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
  if (row?.pending && row.stage === 'merge_installing') {
    return { path:abs, state:'merge_install_pending', tracked:!!row.document_id, operation_id:row.pending.operation_id,
      note:'the merged write is confirmed; run publish to safely finish placing the merged local file' };
  }
  if (row?.pending && (row.stage === 'unknown' || row.stage === 'publishing')) {
    return { path: abs, state: 'publish_result_unknown', tracked: !!row.document_id, operation_id: row.pending.operation_id,
      note: 'an earlier publish has no known result; run publish again to ask the server with the same request' };
  }
  let head = null; let reachable = true;
  if (row) { try { head = (await remoteHead(row.theme, { document_id: row.document_id })).version; } catch { reachable = false; } }
  return { path: abs, state: classify(row, local === null ? null : sha256(local), head), tracked: !!row, ...(row ? { document_id: row.document_id,
    document_key: row.document_key, base_version: row.base_version, remote_head: head, last_synced_at: row.synced_at } : {}),
    ...(reachable ? {} : { offline: true, note: 'Priors was not reachable; the local copy is not known to be current' }) };
}

// --- one sync at a time per local file (publish / fetch of the same path never interleave) ---
async function withPathLock(abs, fn) {
  const dir = path.dirname(ledgerFile()); await fsp.mkdir(dir, { recursive: true });
  const lock = path.join(dir, `document-sync.${sha256(Buffer.from(abs, 'utf8')).slice(0, 24)}.lock`);
  for (let i = 0; ; i++) {
    try { const h = await fsp.open(lock, 'wx'); await h.writeFile(String(process.pid)); await h.close(); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { const st = await fsp.stat(lock); if (Date.now() - st.mtimeMs > 10 * 60_000) { await fsp.rm(lock, { force: true }); continue; } } catch { continue; }
      if (i > 50) fail('path_busy', { note: 'another sync of this file is running' });
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { await fsp.rm(lock, { force: true }); }
}

// --- the exact request of a publish whose result is not known, kept until the server's receipt answers it ---
const pendingDir = () => path.join(path.dirname(ledgerFile()), 'document-sync-pending');
const pendingFile = (opId) => path.join(pendingDir(), `${opId.replace(/[^A-Za-z0-9_-]/g, '')}.bin`);
async function savePending(opId, bytes) {
  await fsp.mkdir(pendingDir(), { recursive: true });
  const tmp = `${pendingFile(opId)}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, bytes, { mode: 0o600 }); await fsp.rename(tmp, pendingFile(opId));
}
async function loadPending(pending) {
  const bytes = await readLocal(pendingFile(pending.operation_id));
  if (bytes === null || sha256(bytes) !== pending.local_sha256) fail('pending_request_lost', { operation_id: pending.operation_id });
  return bytes;
}
const dropPending = (opId) => fsp.rm(pendingFile(opId), { force: true });

/** Send one write and settle the ledger. The request (args + bytes) is saved before sending so that a lost answer can
 *  be asked again later with the same operation_id: the server replays its receipt instead of writing twice. */
async function sendAndSettle(abs, theme, args, bytes, options = {}) {
  const sid = await session(theme);
  let out;
  try { out = await writeRemote(theme, sid, args, bytes); } catch (e) {
    const unknown = e.code === 'result_unknown';
    if (!unknown) await dropPending(args.operation_id);
    await withLedger(async (s) => {
      const { pending: _p, ...rest } = s[abs] || {};
      s[abs] = { ...rest, stage: unknown ? 'unknown' : 'failed', last_error: e.code || 'error', updated_at: new Date().toISOString(),
        ...(unknown ? { pending: _p } : {}) };
    });
    throw e;
  }
  if (out.sha256 !== sha256(bytes)) fail('document_hash_mismatch');
  if (options.keepPending) {
    await withLedger(async (s) => { const row = s[abs] || {}; s[abs] = { ...row, theme, document_id: out.document_id, document_key: out.document_key,
      stage:'merge_installing', updated_at:new Date().toISOString() }; });
  } else {
    await withLedger(async (s) => { s[abs] = { theme, document_id: out.document_id, document_key: out.document_key, base_version: out.version,
      base_sha256: out.sha256, local_sha256: out.sha256, remote_head: out.version, synced_at: new Date().toISOString(), stage: 'synced' }; });
    await dropPending(args.operation_id);
  }
  return out;
}

function strictUtf8(bytes) { if (bytes.length > MAX_BYTES) fail('document_too_large'); try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('document_invalid_utf8'); } }
function strictUtf8Text(bytes) { try { new TextDecoder('utf-8', { fatal:true, ignoreBOM:true }).decode(bytes); } catch { fail('document_invalid_utf8'); } }
function gitMerge(local, base, remote) {
  for (const x of [local, base, remote]) strictUtf8(x);
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'priors-merge-'));
  const resolved = path.resolve(dir), relative = path.relative(tmpRoot, resolved);
  if (!path.basename(resolved).startsWith('priors-merge-') || !relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('merge_temp_unsafe');
  try { const l=path.join(dir,'local'), b=path.join(dir,'base'), r=path.join(dir,'remote'); fs.writeFileSync(l,local); fs.writeFileSync(b,base); fs.writeFileSync(r,remote);
    try { return {clean:true, bytes:execFileSync('git',['merge-file','--stdout','-L','local','-L','base','-L','remote',l,b,r],{encoding:'buffer',maxBuffer:8*MAX_BYTES,stdio:['ignore','pipe','ignore']})}; }
    catch(e) {
      if(Number.isInteger(e.status)&&e.status>=1&&e.status<=127&&Buffer.isBuffer(e.stdout)&&e.stdout.length<=8*MAX_BYTES
        && /<<<<<<< local[\s\S]*=======+[\s\S]*>>>>>>> remote/.test(e.stdout.toString('utf8'))) {
        strictUtf8Text(e.stdout); return {clean:false,bytes:e.stdout};
      }
      throw e;
    }
  } finally { fs.rmSync(resolved,{recursive:true,force:true}); }
}
async function mergeSidecar(abs, bytes, version) { const ext=path.extname(abs)||'.md'; for(let n=1;n<1000;n++){const p=abs+'.priors-merge-v'+version+(n===1?'':'-'+n)+ext; try{await fsp.writeFile(p,bytes,{flag:'wx',mode:0o600});return p;}catch(e){if(e.code!=='EEXIST')throw e;}} fail('no_free_name'); }
async function installMerged(abs, bytes, version, expectedLocalSha) {
  const current = await readLocal(abs);
  if (current && current.equals(bytes)) return { state:'up_to_date', installed:true };
  if (!current || sha256(current) !== expectedLocalSha) {
    const sidecar = await mergeSidecar(abs, bytes, version);
    return { state:'published_local_changed', sidecar, installed:false };
  }
  const tmp = `${abs}.tmp-${process.pid}`; await fsp.writeFile(tmp, bytes, { mode:0o600 });
  try {
    const result = await replaceWithoutLoss(abs, tmp, current);
    const atPath = await readLocal(abs);
    const installed = !!atPath && sha256(atPath) === sha256(bytes);
    if (!installed) {
      const sidecar = await mergeSidecar(abs, bytes, version);
      return { state:'published_local_changed', sidecar, installed:false, ...(result.preserved ? { local_edit_kept_at:result.preserved } : {}) };
    }
    return { state:result.preserved ? 'published_local_changed' : 'up_to_date', installed:true, ...(result.preserved ? { local_edit_kept_at:result.preserved } : {}) };
  } finally { await fsp.rm(tmp, { force:true }); }
}
async function finishMergeLedger(abs, pending, localBytes, out, installed) {
  const saved = pending.merge?.base_snapshot;
  if (!saved) fail('merge_base_snapshot_lost');
  await withLedger(async (s) => {
    const current = s[abs] || {};
    const { pending:_pending, ...rest } = current;
    s[abs] = installed
      ? { ...rest, theme:pending.theme || current.theme, document_id:out.document_id, document_key:out.document_key, base_version:out.version,
        base_sha256:out.sha256, local_sha256:out.sha256, remote_head:out.version, synced_at:new Date().toISOString(), stage:'synced' }
      : { ...rest, base_version:saved.base_version, base_sha256:saved.base_sha256,
        local_sha256:sha256(localBytes || Buffer.alloc(0)), remote_head:out.version, stage:'merge_local_changed', updated_at:new Date().toISOString() };
  });
  await dropPending(pending.operation_id);
}
async function mergeAndPublish(abs,theme,row,local,installInputSha=sha256(local)) {
  const base=await download(theme,row.document_id,row.base_version); if(base.version!==row.base_version||base.sha256!==row.base_sha256) fail('ledger_base_mismatch');
  let meta=await remoteVersionMeta(theme,row.document_id,null);
  for(let attempt=0;attempt<2;attempt++) {
    const remote=await download(theme,row.document_id,meta.head_version); if(remote.version!==meta.head_version||remote.sha256!==meta.sha256) fail('remote_snapshot_mismatch');
    let m; try{m=gitMerge(local,base.bytes,remote.bytes);}catch(e){if(e.code==='document_invalid_utf8'||e.code==='document_too_large')throw e;fail('merge_unavailable',{note:'Git merge-file is unavailable or failed; install Git and retry'});}
    if(!m.clean){const sidecar=await mergeSidecar(abs,m.bytes,remote.version);fail('merge_conflict',{sidecar,remote_version:remote.version,note:'Conflict markers were saved beside the local file; Priors was not written'});}
    strictUtf8(m.bytes); const operation_id='docsync-'+crypto.randomUUID(); const args={operation_id,document_id:row.document_id,expected_version:meta.head_version,expected_sha256:meta.sha256};
    await savePending(operation_id,m.bytes); await withLedger(async s=>{s[abs]={...(s[abs]||{}),stage:'publishing',pending:{theme,args,local_sha256:sha256(m.bytes),operation_id,merge:{input_sha256:installInputSha,base_snapshot:{base_version:row.base_version,base_sha256:row.base_sha256}}},updated_at:new Date().toISOString()};});
    try { const out=await sendAndSettle(abs,theme,args,m.bytes,{keepPending:true}); const installed=await installMerged(abs,m.bytes,out.version,installInputSha);
      await finishMergeLedger(abs,{operation_id,theme,merge:{base_snapshot:{base_version:row.base_version,base_sha256:row.base_sha256}}},await readLocal(abs),out,installed.installed);
      return {...installed,published:true,merged:true,document_id:out.document_id,version:out.version,sha256:out.sha256};
    } catch(e){if(e.code!=='version_conflict')throw e;await dropPending(operation_id);meta=await remoteVersionMeta(theme,row.document_id,null);}
  }
  const sidecar=await mergeSidecar(abs,local,meta.head_version); fail('merge_retry_exhausted',{sidecar,note:'Priors kept changing during compare-and-swap; merge was not published'});
}

async function publish(p, opts) {
  const abs = safePath(p);
  return withPathLock(abs, async () => {
    let row = await withLedger(async (s) => s[abs]);
    const theme = opts.theme || row?.theme; if (!theme) fail('theme_required');
    let resumed = null;
    // a publish whose answer was lost: ask again with the same operation_id and the same bytes before anything else
    if (row?.pending && (row.stage === 'unknown' || row.stage === 'publishing' || row.stage === 'merge_installing')) {
      const pend = row.pending;
      const pendBytes = await loadPending(pend);
      try {
        const out = await sendAndSettle(abs, pend.theme || theme, pend.args, pendBytes, {keepPending:!!pend.merge});
        if (pend.merge?.input_sha256) {
          const installed = await installMerged(abs, pendBytes, out.version, pend.merge.input_sha256);
          await finishMergeLedger(abs,pend,await readLocal(abs),out,installed.installed);
          return { path:abs, ...installed, published:true, merged:true, document_id:out.document_id, version:out.version, sha256:out.sha256,
            resumed:{operation_id:pend.args.operation_id,document_id:out.document_id,version:out.version,replayed:!!out.replayed} };
        }
        resumed = { operation_id: pend.args.operation_id, document_id: out.document_id, version: out.version, replayed: !!out.replayed };
      } catch (e) {
        if (e.code === 'result_unknown') throw e;
        if (e.code === 'version_conflict') {
          const latest = await withLedger(async (s) => s[abs]);
          const current = await readLocal(abs);
          const source = pendBytes;
          if (current && latest?.base_version && latest?.base_sha256) {
            const result = await mergeAndPublish(abs, pend.theme || theme, latest, source, pend.merge?.input_sha256 || sha256(pendBytes));
            return { ...result, resumed:{operation_id:pend.args.operation_id,document_id:pend.args.document_id,version:latest.base_version,replayed:false} };
          }
        }
        fail(e.code === 'version_conflict' ? 'conflict' : (e.code || 'resume_failed'), { resumed_operation_id: pend.args.operation_id,
          note: 'the earlier publish was not applied; check status and publish again' });
      }
      row = await withLedger(async (s) => s[abs]);
    }
    const bytes = await readLocal(abs); if (bytes === null) fail('local_missing');
    if (bytes.length > MAX_BYTES) fail('document_too_large');
    const localSha = sha256(bytes);
    const tracked = row && row.document_id && row.base_sha256;
    if (tracked) {
      const head = await remoteVersionMeta(theme, row.document_id, null);
      const state = classify(row, localSha, head.head_version);
      if (state === 'up_to_date') return { path: abs, state, document_id: row.document_id, version: row.base_version, published: !!resumed, ...(resumed ? { resumed } : {}) };
      if (state === 'conflict') return mergeAndPublish(abs, theme, row, bytes);
      if (state !== 'local_changed') fail(`not_publishable_${state}`, { remote_head: head.head_version, base_version: row.base_version });
    }
    const opId = `docsync-${crypto.randomUUID()}`;
    const args = tracked
      ? { operation_id: opId, document_id: row.document_id, expected_version: row.base_version, expected_sha256: row.base_sha256 }
      : { operation_id: opId, document_key: opts.key || fail('key_required'), title: opts.title || path.basename(abs), expected_version: 0 };
    await savePending(opId, bytes);
    await withLedger(async (s) => { s[abs] = { ...(s[abs] || {}), theme, stage: 'publishing',
      pending: { theme, args, local_sha256: localSha, operation_id: opId }, updated_at: new Date().toISOString() }; });
    let out;
    try { out = await sendAndSettle(abs, theme, args, bytes); }
    catch (e) {
      if (e.code === 'version_conflict' && tracked) {
        const latest = await withLedger(async (s) => s[abs]);
        const current = await readLocal(abs);
        if (current && latest?.base_version && latest?.base_sha256) return mergeAndPublish(abs, theme, latest, bytes, sha256(bytes));
      }
      throw e;
    }
    return { path: abs, state: 'up_to_date', published: true, document_id: out.document_id, version: out.version, sha256: out.sha256,
      replayed: !!out.replayed, ...(resumed ? { resumed } : {}) };
  });
}

/** Put verified bytes next to `abs` under a name nothing else uses (never replaces an existing file). */
async function keepBoth(abs, bytes, version) {
  const ext = path.extname(abs) || '.md';
  for (let n = 1; n < 1000; n++) {
    const candidate = `${abs}.priors-v${version}${n === 1 ? '' : `-${n}`}${ext}`;
    const existing = await readLocal(candidate);
    if (existing !== null) { if (sha256(existing) === sha256(bytes)) return candidate; continue; }
    const tmp = `${candidate}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, bytes, { mode: 0o600 });
    try { await fsp.copyFile(tmp, candidate, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code === 'EEXIST') continue; throw e; } finally { await fsp.rm(tmp, { force: true }); }
    return candidate;
  }
  fail('no_free_name');
}

/** Create `dest` from `src` only if `dest` does not exist (a hard link is atomic and exclusive; copy as a fallback). */
async function createExclusive(src, dest) {
  try { await fsp.link(src, dest); return true; } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP', 'EINVAL'].includes(e.code)) throw e;
  }
  try { await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}

/** Keep a local file under a new name next to `abs` (never over another file). Returns that name. */
async function preserveLocal(abs, from) {
  const ext = path.extname(abs) || '.md';
  for (let n = 1; n < 1000; n++) {
    const candidate = `${abs}.priors-local${n === 1 ? '' : `-${n}`}${ext}`;
    if (await createExclusive(from, candidate)) { await fsp.rm(from, { force: true }); return candidate; }
  }
  fail('no_free_name');
}

/**
 * Replace `abs` (whose content was `before`, or absent) with the verified `tmp`, without ever losing a local edit
 * (GEN-584). Editors do not take our lock, so a plain read-then-rename always leaves a window. Instead:
 *  1. move the current file aside (atomic; on Windows an editor that holds the file open makes this fail → no replace);
 *  2. if what was moved is not `before`, an edit landed first: put it back (or keep it under a new name) → no replace;
 *  3. create `abs` from `tmp` exclusively (if an editor re-created `abs` meanwhile, nothing is overwritten → no replace);
 *  4. look at the moved file once more: unchanged → remove it; written to after step 2 → keep it under a new name.
 * Every interleaving ends with the user's latest text either at `abs` or in a kept file. The trade-off: a replace is
 * refused more often (any concurrent access counts as an edit), and then the remote version is saved next to it.
 */
async function replaceWithoutLoss(abs, tmp, before, hooks = {}) {
  if (before === null) return { placed: await createExclusive(tmp, abs), preserved: null };
  const aside = `${abs}.priors-replacing-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { await fsp.rename(abs, aside); } catch { return { placed: false, preserved: null }; }
  if (hooks.afterAside) await hooks.afterAside(aside);
  const moved = await readLocal(aside);
  if (moved === null || !moved.equals(before)) {
    if (moved !== null && await createExclusive(aside, abs)) { await fsp.rm(aside, { force: true }); return { placed: false, preserved: null }; }
    return { placed: false, preserved: moved === null ? null : await preserveLocal(abs, aside) };
  }
  if (hooks.beforeCreate) await hooks.beforeCreate(aside);
  const placed = await createExclusive(tmp, abs);
  const after = await readLocal(aside);
  if (after !== null && after.equals(before)) { await fsp.rm(aside, { force: true }); return { placed, preserved: null }; }
  return { placed, preserved: after === null ? null : await preserveLocal(abs, aside) };
}

async function fetchDoc(p, opts) {
  const abs = safePath(p);
  return withPathLock(abs, async () => {
    const row = await withLedger(async (s) => s[abs]);
    // an earlier publish whose result is unknown must be settled first: a fetched copy with the same hash is not proof
    // that the request succeeded, and replacing the ledger row would drop the saved request (GEN-584)
    if (row?.pending && (row.stage === 'unknown' || row.stage === 'publishing' || row.stage === 'merge_installing')) {
      fail(row.stage === 'merge_installing' ? 'merge_install_pending' : 'publish_result_unknown', { operation_id: row.pending.operation_id,
        note: row.stage === 'merge_installing' ? 'run publish first; it replays the confirmed merge receipt and safely completes local installation'
          : 'run publish first; it asks the server with the same request and settles it' });
    }
    const theme = opts.theme || row?.theme; if (!theme) fail('theme_required');
    const target = opts.id ? { document_id: opts.id } : opts.key ? { document_key: opts.key } : row?.document_id ? { document_id: row.document_id } : fail('document_required');
    const meta = await remoteVersionMeta(theme, target.document_id || (await remoteHead(theme, target)).document_id, opts.version || null);
    const before = await readLocal(abs);
    const got = await download(theme, meta.document_id, meta.version);
    const baseSha = row?.base_sha256;
    const differs = (local) => local !== null && (baseSha ? sha256(local) !== baseSha : sha256(local) !== got.sha256);
    let conflict = differs(before);
    let preserved = null;
    if (!conflict) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, got.bytes, { mode: 0o600 });
      if (sha256(await fsp.readFile(tmp)) !== got.sha256) { await fsp.rm(tmp, { force: true }); fail('document_hash_mismatch'); }
      // an edit made while downloading, or at any moment of the replace, is kept, never overwritten (§8, GEN-584)
      try {
        const r = await replaceWithoutLoss(abs, tmp, before);
        preserved = r.preserved;
        if (!r.placed) conflict = true;
      } finally { await fsp.rm(tmp, { force: true }); }
    }
    if (conflict) {
      const saved = await keepBoth(abs, got.bytes, got.version);
      return { path: saved, state: 'conflict', document_id: meta.document_id, version: got.version, sha256: got.sha256, local_kept: abs,
        ...(preserved ? { local_edit_kept_at: preserved } : {}),
        note: 'the local file differs from the last synced base (or changed during the fetch); the remote version was saved next to it' };
    }
    await withLedger(async (s) => { s[abs] = { theme, document_id: meta.document_id, document_key: meta.document_key, base_version: got.version,
      base_sha256: got.sha256, local_sha256: got.sha256, remote_head: meta.head_version, synced_at: new Date().toISOString(), stage: 'synced' }; });
    if (preserved) {
      // the remote version is now at the path; an edit written during the very last step was kept under another name
      return { path: abs, state: 'conflict', document_id: meta.document_id, version: got.version, sha256: got.sha256,
        local_kept: preserved, note: 'an edit arrived while the file was being replaced; it was kept under local_kept' };
    }
    return { path: abs, state: 'up_to_date', document_id: meta.document_id, version: got.version, sha256: got.sha256 };
  });
}

function normalizeLf(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
}
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
function repoPath(root, p) {
  if (typeof p !== 'string' || !p || path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.includes(':') || p.includes('\\') || p.split('/').some((x) => !x || x === '.' || x === '..' || x === '~') || /[\x00-\x1f\x7f]/.test(p)) fail('invalid_manifest_path');
  const abs = path.resolve(root, ...p.split('/'));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('invalid_manifest_path');
  return abs;
}
async function auditManifest(manifestFile, repoArg, ref, sourceMode = 'branch', deps = {}) {
  const repo = fs.realpathSync(path.resolve(repoArg));
  const runGit = deps.git || git;
  const readFile = deps.readFile || fsp.readFile;
  const callTool = deps.tool || tool;
  const getDownload = deps.download || download;
  const getGitFile = deps.gitFile || ((r, commit, p) => Buffer.from(execFileSync('git', ['-C', r, 'show', `${commit}:${p}`])));
  const top = path.resolve(runGit(repo, 'rev-parse', '--show-toplevel'));
  if (!fs.statSync(repo).isDirectory() || (process.platform === 'win32' ? top.toLowerCase() !== repo.toLowerCase() : top !== repo)) fail('repo_root_required');
  if (!['branch', 'commit', 'worktree'].includes(sourceMode)) fail('invalid_source_mode');
  if (!ref || !/^[A-Za-z0-9._/-]{1,160}$/.test(ref) || ref.startsWith('/') || ref.includes('//') || ref.split('/').some((p) => p === '.' || p === '..')) fail('invalid_ref');
  if (sourceMode === 'commit' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) fail('commit_mode_requires_oid');
  if (sourceMode === 'worktree' && ref !== 'HEAD') fail('worktree_ref_must_be_HEAD');
  const manifest = JSON.parse(await fsp.readFile(path.resolve(manifestFile), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.documents) || typeof manifest.repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(manifest.repo)) fail('invalid_manifest');
  const out = [];
  for (const row of manifest.documents) {
    if (!row || typeof row.theme !== 'string' || typeof row.document_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.document_id)) fail('invalid_manifest');
    const snapshot = await callTool('document', { action: 'audit_read', theme: row.theme, document_id: row.document_id });
    const expect = { expected_version: Number(snapshot.version), expected_sha256: snapshot.sha256,
      expected_binding_generation: Number(snapshot.binding_generation), expected_observation_generation: Number(snapshot.observation_generation) };
    let status = 'unknown', profile = 'raw-v1', source = null, evidence = 'source_unavailable';
    let worktreePath = null, worktreeHash = null;
    let sourceBytes = null, sourceCommit = null;
    let sourceSha = null;
    if (!row.path) {
      try {
        sourceCommit = sourceMode === 'worktree'
          ? runGit(repo, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}')
          : runGit(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
        if (sourceMode === 'commit' && sourceCommit !== ref) fail('invalid_ref');
      } catch { evidence = 'source_unavailable'; }
    }
    if (row.path) {
      const abs = repoPath(repo, row.path);
      source = { repo: manifest.repo, path: row.path, mode: sourceMode, ref, commit: null, sha256: null };
      // Refuse a symlink or junction at any path segment, including a target outside the repository.
      let cur = repo;
      for (const part of row.path.split('/')) {
        cur = path.join(cur, part);
        try { if (fs.lstatSync(cur).isSymbolicLink()) fail('symlink_refused'); } catch (e) { if (e.code === 'symlink_refused') throw e; break; }
      }
      try {
        if (sourceMode === 'worktree') {
          sourceCommit = runGit(repo, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}');
          source.commit = sourceCommit;
          const before = await readFile(abs); const beforeSha = sha256(before);
          sourceBytes = before;
          if (sha256(await readFile(abs)) !== beforeSha) fail('worktree_changed_during_audit');
          worktreePath = abs; worktreeHash = beforeSha;
        } else {
          sourceCommit = runGit(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
          if (sourceMode === 'commit' && sourceCommit !== ref) fail('invalid_ref');
          source.commit = sourceCommit;
          sourceBytes = Buffer.from(await getGitFile(repo, sourceCommit, row.path));
        }
      } catch (e) {
        if (e.code === 'worktree_changed_during_audit') throw e;
        sourceBytes = null; evidence = 'source_unavailable';
      }
    }
    // A network / server read failure must abort before audit_record, leaving the prior observation intact.
    if (sourceBytes !== null) {
      const localSha = sha256(sourceBytes);
      sourceSha = localSha;
      const remote = await getDownload(row.theme, row.document_id, expect.expected_version);
      if (remote.version !== expect.expected_version || remote.sha256 !== expect.expected_sha256) fail('audit_remote_snapshot_changed');
      if (localSha === remote.sha256) { status = 'matched'; evidence = 'raw_sha256_match'; }
      else {
        let sameNormalized = false;
        try { sameNormalized = sha256(normalizeLf(sourceBytes)) === sha256(normalizeLf(remote.bytes)); } catch { /* invalid UTF-8 cannot use the normalization profile */ }
        if (sameNormalized) { status = 'matched'; profile = 'utf8-crlf-lf-v1'; evidence = 'newline_normalized_match'; }
        else { status = 'different'; evidence = 'content_sha256_differs'; }
      }
      source = { repo: manifest.repo, path: row.path, mode: sourceMode, ref, commit: sourceCommit, sha256: localSha };
    }
    const initial = row.initial;
    if (initial) {
      const tupleMatches = Number(initial.version) === expect.expected_version && initial.sha256 === expect.expected_sha256
        && initial.source_sha256 === sourceSha && initial.source_commit === sourceCommit && (!row.path || sourceBytes !== null);
      status = tupleMatches && ['matched', 'different', 'unknown', 'historical'].includes(initial.status) ? initial.status : 'unknown';
      evidence = row.path && sourceBytes === null ? 'source_unavailable' : 'phase1_review';
      if (['raw-v1', 'utf8-crlf-lf-v1'].includes(initial.comparison_profile)) profile = initial.comparison_profile;
      // Initial classifications are evidence only for their exact version, source bytes, and commit.
      // In particular, an initial unknown is not upgraded by a later byte comparison.
    }
    const audit = { status, source, comparison_profile: profile, checked_at: new Date().toISOString(), evidence };
    if (worktreePath && sha256(await readFile(worktreePath)) !== worktreeHash) fail('worktree_changed_during_audit');
    try {
      const result = await callTool('document', { action: 'audit_record', theme: row.theme, document_id: row.document_id, ...expect, audit });
      out.push({ document_id: row.document_id, status, result });
    } catch (error) {
      // Network failure never changes the persisted server observation.
      if (error?.name === 'TypeError' || /^mcp_http_5/.test(error?.code || '')) fail('audit_result_unknown', { document_id: row.document_id,
        note: 'the server may or may not have recorded the result; read audit_read before retrying' });
      throw error;
    }
  }
  return { audited: out.length, results: out };
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
  if (argv[0] === 'audit') {
    const opts = {}; for (let i = 1; i < argv.length; i += 2) { const k = argv[i], v = argv[i + 1];
      if (!['--manifest', '--repo', '--ref', '--source-mode'].includes(k) || v === undefined) fail('usage'); opts[k.slice(2)] = v; }
    if (!opts.manifest || !opts.repo || !opts.ref) fail('usage');
    return auditManifest(opts.manifest, opts.repo, opts.ref, opts['source-mode'] || 'branch');
  }
  const { cmd, file, o } = parse(argv);
  if (!file) fail('usage');
  if (cmd === 'status') return status(file);
  if (cmd === 'publish') return publish(file, o);
  if (cmd === 'fetch') return fetchDoc(file, o);
  fail('usage');
}
module.exports = { classify, safePath, sha256, replaceWithoutLoss, normalizeLf, repoPath, auditManifest, gitMerge };
if (require.main === module) {
  main(process.argv.slice(2)).then((v) => process.stdout.write(JSON.stringify(v) + '\n'))
    .catch((e) => { process.stderr.write(JSON.stringify({ error: e.code || 'document_sync_failed', ...(e.extra || {}) }) + '\n'); process.exitCode = 1; });
}
