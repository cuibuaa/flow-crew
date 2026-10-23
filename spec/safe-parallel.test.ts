import { latestAttemptWrites } from '../src/scheduler/sched_admission/frontier.js';
import { fixtureResult, declaredDispatch, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import {
  findAllReady,
  runWorkflow,
  selectRunnableBatch,
  StageConfigSchema,
  WorkflowConfigSchema,
  type StageConfig,
} from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import {
  runDir,
  type StageStatus,
  type StoreState,
  type WriteAttribution,
} from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { assertDistFresh, publishBuildOutputs } from '../src/build-manifest.js';

let projectDir: string;

function stage(input: Partial<StageConfig> & Pick<StageConfig, 'id'>): StageConfig {
  return StageConfigSchema.parse({ artifact_contract: fixtureArtifactContract(input.id, input.is_gate === true), role: 'coder', prompt_template: 'work', ...input });
}

function stateFor(stages: StageConfig[]): StoreState {
  return {
    runId: 'r', workflowName: 'w', projectDir, status: 'running',
    startedAt: new Date().toISOString(),
    stages: Object.fromEntries(stages.map((item) => [item.id, { status: 'pending', retries: 0 }])),
  };
}

function completedWithWrite(path: string, writeAttribution: WriteAttribution): StageStatus {
  return {
    status: 'complete',
    retries: 0,
    attempts: [{
      index: 1,
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:01.000Z',
      status: 'complete',
      duration_ms: 1_000,
      exitCode: 0,
      writes: [path],
      writeAttribution,
    }],
  };
}

function writeAgent(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'coder.yaml'), [
    'name: coder', 'description: test coder', 'model: default',
    'reasoning_effort: default', 'tools: []', 'prompt: test',
  ].join('\n'));
  return agentsDir;
}

async function runStatic(
  scopes: [string[], string[]],
  reportedWrites: string[] | ((stageId: string) => string[]) = [],
  mutate?: (stageId: string, opts: RunOpts) => void,
  contracts: Parameters<typeof declaredDispatch>[1] = {},
) {
  const yaml = [
    'name: scope-test',
    'defaults:',
    '  max_iterations: 1',
    'stages:',
    '  - id: left',
    '    role: coder',
    `    scope: ${JSON.stringify(scopes[0])}`,
    '  - id: right',
    '    role: coder',
    `    scope: ${JSON.stringify(scopes[1])}`,
  ].join('\n');
  const workflow = WorkflowConfigSchema.parse(parseYaml(declaredDispatch(yaml, contracts)));
  const created = createRun(projectDir, workflow.name, yaml, workflow.stages.map((item) => item.id));
  writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
  let active = 0;
  let maxActive = 0;
  const adapter: Adapter = {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') return fixtureResult({ output: '## What was done\n- summarized', exitCode: 0, duration_ms: 1 }, opts);
      active++;
      maxActive = Math.max(maxActive, active);
      mutate?.(opts.stageId, opts);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return fixtureResult({
        output: opts.stageId,
        exitCode: 0,
        duration_ms: 25,
        writes: typeof reportedWrites === 'function' ? reportedWrites(opts.stageId) : reportedWrites,
        writeAttribution: 'structured',
      }, opts);
    },
  };
  const final = await runWorkflow(workflow, yaml, projectDir, adapter, new Map(), undefined, writeAgent(), created.runId);
  return { final, maxActive, events: readRunEvents(projectDir, created.runId) };
}

