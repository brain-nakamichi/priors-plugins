'use strict';
// GEN-574 §8: local Markdown ⇄ Priors document sync against a small fake Priors (MCP + /documents raw routes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'document-sync.js');
const { classify, normalizeLf, repoPath, auditManifest, resolveDocument, resolveCommand, parseResolve, gitMerge } = require(SCRIPT);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('Claude and Codex plugin package versions and audit scripts stay aligned', () => {
  const root = path.resolve(__dirname, '..', '..');
  const versions = [
    require(path.join(root, 'plugin/package.json')).version,
    require(path.join(root, 'plugin/.claude-plugin/plugin.json')).version,
    require(path.join(root, 'plugin/.claude-plugin/marketplace.json')).metadata.version,
    require(path.join(root, 'plugin/.claude-plugin/marketplace.json')).plugins[0].version,
    require(path.join(root, 'codex-plugins/priors/.codex-plugin/plugin.json')).version,
    require(path.join(root, 'codex-plugins/marketplace.json')).plugins[0].version,
    require(path.join(root, 'codex-plugins/marketplace.json')).metadata.version,
    require(path.join(root, 'codex-plugins/marketplace.json')).version,
  ];
  assert.deepEqual(versions, Array(8).fill('0.1.67'));
  assert.equal(fs.readFileSync(path.join(root, 'plugin/scripts/document-sync.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'codex-plugins/priors/scripts/document-sync.js'), 'utf8'));
  for (const file of ['plugin/skills/priors/SKILL.md', 'codex-plugins/priors/skills/priors/SKILL.md',
    'plugin/README.md', 'codex-plugins/priors/README.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /weak_match_summary_available/);
    assert.match(text, /include_summaries: true/);
    assert.match(text, /固定順序|fixed order/);
  }
});

async function resolveFixture(t, { sourceBytes = Buffer.from('pinned\n'), localBytes = sourceBytes,
  documentBytes = sourceBytes, sourceOverrides = {}, dirty = false, ancestry = 'newer', sourceAvailable = true,
  mutateDuringGitRead = false, headBytes = localBytes, changeHeadAfterAncestry = false, changeRootAfterAncestry = false } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'priors-resolve-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); await fs.promises.mkdir(path.join(repo, 'docs'), { recursive: true });
  const abs = path.join(repo, 'docs', 'a.md'); await fs.promises.writeFile(abs, localBytes);
  const sourceCommit = 'a'.repeat(40), headCommit = 'b'.repeat(40);
  const source = { repo: 'priors', path: 'docs/a.md', mode: 'branch', ref: 'main', commit: sourceCommit,
    sha256: sha(sourceBytes), comparison_profile: 'raw-v1', ...sourceOverrides };
  const meta = { document_id: '432c36d9-37cc-4f9f-853d-693a56401a21', version: 9, sha256: sha(documentBytes),
    audit_note: null, local_source: source };
  let mutated = false; let currentHead = headCommit;
  const deps = {
    git: (_root, ...args) => {
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return repo;
      if (args[0] === 'rev-parse' && args.includes('HEAD^{commit}')) return currentHead;
      if (args[0] === 'status') return dirty ? ' M docs/a.md' : '';
      throw new Error('unexpected git command');
    },
    gitFile: async (_root, commit, relative) => {
      assert.equal(relative, 'docs/a.md');
      if (mutateDuringGitRead && !mutated) { mutated = true; await fs.promises.writeFile(abs, Buffer.from('raced\n')); }
      if (commit === sourceCommit && sourceAvailable) return sourceBytes;
      if (commit === headCommit) return headBytes;
      throw new Error('commit unavailable');
    },
    isAncestor: async (_root, older, newer) => {
      if (changeHeadAfterAncestry) currentHead = 'c'.repeat(40);
      if (changeRootAfterAncestry) {
        changeRootAfterAncestry = false;
        const moved = `${repo}-moved`;
        await fs.promises.rename(repo, moved);
        await fs.promises.mkdir(repo);
      }
      if (ancestry === 'newer') return older === sourceCommit && newer === headCommit;
      if (ancestry === 'older') return older === headCommit && newer === sourceCommit;
      if (ancestry === 'same') return older === newer;
      if (ancestry === 'diverged') return false;
      throw new Error('history unavailable');
    },
  };
  return { dir, repo, abs, meta, sourceCommit, headCommit, sourceBytes, localBytes, deps };
}

test('resolve uses the normal one-byte document read and returns an explicit source match with distinct Priors hash', async (t) => {
  const f = await resolveFixture(t, { documentBytes: Buffer.from('different Priors body\n') });
  let call;
  const out = await resolveCommand({ theme: 'GEN', id: f.meta.document_id, repo: f.repo, repoId: 'priors', version: 9 }, {
    ...f.deps, tool: async (name, args) => { call = { name, args }; return f.meta; },
  });
  assert.equal(call.name, 'document');
  assert.deepEqual(call.args, { action: 'read', theme: 'GEN', document_id: f.meta.document_id, version: 9, max_bytes: 1, offset_bytes: 0 });
  assert.equal(out.state, 'source_match');
  assert.equal(out.local_path, f.abs);
  assert.equal(out.local_sha256, sha(f.sourceBytes));
  assert.equal(out.source_sha256, sha(f.sourceBytes));
  assert.equal(out.sha256, sha(Buffer.from('different Priors body\n')), 'sha256 is the Priors document-body hash');
  assert.equal(out.version, 9);
  assert.equal(out.document_id, f.meta.document_id);
  assert.equal(out.matches_priors_bytes, false);
  assert.equal(out.audit_note, null);
  assert.equal(out.metadata_origin, 'live_read');
});

test('resolve fails closed if the normal read does not match the requested Priors ID or version', async (t) => {
  const f = await resolveFixture(t);
  const baseOptions = { theme: 'GEN', id: f.meta.document_id, repo: f.repo, repoId: 'priors', version: 9 };
  const wrongId = await resolveCommand(baseOptions, { ...f.deps, tool: async () => ({ ...f.meta, document_id: 'other' }) });
  assert.equal(wrongId.state, 'no_source'); assert.equal(wrongId.reason, 'requested_document_mismatch');
  const wrongVersion = await resolveCommand(baseOptions, { ...f.deps, tool: async () => ({ ...f.meta, version: 8 }) });
  assert.equal(wrongVersion.state, 'no_source'); assert.equal(wrongVersion.reason, 'requested_version_mismatch');
});

test('resolve returns no_source without local details for missing, incomplete, and mismapped metadata', async (t) => {
  const f = await resolveFixture(t);
  const noTuple = await resolveDocument({ ...f.meta, local_source: undefined }, f.repo, 'priors', f.deps);
  assert.equal(noTuple.state, 'no_source'); assert.equal(noTuple.version, 9); assert.equal(noTuple.local_path, undefined);
  const badTuple = await resolveDocument({ ...f.meta, local_source: { ...f.meta.local_source, path: '../secret' } }, f.repo, 'priors', f.deps);
  assert.equal(badTuple.state, 'no_source'); assert.equal(badTuple.local_path, undefined);
  const mismatch = await resolveDocument(f.meta, f.repo, 'other-repo', f.deps);
  assert.equal(mismatch.state, 'no_source'); assert.equal(mismatch.reason, 'repository_id_mismatch');
  assert.equal(mismatch.local_path, undefined);
});

test('resolve distinguishes missing files and refuses unknown pinned source commits', async (t) => {
  const missing = await resolveFixture(t); await fs.promises.rm(missing.abs);
  const absent = await resolveDocument(missing.meta, missing.repo, 'priors', missing.deps);
  assert.equal(absent.state, 'missing'); assert.equal(absent.local_path, missing.abs);
  const unknown = await resolveFixture(t, { sourceBytes: Buffer.from('audit source\n'), localBytes: Buffer.from('worktree\n'), sourceAvailable: false });
  const different = await resolveDocument(unknown.meta, unknown.repo, 'priors', unknown.deps);
  assert.equal(different.state, 'different'); assert.equal(different.reason, 'source_commit_unavailable');
});

test('resolve classifies older/newer only for clean HEAD bytes with proven ancestry', async (t) => {
  const older = await resolveFixture(t, { sourceBytes: Buffer.from('new source\n'), localBytes: Buffer.from('old HEAD\n'), ancestry: 'older' });
  const old = await resolveDocument(older.meta, older.repo, 'priors', older.deps);
  assert.equal(old.state, 'older'); assert.equal(old.reason, 'source_descends_from_head');
  const newer = await resolveFixture(t, { sourceBytes: Buffer.from('old source\n'), localBytes: Buffer.from('new HEAD\n'), ancestry: 'newer' });
  const fresh = await resolveDocument(newer.meta, newer.repo, 'priors', newer.deps);
  assert.equal(fresh.state, 'newer'); assert.equal(fresh.reason, 'head_descends_from_source');
  assert.equal(fresh.verified_comparison_profile, 'raw-v1');
  const dirty = await resolveFixture(t, { sourceBytes: Buffer.from('source\n'), localBytes: Buffer.from('edited\n'), dirty: true });
  assert.equal((await resolveDocument(dirty.meta, dirty.repo, 'priors', dirty.deps)).reason, 'dirty_worktree');
  const diverged = await resolveFixture(t, { sourceBytes: Buffer.from('source\n'), localBytes: Buffer.from('edited\n'), ancestry: 'diverged' });
  assert.equal((await resolveDocument(diverged.meta, diverged.repo, 'priors', diverged.deps)).reason, 'diverged_history');
  const headDiff = await resolveFixture(t, { sourceBytes: Buffer.from('source\n'), localBytes: Buffer.from('edited\n') });
  headDiff.deps.gitFile = async (_root, commit) => commit === headDiff.sourceCommit ? headDiff.sourceBytes : Buffer.from('different HEAD blob');
  assert.equal((await resolveDocument(headDiff.meta, headDiff.repo, 'priors', headDiff.deps)).reason, 'worktree_differs_from_head');
});

test('resolve supports declared CRLF normalization only against raw-hash-verified pinned Git bytes', async (t) => {
  const sourceBytes = Buffer.from('one\ntwo\n');
  const f = await resolveFixture(t, { sourceBytes, localBytes: Buffer.from('one\r\ntwo\r\n'),
    sourceOverrides: { comparison_profile: 'utf8-crlf-lf-v1' } });
  const out = await resolveDocument(f.meta, f.repo, 'priors', f.deps);
  assert.equal(out.state, 'source_match');
  assert.equal(out.verified_comparison_profile, 'utf8-crlf-lf-v1');
  assert.notEqual(out.local_sha256, out.source_sha256, 'newline-normalized matches can have different raw hashes');
  assert.equal(out.matches_priors_bytes, false);
  const rawEqual = await resolveFixture(t, { sourceBytes, localBytes: sourceBytes,
    sourceOverrides: { comparison_profile: 'utf8-crlf-lf-v1' } });
  const rawMatch = await resolveDocument(rawEqual.meta, rawEqual.repo, 'priors', rawEqual.deps);
  assert.equal(rawMatch.state, 'source_match');
  assert.equal(rawMatch.verified_comparison_profile, 'raw-v1', 'an exact byte match is reported as raw comparison');
  const normalizedMismatch = await resolveFixture(t, { sourceBytes, localBytes: Buffer.from('one\r\ntwo!\r\n'), dirty: true,
    sourceOverrides: { comparison_profile: 'utf8-crlf-lf-v1' } });
  const mismatch = await resolveDocument(normalizedMismatch.meta, normalizedMismatch.repo, 'priors', normalizedMismatch.deps);
  assert.equal(mismatch.state, 'different');
  assert.equal(mismatch.reason, 'dirty_worktree');
  assert.equal(mismatch.verified_comparison_profile, null, 'a rejected dirty worktree has no verified comparison profile');
  assert.notEqual(mismatch.state, 'source_match', 'a failed normalized comparison must never report a match');
  const wrongRawPin = await resolveFixture(t, { sourceBytes, localBytes: Buffer.from('one\r\ntwo\r\n'),
    sourceOverrides: { sha256: 'f'.repeat(64), comparison_profile: 'utf8-crlf-lf-v1' } });
  const rejected = await resolveDocument(wrongRawPin.meta, wrongRawPin.repo, 'priors', wrongRawPin.deps);
  assert.equal(rejected.state, 'different'); assert.equal(rejected.reason, 'source_commit_hash_mismatch');
  assert.equal(rejected.verified_comparison_profile, null, 'a raw pinned-blob SHA failure does not verify either comparison profile');
  assert.equal(rejected.matches_priors_bytes, false);
});

test('resolve allows history labels for declared clean CRLF worktrees and rechecks HEAD before returning them', async (t) => {
  const sourceBytes = Buffer.from('source\n'), localBytes = Buffer.from('head\n');
  const crlfHead = await resolveFixture(t, { sourceBytes, localBytes: Buffer.from('head\r\n'), headBytes: Buffer.from('head\n'),
    sourceOverrides: { comparison_profile: 'utf8-crlf-lf-v1' }, ancestry: 'newer' });
  const newer = await resolveDocument(crlfHead.meta, crlfHead.repo, 'priors', crlfHead.deps);
  assert.equal(newer.state, 'newer');
  assert.equal(newer.verified_comparison_profile, 'utf8-crlf-lf-v1');
  assert.equal(newer.local_commit, crlfHead.headCommit);
  const crlfOlder = await resolveFixture(t, { sourceBytes: Buffer.from('new source\n'), localBytes: Buffer.from('old HEAD\r\n'),
    headBytes: Buffer.from('old HEAD\n'), sourceOverrides: { comparison_profile: 'utf8-crlf-lf-v1' }, ancestry: 'older' });
  const older = await resolveDocument(crlfOlder.meta, crlfOlder.repo, 'priors', crlfOlder.deps);
  assert.equal(older.state, 'older');
  assert.equal(older.verified_comparison_profile, 'utf8-crlf-lf-v1');
  const crlfDifferent = await resolveFixture(t, { sourceBytes: Buffer.from('source\n'), localBytes: Buffer.from('changed\r\n'),
    sourceOverrides: { comparison_profile: 'utf8-crlf-lf-v1' }, ancestry: 'diverged' });
  const different = await resolveDocument(crlfDifferent.meta, crlfDifferent.repo, 'priors', crlfDifferent.deps);
  assert.equal(different.state, 'different');
  assert.equal(different.reason, 'diverged_history');
  assert.equal(different.verified_comparison_profile, 'raw-v1');
  const raced = await resolveFixture(t, { sourceBytes, localBytes, headBytes: localBytes,
    sourceOverrides: { comparison_profile: 'utf8-crlf-lf-v1' }, ancestry: 'newer', changeHeadAfterAncestry: true });
  const changed = await resolveDocument(raced.meta, raced.repo, 'priors', raced.deps);
  assert.equal(changed.state, 'different'); assert.equal(changed.reason, 'head_changed');
  assert.equal(changed.local_commit, undefined);
  assert.equal(changed.verified_comparison_profile, null, 'a changed HEAD invalidates the earlier profile proof');
  const rootRace = await resolveFixture(t, { sourceBytes, localBytes, ancestry: 'newer', changeRootAfterAncestry: true });
  const replaced = await resolveDocument(rootRace.meta, rootRace.repo, 'priors', rootRace.deps);
  assert.equal(replaced.state, 'no_source'); assert.equal(replaced.reason, 'repository_changed');
});

test('resolve accepts explicit bounded search metadata offline without another MCP call', async (t) => {
  const f = await resolveFixture(t);
  const metadataFile = path.join(f.dir, 'search-result.json');
  await fs.promises.writeFile(metadataFile, JSON.stringify({ items: [f.meta] }));
  let calls = 0;
  const out = await resolveCommand({ theme: 'GEN', id: f.meta.document_id, repo: f.repo, repoId: 'priors', metadata: metadataFile }, {
    ...f.deps, tool: async () => { calls++; throw new Error('offline metadata must not call MCP'); },
  });
  assert.equal(out.state, 'source_match'); assert.equal(calls, 0);
  assert.equal(out.metadata_origin, 'captured_metadata');
  const parsed = parseResolve(['resolve', '--theme', 'GEN', '--id', f.meta.document_id, '--repo', f.repo,
    '--repo-id', 'priors', '--metadata', metadataFile]);
  assert.equal(parsed.metadata, metadataFile);
  await fs.promises.writeFile(metadataFile, JSON.stringify({ items: [f.meta, f.meta] }));
  await assert.rejects(resolveCommand({ theme: 'GEN', id: f.meta.document_id, repo: f.repo, repoId: 'priors', metadata: metadataFile }, f.deps),
    /metadata_document_not_unique/);
  for (const invalid of [
    { ...f.meta, document_key: 'docs/a.md', document_id: undefined },
    { ...f.meta, document_key: 'docs/a.md', version: undefined },
    { ...f.meta, document_key: 'docs/a.md', sha256: undefined },
  ]) {
    await fs.promises.writeFile(metadataFile, JSON.stringify(invalid));
    const result = await resolveCommand({ theme: 'GEN', key: 'docs/a.md', repo: f.repo, repoId: 'priors', metadata: metadataFile }, f.deps);
    assert.equal(result.state, 'no_source'); assert.equal(result.reason, 'captured_document_identity_invalid');
    assert.equal(result.local_path, undefined); assert.equal(result.metadata_origin, 'captured_metadata');
  }
  await fs.promises.writeFile(metadataFile, Buffer.alloc(1048577));
  await assert.rejects(resolveCommand({ theme: 'GEN', id: f.meta.document_id, repo: f.repo, repoId: 'priors', metadata: metadataFile }, f.deps),
    /metadata_file_invalid/);
  const metadataLink = path.join(f.dir, 'metadata-link.json');
  try {
    await fs.promises.symlink(metadataFile, metadataLink);
    await assert.rejects(resolveCommand({ theme: 'GEN', id: f.meta.document_id, repo: f.repo, repoId: 'priors', metadata: metadataLink }, f.deps),
      /symlink_refused/);
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
});

test('resolve rejects unsafe/symlink paths, oversized files, and files changed during verification', async (t) => {
  const f = await resolveFixture(t);
  for (const relative of ['../secret', 'CON', 'folder./x.md', 'C:/secret', '.git/config.md', '.env.local.md', 'docs/token.txt']) {
    const bad = await resolveDocument({ ...f.meta, local_source: { ...f.meta.local_source, path: relative } }, f.repo, 'priors', f.deps);
    assert.equal(bad.state, 'no_source');
  }
  const large = await resolveFixture(t, { localBytes: Buffer.alloc(1048577), sourceBytes: Buffer.from('pinned') });
  await assert.rejects(resolveDocument(large.meta, large.repo, 'priors', large.deps), /document_too_large/);
  const raced = await resolveFixture(t, { sourceBytes: Buffer.from('other source'), localBytes: Buffer.from('at HEAD'), mutateDuringGitRead: true });
  await assert.rejects(resolveDocument(raced.meta, raced.repo, 'priors', raced.deps), /file_changed_during_check/);
  const symlink = path.join(f.repo, 'docs', 'link.md');
  try {
    await fs.promises.symlink(f.abs, symlink);
    const linkMeta = { ...f.meta, local_source: { ...f.meta.local_source, path: 'docs/link.md' } };
    const refused = await resolveDocument(linkMeta, f.repo, 'priors', f.deps);
    assert.equal(refused.state, 'no_source'); assert.equal(refused.reason, 'symlink_refused');
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; }
});

test('audit helpers normalize only CRLF and reject unsafe repository paths', () => {
  assert.deepEqual(normalizeLf(Buffer.from('a\r\nb\n')), Buffer.from('a\nb\n'));
  assert.deepEqual(normalizeLf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\n')])), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n')]));
  assert.throws(() => normalizeLf(Buffer.from([0xff])), /encoded data/i);
  const root = path.resolve('repo-root');
  assert.equal(repoPath(root, 'docs/a.md'), path.join(root, 'docs', 'a.md'));
  for (const unsafe of ['../secret', '/outside', 'a\\..\\secret', 'a//b']) assert.throws(() => repoPath(root, unsafe));
});

test('three-way merge preserves bytes on clean merge and leaves conflict markers on overlap', () => {
  const base = Buffer.from('one\nmiddle\nthree\n');
  const local = Buffer.from('ONE\nmiddle\nthree\n');
  const remote = Buffer.from('one\nmiddle\nTHREE\n');
  const clean = gitMerge(local, base, remote);
  assert.equal(clean.clean, true);
  assert.ok(clean.bytes.includes(Buffer.from('ONE')));
  assert.ok(clean.bytes.includes(Buffer.from('THREE')));
  const conflict = gitMerge(Buffer.from('same local\n'), Buffer.from('same\n'), Buffer.from('same remote\n'));
  assert.equal(conflict.clean, false);
  assert.match(conflict.bytes.toString('utf8'), /<<<<<<<|=======|>>>>>>>/);
  assert.throws(() => gitMerge(Buffer.from([0xff]), base, remote), /document_invalid_utf8/);
  assert.throws(() => gitMerge(Buffer.alloc(1048577), base, remote), /document_too_large/);
});

test('three-way merge handles separated hunks and reports missing Git safely', () => {
  const base = Buffer.from('one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
  const local = Buffer.from('ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n');
  const remote = Buffer.from('one\ntwo\nTHREE\nfour\nFIVE\nsix\nseven\n');
  const merged = gitMerge(local, base, remote);
  assert.equal(merged.clean, true);
  assert.equal(merged.bytes.toString(), 'ONE\ntwo\nTHREE\nfour\nFIVE\nsix\nSEVEN\n');
  const oldPath = process.env.PATH;
  try { process.env.PATH = ''; assert.throws(() => gitMerge(local, base, remote)); }
  finally { process.env.PATH = oldPath; }
});

async function auditFixture(t, row = { theme: 'GEN', document_id: '432c36d9-37cc-4f9f-853d-693a56401a21', path: 'docs/a.md' }) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'priors-audit-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); await fs.promises.mkdir(path.join(repo, 'docs'), { recursive: true });
  await fs.promises.writeFile(path.join(repo, 'docs', 'a.md'), 'worktree');
  const manifest = path.join(dir, 'manifest.json');
  await fs.promises.writeFile(manifest, JSON.stringify({ version: 1, repo: 'priors', documents: [row] }));
  const commit = 'a'.repeat(40), body = Buffer.from('same\r\nbody\n');
  const calls = [];
  const deps = {
    git: (_root, ...args) => args[0] === 'rev-parse' && args.includes('--show-toplevel') ? repo : commit,
    gitFile: async () => body,
    tool: async (_name, args) => {
      calls.push(args);
      if (args.action === 'audit_read') return { version: 7, sha256: sha(body), binding_generation: 2, observation_generation: 3 };
      return { audit: args.audit };
    },
    download: async () => ({ bytes: body, sha256: sha(body), version: 7 }),
  };
  return { dir, repo, manifest, commit, body, calls, deps };
}

test('audit records raw matches and content differences using the read CAS tuple', async (t) => {
  const f = await auditFixture(t);
  const matched = await auditManifest(f.manifest, f.repo, 'main', 'branch', f.deps);
  assert.equal(matched.results[0].status, 'matched');
  assert.equal(f.calls[1].expected_version, 7);
  assert.equal(f.calls[1].expected_binding_generation, 2);
  assert.equal(f.calls[1].audit.evidence, 'raw_sha256_match');
  f.deps.gitFile = async () => Buffer.from('same\nbody\n');
  const normalized = await auditManifest(f.manifest, f.repo, 'main', 'branch', f.deps);
  assert.equal(normalized.results[0].status, 'matched');
  assert.equal(f.calls.at(-1).audit.comparison_profile, 'utf8-crlf-lf-v1');
  assert.equal(f.calls.at(-1).audit.evidence, 'newline_normalized_match');
  f.deps.gitFile = async () => Buffer.from('repo different');
  const changed = await auditManifest(f.manifest, f.repo, 'main', 'branch', f.deps);
  assert.equal(changed.results[0].status, 'different');
  assert.equal(f.calls.at(-1).audit.evidence, 'content_sha256_differs');
});

test('audit records missing sources as unknown, but never writes after a failed remote read or stale CAS', async (t) => {
  const f = await auditFixture(t, { theme: 'GEN', document_id: '432c36d9-37cc-4f9f-853d-693a56401a21', path: null });
  await auditManifest(f.manifest, f.repo, 'main', 'branch', f.deps);
  assert.equal(f.calls[1].audit.status, 'unknown');
  assert.equal(f.calls[1].audit.source, null);

  const missing = await auditFixture(t);
  missing.deps.gitFile = async () => { throw new Error('not present in ref'); };
  await auditManifest(missing.manifest, missing.repo, 'main', 'branch', missing.deps);
  assert.equal(missing.calls.at(-1).audit.status, 'unknown');
  assert.equal(missing.calls.at(-1).audit.source.path, 'docs/a.md');
  assert.equal(missing.calls.at(-1).audit.source.sha256, null);

  const g = await auditFixture(t);
  g.deps.download = async () => { throw Object.assign(new Error('offline'), { code: 'document_http_503' }); };
  await assert.rejects(auditManifest(g.manifest, g.repo, 'main', 'branch', g.deps), /offline/);
  assert.equal(g.calls.filter((c) => c.action === 'audit_record').length, 0);

  const wrongSnapshot = await auditFixture(t);
  wrongSnapshot.deps.download = async () => ({ bytes: wrongSnapshot.body, sha256: 'b'.repeat(64), version: 7 });
  await assert.rejects(auditManifest(wrongSnapshot.manifest, wrongSnapshot.repo, 'main', 'branch', wrongSnapshot.deps), /audit_remote_snapshot_changed/);
  assert.equal(wrongSnapshot.calls.filter((c) => c.action === 'audit_record').length, 0);

  const lost = await auditFixture(t);
  lost.deps.tool = async (_name, args) => {
    lost.calls.push(args);
    if (args.action === 'audit_read') return { version: 7, sha256: sha(lost.body), binding_generation: 2, observation_generation: 3 };
    throw new TypeError('connection closed');
  };
  await assert.rejects(auditManifest(lost.manifest, lost.repo, 'main', 'branch', lost.deps), (e) => e.code === 'audit_result_unknown');

  const h = await auditFixture(t);
  h.deps.tool = async (_name, args) => {
    h.calls.push(args);
    if (args.action === 'audit_read') return { version: 7, sha256: sha(h.body), binding_generation: 2, observation_generation: 3 };
    throw Object.assign(new Error('stale'), { code: 'version_conflict' });
  };
  await assert.rejects(auditManifest(h.manifest, h.repo, 'main', 'branch', h.deps), /stale/);
});

test('audit stops safely when the server has no audit_read capability', async (t) => {
  const f = await auditFixture(t);
  f.deps.tool = async (_name, args) => {
    f.calls.push(args);
    throw Object.assign(new Error('unsupported_action'), { code: 'invalid_input' });
  };
  await assert.rejects(auditManifest(f.manifest, f.repo, 'main', 'branch', f.deps), /unsupported_action/);
  assert.equal(f.calls.some((c) => c.action === 'audit_record'), false);
});

test('audit refuses a worktree file changed during the two SHA checks', async (t) => {
  const f = await auditFixture(t);
  let reads = 0;
  f.deps.readFile = async () => Buffer.from(++reads === 1 ? 'before' : 'after');
  await assert.rejects(auditManifest(f.manifest, f.repo, 'HEAD', 'worktree', f.deps), /worktree_changed_during_audit/);
  assert.equal(f.calls.filter((c) => c.action === 'audit_record').length, 0);
});

test('manifest initial status stays tied to its exact document and source tuple, including pathless historical rows', async (t) => {
  const f = await auditFixture(t);
  const mk = (status, overrides = {}) => ({ theme: 'GEN', document_id: crypto.randomUUID(), path: null,
    initial: { version: 7, sha256: sha(f.body), status, source_sha256: null, source_commit: f.commit,
      checked_at: '2026-10-23T00:00:00Z', evidence: 'phase1_review', comparison_profile: 'utf8-crlf-lf-v1', ...overrides } });
  const rows = [mk('unknown'), mk('historical'), mk('historical', { source_commit: 'b'.repeat(40) })];
  await fs.promises.writeFile(f.manifest, JSON.stringify({ version: 1, repo: 'priors', documents: rows }));
  const result = await auditManifest(f.manifest, f.repo, 'main', 'branch', f.deps);
  assert.deepEqual(result.results.map((r) => r.status), ['unknown', 'historical', 'unknown']);
  assert.deepEqual(f.calls.filter((c) => c.action === 'audit_record').map((c) => c.audit.evidence), ['phase1_review', 'phase1_review', 'phase1_review']);
});

test('the 24-row initial manifest is accepted by the audit path and preserves only exact pathless observations', async () => {
  const manifestFile = path.resolve(__dirname, '../../docs/document-audit-initial-20261023.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8'));
  assert.equal(manifest.documents.length, 24);
  const repo = path.resolve(__dirname, '../../..');
  const commit = manifest.documents[0].initial.source_commit;
  const records = [];
  const deps = {
    git: (_root, ...args) => args.includes('--show-toplevel') ? repo : commit,
    gitFile: async (_root, _commit, p) => Buffer.from(`checked ${p}`),
    tool: async (_name, args) => {
      if (args.action === 'audit_read') {
        const row = manifest.documents.find((r) => r.document_id === args.document_id);
        return { version: row.initial.version, sha256: row.initial.sha256, binding_generation: 2, observation_generation: 4 };
      }
      records.push(args); return { audit: args.audit };
    },
    download: async (_theme, id) => {
      const row = manifest.documents.find((r) => r.document_id === id);
      return { bytes: Buffer.from('verified remote snapshot'), sha256: row.initial.sha256, version: row.initial.version };
    },
  };
  const result = await auditManifest(manifestFile, repo, manifest.ref, 'branch', deps);
  assert.equal(result.audited, 24);
  const d20 = records.find((r) => manifest.documents.find((m) => m.audit_id === 'D20')?.document_id === r.document_id);
  assert.equal(d20.audit.status, 'historical');
  assert.equal(d20.audit.source, null);
  assert.ok(records.filter((r) => manifest.documents.find((m) => m.document_id === r.document_id)?.path).every((r) => r.audit.status === 'unknown'));
});

function fakePriors() {
  const docs = new Map(); // id -> { key, versions: [{bytes, sha}] }
  const receipts = new Map();
  // test controls: drop the answer of the next N writes (applied=true: the write happens, only the reply is lost);
  // onDownload runs while a GET of the content is being served
  const ctl = { dropWrites: 0, applied: false, onDownload: null, beforeWrite: null, writes: 0 };
  const write = (args, bytes) => {
    if (ctl.beforeWrite) { const beforeWrite = ctl.beforeWrite; ctl.beforeWrite = null; beforeWrite(args, bytes); }
    if (receipts.has(args.operation_id)) return { ...receipts.get(args.operation_id), replayed: true };
    let id = args.document_id;
    if (!id) {
      if ([...docs.values()].some((d) => d.key === args.document_key)) return { error: 'invalid_input', details: { reason: 'document_exists' } };
      id = crypto.randomUUID(); docs.set(id, { key: args.document_key, title: args.title, versions: [] });
    } else {
      const d = docs.get(id); const head = d.versions.length;
      if (args.expected_version !== head || args.expected_sha256 !== d.versions[head - 1].sha) return { error: 'version_conflict' };
    }
    const d = docs.get(id); d.versions.push({ bytes, sha: sha(bytes) });
    const out = { ok: true, document_id: id, document_key: d.key, version: d.versions.length, sha256: sha(bytes) };
    receipts.set(args.operation_id, out); return out;
  };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: 'unauthorized' });
    if (url.pathname === '/mcp') {
      const rpc = JSON.parse(body.toString('utf8')); const { name, arguments: a } = rpc.params;
      let out; let isError = false;
      if (name === 'context_open') out = { resolved_session_id: '11111111-1111-4111-8111-111111111111' };
      else if (a.action === 'read') {
        const id = a.document_id || [...docs.entries()].find(([, d]) => d.key === a.document_key)?.[0];
        const d = id && docs.get(id);
        if (!d) { out = { error: 'not_found' }; isError = true; } else {
          const v = a.version || d.versions.length; out = { document_id: id, document_key: d.key, title: d.title, state: 'active', version: v, head_version: d.versions.length, sha256: d.versions[v - 1].sha };
        }
      } else if (a.action === 'write') {
        ctl.writes++;
        if (ctl.dropWrites > 0) {
          ctl.dropWrites--; if (ctl.applied) write(a, Buffer.from(a.source_base64, 'base64'));
          return send(503, { error: 'unavailable' });
        }
        out = write(a, Buffer.from(a.source_base64, 'base64')); isError = !!out.error;
      }
      return send(200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], ...(isError ? { isError: true } : {}) } });
    }
    const m = /^\/documents\/([^/]+)\/content$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const d = docs.get(m[1]); const v = Number(url.searchParams.get('version')) || d.versions.length; const ver = d.versions[v - 1];
      if (ctl.onDownload) { const f = ctl.onDownload; ctl.onDownload = null; f(); }
      return send(200, ver.bytes, { 'content-type': 'text/markdown', 'x-priors-sha256': ver.sha, 'x-priors-version': String(v) });
    }
    if ((req.method === 'PUT' && m) || (req.method === 'POST' && url.pathname === '/documents/content')) {
      const meta = JSON.parse(Buffer.from(req.headers['x-priors-document-meta'], 'base64url').toString('utf8'));
      if ('document_id' in meta) return send(400, { error: 'invalid_input' });
      const out = write({ ...meta, ...(m ? { document_id: m[1] } : {}) }, body);
      return send(out.error ? 409 : 200, out);
    }
    send(404, { error: 'not_found' });
  });
  return { server, docs, receipts, ctl };
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out ? JSON.parse(out) : null, err: err ? JSON.parse(err) : null }));
  });
}

