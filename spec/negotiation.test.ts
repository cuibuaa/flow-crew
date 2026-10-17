import './test-support/policy-runtime.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { atomicWrite } from '../src/store.js';
import { fixtureResult, declaredDispatch, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { drainDueTimers } from './test-support/engine-fixtures.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { execWithStdin } from '../src/adapters/base.js';
import {
  findAllReady,
  normalizeStageContracts,
  recordSchedulerTechnicalAttemptResult,
  runWorkflow,
  StageConfigSchema,
  WorkflowConfigSchema,
  type WorkflowConfig,
} from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  setFcGlobalDir,
  writeStageStatus,
  writeRunState,
  type StoreState,
} from '../src/store.js';
import { runStage } from '../src/worker.js';
import { captureEngineCheckpoint } from '../src/restart-recovery.js';
import {
  createTechnicalRetryBudgetState,
  transitionTechnicalRetryBudget,
  type AttemptDeadlineClock,
  type TechnicalRetryTerminalDecision,
} from '../src/attempt-deadline.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';
import {
  constraintDecisionPath,
  negotiationIdentity,
  negotiationRequestDigest,
  parseScopeRevisionRequest,
  scopePathDigest,
  publishConstraintDecision,
} from '../src/runtime-negotiation.js';
import { resolveRequest } from '../src/inbox.js';

let projectDir: string;
let isolatedStateDir: string;
let previousStateDir: string;

const role: AgentConfig = {
  name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'fixture',
};

// Pin the engine input; historical retries keep their old clocks, new slices do not grow.
const OWNED_STAGE_TIMEOUT_MS = 3_600_000;
function seedEngineDefaults(): void {
  setEngineDefaults({ timeout_ms: OWNED_STAGE_TIMEOUT_MS });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e9-project-'));
  seedEngineDefaults();
  isolatedStateDir = mkdtempSync(join(tmpdir(), 'flowcrew-e9-state-'));
  previousStateDir = fcGlobalDir();
  setFcGlobalDir(isolatedStateDir);
});

