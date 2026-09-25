---
name: priors
description: Use the Priors AI memory system safely from Codex.
---

# Priors

Use the Priors MCP server when the task benefits from prior project decisions,
design notes, or handoffs.

When a new theme may have been created after the MCP connection started, call
the read-only `theme_list` tool to refresh the current visible theme list; do
not infer that an omitted theme does not exist.

Before proposing a material change, read the relevant context with `context_open`
and `recall`. Before a write, call `guard` and check its result. Keep the active
theme explicit; do not guess a theme from a short ID or from unrelated text.

Priors suggestions are not facts. Preserve provenance and uncertainty. For
meaningful relations (support, similarity, contradiction, or retraction), treat
AI output as a candidate and register it only after the user explicitly accepts
it. Do not mark it verified and do not retract source material automatically.

Use `remember` or other write tools only when the user clearly asks to record a
fact or decision. Never put tokens, DSNs, or raw credentials in messages,
files, or memory. The MCP connection reads `PRIORS_TOKEN_CODEX_V1` from the
process environment; do not inline its value.

If the server returns an authorization or infrastructure error, report the
failure and continue without inventing a result.
