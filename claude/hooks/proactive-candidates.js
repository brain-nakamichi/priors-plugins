'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_CANDIDATES = 100;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function candidatePath(env = process.env) {
  const configured = env.PRIORS_PROACTIVE_CANDIDATE_FILE;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.priors', 'proactive-candidates.jsonl');
}

// Journals are append-only and may contain a partially written or foreign
// line. Read each line independently so one malformed record cannot hide all
// usable candidates from the reviewer.
function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function recordProactiveCandidate({ promptHash, signals, confidence = 'low' }, env = process.env) {
  if (!/^[0-9a-f]{64}$/.test(promptHash)) return null;
  const categories = signals.filter((value) => value === 'recall-likely' || value === 'remember-candidate' || value === 'unresolved-candidate' || value === 'work-item-candidate');
  if (categories.length === 0) return null;
  const file = candidatePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const event = {
    schema: 'priors.proactive-candidate.v1',
    recorded_at: new Date().toISOString(),
    source: 'local-heuristic',
    confidence: confidence === 'high' ? 'high' : 'low',
    prompt_sha256: promptHash,
    categories,
    candidate_id: `pc-${promptHash.slice(0, 12)}-${categories.join('-')}`,
  };
  // Read the raw journal for writes.  A malformed line or a different
  // candidate schema must not make this writer truncate unrelated records.
  let rawLines = [];
  try {
    rawLines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch { /* create on demand */ }
  const existing = rawLines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((item) => item && item.schema === 'priors.proactive-candidate.v1'
    && !item.reviewed_at && Number.isFinite(Date.parse(item.recorded_at || ''))
    && Date.parse(item.recorded_at || '') >= Date.now() - MAX_AGE_MS);
  const duplicate = existing.some((item) => item.prompt_sha256 === promptHash
    && Array.isArray(item.categories)
    && item.categories.length === categories.length
    && item.categories.every((category) => categories.includes(category)));
  if (duplicate) return { file, event: null, duplicate: true };
  const retained = [...rawLines, JSON.stringify(event)].slice(-MAX_CANDIDATES);
  fs.writeFileSync(file, `${retained.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
  return { file, event };
}

function pendingProactiveCandidates(env = process.env) {
  const file = candidatePath(env);
  const cutoff = Date.now() - MAX_AGE_MS;
  return readJsonLines(file).filter((event) => {
    if (event?.schema !== 'priors.proactive-candidate.v1') return false;
    const timestamp = Date.parse(event.recorded_at || '');
    return Number.isFinite(timestamp) && timestamp >= cutoff && !event.reviewed_at;
  });
}

function acknowledgeProactiveCandidates(decision, env = process.env) {
  if (!['use-read', 'write-candidate', 'skip'].includes(decision)) return 0;
  const categoriesToReview = decision === 'use-read' ? new Set(['recall-likely']) : null;
  const file = candidatePath(env);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const reviewedAt = new Date().toISOString();
    let count = 0;
    const updated = lines.map((line) => {
      try {
        const event = JSON.parse(line);
        if (event?.schema !== 'priors.proactive-candidate.v1' || event.reviewed_at) return line;
        if (categoriesToReview && !Array.isArray(event.categories)
          || categoriesToReview && !event.categories.some((category) => categoriesToReview.has(category))) return line;
        const timestamp = Date.parse(event.recorded_at || '');
        if (!Number.isFinite(timestamp) || timestamp < Date.now() - MAX_AGE_MS) return line;
        count += 1;
        return JSON.stringify({ ...event, reviewed_at: reviewedAt, review_decision: decision });
      } catch {
        return line;
      }
    });
    if (count > 0) {
      fs.writeFileSync(file, `${updated.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
    }
    return count;
  } catch {
    return 0;
  }
}

// Collapse the remember signals observed during a conversation into one
// reviewable candidate.  The candidate intentionally contains hashes and
// provenance only; the conversation text never crosses this boundary.
function materializeRememberCandidate(env = process.env) {
  const source = pendingProactiveCandidates(env)
    .filter((event) => Array.isArray(event.categories) && event.categories.includes('remember-candidate'))
    .map((event) => ({
      candidate_id: event.candidate_id,
      prompt_sha256: event.prompt_sha256,
      confidence: event.confidence === 'high' ? 'high' : 'low',
      recorded_at: event.recorded_at,
    }))
    .filter((event) => typeof event.candidate_id === 'string' && /^[0-9a-f]{64}$/.test(event.prompt_sha256 || ''));
  if (source.length === 0) return { candidate: null, duplicate: false };
  const sourceIds = source.map((event) => event.candidate_id).sort();
  const candidateId = `rc-${crypto.createHash('sha256').update(sourceIds.join('\n')).digest('hex').slice(0, 16)}`;
  const file = candidatePath(env);
  let existing = [];
  existing = readJsonLines(file);
  const duplicate = existing.some((event) => event?.schema === 'priors.remember-candidate.v1'
    && event.candidate_id === candidateId);
  if (duplicate) return { candidate: existing.find((event) => event.candidate_id === candidateId) || null, duplicate: true };
  const candidate = {
    schema: 'priors.remember-candidate.v1',
    generated_at: new Date().toISOString(),
    source: 'conversation-end-local-heuristic',
    candidate_id: candidateId,
    candidate_type: 'remember',
    source_candidate_ids: sourceIds,
    evidence_hashes: source.map((event) => event.prompt_sha256).sort(),
    confidence: source.some((event) => event.confidence === 'high') ? 'high' : 'low',
    confirmation_state: 'pending',
    requires_confirmation: true,
    next_action: 'context_open → recall → guard → remember/amend',
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const retained = [...existing, candidate].slice(-MAX_CANDIDATES);
  fs.writeFileSync(file, `${retained.map((item) => JSON.stringify(item)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
  return { file, candidate, duplicate: false };
}

function pendingRememberCandidates(env = process.env) {
  const file = candidatePath(env);
  const cutoff = Date.now() - MAX_AGE_MS;
  return readJsonLines(file).filter((event) => {
    const generated = Date.parse(event.generated_at || '');
    return event?.schema === 'priors.remember-candidate.v1'
      && event.confirmation_state === 'pending'
      && Number.isFinite(generated) && generated >= cutoff;
  });
}

function materializeCheckpointCandidate(env = process.env) {
  const source = pendingProactiveCandidates(env)
    .filter((event) => Array.isArray(event.categories) && event.categories.includes('unresolved-candidate'))
    .map((event) => ({ candidate_id: event.candidate_id, prompt_sha256: event.prompt_sha256, confidence: event.confidence === 'high' ? 'high' : 'low' }))
    .filter((event) => typeof event.candidate_id === 'string' && /^[0-9a-f]{64}$/.test(event.prompt_sha256 || ''));
  if (source.length === 0) return { candidate: null, duplicate: false };
  const sourceIds = source.map((event) => event.candidate_id).sort();
  const candidateId = `cp-${crypto.createHash('sha256').update(sourceIds.join('\n')).digest('hex').slice(0, 16)}`;
  const file = candidatePath(env);
  const existing = readJsonLines(file);
  const duplicate = existing.some((event) => event?.schema === 'priors.checkpoint-candidate.v1' && event.candidate_id === candidateId);
  if (duplicate) return { candidate: existing.find((event) => event.candidate_id === candidateId) || null, duplicate: true };
  const candidate = {
    schema: 'priors.checkpoint-candidate.v1', generated_at: new Date().toISOString(),
    source: 'conversation-end-local-heuristic', candidate_id: candidateId, candidate_type: 'checkpoint',
    source_candidate_ids: sourceIds, evidence_hashes: source.map((event) => event.prompt_sha256).sort(),
    confidence: source.some((event) => event.confidence === 'high') ? 'high' : 'low',
    confirmation_state: 'pending', requires_confirmation: true,
    next_action: 'review question and call checkpoint with explicit payload',
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${[...existing, candidate].slice(-MAX_CANDIDATES).map((item) => JSON.stringify(item)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return { file, candidate, duplicate: false };
}

function pendingCheckpointCandidates(env = process.env) {
  const file = candidatePath(env);
  const cutoff = Date.now() - MAX_AGE_MS;
  return readJsonLines(file).filter((event) => {
    const generated = Date.parse(event.generated_at || '');
    return event?.schema === 'priors.checkpoint-candidate.v1' && event.confirmation_state === 'pending'
      && Number.isFinite(generated) && generated >= cutoff;
  });
}

function confirmCheckpointCandidate(candidateId, input = {}, env = process.env) {
  if (!/^cp-[0-9a-f]{16}$/.test(candidateId || '') || !input || typeof input !== 'object') return { ok: false, error: 'invalid_id' };
  const phases = new Set(['precompact', 'stop', 'session_end', 'manual']);
  if (typeof input.theme !== 'string' || !/^[A-Z][A-Z0-9]{1,7}$/.test(input.theme)
    || typeof input.session_id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.session_id)
    || !phases.has(input.phase) || typeof input.summary !== 'string' || input.summary.length < 1
    || [...input.summary].length > 4000 || typeof input.idempotency_key !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotency_key)
    || (input.next_actions !== undefined && (!Array.isArray(input.next_actions) || input.next_actions.some((value) => typeof value !== 'string')))
    || (input.open_threads !== undefined && (!Array.isArray(input.open_threads) || input.open_threads.some((value) => typeof value !== 'string')))) return { ok: false, error: 'invalid_payload' };
  const file = candidatePath(env);
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    let found = false;
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const updated = lines.map((line) => {
      let event; try { event = JSON.parse(line); } catch { return line; }
      if (event?.schema !== 'priors.checkpoint-candidate.v1' || event.candidate_id !== candidateId) return line;
      if (event.confirmation_state !== 'pending') return line;
      found = true;
      return JSON.stringify({ ...event, confirmation_state: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_payload_sha256: payloadHash, next_action: 'call checkpoint with reviewed payload' });
    });
    if (!found) return { ok: false, error: 'candidate_not_pending' };
    fs.writeFileSync(file, `${updated.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, candidate_id: candidateId, payload: input };
  } catch { return { ok: false, error: 'candidate_file_unavailable' }; }
}

// Confirm a Remember candidate only after a reviewer supplies the complete,
// server-ready payload.  The heuristic candidate stores hashes/provenance, so
// this boundary never infers or persists conversation text automatically.
function confirmRememberCandidate(candidateId, input = {}, env = process.env) {
  if (!/^rc-[0-9a-f]{16}$/.test(candidateId || '') || !input || typeof input !== 'object') {
    return { ok: false, error: 'invalid_id' };
  }
  const allowed = new Set([
    'namespace', 'kind', 'memory_type', 'title', 'body', 'idempotency_key',
    'valid_from', 'valid_to', 'tags', 'metrics', 'refs', 'links', 'evidence',
    'rejected_actions', 'session_id', 'guard_receipt_id',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { ok: false, error: 'invalid_payload' };
  const kinds = new Set(['goal', 'rule', 'decision', 'experiment', 'finding', 'hypothesis', 'retraction', 'question', 'answer', 'handoff']);
  const memoryTypes = new Set(['episodic', 'semantic', 'procedural', 'profile', 'working']);
  if (typeof input.namespace !== 'string' || !/^[A-Z][A-Z0-9]{1,7}$/.test(input.namespace)
    || !kinds.has(input.kind) || !memoryTypes.has(input.memory_type)
    || typeof input.title !== 'string' || input.title.length < 1 || [...input.title].length > 120
    || typeof input.body !== 'string' || input.body.length < 1
    || typeof input.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotency_key)
    || (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string')))
    || (input.evidence !== undefined && (!Array.isArray(input.evidence) || input.evidence.some((item) => !item || typeof item !== 'object')))) {
    return { ok: false, error: 'invalid_payload' };
  }
  const file = candidatePath(env);
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    let found = false;
    let sourceCandidateIds = [];
    const confirmedAt = new Date().toISOString();
    const payload = { ...input };
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const updated = lines.map((line) => {
      let event;
      try { event = JSON.parse(line); } catch { return line; }
      if (event?.schema !== 'priors.remember-candidate.v1' || event.candidate_id !== candidateId) return line;
      if (event.confirmation_state !== 'pending') return line;
      found = true;
      sourceCandidateIds = Array.isArray(event.source_candidate_ids) ? event.source_candidate_ids : [];
      return JSON.stringify({
        ...event,
        confirmation_state: 'confirmed',
        confirmed_at: confirmedAt,
        confirmed_payload_sha256: payloadHash,
        next_action: 'call remember with reviewed payload',
      });
    });
    if (!found) return { ok: false, error: 'candidate_not_pending' };
    fs.writeFileSync(file, `${updated.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
    return { ok: true, candidate_id: candidateId, source_candidate_ids: sourceCandidateIds, payload };
  } catch {
    return { ok: false, error: 'candidate_file_unavailable' };
  }
}

// Collapse work-item signals into a reviewable local candidate.  A work ID is
// never guessed here; the next step is brief or explicit work selection.
function materializeWorkItemCandidate(env = process.env) {
  const source = pendingProactiveCandidates(env)
    .filter((event) => Array.isArray(event.categories) && event.categories.includes('work-item-candidate'))
    .map((event) => ({
      candidate_id: event.candidate_id,
      prompt_sha256: event.prompt_sha256,
      confidence: event.confidence === 'high' ? 'high' : 'low',
    }))
    .filter((event) => typeof event.candidate_id === 'string' && /^[0-9a-f]{64}$/.test(event.prompt_sha256 || ''));
  if (source.length === 0) return { candidate: null, duplicate: false };
  const sourceIds = source.map((event) => event.candidate_id).sort();
  const candidateId = `wc-${crypto.createHash('sha256').update(sourceIds.join('\n')).digest('hex').slice(0, 16)}`;
  const file = candidatePath(env);
  const existing = readJsonLines(file);
  const duplicate = existing.some((event) => event?.schema === 'priors.work-item-candidate.v1'
    && event.candidate_id === candidateId);
  if (duplicate) return { candidate: existing.find((event) => event.candidate_id === candidateId) || null, duplicate: true };
  const candidate = {
    schema: 'priors.work-item-candidate.v1',
    generated_at: new Date().toISOString(),
    source: 'conversation-end-local-heuristic',
    candidate_id: candidateId,
    candidate_type: 'work_item',
    source_candidate_ids: sourceIds,
    evidence_hashes: source.map((event) => event.prompt_sha256).sort(),
    confidence: source.some((event) => event.confidence === 'high') ? 'high' : 'low',
    confirmation_state: 'pending',
    requires_confirmation: true,
    work_selection: 'required',
    next_action: 'brief (without work_id) → explicit work ID selection → work_event(event_type=verification_recorded)',
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const retained = [...existing, candidate].slice(-MAX_CANDIDATES);
  fs.writeFileSync(file, `${retained.map((item) => JSON.stringify(item)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
  return { file, candidate, duplicate: false };
}

function pendingWorkItemCandidates(env = process.env) {
  const file = candidatePath(env);
  const cutoff = Date.now() - MAX_AGE_MS;
  return readJsonLines(file).filter((event) => {
    const generated = Date.parse(event.generated_at || '');
    return event?.schema === 'priors.work-item-candidate.v1'
      && event.confirmation_state === 'pending'
      && Number.isFinite(generated) && generated >= cutoff;
  });
}

function confirmWorkItemCandidate(candidateId, workId, env = process.env) {
  if (!/^wc-[0-9a-f]{16}$/.test(candidateId || '') || !/^[A-Z][A-Z0-9]{1,7}-w[0-9]+$/.test(workId || '')) {
    return { ok: false, error: 'invalid_id' };
  }
  const file = candidatePath(env);
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    let found = false;
    const confirmedAt = new Date().toISOString();
    const updated = lines.map((line) => {
      let event;
      try { event = JSON.parse(line); } catch { return line; }
      if (event?.schema !== 'priors.work-item-candidate.v1' || event.candidate_id !== candidateId) return line;
      if (event.confirmation_state !== 'pending') return line;
      found = true;
      return JSON.stringify({
        ...event,
        confirmation_state: 'confirmed',
        confirmed_at: confirmedAt,
        confirmed_work_id: workId,
        next_action: `brief(${workId}) → work_event(event_type=verification_recorded)`,
      });
    });
    if (!found) return { ok: false, error: 'candidate_not_pending' };
    fs.writeFileSync(file, `${updated.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows / ACLs: best effort */ }
    return { ok: true, candidate_id: candidateId, work_id: workId };
  } catch {
    return { ok: false, error: 'candidate_file_unavailable' };
  }
}

function prepareWorkEvent(candidateId, workId, input = {}, env = process.env) {
  const eventTypes = new Set(['started', 'fix_recorded', 'deployment_recorded', 'verification_recorded', 'blocked', 'resolve', 'reopen', 'cancel']);
  if (!/^wc-[0-9a-f]{16}$/.test(candidateId || '') || !/^[A-Z][A-Z0-9]{1,7}-w[0-9]+$/.test(workId || '')) {
    return { ok: false, error: 'invalid_id' };
  }
  if (!eventTypes.has(input.event_type) || !Number.isInteger(input.expected_work_version) || input.expected_work_version < 1) {
    return { ok: false, error: 'invalid_event' };
  }
  const file = candidatePath(env);
  let candidate;
  candidate = readJsonLines(file)
    .find((event) => event?.schema === 'priors.work-item-candidate.v1' && event.candidate_id === candidateId);
  if (!candidate || candidate.confirmation_state !== 'confirmed' || candidate.confirmed_work_id !== workId) {
    return { ok: false, error: 'candidate_not_confirmed_for_work' };
  }
  if (['fix_recorded', 'deployment_recorded', 'verification_recorded', 'resolve'].includes(input.event_type)
    && (!Array.isArray(input.basis) || input.basis.length === 0)) {
    return { ok: false, error: 'basis_required' };
  }
  if (input.event_type === 'verification_recorded') {
    if (!input.verification_state || !input.verification_environment) {
      return { ok: false, error: 'verification_details_required' };
    }
    if (!input.verification_method || typeof input.verification_method !== 'string'
      || !input.verification_target || typeof input.verification_target !== 'object'
      || !input.verification_tool_output || typeof input.verification_tool_output !== 'object'
      || !input.verification_assessment || typeof input.verification_assessment !== 'object'
      || !input.verification_executed_at
      || !input.verification_source || typeof input.verification_source !== 'object') {
      return { ok: false, error: 'structured_verification_details_required' };
    }
    if (!input.verification_target.type || !input.verification_target.id
      || input.verification_target.version === undefined
      || !input.verification_tool_output.status
      || !input.verification_assessment.decision || !input.verification_assessment.reason
      || !input.verification_source.type || !input.verification_source.reference) {
      return { ok: false, error: 'structured_verification_fields_required' };
    }
  }
  return {
    ok: true,
    candidate_id: candidateId,
    work_id: workId,
    payload: {
      work_id: workId,
      expected_work_version: input.expected_work_version,
      event_type: input.event_type,
      ...(input.status ? { status: input.status } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.target_environment ? { target_environment: input.target_environment } : {}),
      ...(input.implementation_state ? { implementation_state: input.implementation_state } : {}),
      ...(input.deployment_state ? { deployment_state: input.deployment_state } : {}),
      ...(input.verification_state ? { verification_state: input.verification_state } : {}),
      ...(input.verification_environment ? { verification_environment: input.verification_environment } : {}),
      ...(input.verification_method ? { verification_method: input.verification_method } : {}),
      ...(input.verification_target ? { verification_target: input.verification_target } : {}),
      ...(input.verification_tool_output ? { verification_tool_output: input.verification_tool_output } : {}),
      ...(input.verification_assessment ? { verification_assessment: input.verification_assessment } : {}),
      ...(input.verification_executed_at ? { verification_executed_at: input.verification_executed_at } : {}),
      ...(input.verification_source ? { verification_source: input.verification_source } : {}),
      ...(input.next_action ? { next_action: input.next_action } : {}),
      basis: input.basis || [],
    },
    next_action: 'server append_work_event を、同じwork IDとexpected_work_versionで実行する',
  };
}

function summarizeProactiveCandidates(env = process.env) {
  const summary = { total: 0, high_confidence: 0, categories: { 'recall-likely': 0, 'remember-candidate': 0, 'unresolved-candidate': 0, 'work-item-candidate': 0 } };
  for (const event of pendingProactiveCandidates(env)) {
    summary.total += 1;
    if (event.confidence === 'high') summary.high_confidence += 1;
    for (const category of event.categories || []) {
      if (Object.hasOwn(summary.categories, category)) summary.categories[category] += 1;
    }
  }
  return summary;
}

function listProactiveCandidates(env = process.env) {
  const events = [
    ...pendingProactiveCandidates(env).map((event) => ({
      schema: event.schema, candidate_id: event.candidate_id, categories: event.categories,
      confidence: event.confidence, recorded_at: event.recorded_at,
      next_action: 'review candidate source and choose use-read/write-candidate/skip',
    })),
    ...pendingRememberCandidates(env).map((event) => ({
      schema: event.schema, candidate_id: event.candidate_id, categories: ['remember-candidate'],
      confidence: event.confidence, recorded_at: event.generated_at,
      confirmation_state: event.confirmation_state, next_action: event.next_action,
    })),
    ...pendingWorkItemCandidates(env).map((event) => ({
      schema: event.schema, candidate_id: event.candidate_id, categories: ['work-item-candidate'],
      confidence: event.confidence, recorded_at: event.generated_at,
      confirmation_state: event.confirmation_state, next_action: event.next_action,
    })),
  ];
  return { candidates: events, total: events.length };
}

module.exports = {
  candidatePath,
  recordProactiveCandidate,
  pendingProactiveCandidates,
  summarizeProactiveCandidates,
  listProactiveCandidates,
  acknowledgeProactiveCandidates,
  materializeRememberCandidate,
  pendingRememberCandidates,
  materializeCheckpointCandidate,
  pendingCheckpointCandidates,
  confirmCheckpointCandidate,
  confirmRememberCandidate,
  materializeWorkItemCandidate,
  pendingWorkItemCandidates,
  confirmWorkItemCandidate,
  prepareWorkEvent,
};
