'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT = 'claude';
const DEFAULT_URL = 'https://raw.githubusercontent.com/brain-nakamichi/priors-plugins/main/claude/.claude-plugin/plugin.json';
const MAX_BODY = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 1500;
const NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

function parseVersion(value) {
  const m = typeof value === 'string' && value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function newer(a, b) {
  const av = parseVersion(a); const bv = parseVersion(b);
  if (!av || !bv) return false;
  for (let i = 0; i < av.length; i += 1) { if (av[i] !== bv[i]) return av[i] > bv[i]; }
  return false;
}

function currentVersion() {
  try {
    const p = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version;
  } catch { return process.env.PRIORS_PLUGIN_VERSION || '0.0.0'; }
}

function statePath(env) {
  return env.PRIORS_PLUGIN_UPDATE_STATE_FILE || path.join(os.homedir(), '.priors', 'plugin-update-check.json');
}

function readState(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* notification must never break SessionStart */ }
}

function allowedUrl(raw, env) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    const extra = String(env.PRIORS_PLUGIN_UPDATE_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!new Set(['raw.githubusercontent.com', ...extra]).has(u.hostname.toLowerCase())) return null;
    return u;
  } catch { return null; }
}

async function checkPluginUpdate(env = process.env) {
  const current = currentVersion();
  const url = allowedUrl(env.PRIORS_PLUGIN_UPDATE_URL || DEFAULT_URL, env);
  if (!url || typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.PRIORS_PLUGIN_UPDATE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return null;
    const latest = JSON.parse(text).version;
    if (!newer(latest, current)) return null;
    const file = statePath(env); const state = readState(file); const now = Date.now();
    const previous = state[CLIENT];
    if (previous && previous.version === latest && now - Number(previous.notifiedAt) < NOTIFY_INTERVAL_MS) return null;
    state[CLIENT] = { version: latest, notifiedAt: now };
    writeState(file, state);
    return `Priorsプラグインに更新があります（Claude: ${current} → ${latest}）。「claude plugin update priors@priors」を実行し、更新元が古い場合は公式marketplaceを再登録してからClaude Codeを再起動してください。token・MCP設定は変更しません。`;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/**
 * GEN-542: server の initialize が返した priors_contract と自身の版を比べ、古ければ案内文を返す。
 * server が warnings に plugin_outdated を立てたときも同じ案内にする。GitHub 確認と同じ状態ファイルで
 * 1 日 1 回に抑える（鍵は '<client>-contract'）。失敗は無言（null）。
 */
function checkPluginContract(contract, serverWarnings, env = process.env) {
  try {
    const current = currentVersion();
    const minimum = contract && typeof contract === 'object' && contract.minimum_plugin
      && typeof contract.minimum_plugin === 'object' ? contract.minimum_plugin[CLIENT] : undefined;
    const flagged = Array.isArray(serverWarnings) && serverWarnings.includes('plugin_outdated');
    const outdated = flagged || (parseVersion(minimum) !== null && newer(minimum, current));
    if (!outdated) return null;
    const required = parseVersion(minimum) !== null ? minimum : 'server が要求する版';
    const file = statePath(env); const state = readState(file); const now = Date.now();
    const key = `${CLIENT}-contract`;
    const previous = state[key];
    if (previous && previous.version === required && now - Number(previous.notifiedAt) < NOTIFY_INTERVAL_MS) return null;
    state[key] = { version: required, notifiedAt: now };
    writeState(file, state);
    return `Priorsサーバーはプラグイン ${required} 以上を要求しています（Claude: ${current}）。「claude plugin update priors@priors」を実行し、Claude Codeを再起動してください。token・MCP設定は変更しません。`;
  } catch { return null; }
}
module.exports = { checkPluginUpdate, checkPluginContract, currentVersion, parseVersion, newer };
