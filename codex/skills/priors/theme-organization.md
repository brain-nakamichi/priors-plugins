## Optional theme organization

If the user asks to organize a whole theme, the AI may decide whether the
`theme_organize` tool is useful for that request. It is an optional operation,
not a required Priors workflow, and it does not require a fixed
`context_open` → `recall` → `guard` sequence. If chosen, first refresh with
`theme_list` and use its `theme_id` and `current_generation`; follow the tool's
authorization and provenance contract. The tool commits a generation directly
and does not delete source memories or automatically retract them. Parent/child
and other semantic links supplied as organization notes remain unverified. If
the theme has no `theme_id` or generation head, do not guess identifiers.
For an individual memory edit, retraction, split, or merge, `maintain` is an
available alternative when the AI judges it appropriate.

Before proposing a material change, read the relevant context with `context_open`
and `consult`. A successful `consult` whose nested guard was checked satisfies
the client guard step; on an older server, use `recall` followed by `guard`.
Keep the active theme explicit; do not guess a theme or work from a short ID or
unrelated text.

For a write, the server performs an additional guard preflight immediately
before the write. A client must still call `guard` explicitly; this server gate
is a fail-closed backstop, not a replacement for the procedure.

Priors suggestions are not facts. Preserve provenance and uncertainty. For
meaningful relations (support, similarity, contradiction, or retraction), register
them directly with `relation` `record`; registered does not mean correct. Only
the author can `withdraw` a relation. Rebut another AI's relation with a memory
carrying `refs.relation_id`. Do not mark it verified and do not retract source
material automatically.

Remember durable user instructions, important decisions and constraints,
rejected approaches, unresolved commitments, significant operational results,
and material corrections without waiting for "remember this". Undecided
consultations, comparisons and hypotheses can also be retained when materially
important, typed as `hypothesis` / `working` with their uncertainty and source.
Use `remember` for durable items, `working_cache_write` for short-lived work
state, and `checkpoint` for unresolved handoff state. Ordinary facts,
transient discussion, greetings, repeats, secrets, and forbidden content are
not retention targets. Keep the summary short and never present a proposal as
an adopted decision. A save counts only when the server's success response
(memory id and version, or cache id) came back. Keep answering if a save fails
and state that it remains unconfirmed. Never put tokens, DSNs, or raw
credentials in messages, files, or memory. The MCP connection reads
`PRIORS_TOKEN_CODEX_V1` from the process environment; do not inline its value.
