'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectSensitiveInput } = require('./sensitive-input.js');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const MAX_FILES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Z][A-Z0-9]{1,7}-c?\d+$/;
const FILE = /^[0-9a-f]{64}\.json$/;

function scopeOf(endpoint, token, theme, workKinds) {
  const match = /^pv1([hias])([A-Za-z0-9_-]{16})[A-Za-z0-9_-]{43}$/.exec(token || '');
  if (!match || !/^[A-Z][A-Z0-9]{1,7}$/.test(theme || '')) return null;
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  const kinds = workKinds || [];
  if (!Array.isArray(kinds) || kinds.length > 64 || !kinds.every((v) => typeof v === 'string' && v.length <= 128)) return null;
  // Hash only PUBLIC scope metadata, never the token/secret or a prompt.
  return { endpoint: url.href, theme, work_kinds: kinds, mode: match[1], key_id: match[2] };
}
function project(payload) {
  if (!payload || !UUID.test(payload.actor_id || '') || typeof payload.actor_id !== 'string' || !payload.frames || typeof payload.frames !== 'object') return null;
  const pick = (items, tierA) => (Array.isArray(items) ? items : []).filter((v) => v && typeof v === 'object' &&
    typeof v.id === 'string' && ID.test(v.id) && Number.isSafeInteger(v.version) && v.version > 0 && (!tierA || v.tier === 'A')).slice(0, 12).map((v) => {
      const title = typeof v.title === 'string' ? v.title : '';
      const body = tierA && typeof v.body === 'string' ? v.body : '';
      // Inspect complete retained fields before truncation, one item at a time.
      // Discarded frames and unresolved bodies never enter the copy.
      const redacted = v.sensitive_omitted === true || inspectSensitiveInput(JSON.stringify({ title, body })).suppress_auto_recall;
      const omission = '秘密らしい文字列のため省略';
      return {
        id: v.id, version: v.version,
        title: redacted ? omission : [...title].slice(0, 200).join(''),
        ...(redacted ? { sensitive_omitted: true } : {}),
        ...(tierA ? { tier: 'A', body: redacted ? omission : [...body].slice(0, 400).join(''), body_omitted: true } : {}),
      };
    });
  const frame = (name, tierA) => {
    const source = payload.frames[name];
    const items = pick(source?.items, tierA);
    const total = Number.isSafeInteger(source?.coverage?.total) && source.coverage.total >= items.length ? source.coverage.total : items.length;
    return { items, coverage: { shown: items.length, total, omitted: true } };
  };
  return { actor_id: payload.actor_id, ...(Number.isSafeInteger(payload.resolved_revision) && payload.resolved_revision >= 0 ? { resolved_revision: payload.resolved_revision } : {}), frames: { pinned: frame('pinned', true), unresolved: frame('unresolved', false) } };
}
function makeCache(options = {}) {
  const env = options.env || process.env;
  if (env.PRIORS_CONTEXT_CACHE !== '1') return null;
  const { home = os.homedir(), endpoint, token, theme, workKinds, now = () => Date.now() } = options;
  const scope = scopeOf(endpoint, token, theme, workKinds);
  if (!scope) return null;
  const key = crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const dir = path.join(home, '.priors', 'context-cache');
  const file = path.join(dir, `${key}.json`);
  function ready(create = false) {
    if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('cache_directory');
    const relative = path.relative(fs.realpathSync(home), fs.realpathSync(dir));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('cache_directory');
    if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('cache_permissions');
  }
  function remove() { try { ready(); fs.unlinkSync(file); } catch { /* Fixed best-effort invalidation. */ } }
  function trim() {
    const entries = fs.readdirSync(dir).filter((name) => FILE.test(name) && name !== `${key}.json`).map((name) => {
      try { return { name, time: fs.lstatSync(path.join(dir, name)).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
    for (const old of entries.slice(MAX_FILES - 1)) { try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* Best effort. */ } }
  }
  return {
    remove,
    save(payload) {
      let temp;
      try {
        const projected = project(payload);
        if (!projected) return false;
        const fetched = now();
        if (!Number.isSafeInteger(fetched) || fetched < 0) return false;
        const data = JSON.stringify({ schema_version: 1, scope, fetched_at: fetched, ...projected });
        if (Buffer.byteLength(data, 'utf8') > MAX_BYTES || inspectSensitiveInput(data).suppress_auto_recall) return false;
        ready(true);
        temp = path.join(dir, `${key}.${crypto.randomUUID()}.tmp`);
        fs.writeFileSync(temp, data, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, file); temp = null;
        trim(); return true;
      } catch { return false; } finally { if (temp) { try { fs.unlinkSync(temp); } catch { /* Own temporary file only. */ } } }
    },
    load() {
      let fd;
      try {
        ready(); const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077))) return null;
        fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(MAX_BYTES + 1);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (length > MAX_BYTES) return null;
        const data = JSON.parse(buffer.subarray(0, length).toString('utf8'));
        const elapsed = now() - data.fetched_at;
        if (data.schema_version !== 1 || JSON.stringify(data.scope) !== JSON.stringify(scope) ||
            !Number.isSafeInteger(data.fetched_at) || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > TTL_MS) return null;
        if (inspectSensitiveInput(JSON.stringify(data)).suppress_auto_recall) return null;
        const projected = project(data);
        return projected ? { ...projected, fetched_at: new Date(data.fetched_at).toISOString() } : null;
      } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* No raw errors. */ } } }
    },
  };
}
module.exports = { makeCache, scopeOf, project, TTL_MS, MAX_BYTES, MAX_FILES };
