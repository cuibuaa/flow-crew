import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import {
  LiveConstraintGuard,
  type LiveConstraintGuardFactory,
} from '../src/live-constraint-guard.js';
import { readRunEvents } from '../src/run-events.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readStageStatus,
  runDir,
  setFcGlobalDir,
} from '../src/store.js';
import { runStage } from '../src/worker.js';

let projectDir: string;
let stateDir: string;
let previousStateDir: string;

function seedProject(): string {
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 10000\n');
  writeFileSync(join(projectDir, 'config', 'agents', 'coder.yaml'), [
    'name: coder',
    'description: parallel lease fixture',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: fixture',
  ].join('\n'));
  const protectedPath = join(projectDir, 'protected.txt');
  writeFileSync(protectedPath, 'operator preimage\n');
  return protectedPath;
}

function role(): AgentConfig {
  return {
    name: 'coder',
    description: 'parallel lease fixture',
    model: 'default',
    reasoning_effort: 'low',
    tools: [],
    prompt: 'fixture',
  };
}

function noOpGuardFactory(
  runDirectory: string,
  stageId: string,
  writerLease: { batchId: string; partitionId: string; ownerStageId: string },
): LiveConstraintGuardFactory {
  return Object.assign(
    (({ attemptIndex }) => new LiveConstraintGuard({
      projectDir,
      runDir: runDirectory,
      stageId,
      attemptIndex,
      effectiveScope: () => ['src/shared.ts'],
      scanAndRestore: () => ({ scannedPaths: 0, violations: [] }),
      scopeRevisionInstruction: () => 'unused',
      watchProject: () => undefined,
    })) as LiveConstraintGuardFactory,
    { writerLease },
  );
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-parallel-lease-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'flowcrew-parallel-lease-state-'));
  previousStateDir = fcGlobalDir();
  setFcGlobalDir(stateDir);
});