afterEach(() => {
  setFcGlobalDir(previousStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

function writeRoles(...names: string[]): string {
  const directory = join(projectDir, 'config', 'agents');
  mkdirSync(directory, { recursive: true });
  for (const name of names) {
    writeFileSync(join(directory, `${name}.yaml`), [
      `name: ${name}`, 'description: fixture', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: fixture',
    ].join('\n'));
  }
  return directory;
}

function prepareRun(config: WorkflowConfig, yaml: string) {
  return prepareFixtureRun(projectDir, config, yaml);
}

function summaryResult(opts: RunOpts): RunResult | undefined {
  return opts.stageId === '_summary' ? { output: 'summary', exitCode: 0, duration_ms: 1 } : undefined;
}

class ManualAttemptDeadlineClock implements AttemptDeadlineClock {
  private monotonicMs = 0;
  private wallMs = Date.parse('2026-01-01T00:00:00.000Z');
  private nextTimerId = 1;
  private readonly timers = new Map<number, { deadlineMs: number; callback: () => void }>();

  monotonicNow(): number { return this.monotonicMs; }
  wallNow(): number { return this.wallMs; }

  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, { deadlineMs: this.monotonicMs + Math.max(0, delayMs), callback });
    return timerId as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(elapsedMs: number): void {
    this.monotonicMs += elapsedMs;
    this.wallMs += elapsedMs;
    drainDueTimers(this.timers, this.monotonicMs);
  }

}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function findArtifact(directory: string, prefix: string): string {
  const name = readdirSync(directory).find((file) => file.startsWith(prefix) && file.endsWith('.json'));
  if (!name) throw new Error(`Missing ${prefix} artifact in ${directory}`);
  return join(directory, name);
}

async function waitForDecision(directory: string, prefix: string): Promise<Record<string, unknown>> {
  return waitForPathEvent(directory, () => {
    const name = readdirSync(directory).find((file) => file.startsWith(prefix) && file.endsWith('.json'));
    if (name) return readJson(join(directory, name));
    return undefined;
  });
}

describe('shared immutable negotiation protocol', () => {
  it('is attempt-scoped, idempotent for the same body, and audits a body mismatch', () => {
    const stagePath = join(projectDir, 'audit');
    const parsed = parseScopeRevisionRequest({
      version: 1, kind: 'scope_revision', requestId: 'same/id', runId: 'fixture-run', stageId: 'work', attemptIndex: 1,
      requestedPaths: ['./src/shared.ts', 'src/shared.ts'], pathDigest: 'stale', reason: ' shared type is required ',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.requestedPaths).toEqual(['src/shared.ts']);
    expect(parsed.request.pathDigest).toBe(scopePathDigest(['src/shared.ts']));
    for (const mutation of [{ requestedPaths: 'src/shared.ts' }, { requestedPaths: [7] },
      { attemptIndex: 0 }, { attemptIndex: 1.5 }, { stageId: '' }, { runId: '' }]) {
      expect(parseScopeRevisionRequest({ ...parsed.request, ...mutation })).toMatchObject({ ok: false });
    }
    const decision = {
      accepted: true, decision: 'accepted' as const, decidedAt: new Date().toISOString(),
      policyBasis: 'fixture policy', requestedPaths: parsed.request.requestedPaths,
      priorScope: ['src/work.ts'], effectiveScope: ['src/work.ts', 'src/shared.ts'],
    };
    const first = publishConstraintDecision({ stagePath, request: parsed.request, decidedBy: 'scheduler-policy', decision });
    const replay = publishConstraintDecision({ stagePath, request: parsed.request, decidedBy: 'scheduler-policy', decision });
    expect(first.kind).toBe('published');
    expect(replay.kind).toBe('replayed');
    expect(constraintDecisionPath(stagePath, parsed.request)).toContain(negotiationIdentity(parsed.request));

    const changed = parseScopeRevisionRequest({
      ...parsed.request, reason: 'changed rationale', requestedBy: undefined,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    const mismatch = publishConstraintDecision({ stagePath, request: changed.request, decidedBy: 'scheduler-policy', decision });
    expect(mismatch.kind).toBe('mismatch');
    expect(readdirSync(stagePath).filter((file) => file.startsWith('constraint_request_mismatch_'))).toHaveLength(1);

    const nextAttempt = parseScopeRevisionRequest({ ...parsed.request, attemptIndex: 2, requestedBy: undefined });
    expect(nextAttempt.ok).toBe(true);
    if (!nextAttempt.ok) return;
    expect(constraintDecisionPath(stagePath, nextAttempt.request)).not.toBe(constraintDecisionPath(stagePath, parsed.request));
  });

  it('does not let a requester preclaim an accepted lookalike over policy rejection', () => {
    const stagePath = join(projectDir, 'preclaim');
    mkdirSync(stagePath, { recursive: true });
    const parsed = parseScopeRevisionRequest({
      version: 1, kind: 'scope_revision', requestId: 'preclaim', runId: 'fixture-run', stageId: 'work', attemptIndex: 1,
      requestedPaths: ['src/escape.ts'], reason: 'claimed by requester',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = constraintDecisionPath(stagePath, parsed.request);
    writeFileSync(target, JSON.stringify({
      version: 1,
      requestId: parsed.request.requestId,
      kind: parsed.request.kind,
      stageId: parsed.request.stageId,
      attemptIndex: parsed.request.attemptIndex,
      identityDigest: negotiationIdentity(parsed.request),
      requestDigest: negotiationRequestDigest(parsed.request),
      requestedBy: 'stage',
      reason: parsed.request.reason,
      decision: 'accepted',
      accepted: true,
      decidedBy: 'scheduler-policy',
      decidedAt: new Date().toISOString(),
      policyBasis: 'requester-created lookalike',
      requestedPaths: parsed.request.requestedPaths,
      priorScope: ['src/declared.ts'],
      effectiveScope: ['src/declared.ts', 'src/escape.ts'],
    }));
    const publication = publishConstraintDecision({
      stagePath,
      request: parsed.request,
      decidedBy: 'scheduler-policy',
      decision: {
        decision: 'rejected', accepted: false, decidedAt: new Date().toISOString(),
        policyBasis: 'authoritative policy rejects the request', rejectionReason: 'conflicts with active peer',
      },
    });
    expect(publication.kind).toBe('mismatch');
    if (publication.kind === 'mismatch') {
      expect(publication.mismatch.mismatchReason).toBe('decision_policy_mismatch');
    }
  });
});

describe('ordinary-stage scope negotiation and reconciliation', () => {
  function scopeWorkflow(maxRetries = 0, maxIterations = 1): { yaml: string; config: WorkflowConfig } {
    const yaml = [
      'name: e9-scope', 'defaults:', `  max_iterations: ${maxIterations}`, `  max_retries: ${maxRetries}`,
      'stages:', '  - id: ordinary', '    role: coder', '    scope: [src/declared.ts]',
      `    max_retries: ${maxRetries}`, '    prompt_template: scope fixture',
    ].join('\n');
    return {
      yaml,
      config: {description: '', 
        name: 'e9-scope', defaults: { max_iterations: maxIterations, max_retries: maxRetries }, stages: [{ artifact_contract: fixtureArtifactContract('ordinary', false),criterion_refs: [],
          id: 'ordinary', role: 'coder', depends_on: [], scope: ['src/declared.ts'], prompt_template: 'scope fixture',
          max_retries: maxRetries, skills: [], dynamic_dispatch: false, is_gate: false,
        }],
      },
    };
  }

  it('[B1] suspends an exit-0 attempt with a just-accepted scope revision and re-dispatches the same stage', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const yaml = [
      'name: e9-scope-gate', 'defaults:', '  max_iterations: 1', '  max_retries: 0', 'stages:',
      '  - id: ordinary', '    role: coder', '    scope: [src/declared.ts]', '    prompt_template: scope fixture',
      '  - id: audit_gate', '    role: qa', '    scope: []', '    depends_on: [ordinary]',
      '    dependency_reasons: {ordinary: "audit the implementation"}', '    is_gate: true', '    prompt_template: gate fixture',
      '  - id: repair_audit', '    role: coder', '    scope: [src/declared.ts]', '    depends_on: [audit_gate]',
      '    retry_to: [audit_gate]', '    prompt_template: repair the rejected implementation',
    ].join('\n');
    const config: WorkflowConfig = {description: '', 
      name: 'e9-scope-gate', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
        { artifact_contract: fixtureArtifactContract('ordinary', false),criterion_refs: [],  id: 'ordinary', role: 'coder', depends_on: [], scope: ['src/declared.ts'], prompt_template: 'scope fixture', skills: [], dynamic_dispatch: false, is_gate: false },
        { artifact_contract: fixtureArtifactContract('audit_gate', true),criterion_refs: [],  id: 'audit_gate', role: 'qa', depends_on: ['ordinary'], dependency_reasons: { ordinary: 'audit the implementation' }, scope: [], prompt_template: 'gate fixture', skills: [], dynamic_dispatch: false, is_gate: true },
        { artifact_contract: fixtureArtifactContract('repair_audit'), criterion_refs: [], id: 'repair_audit', role: 'coder', depends_on: ['audit_gate'], retry_to: ['audit_gate'], scope: ['src/declared.ts'], prompt_template: 'repair the rejected implementation', skills: [], dynamic_dispatch: false, is_gate: false },
      ],
    };
    const created = prepareRun(config, yaml);
    let gateSawAudit = false;
    let ordinaryCalls = 0;
    const adapter: Adapter = { async run(prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      if (opts.stageId === 'ordinary') {
        ordinaryCalls++;
        expect(prompt).toContain('immutable');
        expect(prompt).toContain('Retries, backoff and fallback consume that same budget');
        expect(prompt).not.toContain('timeout_extension_request.json');
        if (ordinaryCalls === 1) {
          const directory = join(opts.runDir, 'stages', opts.stageId);
          writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
            version: 1, kind: 'scope_revision', requestId: 'ordinary-shared', stageId: opts.stageId,
            attemptIndex: 1, requestedPaths: ['src/shared.ts'], reason: 'the implementation needs the authoritative shared type',
          }));
          const decision = await waitForDecision(directory, 'scope_revision_decision_');
          expect(decision).toMatchObject({ accepted: true, requestedBy: 'stage', decidedBy: 'scheduler-policy' });
          return fixtureResult({ output: 'scope accepted; stop at the control boundary', exitCode: 0, duration_ms: 20, writes: [], writeAttribution: 'structured' }, opts);
        }
        expect(prompt).toContain('# Accepted scope revision');
        expect(prompt).toContain('Continue the stage work in execution 2');
        expect(prompt).not.toContain('Scope revision ordinary-shared was accepted. This attempt stops');
        writeFileSync(join(projectDir, 'src', 'shared.ts'), 'shared\n');
        return fixtureResult({ output: 'done', exitCode: 0, duration_ms: 20, writes: ['src/shared.ts'], writeAttribution: 'structured' }, opts);
      }
      gateSawAudit = prompt.includes('constraint_audit_attempt_1.json') && prompt.includes('accepted=1');
      writeFileSync(join(opts.runDir, 'fixture_verdict_audit_gate.json'), JSON.stringify({ pass: gateSawAudit, reason: 'audit visible' }));
      return fixtureResult({ output: 'gate', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder', 'qa'), created.runId, 'scope gate', true);
    expect(final.status).toBe('complete');
    expect(ordinaryCalls).toBe(2);
    expect(gateSawAudit).toBe(true);
    const status = readStageStatus(projectDir, created.runId, 'ordinary');
    expect(status.attempts?.map((attempt) => attempt.status)).toEqual(['suspended', 'complete']);
    expect(status.attempts?.[0].constraintAudit).toMatchObject({ acceptedRevisionCount: 1, violationCount: 0, effectiveScope: ['src/declared.ts', 'src/shared.ts'] });
  });

  it('attributes an unstructured out-of-scope write through the admitted scheduler scope and corrects it in the same attempt', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const { config, yaml } = scopeWorkflow();
    const created = prepareRun(config, yaml);
    let invocationCount = 0;
    const adapter: Adapter = { async run(prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      invocationCount++;
      if (invocationCount === 1) writeFileSync(join(projectDir, 'src', 'observed.ts'), 'snapshot only\n');
      else expect(prompt).toContain('# Live constraint correction');
      return fixtureResult({ output: invocationCount === 1 ? 'snapshot' : 'corrected', exitCode: 0, duration_ms: 2 }, opts);
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder'), created.runId, 'scope snapshot', true);
    expect(final.status).toBe('complete');
    expect(invocationCount).toBe(2);
    const status = readStageStatus(projectDir, created.runId, 'ordinary');
    expect(status.attempts).toHaveLength(1);
    expect(status.constraintAudit).toMatchObject({
      acceptedRevisionCount: 0,
      violationCount: 1,
      liveViolationCount: 1,
      liveRestoredCount: 1,
      unresolvedViolationCount: 0,
      unverifiedCount: 0,
    });
    const audit = readJson(join(created.runDirPath, status.constraintAudit!.path));
    expect(audit.violations).toEqual(expect.arrayContaining([expect.objectContaining({
      path: 'src/observed.ts', certainty: 'definite', resolution: 'live_reverted',
    })]));
    expect(audit.rolledBackWrites).toEqual(['src/observed.ts']);
    expect(existsSync(join(projectDir, 'src', 'observed.ts'))).toBe(false);
  });

  // These names are stable workload IDs. Their former local-scope assertions
  // are obsolete; the bodies now enforce inherited, revalidated capability.
  it('does not carry an accepted scope revision into a timeout retry attempt', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const { config, yaml } = scopeWorkflow(1, 2);
    const created = prepareRun(config, yaml);
    let calls = 0;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      calls++;
      if (calls === 1) {
        const directory = join(opts.runDir, 'stages', opts.stageId);
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: 'attempt-local', stageId: opts.stageId,
          attemptIndex: 1, requestedPaths: ['src/local.ts'], reason: 'needed in the first attempt',
        }));
        await waitForDecision(directory, 'scope_revision_decision_');
        writeFileSync(join(projectDir, 'src', 'local.ts'), 'attempt one\n');
        return fixtureResult({ output: 'timeout', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true, writes: ['src/local.ts'], writeAttribution: 'structured' }, opts);
      }
      writeFileSync(join(projectDir, 'src', 'local.ts'), 'attempt two\n');
      return fixtureResult({ output: 'no new request', exitCode: 0, duration_ms: 1, writes: ['src/local.ts'], writeAttribution: 'structured' }, opts);
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder'), created.runId, 'scope attempts', true);
    expect(calls).toBe(2);
    expect(final.status).toBe('complete');
    const status = readStageStatus(projectDir, created.runId, 'ordinary');
    expect(status.attempts?.[0].constraintAudit?.effectiveScope).toContain('src/local.ts');
    expect(status.attempts?.[1].constraintAudit).toMatchObject({
      effectiveScope: ['src/declared.ts', 'src/local.ts'], acceptedRevisionCount: 1, violationCount: 0,
    });
  });

  it('reconciles every repair-chain attempt and keeps each effective scope local', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const yaml = [
      'name: repair-scope-attempts', 'defaults:', '  max_iterations: 2', '  max_retries: 0',
      'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true',
    ].join('\n');
    const config: WorkflowConfig = {description: '',  name: 'repair-scope-attempts', defaults: { max_iterations: 2, max_retries: 0 }, stages: [{ artifact_contract: fixtureArtifactContract('plan', false),criterion_refs: [],
      id: 'plan', role: 'planner', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: true, is_gate: false,
    }] };
    const created = prepareRun(config, yaml);
    let gateCalls = 0;
    let repairCalls = 0;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
          'stages:',
          '  - id: review_gate', '    role: qa', '    scope: []', '    depends_on: [plan]',
          '    dependency_reasons: {plan: "review the planned repair"}', '    is_gate: true', '    task: review',
          '  - id: repair', '    role: repair', '    scope: [src/declared.ts]', '    depends_on: [review_gate]',
          '    dependency_reasons: {review_gate: "repair only after an explicit rejection"}', '    retry_to: [review_gate]',
          '    max_retries: 1', '    task: repair',
        ].join('\n')));
        return fixtureResult({ output: 'plan', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      if (opts.stageId === 'review_gate') {
        gateCalls++;
        writeFileSync(join(opts.runDir, 'fixture_verdict_review_gate.json'), JSON.stringify({
          pass: gateCalls > 1, reason: gateCalls > 1 ? 'fixed' : 'rejected',
        }));
        return fixtureResult({ output: 'gate', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      repairCalls++;
      if (repairCalls === 1) {
        const directory = join(opts.runDir, 'stages', opts.stageId);
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: 'repair-attempt-one', stageId: opts.stageId,
          attemptIndex: 1, requestedPaths: ['src/local.ts'], reason: 'attempt one requires the shared repair path',
        }));
        await waitForDecision(directory, 'scope_revision_decision_');
        writeFileSync(join(projectDir, 'src', 'local.ts'), 'attempt one\n');
        return fixtureResult({ output: 'timeout', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true, writes: ['src/local.ts'], writeAttribution: 'structured' }, opts);
      }
      writeFileSync(join(projectDir, 'src', 'local.ts'), 'attempt two without request\n');
      return fixtureResult({ output: 'done', exitCode: 0, duration_ms: 1, writes: ['src/local.ts'], writeAttribution: 'structured' }, opts);
    } };
    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('planner', 'qa', 'repair'), created.runId, 'repair scope attempts', true,
      undefined, true,
    );
    expect(repairCalls).toBe(2);
    expect(final.status).toBe('complete');
    const status = readStageStatus(projectDir, created.runId, 'repair');
    expect(status.attempts?.[0].constraintAudit).toMatchObject({
      effectiveScope: ['src/declared.ts', 'src/local.ts'], acceptedRevisionCount: 1, violationCount: 0,
    });
    expect(status.attempts?.[1].constraintAudit).toMatchObject({
      effectiveScope: ['src/declared.ts', 'src/local.ts'], acceptedRevisionCount: 1, violationCount: 0,
    });
  });
});

