import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Canonical } from './runtime-negotiation.js';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ArtifactContractSchema } from './artifact-declarations.js';
import type { StageConfig } from './scheduler.js';
import { RUN_STATUS, STAGE_STATUS, readStageStatus, runDir, updateRunState, type StoreState } from './store.js';

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const PlanRevisionRequestSchema = z.object({
  version: z.literal(1), requestId,
  runId: z.string().min(1), stageId: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
  attemptIndex: z.number().int().positive(), attemptStartedAt: z.string().datetime(),
  baseRevision: z.number().int().nonnegative(), baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1), stages: z.array(z.unknown()).min(1),
}).strict();
export type PlanRevisionRequest = z.infer<typeof PlanRevisionRequestSchema>;
export interface PlanControl {
  version: 1;
  stages: StageConfig[];
  capabilities: string[];
}
export function planDigest(stages: readonly StageConfig[]): string { return sha256Canonical(stages); }

function publishImmutable(path: string, content: string): void {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`PLAN_HISTORY_CONFLICT: immutable carrier ${path} differs`);
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    // Exclusive publication never exposes a partial history/decision carrier.
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(path, 'utf8') !== content) throw error;
    }
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temporary); }
}

/** Called only after whole-plan admission; the carrier precedes its committed reference. */
export function recordAdmittedPlan(state: StoreState, stages: StageConfig[], directory: string, reason: string, establishCapability = false, admission?: object): void {
  const digest = planDigest(stages);
  if (state.queryState?.planRevision?.digest === digest) return;
  const revision = (state.queryState?.planRevision?.revision ?? -1) + 1;
  const admittedAt = new Date().toISOString();
  const path = `plan_history/revision_${revision}_${randomUUID()}.json`;
  mkdirSync(join(directory, 'plan_history'), { recursive: true });
  publishImmutable(join(directory, path), `${JSON.stringify({ version: 1, runId: state.runId, revision, digest, admittedAt, reason, stages, admission }, null, 2)}\n`);
  const record = { revision, digest, admittedAt, reason, path };
  state.queryState = { ...(state.queryState ?? { version: 1 }), version: 1, planRevision: record, planHistory: [...(state.queryState?.planHistory ?? []), record] };
  state.planControl = { version: 1, stages, capabilities: establishCapability
    ? [...new Set([...(state.planControl?.capabilities ?? []), ...stages.flatMap((stage) => stage.scope ?? [])])]
    : state.planControl?.capabilities ?? stages.flatMap((stage) => stage.scope ?? []) };
}

export interface RevisionAdmission { pass: boolean; errors: string[]; warnings?: string[] }
export interface PlanRevisionDecision { version: 1; requestId: string; accepted: boolean; pending?: true; at: string; baseRevision: number; requestDigest: string; errors: string[]; revision?: number; digest?: string }