test('classify covers the four cases and the unknown ones', () => {
  const row = { base_version: 2, base_sha256: 'b' };
  assert.equal(classify(row, 'b', 2), 'up_to_date');
  assert.equal(classify(row, 'x', 2), 'local_changed');
  assert.equal(classify(row, 'b', 3), 'remote_changed');
  assert.equal(classify(row, 'x', 3), 'conflict');
  assert.equal(classify(row, 'b', null), 'unknown');
  assert.equal(classify(null, 'b', 2), 'untracked');
});

test('publish → status → remote change → fetch, and a conflict keeps both files; large files use the raw route', async () => {
  const { server, docs } = fakePriors();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-docsync-'));
  const env = { PRIORS_MCP_URL: `http://127.0.0.1:${port}/mcp`, PRIORS_DOCUMENT_TOKEN: 'test-token',
    PRIORS_DOCUMENT_SYNC_STATE: path.join(dir, 'ledger.json'), PRIORS_DOCUMENT_ROOT: dir };
  try {
    const file = path.join(dir, 'spec.md');
    fs.writeFileSync(file, Buffer.from('﻿# 仕様\r\n本文\r\n', 'utf8'));
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'specs/spec.md', '--title', 'Spec'], env);
    assert.equal(r.code, 0, JSON.stringify(r.err));
    assert.equal(r.out.published, true); assert.equal(r.out.version, 1);
    const id = r.out.document_id;
    r = await run(['status', file], env);
    assert.equal(r.out.state, 'up_to_date');

    // the remote moves on (another agent of the same owner wrote v2)
    const d = docs.get(id); const v2 = Buffer.from('# v2\n'); d.versions.push({ bytes: v2, sha: sha(v2) });
    r = await run(['status', file], env); assert.equal(r.out.state, 'remote_changed');
    r = await run(['publish', file], env); assert.equal(r.code, 1); assert.equal(r.err.error, 'not_publishable_remote_changed');
    r = await run(['fetch', file, '--theme', 'GEN'], env);
    assert.equal(r.out.state, 'up_to_date'); assert.deepEqual(fs.readFileSync(file), v2);

    // both change: fetch keeps the local edit and saves the remote next to it
    fs.writeFileSync(file, '# local edit\n');
    const v3 = Buffer.from('# v3\n'); d.versions.push({ bytes: v3, sha: sha(v3) });
    r = await run(['status', file], env); assert.equal(r.out.state, 'conflict');
    r = await run(['fetch', file, '--theme', 'GEN'], env);
    assert.equal(r.out.state, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), '# local edit\n');
    assert.deepEqual(fs.readFileSync(r.out.path), v3);

    // a large file goes over the raw HTTP route (create)
    const big = path.join(dir, 'big.md');
    fs.writeFileSync(big, Buffer.from('# big\n' + 'あ'.repeat(60000)));
    r = await run(['publish', big, '--theme', 'GEN', '--key', 'big.md', '--title', 'Big'], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.version, 1);
    // outside the root and through a symlink are refused
    r = await run(['status', path.join(os.tmpdir(), 'elsewhere.md')], env); assert.equal(r.err.error, 'path_outside_root');
  } finally {
    server.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withFake(fn) {
  const fake = fakePriors();
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-docsync-'));
  const env = { PRIORS_MCP_URL: `http://127.0.0.1:${fake.server.address().port}/mcp`, PRIORS_DOCUMENT_TOKEN: 'test-token',
    PRIORS_DOCUMENT_SYNC_STATE: path.join(dir, 'state', 'ledger.json'), PRIORS_DOCUMENT_ROOT: dir };
  try { await fn({ ...fake, dir, env }); } finally { fake.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const line = (s) => `${s}\n`;

test('GEN-579: an edit made while fetch downloads is kept; the remote goes to a new name, never over another file', async () => {
  await withFake(async ({ docs, ctl, dir, env }) => {
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, line('# v1'));
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'a.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); const v2 = Buffer.from(line('# v2')); d.versions.push({ bytes: v2, sha: sha(v2) });
    // an unrelated file already sits at the first keep-both name: it must survive
    fs.writeFileSync(`${file}.priors-v2.md`, line('someone else'));
    ctl.onDownload = () => fs.writeFileSync(file, line('# edited during download'));
    r = await run(['fetch', file, '--theme', 'GEN'], env);
    assert.equal(r.code, 0, JSON.stringify(r.err));
    assert.equal(r.out.state, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), line('# edited during download'));
    assert.equal(fs.readFileSync(`${file}.priors-v2.md`, 'utf8'), line('someone else'));
    assert.equal(r.out.path, `${file}.priors-v2-2.md`);
    assert.deepEqual(fs.readFileSync(r.out.path), v2);
    // the ledger did not move: the local edit is still measured against v1
    r = await run(['status', file], env); assert.equal(r.out.state, 'conflict');
  });
});

test('publish automatically writes a clean three-way merge using latest remote CAS metadata', async () => {
  await withFake(async ({ docs, dir, env }) => {
    const file = path.join(dir, 'merge.md');
    fs.writeFileSync(file, 'one\nmiddle\nthree\n');
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'merge.md'], env);
    assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id);
    const remote = Buffer.from('one\nmiddle\nTHREE\n'); d.versions.push({ bytes: remote, sha: sha(remote) });
    const local = Buffer.from('ONE\nmiddle\nthree\n'); fs.writeFileSync(file, local);
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err));
    assert.equal(r.out.merged, true);
    assert.deepEqual(d.versions.at(-1).bytes, Buffer.from('ONE\nmiddle\nTHREE\n'));
    assert.deepEqual(fs.readFileSync(file), d.versions.at(-1).bytes);
  });
});

