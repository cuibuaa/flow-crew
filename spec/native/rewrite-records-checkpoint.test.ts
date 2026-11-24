import { beginOperation, endOperation } from "../../dist-rewrite/host/process.js";
import { describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { settleFrozenInputs, captureCheckpoint, captureTree, changedTreePaths, changeSince, hashInputs, materializeCheckpoint, preserveOutputs, readCheckpoint } from "../../dist-rewrite/records/content.js";
import { readEvents } from "../../dist-rewrite/records/state.js";
import { putEvidence, git, evidenceRepository, evidenceOid } from "../../dist-rewrite/records/evidence.js";
import { root, scope, writer, hash, manifest, known, record, declarations, checkpoint, setScope } from './fixtures/rewrite-content.js';
describe('records content checkpoint authority', () => {
  it('captures ignored/untracked/external bytes, modes, symlinks and deletions', async () => {
    await writeFile(join(scope.layout.project, '.ignored'), 'secret');
    await writeFile(join(scope.layout.project, 'untracked'), 'work');
    await writeFile(join(root, 'artifact'), 'outside');
    await symlink('untracked', join(scope.layout.project, 'link'));
    declarations([], [{ path: join(root, 'artifact'), kind: 'file', existing: 'replace' }]);
    const initial = known(await captureTree(scope));
    await chmod(join(scope.layout.project, 'untracked'), 0o755);
    expect(known(await captureTree(scope))).not.toBe(initial);
    const cp = await checkpoint();
    await rm(join(scope.layout.project, 'untracked'));
    await writeFile(join(root, 'artifact'), 'changed');
    expect(known(await captureTree(scope))).not.toBe(cp.tree);
    expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
    expect((await lstat(join(scope.layout.project, 'untracked'))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(root, 'artifact'), 'utf8')).toBe('outside');
    expect((await lstat(join(scope.layout.project, 'link'))).isSymbolicLink()).toBe(true);
  });
  it.each(['project-file', 'external-file', 'directory-child', 'external-directory-target'] as const)(
    'replaced output %s retains only symlink bytes and never reads or copies its ungranted target', async placement => {
      const target = join(root, 'outside-every-grant'), secret = 'ungranted target bytes ' + placement;
      const directoryTarget = placement === 'external-directory-target';
      if (directoryTarget) await mkdir(target);
      const targetFile = directoryTarget ? join(target, 'external-output') : target;
      await writeFile(targetFile, secret);
      const output = placement.startsWith('external-') ? join(root, 'external-output') : 'out';
      const absolute = output.startsWith('/') ? output : join(scope.layout.project, output);
      const directory = placement === 'directory-child';
      if (directory) await mkdir(absolute);
      const planted = directory ? join(absolute, 'link') : absolute;
      await writeFile(planted, 'original output');
      const kind = directory ? 'directory' as const : 'file' as const;
      declarations([{ id: 'original', path: output, kind, frozen: false }], [{ path: output, kind, existing: 'replace' }]);
      const baseline = known(await hashInputs(scope));
      declarations([], [{ path: output, kind, existing: 'replace' }]);
      setScope({ ...scope, outputBaseline: baseline });
      const original = known(await captureTree(scope));
      await rm(planted);
      await symlink(target, planted);
      // The target is unreadable for an ordinary native user. Git must hash
      // readlink bytes even when privileged CI could bypass these permissions.
      await chmod(target, 0);
      try {
        const cp = await checkpoint();
        expect(cp.tree).not.toBe(original);
        const tree = await manifest(cp.manifest);
        const selected = tree.roots.find((entry: any) => entry.path === (placement.startsWith('external-') ? absolute : 'project'));
        const listing = (await git(scope.journal, ['ls-tree', '-r', selected.snapshot.tree])).toString();
        const linkOid = (await git(scope.journal, ['hash-object', '--stdin'], { input: Buffer.from(target) })).toString().trim();
        expect(listing).toContain('120000 blob ' + linkOid);
        expect((await git(scope.journal, ['cat-file', 'blob', linkOid])).toString()).toBe(target);
        const targetOid = createHash('sha1').update('blob ' + Buffer.byteLength(secret) + '\0').update(secret).digest('hex');
        expect((await git(scope.journal, ['cat-file', '--batch-check'], { input: Buffer.from(targetOid + '\n') }))
          .toString()).toBe(targetOid + ' missing\n');
        // Changing target bytes cannot change the checkpoint identity.
        await chmod(target, directoryTarget ? 0o700 : 0o600);
        await writeFile(targetFile, secret + ' changed');
        expect(known(await captureTree(scope))).toBe(cp.tree);
        const preserved = known(await preserveOutputs(scope, cp));
        expect(preserved.preserved).toBe(directory);
        expect(preserved.artifacts).toHaveLength(directory ? 1 : 0);
        if (directory) {
          const retained = await manifest(preserved.artifacts[0]);
          expect((await git(scope.journal, ['ls-tree', '-r', retained.snapshot.tree])).toString()).toContain('120000 blob ' + linkOid);
          expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
        } else {
          // Retention before materialization refuses a symlink at the declared file root.
          expect(await materializeCheckpoint(scope, writer, cp)).toMatchObject({ ok: false, kind: 'invalid' });
        }
        expect(await readlink(planted)).toBe(target);
        expect(await readFile(targetFile, 'utf8')).toBe(secret + ' changed');
        process.stderr.write('Native evidence output-symlink ' + JSON.stringify({ platform: process.platform, placement,
          targetBlobAbsent: true, targetChangesIgnored: true, preserved: preserved.preserved }) + '\n');
      } finally { await chmod(target, directoryTarget ? 0o700 : 0o600); }
    });
  it('does not expose an uncommitted capture and rejects corrupt/quarantined bases', async () => {
    // A settlement rolls earlier captures' loose evidence into a pack before it captures, so the checkpoint whose manifest is corrupted
    // below is the last one taken: its manifest is still a loose file.
    const bad = await checkpoint('quarantined');
    await writeFile(join(scope.layout.project, 'file'), 'work');
    const uncommitted = known(await captureCheckpoint(scope, { run: 'Run', stage: 'work', attempt: 'attempt', invocation: 1 }, null, 'safe', [], known(await settleFrozenInputs(scope)).inputs));
    expect(await readCheckpoint(scope.journal, uncommitted.id)).toMatchObject({ ok: false, kind: 'unavailable' });
    await record({ type: 'checkpoint', checkpoint: uncommitted });
    expect(known(await readCheckpoint(scope.journal, uncommitted.id))).toEqual(uncommitted);
    expect(await materializeCheckpoint(scope, writer, bad)).toMatchObject({ ok: false, kind: 'conflict' });
    const oid = evidenceOid(uncommitted.manifest), carrier = join(evidenceRepository(scope.journal), 'objects', oid.slice(0, 2), oid.slice(2));
    await chmod(carrier, 0o644);
    await writeFile(carrier, 'corrupt');
    expect(await readCheckpoint(scope.journal, uncommitted.id)).toMatchObject({ ok: false, kind: 'invalid' });
  });
  it.each(['dead', 'live', 'unknown'] as const)('materialization with a %s group and an honest receipt requires recorded closure', async (state) => {
    const cp = await checkpoint(), empty = known(await putEvidence(scope.journal, Buffer.alloc(0)));
    const worker = known(await beginOperation());
    try {
      if (state === 'dead')
        known(await endOperation(worker.owner));
      await record({ type: 'process', receipt: { owner: state === 'unknown' ? { ...worker.owner,
       start: 'stale-birth' } : worker.owner, state: state === 'dead' ? 'closed' : 'closure_unknown', exit: 0,
          signal: null, stdout: empty, stderr: empty, durationMs: 1, scope: 'group' } });
      const restored = await materializeCheckpoint(scope, writer, cp);
      if (state === 'dead')
        expect(known(restored)).toBe(cp.tree);
      else
        expect(restored).toMatchObject({ ok: false, kind: state === 'unknown' ? 'unknown' : 'conflict' });
    }
    finally {
      known(await endOperation(worker.owner));
    }
  });
  it('owner observation updates retain one authority and still require a closed receipt', async () => {
    const worker = known(await beginOperation());
    const updated = { ...worker.owner, members: [] };
    try {
      await record({ type: 'ownership', owner: worker.owner, state: 'live' });
      await record({ type: 'ownership', owner: updated, state: 'live' });
      known(await endOperation(worker.owner));
      // Kernel death alone is insufficient; the same authority still needs its receipt.
      const address = { run: 'Run', stage: 'work', attempt: 'updated_owner', invocation: 1 };
      const audit = known(await settleFrozenInputs(scope)).inputs;
      expect(await captureCheckpoint(scope, address, null, 'safe', [], audit)).toMatchObject({ ok: false, kind: 'conflict' });
      await record({ type: 'ownership', owner: updated, state: 'dead' });
      expect(await captureCheckpoint(scope, address, null, 'safe', [], audit)).toMatchObject({ ok: false, kind: 'conflict' });
      const empty = known(await putEvidence(scope.journal, Buffer.alloc(0)));
      await record({ type: 'process', receipt: { owner: updated, state: 'closed', exit: 0, signal: null, stdout: empty, stderr: empty, durationMs: 1, scope: 'group' } });
      expect(await captureCheckpoint(scope, address, null, 'safe', [], audit)).toMatchObject({ ok: true });
    } finally {
      known(await endOperation(worker.owner));
    }
  });
  it('selecting an old base preserves invocations plan and history and appends one materialization fact', async () => {
    await writeFile(join(scope.layout.project, 'value'), 'old');
    const old = await checkpoint();
    const invocation = { charge: 'work' as const, address: { kind: 'stage' as const, run: 'Run', stage: 'work', attempt: 'budget',
     invocation: 1 } };
    await record({ type: 'invocation_reserved', invocation });
    await record({ type: 'plan_committed', plan: { revision: 'new', digest: hash('plan'), executed: [], plan: { stages: [{ id: 'work',
     purpose: 'work', role: 'author', after: [], instruction: 'Next',  }] } } });
    await writeFile(join(scope.layout.project, 'value'), 'new');
    const latest = await checkpoint();
    const before = known(await readEvents(scope.journal, 0));
    expect(known(await materializeCheckpoint(scope, writer, old))).toBe(old.tree);
    const events = known(await readEvents(scope.journal, 0));
    expect(events.slice(0, before.length)).toEqual(before);
    expect(events.at(-1)?.payload).toEqual({ type: 'checkpoint_materialized', checkpoint: old.id });
    expect(events.some(event => event.payload.type === 'checkpoint' && event.payload.checkpoint.id === latest.id)).toBe(true);
  });
  it('archives later append output before restoring the exact old base', async () => {
    await writeFile(join(scope.layout.project, 'history'), 'first\n');
    declarations([], [{ path: 'history', kind: 'file', existing: 'append' }]);
    const originals = known(await hashInputs({ ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration, inputs: [{
     id: 'history', path: 'history', kind: 'file', frozen: false }] } } }));
    setScope({ ...scope, outputBaseline: originals });
    const cp = await checkpoint();
    await writeFile(join(scope.layout.project, 'history'), 'first\nsecond\n');
    expect(known(await materializeCheckpoint(scope, writer, cp))).toBe(cp.tree);
    expect(await readFile(join(scope.layout.project, 'history'), 'utf8')).toBe('first\n');
    const retained = known(await readEvents(scope.journal,
     0)).flatMap(event => event.payload.type === 'outputs_preserved' ? event.payload.receipt.artifacts : []);
    const baseline = await manifest(retained[0]);
    expect((await git(scope.journal, ['show', baseline.snapshot.tree + ':history'])).toString()).toBe('first\nsecond\n');
  });
});
it('original-baseline authority is checked before a checkpoint can replace current bytes', async () => {
  const path = join(scope.layout.project, 'out');
  await writeFile(path, 'approved original');
  declarations([{ id: 'original', path: 'out', kind: 'file', frozen: false }], [{ path: 'out', kind: 'file', existing: 'update' }]);
  const baseline = known(await hashInputs(scope));
  declarations([], [{ path: 'out', kind: 'file', existing: 'update' }]);
  setScope({ ...scope, outputBaseline: baseline });
  const cp = await checkpoint();
  const wrong = known(await putEvidence(scope.journal, Buffer.from(JSON.stringify({ ...(await manifest(baseline[0])), path: 'foreign' }))));
  setScope({ ...scope, outputBaseline: [wrong] });
  await writeFile(join(scope.layout.project, 'late-work'), 'must survive refusal');
  expect(await materializeCheckpoint(scope, writer, cp)).toMatchObject({ ok: false, kind: 'invalid' });
  expect(await readFile(join(scope.layout.project, 'late-work'), 'utf8')).toBe('must survive refusal');
  const altered = await checkpoint();
  expect(known(await preserveOutputs(scope, altered)).preserved).toBe(false);
});
it('checkpoint identity cannot substitute a different tree for authenticated Git content', async () => {
  await writeFile(join(scope.layout.project, 'value'), 'selected');
  const selected = await checkpoint();
  const forged = { ...selected, id: 'forged_checkpoint', tree: hash('different content generation') };
  await record({ type: 'checkpoint', checkpoint: forged });
  expect(await readCheckpoint(scope.journal, forged.id)).toMatchObject({ ok: false, kind: 'invalid' });
  await writeFile(join(scope.layout.project, 'late-work'), 'must survive refusal');
  expect((await materializeCheckpoint(scope, writer, forged)).ok).toBe(false);
  expect(await readFile(join(scope.layout.project, 'late-work'), 'utf8')).toBe('must survive refusal');
});
it('describes the change since a base as a patch file, a diffstat, and a command that extracts the base on demand', async () => {
  const project = scope.layout.project, view = join(root, 'view');
  await mkdir(view);
  await writeFile(join(project, 'edit.txt'), 'before\n');
  await writeFile(join(project, 'keep.txt'), 'same\n');
  const base = known(await captureTree(scope));
  const patchPath = join(view, 'change.patch');
  const unchanged = known(await changeSince(scope.journal, base, base, patchPath, join(view, 'base')));
  expect(await readFile(patchPath, 'utf8')).toBe('');
  expect(unchanged.stat).toBe('');
  await writeFile(join(project, 'edit.txt'), 'after\n');
  const current = known(await captureTree(scope));
  const change = known(await changeSince(scope.journal, base, current, patchPath, join(view, 'base')));
  const patch = await readFile(patchPath, 'utf8');
  for (const fact of ['-before', '+after']) expect(patch).toContain(fact);
  expect(patch).not.toContain('keep.txt');
  expect(change.patch).toBe(patchPath);
  expect(change.otherRoots).toEqual([]);
  expect(change.stat).toContain('edit.txt');
  expect(change.stat).toContain('1 file changed');
  // Nothing of the base is materialized until the reviewer runs the command.
  await expect(lstat(join(view, 'base'))).rejects.toThrow();
  execFileSync('sh', ['-c', change.baseCommand]);
  expect(await readFile(join(view, 'base', 'edit.txt'), 'utf8')).toBe('before\n');
});
it('counts a root that is gone from the later generation as changed, in the change view and in the changed paths alike', async () => {
  const project = scope.layout.project, view = join(root, 'view'), artifact = join(root, 'artifact');
  await mkdir(view);
  await writeFile(artifact, 'outside'); await writeFile(join(project, 'kept.txt'), 'same\n');
  declarations([], [{ path: artifact, kind: 'file', existing: 'replace' }]);
  const base = known(await captureTree(scope));
  declarations([], []);
  const current = known(await captureTree(scope));
  const change = known(await changeSince(scope.journal, base, current, join(view, 'change.patch'), join(view, 'base')));
  expect(change.otherRoots).toEqual([artifact]);
  expect(change.stat).toBe('');
  expect(known(await changedTreePaths(scope.journal, base, current))).toEqual([artifact]);
});
it('lists what the Git patch cannot carry, in every root, and says what its base copy cannot restore', async () => {
  const project = scope.layout.project, view = join(root, 'view'), artifact = join(root, 'artifact');
  await mkdir(view);
  await writeFile(artifact, 'outside'); await writeFile(join(project, 'tool.sh'), 'echo\n');
  await chmod(artifact, 0o644); await chmod(join(project, 'tool.sh'), 0o644); await chmod(project, 0o755);   // explicit: the umask must not matter
  declarations([], [{ path: artifact, kind: 'file', existing: 'replace' }]);
  const base = known(await captureTree(scope));
  // A mode other than the default, an empty directory, a special file, and an external root whose bytes are the same but whose mode is not.
  await chmod(join(project, 'tool.sh'), 0o600); await mkdir(join(project, 'empty')); await chmod(join(project, 'empty'), 0o755);
  execFileSync('mkfifo', ['-m', '644', join(project, 'queue')]); await chmod(artifact, 0o600); await chmod(project, 0o750);
  const current = known(await captureTree(scope));
  const patchPath = join(view, 'change.patch');
  const change = known(await changeSince(scope.journal, base, current, patchPath, join(view, 'base')));
  const patch = await readFile(patchPath, 'utf8');
  const rows = patch.split('\n').filter(line => line.startsWith('# "'));
  expect(rows.sort()).toEqual(['# "empty": empty directory, no -> yes', '# "project": mode, 0755 -> 0750', '# "queue": special file, none -> fifo 0644',
    '# "tool.sh": mode, default -> 0600', `# ${JSON.stringify(artifact)}: mode, default -> 0600`].sort());
  expect(change.unpatched).toBe(rows.length);
  expect(change.stat).toBe('');                                  // Git itself sees no change: the list is the only record of these
  expect(change.otherRoots).toEqual([artifact]);
  // The trailing list does not stop the patch from applying: bytes that differ under Git still arrive.
  await writeFile(join(project, 'edit.txt'), 'later\n');
  const edited = known(await changeSince(scope.journal, base, known(await captureTree(scope)), patchPath, join(view, 'base')));
  execFileSync('sh', ['-c', edited.baseCommand]);
  // The fixture poisons repository discovery above the test root, so the copy gets a repository of its own for `git apply`.
  const own = { cwd: join(view, 'base'), env: { PATH: process.env.PATH } };
  execFileSync('git', ['init', '-q'], own); execFileSync('git', ['apply', '--check', patchPath], own);
  // The base copy has none of the unusual entries, as the message says.
  await expect(lstat(join(view, 'base', 'empty'))).rejects.toThrow();
  await expect(lstat(join(view, 'base', 'queue'))).rejects.toThrow();
});
