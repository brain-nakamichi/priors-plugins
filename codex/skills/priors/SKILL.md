---
name: priors
description: Use the Priors AI memory system safely from Codex.
---

# Priors

At the start of every user turn, first run `scripts/record-turn-start.js`.
Then decide exactly one of `use-read`, `write-candidate`, or `skip`, and record
that decision with `scripts/record-decision.js --phase turn-start`. Never put
the decision or prompt text in Priors memory. Before the final response, make a
second decision and record it with `--phase conversation-end`.

Codex has no lifecycle hook, so these are explicit completion steps. A missing
`turn-start` pending marker or missing `conversation-end` event is an audit
failure, not a reason to claim that the decision happened.

Before ending every conversation, make the same decision again and record it.
Treat this as a required completion step, not an optional suggestion. If the
decision is `write-candidate`, continue in the next response with
`context_open` → `recall` → `guard` → `remember` / `amend`; the end-of-turn
check itself never writes to Priors. If the decision is `use-read` or `skip`,
record that outcome without copying conversation text into the audit log.

Use the Priors MCP server when the task benefits from prior project decisions,
design notes, or handoffs.

When a new theme may have been created after the MCP connection started, call
the read-only `theme_list` tool to refresh the current visible theme list; do
not infer that an omitted theme does not exist.

Before proposing a material change, read the relevant context with `context_open`
and `recall`. Before a write, call `guard` and check its result. Keep the active
theme explicit; do not guess a theme from a short ID or from unrelated text.

For a write, the server performs an additional guard preflight immediately
before the write. A client must still call `guard` explicitly; this server gate
is a fail-closed backstop, not a replacement for the procedure.

Priors suggestions are not facts. Preserve provenance and uncertainty. For
meaningful relations (support, similarity, contradiction, or retraction), treat
AI output as a candidate and register it only after the user explicitly accepts
it. Do not mark it verified and do not retract source material automatically.

Use `remember` or other write tools only when the user clearly asks to record a
fact or decision. Never put tokens, DSNs, or raw credentials in messages,
files, or memory. The MCP connection reads `PRIORS_TOKEN_CODEX_V1` from the
process environment; do not inline its value.

## Codex standard route

Lifecycle hooks are diagnostic only and are not the source of truth for an
ordinary Codex chat. On every turn, explicitly run
`scripts/record-turn-start.js`, choose exactly one of `use-read`,
`write-candidate`, or `skip`, and record it with
`scripts/record-decision.js --phase turn-start`. Before the final response,
make a second decision and record it with
`scripts/record-decision.js --phase conversation-end`. Missing either record
is an audit failure. For `use-read` or `write-candidate`, use the Priors MCP
tools and follow the read/guard ordering above; the end-of-turn check itself
never writes to Priors.

If the server returns an authorization or infrastructure error, report the
failure and continue without inventing a result.