test('late CAS conflict on an otherwise local-only publish is merged against the new head', async () => {
  await withFake(async ({ docs, ctl, dir, env }) => {
    const file = path.join(dir, 'late.md'); fs.writeFileSync(file, 'one\ntwo\nthree\n');
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'late.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); fs.writeFileSync(file, 'ONE\ntwo\nthree\n');
    ctl.beforeWrite = () => { const remote = Buffer.from('one\ntwo\nTHREE\n'); d.versions.push({ bytes:remote, sha:sha(remote) }); };
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.merged, true);
    assert.equal(d.versions.at(-1).bytes.toString(), 'ONE\ntwo\nTHREE\n');
  });
});

test('a resumed old CAS conflict is merged after its original operation is settled', async () => {
  await withFake(async ({ docs, ctl, dir, env }) => {
    const file = path.join(dir, 'resume-cas.md'); fs.writeFileSync(file, 'one\ntwo\nthree\n');
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'resume-cas.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); fs.writeFileSync(file, 'ONE\ntwo\nthree\n');
    ctl.dropWrites = 3; ctl.applied = false;
    r = await run(['publish', file], env); assert.equal(r.err.error, 'result_unknown'); const oldOp = r.err.operation_id;
    const remote = Buffer.from('one\ntwo\nTHREE\n'); d.versions.push({ bytes:remote, sha:sha(remote) });
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.merged, true);
    assert.equal(r.out.resumed.operation_id, oldOp);
    assert.equal(d.versions.at(-1).bytes.toString(), 'ONE\ntwo\nTHREE\n');
  });
});