describe('approval attempt suspension', () => {
  it('[C1] parks on approval detection, suspends the requester, and resumes by re-running that same stage', { timeout: 15_000 }, async () => {
    const yaml = [
      'name: approval-suspension', 'defaults:', '  max_iterations: 2', '  max_retries: 0', 'stages:',
      '  - id: action', '    role: coder', '    scope: []', '    prompt_template: request approval',
      '  - id: downstream', '    role: coder', '    scope: []', '    depends_on: [action]',
      '    dependency_reasons: {action: "consume the approved action"}', '    prompt_template: finish',
    ].join('\n');
    const config: WorkflowConfig = {description: '', 
      name: 'approval-suspension',
      defaults: { max_iterations: 2, max_retries: 0 },
      stages: [
        { artifact_contract: fixtureArtifactContract('action', false),criterion_refs: [],  id: 'action', role: 'coder', depends_on: [], scope: [], prompt_template: 'request approval', skills: [], dynamic_dispatch: false, is_gate: false },
        { artifact_contract: fixtureArtifactContract('downstream', false),criterion_refs: [],  id: 'downstream', role: 'coder', depends_on: ['action'], dependency_reasons: { action: 'consume the approved action' }, scope: [], prompt_template: 'finish', skills: [], dynamic_dispatch: false, is_gate: false },
      ],
    };
    const created = prepareRun(config, yaml);
    let actionCalls = 0;
    let downstreamCalls = 0;
    let approvalAborted = false;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      if (opts.stageId === 'downstream') {
        downstreamCalls++;
        return fixtureResult({ output: 'downstream complete', exitCode: 0, duration_ms: 1 }, opts);
      }
      actionCalls++;
      if (actionCalls > 1) {
        expect(existsSync(join(opts.runDir, 'approvals', 'launch-training.decision.json'))).toBe(true);
        return fixtureResult({ output: 'approved action complete', exitCode: 0, duration_ms: 1 }, opts);
      }
      const requestedAt = new Date().toISOString();
      writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'approval_request.json'), JSON.stringify({
        id: 'launch-training',
        action: 'launch_model_training',
        risk: 'external',
        title: 'launch model training',
        requestedAt,
      }));
      await new Promise<void>((resolveWait) => {
        const finish = () => {
          approvalAborted = true;
          resolveWait();
        };
        if (opts.abortSignal?.aborted) finish();
        else opts.abortSignal?.addEventListener('abort', finish, { once: true });
      });
      return fixtureResult({ output: 'stopped at approval boundary', exitCode: opts.abortSignal?.aborted ? 137 : 0, duration_ms: Date.now() - started }, opts);
    } };

    const parked = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('coder'), created.runId, 'approval suspension', true,
    );

    expect(parked.status).toBe('parked');
    expect(approvalAborted).toBe(true);
    expect(parked.stages.action.status, JSON.stringify(parked.stages.action)).toBe('pending');
    expect(readStageStatus(projectDir, created.runId, 'action').attempts?.[0]?.status).toBe('suspended');
    expect(downstreamCalls).toBe(0);
    const events = readFileSync(join(created.runDirPath, 'events.jsonl'), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const parkedEvent = events.find((event) => event.type === 'approval_parked');
    expect(parkedEvent).toMatchObject({
      stageId: 'action',
      attemptIndex: 1,
      requestId: 'launch-training',
      requestedAt: expect.any(String),
      detectedAt: expect.any(String),
    });
    expect(Date.parse(String(parkedEvent?.detectedAt)) - Date.parse(String(parkedEvent?.requestedAt)))
      .toBeGreaterThanOrEqual(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'approval_attempt_suspended',
      stageId: 'action',
      attemptIndex: 1,
      requestId: 'launch-training',
    }));

    expect(resolveRequest(projectDir, created.runId, 'launch-training', 'approve', { by: 'operator' }).won).toBe(true);
    const resumed = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('coder'), created.runId, 'approval suspension', true,
    );
    expect(resumed.status).toBe('complete');
    expect(actionCalls).toBe(2);
    expect(downstreamCalls).toBe(1);
    expect(readStageStatus(projectDir, created.runId, 'action').attempts?.map((attempt) => attempt.status))
      .toEqual(['suspended', 'complete']);
  });
});

