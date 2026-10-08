'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const THEME_RE = /^[A-Z][A-Z0-9]{1,7}$/;
const MAX_CONFIG_BYTES = 64 * 1024;

function canonical(value) {
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync(resolved); } catch { /* Keep explicit lexical mapping. */ }
  resolved = path.normalize(resolved);
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return resolved;
}
function contains(root, dir) {
  const relative = path.relative(root, dir);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { return error.code !== 'ENOENT'; }
}
function searchDirs(cwd, home) {
  const dirs = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (exists(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) { dirs.splice(4); break; }
    dir = parent;
  }
  const homePath = canonical(home);
  return dirs.filter((d) => path.dirname(d) !== d && canonical(d) !== homePath);
}
function readJson(file) {
  let raw;
  try {
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return { status: 'invalid', reason: 'config_too_large' };
    raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) return { status: 'invalid', reason: 'config_too_large' };
  } catch (error) {
    return error.code === 'ENOENT' && !exists(file)
      ? { status: 'missing' } : { status: 'invalid', reason: 'unreadable' };
  }
  let data;
  try { data = JSON.parse(raw); } catch { return { status: 'invalid', reason: 'json_parse_error' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 'invalid', reason: 'not_an_object' };
  return { status: 'ok', data };
}
function entry(data) {
  if (!THEME_RE.test(data.theme || '') || typeof data.theme !== 'string') return { reason: 'theme_invalid' };
  if (data.work_kinds !== undefined && (!Array.isArray(data.work_kinds) || data.work_kinds.length > 64 ||
      !data.work_kinds.every((v) => typeof v === 'string' && v.length <= 128))) return { reason: 'work_kinds_invalid' };
  return { theme: data.theme, workKinds: data.work_kinds };
}
function invalid(file, reason) { return { kind: 'invalid', path: file, reason }; }
function resolveConfig(cwd, options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  for (const dir of searchDirs(cwd || process.cwd(), home)) {
    for (const name of ['priors.local.json', 'priors.json']) {
      const file = path.join(dir, '.claude', name);
      const read = readJson(file);
      if (read.status === 'missing') continue;
      if (read.status === 'invalid') return invalid(file, read.reason);
      const parsed = entry(read.data);
      if (parsed.reason) return invalid(file, parsed.reason);
      return { kind: 'ok', ...parsed, path: file, source: 'project' };
    }
  }
  const file = options.userConfigFile || env.PRIORS_USER_CONFIG_FILE || path.join(home, '.priors', 'config.json');
  const read = readJson(file);
  if (read.status === 'missing') return { kind: 'none' };
  if (read.status === 'invalid') return invalid(file, read.reason);
  const data = read.data;
  if (data.schema_version !== 1 || Object.keys(data).some((k) => !['schema_version', 'default_theme', 'projects'].includes(k))) return invalid(file, 'user_schema_invalid');
  if (data.default_theme !== undefined && (typeof data.default_theme !== 'string' || !THEME_RE.test(data.default_theme))) return invalid(file, 'theme_invalid');
  if (data.projects !== undefined && (!Array.isArray(data.projects) || data.projects.length > 128)) return invalid(file, 'projects_invalid');
  const roots = new Set();
  let selected;
  const current = canonical(cwd || process.cwd());
  for (const project of data.projects || []) {
    if (!project || typeof project !== 'object' || Array.isArray(project) ||
        Object.keys(project).some((k) => !['root', 'theme', 'work_kinds'].includes(k)) ||
        typeof project.root !== 'string' || !path.isAbsolute(project.root)) return invalid(file, 'projects_invalid');
    const parsed = entry(project);
    if (parsed.reason) return invalid(file, parsed.reason);
    const root = canonical(project.root);
    if (roots.has(root)) return invalid(file, 'duplicate_root');
    roots.add(root);
    if (contains(root, current) && (!selected || root.length > selected.root.length)) selected = { root, ...parsed };
  }
  if (selected) return { kind: 'ok', theme: selected.theme, workKinds: selected.workKinds, path: file, source: 'user_project' };
  if (data.default_theme) return { kind: 'ok', theme: data.default_theme, path: file, source: 'user_default' };
  return { kind: 'none' };
}
module.exports = { resolveConfig, searchDirs, canonical, contains, MAX_CONFIG_BYTES };
