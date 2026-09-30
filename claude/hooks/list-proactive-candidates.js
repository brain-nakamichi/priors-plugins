#!/usr/bin/env node
'use strict';

const { listProactiveCandidates } = require('./proactive-candidates.js');

process.stdout.write(`${JSON.stringify(listProactiveCandidates())}\n`);
