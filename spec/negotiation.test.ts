import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { execWithTimeout } from '../src/adapters/base.js';
import {
  findAllReady,
  normalizeRetryGateRelationships,
  recordSchedulerTechnicalAttemptResult,
  runWorkflow,
  StageConfigSchema,
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
import {
  TechnicalChainController,
  HARD_CAP_OBSERVATION_TOLERANCE_MS,
  createTechnicalRetryBudgetState,
  transitionTechnicalRetryBudget,
  type TechnicalChainClock,
  type TechnicalRetryTerminalDecision,
} from '../src/technical-chain.js';
import { parseSupervisorVerdict } from '../src/supervisor.js';
import {
  constraintDecisionPath,
  negotiationIdentity,
  negotiationRequestDigest,
  parseScopeRevisionRequest,
  publishConstraintDecision,
} from '../src/runtime-negotiation.js';

let projectDir: string;
let isolatedStateDir: string;
let previousStateDir: string;

const role: AgentConfig = {
  name: 'coder', description: 'fixture', model: 'test', reasoning_effort: 'low', tools: [], prompt: 'fixture',
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e9-project-'));
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
  const created = createRun(projectDir, config.name, yaml, config.stages.map((stage) => stage.id));
  writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  state.maxRetries = 2;
  writeRunState(projectDir, created.runId, state);
  return created;
}

function summaryResult(opts: RunOpts): RunResult | undefined {
  return opts.stageId === '_summary' ? { output: 'summary', exitCode: 0, duration_ms: 1 } : undefined;
}

class ManualTechnicalChainClock implements TechnicalChainClock {
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

  advanceSemanticEvent(): void {
    this.monotonicMs += 1;
    this.wallMs += 1;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.deadlineMs <= this.monotonicMs)
      .sort((left, right) => left[1].deadlineMs - right[1].deadlineMs);
    for (const [timerId, timer] of due) {
      this.timers.delete(timerId);
      timer.callback();
    }
  }
}

