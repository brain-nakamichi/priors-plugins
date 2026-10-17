## Codex standard route

### Deferred work and credential exposure

- When a durable handoff would help, record adopted unfinished deferred actions (後回し・あとで・延期・user-side operations) in a work item. Distinguish negation, quotation and completion; verify the saved ID. Deferral never means completion or cancellation.
- Treat secret-shaped input or an exposure report as suspicion, not proof of validity or compromise. Never copy its raw text, partial values or hash into shell arguments, tool queries, logs or memory. Use a safe summary. Do not retrieve, revoke or issue credentials automatically. Codex's UserPromptSubmit hook supplies only retention and Recall guidance; it is not a secret detector or audit route. The explicit safe-summary route remains required, and a file on disk does not establish runtime protection.
- If it is useful to document a safety report, you may run `scripts/record-input-safety.js --kind suspected|reported|uninspectable` with only the fixed kind, never a value. This is an explicit local record, not an automatic Stop notice. Value-free reports need not suppress safe search. Input hooks cover only user prompts, not tool output, and do not erase secrets already in client conversation logs.
- Reuse work only after checking service, purpose and incident. Never select by newest date or word match alone. Read full brief for a known ID; partial/empty compact output is not absence. An explicit ID not found must not fall back to creation. Do not modify the other AI's work; share your own evidence. For closed work, distinguish reopening the same incident from a new exposure.
- For a genuinely new incident, supply a random UUID idempotency_key unrelated to prompt/secret. Unknown outcome: retry identical key and arguments, not a new operation. Re-read versions before work_event; reconcile conflicts. Confirm successful storage or state that it remains unsaved.
- Completion covers all confirmed targets: old revocation/new issuance or verified reason it is unnecessary, all required consumer updates and connections, authorized non-secret revocation confirmation. Aggregate the three states over all targets; record partial evidence separately, distinguishing reports from measurements. New connectivity alone does not prove old revocation. Redeploy only if independently required. Never request or test an old value again.

Lifecycle hooks are diagnostic only and are not the source of truth for an
ordinary Codex chat. Turn-start and conversation-end audit records are optional;
use `scripts/record-decision.js` when recording a decision or save outcome is
useful. An absent record is not an audit failure. Use Priors tools only when
they help with the task, following the read-then-guard ordering in SKILL.md.

If the server returns an authorization or infrastructure error, report the
failure and continue without inventing a result.