/** Complete candidates use exactly the caller's initial-plan mechanical admission. */
export function applyPlanRevision(input: {
  projectDir: string; runId: string; request: unknown;
  parseStage: (value: unknown) => StageConfig;
  admit: (stages: StageConfig[], state: StoreState) => RevisionAdmission;
  scopeContained: (scope: string, capabilities: readonly string[]) => boolean;
}): { state: StoreState; decision: PlanRevisionDecision; stages?: StageConfig[] } {
  const request = PlanRevisionRequestSchema.parse(input.request);
  const requestDigest = sha256Canonical(request);
  const directory = runDir(input.projectDir, input.runId);
  const decisionPath = join(directory, 'stages', request.stageId, `plan_revision_decision_${request.requestId}.json`);
  let decision: PlanRevisionDecision = { version: 1, requestId: request.requestId, accepted: false, at: new Date().toISOString(), baseRevision: request.baseRevision, requestDigest, errors: [] };
  const journalKey = `${request.stageId}:${request.requestId}`;
  let candidate: StageConfig[] | undefined;
  const state = updateRunState(input.projectDir, input.runId, (state) => {
    // The run-state transaction is the authority. A crash after its commit but
    // before decision-file publication must not turn acceptance into staleness.
    const previous = state.planRevisionDecisions?.[journalKey];
    if (!previous && existsSync(decisionPath)) throw new Error('PLAN_REVISION_DECISION_UNJOURNALED: decision projection has no committed run-state authority; preserve the carrier and submit a new request ID against the current admitted view');
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw new Error('PLAN_REVISION_REQUEST_CONFLICT: request ID was reused for different bytes');
      if (previous.accepted && !state.queryState?.planHistory?.some((entry) => entry.revision === previous.revision && entry.digest === previous.digest)) throw new Error('PLAN_REVISION_DECISION_UNBOUND: accepted decision has no matching admitted history');
      decision = previous;
      state.planRevisionDecisions = { ...state.planRevisionDecisions, [journalKey]: decision };
      candidate = previous.accepted ? state.planControl?.stages : undefined;
      return;
    }
    const fail = (message: string) => decision.errors.push(message);
    if (state.status !== RUN_STATUS.RUNNING) fail(`PLAN_REVISION_STATE: run must be running, observed ${state.status}`);
    if (request.runId !== input.runId) fail('PLAN_REVISION_RUN_BINDING: request must bind this run');
    const current = state.queryState?.planRevision;
    if (!current || current.revision !== request.baseRevision || current.digest !== request.baseDigest) fail('PLAN_REVISION_STALE: baseRevision/baseDigest must match the admitted current plan');
    if (!state.planControl || planDigest(state.planControl.stages) !== current?.digest) fail('PLAN_REVISION_INTEGRITY: current plan bytes do not match the admitted digest');
    let author = state.stages[request.stageId];
    try { author = readStageStatus(input.projectDir, input.runId, request.stageId); } catch { /* retain projection */ }
    // Bind immutable execution facts, not a moving latest-attempt projection.
    // A technical retry cannot erase the execution that authored the proposal;
    // unchanged executed duties, the base digest and full admission still apply.
    const attempt = author?.attempts?.find((entry) => entry.index === request.attemptIndex && entry.startedAt === request.attemptStartedAt);
    if (!attempt) fail('PLAN_REVISION_ATTEMPT_BINDING: requester must name a retained execution by index and startedAt');
    const active = attempt?.status === STAGE_STATUS.RUNNING
      || Object.values(state.stages).some((stage) => stage.status === STAGE_STATUS.RUNNING);
    if (active && !decision.errors.length) {
      decision.pending = true;
      decision.errors.push('PLAN_REVISION_NOT_AT_BOUNDARY: waiting for active executions to settle');
      return; // Waiting is not a durable refusal; retry this request at idle.
    }
    if (active) fail('PLAN_REVISION_NOT_AT_BOUNDARY: active stages cannot be revised');
    if (attempt && ((attempt.status !== STAGE_STATUS.COMPLETE && attempt.status !== STAGE_STATUS.FAILED) || !attempt.completedAt)) {
      fail('PLAN_REVISION_ATTEMPT_BINDING: named execution must be settled complete or failed with completedAt');
    }
    try {
      const original = new Map((state.planControl?.stages ?? []).map((stage) => [stage.id, stage]));
      candidate = request.stages.map((raw) => {
        const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
        const previous = typeof id === 'string' ? original.get(id) : undefined;
        if (previous && canonicalJson(raw) === canonicalJson(previous)) return previous;
        return input.parseStage(raw);
      });
      const ids = new Set(candidate.map((stage) => stage.id));
      if (ids.size !== candidate.length) fail('PLAN_REVISION_DUPLICATE_ID: every stage ID must be unique');
      for (const previous of original.values()) {
        const next = candidate.find((stage) => stage.id === previous.id);
        if (!next) { fail(`PLAN_REVISION_OBLIGATION_REMOVED: retain existing stage ${previous.id}`); continue; }
        const executed = (state.stages[previous.id]?.attempts?.length ?? 0) > 0 || [STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED, STAGE_STATUS.RUNNING, 'suspended'].includes(state.stages[previous.id]?.status ?? '');
        if (executed && planDigest([previous]) !== planDigest([next])) fail(`PLAN_REVISION_EXECUTED_STAGE: ${previous.id} identity, duties and history are immutable`);
        if (canonicalJson(previous.artifact_contract) !== canonicalJson(next.artifact_contract)) fail(`PLAN_REVISION_DUTIES_CHANGED: retain admitted artifact duties for ${previous.id}`);
        if (previous.condition !== next.condition) fail(`PLAN_REVISION_EXECUTION_CHANGED: retain admitted execution condition for ${previous.id}; a changed predicate can suppress existing artifact duties`);
        if (!previous.artifact_contract && previous.prompt_template !== next.prompt_template) fail(`PLAN_REVISION_LEGACY_DUTIES: ${previous.id} has no explicit contract; migrate at a new initial-plan boundary before changing its text`);
      }
      for (const stage of candidate) {
        if (!original.has(stage.id)) {
          const contract = ArtifactContractSchema.safeParse(stage.artifact_contract);
          if (!contract.success) fail(`ARTIFACT_DECLARATION_REQUIRED: new stage ${stage.id} must declare artifact_contract {version:1,produces:[],reads:[]}`);
        }
        for (const scope of stage.scope ?? []) if (!input.scopeContained(scope, state.planControl?.capabilities ?? [])) fail(`PLAN_REVISION_SCOPE_WIDENED: ${stage.id}.scope ${scope} exceeds the initial task capability`);
      }
      const admission = input.admit(candidate, state);
      decision.errors.push(...admission.errors);
      if (!admission.pass && !admission.errors.length) fail('PLAN_REVISION_ADMISSION_FAILED: candidate was not admitted');
      if (!decision.errors.length) {
        recordAdmittedPlan(state, candidate, directory, request.reason, false, admission);
        for (const stage of candidate) state.stages[stage.id] ??= { status: 'pending', retries: 0 };
        state.dispatchedStages = candidate.filter((stage) => !stage.dynamic_dispatch);
        state.plan = candidate;
        decision.accepted = true;
        decision.revision = state.queryState!.planRevision!.revision;
        decision.digest = state.queryState!.planRevision!.digest;
      }
    } catch (error) { fail(`PLAN_REVISION_INVALID: ${error instanceof Error ? error.message : String(error)}`); }
    state.planRevisionDecisions = { ...state.planRevisionDecisions, [journalKey]: decision };
  });
  if (!decision.pending) {
    mkdirSync(join(directory, 'stages', request.stageId), { recursive: true });
    publishImmutable(decisionPath, `${JSON.stringify(decision, null, 2)}\n`);
  }
  return { state, decision, ...(decision.accepted ? { stages: candidate } : {}) };
}
