import type { Input } from '../../dist-rewrite/contract/brief.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile, appendFile, readFile, stat, readdir, truncate, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stateFixture, get } from '../fixtures/rewrite-state.js';
import { runServices } from '../fixtures/rewrite-run-services.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';
import * as state from '../../dist-rewrite/records/state.js';
import * as content from '../../dist-rewrite/records/content.js';
import { evidenceRepository, publishedEvidence } from '../../dist-rewrite/records/evidence.js';
import { runWorkflow } from '../../dist-rewrite/core/loop.js';
import { runAttempt } from '../../dist-rewrite/exec/attempt.js';
import { runDeclaredCommand } from '../../dist-rewrite/exec/command.js';

afterEach(() => { vi.restoreAllMocks(); });

const git = (repository: string, ...args: string[]) => execFileSync('git', ['--git-dir=' + repository, ...args], { env: { PATH: '/usr/bin' } }).toString();
const objectCounts = (repository: string) => Object.fromEntries(git(repository, 'count-objects', '-v').trim().split('\n')
  .map(line => line.split(': ')).map(([key, value]) => [key, Number(value)])) as Record<'count' | 'in-pack' | 'packs', number>;

interface Scenario {
  inputs?: Input[];
  /** Runs in the test process, which the engine did not start, once the first checkpoint is committed and before the next step begins. */
  foreign?: (project: string) => Promise<void>;
  /** The author's own effect during its invocation. */
  author?: (project: string, invocation: number) => Promise<void>;
  /** The reviewing gate's own effect during its invocation. */
  reviewer?: (project: string) => Promise<void>;
}

