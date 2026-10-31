'use strict';
// Codex plugin has no package.json of its own, so its tests run from here.
// Works in the monorepo (Priors/codex-plugins/priors) and the public mirror (codex/).
const fs = require('node:fs');
const path = require('node:path');

const mirror = path.join(__dirname, '..', '..', 'codex');
const root = fs.existsSync(mirror) ? mirror : path.join(__dirname, '..', '..', 'codex-plugins', 'priors');
const dir = path.join(root, 'test');
const hookRoot=fs.existsSync(path.join(__dirname,'..','..','codex-hooks'))?path.join(__dirname,'..','..','codex-hooks'):path.join(__dirname,'..','..','codex-plugins','priors-hooks');
for(const name of fs.readdirSync(path.join(__dirname,'codex-hooks')).filter(f=>f.endsWith('.test.js')).sort())require(path.join(__dirname,'codex-hooks',name));
for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.test.js')).sort()) require(path.join(dir, name));