async function runPhysicalWriteScenario(mode: 'one-writer' | 'two-writers') {
  const sharedPath = 'src/shared.ts';
  const scopes: [string[], string[]] = mode === 'one-writer'
    ? [[sharedPath], []]
    : [['src/left.ts'], ['src/right.ts']];
  const yaml = [
    'name: physical-write-test',
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: left',
    '    role: coder',
    `    scope: ${JSON.stringify(scopes[0])}`,
    '  - id: right',
    '    role: coder',
    `    scope: ${JSON.stringify(scopes[1])}`,
  ].join('\n');
  const workflow = WorkflowConfigSchema.parse(parseYaml(declaredDispatch(yaml)));
  const created = createRun(projectDir, workflow.name, yaml, workflow.stages.map((item) => item.id));
  writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
  mkdirSync(join(projectDir, 'src'), { recursive: true });

  let active = 0;
  let maxActive = 0;
  let markWriterDone!: () => void;
  let markObserverDone!: () => void;
  let observerSawWrite = false;
  const writerDone = new Promise<void>((resolve) => { markWriterDone = resolve; });
  const observerDone = new Promise<void>((resolve) => { markObserverDone = resolve; });
  let markWritersArrived!: () => void;
  let writerArrivals = 0;
  const writersArrived = new Promise<void>((resolve) => { markWritersArrived = resolve; });
  const physicalWriteCalls = { left: 0, right: 0 };

  const adapter: Adapter = {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') {
        return fixtureResult({ output: '## What was done\n- summarized', exitCode: 0, duration_ms: 1 }, opts);
      }
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (mode === 'one-writer') {
          if (opts.stageId === 'left') {
            physicalWriteCalls.left++;
            writeFileSync(join(projectDir, sharedPath), 'export const source = "left";\n');
            markWriterDone();
            return fixtureResult({
              output: 'left wrote', exitCode: 0, duration_ms: 1,
              writes: [sharedPath], writeAttribution: 'structured',
            }, opts);
          }
          await writerDone;
          observerSawWrite = existsSync(join(projectDir, sharedPath));
          markObserverDone();
          return fixtureResult({
            output: 'right observed without writing', exitCode: 0, duration_ms: 1,
            writeAttribution: 'unknown',
          }, opts);
        }

        physicalWriteCalls[opts.stageId as 'left' | 'right']++;
        if (physicalWriteCalls[opts.stageId as 'left' | 'right'] === 1) {
          writerArrivals++;
          if (writerArrivals === 2) markWritersArrived();
        }
        writeFileSync(join(projectDir, sharedPath), `export const source = "${opts.stageId}";\n`);
        return fixtureResult({
          output: `${opts.stageId} wrote`, exitCode: 0, duration_ms: 1,
          writes: [sharedPath], writeAttribution: 'structured',
        }, opts);
      } finally {
        active--;
      }
    },
  };
  const final = await runWorkflow(workflow, yaml, projectDir, adapter, new Map(), undefined, writeAgent(), created.runId);
  return {
    final,
    maxActive,
    observerSawWrite,
    physicalWriteCalls,
    events: readRunEvents(projectDir, created.runId),
    sharedPath,
  };
}