function applyBoundedRetryCpuLoad(): void {
  const started = performance.now();
  let accumulator = 0;
  while (performance.now() - started < 125) {
    accumulator = Math.imul(accumulator + 1, 31) >>> 0;
  }
  void accumulator;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function findArtifact(directory: string, prefix: string): string {
  const name = readdirSync(directory).find((file) => file.startsWith(prefix) && file.endsWith('.json'));
  if (!name) throw new Error(`Missing ${prefix} artifact in ${directory}`);
  return join(directory, name);
}

async function waitForDecision(directory: string, prefix: string, timeoutMs = 800): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const name = readdirSync(directory).find((file) => file.startsWith(prefix) && file.endsWith('.json'));
    if (name) return readJson(join(directory, name));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${prefix}`);
}

describe('shared immutable negotiation protocol', () => {
  it('is attempt-scoped, idempotent for the same body, and audits a body mismatch', () => {
    const stagePath = join(projectDir, 'audit');
    const parsed = parseScopeRevisionRequest({
      version: 1, kind: 'scope_revision', requestId: 'same/id', runId: 'fixture-run', stageId: 'work', attemptIndex: 1,
      requestedPaths: ['./src/shared.ts'], reason: ' shared type is required ',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
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
      ...parsed.request, requestedPaths: ['src/different.ts'], requestedBy: undefined,
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
  function scopeWorkflow(maxRetries = 0): { yaml: string; config: WorkflowConfig } {
    const yaml = [
      'name: e9-scope', 'defaults:', '  max_iterations: 1', `  max_retries: ${maxRetries}`,
      'stages:', '  - id: ordinary', '    role: coder', '    scope: [src/declared.ts]',
      '    timeout_ms: 1000', '    timeout_total_ms: 3000', `    max_retries: ${maxRetries}`, '    prompt_template: scope fixture',
    ].join('\n');
    return {
      yaml,
      config: {
        name: 'e9-scope', defaults: { max_iterations: 1, max_retries: maxRetries }, stages: [{
          id: 'ordinary', role: 'coder', depends_on: [], scope: ['src/declared.ts'], prompt_template: 'scope fixture',
          timeout_ms: 1000, timeout_total_ms: 3000, max_retries: maxRetries, skills: [], dynamic_dispatch: false, is_gate: false,
        }],
      },
    };
  }

  it('accepts a reasoned ordinary-stage addition before write and exposes its audit to a gate', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const yaml = [
      'name: e9-scope-gate', 'defaults:', '  max_iterations: 1', '  max_retries: 0', 'stages:',
      '  - id: ordinary', '    role: coder', '    scope: [src/declared.ts]', '    prompt_template: scope fixture',
      '  - id: audit_gate', '    role: qa', '    scope: []', '    depends_on: [ordinary]',
      '    dependency_reasons: {ordinary: "audit the implementation"}', '    is_gate: true', '    prompt_template: gate fixture',
    ].join('\n');
    const config: WorkflowConfig = {
      name: 'e9-scope-gate', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
        { id: 'ordinary', role: 'coder', depends_on: [], scope: ['src/declared.ts'], prompt_template: 'scope fixture', skills: [], dynamic_dispatch: false, is_gate: false },
        { id: 'audit_gate', role: 'qa', depends_on: ['ordinary'], dependency_reasons: { ordinary: 'audit the implementation' }, scope: [], prompt_template: 'gate fixture', skills: [], dynamic_dispatch: false, is_gate: true },
      ],
    };
    const created = prepareRun(config, yaml);
    let gateSawAudit = false;
    const adapter: Adapter = { async run(prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      if (opts.stageId === 'ordinary') {
        const directory = join(opts.runDir, 'stages', opts.stageId);
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: 'ordinary-shared', stageId: opts.stageId,
          attemptIndex: 1, requestedPaths: ['src/shared.ts'], reason: 'the implementation needs the authoritative shared type',
        }));
        const decision = await waitForDecision(directory, 'scope_revision_decision_');
        expect(decision).toMatchObject({ accepted: true, requestedBy: 'stage', decidedBy: 'scheduler-policy' });
        writeFileSync(join(projectDir, 'src', 'shared.ts'), 'shared\n');
        return { output: 'done', exitCode: 0, duration_ms: 20, writes: ['src/shared.ts'], writeAttribution: 'structured' };
      }
      gateSawAudit = prompt.includes('constraint_audit_attempt_1.json') && prompt.includes('accepted=1');
      writeFileSync(join(opts.runDir, 'verdict_audit_gate.json'), JSON.stringify({ pass: gateSawAudit, reason: 'audit visible' }));
      return { output: 'gate', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder', 'qa'), created.runId, 'scope gate', true);
    expect(final.status).toBe('complete');
    expect(gateSawAudit).toBe(true);
    const status = readStageStatus(projectDir, created.runId, 'ordinary');
    expect(status.attempts?.[0].constraintAudit).toMatchObject({ acceptedRevisionCount: 1, violationCount: 0, effectiveScope: ['src/declared.ts', 'src/shared.ts'] });
  });

  it('rejects an empty reason and fails a definite structured write without accepted scope', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const { config, yaml } = scopeWorkflow();
    const created = prepareRun(config, yaml);
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      const directory = join(opts.runDir, 'stages', opts.stageId);
      writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
        version: 1, kind: 'scope_revision', requestId: 'empty-reason', stageId: opts.stageId,
        attemptIndex: 1, requestedPaths: ['src/escape.ts'], reason: '',
      }));
      const decision = await waitForDecision(directory, 'scope_revision_decision_');
      expect(decision).toMatchObject({ accepted: false, decision: 'rejected' });
      writeFileSync(join(projectDir, 'src', 'escape.ts'), 'not authorized\n');
      return { output: 'escaped', exitCode: 0, duration_ms: 20, writes: ['src/escape.ts'], writeAttribution: 'structured' };
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder'), created.runId, 'scope rejection', true);
    expect(final.status).toBe('failed');
    const status = readStageStatus(projectDir, created.runId, 'ordinary');
    expect(status.error).toContain('scope_violation');
    expect(status.constraintAudit).toMatchObject({ rejectedRevisionCount: 1, violationCount: 1 });
  });

  it('records snapshot-only out-of-scope attribution as unverified without silently approving it', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const { config, yaml } = scopeWorkflow();
    const created = prepareRun(config, yaml);
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      writeFileSync(join(projectDir, 'src', 'observed.ts'), 'snapshot only\n');
      return { output: 'snapshot', exitCode: 0, duration_ms: 2 };
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder'), created.runId, 'scope snapshot', true);
    expect(final.status).toBe('complete');
    const status = readStageStatus(projectDir, created.runId, 'ordinary');
    expect(status.constraintAudit).toMatchObject({ acceptedRevisionCount: 0, violationCount: 0, unverifiedCount: 1 });
    const audit = readJson(join(created.runDirPath, status.constraintAudit!.path));
    expect(audit.violations).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/observed.ts', certainty: 'unverified' })]));
    expect(audit.rolledBackWrites).toEqual(['src/observed.ts']);
    expect(existsSync(join(projectDir, 'src', 'observed.ts'))).toBe(false);
  });

  it('does not carry an accepted scope revision into a timeout retry attempt', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const { config, yaml } = scopeWorkflow(1);
    const created = prepareRun(config, yaml);
    let calls = 0;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      calls++;
      if (calls === 1) {
        const directory = join(opts.runDir, 'stages', opts.stageId);
        writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
          version: 1, kind: 'scope_revision', requestId: 'attempt-local', stageId: opts.stageId,
          attemptIndex: 1, requestedPaths: ['src/local.ts'], reason: 'needed in the first attempt',
        }));
        await waitForDecision(directory, 'scope_revision_decision_');
        writeFileSync(join(projectDir, 'src', 'local.ts'), 'attempt one\n');
        return { output: 'timeout', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true, writes: ['src/local.ts'], writeAttribution: 'structured' };
      }
      writeFileSync(join(projectDir, 'src', 'local.ts'), 'attempt two\n');
      return { output: 'no new request', exitCode: 0, duration_ms: 1, writes: ['src/local.ts'], writeAttribution: 'structured' };
    } };
    const final = await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder'), created.runId, 'scope attempts', true);
    expect(calls).toBe(2);
    expect(final.status).toBe('failed');
    const status = readStageStatus(projectDir, created.runId, 'ordinary');
    expect(status.attempts?.[0].constraintAudit?.effectiveScope).toContain('src/local.ts');
    expect(status.attempts?.[1].constraintAudit).toMatchObject({ effectiveScope: ['src/declared.ts'], violationCount: 1 });
  });

  it('reconciles every repair-chain attempt and keeps each effective scope local', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'declared.ts'), 'declared\n');
    const yaml = [
      'name: repair-scope-attempts', 'defaults:', '  max_iterations: 1', '  max_retries: 0',
      'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true',
    ].join('\n');
    const config: WorkflowConfig = { name: 'repair-scope-attempts', defaults: { max_iterations: 1, max_retries: 0 }, stages: [{
      id: 'plan', role: 'planner', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: true, is_gate: false,
    }] };
    const created = prepareRun(config, yaml);
    let gateCalls = 0;
    let repairCalls = 0;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
          'stages:',
          '  - id: review_gate', '    role: qa', '    scope: []', '    depends_on: [plan]', '    is_gate: true', '    task: review',
          '  - id: repair', '    role: repair', '    scope: [src/declared.ts]', '    retry_to: [review_gate]',
          '    timeout_ms: 100', '    timeout_total_ms: 300', '    max_retries: 1', '    task: repair',
        ].join('\n'));
        return { output: 'plan', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      if (opts.stageId === 'review_gate') {
        gateCalls++;
        writeFileSync(join(opts.runDir, 'verdict_review_gate.json'), JSON.stringify({
          pass: gateCalls > 1, reason: gateCalls > 1 ? 'fixed' : 'rejected',
        }));
        return { output: 'gate', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
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
        return { output: 'timeout', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true, writes: ['src/local.ts'], writeAttribution: 'structured' };
      }
      writeFileSync(join(projectDir, 'src', 'local.ts'), 'attempt two without request\n');
      return { output: 'done', exitCode: 0, duration_ms: 1, writes: ['src/local.ts'], writeAttribution: 'structured' };
    } };
    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('planner', 'qa', 'repair'), created.runId, 'repair scope attempts', true,
    );
    expect(repairCalls).toBe(2);
    expect(final.status).not.toBe('complete');
    const status = readStageStatus(projectDir, created.runId, 'repair');
    expect(status.attempts?.[0].constraintAudit).toMatchObject({
      effectiveScope: ['src/declared.ts', 'src/local.ts'], acceptedRevisionCount: 1, violationCount: 0,
    });
    expect(status.attempts?.[1].constraintAudit).toMatchObject({
      effectiveScope: ['src/declared.ts'], acceptedRevisionCount: 0, violationCount: 1,
    });
  });
});

describe('gate verdict facts and repair eligibility', () => {
  it('normalizes retry targets and blocks ordinary dependents on an explicit negative verdict', () => {
    const gate = StageConfigSchema.parse({ id: 'legacy_gate', role: 'qa', prompt_template: 'gate' });
    const repair = StageConfigSchema.parse({ id: 'repair', role: 'coder', prompt_template: 'repair', retry_to: ['legacy_gate'] });
    const downstream = StageConfigSchema.parse({ id: 'downstream', role: 'coder', prompt_template: 'down', depends_on: ['legacy_gate'] });
    normalizeRetryGateRelationships([gate, repair, downstream]);
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
    // E18: `normalizeRetryGateRelationships` adds the gate to the fix's `depends_on` purely as
    // retry wiring, recording "fixes run only after this gate reports a failure". Reading that
    // edge as an ordinary dependency made a PASSING gate re-dispatch the fix, so a run whose
    // gate had already accepted the work ran fix → gate → fix → gate for another 46 minutes
    // and 20M input tokens, committing nothing. `gate_retry_loops` does not bound it: this is
    // not the retry loop. Rejection still reaches the fix, through that loop.
    const gate = StageConfigSchema.parse({ id: 'passing_gate', role: 'qa', prompt_template: 'gate' });
    const repair = StageConfigSchema.parse({ id: 'fix', role: 'coder', prompt_template: 'fix', retry_to: ['passing_gate'] });
    const downstream = StageConfigSchema.parse({ id: 'after', role: 'coder', prompt_template: 'after', depends_on: ['passing_gate'] });
    normalizeRetryGateRelationships([gate, repair, downstream]);
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
      'name: e9-gates', 'defaults:', '  max_iterations: 1', '  max_retries: 0',
      'stages:', '  - id: plan', '    role: planner', '    dynamic_dispatch: true',
    ].join('\n');
    const config: WorkflowConfig = { name: 'e9-gates', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
      { id: 'plan', role: 'planner', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: true, is_gate: false },
    ] };
    const created = prepareRun(config, yaml);
    const calls: string[] = [];
    let reviewCalls = 0;
    let releaseCalls = 0;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      calls.push(opts.stageId);
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
          'stages:',
          '  - id: review_gate', '    role: qa', '    scope: []', '    depends_on: [plan]', '    is_gate: true', '    task: review',
          '  - id: implement', '    role: coder', '    scope: [src/impl.ts]', '    depends_on: [review_gate]', '    task: implement',
          '  - id: release_gate', '    role: qa', '    scope: []', '    depends_on: [implement]', '    is_gate: true', '    task: release',
          '  - id: fix_review', '    role: repair', '    scope: [src/review.ts]', '    retry_to: [review_gate]', '    task: fix review',
          '  - id: fix_release', '    role: repair', '    scope: [src/release.ts]', '    retry_to: [release_gate]', '    task: fix release',
        ].join('\n'));
      } else if (opts.stageId === 'review_gate') {
        reviewCalls++;
        writeFileSync(join(opts.runDir, 'verdict_review_gate.json'), JSON.stringify({ pass: reviewCalls > 1, reason: reviewCalls > 1 ? 'fixed' : 'rejected' }));
      } else if (opts.stageId === 'implement') {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, 'src', 'impl.ts'), 'implemented\n');
      } else if (opts.stageId === 'release_gate') {
        releaseCalls++;
        writeFileSync(join(opts.runDir, 'verdict_release_gate.json'), JSON.stringify({ pass: releaseCalls > 1, reason: releaseCalls > 1 ? 'released' : 'release rejected' }));
      }
      const writes = opts.stageId === 'implement' ? ['src/impl.ts'] : [];
      return { output: opts.stageId, exitCode: 0, duration_ms: 1, writes, writeAttribution: 'structured' };
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

  it('parses supervisor extension proposals without turning them into approvals', () => {
    expect(parseSupervisorVerdict([
      '{"verdict":"EXTEND","target_stage":"work","reason":"verified final checks remain","guidance":null,"extension_ms":75}',
    ].join('\n'))).toMatchObject({
      verdict: 'EXTEND',
      targetStage: 'work',
      reason: 'verified final checks remain',
      extensionMs: 75,
    });
  });

  it('recovers a technical chain conservatively and aborts on backwards wall time', () => {
    const observedAt = Date.now();
    const recovered = new TechnicalChainController({
      initialBudgetMs: 100,
      hardTotalMs: 300,
      chainId: 'persisted-chain',
      recovery: {
        hardDeadlineAt: new Date(observedAt + 120).toISOString(),
        lastObservedAt: new Date(observedAt - 20).toISOString(),
        persistedChargedMs: 130,
        chainStartedAt: new Date(observedAt - 130).toISOString(),
      },
    });
    expect(recovered.chainId).toBe('persisted-chain');
    expect(recovered.elapsedMs()).toBeGreaterThanOrEqual(179);
    expect(recovered.remainingMs()).toBeLessThanOrEqual(120);
    expect(recovered.elapsedMs() + recovered.remainingMs()).toBeLessThanOrEqual(301);
    recovered.dispose();

    const uncertain = new TechnicalChainController({
      initialBudgetMs: 100,
      hardTotalMs: 300,
      recovery: {
        hardDeadlineAt: new Date(observedAt + 1_000).toISOString(),
        lastObservedAt: new Date(observedAt + 500).toISOString(),
        persistedChargedMs: 10,
      },
    });
    expect(uncertain.signal.aborted).toBe(true);
    expect(uncertain.terminationCause()).toBe('hard_cap_clock_uncertain');
    uncertain.dispose();
  });

  it('resumes a scheduler technical retry without replenishing an unprovable hard balance', { timeout: 10_000 }, async () => {
    async function scenario(withEvidence: boolean): Promise<{ budgets: number[]; status: ReturnType<typeof readStageStatus> }> {
      const yaml = [
        'name: resume-timeout', 'defaults:', '  max_iterations: 1', '  max_retries: 1', 'stages:',
        '  - id: work', '    role: coder', '    timeout_ms: 30000', '    timeout_total_ms: 100000',
        '    max_retries: 1', '    prompt_template: resume timeout',
      ].join('\n');
      const config: WorkflowConfig = { name: 'resume-timeout', defaults: { max_iterations: 1, max_retries: 1 }, stages: [{
        id: 'work', role: 'coder', depends_on: [], prompt_template: 'resume timeout', timeout_ms: 30_000,
        timeout_total_ms: 100_000, max_retries: 1, skills: [], dynamic_dispatch: false, is_gate: false,
      }] };
      const created = prepareRun(config, yaml);
      const observedAt = Date.now();
      const priorTimeout = {
        chainId: 'persisted-scheduler-chain',
        initialBudgetMs: 30_000,
        effectiveBudgetMs: 30_000,
        hardTotalMs: 100_000,
        chainStartedAt: new Date(observedAt - 45_000).toISOString(),
        hardDeadlineAt: new Date(observedAt + 55_000).toISOString(),
        chargedElapsedMs: 45_000,
        hardRemainingMs: 55_000,
        extensionCount: 0,
        cumulativeGrantedMs: 0,
        decisionPaths: [],
        mismatchPaths: [],
        terminationCause: 'soft_timeout' as const,
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
          duration_ms: 30_000,
          exitCode: 124,
          error: 'timed out after 0s',
          ...(withEvidence ? { timeout: priorTimeout } : {}),
        }],
        ...(withEvidence ? { timeout: priorTimeout } : {}),
      };
      writeStageStatus(projectDir, created.runId, 'work', priorStatus);
      const state = readRunState(projectDir, created.runId);
      state.stages.work = priorStatus;
      writeRunState(projectDir, created.runId, state);
      const budgets: number[] = [];
      const adapter: Adapter = { async run(_prompt, _agent, opts) {
        const summary = summaryResult(opts);
        if (summary) return summary;
        budgets.push(opts.timeout_ms);
        return { output: 'resumed', exitCode: 0, duration_ms: 1 };
      } };
      await runWorkflow(config, yaml, projectDir, adapter, new Map(), undefined, writeRoles('coder'), created.runId, 'resume timeout', true);
      return { budgets, status: readStageStatus(projectDir, created.runId, 'work') };
    }

    const recovered = await scenario(true);
    expect(recovered.budgets).toHaveLength(1);
    expect(recovered.budgets[0]).toBeGreaterThan(30_000);
    expect(recovered.budgets[0]).toBeLessThanOrEqual(55_000);
    expect(recovered.status.attempts?.at(-1)?.timeout?.chainId).toBe('persisted-scheduler-chain');

    rmSync(projectDir, { recursive: true, force: true });
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e9-project-resume-missing-'));
    const failClosed = await scenario(false);
    expect(failClosed.budgets).toEqual([]);
    expect(failClosed.status.error).toContain('hard_cap_clock_uncertain');
    expect(failClosed.status.timeout?.terminationCause).toBe('hard_cap_clock_uncertain');
  });

  // Budgets here are 10x the other cases in this file, deliberately. Most of them
  // assert that a stage DID time out, so jitter can only help them. This one asserts
  // the opposite — that the work finishes inside the extended budget — and at the
  // original 60ms + 70ms it left ~40ms of slack for the request/decision round trip
  // plus process scheduling. Under a loaded machine (the full 140-file suite in
  // parallel) that is not enough, and it failed intermittently with exit 124.
  // Same semantics, ~400ms of slack, still about a second of wall clock.
  it('lets a finite task finish through an audited pre-deadline extension', { timeout: 15_000 }, async () => {
    const stageId = 'finite';
    const { runId, runDirPath } = directRunDir(stageId);
    const chain = new TechnicalChainController({ initialBudgetMs: 600, hardTotalMs: 1_800, ledgerDir: join(runDirPath, 'stages', stageId) });
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'timeout_extension_request.json'), JSON.stringify({
        version: 1, kind: 'timeout_extension', requestId: 'finite-more', stageId: opts.stageId,
        attemptIndex: 1, requestedExtensionMs: 700, reason: 'verified final checks remain',
      }));
      await waitForDecision(join(opts.runDir, 'stages', opts.stageId), 'timeout_extension_decision_');
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { output: 'finished', exitCode: 0, duration_ms: 900 };
    } };
    const result = await runStage(adapter, {
      stageId, role, dependsOn: [], promptTemplate: 'finite', timeout_ms: 600, timeout_total_ms: 1_800,
      technicalChain: chain, projectDir, runId, runDir: runDirPath, retries: 0,
    });
    chain.dispose();
    expect(result.exitCode).toBe(0);
    const status = readStageStatus(projectDir, runId, stageId);
    expect(status.timeout).toMatchObject({ effectiveBudgetMs: 1_300, extensionCount: 1, cumulativeGrantedMs: 700, terminationCause: 'complete' });
    const decision = readJson(join(runDirPath, status.timeout!.decisionPaths[0]));
    expect(decision).toMatchObject({ accepted: true, requestedBy: 'stage', decidedBy: 'worker-policy', grantedExtensionMs: 700 });
  });

  it('never replays a stale timeout request or decision into a later attempt', { timeout: 5_000 }, async () => {
    const stageId = 'attempt_local_timeout';
    const { runId, runDirPath } = directRunDir(stageId);
    const first: Adapter = { async run(_prompt, _agent, opts) {
      const directory = join(opts.runDir, 'stages', opts.stageId);
      writeFileSync(join(directory, 'timeout_extension_request.json'), JSON.stringify({
        version: 1, kind: 'timeout_extension', requestId: 'first-only', stageId: opts.stageId,
        attemptIndex: 1, requestedExtensionMs: 50, reason: 'attempt one has verified remaining work',
      }));
      await waitForDecision(directory, 'timeout_extension_decision_');
      return { output: 'first complete', exitCode: 0, duration_ms: 1 };
    } };
    await runStage(first, {
      stageId, role, dependsOn: [], promptTemplate: 'first', timeout_ms: 100, timeout_total_ms: 300,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    let secondBudget = 0;
    const second: Adapter = { async run(_prompt, _agent, opts) {
      secondBudget = opts.timeout_ms;
      return { output: 'second complete without request', exitCode: 0, duration_ms: 1 };
    } };
    await runStage(second, {
      stageId, role, dependsOn: [], promptTemplate: 'second', timeout_ms: 100, timeout_total_ms: 300,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    const status = readStageStatus(projectDir, runId, stageId);
    expect(secondBudget).toBe(100);
    expect(status.attempts?.[1].timeout).toMatchObject({
      effectiveBudgetMs: 100, extensionCount: 0, cumulativeGrantedMs: 0, decisionPaths: [],
    });
  });

  it('uses a strictly larger timeout retry budget and refuses a retry when no increase fits', { timeout: 10_000 }, () => {
    function scenario(
      total: number,
      clock?: ManualTechnicalChainClock,
    ): { budgets: number[]; terminalDecision: TechnicalRetryTerminalDecision } {
      const controller = new TechnicalChainController({
        initialBudgetMs: 50,
        hardTotalMs: total,
        ...(clock ? { clock } : {}),
      });
      const retry = createTechnicalRetryBudgetState({ controller });
      const budgets: number[] = [];
      try {
        const first = transitionTechnicalRetryBudget(retry, { type: 'prepare_attempt' });
        if (first.type !== 'attempt_prepared') throw new Error('initial retry budget was not prepared');
        budgets.push(first.budgetMs);

        clock?.advanceSemanticEvent();
        recordSchedulerTechnicalAttemptResult(retry, {
          effectiveTimeoutMs: first.budgetMs,
          timedOut: true,
          timeoutTerminationCause: 'soft_timeout',
        }, first.budgetMs);
        applyBoundedRetryCpuLoad();
        const second = transitionTechnicalRetryBudget(retry, { type: 'prepare_attempt' });
        if (second.type === 'terminal') return { budgets, terminalDecision: second.terminalDecision };
        if (second.type !== 'attempt_prepared') throw new Error('retry budget transition did not make a decision');
        budgets.push(second.budgetMs);

        clock?.advanceSemanticEvent();
        recordSchedulerTechnicalAttemptResult(retry, {
          effectiveTimeoutMs: second.budgetMs,
          timedOut: true,
          timeoutTerminationCause: 'soft_timeout',
        }, second.budgetMs);
        const terminal = transitionTechnicalRetryBudget(retry, { type: 'retry_exhausted' });
        if (terminal.type !== 'terminal') throw new Error('retry exhaustion was not terminal');
        return { budgets, terminalDecision: terminal.terminalDecision };
      } finally {
        controller.dispose();
      }
    }
    const semantic = {
      expandable: scenario(150, new ManualTechnicalChainClock()),
      capped: scenario(50, new ManualTechnicalChainClock()),
    };
    expect(semantic).toEqual({
      expandable: { budgets: [50, 100], terminalDecision: 'soft_timeout' },
      capped: { budgets: [50], terminalDecision: 'hard_cap_exhausted' },
    });

    const legacy = scenario(150);
    const legacyCounterexampleKilled = legacy.budgets.length === 1
      && legacy.terminalDecision === 'hard_cap_exhausted';
    expect(legacyCounterexampleKilled).toBe(true);

    process.stdout.write(`M4_RETRY_SEMANTICS=${JSON.stringify(semantic)}\n`);
    process.stdout.write(`legacyCounterexampleKilled=${String(legacyCounterexampleKilled)}\n`);
  });

  it('charges primary retries, bounded backoff, and fallback to one aggregate deadline', { timeout: 5_000 }, async () => {
    const stageId = 'adapter_chain';
    const { runId, runDirPath } = directRunDir(stageId);
    mkdirSync(join(projectDir, 'config'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
      'adapter: fallback',
      'model: default',
      'reasoning_effort: default',
    ].join('\n'));
    const chain = new TechnicalChainController({ initialBudgetMs: 90, hardTotalMs: 90, ledgerDir: join(runDirPath, 'stages', stageId) });
    const hardBudgets: number[] = [];
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary: Adapter = { async run(_prompt, _agent, opts) {
      primaryCalls++;
      hardBudgets.push(opts.hard_timeout_ms ?? 0);
      return { output: '503 Service Unavailable', exitCode: 1, duration_ms: 1 };
    } };
    const fallback: Adapter = { async run(_prompt, _agent, opts) {
      fallbackCalls++;
      hardBudgets.push(opts.hard_timeout_ms ?? 0);
      const started = Date.now();
      if (opts.abortSignal?.aborted) return { output: 'cancelled', exitCode: 137, duration_ms: 0 };
      return new Promise<RunResult>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve({
          output: 'cancelled', exitCode: 137, duration_ms: Date.now() - started,
        }), { once: true });
      });
    } };
    const started = Date.now();
    const result = await runStage(primary, {
      stageId,
      role: { ...role, adapter: 'primary' },
      dependsOn: [],
      promptTemplate: 'adapter chain',
      timeout_ms: 90,
      timeout_total_ms: 90,
      technicalChain: chain,
      technicalRetry: {
        delaysMs: [5, 7],
        loadFallbackAdapter: async (name) => {
          expect(name).toBe('fallback');
          return fallback;
        },
      },
      projectDir,
      runId,
      runDir: runDirPath,
      retries: 0,
    });
    chain.dispose();
    expect(result.exitCode).toBe(124);
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
    expect(hardBudgets).toHaveLength(4);
    for (let index = 1; index < hardBudgets.length; index++) {
      expect(hardBudgets[index]).toBeLessThanOrEqual(hardBudgets[index - 1]);
    }
    const status = readStageStatus(projectDir, runId, stageId);
    expect(status.timeout?.terminationCause).toBe('hard_cap_timeout');
    expect(status.timeout?.deadlineOverrunMs).toBeLessThanOrEqual(HARD_CAP_OBSERVATION_TOLERANCE_MS);
    expect(Date.now() - started).toBeLessThan(1_000);
    const ledgerName = readdirSync(join(runDirPath, 'stages', stageId))
      .find((name) => name.startsWith('technical_chain_') && name.endsWith('.jsonl'));
    expect(ledgerName).toBeTruthy();
    const events = readFileSync(join(runDirPath, 'stages', stageId, ledgerName!), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line) as { type: string; chainId: string });
    expect(events.filter((event) => event.type === 'adapter_backoff_started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'adapter_phase_started')).toHaveLength(4);
    expect(new Set(events.map((event) => event.chainId))).toEqual(new Set([chain.chainId]));
  });

  it('includes fallback loading itself in the aggregate hard-cap race', { timeout: 5_000 }, async () => {
    const stageId = 'hanging_loader';
    const { runId, runDirPath } = directRunDir(stageId);
    mkdirSync(join(projectDir, 'config'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
      'adapter: fallback', 'model: default', 'reasoning_effort: default',
    ].join('\n'));
    const primary: Adapter = { async run() {
      return { output: '503 Service Unavailable', exitCode: 1, duration_ms: 1 };
    } };
    const started = Date.now();
    const result = await runStage(primary, {
      stageId, role: { ...role, adapter: 'primary' }, dependsOn: [], promptTemplate: 'loader',
      timeout_ms: 60, timeout_total_ms: 120,
      technicalRetry: { delaysMs: [], loadFallbackAdapter: async () => new Promise<Adapter>(() => {}) },
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    expect(Date.now() - started).toBeLessThan(350);
    expect(result.exitCode).toBe(124);
    expect(['soft_timeout', 'hard_cap_timeout']).toContain(
      readStageStatus(projectDir, runId, stageId).timeout?.terminationCause,
    );
  });

  it('waits for adapter cancellation settlement before recording child close', { timeout: 5_000 }, async () => {
    const stageId = 'child_close';
    const { runId, runDirPath } = directRunDir(stageId);
    let adapterSettled = false;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const started = Date.now();
      return new Promise<RunResult>((resolve) => {
        const finishAfterClose = () => setTimeout(() => {
          adapterSettled = true;
          resolve({ output: 'closed after cancellation', exitCode: 137, duration_ms: Date.now() - started });
        }, 120);
        if (opts.abortSignal?.aborted) finishAfterClose();
        else opts.abortSignal?.addEventListener('abort', finishAfterClose, { once: true });
      });
    } };
    const started = Date.now();
    await runStage(adapter, {
      stageId, role, dependsOn: [], promptTemplate: 'child close', timeout_ms: 40, timeout_total_ms: 40,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    const status = readStageStatus(projectDir, runId, stageId);
    expect(adapterSettled).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(status.timeout?.childClosedAt).toBeTruthy();
    expect(status.timeout?.deadlineOverrunMs).toBeGreaterThanOrEqual(100);
    expect(status.timeout?.deadlineOverrunMs).toBeLessThanOrEqual(HARD_CAP_OBSERVATION_TOLERANCE_MS);
  });

  it('kills an infinite local Node child at the aggregate cap despite repeated extension requests', { timeout: 5_000 }, async () => {
    const stageId = 'infinite';
    const { runId, runDirPath } = directRunDir(stageId);
    const chain = new TechnicalChainController({ initialBudgetMs: 50, hardTotalMs: 170, ledgerDir: join(runDirPath, 'stages', stageId) });
    let requestNumber = 0;
    let resolveAdapterSettled!: () => void;
    const adapterSettled = new Promise<void>((resolve) => { resolveAdapterSettled = resolve; });
    const started = Date.now();
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const requestPath = join(opts.runDir, 'stages', opts.stageId, 'timeout_extension_request.json');
      const emit = () => {
        requestNumber++;
        writeFileSync(requestPath, JSON.stringify({
          version: 1, kind: 'timeout_extension', requestId: `loop-${requestNumber}`, stageId: opts.stageId,
          attemptIndex: 1, requestedExtensionMs: 50, reason: `progress sample ${requestNumber}`,
        }));
      };
      emit();
      const interval = setInterval(emit, 25);
      try {
        return await execWithTimeout(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: projectDir, timeout_ms: opts.hard_timeout_ms ?? 1_000, abortSignal: opts.abortSignal,
        });
      } finally {
        clearInterval(interval);
        resolveAdapterSettled();
      }
    } };
    const result = await runStage(adapter, {
      stageId, role, dependsOn: [], promptTemplate: 'infinite', timeout_ms: 50, timeout_total_ms: 170,
      technicalChain: chain, projectDir, runId, runDir: runDirPath, retries: 0,
    });
    // The worker now treats adapter settlement as the child lifecycle
    // acknowledgement, so this promise must already be settled on return.
    await adapterSettled;
    chain.dispose();
    const elapsed = Date.now() - started;
    const status = readStageStatus(projectDir, runId, stageId);
    expect(result.exitCode).not.toBe(0);
    expect(status.timeout?.terminationCause).toBe('hard_cap_timeout');
    expect(status.timeout?.cumulativeGrantedMs).toBeLessThanOrEqual(120);
    expect(status.timeout?.effectiveBudgetMs).toBeLessThanOrEqual(170);
    expect(status.timeout?.deadlineOverrunMs).toBeLessThanOrEqual(HARD_CAP_OBSERVATION_TOLERANCE_MS);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('keeps a current-attempt supervisor ABORT authoritative over an extension', { timeout: 5_000 }, async () => {
    const stageId = 'abort_wins';
    const { runId, runDirPath } = directRunDir(stageId);
    writeFileSync(join(runDirPath, 'signals', `abort_${stageId}.json`), JSON.stringify({
      version: 1, stageId, attemptIndex: 1, reason: 'verified repeated wrong direction',
      timestamp: new Date().toISOString(), source: 'supervisor',
    }));
    writeFileSync(join(runDirPath, 'stages', stageId, 'timeout_extension_request.json'), JSON.stringify({
      version: 1, kind: 'timeout_extension', requestId: 'cannot-cancel-abort', stageId,
      attemptIndex: 1, requestedExtensionMs: 100, reason: 'more work remains',
    }));
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      if (!opts.abortSignal?.aborted) await new Promise((resolve) => opts.abortSignal?.addEventListener('abort', resolve, { once: true }));
      return { output: 'cancelled', exitCode: 137, duration_ms: 1 };
    } };
    const result = await runStage(adapter, {
      stageId, role, dependsOn: [], promptTemplate: 'abort', timeout_ms: 200, timeout_total_ms: 600,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    expect(result.exitCode).toBe(137);
    const status = readStageStatus(projectDir, runId, stageId);
    expect(status.error).toContain('aborted by supervisor');
    expect(status.timeout).toMatchObject({ extensionCount: 0, cumulativeGrantedMs: 0, terminationCause: 'supervisor_abort' });
    const decision = readJson(findArtifact(join(runDirPath, 'stages', stageId), 'timeout_extension_decision_'));
    expect(decision).toMatchObject({ accepted: false, rejectionReason: 'a current-attempt ABORT already exists' });
  });
});
