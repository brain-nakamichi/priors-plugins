'use strict';
// Read-only diagnosis of Codex 0.165.0 user hook state. Never writes trust/config or launches Codex.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const EVENTS = { SessionStart: 'session_start', UserPromptSubmit: 'user_prompt_submit', PostToolUse: 'post_tool_use', Stop: 'stop' };
const HASH = /^sha256:[0-9a-f]{64}$/;
const DAY = 86400000;
function digest(bytes) { return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'); }
function stableJson(x) {
  if (Array.isArray(x)) return '[' + x.map(stableJson).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableJson(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
function readStable(file, limit) {
  const a = fs.lstatSync(file);
  if (!a.isFile() || a.isSymbolicLink() || a.size > limit) throw Error('unsupported_file');
  const bytes = fs.readFileSync(file), b = fs.lstatSync(file);
  if (bytes.length !== a.size || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ino !== b.ino) throw Error('changed_file');
  return bytes;
}
function lengthPrefix(hash, bytes) { const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(bytes.length)); hash.update(n); hash.update(bytes); }

// hooks/engine/plugin_fingerprint.rs. Raw bytes, native relative separators, sorted depth-first traversal.
function contentHash(root) {
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw Error('unsupported_root');
  const hash = crypto.createHash('sha256').update('codex-plugin-bundle-v1');
  const pending = [root]; let count = 0, total = 0;
  while (pending.length) {
    const file = pending.pop(), rel = path.relative(root, file), name = path.basename(file);
    if (rel && (['__pycache__', '.venv'].includes(name) || name.endsWith('.pyc') || name.endsWith('.egg-info'))) continue;
    // Bundled Priors paths are ASCII. Other OS string encodings are deliberately not guessed.
    if (!/^[\x20-\x7e]*$/.test(rel) || ++count > 4096) throw Error('unsupported_bundle');
    lengthPrefix(hash, Buffer.from(rel));
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error('unsupported_entry');
    if (stat.isDirectory()) {
      hash.update('directory');
      const entries = fs.readdirSync(file).sort();
      for (const entry of entries.reverse()) pending.push(path.join(file, entry));
    } else if (stat.isFile()) {
      hash.update('file'); const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(stat.size)); hash.update(n);
      total += stat.size; if (total > 32 * 1024 * 1024) throw Error('bundle_limit');
      hash.update(readStable(file, 8 * 1024 * 1024));
    } else throw Error('unsupported_entry');
  }
  return 'sha256:' + hash.digest('hex');
}

// The supported package has one ordinary command handler per event. Refuse unfamiliar declarations.
function declarationHashes(root) {
  const config = JSON.parse(readStable(path.join(root, 'hooks/hooks.json'), 65536));
  if (!config.hooks || Object.keys(config.hooks).sort().join() !== Object.keys(EVENTS).sort().join()) throw Error('unknown_events');
  return Object.entries(EVENTS).map(([event, label]) => {
    const groups = config.hooks[event];
    if (!Array.isArray(groups) || groups.length !== 1 || groups[0].hooks?.length !== 1 ||
      Object.keys(groups[0]).some(k => !['matcher', 'hooks'].includes(k))) throw Error('unknown_group');
    const g = groups[0], h = g.hooks[0];
    if (Object.keys(h).some(k => !['type', 'command', 'timeout', 'async'].includes(k)) ||
      h.type !== 'command' || typeof h.command !== 'string' || h.timeout !== 10 ||
      h.async !== undefined && typeof h.async !== 'boolean' || g.matcher !== undefined && typeof g.matcher !== 'string') throw Error('unknown_handler');
    if (g.matcher !== undefined && event !== 'PostToolUse') throw Error('unknown_matcher');
    // TomlValue serialization omits absent Options; version_for_toml sorts all JSON object keys.
    const identity = { event_name: label, hooks: [{ type: 'command', command: h.command, timeout: 10, async: h.async ?? false }] };
    if (g.matcher !== undefined) identity.matcher = g.matcher;
    return { event, key: `priors@priors:hooks/hooks.json:${label}:0:0`, hash: digest(stableJson(identity)) };
  });
}

// Conservative single-line TOML subset: current Codex-generated scalar state tables.
// Unsupported syntax anywhere (including multiline strings/arrays) is unknown, never "untrusted".
function cleanLine(raw) {
  let quote = '', escape = false, depth = 0, out = '';
  if (raw.includes('"""') || raw.includes("'''")) throw Error('multiline');
  for (const ch of raw) {
    if (quote) {
      out += ch;
      if (escape) escape = false;
      else if (quote === '"' && ch === '\\') escape = true;
      else if (ch === quote) quote = '';
    } else if (ch === '#') break;
    else { out += ch; if (ch === '"' || ch === "'") quote = ch; else if ('[{'.includes(ch)) depth++; else if (']}'.includes(ch)) depth--; }
  }
  if (quote || depth !== 0) throw Error('unsupported_line');
  return out.trim();
}
function keyParts(text) {
  const parts = []; let rest = text.trim();
  while (rest) {
    let match, value;
    if (rest[0] === '"') { match = /^"(?:[^"\\\r\n]|\\(?:["\\bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(rest); if (!match) throw Error('quoted_key'); value = JSON.parse(match[0]); }
    else if (rest[0] === "'") { match = /^'[^'\r\n]*'/.exec(rest); if (!match) throw Error('literal_key'); value = match[0].slice(1, -1); }
    else { match = /^[A-Za-z0-9_-]+/.exec(rest); if (!match) throw Error('bare_key'); value = match[0]; }
    parts.push(value); rest = rest.slice(match[0].length).trim();
    if (!rest) break; if (rest[0] !== '.') throw Error('key_separator'); rest = rest.slice(1).trim(); if (!rest) throw Error('empty_key');
  }
  if (!parts.length) throw Error('empty_key'); return parts;
}
function parseUserState(text) {
  let section = []; const states = new Map(), seen = new Set();
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = cleanLine(raw); if (!line) continue;
    if (line.startsWith('[')) {
      if (!line.endsWith(']') || line.startsWith('[[')) throw Error('unknown_table');
      section = keyParts(line.slice(1, -1));
      if (section[0] === 'profiles' && section.includes('hooks')) throw Error('profile_override');
      if (section[0] === 'hooks' && !(['hooks', 'hooks.state'].includes(section.join('.')) || section.length === 3 && section[1] === 'state')) throw Error('unknown_hook_config');
      if (section.length === 3 && section[0] === 'hooks' && section[1] === 'state') {
        if (states.has(section[2].trim())) throw Error('duplicate_state'); states.set(section[2].trim(), {});
      }
      continue;
    }
    const eq = line.indexOf('='); if (eq < 1) throw Error('unknown_assignment');
    const keys = keyParts(line.slice(0, eq)), full = [...section, ...keys];
    const unique = JSON.stringify(full); if (seen.has(unique)) throw Error('duplicate_key'); seen.add(unique);
    if (full[0] !== 'hooks') continue;
    if (section.length !== 3 || section[1] !== 'state' || keys.length !== 1) throw Error('unknown_hook_state');
    const field = keys[0], value = line.slice(eq + 1).trim(); let parsed;
    if (field === 'enabled') { if (!['true', 'false'].includes(value)) throw Error('unknown_enabled'); parsed = value === 'true'; }
    else if (['trusted_hash', 'trusted_content_hash'].includes(field)) {
      if (value[0] === '"') parsed = JSON.parse(value);
      else if (/^'[^']*'$/.test(value)) parsed = value.slice(1, -1);
      else throw Error('unknown_hash');
      if (!HASH.test(parsed)) throw Error('unknown_hash');
    } else throw Error('unknown_state_field');
    states.get(section[2].trim())[field] = parsed;
  }
  return states;
}
function legacyBaseline(configFile) {
  const hash = crypto.createHash('sha256');
  lengthPrefix(hash, Buffer.from(configFile)); lengthPrefix(hash, Buffer.from('priors@priors'));
  const file = path.join(path.dirname(configFile), '.hook-trust', hash.digest('hex'));
  const value = readStable(file, 80).toString('utf8'); if (!HASH.test(value)) throw Error('unknown_baseline'); return value;
}
function inspectHooks(env = process.env, root = path.resolve(__dirname, '..')) {
  try {
    const configFile = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    const configBytes = readStable(configFile, 1024 * 1024);
    const states = parseUserState(new TextDecoder('utf-8', { fatal: true }).decode(configBytes));
    const declarations = declarationHashes(root), currentContent = contentHash(root);
    const result = declarations.map(d => {
      const state = states.get(d.key);
      let reason = !state?.trusted_hash ? 'untrusted' : state.trusted_hash !== d.hash ? 'definition_changed' : null;
      if (!reason) {
        const approvedContent = state.trusted_content_hash || legacyBaseline(configFile);
        if (approvedContent !== currentContent) reason = 'contents_changed';
      }
      if (state?.enabled === false) reason = 'disabled';
      return { event: d.event, reason };
    });
    // Re-read content after reading all approvals: concurrent updates are unknown.
    if (contentHash(root) !== currentContent || !readStable(configFile, 1024 * 1024).equals(configBytes)) return null;
    return result;
  } catch { return null; }
}
function healthNotice(env = process.env, root = path.resolve(__dirname, '..'), now = Date.now()) {
  // Only real plugin launches (or explicitly isolated fixtures), never ordinary imported helper tests.
  if (!env.PLUGIN_ROOT || !env.PLUGIN_DATA || path.resolve(env.PLUGIN_ROOT) !== path.resolve(root)) return null;
  const report = inspectHooks(env, root); if (!report) return null;
  const bad = report.filter(r => r.reason); if (!bad.length) return null;
  const stateFile = path.join(env.PLUGIN_DATA || path.join(os.homedir(), '.priors/codex'), 'hook-health-notice.json');
  const signature = report.map(r => `${r.event}:${r.reason || 'ok'}`).join('|');
  const lock = stateFile + '.lock', temporary = stateFile + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'; let held = false;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 }); fs.mkdirSync(lock); held = true;
    let notices = {};
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(readStable(stateFile, 65536));
      if (data.schema !== 1 || !data.notices || typeof data.notices !== 'object' || Array.isArray(data.notices)) return null;
      notices = data.notices;
      if (Object.keys(notices).length > 256 || Object.entries(notices).some(([k, v]) => !/^[A-Za-z_:|]+$/.test(k) || !Number.isFinite(v))) return null;
    }
    if (notices[signature] > now - DAY && notices[signature] <= now) return null;
    notices = Object.fromEntries(Object.entries(notices).filter(([, time]) => time > now - DAY && time <= now));
    notices[signature] = now;
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, notices }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, stateFile);
    const names = bad.map(r => `${r.event}（${r.reason === 'disabled' ? '無効' : '要確認'}）`).join('・');
    return `Priors: 保存支援フックの設定を確認してください: ${names}。\n利用者がCLIの /hooks で各定義を確認して信頼し、無効なら有効にしてください。設定をAIが変更することはありません。`;
  } catch { return null; } finally { try { fs.unlinkSync(temporary); } catch {} if (held) try { fs.rmdirSync(lock); } catch {} }
}
module.exports = { inspectHooks, healthNotice, declarationHashes, contentHash, parseUserState, stableJson };
