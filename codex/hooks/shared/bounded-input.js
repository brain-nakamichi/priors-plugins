'use strict';

const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const MAX_RAW_BYTES = 2 * 1024 * 1024;

// Keep at most MAX_RAW_BYTES; drain oversized input without retaining its tail.
// Errors are fixed codes, never raw JSON, paths, or exception messages.
function readHookInput(fd = 0, requirePrompt = true) {
  try {
    const chunks = [];
    const buffer = Buffer.alloc(8192);
    let total = 0;
    let oversized = false;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_RAW_BYTES) { oversized = true; chunks.length = 0; }
      if (!oversized) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (oversized) return { ok: false, reason: 'input_too_large' };
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const input = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input) || (requirePrompt && typeof input.prompt !== 'string')) {
      return { ok: false, reason: 'invalid_input' };
    }
    return { ok: true, input };
  } catch { return { ok: false, reason: 'invalid_input' }; }
}

module.exports = { readHookInput, MAX_RAW_BYTES };
