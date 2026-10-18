import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { captureRepairRoundSnapshot } from '../src/scheduler/sched_scope/snapshots.js';
import { createLiveGuardFactory, enforceStageScopeWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { listProjectFilesAt } from '../src/scheduler/sched_scope/path-capabilities.js';
import { createRun, fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let root: string;
let project: string;
let previousState: string;
let runPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-git-content-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousState = fcGlobalDir();
  setFcGlobalDir(join(root, 'state'));
  writeFileSync(join(project, 'source.txt'), 'original project content\n');
  writeFileSync(join(project, '.gitkeep'), 'ordinary dotfile\n');
});

afterEach(() => {
  closeRollbackBaseline(project, runPath);
  setFcGlobalDir(previousState);
  rmSync(root, { recursive: true, force: true });
});

const metadata = ['.git/FETCH_HEAD', '.git/objects/pack/tmp_pack_fixture', 'nested/.git/HEAD', '.git'];

describe('Git metadata and project content boundary', () => {
  it.each(['live', 'settlement'])('preserves ignored generated effects, restores tracked content, and refuses an unbacked input write (%s)', async boundary => {
    const generated = ['artifacts/output.txt', '.cache/active.lock'];
    const protectedPaths = ['artifacts/tracked.txt', 'artifacts/input.txt'];
    for (const path of [...generated, ...protectedPaths]) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), 'original');
    }
    writeFileSync(join(project, '.gitignore'), 'artifacts/\n.cache/\n');
    const git = (args: string[]) => isolatedProjectCommand('git', args, project, root);
    git(['init', '-q']); git(['add', '-f', protectedPaths[0]]);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const stage = StageConfigSchema.parse({ id: 'writer', role: 'coder', scope: [] });
    const created = createRun(project, 'content-boundary', '', ['writer']);
    runPath = created.runDirPath;
    writeFileSync(join(runPath, 'task_brief.md'), `---\ninputs: [${protectedPaths[1]}]\n---\nRead the input.`);
    const context = createScopeBatchContext(project, [stage], undefined, created.runId);
    const paths = [...generated, ...protectedPaths];
    for (const path of paths) writeFileSync(join(project, path), 'changed');
    if (boundary === 'live') {
      const factory = createLiveGuardFactory().createSchedulerLiveConstraintGuardFactory({ stage, projectDir: project, runId: created.runId, context })!;
      const monitor = factory({ attemptIndex: 1, attemptStartedAt: new Date().toISOString() }).beginInvocation(1, () => {});
      monitor.observePaths(paths);
      const incidents = (await monitor.finish()).incidents;
      expect(incidents).toHaveLength(protectedPaths.length);
      expect(incidents).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: protectedPaths[0], restored: true }),
        expect.objectContaining({ path: protectedPaths[1], restored: false,
          rollbackFailure: expect.stringContaining('preimage content is unavailable') }),
      ]));
    } else {
      const audit = enforceStageScopeWrites({ projectDir: project, snapshot: context.snapshot, effectiveScope: [],
        declaredInputs: context.declaredInputs, rawWrites: paths, definiteWrites: new Set(paths), preserveUnverifiedPath: () => false });
      expect(audit.exemptedWrites).toEqual(generated);
      expect(audit.unauthorizedWrites).toEqual(protectedPaths);
      expect(audit.rolledBackWrites).toEqual([protectedPaths[0]]);
      expect(audit.rollbackFailures).toEqual([protectedPaths[1]]);
      expect(audit.rollbackFailureReasons[protectedPaths[1]]).toContain('preimage content is unavailable');
    }
    for (const path of generated) expect(readFileSync(join(project, path), 'utf8')).toBe('changed');
    expect(readFileSync(join(project, protectedPaths[0]), 'utf8')).toBe('original');
    expect(readFileSync(join(project, protectedPaths[1]), 'utf8')).toBe('changed');
  });

  it.each(metadata)('ignores metadata notification %s and restores real project edits', async path => {
    const stage = StageConfigSchema.parse({ id: 'writer', role: 'coder', scope: [], depends_on: [] });
    const created = createRun(project, 'content-boundary', '', ['writer']);
    runPath = created.runDirPath;
    // These mutable source paths were admitted before this read-only attempt;
    // metadata notifications must not release their retained preimages.
    captureRepairRoundSnapshot(project, [{ ...stage, scope: ['source.txt', '.gitkeep'] }], { runDirPath: runPath });
    const context = createScopeBatchContext(project, [stage], undefined, created.runId);
    const factory = createLiveGuardFactory()
      .createSchedulerLiveConstraintGuardFactory({ stage, projectDir: project, runId: created.runId, context })!;
    const aborts: string[] = [];
    const monitor = factory({ attemptIndex: 1, attemptStartedAt: new Date().toISOString() })
      .beginInvocation(1, reason => aborts.push(reason));
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), 'Git-owned metadata\n');
    // Explicit paths model both native notifications and adapter observations.
    monitor.observePaths([path]);
    const result = await monitor.finish();
    expect(result.incidents).toEqual([]);
    expect(aborts).toEqual([]);
    expect(existsSync(join(project, path))).toBe(true);
    expect(listProjectFilesAt(project, path)).toEqual([]);

    const next = factory({ attemptIndex: 2, attemptStartedAt: new Date().toISOString() })
      .beginInvocation(1, () => {});
    writeFileSync(join(project, 'source.txt'), 'unauthorized source edit\n');
    writeFileSync(join(project, '.gitkeep'), 'unauthorized ordinary dotfile edit\n');
    next.observePaths(['source.txt', '.gitkeep']);
    expect((await next.finish()).incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'source.txt', restored: true }),
      expect.objectContaining({ path: '.gitkeep', restored: true }),
    ]));
    expect(readFileSync(join(project, 'source.txt'), 'utf8')).toBe('original project content\n');
    expect(readFileSync(join(project, '.gitkeep'), 'utf8')).toBe('ordinary dotfile\n');
  });

  it('uses the same boundary for structured post-attempt writes', () => {
    const stage = StageConfigSchema.parse({ id: 'writer', role: 'coder', scope: [], depends_on: [] });
    const created = createRun(project, 'content-boundary', '', ['writer']);
    runPath = created.runDirPath;
    // These mutable source paths were admitted before this read-only attempt;
    // metadata notifications must not release their retained preimages.
    captureRepairRoundSnapshot(project, [{ ...stage, scope: ['source.txt', '.gitkeep'] }], { runDirPath: runPath });
    const context = createScopeBatchContext(project, [stage], undefined, created.runId);
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git/FETCH_HEAD'), 'Git metadata\n');
    writeFileSync(join(project, 'source.txt'), 'unauthorized\n');
    const audit = enforceStageScopeWrites({ projectDir: project, snapshot: context.snapshot,
      effectiveScope: [], rawWrites: ['.git/FETCH_HEAD', 'source.txt'],
      definiteWrites: new Set(['.git/FETCH_HEAD', 'source.txt']), preserveUnverifiedPath: () => false });
    expect(audit.rollbackFailures).toEqual([]);
    expect(audit.rolledBackWrites).toEqual(['source.txt']);
    expect(audit.durableWrites).toEqual([]);
    expect(readFileSync(join(project, 'source.txt'), 'utf8')).toBe('original project content\n');
  });
});
