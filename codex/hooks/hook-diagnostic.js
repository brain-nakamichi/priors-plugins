"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const LIMIT_BYTES = 65536;
const LIMIT_LINES = 256;
function diagnosticPath(env = process.env) {
  return env.PRIORS_HOOK_DIAGNOSTIC_FILE || path.join(env.PLUGIN_DATA || path.join(os.homedir(), ".priors"), "codex-hook-invocations.jsonl");
}
// Best-effort diagnostics, not an authoritative audit: concurrent rewrites may
// drop a line. Missing diagnostics never prove that a hook was not invoked.
function recordHookInvocation(eventName, env = process.env) {
  if (!["SessionStart", "Stop"].includes(eventName)) return false;
  let fd;
  try {
    const file = diagnosticPath(env);
    let rows = [];
    if (fs.existsSync(file)) {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - LIMIT_BYTES);
      const buffer = Buffer.alloc(Math.min(size, LIMIT_BYTES));
      const read = fs.readSync(fd, buffer, 0, buffer.length, start);
      fs.closeSync(fd); fd = undefined;
      const lines = buffer.subarray(0, read).toString("utf8").split(/\r?\n/);
      if (start > 0) lines.shift();
      for (const line of lines) {
        try {
          const x = JSON.parse(line);
          if (x.schema !== "priors.hook-invocation.v1" || !["SessionStart", "Stop"].includes(x.event)
              || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(x.recorded_at)
              || !/^[0-9a-f-]{36}$/.test(x.correlation_id)) continue;
          rows.push({ schema: x.schema, event: x.event, recorded_at: x.recorded_at, correlation_id: x.correlation_id });
        } catch { /* discard malformed input without echoing it */ }
      }
    }
    rows.push({ schema: "priors.hook-invocation.v1", event: eventName,
      recorded_at: new Date().toISOString(), correlation_id: crypto.randomUUID() });
    rows = rows.slice(-LIMIT_LINES);
    let text = rows.map(x => JSON.stringify(x)).join("\n") + "\n";
    while (Buffer.byteLength(text) > LIMIT_BYTES && rows.length > 1) {
      rows.shift(); text = rows.map(x => JSON.stringify(x)).join("\n") + "\n";
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows best effort */ }
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
module.exports = { diagnosticPath, recordHookInvocation, LIMIT_BYTES, LIMIT_LINES };