afterEach(() => {
  setFcGlobalDir(previousStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('scheduler-proven parallel writer leases', () => {
  it('A1 runs two explicit empty-scope stages concurrently and restores/attributes an unauthorized write', { timeout: 15_000 }, async () => {
    const protectedPath = seedProject();
    const preimage = readFileSync(protectedPath, 'utf-8');
    const workflow: WorkflowConfig = {
      name: 'readonly-parallel',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [
        { id: 'readonly_left', role: 'coder', depends_on: [], scope: [], prompt_template: 'inspect', skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [] },
        { id: 'readonly_right', role: 'coder', depends_on: [], scope: [], prompt_template: 'inspect', skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [] },
      ],
    };
    const yaml = [
      'name: readonly-parallel',
      'defaults:',
      '  max_iterations: 1',
      '  max_retries: 0',
      'stages:',
      '  - id: readonly_left',
      '    role: coder',
      '    scope: []',
      '  - id: readonly_right',
      '    role: coder',
      '    scope: []',
    ].join('\n');
    const created = createRun(projectDir, workflow.name, yaml, workflow.stages.map((stage) => stage.id));
    writeFileSync(join(runDir(projectDir, created.runId), 'scheduler.pid'), String(process.pid));

    let active = 0;
    let maxActive = 0;
    let arrivals = 0;
    let releaseArrivals!: () => void;
    const bothArrived = new Promise<void>((resolvePromise) => { releaseArrivals = resolvePromise; });
    const invocationIntervals: Record<string, Array<{ start: number; end: number }>> = {
      readonly_left: [],
      readonly_right: [],
    };
    let physicalWrites = 0;

    const adapter: Adapter = {
      async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') {
          return { output: '## What was done\n- summarized', exitCode: 0, duration_ms: 1 };
        }
        const interval = { start: Date.now(), end: 0 };
        invocationIntervals[opts.stageId].push(interval);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (invocationIntervals[opts.stageId].length === 1) {
            arrivals++;
            if (arrivals === 2) releaseArrivals();
            // The timeout keeps the baseline implementation (which serializes
            // before attempt start) observable instead of deadlocking the test.
            await Promise.race([
              bothArrived,
              new Promise((resolvePromise) => setTimeout(resolvePromise, 75)),
            ]);
            if (opts.stageId === 'readonly_left') {
              physicalWrites++;
              writeFileSync(protectedPath, 'unauthorized adapter write\n');
              const deadline = Date.now() + 2_000;
              while (Date.now() < deadline && readFileSync(protectedPath, 'utf-8') !== preimage) {
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
              }
            } else {
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
            }
          }
          return {
            output: `${opts.stageId} invocation finished`,
            exitCode: 0,
            duration_ms: Date.now() - interval.start,
            ...(opts.stageId === 'readonly_left' && physicalWrites === 1
              ? { writes: ['protected.txt'], writeAttribution: 'structured' as const }
              : { writeAttribution: 'unknown' as const }),
          };
        } finally {
          interval.end = Date.now();
          active--;
        }
      },
    };

    const final = await runWorkflow(
      workflow,
      yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      join(projectDir, 'config', 'agents'),
      created.runId,
    );

    expect(final.status).toBe('complete');
    expect(maxActive).toBe(2);
    expect(physicalWrites).toBe(1);
    expect(readFileSync(protectedPath, 'utf-8')).toBe(preimage);
    const leftAttempt = final.stages.readonly_left.attempts?.at(-1);
    const rightAttempt = final.stages.readonly_right.attempts?.at(-1);
    expect(leftAttempt).toBeDefined();
    expect(rightAttempt).toBeDefined();
    expect(Date.parse(leftAttempt!.startedAt)).toBeLessThan(Date.parse(rightAttempt!.completedAt!));
    expect(Date.parse(rightAttempt!.startedAt)).toBeLessThan(Date.parse(leftAttempt!.completedAt!));
    for (const stageId of ['readonly_left', 'readonly_right']) {
      const status = final.stages[stageId];
      expect(status.constraintAudit).toMatchObject({ violationCount: 1, liveRestoredCount: 1 });
      const audit = JSON.parse(readFileSync(join(created.runDirPath, status.constraintAudit!.path), 'utf-8')) as {
        liveIncidents: Array<{ path: string; restored: boolean }>;
        violations: Array<{ path: string; resolution?: string }>;
      };
      expect(audit.liveIncidents).toContainEqual(expect.objectContaining({ path: 'protected.txt', restored: true }));
      expect(audit.violations).toContainEqual(expect.objectContaining({ path: 'protected.txt', resolution: 'live_reverted' }));
    }
  });

  it('A3 journals the lease blocker and wait duration', { timeout: 10_000 }, async () => {
    seedProject();
    const created = createRun(projectDir, 'lease-wait-events', 'name: lease-wait-events\nstages: []\n', ['lease_owner', 'lease_waiter']);
    let ownerEntered!: () => void;
    let releaseOwner!: () => void;
    const entered = new Promise<void>((resolvePromise) => { ownerEntered = resolvePromise; });
    const held = new Promise<void>((resolvePromise) => { releaseOwner = resolvePromise; });
    const adapter: Adapter = {
      async run(_prompt, _role, opts) {
        if (opts.stageId === 'lease_owner') {
          ownerEntered();
          await held;
        }
        return { output: opts.stageId, exitCode: 0, duration_ms: 1 };
      },
    };
    const common = {
      role: role(),
      dependsOn: [],
      promptTemplate: 'hold the same writer partition',
      timeout_ms: 5_000,
      projectDir,
      runId: created.runId,
      runDir: created.runDirPath,
      retries: 0,
      projectWriteScope: ['src/shared.ts'],
    };
    const batchId = `test-batch-${randomBytes(4).toString('hex')}`;
    const owner = runStage(adapter, {
      ...common,
      stageId: 'lease_owner',
      liveConstraintGuardFactory: noOpGuardFactory(created.runDirPath, 'lease_owner', {
        batchId, partitionId: 'shared-scope', ownerStageId: 'lease_owner',
      }),
    });
    await entered;
    const waiter = runStage(adapter, {
      ...common,
      stageId: 'lease_waiter',
      liveConstraintGuardFactory: noOpGuardFactory(created.runDirPath, 'lease_waiter', {
        batchId, partitionId: 'shared-scope', ownerStageId: 'lease_waiter',
      }),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    releaseOwner();
    await Promise.all([owner, waiter]);

    const events = readRunEvents(projectDir, created.runId) as Array<Record<string, unknown>>;
    expect(events.find((event) => event.type === 'writer_lease_wait_started')).toMatchObject({
      stageId: 'lease_waiter',
      blockedByStageId: 'lease_owner',
      leasePartition: 'shared-scope',
    });
    expect(events.find((event) => event.type === 'writer_lease_wait_finished')).toMatchObject({
      stageId: 'lease_waiter',
      blockedByStageId: 'lease_owner',
      leasePartition: 'shared-scope',
    });
    const finished = events.find((event) => event.type === 'writer_lease_wait_finished');
    expect(finished?.waitedMs).toBeTypeOf('number');
    expect(Number(finished?.waitedMs)).toBeGreaterThanOrEqual(20);
    expect(readStageStatus(projectDir, created.runId, 'lease_waiter').status).toBe('complete');
  });
});
