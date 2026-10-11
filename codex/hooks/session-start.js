#!/usr/bin/env node
import fs from "node:fs";
import { checkPluginUpdate, checkPluginContract } from "./plugin-update-check.js";

const notices = (await Promise.all([checkPluginUpdate(process.env), checkPluginContract(process.env)])).filter(Boolean);
if (notices.length > 0) process.stdout.write(JSON.stringify({ systemMessage: notices.join("\n"), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notices.join("\n") } }));
