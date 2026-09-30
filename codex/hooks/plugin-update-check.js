import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT = 'codex';
const DEFAULT_URL = 'https://raw.githubusercontent.com/brain-nakamichi/priors-plugins/main/codex/priors/plugin.json';
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
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin.json'), 'utf8')).version; }
  catch { return process.env.PRIORS_PLUGIN_VERSION || '0.0.0'; }
}
function statePath(env) { return env.PRIORS_PLUGIN_UPDATE_STATE_FILE || path.join(os.homedir(), '.priors', 'plugin-update-check.json'); }
function readState(file) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function writeState(file, state) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(tmp, file); } catch { /* notification must never break SessionStart */ }
}
function allowedUrl(raw, env) {
  try { const u = new URL(raw); if (u.protocol !== 'https:') return null; const extra = String(env.PRIORS_PLUGIN_UPDATE_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); if (!new Set(['raw.githubusercontent.com', ...extra]).has(u.hostname.toLowerCase())) return null; return u; } catch { return null; }
}
export async function checkPluginUpdate(env = process.env) {
  const current = currentVersion(); const url = allowedUrl(env.PRIORS_PLUGIN_UPDATE_URL || DEFAULT_URL, env);
  if (!url || typeof fetch !== 'function') return null;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Number(env.PRIORS_PLUGIN_UPDATE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null; const text = await res.text(); if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return null;
    const latest = JSON.parse(text).version; if (!newer(latest, current)) return null;
    const file = statePath(env); const state = readState(file); const now = Date.now(); const previous = state[CLIENT];
    if (previous && previous.version === latest && now - Number(previous.notifiedAt) < NOTIFY_INTERVAL_MS) return null;
    state[CLIENT] = { version: latest, notifiedAt: now }; writeState(file, state);
    return `Priorsプラグインに更新があります（Codex: ${current} → ${latest}）。CodexのPriors marketplaceを更新してからプラグインを再インストールし、Codexを再起動してください。token・MCP設定は変更しません。`;
  } catch { return null; } finally { clearTimeout(timer); }
}
