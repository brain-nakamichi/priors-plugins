'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const expected = ['postToolUse', 'sessionStart', 'stop', 'userPromptSubmit'];

test('Codex package keeps the compatibility manifest as the selected manifest', () => {
  // Codex 0.165.0 skips hook loading for root Agent Plugins manifests, even with an overlay.
  assert.equal(fs.existsSync(path.join(root, 'plugin.json')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'priors');
  assert.equal(manifest.hooks, './hooks/hooks.json');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(fs.existsSync(path.join(root, manifest.skills)));
  const mcp = JSON.parse(fs.readFileSync(path.join(root, manifest.mcpServers), 'utf8'));
  assert.ok(mcp.mcpServers.priors);
  const hooks = JSON.parse(fs.readFileSync(path.join(root, manifest.hooks), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
});

test('Codex update notices read local and published compatibility manifests', async t => {
  const { pathToFileURL } = require('node:url');
  const { checkPluginUpdate } = await import(pathToFileURL(path.join(root, 'hooks/plugin-update-check.js')).href);
  const current = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8')).version;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-update-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = global.fetch;
  t.after(() => { global.fetch = saved; });
  global.fetch = async url => {
    assert.equal(String(url), 'https://raw.githubusercontent.com/brain-nakamichi/priors-plugins/main/codex/.codex-plugin/plugin.json');
    return { ok: true, text: async () => JSON.stringify({ version: current }) };
  };
  assert.equal(await checkPluginUpdate({ PRIORS_PLUGIN_UPDATE_STATE_FILE: path.join(dir, 'state.json') }), null);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

// Opt-in actual engine test: no model/MCP call, hook execution, trust, daemon, or normal config mutation.
test('actual engine discovers packaged hooks; a portable-root control reproduces the failure', {
  skip: !process.env.PRIORS_CODEX_DISCOVERY_EXECUTABLE,
  timeout: 45000,
}, async t => {
  const base = fs.mkdtempSync(path.join(process.env.PRIORS_CODEX_DISCOVERY_TMP || os.tmpdir(), 'priors-hook-discovery-'));
  t.after(async () => {
    // Allow Windows process/pipe watchers to release their directory handles without blocking Node.
    let lastError;
    for (let attempt = 0; attempt < 12; attempt++) {
      try { fs.rmSync(base, { recursive: true, force: true }); lastError = null; break; }
      catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    try { if (lastError) throw lastError; }
    catch (error) {
      if (process.platform !== 'win32') throw error;
      // Native Force cleanup handles Windows attributes left by the engine. No shell interpolation.
      // Validate the exact newly-created absolute target again in the shell performing removal.
      const cleanup = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$p=[IO.Path]::GetFullPath($env:PRIORS_DISCOVERY_CLEANUP); if ($p -ne $env:PRIORS_DISCOVERY_CLEANUP -or [IO.Path]::GetFileName($p) -notmatch "^priors-hook-discovery-[A-Za-z0-9]+$") { throw "unexpected_test_target" }; Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop'],
      { env: { ...process.env, PRIORS_DISCOVERY_CLEANUP: base }, windowsHide: true, encoding: 'utf8' });
      assert.equal(cleanup.status, 0, 'native_test_cleanup_failed');
    }
    assert.equal(fs.existsSync(base), false);
  });
  async function discover(portable) {
    const home = path.join(base, portable ? 'portable' : 'compatibility');
    const installed = path.join(home, 'plugins/cache/priors/priors/0.1.67');
    fs.mkdirSync(installed, { recursive: true });
    fs.cpSync(root, installed, { recursive: true });
    if (portable) fs.writeFileSync(path.join(installed, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'priors', version: '0.1.67', description: 'synthetic packaging control',
      extensions: { 'com.openai': { hooks: './hooks/hooks.json' } },
    }));
    fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nhooks=true\nplugins=true\nremote_plugin=false\n[analytics]\nenabled=false\n[plugins."priors@priors"]\nenabled=true\n');
    const before = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|SECRET|API_KEY|DATABASE|AUTH|^PRIORS|^CODEX/i.test(k))), CODEX_HOME: home };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.env.PRIORS_CODEX_DISCOVERY_EXECUTABLE, ['--no-daemon', 'app-server', '--stdio'], { env, cwd: base, windowsHide: true });
      let tail = '', settled = false;
      const timer = setTimeout(() => finish(new Error('discovery_timeout')), 18000);
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const complete = () => error ? reject(error) : resolve(value);
        if (child.exitCode !== null || !child.pid) complete();
        else { child.once('close', complete); child.kill(); }
      }
      child.once('error', () => finish(new Error('discovery_spawn_failed')));
      child.once('exit', () => { if (!settled) finish(new Error('discovery_exited_early')); });
      child.stderr.on('data', () => {}); // Never print raw engine logs or credentials.
      child.stdin.on('error', () => {});
      const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      child.stdout.on('data', bytes => {
        tail += bytes;
        if (tail.length > 1024 * 1024) return finish(new Error('discovery_output_limit'));
        for (;;) {
          const i = tail.indexOf('\n'); if (i < 0) break;
          const raw = tail.slice(0, i); tail = tail.slice(i + 1);
          let response; try { response = JSON.parse(raw); } catch { continue; }
          if (response.error) return finish(new Error('discovery_api_failed'));
          if (response.id === 1) send(2, 'hooks/list', { cwds: [base, os.homedir()] });
          if (response.id === 2) finish(null, response.result.data);
        }
      });
      send(1, 'initialize', { clientInfo: { name: 'priors-hook-discovery-test', version: '1' }, capabilities: { experimentalApi: true } });
    });
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(home, 'hooks.json')), false);
    return result;
  }
  const broken = await discover(true);
  const fixed = await discover(false);
  assert.equal(broken.length, 2); assert.equal(fixed.length, 2);
  for (const entry of broken) {
    assert.equal(entry.errors.length, 0);
    assert.equal(entry.hooks.filter(h => h.pluginId === 'priors@priors').length, 0);
  }
  for (const entry of fixed) {
    assert.equal(entry.errors.length, 0);
    const hooks = entry.hooks.filter(h => h.pluginId === 'priors@priors');
    assert.deepEqual(hooks.map(h => h.eventName).sort(), expected);
    assert.ok(hooks.every(h => h.trustStatus === 'untrusted' && h.enabled && h.source === 'plugin'));
  }
});
