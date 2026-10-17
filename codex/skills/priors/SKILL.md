---
name: priors
description: Use the Priors AI memory system safely from Codex when it is useful.
---

# Priors

Use Priors according to the triggers below; there is no all-turn search or fixed tool sequence. When durable important information meets the retention criteria, save it before completing the answer without waiting for an explicit “remember” request. When relevant prior information may materially affect an answer or important action and is missing from current context, retrieve the narrowest useful scope before relying on it. Unrelated facts and temporary discussion do not need to be saved or searched. Heuristic cues are not proof of coverage and do not confirm facts. Never put prompt text in Priors memory or the audit log.

## Retention and recall

- Retain durable user instructions/preferences, important decisions and constraints (including rejected alternatives), unresolved commitments, significant operational/safety/recovery results, and material corrections or new evidence. Preserve source, uncertainty, and whether something is decided or proposed.
- Do not retain ordinary facts, transient topics, secrets, or information the user forbids saving.
- Recall before depending on prior decisions/specifications, during a resume or handoff, when an old mistake/rejected approach could recur, for history questions, or when missing context could change an important answer/action. If current conversation already contains enough, avoid duplicate retrieval. Do not search every turn or the whole theme.
- Choose among `context_open`, `recall`/`consult`, `get`, `timeline`, `expand`, and other tools for the task. There is no fixed order, no A→B→C topic-switch detection, and no bulk reconstruction.
- A hook cue, local candidate, or audit line does not prove a successful read/write. Claim a save only after the success response returns a memory ID and version. Treat denial, failure, timeout, or unknown outcome as unverified.

Use the Priors MCP server when prior project decisions, design notes, or handoffs would help.

## One subject per memory

Write one memory per subject. Keep deployment/work reports short and link subject memories with `relates_to`; do not dilute an existing memory by adding another subject.

## Authorization and error handling

Only a memory's owner can directly edit, retract, supersede, pin, split, merge, or resolve it. Another client kind (Claude/Codex) is a different owner even for the same person; a human request does not grant cross-client write permission, and an AI cannot change a human-protected memory. On `forbidden` / SQLSTATE `42501`, do not retry as owner or seek a delegation. For `other_client`, leave your own memory instead (`dispute`, or an `amends` / `refutes` / `supports` / `answers` link); only the owner changes the source memory. If the server returns an authorization or infrastructure error, report the failure and continue without inventing a result.

- Never put tokens, DSNs, or raw credentials in messages, files, commands, or memory. The Codex connection reads `PRIORS_TOKEN_CODEX_V1` from the environment; do not inline its value.
- Before proposing a material change, read the relevant prior context (`context_open` / `consult`) and call `guard` explicitly; the server-side gate is only a fail-closed backstop.
- Keep the active theme explicit. Do not guess a theme or work item from a short ID or unrelated text.

## Load details only when relevant

- For write contracts, retries, version conflicts, capacity errors, cross-client handoffs, `document` use, re-reading themes with `theme_list`, optional search features (`query_variants`, `view: current`, compact responses), `refs.observations`, and plugin-version checks, read [daily cross-client route](daily-cross-client-route.md). For continuing-request and search-card contracts, read [retention and search cards](retention-and-search-cards.md).
- For organizing a theme or changing a memory's relations, read [theme organization](theme-organization.md).
- For short-lived work state and peer handoffs, read [working cache](working-cache.md).
- For deferred actions or credential exposure, read [deferred work and credential exposure](deferred-work.md).
- For search-card recovery, read [search-card recovery](search-card-recovery.md).

These references are on-demand details; this file contains the shared triggers and critical authorization boundary.
