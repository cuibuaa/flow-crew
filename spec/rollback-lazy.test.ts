import { execFileSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RollbackContentStore } from '../src/rollback-content-store.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { captureRepairRoundSnapshot } from '../src/scheduler/sched_scope/snapshots.js';
import { enforceStageScopeWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { decideScopeRevision } from '../src/scheduler/sched_scope/scope-revisions.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createRun } from '../src/store.js';

const roots: string[] = [];
const baselines: [string, string][] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const [project, run] of baselines.splice(0)) closeRollbackBaseline(project, run);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(name: string) {
  const project = join(process.env.FLOWCREW_VITEST_ROOT!, name);
  roots.push(project);
  mkdirSync(project, { recursive: true });
  const created = createRun(project, 'lazy rollback fixture', '', ['plan', 'writer']);
  baselines.push([project, created.runDirPath]);
  return { project, ...created };
}
const stage = (id: string, scope: string[]) => StageConfigSchema.parse({ id, role: 'coder', scope });
function storedBytes(run: string) {
  return readdirSync(join(run, '.rollback-preimages')).reduce((total, path) => total + statSync(join(run, '.rollback-preimages', path)).size, 0);
}

describe('rollback capture follows admitted writes', () => {
  it('stores zero bytes for an ignored sparse cache and a read-only input, including resume and broad scopes', () => {
    const { project, runId, runDirPath } = fixture('lazy-read-only');
    writeFileSync(join(project, '.gitignore'), 'cache/\n');
    execFileSync(process.execPath, ['--input-type=module', '-e', "import { execFileSync } from 'node:child_process'; execFileSync('git', ['init', '-q']);"], {
      cwd: project, env: { ...process.env, HOME: project, FC_HOME: project },
    });
    mkdirSync(join(project, 'cache'));
    const sparse = join(project, 'cache', 'weights.bin');
    const fd = openSync(sparse, 'wx');
    try { ftruncateSync(fd, 2 ** 31 + 17); } finally { closeSync(fd); }
    expect(statSync(sparse).blocks * 512).toBeLessThan(1024 * 1024);
    writeFileSync(join(project, 'input.bin'), Buffer.alloc(27_546_197, 0x41));
    writeFileSync(join(runDirPath, 'task_brief.md'), '---\ninputs: [input.bin]\n---\n# Goal\nRead the input.\n');
    // A reverted broad-tree bug must fail without allocating a multi-GiB copy.
    const original = RollbackContentStore.prototype.capture;
    const capture = vi.spyOn(RollbackContentStore.prototype, 'capture').mockImplementation(function(source, logical) {
      if (source === sparse) throw new Error('ignored cache reached rollback capture');
      return original.call(this, source, logical);
    });
    const planner = stage('plan', []);
    createScopeBatchContext(project, [planner], undefined, runId);
    expect(storedBytes(runDirPath)).toBe(0);
    expect(capture).not.toHaveBeenCalled();
    closeRollbackBaseline(project, runDirPath);
    createScopeBatchContext(project, [planner], undefined, runId);
    expect(storedBytes(runDirPath)).toBe(0);
    expect(capture).not.toHaveBeenCalled();
    // The broad writable capability still cannot write a preserved input or
    // turn a disposable ignored cache into required restoration backing.
    createScopeBatchContext(project, [stage('writer', ['**'])], undefined, runId);
    expect(capture.mock.calls.some(([source]) => source === sparse || source === join(project, 'input.bin'))).toBe(false);
    expect(storedBytes(runDirPath)).toBe(0);
  });

  it('captures only writable glob members and reuses immutable backing across rounds and identical replacements', () => {
    const { project, runDirPath } = fixture('lazy-writable');
    mkdirSync(join(project, 'out'));
    const target = join(project, 'out', 'result.bin');
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x41));
    writeFileSync(join(project, 'out', 'unwritable.txt'), 'outside the glob');
    const stages = [stage('writer', ['out/*.bin'])];
    const first = captureRepairRoundSnapshot(project, stages, { runDirPath });
    expect(first.files.has('out/unwritable.txt')).toBe(false);
    const original = first.files.get('out/result.bin')!;
    expect(original.backingPath).toBeTruthy();
    const second = captureRepairRoundSnapshot(project, stages, { runDirPath });
    expect(second.files.get('out/result.bin')!.backingPath).toBe(original.backingPath);
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const third = captureRepairRoundSnapshot(project, stages, { runDirPath });
    expect(third.files.get('out/result.bin')!.backingPath).toBe(original.backingPath);
    expect(storedBytes(runDirPath)).toBe(2 * 1024 * 1024);
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x42));
    const result = enforceStageScopeWrites({ projectDir: project, snapshot: third, effectiveScope: [],
      rawWrites: ['out/result.bin'], definiteWrites: new Set(['out/result.bin']), preserveUnverifiedPath: () => false });
    expect(result.unauthorizedWrites).toEqual(['out/result.bin']);
    expect(result.rolledBackWrites).toEqual(['out/result.bin']);
    expect(result.rollbackFailures).toEqual([]);
    expect(readFileSync(target)[0]).toBe(0x41);
  });

  it('captures newly admitted tree content before the revised writer starts', () => {
    const { project, runId, runDirPath } = fixture('lazy-revision');
    mkdirSync(join(project, 'out'));
    const target = join(project, 'out', 'result.bin');
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const writer = stage('writer', []);
    const snapshot = captureRepairRoundSnapshot(project, [writer], { runDirPath });
    expect(storedBytes(runDirPath)).toBe(0);
    const requestedPaths = ['out/'];
    const decision = decideScopeRevision({ projectDir: project, runId, stage: writer,
      priorScope: [], activePeers: [], attemptIndex: 1, snapshot, request: {
        version: 1, kind: 'scope_revision', requestId: 'grant', runId, stageId: writer.id,
        attemptIndex: 1, requestedBy: 'stage', requestedPaths, pathDigest: scopePathDigest(requestedPaths),
      } });
    expect(decision.accepted).toBe(true);
    expect(snapshot.files.get('out/result.bin')!.backingPath).toBeTruthy();
    expect(storedBytes(runDirPath)).toBe(2 * 1024 * 1024);
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x42));
    const result = enforceStageScopeWrites({ projectDir: project, snapshot, effectiveScope: [],
      rawWrites: ['out/result.bin'], definiteWrites: new Set(['out/result.bin']), preserveUnverifiedPath: () => false });
    expect(result.rolledBackWrites).toEqual(['out/result.bin']);
    expect(readFileSync(target)[0]).toBe(0x41);
  });

  it('retains dirty tracked cache bytes before admitting a broad writer', () => {
    const { project, runDirPath } = fixture('lazy-tracked-cache');
    mkdirSync(join(project, 'data', '.cache'), { recursive: true });
    const target = join(project, 'data', '.cache', 'operator.bin');
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x41));
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { execFileSync } from 'node:child_process';
      for (const args of [['init', '-q'], ['add', '-f', 'data/.cache/operator.bin'],
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
        execFileSync('git', args);
      }
    `], { cwd: project, env: { ...process.env, HOME: project, FC_HOME: project } });
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x42));
    const snapshot = captureRepairRoundSnapshot(project, [stage('writer', ['data/**'])], { runDirPath });
    expect(snapshot.files.get('data/.cache/operator.bin')!.backingPath).toBeTruthy();
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x43));
    const result = enforceStageScopeWrites({ projectDir: project, snapshot, effectiveScope: [],
      rawWrites: ['data/.cache/operator.bin'], definiteWrites: new Set(['data/.cache/operator.bin']), preserveUnverifiedPath: () => false });
    expect(result.rolledBackWrites).toEqual(['data/.cache/operator.bin']);
    expect(readFileSync(target)[0]).toBe(0x42);
  });

  it('captures newly authored bytes before admitting the next writer of a Git-tracked file', () => {
    const { project, runDirPath } = fixture('lazy-next-writer');
    const target = join(project, 'output.bin');
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x41));
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { execFileSync } from 'node:child_process';
      for (const args of [['init', '-q'], ['add', 'output.bin'],
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
        execFileSync('git', args);
      }
    `], { cwd: project, env: { ...process.env, HOME: project, FC_HOME: project } });
    const writer = stage('writer', ['output.bin']);
    const first = captureRepairRoundSnapshot(project, [writer], { runDirPath });
    expect(storedBytes(runDirPath)).toBe(0);
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x42));
    expect(enforceStageScopeWrites({ projectDir: project, snapshot: first, effectiveScope: writer.scope!,
      rawWrites: ['output.bin'], definiteWrites: new Set(['output.bin']), preserveUnverifiedPath: () => false })
      .appliedWrites).toEqual(['output.bin']);
    // Settlement retains the newly admitted bytes before a later unauthorized
    // writer can destroy them, even if no next writer has been admitted yet.
    expect(storedBytes(runDirPath)).toBe(2 * 1024 * 1024);
    const next = captureRepairRoundSnapshot(project, [writer], { runDirPath });
    expect(next.files.get('output.bin')!.backingPath).toBeTruthy();
    expect(storedBytes(runDirPath)).toBe(2 * 1024 * 1024);
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x43));
    expect(enforceStageScopeWrites({ projectDir: project, snapshot: next, effectiveScope: [],
      rawWrites: ['output.bin'], definiteWrites: new Set(['output.bin']), preserveUnverifiedPath: () => false })
      .rolledBackWrites).toEqual(['output.bin']);
    expect(readFileSync(target)[0]).toBe(0x42);
  });

  it('withholds write admission when preimage capture fails', () => {
    const { project, runId, runDirPath } = fixture('lazy-capture-failure');
    writeFileSync(join(project, 'output.bin'), Buffer.alloc(2 * 1024 * 1024, 0x41));
    const writer = stage('writer', []);
    const snapshot = captureRepairRoundSnapshot(project, [writer], { runDirPath });
    vi.spyOn(RollbackContentStore.prototype, 'capture').mockImplementation(() => { throw new Error('capture unavailable'); });
    expect(() => captureRepairRoundSnapshot(project, [stage('writer', ['output.bin'])], { runDirPath }))
      .toThrow('capture unavailable');
    const requestedPaths = ['output.bin'];
    expect(() => decideScopeRevision({ projectDir: project, runId, stage: writer,
      priorScope: [], activePeers: [], attemptIndex: 1, snapshot, request: {
        version: 1, kind: 'scope_revision', requestId: 'grant', runId, stageId: writer.id,
        attemptIndex: 1, requestedBy: 'stage', requestedPaths, pathDigest: scopePathDigest(requestedPaths),
      } })).toThrow('capture unavailable');
    expect(snapshot.files.has('output.bin')).toBe(false);
    expect(storedBytes(runDirPath)).toBe(0);
  });

  it('keeps an unrestored read-only input edit visible across later batches', () => {
    const { project, runId, runDirPath } = fixture('lazy-input-identity');
    const target = join(project, 'input.bin');
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x41));
    writeFileSync(join(runDirPath, 'task_brief.md'), '---\ninputs: [input.bin]\n---\n# Goal\nPreserve the input.\n');
    const planner = stage('plan', []);
    const first = createScopeBatchContext(project, [planner], undefined, runId);
    const sha256 = first.snapshot.files.get('input.bin')!.sha256;
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 0x42));
    const later = createScopeBatchContext(project, [planner], undefined, runId);
    expect(later.snapshot.files.get('input.bin')!.sha256).toBe(sha256);
    const result = enforceStageScopeWrites({ projectDir: project, snapshot: later.snapshot,
      declaredInputs: later.declaredInputs, effectiveScope: [], rawWrites: ['input.bin'],
      definiteWrites: new Set(['input.bin']), preserveUnverifiedPath: () => false });
    expect(result.unauthorizedWrites).toEqual(['input.bin']);
    expect(result.rollbackFailures).toEqual(['input.bin']);
    expect(storedBytes(runDirPath)).toBe(0);
  });

  it('still refuses an out-of-scope write when only its identity was retained', () => {
    const { project, runDirPath } = fixture('lazy-forbidden');
    const path = join(project, 'operator.bin');
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 0x41));
    const snapshot = captureRepairRoundSnapshot(project, [stage('plan', [])], { runDirPath });
    expect(storedBytes(runDirPath)).toBe(0);
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 0x42));
    const result = enforceStageScopeWrites({ projectDir: project, snapshot, effectiveScope: [],
      rawWrites: ['operator.bin'], definiteWrites: new Set(['operator.bin']), preserveUnverifiedPath: () => false });
    expect(result.unauthorizedWrites).toEqual(['operator.bin']);
    expect(result.rollbackFailures).toEqual(['operator.bin']);
    expect(result.rolledBackWrites).toEqual([]);
    expect(readFileSync(path)[0]).toBe(0x42);
  });
});
