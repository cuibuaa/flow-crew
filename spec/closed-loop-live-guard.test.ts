import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Adapter } from '../src/adapters/base.js';
import {
  LiveConstraintGuard,
  acquireAttributableWriterLease,
} from '../src/live-constraint-guard.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { loadClosedLoopEngineEvidence } from './test-support/closed-loop-engine-evidence.js';

let projectDir: string;
let stateDir: string;
let priorStateDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-closed-loop-live-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'flowcrew-closed-loop-live-state-'));
  priorStateDir = fcGlobalDir();
  setFcGlobalDir(stateDir);
});

afterEach(() => {
  setFcGlobalDir(priorStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function seedProject(): string {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(projectDir, 'spec'), { recursive: true });
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
  writeFileSync(join(projectDir, 'config', 'agents', 'coder.yaml'), [
    'name: coder',
    'description: live guard fixture',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: fixture',
  ].join('\n'));
  const path = join(projectDir, 'spec', 'existing.test.ts');
  writeFileSync(path, 'export const invariant = "original";\n');
  writeFileSync(join(projectDir, 'operator-note.txt'), 'pre-existing dirt stays intact\n');
  return path;
}

function workflowFixture(scope: string[] = ['src/allowed.ts']): { config: WorkflowConfig; yaml: string } {
  const config: WorkflowConfig = {
    name: `closed-loop-live-guard-${scope.length > 0 ? 'nonempty' : 'empty'}`,
    defaults: { max_iterations: 1, max_retries: 0 },
    stages: [{
      id: 'writer', role: 'coder', scope, depends_on: [],
      prompt_template: 'Write only the declared source path.', skills: [],
      dynamic_dispatch: false, is_gate: false,
    }],
  };
  const yaml = [
    `name: closed-loop-live-guard-${scope.length > 0 ? 'nonempty' : 'empty'}`,
    'defaults:',
    '  max_iterations: 1',
    '  max_retries: 0',
    'stages:',
    '  - id: writer',
    '    role: coder',
    `    scope: [${scope.join(', ')}]`,
    '    depends_on: []',
    '    prompt_template: Write only the declared source path.',
  ].join('\n');
  return { config, yaml };
}

async function waitForDecision(directory: string, requestId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (const name of readdirSync(directory).filter((candidate) => (
      candidate.startsWith('scope_revision_decision_') && candidate.endsWith('.json')
    ))) {
      const decision = JSON.parse(readFileSync(join(directory, name), 'utf-8')) as Record<string, unknown>;
      if (decision.requestId === requestId) return decision;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`scope decision ${requestId} was not published`);
}

describe('portable live constraint guard', () => {
  it('keeps the historical violation byte anchor self-contained', () => {
    const evidence = loadClosedLoopEngineEvidence();
    expect(evidence.baseFailures.behavior1).toEqual({
      exitCode: 1,
      logBytes: 1711,
      logSha256: 'b4f439f6d985f43e98381a8bd3936ce2b08091bba1046346dc669c726e82c1d5',
    });
    expect(evidence.anchors.historicalConstraintAudit).toMatchObject({
      bytes: 3086,
      sha256: 'b848c74719dd4b4c2a829f246e04e63fad24d81deb3bf69cac9b3a7a788deb44',
      unauthorizedPath: 'tests/test_happymj_explore7_round02_verification.py',
      recordedElapsedMs: 5741999,
      childCloseToAuditCompleteMs: 29023,
      slice: {
        byteStart: 1283,
        byteEndExclusive: 2593,
        sha256: '9a69e752a6f1bb04b4448b97c813aab8df1d9e40e6488c0bd14c36c98a7963dd',
      },
    });
  });

  it.each([
    { label: 'non-empty', scope: ['src/allowed.ts'] },
    { label: 'empty', scope: [] },
  ])('restores an unlisted existing test live with a $label declared scope, reinvokes once in the same attempt, and retains the post-attempt audit', { timeout: 10_000 }, async ({ scope }) => {
    const testPath = seedProject();
    const preimage = readFileSync(testPath, 'utf-8');
    const { config, yaml } = workflowFixture(scope);
    const created = createRun(projectDir, config.name, yaml, ['writer']);
    const state = readRunState(projectDir, created.runId);
    state.autoApprove = true;
    state.maxRetries = 0;
    writeRunState(projectDir, created.runId, state);
    let invocationCount = 0;
    let restoreLatencyMs: number | undefined;
    let correctionBytes: Buffer | undefined;

    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      invocationCount++;
      if (invocationCount === 1) {
        if (scope.length > 0) writeFileSync(join(projectDir, 'src', 'allowed.ts'), 'authorized change survives\n');
        writeFileSync(testPath, 'export const invariant = "unauthorized";\n');
        const writtenAt = performance.now();
        const deadline = writtenAt + 1_000;
        while (performance.now() < deadline && readFileSync(testPath, 'utf-8') !== preimage) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        }
        if (readFileSync(testPath, 'utf-8') === preimage) restoreLatencyMs = performance.now() - writtenAt;
        return {
          output: 'first invocation wrote an unlisted existing test', exitCode: 0,
          duration_ms: performance.now() - writtenAt,
          writes: [...(scope.length > 0 ? ['src/allowed.ts'] : []), 'spec/existing.test.ts'], writeAttribution: 'structured',
        };
      }

      const marker = '# Live constraint correction\n';
      const markerAt = prompt.indexOf(marker);
      expect(markerAt).toBeGreaterThanOrEqual(0);
      correctionBytes = Buffer.from(prompt.slice(markerAt + marker.length), 'utf-8');
      const directory = join(opts.runDir, 'stages', opts.stageId);
      const requestedPaths = ['spec/existing.test.ts'];
      const requestId = 'authorize-existing-test';
      writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
        version: 1,
        kind: 'scope_revision',
        requestId,
        runId: created.runId,
        stageId: opts.stageId,
        attemptIndex: opts.attemptIndex,
        requestedPaths,
        pathDigest: scopePathDigest(requestedPaths),
        reason: 'the corrected fixture explicitly needs this existing test',
      }));
      expect(await waitForDecision(directory, requestId)).toMatchObject({ accepted: true });
      writeFileSync(testPath, 'export const invariant = "authorized-after-revision";\n');
      return {
        output: 'corrected in the original attempt', exitCode: 0, duration_ms: 2,
        writes: ['spec/existing.test.ts'], writeAttribution: 'structured',
      };
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      join(projectDir, 'config', 'agents'), created.runId, 'live guard replay', true, false,
    );
    expect(final.status).toBe('complete');
    expect(invocationCount).toBe(2);
    expect(restoreLatencyMs).toBeDefined();
    expect(restoreLatencyMs!).toBeLessThan(1_000);
    if (scope.length > 0) expect(readFileSync(join(projectDir, 'src', 'allowed.ts'), 'utf-8')).toContain('survives');
    else expect(existsSync(join(projectDir, 'src', 'allowed.ts'))).toBe(false);
    expect(readFileSync(join(projectDir, 'operator-note.txt'), 'utf-8')).toBe('pre-existing dirt stays intact\n');

    const status = readStageStatus(projectDir, created.runId, 'writer');
    expect(status.attempts).toHaveLength(1);
    const audit = JSON.parse(readFileSync(join(created.runDirPath, status.constraintAudit!.path), 'utf-8')) as {
      liveIncidents: Array<{ path: string; restored: boolean; detectionLatencyMs: number; scopeRevisionInstruction: string }>;
      scopeRevisionInstructions: string[];
      violations: Array<{ path: string; resolution?: string }>;
    };
    expect(audit.liveIncidents).toHaveLength(1);
    expect(audit.liveIncidents[0]).toMatchObject({ path: 'spec/existing.test.ts', restored: true });
    expect(audit.violations).toContainEqual(expect.objectContaining({
      path: 'spec/existing.test.ts', resolution: 'live_reverted',
    }));
    expect(correctionBytes).toEqual(Buffer.from(audit.scopeRevisionInstructions[0], 'utf-8'));
    expect(existsSync(join(created.runDirPath, 'stages', 'writer', 'constraint_audit_attempt_1.json'))).toBe(true);
  });

  it('catches a dropped watch event through the bounded fallback', async () => {
    const aborts: string[] = [];
    let dirty = false;
    const guard = new LiveConstraintGuard({
      projectDir,
      runDir: stateDir,
      stageId: 'writer',
      attemptIndex: 1,
      effectiveScope: () => ['src/allowed.ts'],
      fallbackScanMs: 10,
      monitorDeadlineMs: 100,
      watchProject: () => undefined,
      scanAndRestore: (_paths, trigger) => dirty
        ? {
            scannedPaths: 1,
            violations: [{ path: 'config/defaults.yaml', reason: `caught by ${trigger}`, restored: true }],
          }
        : { scannedPaths: 0, violations: [] },
      scopeRevisionInstruction: (paths) => `revise:${paths.join(',')}`,
    });
    const monitor = guard.beginInvocation(1, (reason) => aborts.push(reason));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    dirty = true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    dirty = false;
    const result = await monitor.finish();
    expect(result.incidents[0]).toMatchObject({
      trigger: 'fallback', path: 'config/defaults.yaml', restored: true,
    });
    expect(aborts).toContain('live_constraint_violation');
  });

  it('fails closed on rollback failure and on a scan that exceeds the monitor deadline', async () => {
    const rollbackGuard = new LiveConstraintGuard({
      projectDir,
      runDir: stateDir,
      stageId: 'writer',
      attemptIndex: 1,
      effectiveScope: () => [],
      watchProject: () => undefined,
      scanAndRestore: () => ({
        scannedPaths: 1,
        violations: [{ path: 'protected.txt', reason: 'cannot restore', restored: false, rollbackFailure: 'denied' }],
      }),
      scopeRevisionInstruction: () => 'request scope',
    });
    const rollbackAborts: string[] = [];
    const rollback = await rollbackGuard.beginInvocation(1, (reason) => rollbackAborts.push(reason)).finish();
    expect(rollback.incidents[0]).toMatchObject({ restored: false, rollbackFailure: 'denied' });
    expect(rollbackAborts).toContain('live_constraint_rollback_failure');

    const deadlineGuard = new LiveConstraintGuard({
      projectDir,
      runDir: stateDir,
      stageId: 'writer',
      attemptIndex: 2,
      effectiveScope: () => [],
      fallbackScanMs: 100,
      monitorDeadlineMs: 20,
      watchProject: () => undefined,
      scanAndRestore: () => new Promise(() => undefined),
      scopeRevisionInstruction: () => 'request scope',
    });
    const deadlineAborts: string[] = [];
    const deadline = await deadlineGuard.beginInvocation(1, (reason) => deadlineAborts.push(reason)).finish();
    expect(deadline.monitorFailure?.reason).toContain('monitor deadline');
    expect(deadlineAborts).toContain('live_constraint_monitor_failure');
  });

  it('serializes attributable writers while leaving an explicitly read-only lease free', async () => {
    const releaseFirst = await acquireAttributableWriterLease(projectDir, true);
    let secondAcquired = false;
    const second = acquireAttributableWriterLease(projectDir, true).then((release) => {
      secondAcquired = true;
      return release;
    });
    const releaseReadOnly = await acquireAttributableWriterLease(projectDir, false);
    releaseReadOnly();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(secondAcquired).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });
});
