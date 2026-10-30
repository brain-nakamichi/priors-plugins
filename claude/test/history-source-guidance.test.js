const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('both skills explain current-source invalidation without claiming every not_found is staleness',()=>{
 const files=[path.join(__dirname,'../skills/priors/SKILL.md'),path.join(__dirname,'../../codex-plugins/priors/skills/priors/SKILL.md')];
 const sections=files.map(file=>fs.readFileSync(file,'utf8').split('## History の登録が not_found になるとき')[1]?.split('\n## ')[0].trim());
 assert.ok(sections[0]);assert.equal(sections[0],sections[1]);
 for(const text of sections){assert.match(text,/current/);assert.match(text,/改訂・撤回・期限/);assert.match(text,/断定せず/);assert.match(text,/本文と出典を見直してから/);assert.match(text,/historical.*機械的に変更/);}
});