describe('gate verdict facts and repair eligibility', () => {
  it('normalizes retry targets and blocks ordinary dependents on an explicit negative verdict', () => {
    const gate = StageConfigSchema.parse({ artifact_contract: fixtureArtifactContract('legacy_gate', false), id: 'legacy_gate', role: 'qa', prompt_template: 'gate' });
    const repair = StageConfigSchema.parse({ artifact_contract: fixtureArtifactContract('repair', false), id: 'repair', role: 'coder', prompt_template: 'repair', retry_to: ['legacy_gate'] });
    const downstream = StageConfigSchema.parse({ artifact_contract: fixtureArtifactContract('downstream', false),criterion_refs: [], dynamic_dispatch: false,  id: 'downstream', role: 'coder', prompt_template: 'down', depends_on: ['legacy_gate'] });
    normalizeStageContracts([gate, repair, downstream]);
    expect(gate.is_gate).toBe(true);
    expect(repair.depends_on).toContain('legacy_gate');

    const runId = 'gate-fact';
    const directory = join(isolatedStateDir, 'runs', runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'verdict_legacy_gate.json'), JSON.stringify({ pass: false, reason: 'rejected' }));
    const state: StoreState = {
      runId, workflowName: 'gate-fact', projectDir, status: 'running', startedAt: new Date().toISOString(),
      stages: {
        legacy_gate: { status: 'complete', retries: 0 }, repair: { status: 'pending', retries: 0 }, downstream: { status: 'pending', retries: 0 },
      },
    };
    // Even if a legacy producer loses the normalized marker, the verdict fact wins.
    gate.is_gate = false;
    expect(findAllReady([gate, repair, downstream], state)).toEqual([]);
  });

  it('does not re-dispatch the fix once its gate has passed, while ordinary dependents proceed', () => {
    // E18: `normalizeStageContracts` adds the gate to the fix's `depends_on` purely as
    // retry wiring, recording "fixes run only after this gate reports a failure". Reading that
    // edge as an ordinary dependency made a PASSING gate re-dispatch the fix, so a run whose
    // gate had already accepted the work ran fix → gate → fix → gate for another 46 minutes
    // and 20M input tokens, committing nothing. `gate_retry_loops` does not bound it: this is
    // not the retry loop. Rejection still reaches the fix, through that loop.
    const gate = StageConfigSchema.parse({ artifact_contract: fixtureArtifactContract('passing_gate', false), id: 'passing_gate', role: 'qa', prompt_template: 'gate' });
    const repair = StageConfigSchema.parse({ artifact_contract: fixtureArtifactContract('fix', false), id: 'fix', role: 'coder', prompt_template: 'fix', retry_to: ['passing_gate'] });
    const downstream = StageConfigSchema.parse({ artifact_contract: fixtureArtifactContract('after', false),criterion_refs: [], dynamic_dispatch: false,  id: 'after', role: 'coder', prompt_template: 'after', depends_on: ['passing_gate'] });
    normalizeStageContracts([gate, repair, downstream]);
    expect(repair.depends_on).toContain('passing_gate');

    const runId = 'gate-passed';
    const directory = join(isolatedStateDir, 'runs', runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'verdict_passing_gate.json'), JSON.stringify({ pass: true, reason: 'accepted' }));
    const state: StoreState = {
      runId, workflowName: 'gate-passed', projectDir, status: 'running', startedAt: new Date().toISOString(),
      stages: {
        passing_gate: { status: 'complete', retries: 0 },
        fix: { status: 'pending', retries: 0 },
        after: { status: 'pending', retries: 0 },
      },
    };
    // The accepted gate releases its ordinary dependent and nothing else.
    expect(findAllReady([gate, repair, downstream], state).map((stage) => stage.id)).toEqual(['after']);
  });

  it('never dispatches a pending release repair/gate and resumes the DAG after review repair passes', { timeout: 15_000 }, async () => {
    const yaml = [
      'name: e9-gates', 'defaults:', '  max_iterations: 2', '  max_retries: 0',
      'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true',
    ].join('\n');
    const config: WorkflowConfig = {description: '',  name: 'e9-gates', defaults: { max_iterations: 2, max_retries: 0 }, stages: [
      { artifact_contract: fixtureArtifactContract('plan', false),criterion_refs: [],  id: 'plan', role: 'planner', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: true, is_gate: false },
    ] };
    const created = prepareRun(config, yaml);
    const calls: string[] = [];
    let reviewCalls = 0;
    let releaseCalls = 0;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      calls.push(opts.stageId);
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
          'stages:',
          '  - id: review_gate', '    role: qa', '    scope: []', '    depends_on: [plan]',
          '    dependency_reasons: {plan: "review the planned work"}', '    is_gate: true', '    task: review',
          '  - id: implement', '    role: coder', '    scope: [src/impl.ts]', '    depends_on: [review_gate]',
          '    dependency_reasons: {review_gate: "implement only after review passes"}', '    task: implement',
          '  - id: release_gate', '    role: qa', '    scope: []', '    depends_on: [implement]',
          '    dependency_reasons: {implement: "release audit follows implementation"}', '    is_gate: true', '    task: release',
          '  - id: fix_review', '    role: repair', '    scope: [src/review.ts]', '    depends_on: [review_gate]',
          '    dependency_reasons: {review_gate: "repair only the rejected review"}', '    retry_to: [review_gate]', '    task: fix review',
          '  - id: fix_release', '    role: repair', '    scope: [src/release.ts]', '    depends_on: [release_gate]',
          '    dependency_reasons: {release_gate: "repair only the rejected release"}', '    retry_to: [release_gate]', '    task: fix release',
        ].join('\n')));
      } else if (opts.stageId === 'review_gate') {
        reviewCalls++;
        writeFileSync(join(opts.runDir, 'fixture_verdict_review_gate.json'), JSON.stringify({ pass: reviewCalls > 1, reason: reviewCalls > 1 ? 'fixed' : 'rejected' }));
      } else if (opts.stageId === 'implement') {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src', 'impl.ts'), 'implemented\n');
      } else if (opts.stageId === 'release_gate') {
        releaseCalls++;
        writeFileSync(join(opts.runDir, 'fixture_verdict_release_gate.json'), JSON.stringify({ pass: releaseCalls > 1, reason: releaseCalls > 1 ? 'released' : 'release rejected' }));
      }
      const writes = opts.stageId === 'implement' ? ['src/impl.ts'] : [];
      return fixtureResult({ output: opts.stageId, exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' }, opts);
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('planner', 'qa', 'coder', 'repair'), created.runId, 'gate order', true);
    expect(final.status).toBe('complete');
    expect(calls).toEqual(['plan', 'review_gate', 'fix_review', 'review_gate', 'implement', 'release_gate', 'fix_release', 'release_gate']);
    expect(calls.indexOf('fix_release')).toBeGreaterThan(calls.indexOf('release_gate'));
  });
});

