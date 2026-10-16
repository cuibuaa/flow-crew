import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { StageConfigSchema, type StageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { createScopeBatchContext, type ScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { createLiveGuardFactory, enforceStageScopeWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { createRun, fcGlobalDir, setFcGlobalDir } from '../src/store.js';

const docsPath = 'docs/runner_minimal/evidence/reference_hashes.json';
const srcPath = 'src/main.ts';
const original = '{"reference":"original"}\n';
const docsStage = StageConfigSchema.parse({ id: 'fix_tools', role: 'coder', scope: ['docs'] });
const srcStage = StageConfigSchema.parse({ id: 'fix_perf', role: 'coder', scope: ['src'] });
let root: string;
let project: string;
let previousState: string;
let runPath: string;
let runId: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-baseline-resettle-'));
  project = join(root, 'project');
  previousState = fcGlobalDir();
  setFcGlobalDir(join(root, 'state'));
  for (const path of [docsPath, srcPath]) mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, docsPath), original, { mode: 0o644 });
  writeFileSync(join(project, srcPath), 'export const original = true;\n', { mode: 0o644 });
  const git = (args: string[]) => isolatedProjectCommand('git', args, project, root);
  git(['init', '-q']);
  git(['add', docsPath, srcPath]);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const created = createRun(project, 'baseline follows admitted writes', '', [docsStage.id, srcStage.id]);
  runPath = created.runDirPath;
  runId = created.runId;
});

afterEach(() => {
  closeRollbackBaseline(project, runPath);
  setFcGlobalDir(previousState);
  rmSync(root, { recursive: true, force: true });
});

function guard(context: ScopeBatchContext, stage: StageConfig) {
  const factory = createLiveGuardFactory().createSchedulerLiveConstraintGuardFactory({
    stage, projectDir: project, runId, context,
  })!;
  return factory({ attemptIndex: 1, attemptStartedAt: new Date().toISOString() });
}

async function settleAdmittedWrite() {
  const context = createScopeBatchContext(project, [docsStage], undefined, runId);
  const writer = guard(context, docsStage);
  const first = writer.beginInvocation(1, () => {});
  writeFileSync(join(project, docsPath), '{"reference":"updated"}\n');
  first.observePaths([docsPath]);
  expect((await first.finish()).incidents).toEqual([]);
  return { context, writer };
}

async function reconcileNextBatch() {
  const context = createScopeBatchContext(project, [srcStage], undefined, runId);
  expect(context.snapshot.files.has(docsPath)).toBe(false);
  const writer = guard(context, srcStage);
  const next = writer.beginInvocation(1, () => {});
  // finish performs full reconciliation even without an observed write.
  expect((await next.finish()).incidents).toEqual([]);
  expect(readFileSync(join(project, docsPath), 'utf8')).toBe(original);
  return writer;
}

describe('rollback baseline follows admitted writes', () => {
  it('follows a live admitted writer back to the batch preimage', async () => {
    const { writer } = await settleAdmittedWrite();
    const second = writer.beginInvocation(2, () => {});
    writeFileSync(join(project, docsPath), original);
    second.observePaths([docsPath]);
    expect((await second.finish()).incidents).toEqual([]);

    const nextWriter = await reconcileNextBatch();
    const trespass = nextWriter.beginInvocation(2, () => {});
    writeFileSync(join(project, docsPath), '{"reference":"unauthorized"}\n');
    trespass.observePaths([docsPath]);
    expect((await trespass.finish()).incidents).toContainEqual(expect.objectContaining({
      path: docsPath, changeObserved: true,
    }));
  });

  it('follows an audited admitted writer back to the batch preimage', async () => {
    const { context } = await settleAdmittedWrite();
    // No live invocation observes the return, so only the audit can resettle it.
    writeFileSync(join(project, docsPath), original);
    const audit = enforceStageScopeWrites({
      projectDir: project, snapshot: context.snapshot, effectiveScope: docsStage.scope!,
      rawWrites: [docsPath], definiteWrites: new Set([docsPath]), preserveUnverifiedPath: () => false,
    });
    expect(audit).toEqual({
      rawWrites: [docsPath], unauthorizedWrites: [], appliedWrites: [], exemptedWrites: [],
      rolledBackWrites: [], rollbackFailures: [], rollbackFailureReasons: {}, durableWrites: [],
    });

    await reconcileNextBatch();
  });
});
