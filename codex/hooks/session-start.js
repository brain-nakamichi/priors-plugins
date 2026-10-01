#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { checkPluginUpdate, checkPluginContract } from "./plugin-update-check.js";

const auditFile = process.env.PRIORS_DECISION_AUDIT_FILE ||
  (process.env.PLUGIN_DATA ? path.join(process.env.PLUGIN_DATA, "decision-audit.jsonl") : null) ||
  path.join(os.homedir(), ".priors", "decision-audit.jsonl");
fs.mkdirSync(path.dirname(auditFile), { recursive: true });
const session = process.env.CODEX_SESSION_ID || process.env.SESSION_ID || "unknown";
const event = { schema: "priors.decision-audit.v1", recorded_at: new Date().toISOString(), decision: "pending", client: "codex", source: "hook", phase: "turn-start", session_sha256: crypto.createHash("sha256").update(session).digest("hex") };
fs.appendFileSync(auditFile, `${JSON.stringify(event)}\n`, "utf8");
const baseMessage = "Priors判定（開始時）: 今回はPriorsを読むか、書込候補として扱うか、使わないかを判断してください。読む場合は context_open → recall、書込候補は guard 後に remember/amend を行います。判定結果はローカル監査ログへ記録します。";
const notices = (await Promise.all([checkPluginUpdate(process.env), checkPluginContract(process.env)])).filter(Boolean);
const message = notices.length > 0 ? `${baseMessage}\n${notices.join("\n")}` : baseMessage;
process.stdout.write(JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } }));
