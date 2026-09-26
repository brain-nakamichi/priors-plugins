#!/usr/bin/env node
'use strict';

// Codex has no lifecycle hook. This explicit first-step helper creates a
// pending marker without persisting the prompt, token, or conversation text.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const recorder = path.join(__dirname, 'record-decision.js');
const result = spawnSync(process.execPath, [
  recorder,
  '--decision', 'pending',
  '--client', 'codex',
  '--phase', 'turn-start',
  '--source', 'hook',
], { stdio: 'inherit' });
process.exitCode = result.status ?? 2;