test('a lost clean-merge acknowledgement replays its own bytes and preserves later local edits', async () => {
  await withFake(async ({ docs, ctl, dir, env }) => {
    const file = path.join(dir, 'merge-unknown.md'); fs.writeFileSync(file, 'one\ntwo\nthree\n');
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'merge-unknown.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); const remote = Buffer.from('one\ntwo\nTHREE\n'); d.versions.push({ bytes:remote, sha:sha(remote) });
    fs.writeFileSync(file, 'ONE\ntwo\nthree\n'); ctl.dropWrites = 3; ctl.applied = true;
    r = await run(['publish', file], env); assert.equal(r.err.error, 'result_unknown'); const op = r.err.operation_id;
    fs.writeFileSync(file, 'new edit after merge request\n');
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.state, 'published_local_changed');
    assert.equal(r.out.resumed.operation_id, op);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new edit after merge request\n');
    assert.equal(fs.readFileSync(r.out.sidecar, 'utf8'), 'ONE\ntwo\nTHREE\n');
    assert.equal(d.versions.length, 3);
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'ledger.json'), 'utf8'));
    assert.equal(ledger[file].base_version, 1, 'do not advance the base while merged bytes are only in a sidecar');
    r = await run(['status', file], env); assert.equal(r.out.state, 'conflict');
  });
});

