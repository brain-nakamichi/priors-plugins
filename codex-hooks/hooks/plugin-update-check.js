import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {coreVersion} from './core-version.js';

const CLIENT = 'codex-hooks';
// GEN-541 (historical; 0.1.67 uses compatibility manifest): 公開リポの実パスは codex/plugin.json（旧 codex/priors/plugin.json は 404 で通知が一度も出なかった）
const DEFAULT_URL = 'https://raw.githubusercontent.com/brain-nakamichi/priors-plugins/main/codex-hooks/.codex-plugin/plugin.json';
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
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.codex-plugin', 'plugin.json'), 'utf8')).version; }
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
    return `Priors Hooksに更新があります（${current} → ${latest}）。marketplaceを更新し、priors-hooks@priorsを更新後、CLI /hooksで5フックを確認・再信頼してください。token・MCP設定は変更しません。`;
  } catch { return null; } finally { clearTimeout(timer); }
}

// GEN-542 (Codex review): the Codex SessionStart does not otherwise talk to the server, so this hook performs its own
// MCP initialize, names the plugin (clientInfo priors-plugin-codex + version) and compares with priors_contract.
// Token comes from the same env var the MCP config uses; it is sent as a header and never printed. Failures are silent.
const DEFAULT_MCP_URL = 'https://priors-brain9.vercel.app/mcp';
function allowedMcpUrl(raw, env) {
  try {
    const u = new URL(raw); if (u.protocol !== 'https:') return null;
    const extra = String(env.PRIORS_MCP_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!new Set(['priors-brain9.vercel.app', ...extra]).has(u.hostname.toLowerCase())) return null; return u;
  } catch { return null; }
}
export async function checkPluginContract(env = process.env) {
  const current=coreVersion(env);if(!current)return null;
  const token = env.PRIORS_TOKEN_CODEX_V1; const url = allowedMcpUrl(env.PRIORS_MCP_URL || DEFAULT_MCP_URL, env);
  if (!token || !url || typeof fetch !== 'function') return null;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Number(env.PRIORS_PLUGIN_UPDATE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'priors-plugin-codex', version: current } } }) });
    if (!res.ok) return null; const text = await res.text(); if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return null;
    const result = (JSON.parse(text) || {}).result; if (!result || typeof result !== 'object') return null;
    const contract = result.priors_contract || (result._meta && result._meta.priors_contract) || null;
    const minimum = contract && contract.minimum_plugin ? contract.minimum_plugin.codex : undefined;
    const flagged = Array.isArray(result.warnings) && result.warnings.includes('plugin_outdated');
    if (!(flagged || (parseVersion(minimum) && newer(minimum, current)))) return null;
    const required = parseVersion(minimum) ? minimum : 'server が要求する版';
    const file = statePath(env); const state = readState(file); const now = Date.now(); const key = `${CLIENT}-contract`; const previous = state[key];
    if (previous && previous.version === required && now - Number(previous.notifiedAt) < NOTIFY_INTERVAL_MS) return null;
    state[key] = { version: required, notifiedAt: now }; writeState(file, state);
    return `Priorsサーバーはプラグイン ${required} 以上を要求しています（Codex: ${current}）。CodexのPriors marketplaceを更新してからプラグインを再インストールし、Codexを再起動してください。token・MCP設定は変更しません。`;
  } catch { return null; } finally { clearTimeout(timer); }
}

export async function checkCoreUpdate(env=process.env){
 const current=coreVersion(env);if(!current)return null;
 const url=allowedUrl(env.PRIORS_CORE_PLUGIN_UPDATE_URL||'https://raw.githubusercontent.com/brain-nakamichi/priors-plugins/main/codex/.codex-plugin/plugin.json',env);
 if(!url||typeof fetch!=='function')return null;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Number(env.PRIORS_PLUGIN_UPDATE_TIMEOUT_MS)||DEFAULT_TIMEOUT_MS);
 try{
  const res=await fetch(url,{redirect:'error',signal:controller.signal,headers:{accept:'application/json'}});
  if(!res.ok)return null;const text=await res.text();if(Buffer.byteLength(text)>MAX_BODY)return null;
  const latest=JSON.parse(text).version;if(!newer(latest,current))return null;
  const file=statePath(env),state=readState(file),previous=state['codex-core'],now=Date.now();
  if(previous&&previous.version===latest&&now-Number(previous.notifiedAt)<NOTIFY_INTERVAL_MS)return null;
  state['codex-core']={version:latest,notifiedAt:now};writeState(file,state);
  return `Priors本体に更新があります（${current} → ${latest}）。priors@priorsを更新してください。priors-hooksを更新しない場合、フックの再信頼は不要です。`;
 }catch{return null;}finally{clearTimeout(timer);}
}
