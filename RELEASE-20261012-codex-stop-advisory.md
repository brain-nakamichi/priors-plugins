# Codex Stop advisory — 0.1.44

## Change

- Keep the Codex `Stop` hook registered and provide a concise Remember/Recall advisory through `systemMessage`.
- Do not return `decision: "block"`; the advisory must not force an additional model response.
- The hook reads no transcript and writes no memory or audit data.
- Align both Codex plugin manifests at 0.1.44.

## Verification

- The source was inspected and invoked directly; `systemMessage` output was confirmed with no continuation decision.
- `node --test codex/test/conversation-end.test.js` could not run because the Windows sandbox denied the test runner's worker-process spawn (`EPERM`).
- JSON manifests and the registered Stop command target validated locally.

Codex documents `systemMessage` as a UI/event-stream warning. Stop does not document `additionalContext` as model-context output, so this release intentionally uses the supported non-blocking advisory field.