test('publish recovers a receipt-confirmed merge whose local installation was interrupted', async () => {
  await withFake(async ({ docs, receipts, dir, env }) => {
    const file = path.join(dir, 'merge-install-recovery.md'); fs.writeFileSync(file, 'one\ntwo\nthree\n');
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'merge-install-recovery.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); const remote = Buffer.from('one\ntwo\nTHREE\n'); d.versions.push({ bytes:remote, sha:sha(remote) });
    const local = Buffer.from('ONE\ntwo\nthree\n'); const merged = Buffer.from('ONE\ntwo\nTHREE\n'); fs.writeFileSync(file, local);
    const operation_id = 'docsync-interrupted-merge'; d.versions.push({ bytes:merged, sha:sha(merged) });
    const receipt = { ok:true, document_id:r.out.document_id, document_key:d.key, version:3, sha256:sha(merged) }; receipts.set(operation_id, receipt);
    const args = { operation_id, document_id:r.out.document_id, expected_version:2, expected_sha256:sha(remote) };
    const pending = { theme:'GEN', args, operation_id, local_sha256:sha(merged), merge:{ input_sha256:sha(local), base_snapshot:{base_version:1,base_sha256:d.versions[0].sha} } };
    const ledgerPath = path.join(dir, 'state', 'ledger.json'); const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger[file] = { ...ledger[file], stage:'merge_installing', pending }; fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    const pendingDir = path.join(dir, 'state', 'document-sync-pending'); fs.mkdirSync(pendingDir, {recursive:true});
    fs.writeFileSync(path.join(pendingDir, `${operation_id}.bin`), merged);
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.merged, true);
    assert.deepEqual(fs.readFileSync(file), merged);
    const finalLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(finalLedger[file].base_version, 3); assert.equal(finalLedger[file].pending, undefined);
  });
});

