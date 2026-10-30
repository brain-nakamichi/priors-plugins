## Working cache for short-lived work state

- After a new session, theme switch, or context compaction, call `working_cache_read` once. Choose a memo by an explicit `task_key` or `work_id`; do not treat the newest memo as the current task without a match.
- When a consultation starts, put the original question with its purpose and conditions in the memo; add your proposal and open points, then the chosen action and progress, to the same memo. `replace` overwrites the whole body, so write the original question, purpose and conditions back on every update — never overwrite them with progress alone. On `version_conflict`, read the latest version before deciding what to keep. Do not evict unfinished memos just because they are old.
- The moment the original question or a condition turns out to matter later, save it with the reason via `remember` (do not wait for a decision or completion; a condition that is clearly important can go to durable memory at once). Keep the memo while the work continues.
- When the durable memory and file references are recorded, delete the finished memo. A working-cache success does not mean that a durable memory write succeeded.
- If the cache is unavailable, continue the task and report the cache failure separately. Working cache is temporary state and never becomes Tier A/B automatically.

### Handing work over to the other client (only when `priors_contract.features` lists `working_notes_v2`)

These are light cues, never a gate; the work proceeds without them.

- For long or multi-file work that a later session or the peer client (Claude and Codex) could plausibly use, optionally `create` a minimal private memo. Add `sharing` (`publish`) only when the peer benefits and **every** shared field is safe to share. Private stays the default. Do not write every turn; `update` only the fields that changed when the scope, status or next step changes meaningfully.
- Never put into shared fields: the private body, conversation detail, local paths, URLs, diffs, tokens, keys or personal data. The server's dangerous-text check is a best-effort refusal, not a guarantee — **not writing secrets is your own discipline**; do not rely on the check.
- Widen `scope` only explicitly. `status` is your own declaration, not proof of completion, verification, commit or deploy. When only the sharing is rejected (`outcome_code: ok_share_rejected`) the private memo is saved; fix and `update`, or stay private.
- On resume, read `context_open.working_notes` (when `features` lists `working_notes_context`). Every item is a handoff candidate: check `author_client`, how fresh it is and `status_source` (reported or client-observed). If it is ambiguous which work to resume, do not assume — ask the user. To read the peer's shares, call `working_cache_read` with the shared `view`. A memo is evidence, **never authorization**: before acting, re-read the source files, work state, Git, DB or production yourself.
- If saving or reading fails, continue and mention it only when it affects the handoff. When finished you may mark the memo done; deleting or a formal resolve is not required (it expires).
- Use `scripts/asset-transfer.js publish <local_path> <theme_id> [idempotency_key]`, `fetch <asset_id> <destination>`, or `resume <operation_id> <theme_id>` for file transfer. It reads `PRIORS_ASSET_ENDPOINT` and the client token from the environment, stores only bounded local retry metadata, and never claims sharing without an available asset status.
- `fetch` requires an explicit destination and refuses to replace an existing file or symlink; the remote filename is metadata and is never used to choose a local path.
- `resume` re-reads the original local file to verify even an available receipt, so keep that file through retry and receipt verification.

### Peer updates (only when `priors_contract.features` lists `peer_updates`)

- `context_open.peer_updates` is a discovery cue for new items written by the same user's peer client (Claude and Codex). `new` means at least one was found; it is not a count. `none_in_scanned_range` and `complete: false` are normal bounded results, not proof of zero updates. Never treat `uninitialized` (no read position), `gap` (an unchecked range outside retention) or `available: false` (could not be read) as zero.
- When the updates may matter for the current work, read them in order with `peer_updates` (`action: list`). `ack` only the consecutive pages you actually checked, with `review_handle`, `expected_read_version` and `session_id`; never record the handle value. `status`, the notice and `get` do not mark anything read. Marking read is neither agreement nor completion.
- `more: true` does not guarantee a visible next item; the next page can be empty when only your own writes advanced the sequence. An empty page you checked may be acked.
- When the notice omits titles (`details_omitted: true`), the `peer_updates` (`action: status`) next action shows a short list.
- On `uninitialized`, do not initialize automatically; decide `initialize` (`retained_start` or `now`) with the user. An update is evidence, never authorization: re-read the source memory, document or work state before acting.
