#!/usr/bin/env node
'use strict';

// This explicit helper creates a pending marker without claiming that a native
// lifecycle hook ran or persisting the prompt, token, or conversation text.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const recorder = path.join(__dirname, 'record-decision.js');
const result = spawnSync(process.execPath, [
  recorder,
  '--decision', 'pending',
  '--client', 'codex',
  '--phase', 'turn-start',
  '--source', 'explicit',
], { stdio: 'inherit' });
process.exitCode = result.status ?? 2;