/** The real loop, attempt, command and content owners over a small project; only the provider is scripted. */
async function sequence<T>(scenario: Scenario, inspect: (ctx: { f: Awaited<ReturnType<typeof stateFixture>>; result: unknown }) => Promise<T>): Promise<T> {
  const command = { id: 'visible-1', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('command.txt','ran')"], env: {}, inputs: [], required: true };
  const declared = [command];
  const plan = { stages: [
    { id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' },
    { id: 'gate', role: 'author', purpose: 'gate', after: ['work'], commands: declared.map(value => value.id) }] };
  const f = await stateFixture({ commands: declared, inputs: scenario.inputs ?? [] }, plan as never);
  try {
    await writeFile(join(f.project, 'source.txt'), 'original\n');
    await f.admit();
    await mkdir(join(f.configRoot, 'roles'), { recursive: true });
    for (const role of ['work', 'gate']) await writeFile(join(f.configRoot, 'roles', role + '.md'), 'Role ' + role);
    const scope = { ...f.scope, authority: { ...f.scope.authority, preferences: [{ role: 'author', backend: 'codex' as const,
      settings: { model: 'fixture', effort: 'fixture', source: { model: 'role' as const, effort: 'role' as const } } }] } };
    const proc = runServices(f).process(f.execution);
    const attempts = new Map<string, number>();
    const adapter = { invoke: async (backend: { attempt: { stage: string }; schema: unknown; role: unknown; input: unknown }) => {
      const stage = backend.attempt.stage, invocation = (attempts.set(stage, (attempts.get(stage) ?? 0) + 1), attempts.get(stage)!);
      if (stage === 'work') await (scenario.author ?? (async project => { await appendFile(join(project, 'source.txt'), 'edited\n'); }))(f.project, invocation);
      if (stage === 'gate') await scenario.reviewer?.(f.project);
      const answer = stage === 'work' ? { kind: 'work', answer: { status: 'delivered', summary: 'ok', caveats: [], remainingWork: [], blocks: null } }
        : { kind: 'gate', answer: { outcome: 'accepted', reason: 'ok', criteria: { correct: { status: 'pass', evidence: 'x' } }, findings: [], remainingWork: [] } };
      const answerBytes = get(await state.putEvidence(f.journal, Buffer.from(JSON.stringify(answer))));
      const schema = get(await state.putEvidence(f.journal, Buffer.from(JSON.stringify(backend.schema))));
      const raw = get(await state.putEvidence(f.journal, Buffer.from(JSON.stringify({ attempt: backend.attempt, role: backend.role, input: backend.input, schema, answerBytes }))));
      return { ok: true, value: { raw, exit: 0, signal: null, ending: 'delivered', answerBytes, closure: 'dead', usage: { state: 'unknown', raw: [] }, nativeCommands: [] } };
    } };
    let wrote = false;
    const base = workflowFixture(f).ports;
    const ports = { ...base,
      publishStatus: async (...args: Parameters<typeof base.publishStatus>) => {
        if (scenario.foreign && !wrote && (await f.projection()).checkpoints.length > 0) { wrote = true; await scenario.foreign(f.project); }
        return base.publishStatus(...args);
      },
      attempt: (request: Parameters<typeof runAttempt>[0]) => runAttempt(request, { scope, adapter: adapter as never, process: proc,
        configRoot: f.configRoot, privateEnvironment: {}, abort: new AbortController().signal }),
      command: (request: Parameters<typeof runDeclaredCommand>[0]) => runDeclaredCommand(request, { scope, writer: f.execution, process: proc, abort: new AbortController().signal }) };
    const result = await runWorkflow({ writer: f.execution, scope, ports: ports as never, abort: new AbortController().signal });
    return await inspect({ f: { ...f, scope } as typeof f, result });
  } finally { vi.restoreAllMocks(); await f.close(); }
}

it('work, command and gate bind the bytes they judged', async () => {
  await sequence({}, async ({ f, result }) => {
    expect(result).toMatchObject({ ok: true, value: { status: 'complete' } });
    const p = await f.projection();
    const [work, gate] = [p.attempts.find(a => a.address.stage === 'work')!, p.attempts.find(a => a.address.stage === 'gate')!];
    const [workCheckpoint, gateCheckpoint] = [p.checkpoints.find(c => c.address.stage === 'work')!, p.checkpoints.find(c => c.address.stage === 'gate')!];
    const receipt = p.commands.find(c => c.command === 'visible-1')!;
    expect(workCheckpoint.tree).toBe(work.after);
    expect(gateCheckpoint.tree).toBe(gate.after);
    // Each boundary starts from the capture the step before ended with.
    expect(receipt.before).toBe(workCheckpoint.tree);
    expect(receipt.after).not.toBe(receipt.before);
    expect(gate.before).toBe(receipt.after);
    expect(gate.after).toBe(gate.before);
    // What is bound is what is on disk.
    expect(get(await content.captureTree(f.scope))).toBe(gateCheckpoint.tree);
  });
});

it('a write by a process the engine did not start is seen by the next step, which holds nothing and so reads the project', async () => {
  await sequence({ foreign: project => writeFile(join(project, 'foreign.txt'), 'not the engine\n') }, async ({ f, result }) => {
    expect(result).toMatchObject({ ok: true, value: { status: 'complete' } });
    const p = await f.projection();
    const work = p.attempts.find(a => a.address.stage === 'work')!;
    const workCheckpoint = p.checkpoints.find(c => c.address.stage === 'work')!;
    const receipt = p.commands.find(c => c.command === 'visible-1')!;
    const gate = p.attempts.find(a => a.address.stage === 'gate')!;
    expect(workCheckpoint.tree).toBe(work.after);
    // The command's key and its before-binding name the tree with the foreign file, not the checkpoint's.
    expect(receipt.before).not.toBe(workCheckpoint.tree);
    expect(get(await content.changedTreePaths(f.journal, workCheckpoint.tree, receipt.before))).toEqual(['foreign.txt']);
    expect(get(await content.changedTreePaths(f.journal, receipt.before, receipt.after))).toEqual(['command.txt']);
    expect(gate.before).toBe(receipt.after);
    expect(p.checkpoints.at(-1)!.tree).toBe(get(await content.captureTree(f.scope)));
  });
});

it('a frozen input the author changed is restored, and the checkpoint binds the restored tree, not the attempt\'s after-capture', async () => {
  const inputs: Input[] = [{ id: 'spec', path: 'spec.txt', kind: 'file', frozen: true }];
  await sequence({ inputs, author: async (project, invocation) => {
    await appendFile(join(project, 'source.txt'), 'edited\n');
    if (invocation === 1) await writeFile(join(project, 'spec.txt'), 'the author rewrote a frozen input\n');
  } }, async ({ f }) => {
    const p = await f.projection();
    const first = p.attempts.find(a => a.address.stage === 'work')!;
    const checkpoint = p.checkpoints.find(c => c.address.stage === 'work')!;
    expect(first.ending).toBe('isolation_failure');
    // The invocation saw spec.txt; the restored tree does not, and that is the tree the checkpoint binds.
    expect(get(await content.changedTreePaths(f.journal, first.before, first.after))).toEqual(['source.txt', 'spec.txt']);
    expect(checkpoint.tree).not.toBe(first.after);
    expect(get(await content.changedTreePaths(f.journal, first.before, checkpoint.tree))).toEqual(['source.txt']);
    await expect(stat(join(f.project, 'spec.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The restored audit is reused by the checkpoint: the input is read once per settlement.
    expect(checkpoint.inputHashes).toHaveLength(1);
  });
});

it('what a reviewing gate leaves in the project is not delivered: the checkpoint binds the tree it reviewed and the accepted run completes', async () => {
  let reviewed = false;
  await sequence({ reviewer: async project => {
    if (reviewed) return;
    reviewed = true;
    await appendFile(join(project, 'source.txt'), 'reviewer edit\n');
    await writeFile(join(project, 'byproduct.txt'), 'left by the reviewer\'s tools');
    await rm(join(project, 'command.txt'));
  } }, async ({ f, result }) => {
    expect(result).toMatchObject({ ok: true, value: { status: 'complete' } });
    const p = await f.projection();
    const gate = p.attempts.find(a => a.address.stage === 'gate')!;
    const checkpoint = p.checkpoints.find(c => c.address.stage === 'gate')!;
    expect(gate.ending).toBe('delivered');
    // The receipt keeps what the invocation left; the checkpoint, and so the delivery, binds what it reviewed.
    expect(get(await content.changedTreePaths(f.journal, gate.before, gate.after))).toEqual(['byproduct.txt', 'command.txt', 'source.txt']);
    expect(checkpoint).toMatchObject({ state: 'safe', tree: gate.before });
    expect(get(await content.captureTree(f.scope))).toBe(gate.before);
    expect(await readFile(join(f.project, 'source.txt'), 'utf8')).toBe('original\nedited\n');
    expect(await readFile(join(f.project, 'command.txt'), 'utf8')).toBe('ran');
    await expect(stat(join(f.project, 'byproduct.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('settlement binds every declared input into its checkpoints', async () => {
  const inputs: Input[] = ['a', 'b', 'c'].map(id => ({ id, path: id + '.txt', kind: 'file' as const, frozen: false }));
  await sequence({ inputs }, async ({ f, result }) => {
    expect(result).toMatchObject({ ok: true, value: { status: 'complete' } });
    expect((await f.projection()).checkpoints.every(checkpoint => checkpoint.inputHashes.length === 3)).toBe(true);
  });
});

it('a recorded tree hash names the evidence published for it, authenticated against that hash; a hash nothing published is unavailable', async () => {
  const f = await stateFixture({}, { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' }] } as never);
  try {
    await writeFile(join(f.project, 'source.txt'), 'bytes');
    const sha = get(await content.captureTree(f.scope));
    const ref = get(await publishedEvidence(f.journal, sha));
    expect(ref.sha256).toBe(sha);
    expect(get(await content.captureGeneration(f.scope))).toEqual(ref);
    expect(await publishedEvidence(f.journal, '0'.repeat(64))).toMatchObject({ ok: false, kind: 'unavailable' });
  } finally { await f.close(); }
});

it('a tree that already is the base checkpoint is not rewritten, and both restore events are still journalled', async () => {
  const f = await stateFixture({}, { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' }] } as never);
  try {
    await f.admit();
    await writeFile(join(f.project, 'source.txt'), 'base\n');
    const cp = get(await content.captureCheckpoint(f.scope, { run: 'Run', stage: 'work', attempt: 'attempt', invocation: 1 }, null, 'safe', [], get(await content.settleFrozenInputs(f.scope)).inputs));
    await f.append(f.execution, [{ type: 'checkpoint', checkpoint: cp }]);
    const events = async () => get(await state.readEvents(f.journal, 0)).map(event => event.payload.type);
    const restoreEvents = async () => (await events()).filter(type => type === 'checkpoint_restore_started' || type === 'checkpoint_materialized');
    const before = (await stat(join(f.project, 'source.txt'))).ino;
    expect(get(await content.materializeCheckpoint(f.scope, f.execution, cp))).toBe(cp.tree);
    expect((await stat(join(f.project, 'source.txt'))).ino).toBe(before);
    expect(await restoreEvents()).toEqual(['checkpoint_restore_started', 'checkpoint_materialized']);
    // A differing tree is replaced, and the same two events follow.
    await writeFile(join(f.project, 'source.txt'), 'edited\n');
    const edited = (await stat(join(f.project, 'source.txt'))).ino;
    expect(get(await content.materializeCheckpoint(f.scope, f.execution, cp))).toBe(cp.tree);
    expect(await readFile(join(f.project, 'source.txt'), 'utf8')).toBe('base\n');
    expect((await stat(join(f.project, 'source.txt'))).ino).not.toBe(edited);
    expect(await restoreEvents()).toHaveLength(4);
  } finally { await f.close(); }
});

it('a capture stores its new objects in one pack, however many there are', async () => {
  const f = await stateFixture({}, { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' }] } as never);
  try {
    const repository = evidenceRepository(f.journal);
    for (let i = 0; i < 40; i++) await writeFile(join(f.project, 'file' + i + '.txt'), 'content ' + i);
    const start = objectCounts(repository);
    get(await content.captureTree(f.scope));
    const first = objectCounts(repository);
    expect(first.packs - start.packs).toBe(1);
    expect(first['in-pack'] - start['in-pack']).toBeGreaterThanOrEqual(41);   // 40 blobs and the root tree
    expect(first.count - start.count).toBeLessThanOrEqual(1);                  // only the manifest evidence is loose
    get(await content.captureTree(f.scope));
    expect(objectCounts(repository).packs).toBe(first.packs);                  // nothing new, nothing written
    await writeFile(join(f.project, 'file7.txt'), 'changed');
    get(await content.captureTree(f.scope));
    const edited = objectCounts(repository);
    expect(edited.packs - first.packs).toBe(1);
    expect(edited['in-pack'] - first['in-pack']).toBe(2);                      // the new blob and the new root tree
  } finally { await f.close(); }
});

it('a file above core.bigFileThreshold, which git streams into a pack of its own, is kept as well', async () => {
  const f = await stateFixture({}, { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' }] } as never);
  try {
    const repository = evidenceRepository(f.journal), size = 600 * 1024 * 1024;
    await writeFile(join(f.project, 'small.txt'), 'small');
    await writeFile(join(f.project, 'big.bin'), '');
    await truncate(join(f.project, 'big.bin'), size);                         // sparse: reads as zeros
    get(await content.captureGeneration(f.scope));
    const root = git(repository, 'for-each-ref', '--format=%(objectname)', 'refs/content').trim().split('\n');
    expect(root.length).toBeGreaterThan(0);
    const listed = git(repository, 'ls-tree', '-r', '-l', root[0]).trim().split('\n').map(line => line.split(/\s+/));
    const big = listed.find(row => row.at(-1) === 'big.bin')!;
    expect(Number(big[3])).toBe(size);
    git(repository, 'cat-file', '-e', big[2]);
    expect((await readdir(join(repository, 'objects', 'pack'))).filter(name => name.endsWith('.idx')).length).toBeGreaterThanOrEqual(2);
    expect(git(repository, 'fsck', '--full', '--strict')).not.toMatch(/missing|corrupt|error/i);
  } finally { await f.close(); }
}, 120_000);

it.each([
  ['after its pack is complete and before it is published', async (repository: string, held: readonly string[]) =>
    (await readdir(join(repository, 'objects', 'pack'))).some(name => name.endsWith('.idx') && !held.includes(name)), false],
  // git writes the pack under tmp_pack_* in the private object directory until it is complete.
  ['while its pack is being written', async (repository: string, _held: readonly string[]) => {
    for (const name of await readdir(repository)) if (name.startsWith('private-') && (await readdir(join(repository, name, 'pack')).catch(() => [] as string[])).some(file => file.startsWith('tmp_pack_'))) return true;
    return false;
  }, true],
] as const)('a capture killed %s leaves nothing to repair', async (_when, seen, wholeGroup) => {
  const f = await stateFixture({}, { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' }] } as never);
  try {
    const repository = evidenceRepository(f.journal);
    for (let i = 0; i < 200; i++) await writeFile(join(f.project, 'file' + i + '.bin'), randomBytes(200_000));
    // Independent expectation: plain git over the same bytes.
    const control = join(f.root, 'control.git');
    execFileSync('git', ['init', '--bare', '-q', control], { env: { PATH: '/usr/bin' } });
    const env = { PATH: '/usr/bin', GIT_DIR: control, GIT_WORK_TREE: f.project, GIT_INDEX_FILE: join(control, 'index') };
    execFileSync('git', ['add', '-A', '--', '.'], { env, cwd: f.project });
    const expected = execFileSync('git', ['write-tree'], { env, cwd: f.project }).toString().trim();
    // The fixture's setup already captured the base (empty) project; that is the only publication the killed capture may leave beside.
    const base = git(repository, 'for-each-ref', 'refs/content').trim();
    expect(base).not.toBe('');
    const held = (await readdir(join(repository, 'objects', 'pack'))).filter(name => name.endsWith('.idx'));  // the base capture's pack
    const pending = content.captureTree(f.scope);
    let finished = false;
    void pending.finally(() => { finished = true; });
    let killed = false, published = '';
    while (!killed && !finished) {
      if (await seen(repository, held)) {
        const db = new DatabaseSync(f.location.database);
        try {
          for (const row of db.prepare("SELECT owner FROM resources WHERE id LIKE 'record:%'").all() as { owner: string }[]) {
            const owner = JSON.parse(row.owner);
            try { process.kill(wholeGroup ? -owner.group : owner.pid, 'SIGKILL'); killed = true; } catch { /* already gone */ }
            published = git(repository, 'for-each-ref', 'refs/content').trim();
          }
        } finally { db.close(); }
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(killed).toBe(true);
    expect((await pending).ok).toBe(false);
    // Nothing of the killed capture had been published, so the journal can reference nothing of it.
    expect(published).toBe(base);
    expect(get(await state.readEvents(f.journal, 0))).toHaveLength(0);
    get(await state.reclaimRecordOperations(f.journal));
    // A group killed mid-capture leaves its private object directory behind; a retry must not depend on it being gone.
    if (wholeGroup) expect((await readdir(repository)).some(name => name.startsWith('private-'))).toBe(true);
    // The retry stores the same tree as plain git computes, and every object it names is present.
    const generation = get(await content.captureGeneration(f.scope));
    expect(get(await content.captureTree(f.scope))).toBe(generation.sha256);
    expect(git(repository, 'for-each-ref', '--format=%(objectname)', 'refs/content').trim().split('\n')).toContain(expected);
    expect(git(repository, 'fsck', '--full', '--strict')).not.toMatch(/missing|corrupt|error/i);
    // The retry removed what the dead capture left.
    expect((await readdir(repository)).filter(name => name.startsWith('private-'))).toEqual([]);
  } finally { await f.close(); }
}, 120_000);

/** Kills the operation's whole process group (the record operation's recorded owner) once `seen` holds; returns what it saw. */
async function killWhen<T extends { ok: boolean }>(pending: Promise<T>, database: string, seen: () => Promise<string>): Promise<{ killed: string; ok: boolean }> {
  let finished = false;
  void pending.finally(() => { finished = true; });
  let killed = '';
  while (!killed && !finished) {
    const at = await seen();
    if (at) {
      const db = new DatabaseSync(database);
      try {
        for (const row of db.prepare("SELECT owner FROM resources WHERE id LIKE 'record:%'").all() as { owner: string }[]) {
          try { process.kill(-JSON.parse(row.owner).group, 'SIGKILL'); killed = at; } catch { /* already gone */ }
        }
      } finally { db.close(); }
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  return { killed, ok: (await pending).ok };
}
/** The private directories a dead user of the repository leaves, with their entries. */
async function privateDirectories(repository: string): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {};
  for (const name of await readdir(repository)) if (name.startsWith('private-')) found[name] = await readdir(join(repository, name)).catch(() => [] as string[]);
  return found;
}
/** An object (or git's temporary file for one) in a private object directory, where a capture writes its objects and nowhere else. */
const objectIn = (repository: string) => async () => {
  for (const [name, entries] of Object.entries(await privateDirectories(repository)))
    for (const fan of entries.filter(entry => /^[0-9a-f]{2}$/.test(entry)))
      for (const object of await readdir(join(repository, name, fan)).catch(() => [] as string[])) return name + '/' + fan + '/' + object;
  return '';
};

it('a capture killed while it is writing objects blocks no later capture, and the next one removes what the dead one left', async () => {
  const f = await stateFixture({}, { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' }] } as never);
  try {
    const repository = evidenceRepository(f.journal);
    for (let i = 0; i < 200; i++) await writeFile(join(f.project, 'file' + i + '.bin'), randomBytes(200_000));
    const packs = async () => (await readdir(join(repository, 'objects', 'pack'))).filter(name => name.endsWith('.idx'));
    const held = await packs();                                                // the base capture's pack, from the fixture's setup
    const dead = await killWhen(content.captureTree(f.scope), f.location.database, objectIn(repository));
    // The kill landed while objects were being stored: an object (or git's temporary file for one) exists in the dead capture's private
    // directory, its index is there too, and the repository's own pack directory has gained no pack.
    expect(dead.killed).toMatch(/^private-[^/]+\/[0-9a-f]{2}\/([0-9a-f]{38}|tmp_obj_\w+)$/);
    expect(dead.ok).toBe(false);
    const left = await privateDirectories(repository);
    expect(Object.keys(left)).toHaveLength(1);
    expect(Object.keys(left)[0]).toBe(dead.killed.split('/')[0]);
    expect((await readdir(join(repository, dead.killed.split('/')[0], dead.killed.split('/')[1]))).length).toBeGreaterThan(0);
    expect(left[Object.keys(left)[0]].some(entry => /^index/.test(entry))).toBe(true);
    expect(await packs()).toEqual(held);
    get(await state.reclaimRecordOperations(f.journal));
    const retried = get(await content.captureGeneration(f.scope));
    expect(await privateDirectories(repository)).toEqual({});
    expect(get(await content.captureTree(f.scope))).toBe(retried.sha256);
    expect(git(repository, 'fsck', '--full', '--strict')).not.toMatch(/missing|corrupt|error/i);
  } finally { await f.close(); }
}, 120_000);

it('a restore killed while it is staging a tree blocks no later restore, and the next one removes what the dead one left', async () => {
  const f = await stateFixture({}, { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' }] } as never);
  try {
    const repository = evidenceRepository(f.journal);
    await f.admit();
    for (let i = 0; i < 200; i++) await writeFile(join(f.project, 'file' + i + '.bin'), randomBytes(200_000));
    const cp = get(await content.captureCheckpoint(f.scope, { run: 'Run', stage: 'work', attempt: 'attempt', invocation: 1 }, null, 'safe', [], get(await content.settleFrozenInputs(f.scope)).inputs));
    await f.append(f.execution, [{ type: 'checkpoint', checkpoint: cp }]);
    // A project that differs from the checkpoint, so the restore has bytes to install.
    await writeFile(join(f.project, 'file0.bin'), 'edited');
    // checkout-index writes into the staging directory only after read-tree has written the restore's index.
    const staging = async () => {
      const privates = await privateDirectories(repository);
      for (const name of await readdir(f.root)) if (name.startsWith('.restore-') && (await readdir(join(f.root, name)).catch(() => [] as string[])).length > 0)
        for (const [dir, entries] of Object.entries(privates)) if (entries.includes('index')) return name + ' ' + dir;
      return '';
    };
    const dead = await killWhen(content.materializeCheckpoint(f.scope, f.execution, cp), f.location.database, staging);
    expect(dead.killed).toMatch(/^\.restore-\S+ private-\S+$/);
    expect(dead.ok).toBe(false);
    // The dead restore left its private directory, with the index it was reading; the live bytes were not touched.
    const left = await privateDirectories(repository);
    expect(Object.keys(left)).toContain(dead.killed.split(' ')[1]);
    expect(left[dead.killed.split(' ')[1]]).toContain('index');
    expect(await readFile(join(f.project, 'file0.bin'), 'utf8')).toBe('edited');
    // Its index is inside that directory: nothing it wrote sits in the repository itself, where a later restore with the same pid would find it.
    expect((await readdir(repository)).filter(name => /^(restore-|index)/.test(name))).toEqual([]);
    get(await state.reclaimRecordOperations(f.journal));
    expect(get(await content.materializeCheckpoint(f.scope, f.execution, cp))).toBe(cp.tree);
    expect((await readFile(join(f.project, 'file0.bin'))).length).toBe(200_000);
    expect(await privateDirectories(repository)).toEqual({});
    expect(git(repository, 'fsck', '--full', '--strict')).not.toMatch(/missing|corrupt|error/i);
  } finally { await f.close(); }
}, 120_000);

it('a capture that starts while another is alive does not remove the live one\'s private directory', async () => {
  const f = await stateFixture({}, { stages: [{ id: 'work', role: 'author', purpose: 'work', after: [], instruction: 'Deliver' }] } as never);
  try {
    const repository = evidenceRepository(f.journal);
    for (let i = 0; i < 100; i++) await writeFile(join(f.project, 'file' + i + '.bin'), randomBytes(200_000));
    await mkdir(join(f.root, 'other'));
    await writeFile(join(f.root, 'other', 'small.txt'), 'small');
    const long = content.captureTree(f.scope);
    let finished = false;
    void long.finally(() => { finished = true; });
    while (!finished && !(await readdir(repository)).some(name => name.startsWith('private-'))) await new Promise(resolve => setTimeout(resolve, 1));
    // The second capture runs while the first is mid-flight; it must find the first one's lock held and leave its directory alone.
    expect((await content.snapshotTask(f.journal, join(f.root, 'other'))).ok).toBe(true);
    expect(finished).toBe(false);
    expect((await long).ok).toBe(true);
  } finally { await f.close(); }
}, 120_000);
