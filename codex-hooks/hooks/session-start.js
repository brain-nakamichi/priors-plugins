#!/usr/bin/env node
import fs from "node:fs";
import { checkPluginUpdate, checkCoreUpdate, checkPluginContract } from "./plugin-update-check.js";
import health from "./hook-health.js";
import bounded from "./shared/bounded-input.js";
import compact from "./compact.js";

const read=bounded.readHookInput(0,false);
if(read.ok && read.input.source==='compact') {
  const output=compact.handle(read.input); if(output)process.stdout.write(JSON.stringify(output));
} else {
  const notices = [health.healthNotice(process.env), ...(await Promise.all([checkPluginUpdate(process.env), checkCoreUpdate(process.env), checkPluginContract(process.env)]))].filter(Boolean);
  if (notices.length > 0) process.stdout.write(JSON.stringify({ systemMessage: notices.join("\n"), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notices.join("\n") } }));
}
