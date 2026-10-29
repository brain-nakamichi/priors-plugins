'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('Claude/Codex packaged pure hook core stays identical to the canonical source',()=>{
 const {sync,FILES}=require('../scripts/sync-codex-hook-core.js');assert.ok(FILES.includes('compact-checkpoint.js'));assert.equal(FILES.length,5);sync(true);
});