test('an edit arriving during merge publication stays local and gets an exclusive sidecar for merged bytes', async () => {
  await withFake(async ({ docs, ctl, dir, env }) => {
    const file = path.join(dir, 'merge-edit.md'); fs.writeFileSync(file, 'one\ntwo\nthree\n');
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'merge-edit.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); const remote = Buffer.from('one\ntwo\nTHREE\n'); d.versions.push({ bytes:remote, sha:sha(remote) });
    fs.writeFileSync(file, 'ONE\ntwo\nthree\n');
    ctl.beforeWrite = () => fs.writeFileSync(file, 'concurrent edit\n');
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.state, 'published_local_changed');
    assert.equal(fs.readFileSync(file, 'utf8'), 'concurrent edit\n');
    assert.equal(fs.readFileSync(r.out.sidecar, 'utf8'), 'ONE\ntwo\nTHREE\n');
    assert.equal(d.versions.at(-1).bytes.toString(), 'ONE\ntwo\nTHREE\n');
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'ledger.json'), 'utf8'));
    assert.equal(ledger[file].base_version, 1, 'the old local file must remain based on its original version');
  });
});

test('a missing Git executable stops before writing and explains the fallback', async () => {
  await withFake(async ({ docs, ctl, dir, env }) => {
    const file = path.join(dir, 'no-git.md'); fs.writeFileSync(file, 'same\n');
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'no-git.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); const remote = Buffer.from('remote\n'); d.versions.push({ bytes:remote, sha:sha(remote) });
    fs.writeFileSync(file, 'local\n'); const writes = ctl.writes;
    r = await run(['publish', file], { ...env, PATH:'' });
    assert.equal(r.code, 1); assert.equal(r.err.error, 'merge_unavailable');
    assert.match(r.err.note, /Git merge-file/); assert.equal(ctl.writes, writes);
  });
});

