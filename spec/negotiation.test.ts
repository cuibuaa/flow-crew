import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { execWithTimeout } from '../src/adapters/base.js';
import {
  findAllReady,
  normalizeRetryGateRelationships,
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
import {
  ATTEMPT_CLOSE_OBSERVATION_CUSHION_MS,
  createTechnicalRetryBudgetState,
  transitionTechnicalRetryBudget,
  type AttemptDeadlineClock,
  type TechnicalRetryTerminalDecision,
} from '../src/attempt-deadline.js';
import { parseSupervisorVerdict } from '../src/supervisor.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';
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

// The scheduler's technical-retry budget comes from the project's
// config/defaults.yaml::default_timeout_ms, not from the stage's declared
// timeout_ms. An unseeded temp project inherits a copy of this repository's
// operator-owned config, so any absolute budget asserted below would move
// whenever an operator retunes that file. Pin the one input these budgets are
// derived from, so the assertions test the doubling rule and nothing else.
const OWNED_STAGE_TIMEOUT_MS = 3_600_000;
function seedProjectDefaults(dir: string): void {
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'defaults.yaml'), `default_timeout_ms: ${OWNED_STAGE_TIMEOUT_MS}\n`, 'utf-8');
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e9-project-'));
  seedProjectDefaults(projectDir);
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
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.deadlineMs <= this.monotonicMs)
      .sort((left, right) => left[1].deadlineMs - right[1].deadlineMs);
    for (const [timerId, timer] of due) {
      this.timers.delete(timerId);
      timer.callback();
    }
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
      `    max_retries: ${maxRetries}`, '    prompt_template: scope fixture',
    ].join('\n');
    return {
      yaml,
      config: {
        name: 'e9-scope', defaults: { max_iterations: 1, max_retries: maxRetries }, stages: [{
          id: 'ordinary', role: 'coder', depends_on: [], scope: ['src/declared.ts'], prompt_template: 'scope fixture',
          max_retries: maxRetries, skills: [], dynamic_dispatch: false, is_gate: false,
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
        expect(prompt).toContain('immutable');
        expect(prompt).toContain('config/defaults.yaml::default_timeout_ms');
        expect(prompt).not.toContain('timeout_extension_request.json');
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
          '  - id: review_gate', '    role: qa', '    scope: []', '    depends_on: [plan]',
          '    dependency_reasons: {plan: "review the planned repair"}', '    is_gate: true', '    task: review',
          '  - id: repair', '    role: repair', '    scope: [src/declared.ts]', '    depends_on: [review_gate]',
          '    dependency_reasons: {review_gate: "repair only after an explicit rejection"}', '    retry_to: [review_gate]',
          '    max_retries: 1', '    task: repair',
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
      undefined, undefined, true,
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

  it('does not advertise or accept supervisor extension verdicts', () => {
    expect(parseSupervisorVerdict(
      '{"verdict":"EXTEND","target_stage":"work","reason":"more time","guidance":null}',
    )).toBeNull();
  });

  it('rejects every workflow or plan timeout override with a migration hint', () => {
    const base = { id: 'work', role: 'coder' };
    expect(() => StageConfigSchema.parse({ ...base, timeout_ms: 100 })).toThrow('config/defaults.yaml::default_timeout_ms');
    expect(() => StageConfigSchema.parse({ ...base, timeout_total_ms: 100 })).toThrow('config/defaults.yaml::default_timeout_ms');
    expect(() => WorkflowConfigSchema.parse({
      name: 'removed-default', defaults: { timeout_ms: 100 }, stages: [base],
    })).toThrow('config/defaults.yaml::default_timeout_ms');
  });

  it('resumes a scheduler timeout retry from attempt evidence without an aggregate balance', { timeout: 10_000 }, async () => {
    async function scenario(withEvidence: boolean): Promise<{ budgets: number[]; status: ReturnType<typeof readStageStatus> }> {
      const yaml = [
        'name: resume-timeout', 'defaults:', '  max_iterations: 1', '  max_retries: 1', 'stages:',
        '  - id: work', '    role: coder', '    max_retries: 1', '    prompt_template: resume timeout',
      ].join('\n');
      const config: WorkflowConfig = { name: 'resume-timeout', defaults: { max_iterations: 1, max_retries: 1 }, stages: [{
        id: 'work', role: 'coder', depends_on: [], prompt_template: 'resume timeout',
        max_retries: 1, skills: [], dynamic_dispatch: false, is_gate: false,
      }] };
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
    expect(recovered.budgets[0]).toBe(7_200_000);
    expect(recovered.status.attempts?.at(-1)?.timeout?.attemptId).not.toBe('persisted-attempt');

    rmSync(projectDir, { recursive: true, force: true });
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-e9-project-resume-missing-'));
    seedProjectDefaults(projectDir);
    const recoveredFromRetryLedger = await scenario(false);
    expect(recoveredFromRetryLedger.budgets).toEqual([7_200_000]);
    expect(recoveredFromRetryLedger.status.status).toBe('complete');
  });

  it('rejects a pre-deadline extension and keeps the attempt budget immutable', { timeout: 5_000 }, async () => {
    const stageId = 'finite';
    const { runId, runDirPath } = directRunDir(stageId);
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'timeout_extension_request.json'), JSON.stringify({
        version: 1, kind: 'timeout_extension', requestId: 'finite-more', stageId: opts.stageId,
        attemptIndex: 1, requestedAt: new Date().toISOString(),
        requestedExtensionMs: 700, reason: 'verified final checks remain',
      }));
      await waitForDecision(join(opts.runDir, 'stages', opts.stageId), 'timeout_extension_decision_');
      if (!opts.abortSignal?.aborted) {
        await new Promise((resolve) => opts.abortSignal?.addEventListener('abort', resolve, { once: true }));
      }
      return { output: 'cancelled', exitCode: 137, duration_ms: 600 };
    } };
    const result = await runStage(adapter, {
      stageId, role, dependsOn: [], promptTemplate: 'finite', timeout_ms: 600,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    expect(result.exitCode).toBe(124);
    const status = readStageStatus(projectDir, runId, stageId);
    expect(status.timeout).toMatchObject({ budgetMs: 600, rejectedExtensionCount: 1, terminationCause: 'attempt_timeout' });
    const decision = readJson(join(runDirPath, status.timeout!.decisionPaths[0]));
    expect(decision).toMatchObject({
      accepted: false,
      requestedBy: 'stage',
      decidedBy: 'worker-policy',
      grantedExtensionMs: 0,
      timingBasis: 'requested_at',
      requestedAt: expect.any(String),
      rejectionReason: 'running attempt deadlines are immutable; edit config/defaults.yaml::default_timeout_ms before launch',
    });
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
      stageId, role, dependsOn: [], promptTemplate: 'first', timeout_ms: 100,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    let secondBudget = 0;
    const second: Adapter = { async run(_prompt, _agent, opts) {
      secondBudget = opts.timeout_ms;
      return { output: 'second complete without request', exitCode: 0, duration_ms: 1 };
    } };
    await runStage(second, {
      stageId, role, dependsOn: [], promptTemplate: 'second', timeout_ms: 100,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    const status = readStageStatus(projectDir, runId, stageId);
    expect(secondBudget).toBe(100);
    expect(status.attempts?.[1].timeout).toMatchObject({
      budgetMs: 100, rejectedExtensionCount: 0, decisionPaths: [],
    });
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

  it('makes the lost first-timeout shape recover with a larger second attempt', { timeout: 10_000 }, async () => {
    const yaml = [
      'name: retry-after-timeout',
      'defaults:',
      '  max_iterations: 1',
      '  max_retries: 1',
      'stages:',
      '  - id: work',
      '    role: coder',
      '    max_retries: 1',
      '    prompt_template: finish the work',
    ].join('\n');
    const config = WorkflowConfigSchema.parse({
      name: 'retry-after-timeout',
      defaults: { max_iterations: 1, max_retries: 1 },
      stages: [{ id: 'work', role: 'coder', max_retries: 1, prompt_template: 'finish the work' }],
    });
    const created = prepareRun(config, yaml);
    const budgets: number[] = [];
    const adapter: Adapter = { async run(prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      budgets.push(opts.timeout_ms);
      if (budgets.length === 1) {
        return { output: 'partial', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true };
      }
      expect(prompt).toContain(`strictly larger immutable budget of ${opts.timeout_ms}ms`);
      return { output: 'finished', exitCode: 0, duration_ms: 1 };
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('coder'), created.runId, 'timeout retry', true, false,
    );
    expect(final.status).toBe('complete');
    expect(budgets).toEqual([3_600_000, 7_200_000]);
    const attempts = readStageStatus(projectDir, created.runId, 'work').attempts ?? [];
    expect(attempts.map((attempt) => attempt.timeout?.budgetMs)).toEqual(budgets);
    expect(attempts.map((attempt) => attempt.timeout?.terminationCause)).toEqual(['attempt_timeout', 'complete']);
  });

  it('does not let planner-authored max_retries suppress the configured timeout retry', { timeout: 10_000 }, async () => {
    mkdirSync(join(projectDir, 'config'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
      'default_timeout_ms: 50',
      'default_stage_technical_retries: 1',
      'adapter: mock',
      'model: default',
      'reasoning_effort: default',
    ].join('\n'));
    const yaml = [
      'name: planner-retry-suppression',
      'defaults:',
      '  max_iterations: 1',
      '  max_retries: 0',
      'stages:',
      '  - id: plan',
      '    role: planner',
      '    dynamic_dispatch: true',
    ].join('\n');
    const config = WorkflowConfigSchema.parse(parseYaml(yaml));
    const created = prepareRun(config, yaml);
    const budgets: number[] = [];
    let workCalls = 0;
    const adapter: Adapter = { async run(_prompt, _agent, opts) {
      const summary = summaryResult(opts);
      if (summary) return summary;
      if (opts.stageId === 'plan') {
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), [
          '- id: work',
          '  role: coder',
          '  scope: []',
          '  depends_on: [plan]',
          '  dependency_reasons: {plan: "Consumes the planner output."}',
          '  max_retries: 0',
          '  prompt_template: finish the dispatched work',
        ].join('\n'));
        return { output: 'planned', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      }
      workCalls++;
      budgets.push(opts.timeout_ms);
      if (workCalls === 1) {
        return { output: 'partial', exitCode: 124, duration_ms: opts.timeout_ms, timedOut: true };
      }
      return { output: 'finished', exitCode: 0, duration_ms: 1 };
    } };

    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      writeRoles('planner', 'coder'), created.runId, 'planner retry suppression', true, false,
    );
    const recorded = parseYaml(readFileSync(join(created.runDirPath, 'workflow.yaml'), 'utf-8')) as {
      stages: Array<{ id: string; max_retries?: number }>;
    };
    const observed = { workCalls, budgets, finalStatus: final.status };
    process.stdout.write(`PLAN_RETRY_SUPPRESSION=${JSON.stringify(observed)}\n`);
    expect(observed).toEqual({ workCalls: 2, budgets: [50, 100], finalStatus: 'complete' });
    expect((final.dispatchedStages as Array<{ id: string; max_retries?: number }> | undefined)
      ?.find((stage) => stage.id === 'work')).not.toHaveProperty('max_retries');
    expect(recorded.stages.find((stage) => stage.id === 'work')).not.toHaveProperty('max_retries');
  });

  it('charges primary retries, bounded backoff, and fallback to one attempt deadline', { timeout: 5_000 }, async () => {
    const stageId = 'adapter_chain';
    const { runId, runDirPath } = directRunDir(stageId);
    mkdirSync(join(projectDir, 'config'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
      'adapter: fallback',
      'model: default',
      'reasoning_effort: default',
    ].join('\n'));
    const clock = new ManualAttemptDeadlineClock();
    const adapterBudgets: number[] = [];
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary: Adapter = { async run(_prompt, _agent, opts) {
      primaryCalls++;
      adapterBudgets.push(opts.timeout_ms);
      if (primaryCalls === 1) setImmediate(() => clock.advance(5));
      if (primaryCalls === 2) setImmediate(() => clock.advance(7));
      return { output: '503 Service Unavailable', exitCode: 1, duration_ms: 1 };
    } };
    const fallback: Adapter = { async run(_prompt, _agent, opts) {
      fallbackCalls++;
      adapterBudgets.push(opts.timeout_ms);
      const started = Date.now();
      if (opts.abortSignal?.aborted) return { output: 'cancelled', exitCode: 137, duration_ms: 0 };
      return new Promise<RunResult>((resolve) => {
        opts.abortSignal?.addEventListener('abort', () => resolve({
          output: 'cancelled', exitCode: 137, duration_ms: Date.now() - started,
        }), { once: true });
        setImmediate(() => clock.advance(90));
      });
    } };
    const result = await runStage(primary, {
      stageId,
      role: { ...role, adapter: 'primary' },
      dependsOn: [],
      promptTemplate: 'adapter chain',
      timeout_ms: 90,
      deadlineClock: clock,
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
    expect(result.exitCode).toBe(124);
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
    expect(adapterBudgets).toEqual([90, 90, 90, 90]);
    const status = readStageStatus(projectDir, runId, stageId);
    expect(status.timeout?.terminationCause).toBe('attempt_timeout');
    expect(status.timeout?.deadlineOverrunMs).toBeLessThanOrEqual(ATTEMPT_CLOSE_OBSERVATION_CUSHION_MS);
    expect(clock.monotonicNow()).toBe(102);
    const ledgerName = readdirSync(join(runDirPath, 'stages', stageId))
      .find((name) => name.startsWith('attempt_deadline_') && name.endsWith('.jsonl'));
    expect(ledgerName).toBeTruthy();
    const events = readFileSync(join(runDirPath, 'stages', stageId, ledgerName!), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line) as { type: string; attemptId: string });
    expect(events.filter((event) => event.type === 'adapter_backoff_started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'adapter_phase_started')).toHaveLength(4);
    expect(new Set(events.map((event) => event.attemptId))).toEqual(new Set([status.timeout?.attemptId]));
  });

  it('includes fallback loading itself in the attempt-deadline race', { timeout: 5_000 }, async () => {
    const stageId = 'hanging_loader';
    const { runId, runDirPath } = directRunDir(stageId);
    mkdirSync(join(projectDir, 'config'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), [
      'adapter: fallback', 'model: default', 'reasoning_effort: default',
    ].join('\n'));
    const primary: Adapter = { async run() {
      return { output: '503 Service Unavailable', exitCode: 1, duration_ms: 1 };
    } };
    const clock = new ManualAttemptDeadlineClock();
    const result = await runStage(primary, {
      stageId, role: { ...role, adapter: 'primary' }, dependsOn: [], promptTemplate: 'loader',
      timeout_ms: 60,
      deadlineClock: clock,
      technicalRetry: {
        delaysMs: [],
        loadFallbackAdapter: async () => {
          setImmediate(() => clock.advance(60));
          return new Promise<Adapter>(() => {});
        },
      },
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    expect(clock.monotonicNow()).toBe(60);
    expect(result.exitCode).toBe(124);
    expect(readStageStatus(projectDir, runId, stageId).timeout?.terminationCause).toBe('attempt_timeout');
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
      stageId, role, dependsOn: [], promptTemplate: 'child close', timeout_ms: 40,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    const status = readStageStatus(projectDir, runId, stageId);
    expect(adapterSettled).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(status.timeout?.childClosedAt).toBeTruthy();
    expect(status.timeout?.deadlineOverrunMs).toBeGreaterThanOrEqual(100);
    expect(status.timeout?.deadlineOverrunMs).toBeLessThanOrEqual(ATTEMPT_CLOSE_OBSERVATION_CUSHION_MS);
  });

  it('kills an infinite local Node child at its immutable attempt deadline despite repeated extension requests', { timeout: 15_000 }, async () => {
    const stageId = 'infinite';
    const { runId, runDirPath } = directRunDir(stageId);
    const initialBudgetMs = 500;
    const requestedExtensionMs = 500;
    const requestCadenceMs = 100;
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
          attemptIndex: 1, requestedAt: new Date().toISOString(),
          requestedExtensionMs, reason: `progress sample ${requestNumber}`,
        }));
      };
      emit();
      const interval = setInterval(emit, requestCadenceMs);
      try {
        return await execWithTimeout(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: projectDir, timeout_ms: 10_000, abortSignal: opts.abortSignal,
        });
      } finally {
        clearInterval(interval);
        resolveAdapterSettled();
      }
    } };
    const result = await runStage(adapter, {
      stageId, role, dependsOn: [], promptTemplate: 'infinite', timeout_ms: initialBudgetMs,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    // The worker now treats adapter settlement as the child lifecycle
    // acknowledgement, so this promise must already be settled on return.
    await adapterSettled;
    const elapsed = Date.now() - started;
    const status = readStageStatus(projectDir, runId, stageId);
    const decisions = status.timeout?.decisionPaths.map((path) => readJson(join(runDirPath, path))) ?? [];
    expect(result.exitCode).not.toBe(0);
    expect(status.timeout?.terminationCause, JSON.stringify({ timeout: status.timeout, decisions })).toBe('attempt_timeout');
    expect(status.timeout?.deadlineReachedAt).toBeTruthy();
    expect(status.timeout?.budgetMs).toBe(initialBudgetMs);
    expect(status.timeout?.rejectedExtensionCount).toBeGreaterThanOrEqual(2);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    expect(decisions.every((decision) => decision.accepted === false && decision.grantedExtensionMs === 0)).toBe(true);
    expect(status.timeout?.deadlineOverrunMs).toBeLessThanOrEqual(ATTEMPT_CLOSE_OBSERVATION_CUSHION_MS);
    expect(elapsed).toBeLessThan(initialBudgetMs + (2 * ATTEMPT_CLOSE_OBSERVATION_CUSHION_MS));
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
      stageId, role, dependsOn: [], promptTemplate: 'abort', timeout_ms: 200,
      projectDir, runId, runDir: runDirPath, retries: 0,
    });
    expect(result.exitCode).toBe(137);
    const status = readStageStatus(projectDir, runId, stageId);
    expect(status.error).toContain('aborted by supervisor');
    expect(status.timeout).toMatchObject({ rejectedExtensionCount: 1, terminationCause: 'supervisor_abort' });
    const decision = readJson(findArtifact(join(runDirPath, 'stages', stageId), 'timeout_extension_decision_'));
    expect(decision).toMatchObject({ accepted: false, rejectionReason: 'a current-attempt ABORT already exists' });
  });
});