beforeEach(() => {
  projectDir = join(tmpdir(), `flowcrew-e6-parallel-${randomBytes(6).toString('hex')}`);
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

describe('safe scope batching', () => {
  it('serializes shared-tree authors even when build outputs are private', async () => {
    mkdirSync(join(projectDir, 'src'));
    mkdirSync(join(projectDir, 'dist'));
    writeFileSync(join(projectDir, 'tsconfig.json'), '{}');
    writeFileSync(join(projectDir, 'dist/served.js'), 'serving generation');
    for (const id of ['left', 'right']) writeFileSync(join(projectDir, `src/${id}.ts`), `export const ${id} = 0;`);
    const destinations: string[] = [];
    const contracts = Object.fromEntries(['left', 'right'].map(id => [id, {
      version: 1 as const, produces: [
        { id: 'build', root: 'run' as const, path: `stages/${id}/build`, kind: 'directory' as const },
        { id: 'published', root: 'run' as const, path: `stages/${id}/build/dist`, kind: 'directory' as const },
      ],
      reads: [],
    }]));
    const measured = await runStatic([['src/left.ts'], ['src/right.ts']], id => [`src/${id}.ts`], (id, opts) => {
      writeFileSync(join(projectDir, `src/${id}.ts`), `export const ${id} = 1;`);
      const outputRoot = join(opts.runDir, 'stages', id, 'build');
      const stagedDistDir = join(outputRoot, 'staged');
      mkdirSync(stagedDistDir, { recursive: true });
      for (const name of ['left', 'right']) {
        writeFileSync(join(stagedDistDir, `${name}.js`), readFileSync(join(projectDir, `src/${name}.ts`)));
        writeFileSync(join(stagedDistDir, `${name}.d.ts`), `export declare const ${name}: number;`);
      }
      const distDir = join(outputRoot, 'dist');
      publishBuildOutputs({ projectRoot: projectDir, stagedDistDir, distDir });
      destinations.push(distDir);
    }, contracts);
    expect(measured.final.status).toBe('complete');
    expect(measured.maxActive).toBe(1);
    expect(new Set(destinations).size).toBe(2);
    expect(readFileSync(join(destinations[0], 'left.js'), 'utf8')).toBe('export const left = 1;');
    expect(readFileSync(join(destinations[1], 'right.js'), 'utf8')).toBe('export const right = 1;');
    expect(assertDistFresh(projectDir, destinations[1]).outputs).toHaveLength(4);
    expect(readFileSync(join(projectDir, 'dist/served.js'), 'utf8')).toBe('serving generation');
    expect(measured.events.some(event => event.type === 'parallel_scope_serialized')).toBe(true);
    expect(selectRunnableBatch([
      stage({ id: 'left', scope: ['src/left.ts', 'dist/'] }),
      stage({ id: 'right', scope: ['src/right.ts', 'dist/'] }),
    ]).selected).toHaveLength(1);
  });

  it('H3a serializes all authors while accepting required writes outside their estimates', async () => {
    const ownPath = 'a/round_1/control/owned.txt';
    const peerPath = 'a/round_1/arms/x/escaped.txt';
    const disjoint = await runStatic([
      ['a/round_*/control/**'],
      ['a/round_*/arms/x/**'],
    ]);
    expect(disjoint.final.status).toBe('complete');
    expect(disjoint.maxActive).toBe(1);
    expect(disjoint.events.some((event) => event.type === 'parallel_scope_serialized')).toBe(true);

    const guarded = await runStatic([
      ['a/round_*/control/**'],
      ['a/round_*/arms/x/**'],
    ], (stageId) => stageId === 'left' ? [ownPath, peerPath] : [], (stageId) => {
      if (stageId !== 'left') return;
      mkdirSync(join(projectDir, 'a', 'round_1', 'control'), { recursive: true });
      mkdirSync(join(projectDir, 'a', 'round_1', 'arms', 'x'), { recursive: true });
      writeFileSync(join(projectDir, ownPath), 'owned by control\n');
      writeFileSync(join(projectDir, peerPath), 'must be reverted\n');
    });
    expect(guarded.maxActive).toBe(1);
    expect(existsSync(join(projectDir, ownPath))).toBe(true);
    expect(existsSync(join(projectDir, peerPath))).toBe(true);
    expect(guarded.final.status).toBe('complete');
    expect(guarded.final.stages.left.constraintAudit).toMatchObject({ violationCount: 0 });

    const overlapping = await runStatic([
      ['a/round_*/arms/**'],
      ['a/round_*/arms/x/**'],
    ]);
    expect(overlapping.final.status).toBe('complete');
    expect(overlapping.maxActive).toBe(1);
    expect(overlapping.events.some((event) => event.type === 'parallel_scope_serialized')).toBe(true);
  });

  it('A2 serializes disjoint and overlapping estimates through the same frontier', async () => {
    const stages = [
      stage({ id: 'left', scope: ['src/left.ts'] }),
      stage({ id: 'right', scope: ['spec/right/**'] }),
    ];
    const ready = findAllReady(stages, stateFor(stages));
    expect(ready).toHaveLength(2);
    expect(selectRunnableBatch(ready).selected.map((item) => item.id)).toEqual(['left']);

    const measured = await runStatic([['src/left.ts'], ['spec/right/**']]);
    expect(measured.final.status).toBe('complete');
    expect(measured.maxActive).toBe(1);

    const serialized = await runStatic([['src/shared/**'], ['src/shared/file.ts']]);
    expect(serialized.final.status).toBe('complete');
    expect(serialized.maxActive).toBe(1);
    expect(serialized.events.some((event) => (
      event.type === 'parallel_scope_serialized' && event.detail?.includes('right deferred')
    ))).toBe(true);
  });

  it('serializes overlapping scopes and records the reason without failing the run', async () => {
    const stages = [
      stage({ id: 'left', scope: ['src/shared/**'] }),
      stage({ id: 'right', scope: ['src/shared/file.ts'] }),
    ];
    const batch = selectRunnableBatch(stages);
    expect(batch.selected.map((item) => item.id)).toEqual(['left']);
    expect(batch.deferred[0].conflict.reason).toContain('mutable project tree');

    const measured = await runStatic([['src/shared/**'], ['src/shared/file.ts']]);
    expect(measured.final.status).toBe('complete');
    expect(measured.maxActive).toBe(1);
    expect(measured.events.some((event) => event.type === 'parallel_scope_serialized' && event.detail?.includes('right deferred'))).toBe(true);
  });

  it('conservatively serializes an unmarked directory ancestor without conflating sibling names', () => {
    const nested = selectRunnableBatch([
      stage({ id: 'directory', scope: ['src'] }),
      stage({ id: 'child', scope: ['src/child.ts'] }),
    ]);
    expect(nested.selected.map((item) => item.id)).toEqual(['directory']);
    expect(nested.deferred[0].conflict.reason).toContain('mutable project tree');

    const siblings = selectRunnableBatch([
      stage({ id: 'backend', scope: ['src'] }),
      stage({ id: 'frontend', scope: ['src-ui/child.ts'] }),
    ]);
    expect(siblings.selected.map((item) => item.id)).toEqual(['backend']);
    expect(siblings.deferred).toHaveLength(1);
  });

  it('canonicalizes explicit directory and dot-segment aliases without conflating path-segment siblings', () => {
    for (const directoryScope of ['packages/core/', './packages/core/.']) {
      const nested = selectRunnableBatch([
        stage({ id: 'directory', scope: [directoryScope] }),
        stage({ id: 'child', scope: ['packages/core/index.ts'] }),
      ]);
      expect(nested.selected.map((item) => item.id)).toEqual(['directory']);
      expect(nested.deferred).toHaveLength(1);
    }

    const equivalent = selectRunnableBatch([
      stage({ id: 'explicit', scope: ['packages/core/'] }),
      stage({ id: 'bare', scope: ['packages/core'] }),
    ]);
    expect(equivalent.selected.map((item) => item.id)).toEqual(['explicit']);
    expect(equivalent.deferred).toHaveLength(1);

    const siblings = selectRunnableBatch([
      stage({ id: 'core', scope: ['packages/core/.'] }),
      stage({ id: 'core_ui', scope: ['packages/core-ui/index.ts'] }),
    ]);
    expect(siblings.selected.map((item) => item.id)).toEqual(['core']);
    expect(siblings.deferred).toHaveLength(1);
  });

  it('admits an empty-scope observer after a writer without claiming the peer write', async () => {
    const measured = await runPhysicalWriteScenario('one-writer');
    const warnings = measured.events.filter((event) => event.type === 'parallel_write_conflict');
    const leftAttempt = measured.final.stages.left.attempts?.at(-1);
    const rightAttempt = measured.final.stages.right.attempts?.at(-1);

    expect(measured.maxActive).toBe(1);
    expect(measured.physicalWriteCalls).toEqual({ left: 1, right: 0 });
    expect(measured.observerSawWrite).toBe(true);
    expect(leftAttempt).toMatchObject({ writes: [measured.sharedPath], writeAttribution: 'structured' });
    expect(rightAttempt).toMatchObject({
      writes: [],
      writeAttribution: 'snapshot',
      constraintAudit: { appliedWriteCount: 0 },
    });
    expect(warnings).toEqual([]);
    expect(measured.final.status).toBe('complete');
  });

  it('accepts sequential authors of the same path without a false parallel conflict', async () => {
    const measured = await runPhysicalWriteScenario('two-writers');
    const warning = measured.events.find((event) => event.type === 'parallel_write_conflict');

    expect(measured.maxActive).toBe(1);
    expect(measured.physicalWriteCalls).toEqual({ left: 1, right: 1 });
    expect(measured.final.stages.left.attempts?.at(-1)).toMatchObject({
      writes: [measured.sharedPath], writeAttribution: 'structured',
    });
    expect(measured.final.stages.right.attempts?.at(-1)).toMatchObject({
      writes: [measured.sharedPath], writeAttribution: 'structured',
    });
    expect(warning).toBeUndefined();
    expect(measured.final.status).toBe('complete');
    expect(measured.final.stages.left.constraintAudit).toMatchObject({ violationCount: 0 });
    expect(measured.final.stages.right.constraintAudit).toMatchObject({ violationCount: 0 });
  });

  it('retains factual external-path observations without inventing a concurrent conflict', async () => {
    const reported = '../fc-home/runs/example/./notes.json';
    const canonical = '../fc-home/runs/example/notes.json';
    const measured = await runStatic([['src/left.ts'], ['src/right.ts']], [reported]);
    const warning = measured.events.find((event) => event.type === 'parallel_write_conflict');
    expect(measured.maxActive).toBe(1);
    expect(warning).toBeUndefined();
    expect(measured.final.status).toBe('complete');
    expect(latestAttemptWrites(completedWithWrite(reported, 'structured'))).toEqual({ files: [canonical], attribution: 'structured' });
  });

  it.each(['structured', 'snapshot', 'unknown'] as const)('retains factual observations without upgrading %s attribution', attribution => {
    expect(latestAttemptWrites(completedWithWrite('./src/area/../shared.ts', attribution)))
      .toEqual({ files: ['src/shared.ts'], attribution });
    const legacy = completedWithWrite('src/shared.ts', attribution);
    delete legacy.attempts?.[0].writeAttribution;
    expect(latestAttemptWrites(legacy)).toEqual({ files: ['src/shared.ts'], attribution: 'unknown' });
  });

  it('keeps a linear DAG one-stage-at-a-time', () => {
    const stages = [
      stage({ id: 'a', scope: ['a.ts'] }),
      stage({ id: 'b', depends_on: ['a'], scope: ['b.ts'] }),
      stage({ id: 'c', depends_on: ['b'], scope: ['c.ts'] }),
    ];
    const state = stateFor(stages);
    expect(findAllReady(stages, state).map((item) => item.id)).toEqual(['a']);
    state.stages.a = { status: 'complete', retries: 0 };
    expect(findAllReady(stages, state).map((item) => item.id)).toEqual(['b']);
    state.stages.b = { status: 'complete', retries: 0 };
    expect(findAllReady(stages, state).map((item) => item.id)).toEqual(['c']);
  });
});
