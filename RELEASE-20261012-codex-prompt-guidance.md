# Codex turn-start Priors guidance — 0.1.45

## Change

- Register `UserPromptSubmit` and provide concise model-visible `additionalContext` for retention and timely Recall on each submitted turn.
- Remove the `Stop` hook and its UI-only warning; the turn-start hook does not block or create an extra model response.
- The hook does not read, log, or persist prompt text and does not call Priors tools.
- Keep the selection of tools and search scope with the model; no unrelated all-turn search or fixed sequence is prescribed.
- Align both Codex plugin manifests at 0.1.45 and update the Codex skill's hook description.

## Verification

- `node --test codex/test/user-prompt-submit.test.js`
- Validate manifests, hook registration, and command target.
