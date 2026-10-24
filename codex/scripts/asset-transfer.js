#!/usr/bin/env node
'use strict';

// Small, explicit Asset transfer helper. It never uses a Supabase key.
// Endpoint and bearer token must be supplied by the caller's environment.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 4_500_000;
const stateFile = () => process.env.PRIORS_ASSET_TRANSFER_STATE || path.join(process.cwd(), '.priors', 'asset-transfers.json');
const endpoint = () => String(process.env.PRIORS_ASSET_ENDPOINT || '').replace(/\/+$/u, '');
// Asset transfers must use an explicitly scoped Asset token. Never fall back to
// another client's general memory token: doing so can attribute a write to the
// wrong actor and bypass the ownership boundary.
const token = () => process.env.PRIORS_ASSET_TOKEN || '';
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
function requestContext() {
  const rawEndpoint = String(process.env.PRIORS_ASSET_ENDPOINT || '');
  const url = endpoint(); const bearer = token();
  if (!url || !bearer) fail('asset_transfer_config_missing');
  // URL fragments never reach the server and query strings can select a
  // different endpoint. Reject both delimiters, including empty values.
  if (/[?#]/u.test(rawEndpoint)) fail('asset_transfer_config_invalid');
  let parsed;
  try { parsed = new URL(url); } catch { fail('asset_transfer_config_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('asset_transfer_config_invalid');
  parsed.hash = '';
  const normalized = parsed.protocol + '//' + parsed.host + parsed.pathname.replace(/\/+$/u, '') + parsed.search;
  // Store one-way discriminators only. Never persist a URL that could contain
  // sensitive query parameters or the bearer itself.
  return {
    endpoint_fingerprint: crypto.createHash('sha256').update(normalized, 'utf8').digest('hex'),
    credential_fingerprint: crypto.createHash('sha256').update(bearer, 'utf8').digest('hex'),
  };
}
function validateBinding(row, expected) {
  if (!row || typeof row.endpoint_fingerprint !== 'string' || typeof row.theme_id !== 'string'
    || typeof row.credential_fingerprint !== 'string' || typeof row.filename !== 'string'
    || !Number.isSafeInteger(row.byte_size) || typeof row.sha256 !== 'string') fail('asset_transfer_legacy_binding_missing');
  if (row.endpoint_fingerprint !== expected.endpoint_fingerprint || row.theme_id !== expected.theme_id
    || row.credential_fingerprint !== expected.credential_fingerprint) fail('asset_transfer_scope_mismatch');
  if (row.filename !== expected.filename || row.byte_size !== expected.byte_size || row.sha256 !== expected.sha256) fail('asset_transfer_payload_mismatch');
}
function publicReceipt(row, replayed) {
  const { operation_id, stage, upload_id, local_path, filename, byte_size, sha256, asset_id, failure_state, updated_at } = row;
  return { operation_id, stage, upload_id, local_path, filename, byte_size, sha256, asset_id, failure_state, updated_at, replayed };
}
function safeName(value) {
  if (typeof value !== 'string') fail('invalid_filename');
  const name = path.basename(value);
  if (!name || name === '.' || name === '..' || /[\0<>:"/\\|?*]/u.test(name)) fail('invalid_filename');
  const windowsName = name.replace(/[. ]+$/u, '');
  const stem = (windowsName.split('.', 1)[0] || '').replace(/[. ]+$/u, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) fail('invalid_filename');
  return name;
}
function mediaType(name) { const ext = path.extname(name).toLowerCase(); return ({'.md':'text/markdown','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})[ext] || 'application/octet-stream'; }
async function readState() { try { return JSON.parse(await fsp.readFile(stateFile(), 'utf8')); } catch { return {}; } }
async function writeState(state) { const file = stateFile(); await fsp.mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${process.pid}`; await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await fsp.rename(tmp, file); }
function headers(extra={}) { const t = token(); if (!endpoint() || !t) fail('asset_transfer_config_missing'); return { authorization: `Bearer ${t}`, ...extra }; }
async function request(url, init={}) { const response = await fetch(url, { redirect: 'error', ...init, headers: headers(init.headers || {}) }); if (!response.ok) fail(`asset_http_${response.status}`); return response; }
async function publish(file, themeId, idempotencyKey) {
  const localPath = path.resolve(file); const name = safeName(path.basename(localPath)); const bytes = await fsp.readFile(localPath); if (!bytes.length || bytes.length > MAX_BYTES) fail('invalid_size');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex'); const state = await readState(); const key = idempotencyKey || crypto.randomUUID();
  const binding = { ...requestContext(), theme_id: String(themeId || ''), filename: name, byte_size: bytes.length, sha256: hash };
  const existing = state[key];
  if (existing) {
    validateBinding(existing, binding);
    if (existing.stage === 'available') return publicReceipt(existing, true);
  }
  const begun = await request(`${endpoint()}/begin`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ theme_id: themeId, filename: name, byte_size: bytes.length, idempotency_key: key }) });
  const begin = await begun.json(); const uploadId = begin?.upload_id; if (typeof uploadId !== 'string') fail('asset_begin_invalid');
  state[key] = { operation_id:key, ...binding, stage:'begun', upload_id:uploadId, local_path:localPath, updated_at:new Date().toISOString() }; await writeState(state);
  const uploaded = await request(`${endpoint()}/${encodeURIComponent(uploadId)}/upload`, { method:'PUT', headers:{'content-type':mediaType(name)}, body:bytes });
  const result = await uploaded.json(); const assetId = result?.asset_id;
  if (result?.state !== 'available') {
    state[key] = { ...state[key], stage:'failed', asset_id: typeof assetId === 'string' ? assetId : undefined, failure_state: result?.state || 'unknown', updated_at:new Date().toISOString() };
    await writeState(state);
    fail('asset_not_available');
  }
  if (typeof assetId !== 'string') fail('asset_upload_invalid');
  state[key] = { ...state[key], stage:'available', asset_id:assetId, updated_at:new Date().toISOString() }; await writeState(state);
  return publicReceipt(state[key], false);
}
async function fetchAsset(assetId, destination) {
  if (typeof destination !== 'string' || !destination.trim()) fail('asset_destination_required');
  const target = path.resolve(destination); safeName(path.basename(target));
  const dir = path.dirname(target);
  try { await fsp.lstat(target); fail('asset_destination_exists'); }
  catch (error) {
    if (error?.code === 'asset_destination_exists') throw error;
    if (error?.code !== 'ENOENT') fail('asset_destination_unavailable');
  }
  const status = await (await request(`${endpoint()}/${encodeURIComponent(assetId)}/status`)).json(); if (status?.state !== 'available') fail('asset_not_available');
  const filename = safeName(status.original_filename || `${assetId}.bin`);
  const response = await request(`${endpoint()}/${encodeURIComponent(assetId)}/content`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== Number(status.byte_size)) fail('asset_size_mismatch');
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  if (status.content_hash && String(status.content_hash).replace(/^\\x/u,'') !== hash) fail('asset_hash_mismatch');
  await fsp.mkdir(dir, { recursive:true }).catch(() => fail('asset_destination_write_failed'));
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fsp.writeFile(tmp, body, { mode:0o600, flag:'wx' });
    try { await fsp.copyFile(tmp, target, fs.constants.COPYFILE_EXCL); }
    catch (error) {
      if (error?.code === 'EEXIST') fail('asset_destination_exists');
      fail('asset_destination_write_failed');
    }
  } catch (error) {
    if (error?.code === 'asset_destination_exists' || error?.code === 'asset_destination_write_failed') throw error;
    fail('asset_destination_write_failed');
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
  return { asset_id:assetId, local_path:target, filename, byte_size:body.length, sha256:hash };
}
async function main(argv) { const [command, ...args] = argv; if (command === 'publish') return publish(args[0], args[1], args[2]); if (command === 'fetch') return fetchAsset(args[0], args[1]); if (command === 'resume') { const state = await readState(); const key = args[0]; const themeId = args[1]; if (!key || !state[key]) fail('transfer_not_found'); if (!themeId) fail('asset_transfer_theme_required'); const row = state[key]; const context = requestContext(); const file = row.local_path ? path.resolve(row.local_path) : ''; if (!file) fail('resume_local_path_missing'); let bytes; try { bytes = await fsp.readFile(file); } catch { fail('resume_local_path_missing'); } if (!bytes.length || bytes.length > MAX_BYTES) fail('invalid_size'); validateBinding(row, { ...context, theme_id: String(themeId), filename: safeName(path.basename(file)), byte_size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }); if (row.stage === 'available') return publicReceipt(row, true); return publish(file, themeId, key); } fail('usage'); }
module.exports = { safeName, mediaType, MAX_BYTES };
if (require.main === module) main(process.argv.slice(2)).then((value) => { process.stdout.write(JSON.stringify(value) + '\n'); }).catch((error) => { process.stderr.write(JSON.stringify({ error: error.code || 'asset_transfer_failed' }) + '\n'); process.exitCode = 1; });