describe('bounded timeout negotiation', () => {
  function directRunDir(stageId: string): { runId: string; runDirPath: string } {
    const created = createRun(projectDir, 'timeout-direct', 'name: timeout-direct', [stageId]);
    mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
    return { runId: created.runId, runDirPath: created.runDirPath };
  }

  it('[E1] delivers new targeted guidance at attempt start and before every adapter invocation', { timeout: 15_000 }, async () => {
    const stageId = 'guided_retry';
    const { runId, runDirPath } = directRunDir(stageId);
    const beforeAttempt = 'read this before the attempt starts';
    writeFileSync(join(runDirPath, 'user_input.md'), beforeAttempt, 'utf-8');
    const prompts: string[] = [];
    let calls = 0;
    const adapter: Adapter = { async run(prompt, _agent, opts) {
      calls++;
      prompts.push(prompt);
      if (calls === 1) {
        expect(prompt).toContain(beforeAttempt);
        atomicWrite(join(opts.runDir, 'user_input.md'), 'switch to the isolated retry reproduction');
        return fixtureResult({ output: '503 Service Unavailable', exitCode: 1, duration_ms: 1,
          adapterError: true, adapterFailureKind: 'service_unavailable' }, opts);
      }
      return fixtureResult({ output: 'recovered', exitCode: 0, duration_ms: 1 }, opts);
    } };

    const result = await runStage(adapter, {
      artifactContract: fixtureArtifactContract(stageId),
      stageId,
      role,
      dependsOn: [],
      promptTemplate: 'guided retry',
      timeout_ms: 10_000,
      technicalRetry: {
        delaysMs: [0],
      },
      projectDir,
      runId,
      runDir: runDirPath,
      retries: 0,
    });

    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('switch to the isolated retry reproduction');
    const receipt = readFileSync(join(runDirPath, 'stages', stageId, 'guidance_consumed.md'), 'utf-8');
    expect(receipt).toContain(beforeAttempt);
    expect(receipt).toContain('switch to the isolated retry reproduction');
    expect(existsSync(join(runDirPath, 'user_input.md'))).toBe(false);
    const events = readFileSync(join(runDirPath, 'events.jsonl'), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'guidance_delivery_checked', stageId, attemptIndex: 1,
        boundary: 'attempt_start', delivered: true,
      }),
      expect.objectContaining({
        type: 'guidance_delivery_checked', stageId, attemptIndex: 1,
        boundary: 'adapter_invocation', invocationIndex: 2, delivered: true,
      }),
    ]));
  });

  it('resumes a scheduler timeout retry from attempt evidence without an aggregate balance', { timeout: 10_000 }, async () => {
    async function scenario(withEvidence: boolean): Promise<{ budgets: number[]; status: ReturnType<typeof readStageStatus> }> {
      const config: WorkflowConfig = {description: '',  name: 'resume-timeout', defaults: { max_iterations: 1, max_retries: 1 }, stages: [{ artifact_contract: fixtureArtifactContract('work', false),criterion_refs: [], 
        id: 'work', role: 'coder', depends_on: [], prompt_template: 'resume timeout',
        max_retries: 1, skills: [], dynamic_dispatch: false, is_gate: false,
      }] };
      const yaml = JSON.stringify(config);
      const created = prepareRun(config, yaml);
      const observedAt = Date.now();
      const priorTimeout = {
        attemptId: 'persisted-attempt',
        budgetMs: 3_600_000,
        attemptStartedAt: new Date(observedAt - 3_600_000).toISOString(),
        deadlineAt: new Date(observedAt).toISOString(),
        elapsedMs: 3_600_000,
        remainingMs: 0,
        rejectedExtensionCount: 0,
        decisionPaths: [],
        mismatchPaths: [],
        terminationCause: 'attempt_timeout' as const,
        childClosedAt: new Date(observedAt).toISOString(),
      };
      const priorStatus = {
        status: 'pending' as const,
        retries: 1,
        error: 'timed out after 0s',
        attempts: [{
          index: 1,
          startedAt: new Date(observedAt - 30_000).toISOString(),
          completedAt: new Date(observedAt).toISOString(),
          status: 'failed' as const,
          duration_ms: 3_600_000,
          exitCode: 124,
          error: 'timed out after 0s',
          ...(withEvidence ? { timeout: priorTimeout } : {}),
        }],
        ...(withEvidence ? { timeout: priorTimeout } : {}),
      };
      writeStageStatus(projectDir, created.runId, 'work', priorStatus);
      const state = readRunState(projectDir, created.runId);
      state.stages.work = priorStatus;
      // The retry clock is separate from recovery authority: this fixture
      // supplies previous-boot/same-generation provenance for its executed run.
      state.engineCheckpoint = { ...captureEngineCheckpoint(projectDir, created.runId), bootId: 'prior-fixture-boot' };
      writeRunState(projectDir, created.runId, state);
      const budgets: number[] = [];
      const adapter: Adapter = { async run(_prompt, _agent, opts) {
        const summary = summaryResult(opts);
        if (summary) return fixtureResult(summary, opts);
        const nominal = readStageStatus(projectDir, opts.runDir.split('/').at(-1)!, opts.stageId).timeout!.budgetMs;
        expect(opts.timeout_ms).toBeGreaterThan(0); expect(opts.timeout_ms).toBeLessThanOrEqual(nominal); budgets.push(nominal);
        return fixtureResult({ output: 'resumed', exitCode: 0, duration_ms: 1 }, opts);
      } };
      await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder'), created.runId, 'resume timeout', true);
      return { budgets, status: readStageStatus(projectDir, created.runId, 'work') };
    }

    const recovered = await scenario(true);
    expect(recovered.budgets).toHaveLength(1);
    expect(recovered.budgets[0]).toBe(7_200_000);
    expect(recovered.status.attempts?.at(-1)?.timeout?.attemptId).not.toBe('persisted-attempt');

    rmSync(projectDir, { recursive: true, force: true });
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e9-project-resume-missing-'));
    seedEngineDefaults();
    const recoveredFromRetryLedger = await scenario(false);
    expect(recoveredFromRetryLedger.budgets).toEqual([7_200_000]);
    expect(recoveredFromRetryLedger.status.status).toBe('complete');
  });

  it('always prepares a strictly larger timeout retry without a second balance', () => {
    const retry = createTechnicalRetryBudgetState({ initialBudgetMs: 50 });
    const budgets: number[] = [];
    const first = transitionTechnicalRetryBudget(retry, { type: 'prepare_attempt' });
    if (first.type !== 'attempt_prepared') throw new Error('initial retry budget was not prepared');
    budgets.push(first.budgetMs);
    recordSchedulerTechnicalAttemptResult(retry, {
      effectiveTimeoutMs: first.budgetMs,
      timedOut: true,
      timeoutTerminationCause: 'attempt_timeout',
    }, first.budgetMs);
    const second = transitionTechnicalRetryBudget(retry, { type: 'prepare_attempt' });
    if (second.type !== 'attempt_prepared') throw new Error('retry budget was not prepared');
    budgets.push(second.budgetMs);
    recordSchedulerTechnicalAttemptResult(retry, {
      effectiveTimeoutMs: second.budgetMs,
      timedOut: true,
      timeoutTerminationCause: 'attempt_timeout',
    }, second.budgetMs);
    const terminal = transitionTechnicalRetryBudget(retry, { type: 'retry_exhausted' });
    if (terminal.type !== 'terminal') throw new Error('retry exhaustion was not terminal');
    const semantic: { budgets: number[]; terminalDecision: TechnicalRetryTerminalDecision } = {
      budgets,
      terminalDecision: terminal.terminalDecision,
    };
    expect(semantic).toEqual({ budgets: [50, 100], terminalDecision: 'attempt_timeout' });
    process.stdout.write(`SINGLE_TIMEOUT_RETRY_SEMANTICS=${JSON.stringify(semantic)}\n`);
  });

  it('continues first-budget work without enlarging the next execution', { timeout: 10_000 }, async () => {
    const yaml = [
      'name: retry-after-timeout',
      'defaults:',
      '  max_iterations: 2',
      '  max_retries: 1',
      'stages:',
      '  - id: work',
      '    role: coder',
      '    max_retries: 1',
      '    prompt_template: finish the work',
    ].join('\n');
    const config = WorkflowConfigSchema.parse({description: '', 
      name: 'retry-after-timeout',
      defaults: { max_iterations: 2, max_retries: 1 },
      stages: [{ artifact_contract: fixtureArtifactContract('work', false), id: 'work', role: 'coder', max_retries: 1, prompt_template: 'finish the work' }],
    });
    const created = prepareRun(config, yaml);
    const budgets: number[] = [];
    const adapter: Adapter = { async run(prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      const nominal = readStageStatus(projectDir, opts.runDir.split('/').at(-1)!, opts.stageId).timeout!.budgetMs;
        expect(opts.timeout_ms).toBeGreaterThan(0); expect(opts.timeout_ms).toBeLessThanOrEqual(nominal); budgets.push(nominal);
      if (budgets.length === 1) {
        return fixtureResult({ output: 'partial', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true }, opts);
      }
      expect(prompt).toContain('Own-stage continuation evidence');
      return fixtureResult({ output: 'finished', exitCode: 0, duration_ms: 1 }, opts);
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('coder'), created.runId, 'timeout retry', true,
    );
    expect(final.status).toBe('complete');
    expect(final.currentIteration).toBe(2);
    expect(budgets).toEqual([3_600_000, 3_600_000]);
    const attempts = readStageStatus(projectDir, created.runId, 'work').attempts ?? [];
    expect(attempts.map((attempt) => attempt.timeout?.budgetMs)).toEqual(budgets);
    expect(attempts.map((attempt) => attempt.timeout?.terminationCause)).toEqual(['budget_forced_stop', 'complete']);
  });

  it('does not let planner-authored max_retries suppress bounded budget continuation', { timeout: 10_000 }, async () => {
    setEngineDefaults({ timeout_ms: OWNED_STAGE_TIMEOUT_MS, stage_technical_retries: 1 });
    const yaml = [
      'name: planner-retry-suppression',
      'defaults:',
      '  max_iterations: 2',
      '  max_retries: 0',
      'stages:',
      '  - id: plan',
      '    role: planner',
      '    dynamic_dispatch: true',
    ].join('\n');
    const config = WorkflowConfigSchema.parse(parseYaml(declaredDispatch(yaml)));
    const created = prepareRun(config, yaml);
    const budgets: number[] = [];
    let workCalls = 0;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return fixtureResult(summary, opts);
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch([
          '- id: work',
          '  role: coder',
          '  scope: []',
          '  depends_on: [plan]',
          '  dependency_reasons: {plan: "Consumes the planner output."}',
          '  max_retries: 0',
          '  prompt_template: finish the dispatched work',
        ].join('\n')));
        return fixtureResult({ output: 'planned', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
      }
      workCalls++;
      const nominal = readStageStatus(projectDir, opts.runDir.split('/').at(-1)!, opts.stageId).timeout!.budgetMs;
        expect(opts.timeout_ms).toBeGreaterThan(0); expect(opts.timeout_ms).toBeLessThanOrEqual(nominal); budgets.push(nominal);
      if (workCalls === 1) {
        return fixtureResult({ output: 'partial', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true }, opts);
      }
      return fixtureResult({ output: 'finished', exitCode: 0, duration_ms: 1 }, opts);
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('planner', 'coder'), created.runId, 'planner retry suppression', true,
    );
    const recorded = parseYaml(readFileSync(join(created.runDirPath, 'workflow.yaml'), 'utf-8')) as {
      stages: Array<{ id: string; max_retries?: number }>;
    };
    const observed = { workCalls, budgets, finalStatus: final.status };
    process.stdout.write(`PLAN_RETRY_SUPPRESSION=${JSON.stringify(observed)}\n`);
    expect(observed).toEqual({ workCalls: 2, budgets: [OWNED_STAGE_TIMEOUT_MS, OWNED_STAGE_TIMEOUT_MS], finalStatus: 'complete' });
    expect((final.dispatchedStages as Array<{ id: string; max_retries?: number }> | undefined)
      ?.find((stage) => stage.id === 'work')).not.toHaveProperty('max_retries');
    expect(recorded.stages.find((stage) => stage.id === 'work')).not.toHaveProperty('max_retries');
  });

  it('waits for adapter cancellation settlement before recording child close', { timeout: 5_000 }, async () => {
    const stageId = 'child_close';
    const { runId, runDirPath } = directRunDir(stageId);
    const clock = new ManualAttemptDeadlineClock();
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    let closeChild!: () => void;
    const childClose = new Promise<void>((resolve) => { closeChild = resolve; });
    let adapterSettled = false;
    let workerSettled = false;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      opts.abortSignal?.addEventListener('abort', cancelled, { once: true });
      clock.advance(20000);
      await childClose;
      adapterSettled = true;
      return fixtureResult({ output: 'closed after cancellation', exitCode: 137, duration_ms: 160 }, opts);
    } };
    const execution = runStage(adapter, {
      artifactContract: fixtureArtifactContract(stageId), deadlineClock: clock,
      stageId, role, dependsOn: [], promptTemplate: 'child close', timeout_ms: 20000,
      projectDir, runId, runDir: runDirPath, retries: 0,
    }).then(() => { workerSettled = true; });
    try {
      await cancellation;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(adapterSettled).toBe(false);
      expect(workerSettled).toBe(false);
      expect(readStageStatus(projectDir, runId, stageId).timeout?.childClosedAt).toBeUndefined();
      clock.advance(120);
    } finally {
      closeChild();
      await execution;
    }
    const status = readStageStatus(projectDir, runId, stageId);
    expect(adapterSettled).toBe(true);
    expect(status.timeout?.childClosedAt).toBeTruthy();
    expect(status.timeout?.deadlineOverrunMs).toBe(120);
  });

  it('kills an infinite local Node child at its immutable attempt deadline despite repeated extension requests', { timeout: 15_000 }, async () => {
    const stageId = 'infinite';
    const { runId, runDirPath } = directRunDir(stageId);
    const initialBudgetMs = 20000;
    const requestedExtensionMs = 500;
    const requestCadenceMs = 1000;
    const clock = new ManualAttemptDeadlineClock();
    let childStarted = false;
    let requestNumber = 0;
    let resolveAdapterSettled!: () => void;
    const adapterSettled = new Promise<void>((resolve) => { resolveAdapterSettled = resolve; });
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const requestPath = join(opts.runDir, 'stages', opts.stageId, 'timeout_extension_request.json');
      const emit = () => {
        requestNumber++;
        writeFileSync(requestPath, JSON.stringify({
          version: 1, kind: 'timeout_extension', requestId: `loop-${requestNumber}`, stageId: opts.stageId,
          attemptIndex: 1, requestedAt: new Date().toISOString(),
          requestedExtensionMs, reason: `progress sample ${requestNumber}`,
        }));
      };
      try {
        let stdout = '';
        return fixtureResult(await execWithStdin(process.execPath, ['-e', 'process.stdout.write("infinite-ready\\n");setInterval(() => {}, 1000)'], '', {
          cwd: projectDir, timeout_ms: 10_000, abortSignal: opts.abortSignal,
          onStdout: (chunk) => {
            stdout += chunk;
            if (childStarted || !stdout.includes('infinite-ready\n')) return;
            childStarted = true;
            // Native enforcement and Node startup must finish before the
            // deadline scenario begins. Extension requests never move it.
            for (let elapsed = 0; elapsed < initialBudgetMs; elapsed += requestCadenceMs) {
              emit();
              clock.advance(requestCadenceMs);
            }
          },
        }), opts);
      } finally {
        resolveAdapterSettled();
      }
    } };
    const result = await runStage(adapter, {
      artifactContract: fixtureArtifactContract(stageId), deadlineClock: clock,
      stageId, role, dependsOn: [], promptTemplate: 'infinite', timeout_ms: initialBudgetMs,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    // The worker now treats adapter settlement as the child lifecycle
    // acknowledgement, so this promise must already be settled on return.
    await adapterSettled;
    expect(childStarted).toBe(true);
    expect(requestNumber).toBe(initialBudgetMs / requestCadenceMs);
    expect(result).toMatchObject({ processExitCode: null, processSignal: 'SIGTERM' });
    const status = readStageStatus(projectDir, runId, stageId);
    const decisions = status.timeout?.decisionPaths?.map((path) => readJson(join(runDirPath, path))) ?? [];
    expect(result).toMatchObject({ exitCode: 0, continuation: { reason: 'stage_budget', forced: true } });
    expect(status.timeout?.terminationCause, JSON.stringify({ timeout: status.timeout, decisions })).toBe('budget_forced_stop');
    expect(status.timeout?.deadlineReachedAt).toBeTruthy();
    expect(status.timeout?.budgetMs).toBe(initialBudgetMs);
    expect(Date.parse(status.timeout!.deadlineAt) - Date.parse(status.timeout!.attemptStartedAt)).toBe(initialBudgetMs);
    expect(status.timeout?.rejectedExtensionCount).toBeUndefined();
    expect(decisions).toEqual([]);
    expect(decisions.every((decision) => decision.accepted === false && decision.grantedExtensionMs === 0)).toBe(true);
    expect(status.timeout?.elapsedMs).toBe(initialBudgetMs);
    expect(status.timeout?.deadlineOverrunMs).toBe(0);
  });

});
