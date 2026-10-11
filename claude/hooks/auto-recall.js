#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://priors-brain9.vercel.app/mcp';
const ALLOWED_HOSTS = new Set(['priors-brain9.vercel.app', '127.0.0.1', 'localhost', '::1']);
const TIMEOUT_MS = 2500;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 12000;
const MAX_QUERY_CHARS = 4000;
const THEME_RE = /^[A-Z][A-Z0-9]{1,7}$/;

const { resolveConfig } = require('./config-resolver.js');
function config(cwd, env = process.env) {
  const result = resolveConfig(cwd, { env });
  return result.kind === 'ok' ? { theme: result.theme, file: result.path } : null;
}

function token(env) {
  const file = env.PRIORS_HOOK_TOKEN_FILE;
  if (file) {
    try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
  }
  return typeof env.PRIORS_HOOK_TOKEN_V1 === 'string' && env.PRIORS_HOOK_TOKEN_V1 ? env.PRIORS_HOOK_TOKEN_V1 : null;
}

function validUrl(raw, env = {}) {
  try {
    const url = new URL(raw || DEFAULT_URL);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return null;
    const extra = typeof env.PRIORS_MCP_ALLOWED_HOSTS === 'string'
      ? env.PRIORS_MCP_ALLOWED_HOSTS.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
      : [];
    if (!new Set([...ALLOWED_HOSTS, ...extra]).has(url.hostname.toLowerCase())) return null;
    return url;
  } catch { return null; }
}

function embeddedPayload(result) {
  if (!result || !Array.isArray(result.content) || typeof result.content[0]?.text !== 'string') return null;
  try {
    const parsed = JSON.parse(result.content[0].text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function formatAutoRecall(text) {
  const safe = text.replace(/AUTO_RECALL_(?:BEGIN|END)/g, (value) => value.replace('_', '＿'));
  return `AUTO_RECALL_BEGIN\n${safe}\nAUTO_RECALL_END`;
}

async function call(url, bearer, method, params, signal) {
  const response = await fetch(url, {
    method: 'POST', signal, redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (response.status !== 200) return null;
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  return body && body.result ? body.result : null;
}

async function main(input, env = process.env) {
  // Gate before config/token reads and even initialize, including standalone use.
  let inspection;
  try { inspection = require('./sensitive-input.js').inspectSensitiveInput(input?.prompt); }
  catch { inspection = { state: 'uninspectable', suppress_auto_recall: true }; }
  if (inspection.suppress_auto_recall) return {
    ok: false, reason: inspection.state === 'suspected' ? 'input_suspected_sensitive' : 'input_uninspectable',
  };
  if (env.PRIORS_AUTO_RECALL !== '1') return { ok: false, reason: 'disabled' };
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const cfg = config(input.cwd, env);
  const bearer = token(env);
  const url = validUrl(env.PRIORS_MCP_URL, env);
  if (!cfg || !bearer || !url || !prompt) return { ok: false, reason: 'configuration' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init = await call(url, bearer, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'priors-auto-recall-hook', version: '0.1.0' } }, controller.signal);
    if (!init) return { ok: false, reason: 'initialize' };
    const opened = await call(url, bearer, 'tools/call', { name: 'context_open', arguments: { theme: cfg.theme, budget_tokens: 1000, ...(input.session_id ? { session_id: input.session_id } : {}) } }, controller.signal);
    if (!opened || opened.isError === true) return { ok: false, reason: 'context_open' };
    const openedPayload = embeddedPayload(opened);
    const sessionId = (openedPayload && typeof openedPayload.resolved_session_id === 'string')
      ? openedPayload.resolved_session_id
      : (opened && typeof opened.resolved_session_id === 'string' ? opened.resolved_session_id : input.session_id);
    const query = prompt.slice(0, MAX_QUERY_CHARS);
    const recalled = await call(url, bearer, 'tools/call', { name: 'recall', arguments: { theme: cfg.theme, scopes: ['theme'], query, budget_tokens: 1200, ...(sessionId ? { session_id: sessionId } : {}) } }, controller.signal);
    if (!recalled || recalled.isError === true) return { ok: false, reason: 'recall' };
    const text = recalled && Array.isArray(recalled.content) && typeof recalled.content[0]?.text === 'string' ? recalled.content[0].text : '';
    if (!text) return { ok: false, reason: 'empty' };
    return { ok: true, text: Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8') };
  } catch { return { ok: false, reason: 'unreachable' }; } finally { clearTimeout(timer); }
}

if (require.main === module) {
  let read;
  try { read = require('./bounded-input.js').readHookInput(); }
  catch { read = { ok: false }; }
  if (!read.ok) process.stdout.write(JSON.stringify({ ok: false, reason: 'input_uninspectable' }));
  else main(read.input).then((result) => process.stdout.write(JSON.stringify(result))).catch(() => process.stdout.write(JSON.stringify({ ok: false, reason: 'error' })));
}

module.exports = { main, embeddedPayload, config, formatAutoRecall, validUrl, MAX_QUERY_CHARS };
