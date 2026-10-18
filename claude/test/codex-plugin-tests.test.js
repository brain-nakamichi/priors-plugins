'use strict';
// Codex plugin has no package.json of its own, so its tests run from here.
// Works in the monorepo (Priors/codex-plugins/priors) and the public mirror (codex/).
const fs = require('node:fs');
const path = require('node:path');

const mirror = path.join(__dirname, '..', '..', 'codex');
const root = fs.existsSync(mirror) ? mirror : path.join(__dirname, '..', '..', 'codex-plugins', 'priors');
const dir = path.join(root, 'test');
for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.test.js')).sort()) require(path.join(dir, name));
