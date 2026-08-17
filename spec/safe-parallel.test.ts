import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import {
  detectParallelWriteConflicts,
  findAllReady,
  runWorkflow,
  selectRunnableBatch,
  StageConfigSchema,
  WorkflowConfigSchema,
  type StageConfig,
} from '../src/scheduler.js';
import {
  createRun,
  runDir,
  type StageStatus,
  type StoreState,
  type WriteAttribution,
} from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';

let projectDir: string;

function stage(input: Partial<StageConfig> & Pick<StageConfig, 'id'>): StageConfig {
  return StageConfigSchema.parse({ role: 'coder', prompt_template: 'work', ...input });
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

async function runStatic(scopes: [string[], string[]], reportedWrites: string[] = []) {
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
  const workflow = WorkflowConfigSchema.parse(parseYaml(yaml));
  const created = createRun(projectDir, workflow.name, yaml, workflow.stages.map((item) => item.id));
  writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
  let active = 0;
  let maxActive = 0;
  const adapter: Adapter = {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') return { output: '## What was done\n- summarized', exitCode: 0, duration_ms: 1 };
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return { output: opts.stageId, exitCode: 0, duration_ms: 25, writes: reportedWrites, writeAttribution: 'structured' };
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
  const workflow = WorkflowConfigSchema.parse(parseYaml(yaml));
  const created = createRun(projectDir, workflow.name, yaml, workflow.stages.map((item) => item.id));
  writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));
  mkdirSync(join(projectDir, 'src'), { recursive: true });

  let active = 0;
  let maxActive = 0;
  let entered = 0;
  let releaseBoth!: () => void;
  let markWriterDone!: () => void;
  let markObserverSawWrite!: () => void;
  let observerSawWrite = false;
  const bothEntered = new Promise<void>((resolve) => { releaseBoth = resolve; });
  const writerDone = new Promise<void>((resolve) => { markWriterDone = resolve; });
  const observerSawWritePromise = new Promise<void>((resolve) => { markObserverSawWrite = resolve; });
  const physicalWriteCalls = { left: 0, right: 0 };

  const adapter: Adapter = {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === '_summary') {
        return { output: '## What was done\n- summarized', exitCode: 0, duration_ms: 1 };
      }
      active++;
      maxActive = Math.max(maxActive, active);
      entered++;
      if (entered === 2) releaseBoth();
      await bothEntered;
      try {
        if (mode === 'one-writer') {
          if (opts.stageId === 'left') {
            physicalWriteCalls.left++;
            writeFileSync(join(projectDir, sharedPath), 'export const source = "left";\n');
            markWriterDone();
            await observerSawWritePromise;
            return {
              output: 'left wrote', exitCode: 0, duration_ms: 1,
              writes: [sharedPath], writeAttribution: 'structured',
            };
          }
          await writerDone;
          observerSawWrite = existsSync(join(projectDir, sharedPath));
          markObserverSawWrite();
          return {
            output: 'right observed without writing', exitCode: 0, duration_ms: 1,
            writeAttribution: 'unknown',
          };
        }

        physicalWriteCalls[opts.stageId as 'left' | 'right']++;
        writeFileSync(join(projectDir, sharedPath), `export const source = "${opts.stageId}";\n`);
        return {
          output: `${opts.stageId} wrote`, exitCode: 0, duration_ms: 1,
          writes: [sharedPath], writeAttribution: 'structured',
        };
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
  it('admits both independent ready stages into the same batch', async () => {
    const stages = [
      stage({ id: 'left', scope: ['src/left.ts'] }),
      stage({ id: 'right', scope: ['spec/right/**'] }),
    ];
    const ready = findAllReady(stages, stateFor(stages));
    expect(ready).toHaveLength(2);
    expect(selectRunnableBatch(ready).selected.map((item) => item.id)).toEqual(['left', 'right']);

    const measured = await runStatic([['src/left.ts'], ['spec/right/**']]);
    expect(measured.final.status).toBe('complete');
    expect(measured.maxActive).toBe(2);
  });

  it('serializes overlapping scopes and records the reason without failing the run', async () => {
    const stages = [
      stage({ id: 'left', scope: ['src/shared/**'] }),
      stage({ id: 'right', scope: ['src/shared/file.ts'] }),
    ];
    const batch = selectRunnableBatch(stages);
    expect(batch.selected.map((item) => item.id)).toEqual(['left']);
    expect(batch.deferred[0].conflict.reason).toContain('may overlap');

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
    expect(nested.deferred[0].conflict.reason).toContain('may overlap');

    const siblings = selectRunnableBatch([
      stage({ id: 'backend', scope: ['src'] }),
      stage({ id: 'frontend', scope: ['src-ui/child.ts'] }),
    ]);
    expect(siblings.selected.map((item) => item.id)).toEqual(['backend', 'frontend']);
    expect(siblings.deferred).toEqual([]);
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
    expect(siblings.selected.map((item) => item.id)).toEqual(['core', 'core_ui']);
    expect(siblings.deferred).toEqual([]);
  });

  it('does not claim that a snapshot observer co-wrote its concurrent peer\'s physical write', async () => {
    const measured = await runPhysicalWriteScenario('one-writer');
    const warnings = measured.events.filter((event) => event.type === 'parallel_write_conflict');
    const leftAttempt = measured.final.stages.left.attempts?.at(-1);
    const rightAttempt = measured.final.stages.right.attempts?.at(-1);

    expect(measured.maxActive).toBe(2);
    expect(measured.physicalWriteCalls).toEqual({ left: 1, right: 0 });
    expect(measured.observerSawWrite).toBe(true);
    expect(leftAttempt).toMatchObject({ writes: [measured.sharedPath], writeAttribution: 'structured' });
    expect(rightAttempt).toMatchObject({
      writes: [measured.sharedPath],
      writeAttribution: 'snapshot',
      constraintAudit: { appliedWriteCount: 0 },
    });
    expect(warnings).toEqual([]);
    expect(measured.final.status).toBe('complete');
  });

  it('warns when two concurrent adapters physically write and structurally report the same file', async () => {
    const measured = await runPhysicalWriteScenario('two-writers');
    const warning = measured.events.find((event) => event.type === 'parallel_write_conflict');

    expect(measured.maxActive).toBe(2);
    expect(measured.physicalWriteCalls).toEqual({ left: 1, right: 1 });
    expect(measured.final.stages.left.attempts?.at(-1)).toMatchObject({
      writes: [measured.sharedPath], writeAttribution: 'structured',
    });
    expect(measured.final.stages.right.attempts?.at(-1)).toMatchObject({
      writes: [measured.sharedPath], writeAttribution: 'structured',
    });
    expect(warning).toMatchObject({
      level: 'warning', stageIds: ['left', 'right'], files: [measured.sharedPath],
    });
    expect(warning?.detail).toContain('attribution: structured / structured');
    expect(measured.final.status).toBe('failed');
    expect(measured.final.stages.left.constraintAudit).toMatchObject({ violationCount: 1 });
    expect(measured.final.stages.right.constraintAudit).toMatchObject({ violationCount: 1 });
  });

  it('preserves an identical ../ factual write in both the event and summary warning', async () => {
    const reported = '../fc-home/runs/example/./knowledge_graph.json';
    const canonical = '../fc-home/runs/example/knowledge_graph.json';
    const measured = await runStatic([['src/left.ts'], ['src/right.ts']], [reported]);
    const warning = measured.events.find((event) => event.type === 'parallel_write_conflict');
    expect(measured.maxActive).toBe(2);
    expect(warning).toMatchObject({
      level: 'warning',
      stageIds: ['left', 'right'],
      files: [canonical],
    });
    expect(measured.final.status).toBe('failed');
    expect(measured.final.stages.left.error).toContain('scope_violation');
    expect(measured.final.stages.right.error).toContain('scope_violation');
  });

  it('requires structured evidence from both sides across every attribution pairing', () => {
    const shared = '../fc-home/runs/example/knowledge_graph.json';
    const attributions: WriteAttribution[] = ['structured', 'snapshot', 'unknown'];
    const outcomes: Record<string, string[]> = {};
    for (const leftAttribution of attributions) {
      for (const rightAttribution of attributions) {
        outcomes[`${leftAttribution}/${rightAttribution}`] = detectParallelWriteConflicts(
          ['left', 'right'],
          {
            left: completedWithWrite(shared, leftAttribution),
            right: completedWithWrite(shared, rightAttribution),
          },
        ).flatMap((conflict) => conflict.files);
      }
    }

    expect(outcomes).toEqual({
      'structured/structured': [shared],
      'structured/snapshot': [],
      'structured/unknown': [],
      'snapshot/structured': [],
      'snapshot/snapshot': [],
      'snapshot/unknown': [],
      'unknown/structured': [],
      'unknown/snapshot': [],
      'unknown/unknown': [],
    });

    const legacyUnknown = completedWithWrite(shared, 'unknown');
    delete legacyUnknown.attempts?.[0].writeAttribution;
    expect(detectParallelWriteConflicts(['left', 'right'], {
      left: completedWithWrite(shared, 'structured'),
      right: legacyUnknown,
    })).toEqual([]);
  });

  it('retains path normalization and ignores disjoint structured writes', () => {
    expect(detectParallelWriteConflicts(['left', 'right'], {
      left: completedWithWrite('./src/area/../shared.ts', 'structured'),
      right: completedWithWrite('src/shared.ts', 'structured'),
    })).toEqual([{
      stageIds: ['left', 'right'],
      files: ['src/shared.ts'],
      attribution: ['structured', 'structured'],
    }]);

    expect(detectParallelWriteConflicts(['left', 'right'], {
      left: completedWithWrite('src/left.ts', 'structured'),
      right: completedWithWrite('src/right.ts', 'structured'),
    })).toEqual([]);
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