test('overlapping changes save conflict markers exclusively without writing to Priors', async () => {
  await withFake(async ({ docs, ctl, dir, env }) => {
    const file = path.join(dir, 'overlap.md'); fs.writeFileSync(file, 'same\n');
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'overlap.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); const remote = Buffer.from('remote\n'); d.versions.push({ bytes: remote, sha: sha(remote) });
    fs.writeFileSync(file, 'local\n'); const writes = ctl.writes;
    r = await run(['publish', file], env);
    assert.equal(r.code, 1); assert.equal(r.err.error, 'merge_conflict');
    assert.match(fs.readFileSync(r.err.sidecar, 'utf8'), /<<<<<<<|=======|>>>>>>>/);
    assert.equal(ctl.writes, writes);
    assert.equal(d.versions.length, 2);
  });
});

test('conflict marker output above 1 MiB is kept as a sidecar without a Priors write', async () => {
  await withFake(async ({ docs, ctl, dir, env }) => {
    const file = path.join(dir, 'large-conflict.md'); const base = Buffer.from('a'.repeat(600 * 1024)); fs.writeFileSync(file, base);
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'large-conflict.md'], env); assert.equal(r.code, 0, JSON.stringify(r.err));
    const d = docs.get(r.out.document_id); const remote = Buffer.from('r'.repeat(600 * 1024)); d.versions.push({ bytes:remote, sha:sha(remote) });
    fs.writeFileSync(file, Buffer.from('l'.repeat(600 * 1024))); const writes = ctl.writes;
    r = await run(['publish', file], env);
    assert.equal(r.code, 1); assert.equal(r.err.error, 'merge_conflict');
    const markers = fs.readFileSync(r.err.sidecar);
    assert.ok(markers.length > 1048576);
    assert.match(markers.toString('utf8').slice(0, 100), /<<<<<<< local/);
    assert.equal(ctl.writes, writes); assert.equal(d.versions.length, 2);
  });
});

