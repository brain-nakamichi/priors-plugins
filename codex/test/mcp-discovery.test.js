'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('Codex bundled MCP uses native bearer env lookup, not Claude headers interpolation', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(fs.existsSync(path.join(root, 'plugin.json')), false);
  assert.equal(manifest.mcpServers, './.mcp.json');
  const config = JSON.parse(fs.readFileSync(path.join(root, manifest.mcpServers), 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['priors']);
  assert.deepEqual(config.mcpServers.priors, {
    type: 'http', url: 'https://priors-brain9.vercel.app/mcp',
    bearer_token_env_var: 'PRIORS_TOKEN_CODEX_V1', startup_timeout_sec: 30, tool_timeout_sec: 60,
  });
  assert.doesNotMatch(JSON.stringify(config), /\$\{|"headers"|"http_headers"/);
});

// Actual Codex with fresh CODEX_HOME, no model, no hook execution/trust, and loopback-only fake MCP.
// Inherited credential variables are never copied, read, or logged. Only a fake test value is used.
test('actual engine loads Legacy MCP, ignores headers, does not expand literal headers, and honors config precedence', {
  skip: !process.env.PRIORS_CODEX_DISCOVERY_EXECUTABLE, timeout: 110000,
}, async t => {
  const base = fs.mkdtempSync(path.join(process.env.PRIORS_CODEX_DISCOVERY_TMP || os.tmpdir(), 'priors-mcp-discovery-'));
  const counts = { plugin: 0, manual: 0, authorized: 0, literal: 0, absent: 0, tools_call: 0 };
  const fake = 'local-synthetic-value-not-a-real-credential';
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !['/plugin', '/manual'].includes(req.url)) {
      res.writeHead(404); res.end(); return;
    }
    counts[req.url === '/manual' ? 'manual' : 'plugin']++;
    const authorized = req.headers.authorization === `Bearer ${fake}`;
    counts[authorized ? 'authorized' : req.headers.authorization ? 'literal' : 'absent']++;
    if (!authorized) { res.writeHead(401); res.end(); return; }
    let body = '';
    req.on('data', b => { body += b; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let p; try { p = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      if (p.id == null) { res.writeHead(202); res.end(); return; }
      let result;
      if (p.method === 'initialize') result = { protocolVersion: p.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'loopback-only-test', version: '1' } };
      else if (p.method === 'tools/list') result = { tools: [{ name: 'read_only_probe', description: 'synthetic test', inputSchema: { type: 'object' } }] };
      else if (p.method === 'resources/list') result = { resources: [] };
      else if (p.method === 'resources/templates/list') result = { resourceTemplates: [] };
      else { if (p.method === 'tools/call') counts.tools_call++; result = {}; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: p.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    let error;
    for (let n = 0; n < 12; n++) {
      try { fs.rmSync(base, { recursive: true, force: true }); error = null; break; }
      catch (e) { error = e; await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (error) throw error;
    assert.equal(fs.existsSync(base), false);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const released = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.priors;
  async function discover(kind) {
    for (const key of Object.keys(counts)) counts[key] = 0;
    const home = path.join(base, kind);
    const version = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8')).version;
    const installed = path.join(home, 'plugins/cache/priors/priors', version);
    fs.mkdirSync(installed, { recursive: true });
    fs.cpSync(root, installed, { recursive: true });
    let config = { ...released, url: url + '/plugin', bearer_token_env_var: 'PRIORS_TEST_MCP_AUTH' };
    if (kind === 'old_headers') { delete config.bearer_token_env_var; config.headers = { Authorization: 'Bearer ${PRIORS_TEST_MCP_AUTH}' }; }
    if (kind === 'literal_http_headers') { delete config.bearer_token_env_var; config.http_headers = { Authorization: 'Bearer ${PRIORS_TEST_MCP_AUTH}' }; }
    fs.writeFileSync(path.join(installed, '.mcp.json'), JSON.stringify({ mcpServers: { priors: config } }));
    let settings = 'cli_auth_credentials_store="file"\nmcp_oauth_credentials_store="file"\n[features]\nplugins=true\nhooks=false\nremote_plugin=false\n[analytics]\nenabled=false\n[plugins."priors@priors"]\nenabled=true\n';
    if (kind === 'manual_override') settings += `[mcp_servers.priors]\nurl="${url}/manual"\nbearer_token_env_var="PRIORS_TEST_MCP_AUTH"\nstartup_timeout_sec=5\n`;
    fs.writeFileSync(path.join(home, 'config.toml'), settings);
    const env = { CODEX_HOME: home };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'LOCALAPPDATA']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (kind !== 'missing_env') env.PRIORS_TEST_MCP_AUTH = fake;
    const data = await new Promise((resolve, reject) => {
      const child = spawn(process.env.PRIORS_CODEX_DISCOVERY_EXECUTABLE,
        ['--no-daemon', 'app-server', '--stdio'], { env, cwd: base, windowsHide: true });
      let tail = '', settled = false;
      const timer = setTimeout(() => finish(new Error('mcp_discovery_timeout')), 18000);
      function finish(error, value) {
        if (settled) return; settled = true; clearTimeout(timer);
        const done = () => error ? reject(error) : resolve(value);
        if (!child.pid || child.exitCode !== null) done();
        else { child.once('close', done); child.kill(); }
      }
      child.once('error', () => finish(new Error('mcp_discovery_spawn_failed')));
      child.once('exit', () => { if (!settled) finish(new Error('mcp_discovery_exited_early')); });
      child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
      const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      child.stdout.on('data', bytes => {
        tail += bytes; if (tail.length > 1024 * 1024) return finish(new Error('mcp_discovery_output_limit'));
        for (;;) {
          const i = tail.indexOf('\n'); if (i < 0) break;
          const raw = tail.slice(0, i); tail = tail.slice(i + 1);
          let p; try { p = JSON.parse(raw); } catch { continue; }
          if (p.error) return finish(new Error('mcp_discovery_api_failed'));
          if (p.id === 1) send(2, 'mcpServerStatus/list', { serverName: 'priors' });
          if (p.id === 2) finish(null, p.result.data);
        }
      });
      send(1, 'initialize', { clientInfo: { name: 'priors-mcp-discovery-test', version: '1' }, capabilities: { experimentalApi: true } });
    });
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), settings);
    assert.equal(fs.existsSync(path.join(home, 'hooks.json')), false);
    assert.equal(counts.tools_call, 0);
    return { data, counts: { ...counts } };
  }
  for (const kind of ['old_headers', 'literal_http_headers', 'fixed_bearer', 'manual_override', 'missing_env']) {
    await t.test(kind, async () => {
      const r = await discover(kind);
      assert.equal(r.data.length, 1, 'one logical priors server');
      const s = r.data[0]; assert.equal(s.name, 'priors');
      const success = ['fixed_bearer', 'manual_override'].includes(kind);
      assert.equal(Object.keys(s.tools || {}).length, success ? 1 : 0);
      if (kind === 'old_headers') { assert.ok(r.counts.absent > 0); assert.equal(r.counts.literal, 0); }
      if (kind === 'literal_http_headers') { assert.ok(r.counts.literal > 0); assert.equal(r.counts.authorized, 0); }
      if (kind === 'fixed_bearer') { assert.ok(r.counts.authorized > 0); assert.equal(s.pluginId, 'priors@priors'); }
      if (kind === 'manual_override') { assert.ok(r.counts.manual > 0); assert.equal(r.counts.plugin, 0); assert.equal(s.pluginId, null); }
      if (kind === 'missing_env') assert.equal(r.counts.authorized, 0);
      // Only fixed labels and counts, never engine responses, headers or configuration contents.
      t.diagnostic(JSON.stringify({ kind, servers: r.data.length, tools: Object.keys(s.tools || {}).length, ...r.counts }));
    });
  }
});
