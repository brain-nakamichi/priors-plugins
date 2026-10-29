#!/usr/bin/env node
import fs from "node:fs";
import { checkPluginUpdate, checkPluginContract } from "./plugin-update-check.js";
import health from "./hook-health.js";

const notices = [health.healthNotice(process.env), ...(await Promise.all([checkPluginUpdate(process.env), checkPluginContract(process.env)]))].filter(Boolean);
if (notices.length > 0) process.stdout.write(JSON.stringify({ systemMessage: notices.join("\n"), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notices.join("\n") } }));