test('GEN-579: a publish with a lost answer is resumed with the same operation_id and bytes (create and update)', async () => {
  await withFake(async ({ docs, receipts, ctl, dir, env }) => {
    const file = path.join(dir, 'b.md');
    fs.writeFileSync(file, line('# first'));
    // the create reaches the server but every answer is lost
    ctl.dropWrites = 3; ctl.applied = true;
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'b.md'], env);
    assert.equal(r.code, 1); assert.equal(r.err.error, 'result_unknown');
    const op = r.err.operation_id;
    r = await run(['status', file], env); assert.equal(r.out.state, 'publish_result_unknown'); assert.equal(r.out.operation_id, op);
    // the local file changes meanwhile; the resume still sends the original bytes, then publishes the edit as v2
    fs.writeFileSync(file, line('# second'));
    ctl.applied = false;
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err));
    assert.equal(r.out.resumed.operation_id, op); assert.equal(r.out.resumed.replayed, true); assert.equal(r.out.resumed.version, 1);
    assert.equal(r.out.version, 2);
    const d = docs.get(r.out.document_id);
    assert.deepEqual(d.versions.map((v) => v.bytes.toString()), [line('# first'), line('# second')], 'no duplicate document or version');
    assert.equal(docs.size, 1); assert.ok(receipts.has(op));

    // an update whose request never reached the server is applied once on resume
    fs.writeFileSync(file, line('# third'));
    ctl.dropWrites = 3; ctl.applied = false;
    r = await run(['publish', file], env); assert.equal(r.err.error, 'result_unknown');
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.resumed.replayed, false); assert.equal(r.out.version, 3);
    assert.equal(r.out.published, true);
    assert.equal(d.versions.length, 3);
    // the saved request is removed once answered
    assert.deepEqual(fs.readdirSync(path.join(dir, 'state', 'document-sync-pending')), []);
  });
});

// --- GEN-584: the replace never loses an edit, whenever it lands; fetch does not settle an unknown publish ---
const { replaceWithoutLoss } = require(SCRIPT);
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priors-replace-'));
  const abs = path.join(dir, 'doc.md'); const tmp = path.join(dir, 'doc.md.tmp');
  fs.writeFileSync(abs, line('base')); fs.writeFileSync(tmp, line('remote'));
  return { dir, abs, tmp, before: fs.readFileSync(abs), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.includes('priors-replacing'));

test('GEN-584 replace: no edit → the remote version is placed and nothing is left behind', async () => {
  const s = scratch();
  try {
    const r = await replaceWithoutLoss(s.abs, s.tmp, s.before);
    assert.deepEqual(r, { placed: true, preserved: null });
    assert.equal(fs.readFileSync(s.abs, 'utf8'), line('remote'));
    assert.deepEqual(leftovers(s.dir), []);
  } finally { s.done(); }
});

test('GEN-584 replace: an edit saved just before the replace (the review probe) stays at the path', async () => {
  const s = scratch();
  try {
    fs.writeFileSync(s.abs, line('edited at the last moment')); // after the caller's last look, before the replace
    const r = await replaceWithoutLoss(s.abs, s.tmp, s.before);
    assert.equal(r.placed, false);
    assert.equal(fs.readFileSync(s.abs, 'utf8'), line('edited at the last moment'));
    assert.deepEqual(leftovers(s.dir), []);
  } finally { s.done(); }
});

test('GEN-584 replace: an editor re-creating the file while it is set aside wins; nothing is overwritten', async () => {
  const s = scratch();
  try {
    const r = await replaceWithoutLoss(s.abs, s.tmp, s.before, {
      beforeCreate: async () => { fs.writeFileSync(s.abs, line('saved by the editor')); } });
    assert.equal(r.placed, false);
    assert.equal(fs.readFileSync(s.abs, 'utf8'), line('saved by the editor'));
    assert.deepEqual(leftovers(s.dir), []);
  } finally { s.done(); }
});

test('GEN-584 replace: an edit written into the moved file (same open file) is kept under another name', async () => {
  const s = scratch();
  try {
    const r = await replaceWithoutLoss(s.abs, s.tmp, s.before, {
      beforeCreate: async (aside) => { fs.writeFileSync(aside, line('written through the old handle')); } });
    assert.equal(r.placed, true);
    assert.equal(fs.readFileSync(s.abs, 'utf8'), line('remote'));
    assert.equal(fs.readFileSync(r.preserved, 'utf8'), line('written through the old handle'));
    assert.match(path.basename(r.preserved), /^doc\.md\.priors-local\.md$/);
    assert.deepEqual(leftovers(s.dir), []);
  } finally { s.done(); }
});

test('GEN-584 replace: an edit between the move and its check is put back; a missing file is created only if still absent', async () => {
  const s = scratch();
  try {
    const r = await replaceWithoutLoss(s.abs, s.tmp, s.before, {
      afterAside: async (aside) => { fs.writeFileSync(aside, line('edit raced the move')); } });
    assert.equal(r.placed, false);
    assert.equal(fs.readFileSync(s.abs, 'utf8'), line('edit raced the move'));
    fs.rmSync(s.abs);
    fs.writeFileSync(s.abs, line('created meanwhile'));
    const r2 = await replaceWithoutLoss(s.abs, s.tmp, null);
    assert.equal(r2.placed, false);
    assert.equal(fs.readFileSync(s.abs, 'utf8'), line('created meanwhile'));
  } finally { s.done(); }
});

test('GEN-584: fetch is refused while a publish result is unknown; the saved request stays', async () => {
  await withFake(async ({ ctl, dir, env }) => {
    const file = path.join(dir, 'c.md');
    fs.writeFileSync(file, line('# first'));
    ctl.dropWrites = 3; ctl.applied = true;
    let r = await run(['publish', file, '--theme', 'GEN', '--key', 'c.md'], env);
    assert.equal(r.err.error, 'result_unknown');
    const op = r.err.operation_id;
    r = await run(['fetch', file, '--theme', 'GEN', '--key', 'c.md'], env);
    assert.equal(r.code, 1); assert.equal(r.err.error, 'publish_result_unknown'); assert.equal(r.err.operation_id, op);
    r = await run(['status', file], env); assert.equal(r.out.state, 'publish_result_unknown');
    assert.equal(fs.readdirSync(path.join(dir, 'state', 'document-sync-pending')).length, 1);
    // publish settles it with the same request
    ctl.applied = false;
    r = await run(['publish', file], env);
    assert.equal(r.code, 0, JSON.stringify(r.err)); assert.equal(r.out.resumed.operation_id, op);
  });
});

