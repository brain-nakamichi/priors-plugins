# Codex Stop hook restoration — 0.1.43

## Change

- Restore the Codex `Stop` lifecycle hook and provide one end-of-turn reminder to assess durable Remember candidates and relevant Recall needs.
- Keep the decision with the assistant: saving is not forced, and the hook does not invoke Priors tools or store transcript content.
- On Stop-hook re-entry, return a successful continuation response without prompting again.
- Align both Codex plugin manifests at 0.1.43.

## Verification

- `node --test codex/test/conversation-end.test.js`
- JSON manifests and the registered Stop command target validated locally.
