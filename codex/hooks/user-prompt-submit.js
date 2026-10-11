'use strict';

// Codex does not register this hook. Priors use is selected independently by
// the assistant from the task; no prompt-level heuristic or audit event runs.
if (require.main === module) process.exit(0);

module.exports = {};
