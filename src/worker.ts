import { stageLiveLogPath, readStageLiveLogPath } from './stage-live-log.js';
import { isRetryableAdapterFailure } from './adapters/failure.js';
import { writeFileSync, appendFileSync, mkdirSync, unlinkSync } from './engine-fs.js';


// Module: worker
import { withEngineIntegrity } from './engine-integrity.js';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { hashRollbackFileSync } from './rollback-content-store.js';
import { recordInvocationInput } from './run-state-view.js';
import { finalizeStageSessions, isSessionUuid, readSession } from './adapter-session.js';
import { declaredOutputFacts, runStateContext } from './run-state-access.js';
import { providerFailureDetail } from './provider-result.js';
import { invocationUsageFields, sumInvocationUsage } from './invocation-usage.js';
import { renderPlanInterface, renderPlannerAdmissionCheck } from './plan-interface.js';
import { ARTIFACT_CONTRACT_SCHEMA_DOC, artifactDeclarationErrors, type ArtifactContract } from './artifact-declarations.js';
import { join, relative, resolve } from 'node:path';
import type { Adapter, AgentConfig, CommandLifecycleEvent, RunResult } from './adapters/base.js';
import { runProcessAbortSignal } from './adapters/base.js';
export { ADAPTER_FAILURE_PATTERNS, classifyAdapterFailure } from './adapters/failure.js';
import { buildStagePrompt, HANDOFF_SCHEMA, RECORDED_HANDOFF_SCHEMA, parseStageRecord } from './handoff.js';
import type { Schema } from './reality-gate/checks/json-schema-match.js';
import { recordGateValidationDelta, settleGateValidationEvidence } from './scheduler/sched_settlement/gate-validation.js';
import { validateGateCriterionEvidence, validateGateRepairability, explicitPassContradiction } from './scheduler/sched_settlement/gate-evidence.js';
import { AuditFindingsSchema } from './scoped-audit-repair.js';
import { getDefaultTimeout } from './config.js';
import { parseBriefFrontmatter } from './scheduler/sched_admission/brief-contract.js';
import { renderPlannerPolicies } from './planner-policies.js';
import { extractBriefCriteria } from './brief-criteria.js';
import { parseStageAbortSignal } from './abort-signal.js';
import {
  RUN_STATUS,
  beginStageAttempt,
  closeStageAttempt,
  settleStageAttempt,
  StageAttemptSettlementError,
  readStageStatus,
  readRunState,
  writeStageStatus,
  writeStageInput,
  writeStageOutput,
  atomicWrite,
  TERMINAL_STATUSES,
  VERDICT_CONTRACT_DOC,
  PHASE_METADATA_FIELDS,
} from './store.js';
import type { AttemptAttribution, StageAttemptTimeoutSummary, StageStatus } from './store.js';
import {
  ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS,
  AttemptDeadlineController,
  type AttemptDeadlineClock,
} from './attempt-deadline.js';
import {
  guidanceForStageFromText,
  guidanceForExecution,
  appendGuidanceEnvelope,
  readGuidanceForStage,
  renderGuidanceDelivery,
  renderGuidanceEnvelope,
  routePendingOperatorGuidanceToStage,
} from './guidance.js';
import { attemptEventFields, recordRunEvent } from './run-events.js';
import { parseExplicitCommandTimeout } from './command-activity.js';
import {
  commandFingerprint,
  parseStageCommandInterrupt,
  type StageCommandInterruptSignal,
} from './command-interrupt.js';
import {
  compareLiveConstraintContentIdentities,
  readLiveConstraintContentIdentity,
  type LiveConstraintContentIdentity,
  type LiveConstraintGuardFactory,
  type LiveConstraintInvocationResult,
} from './live-constraint-guard.js';
import {
  inspectStageArtifactContract,
  writeStageArtifactContractAudit,
  stageArtifactProduction,
} from './stage-artifact-contract.js';
import { readAcceptedScopeRevisionDecisions } from './runtime-negotiation.js';
import { buildGateDispatchPreamble } from './scheduler/sched_settlement/gate-archives.js';

/** Put the canonical IDs beside the planner's first proposal instructions. */
export function plannerCriterionAssignmentContext(brief: string): string {
  const criteria = extractBriefCriteria(brief).criteria;
  if (criteria.length === 0) return '';
  return [
    '# First-proposal criterion assignments',
    'Empty/omitted criterion_refs assign all criteria conservatively. Use these exact IDs only when assigning explicit subsets. Ordinary work needs a downstream independent gate.',
    ...criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
  ].join('\n');
}

export interface StageOpts {
  /** Scheduled stages return JSON; standalone legacy workers remain readable. */
  outputSchema?: Schema;
  artifactContract?: ArtifactContract;
  planRevision?: { revision: number; digest: string };
  artifactStatuses?: Record<string, StageStatus>;
  /** Trusted engine provider injection; never supplied by a model declaration. */
  stageId: string;
  role: AgentConfig;
  /** Scheduler declaration, captured before role loading or plan replacement. */
  attribution?: AttemptAttribution;
  dependsOn: string[];
  promptTemplate: string;
  /** Planner-authored stage text before scheduler contracts are appended. */
  artifactObligationTemplate?: string;
  timeout_ms: number;
  /** Internal dependency injection for deterministic attempt-deadline tests. */
  deadlineClock?: AttemptDeadlineClock;
  /** Internal dependency injection for deterministic attempt-deadline tests. */
  technicalRetry?: {
    delaysMs?: readonly number[];
  };
  /** The worker awaits scope admission, then audit classification, before publication. */
  settlementBoundary?: (phase: 'child_closed' | 'attempt_closed') => Promise<boolean>;
  projectDir: string;
  runId: string;
  runDir: string;
  retries: number;
  skills?: string;
  stageSkills?: string[];
  availableRoles?: string;
  availableChecks?: string;
  availableSkills?: string;
  resultSchema?: string;
  contextInventory?: string;
  ledgerDigest?: string;
  taskDescription?: string;
  isGate?: boolean;
  gateContext?: Pick<Parameters<typeof buildGateDispatchPreamble>[0], 'authorIds' | 'fixStageIds' | 'roundDiffPath'>;
  /** A gate reviews this author's result, so a blocked result settles the stage for that gate to confirm or reject. */
  gateReviewed?: boolean;
  dynamicDispatch?: boolean;
  researchOutcomeGate?: boolean;
  criterionRefs?: string[];
  resumeSessionId?: string;
  sessionOwnerStageId?: string;
  preserveSession?: boolean;
  /** Scheduler-resolved effective project-write capability. Snapshot fallback
   * observes only these roots; run-level scope enforcement owns global change
   * detection and rollback. */
  projectWriteScope?: string[];
  /** Scheduler-owned canonical scope policy bound to the run rollback baseline. */
  liveConstraintGuardFactory?: LiveConstraintGuardFactory;
}

const ADAPTER_RETRY_DELAYS = [30_000, 60_000, 120_000];

const PARALLEL_EXECUTION_BOUNDARY = '# Parallel execution boundary\n'
  + 'Other stages share this wave. Do not revert or stage their edits. Never use git add . or git commit -a. '
  + 'Shared git status or diff does not attribute changes to you; the engine records per-attempt writes.';

function inferAdapterName(adapter: Adapter): string | undefined {
  const name = adapter.constructor?.name;
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return lower.endsWith('adapter') ? lower.slice(0, -'adapter'.length) : lower;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.fc', '.next', '.cache', '.pytest_cache', 'coverage', '__pycache__', '.venv', 'venv', '.tox', 'target', 'out', '.gradle']);

function literalScopeRoot(scope: string): string | undefined {
  const normalized = scope.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  const meta = normalized.search(/[!*?{}[\]()]/);
  const prefix = (meta < 0 ? normalized : normalized.slice(0, meta)).replace(/\/+$/, '');
  if (!prefix) return undefined;
  return prefix;
}

function snapshotScopedContent(
  projectDir: string,
  scopes: readonly string[],
): Map<string, LiveConstraintContentIdentity> {
  const snap = new Map<string, LiveConstraintContentIdentity>();
  function walk(dir: string, depth: number) {
    if (depth > 20) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const full = join(dir, e);
      try {
        const st = lstatSync(full);
        if (st.isDirectory()) walk(full, depth + 1);
        else snap.set(full, readLiveConstraintContentIdentity(full));
      } catch { /* skip */ }
    }
  }
  for (const scope of scopes) {
    const root = literalScopeRoot(scope);
    if (!root) continue;
    const absolute = join(projectDir, root);
    try {
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, 0);
      else snap.set(absolute, readLiveConstraintContentIdentity(absolute));
    } catch { /* an exact declared output may not exist yet */ }
  }
  return snap;
}

function diffScopedArtifacts(
  before: Map<string, LiveConstraintContentIdentity>,
  projectDir: string,
  scopes: readonly string[],
): string[] {
  const after = snapshotScopedContent(projectDir, scopes);
  const changed: string[] = [];
  const absent: LiveConstraintContentIdentity = { state: 'absent' };
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (compareLiveConstraintContentIdentities(before.get(path) ?? absent, after.get(path) ?? absent) !== 'different') continue;
    changed.push(relative(projectDir, path).replace(/\\/g, '/'));
  }
  return changed.sort();
}

/** Keep history in attempts while ensuring the live top level describes only the new execution. */
export function freshRunningStageProjection(
  previous: StageStatus | undefined,
  retries: number,
  startedAt = new Date().toISOString(),
): StageStatus {
  const next: StageStatus = {
    ...(previous ?? { status: 'pending', retries }),
    status: 'running',
    retries,
    startedAt,
  };
  for (const field of [
    'exitCode', 'duration_ms', 'artifacts', 'completedAt', 'error', 'tokens_in', 'tokens_out',
    'writes', 'writeAttribution', 'constraintAudit', 'timeout', 'acceptedFrom',
  ] as const) delete next[field];
  return next;
}

export function renderStageAbortOutput(
  output: string,
  stageId: string,
  executionIndex: number,
  reason?: string,
): string {
  if (output.trim().length > 0) return output;
  return [
    '# Execution aborted by engine',
    '',
    reason?.trim() || 'The engine stopped this execution before it produced output.',
    '',
    `Stage: ${stageId}`,
    `Execution: ${executionIndex}`,
  ].join('\n');
}

export interface AttemptEvidenceGeneration {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  segmentStart: number;
  /** Content fingerprints at the boundary for shared artifact slots. An
   * unchanged prior-attempt verdict is therefore never current evidence. */
  artifactBaselines: Record<string, string | null>;
  recordedAt: string;
}

function attemptArtifactFingerprint(path: string): string | null {
  try { return hashRollbackFileSync(path).sha256; } catch { return null; }
}

/** Mark the attempt stream so the watchdog excludes its bookkeeping bytes. */
export function beginAttemptEvidenceGeneration(
  runDirectory: string,
  stageId: string,
  attemptIndex: number,
  attemptStartedAt: string,
): AttemptEvidenceGeneration {
  const stagePath = join(runDirectory, 'stages', stageId);
  const logPath = stageLiveLogPath(runDirectory, stageId, attemptIndex, attemptStartedAt);
  mkdirSync(stagePath, { recursive: true });
  const marker = `\n<!-- flowcrew-attempt ${JSON.stringify({ version: 1, stageId, attemptIndex, attemptStartedAt })} -->\n`;
  appendFileSync(logPath, marker, 'utf-8');
  const generation: AttemptEvidenceGeneration = {
    version: 1,
    stageId,
    attemptIndex,
    attemptStartedAt,
    segmentStart: statSync(logPath).size,
    artifactBaselines: {
      output: attemptArtifactFingerprint(join(stagePath, `output_attempt_${attemptIndex}.md`)),
      verdict: attemptArtifactFingerprint(join(runDirectory, `verdict_${stageId}.json`)),
    },
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(join(stagePath, 'attempt_generation.json'), `${JSON.stringify(generation, null, 2)}\n`, 'utf-8');
  return generation;
}

/**
 * Project-local acceptance contract (P3). The PROJECT declares its domain hard
 * constraints + metric in <project>/.flowcrew/contract.yaml; the planner reads it
 * (injected as {project_contract}) and wires deterministic gates from it. Domain
 * semantics live with the project — never in the engine or the planner prompt.
 */
function loadProjectContract(projectDir: string): string {
  try {
    const p = join(projectDir, '.flowcrew', 'contract.yaml');
    if (!existsSync(p)) return 'none';
    const body = readFileSync(p, 'utf-8').trim();
    return body || 'none';
  } catch { return 'none'; }
}

export async function runStage(
  adapter: Adapter,
  opts: StageOpts,
): Promise<RunResult> {
  // Direct already supplies the whole admitted task. Its guarantees are the
  // same worker/scheduler checks, rather than a second process brief.
  const runState = existsSync(join(opts.runDir, 'run.json'))
    ? readRunState(opts.projectDir, opts.runId) : undefined;
  const direct = runState?.workflowName === 'direct';
  const promptTemplate = direct && opts.taskDescription && runState.taskDescription
    ? opts.promptTemplate.replace(opts.taskDescription.trim(), () => runState.taskDescription!)
    : opts.promptTemplate;
  const skillNames = opts.stageSkills ?? [];
  let prompt = buildStagePrompt({
    dependsOn: opts.dependsOn,
    promptTemplate,
    projectDir: opts.projectDir,
    runId: opts.runId,
    runDir: opts.runDir,
    skills: opts.skills,
    skillNames,
    availableRoles: opts.availableRoles,
    availableSkills: opts.availableSkills,
    taskDescription: opts.taskDescription,
    isGate: direct ? false : opts.isGate,
    researchOutcomeGate: opts.researchOutcomeGate,
    criterionRefs: direct && !opts.isGate ? undefined : opts.criterionRefs,
    stageId: opts.stageId,
    role: opts.role.name,
    handoffVisibility: direct && opts.isGate ? 'none' : opts.role.handoff_visibility,
  });

  const attribution = opts.attribution ?? {
    role: opts.role.name,
    iteration: existsSync(join(opts.runDir, 'run.json'))
      ? readRunState(opts.projectDir, opts.runId).currentIteration ?? 1
      : 1,
  };
  const runningStatus = beginStageAttempt(opts.projectDir, opts.runId, opts.stageId, opts.retries, undefined, attribution);
  const previous = runningStatus.attempts?.at(-2);
  if (previous?.disposition === 'superseded') {
    recordRunEvent(opts.projectDir, opts.runId, {
      type: 'attempt_results_updated', runId: opts.runId, timestamp: new Date().toISOString(),
      stageId: opts.stageId, ...attemptEventFields(previous), source: 'worker',
      detail: 'attempt result replaced by another execution',
    });
  }
  const attemptIndex = runningStatus.attempts?.at(-1)?.index;
  if (attemptIndex === undefined) throw new Error(`Stage ${opts.stageId} started without an execution index`);
  const attemptStartedAt = runningStatus.attempts?.at(-1)?.startedAt;
  if (!attemptStartedAt) throw new Error(`Stage ${opts.stageId} started without an execution start timestamp`);
  // Every execution enters here, including technical retries, repairs and
  // resumed sessions. Arm and publish one clock before preparing its work.
  const attemptDeadline = new AttemptDeadlineController({
    budgetMs: opts.timeout_ms,
    ledgerDir: join(opts.runDir, 'stages', opts.stageId),
    executionIndex: attemptIndex,
    ...(opts.deadlineClock ? { clock: opts.deadlineClock } : {}),
  });
  const effectiveBudgetMs = attemptDeadline.budgetMs;
  try {
  const timeout = attemptDeadline.snapshot();
  const freshRunningStatus = freshRunningStageProjection(runningStatus, opts.retries, attemptStartedAt);
  freshRunningStatus.timeout = timeout;
  freshRunningStatus.attempts = runningStatus.attempts?.map(attempt =>
    attempt.index === attemptIndex ? { ...attempt, timeout } : attempt);
  writeStageStatus(opts.projectDir, opts.runId, opts.stageId, freshRunningStatus);
  if (opts.isGate) prompt = `${buildGateDispatchPreamble({
    runDirPath: opts.runDir, gateId: opts.stageId,
    evaluationRound: runningStatus.attempts!.length, priorAttemptCount: runningStatus.attempts!.length - 1,
    ...opts.gateContext,
  })}\n\n${prompt}`;
  const guidanceBeforePrompt = readGuidanceForStage(opts.runDir, opts.stageId, attemptIndex);
  // Retain delivered, targeted notices across execution boundaries. Their
  // original attempt identity remains explicit; only re-admission grants scope.
  try {
    const priorReceipt = readFileSync(join(opts.runDir, 'stages', opts.stageId, 'guidance_consumed.md'), 'utf-8');
    for (const attempt of runningStatus.attempts ?? []) {
      for (const entry of guidanceForStageFromText(priorReceipt, opts.stageId, attempt.index)) {
        if (!guidanceBeforePrompt.some((current) => current.id === entry.id)) guidanceBeforePrompt.push(entry);
      }
    }
  } catch { /* first execution has no delivery receipt */ }
  const guidanceBlock = (entries: ReturnType<typeof readGuidanceForStage>): string =>
    renderGuidanceDelivery(guidanceForExecution(entries, attemptIndex));
  const liveConstraintGuard = opts.liveConstraintGuardFactory?.({ attemptIndex, attemptStartedAt });
  prompt = prompt
    .replace(/<current execution index>/g, String(attemptIndex))
    .replace(/<current attempt>/g, String(attemptIndex)); // legacy prompt templates
  const priorAttempt = runningStatus.attempts?.at(-2);
  if (priorAttempt && (priorAttempt.status === RUN_STATUS.FAILED || priorAttempt.status === 'suspended')) {
    prompt += `\n\n# Own-stage continuation evidence\nRead ${opts.runDir}/stages/${opts.stageId}/output_attempt_${priorAttempt.index}.md and ${readStageLiveLogPath(opts.runDir, opts.stageId, priorAttempt.index)} for the previous execution's progress. Its attributed writes were ${JSON.stringify(priorAttempt.writes ?? [])}. Verify these existing artifacts and continue the declared duties; do not infer success from the prior attempt. An unavailable thread uses the full current duties and these same evidence references.`;
  }
  // buildStagePrompt ran before the execution index existed and intentionally
  // included only run-wide guidance. Add notices bound to this execution now.
  const scopedAtStart = guidanceBeforePrompt.filter((entry) => entry.attemptIndex !== undefined);
  if (scopedAtStart.length > 0) prompt += `\n\n${guidanceBlock(scopedAtStart)}`;
  beginAttemptEvidenceGeneration(opts.runDir, opts.stageId, attemptIndex, attemptStartedAt);
  recordRunEvent(opts.projectDir, opts.runId, {
    type: 'attempt_started',
    ...attemptEventFields(runningStatus.attempts?.at(-1)),
    runId: opts.runId,
    timestamp: attemptStartedAt,
    stageId: opts.stageId,
    source: 'worker',
  });

  const guidanceReceiptPath = join(opts.runDir, 'stages', opts.stageId, 'guidance_consumed.md');
  const deliveredGuidanceIds = new Set(guidanceBeforePrompt.map((entry) => entry.id));
  const deliveredGuidance = [...guidanceBeforePrompt];
  let receiptContent: string | undefined;
  const persistGuidanceReceipt = (): void => {
    try {
      mkdirSync(join(opts.runDir, 'stages', opts.stageId), { recursive: true });
      const rendered = renderGuidanceDelivery(deliveredGuidance);
      const content = rendered ? `${rendered}\n` : 'No guidance was delivered to this execution.\n';
      if (content === receiptContent) return;
      writeFileSync(guidanceReceiptPath, content, 'utf-8');
      receiptContent = content;
    } catch { /* the run event remains the delivery audit */ }
  };
  const consumeNewGuidance = (
    boundary: 'attempt_start' | 'adapter_invocation' | 'tool_call_start' | 'tool_call_completion' | 'operator_interrupt',
    boundaryInvocationIndex?: number,
    commandEvent?: Pick<CommandLifecycleEvent, 'id' | 'command'>,
  ): ReturnType<typeof readGuidanceForStage> => {
    let entries: ReturnType<typeof readGuidanceForStage> = [];
    let checkFailed = false;
    try {
      routePendingOperatorGuidanceToStage(opts.runDir, opts.stageId);
      entries = readGuidanceForStage(opts.runDir, opts.stageId, attemptIndex)
        .filter((entry) => !deliveredGuidanceIds.has(entry.id));
      for (const entry of entries) {
        deliveredGuidanceIds.add(entry.id);
        deliveredGuidance.push(entry);
      }
      persistGuidanceReceipt();
    } catch { checkFailed = true; }
    if (!entries.length && !checkFailed && boundary !== 'attempt_start' && boundary !== 'adapter_invocation') return entries;
    const currentDelivery = guidanceForExecution(boundary === 'attempt_start' ? deliveredGuidance : entries, attemptIndex);
    recordRunEvent(opts.projectDir, opts.runId, {
      type: 'guidance_delivery_checked',
      runId: opts.runId,
      timestamp: new Date().toISOString(),
      stageId: opts.stageId,
      attemptIndex,
      attemptStartedAt,
      boundary,
      ...(boundaryInvocationIndex === undefined ? {} : { invocationIndex: boundaryInvocationIndex }),
      ...(commandEvent?.id ? { commandId: commandEvent.id } : {}),
      ...(checkFailed ? { checkFailed: true } : {}),
      guidanceIds: currentDelivery.map((entry) => entry.id),
      delivered: currentDelivery.length > 0,
      detail: entries.length > 0
        ? `delivered ${entries.length} new guidance envelope${entries.length === 1 ? '' : 's'} at ${boundary}`
        : boundary === 'attempt_start' && currentDelivery.length > 0
          ? `confirmed ${currentDelivery.length} guidance envelope${currentDelivery.length === 1 ? '' : 's'} at attempt start`
          : `no new guidance available at ${boundary}`,
      source: 'worker',
    });
    return entries;
  };
  // buildStagePrompt read the first snapshot. Close the small read/build race by
  // appending only envelopes that appeared after that snapshot.
  const arrivedAtAttemptStart = consumeNewGuidance('attempt_start');
  if (arrivedAtAttemptStart.length > 0) prompt += `\n\n${guidanceBlock(arrivedAtAttemptStart)}`;

  // Auto-prepend task brief to the role's system prompt so the brief sits in
  // a stable prefix position across stages. This:
  //   - Frees `prompt_template` in dispatch.yaml from having to repeat the brief;
  //   - Anthropic prompt caching can deduplicate the brief across stages of the
  //     same role (cache_read_input_tokens benefits) because the system prompt
  //     prefix is byte-identical;
  //   - Codex `developer_instructions` similarly benefits from auto-caching.
  // The brief lives at <run_dir>/task_brief.md and is written by the dispatcher
  // (cli.ts cmdQuick or the dashboard). If absent, we skip prepending.
  const projectContract = opts.role.prompt.includes('{project_contract}')
    ? loadProjectContract(opts.projectDir) : 'none';
  let resolvedSystemPrompt = (direct
    ? (opts.isGate
      ? "Decide independently whether the change achieves the brief's outcome and what it breaks. Return a short verdict and concrete defects with evidence."
      : "Implement the brief's outcome. You decide how. Return a short result; the engine runs configured validation and checks declared outputs.")
      + '\nRun unattended. Do not access credentials or signal processes you did not start. Use private scratch at $TMPDIR.'
    : opts.role.prompt)
    .replace(/\{available_roles\}/g, opts.availableRoles ?? '')
    .replace(/\{available_checks\}/g, opts.availableChecks ?? 'none')
    .replace(/\{available_skills\}/g, opts.availableSkills ?? 'none')
    .replace(/\{result_schema\}/g, opts.resultSchema ?? 'none')
    .replace(/\{context_inventory\}/g, opts.contextInventory ?? 'none')
    .replace(/\{ledger_digest\}/g, opts.ledgerDigest ?? 'none')
    .replace(/\{terminal_statuses\}/g, TERMINAL_STATUSES.join(', '))
    .replace(/\{verdict_contract\}/g, VERDICT_CONTRACT_DOC)
    .replace(/\{artifact_contract_schema\}/g, () => ARTIFACT_CONTRACT_SCHEMA_DOC)
    .replace(/\{phase_metadata_fields\}/g, PHASE_METADATA_FIELDS)
    .replace(/\{project_contract\}/g, projectContract)
    .replace(/\{run_dir\}/g, opts.runDir)
    .replace(/\{project\}/g, opts.projectDir)
    .replace(/\{default_timeout_ms\}/g, getDefaultTimeout());
  try {
    const taskBriefPath = join(opts.runDir, 'task_brief.md');
    if (!direct && existsSync(taskBriefPath)) {
      const brief = readFileSync(taskBriefPath, 'utf-8').trim();
      if (brief) {
        resolvedSystemPrompt = `# Task Brief\n\n${brief}\n\n---\n\n${resolvedSystemPrompt}`;
      }
    }
  } catch { /* non-critical */ }

  // Planner-only history remains target-filtered. An archived instruction for
  // an implementation or gate stage must not become a planner instruction.
  if (opts.dynamicDispatch || opts.role.name === 'planner') {
    try {
      const historyDir = join(opts.runDir, 'guidance_history');
      if (existsSync(historyDir)) {
        const archives = readdirSync(historyDir)
          .filter((f) => /^iter_\d+\.md$/.test(f))
          .sort((a, b) => {
            const na = parseInt(a.match(/\d+/)![0], 10);
            const nb = parseInt(b.match(/\d+/)![0], 10);
            return na - nb;
          });
        if (archives.length > 0) {
          const latest = archives[archives.length - 1];
          const prev = readFileSync(join(historyDir, latest), 'utf-8');
          const targeted = renderGuidanceDelivery(guidanceForStageFromText(prev, opts.stageId));
          if (targeted) {
            resolvedSystemPrompt = `# Previous iteration's targeted guidance\n\n${targeted}\n\n---\n\n${resolvedSystemPrompt}`;
          }
        }
      }
    } catch { /* non-critical */ }
    const criterionContext = plannerCriterionAssignmentContext(opts.taskDescription ?? '');
    if (criterionContext) resolvedSystemPrompt += `\n\n${criterionContext}`;
    if (opts.dynamicDispatch) resolvedSystemPrompt += `\n\n${renderPlanInterface()}\n\n${renderPlannerAdmissionCheck(opts.projectDir, opts.runDir)}`;
    const briefPath = join(opts.runDir, 'task_brief.md');
    const brief = existsSync(briefPath) ? readFileSync(briefPath, 'utf-8') : opts.taskDescription ?? '';
    const policies = renderPlannerPolicies(parseBriefFrontmatter(brief).plannerPolicies ?? []);
    if (policies) resolvedSystemPrompt += `\n\n${policies}`;
  }

  const resolvedRole = { ...opts.role, prompt: resolvedSystemPrompt };
  if (opts.outputSchema) {
    const judgement = opts.isGate
      ? 'Judge assigned criteria in the context of the full brief, including permitted outcomes and stopping conditions. Stage instructions and extracted criteria cannot narrow or replace the outcomes the brief permits. Pass when an allowed outcome has all required evidence, including a permitted negative or blocked report. Reject missing required attempts, measurements or artifacts. '
      : '';
    prompt += `\n\n# Stage result\nReturn your final answer as one JSON document matching this schema:\n${JSON.stringify(opts.outputSchema)}\nThe engine validates and publishes that answer as the stage record${opts.isGate ? ` and verdict_${opts.stageId}.json` : ''}. This result contract supersedes older prose handoff, stage or verdict-file instructions. ${judgement}Write declared human deliverables within admitted capabilities. Evidence references name reproducible files or commands.`;
  }
  if (opts.artifactContract && (!direct || opts.artifactContract.produces.length || opts.artifactContract.reads.length)) prompt += `\n\n# Declared output and input locations\n${JSON.stringify(opts.artifactContract)}`;

  const projectWriteScope = opts.projectWriteScope ?? [];
  const beforeSnapshot = snapshotScopedContent(opts.projectDir, projectWriteScope);
  // A declared run product may belong to later work, but an available product
  // cannot disappear during this attempt. This fact was only model advice;
  // deletion alone cannot preserve it, so bind the engine check to this start.
  const availableProductsAtStart = existsSync(join(opts.runDir, 'run.json'))
    ? declaredOutputFacts(opts.projectDir, opts.runId).filter(output => output.available) : [];
  const production = artifactDeclarationErrors(opts.artifactContract, opts.stageId).length === 0 ? stageArtifactProduction({
    runId: opts.runId, stageId: opts.stageId, projectDir: opts.projectDir, runDir: opts.runDir,
    template: opts.artifactObligationTemplate ?? '', artifactContract: opts.artifactContract,
    isGate: opts.isGate, planRevision: opts.planRevision, attemptIndex, attemptStartedAt,
  }) : undefined;

  // Abort files are one-shot envelopes owned by this exact stage attempt. A
  // crash can leave a file behind, so ownership is validated on every launch;
  // stale/malformed envelopes are warned about and removed without firing.
  const attemptAbortController = new AbortController();
  const abortSignalPath = join(opts.runDir, 'signals', `abort_${opts.stageId}.json`);
  const commandInterruptSignalPath = join(opts.runDir, 'signals', `interrupt_${opts.stageId}.json`);
  const liveLogPath = stageLiveLogPath(opts.runDir, opts.stageId, attemptIndex, attemptStartedAt);
  const activeCommands = new Map<string, CommandLifecycleEvent>();
  const interruptedCommands = new Map<string, StageCommandInterruptSignal>();
  let activeInvocationAbortController: AbortController | undefined;
  let activeInvocationIndex: number | undefined;
  type CommandBoundaryControl = {
    kind: 'guidance' | 'timeout_projection' | 'operator_interrupt' | 'scope_revision';
    command: CommandLifecycleEvent;
    guidance: ReturnType<typeof readGuidanceForStage>;
    interrupt?: StageCommandInterruptSignal;
  };
  let commandBoundaryControl: CommandBoundaryControl | undefined;
  let scopeRevisionBoundaryReached = false;
  let stageAborted = false;
  let approvalSuspended = false;
  let approvalRequestId: string | undefined;
  let approvalRequestingStageId: string | undefined;
  let abortReason = '';
  let terminationCause: StageAttemptTimeoutSummary['terminationCause'];
  const attemptElapsedMs = (): number => attemptDeadline.elapsedMs();

  const removeAbortSignal = (): void => {
    try {
      if (existsSync(abortSignalPath)) unlinkSync(abortSignalPath);
    } catch { /* non-critical */ }
  };
  const removeCommandInterruptSignal = (): void => {
    try {
      if (existsSync(commandInterruptSignalPath)) unlinkSync(commandInterruptSignalPath);
    } catch { /* non-critical */ }
  };
  const appendAbortWarning = (detail: string): void => {
    try { appendFileSync(liveLogPath, `\nWarning: ${detail}\n`); } catch { /* non-critical */ }
  };
  const pollAbortSignal = (): void => {
    try {
      if (!existsSync(abortSignalPath) || attemptAbortController.signal.aborted) return;
      const parsed = parseStageAbortSignal(readFileSync(abortSignalPath, 'utf-8'));
      if (!parsed.ok) {
        removeAbortSignal();
        appendAbortWarning(
          `Ignored stale stage abort signal: expected attempt ${attemptIndex} for stage "${opts.stageId}", `
          + `observed attempt ${parsed.observedAttemptIndex ?? 'unknown'} for stage "${parsed.observedStageId ?? 'unknown'}" `
          + `(${parsed.error}); signal removed without aborting.`,
        );
        return;
      }
      if (parsed.signal.stageId !== opts.stageId || parsed.signal.attemptIndex !== attemptIndex) {
        removeAbortSignal();
        appendAbortWarning(
          `Ignored stale stage abort signal: expected attempt ${attemptIndex} for stage "${opts.stageId}", `
          + `observed attempt ${parsed.signal.attemptIndex} for stage "${parsed.signal.stageId}"; `
          + 'signal removed without aborting.',
        );
        return;
      }

      // Consume before killing the child. If the adapter throws or the child is
      // SIGKILLed, the next same-name attempt cannot replay this cancellation.
      abortReason = parsed.signal.reason.slice(0, 240);
      removeAbortSignal();
      const approvalSignal = parsed.signal.source === 'scheduler' && parsed.signal.requestId !== undefined;
      if (approvalSignal) {
        approvalSuspended = true;
        approvalRequestId = parsed.signal.requestId;
        approvalRequestingStageId = parsed.signal.requestingStageId;
        terminationCause = 'approval_suspension';
      } else {
        stageAborted = true;
        terminationCause ??= 'stage_abort';
      }
      try {
        appendFileSync(
          liveLogPath,
          approvalSignal
            ? `\nApproval suspension ${approvalRequestId} consumed for attempt ${attemptIndex}; stopping stage child process.\n`
            : `\nStage abort signal consumed for attempt ${attemptIndex}; killing stage child process.\n`,
        );
      } catch { /* non-critical */ }
      attemptAbortController.abort(approvalSignal ? 'approval_suspension' : 'stage_abort');
    } catch { /* non-critical */ }
  };
  const pollCommandInterruptSignal = (): void => {
    try {
      if (!existsSync(commandInterruptSignalPath) || attemptAbortController.signal.aborted) return;
      const parsed = parseStageCommandInterrupt(readFileSync(commandInterruptSignalPath, 'utf-8'));
      if (!parsed.ok) {
        removeCommandInterruptSignal();
        appendAbortWarning(`Ignored malformed operator command interrupt (${parsed.error}); signal removed.`);
        return;
      }
      const signal = parsed.signal;
      const active = activeCommands.get(signal.commandId);
      if (signal.stageId !== opts.stageId
        || signal.attemptIndex !== attemptIndex
        || signal.attemptStartedAt !== attemptStartedAt
        || !active
        || !active.command
        || commandFingerprint(active.command) !== signal.commandFingerprint) {
        removeCommandInterruptSignal();
        appendAbortWarning(
          `Ignored stale operator command interrupt ${signal.requestId}: it does not match the active command in attempt ${attemptIndex}.`,
        );
        return;
      }

      const acceptedGuidance = appendGuidanceEnvelope({ runDir: opts.runDir, target: opts.stageId,
        source: 'operator', body: signal.reason, knownStageIds: [opts.stageId], createdAt: signal.requestedAt });
      signal.guidanceId = acceptedGuidance.id;
      recordRunEvent(opts.projectDir, opts.runId, { type: 'stage_command_interrupt_requested', runId: opts.runId,
        timestamp: signal.requestedAt, stageId: opts.stageId, attemptIndex, attemptStartedAt,
        requestId: signal.requestId, guidanceId: signal.guidanceId, commandId: signal.commandId,
        command: signal.command, commandFingerprint: signal.commandFingerprint, detail: signal.reason, source: 'operator' });
      // Consume before stopping the child so a crash cannot replay this exact
      // request into a later command or attempt.
      removeCommandInterruptSignal();
      interruptedCommands.set(signal.commandFingerprint, signal);
      const guidance = consumeNewGuidance(
        'operator_interrupt',
        activeInvocationIndex,
        { id: active.id, command: active.command },
      );
      const interruptGuidance = deliveredGuidance.find((entry) => entry.id === signal.guidanceId);
      const priorGuidance = commandBoundaryControl?.guidance ?? [];
      const mergedGuidance = [...priorGuidance, ...guidance, ...(interruptGuidance ? [interruptGuidance] : [])]
        .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
      commandBoundaryControl = {
        kind: 'operator_interrupt',
        command: active,
        guidance: mergedGuidance,
        interrupt: signal,
      };
      try {
        appendFileSync(
          liveLogPath,
          `\nOperator interrupt ${signal.requestId} matched command ${signal.commandId}; stopping only the current adapter invocation.\n`,
        );
      } catch { /* the event ledger and signal are the durable audit */ }
      if (activeInvocationAbortController && !activeInvocationAbortController.signal.aborted) {
        activeInvocationAbortController.abort('operator_command_interrupt');
      }
    } catch { /* signal may be between publication and a complete read */ }
  };
  const cleanupAbortSignalAtExit = (): void => {
    try {
      if (!existsSync(abortSignalPath)) return;
      const parsed = parseStageAbortSignal(readFileSync(abortSignalPath, 'utf-8'));
      if (!parsed.ok) {
        removeAbortSignal();
        return;
      }
      if (
        parsed.signal.stageId !== opts.stageId
        || parsed.signal.attemptIndex <= attemptIndex
      ) {
        removeAbortSignal();
      }
      // A future-attempt envelope is not owned by this invocation. This should
      // not occur in normal scheduling, but leaving it is safer than deleting
      // another execution's cancellation in a race.
    } catch { /* non-critical */ }
  };
  const cleanupCommandInterruptSignalAtExit = (): void => {
    try {
      if (!existsSync(commandInterruptSignalPath)) return;
      const parsed = parseStageCommandInterrupt(readFileSync(commandInterruptSignalPath, 'utf-8'));
      if (!parsed.ok
        || parsed.signal.stageId !== opts.stageId
        || parsed.signal.attemptIndex <= attemptIndex) {
        removeCommandInterruptSignal();
      }
    } catch { /* retain an unreadable signal for diagnosis */ }
  };
  pollAbortSignal();
  pollCommandInterruptSignal();
  const abortPollTimer = setInterval(pollAbortSignal, 1000);
  const commandInterruptPollTimer = setInterval(pollCommandInterruptSignal, 250);
  const requestWatchers: import('node:fs').FSWatcher[] = [];
  try {
    const signalsDir = join(opts.runDir, 'signals');
    mkdirSync(signalsDir, { recursive: true });
    for (const directory of [join(opts.runDir, 'stages', opts.stageId), signalsDir]) {
      requestWatchers.push(watch(directory, { persistent: false }, (_event, fileName) => {
        const name = fileName?.toString() ?? '';
        if (!name || name === `abort_${opts.stageId}.json`) pollAbortSignal();
        if (!name || name === `interrupt_${opts.stageId}.json`) pollCommandInterruptSignal();
      }));
    }
  } catch { /* one-second reconciliation remains the portable fallback */ }
  const parentAbortSignal = runProcessAbortSignal();
  const aggregateAbortSignal = AbortSignal.any([attemptAbortController.signal, attemptDeadline.signal,
    ...(parentAbortSignal ? [parentAbortSignal] : [])]);
  const cancelledResult = (telemetry?: RunResult): RunResult => {
    const tokensIn = typeof telemetry?.tokens_in === 'number' && Number.isFinite(telemetry.tokens_in)
      ? telemetry.tokens_in
      : undefined;
    const tokensOut = typeof telemetry?.tokens_out === 'number' && Number.isFinite(telemetry.tokens_out)
      ? telemetry.tokens_out
      : undefined;
    const timedOut = !approvalSuspended && (terminationCause === 'attempt_timeout' || attemptDeadline.signal.aborted);
    return {
      output: '',
      exitCode: approvalSuspended ? 0 : timedOut ? 124 : 137,
      ...(telemetry?.processExitCode !== undefined ? { processExitCode: telemetry.processExitCode } : {}),
      ...(telemetry?.processSignal !== undefined ? { processSignal: telemetry.processSignal } : {}),
      duration_ms: Math.round(attemptElapsedMs()),
      timedOut,
      ...(approvalSuspended ? {
        suspended: true,
        suspensionReason: 'approval' as const,
        ...(approvalRequestId ? { suspensionRequestId: approvalRequestId } : {}),
        ...(approvalRequestingStageId ? { suspensionRequestingStageId: approvalRequestingStageId } : {}),
      } : {}),
      ...invocationUsageFields({ ...telemetry, tokens_in: tokensIn, tokens_out: tokensOut }),
      invocations: telemetry?.invocations,
    };
  };
  const observeAdapterSettlement = (): void => {
    // Timer starvation delays both deadline and abort polling. Consume a
    // current-attempt ABORT first because abort authority takes
    // precedence, then observe the monotonic deadline synchronously.
    pollAbortSignal();
    if (!stageAborted && !approvalSuspended) attemptDeadline.observeSettlement();
  };
  let lastChildClosedAt: string | undefined;
  let childCloseUnverified = false;
  let invocationIndex = 0;
  let inputRecordIndex = 0;
  let latestLiveConstraintResult: LiveConstraintInvocationResult | undefined;
  const continuations = new Map<Adapter, { sessionId: string; ownerStageId: string }>();
  if (opts.resumeSessionId && isSessionUuid(opts.resumeSessionId)) {
    continuations.set(adapter, { sessionId: opts.resumeSessionId, ownerStageId: opts.sessionOwnerStageId ?? opts.stageId });
  }
  const deadlineContext = (): string => direct
    ? `Execution deadline: ${attemptDeadline.deadlineAt}.`
    : `# Execution clock\nExecution ${attemptIndex}: started ${attemptDeadline.attemptStartedAt}; absolute deadline ${attemptDeadline.deadlineAt}; remaining ${Math.floor(attemptDeadline.remainingMs())} ms at ${new Date(attemptDeadline.wallNow()).toISOString()}. This deadline is immutable. Query UTC time with node -e "console.log(new Date().toISOString())".`;
  const invokeAdapter = async (
    selectedAdapter: Adapter,
    selectedRole: AgentConfig,
    invocationPrompt = prompt,
  ): Promise<RunResult> => {
    if (aggregateAbortSignal.aborted || attemptDeadline.remainingMs() <= 0) {
      if (attemptDeadline.signal.aborted) terminationCause ??= 'attempt_timeout';
      return cancelledResult();
    }
    attemptDeadline.append('adapter_phase_started', {
      stageId: opts.stageId,
      attemptIndex,
      remainingMs: Math.max(0, Math.floor(attemptDeadline.remainingMs())),
      effectiveBudgetMs,
    });
    invocationIndex++;
    // Keep cached roles topology-neutral, including retries after a peer closes.
    const invocationRole = opts.liveConstraintGuardFactory?.parallelExecution?.()
      ? { ...selectedRole, prompt: `${selectedRole.prompt}\n\n${PARALLEL_EXECUTION_BOUNDARY}` }
      : selectedRole;
    consumeNewGuidance('adapter_invocation', invocationIndex);
    const continuation = continuations.get(selectedAdapter);
    // A fresh child (including a failed-resume fallback) needs both its duties
    // and the current local correction; the thread only carries the former.
    const additionalGuidance = deliveredGuidance.filter((entry) => !prompt.includes(renderGuidanceEnvelope(entry)));
    const stateContext = direct ? '' : runStateContext(opts.projectDir, opts.runId, opts.planRevision);
    const fullPrompt = `${prompt}${invocationPrompt === prompt ? '' : `\n\n${invocationPrompt}`}\n\n${guidanceBlock(additionalGuidance)}\n\n${deadlineContext()}\n\n${stateContext}`;
    const effectiveInvocationPrompt = continuation && invocationPrompt !== prompt
      ? `${invocationPrompt}\n\n${guidanceBlock(deliveredGuidance)}\n\n${deadlineContext()}\n\n${stateContext}`
      : fullPrompt;
    const captureInput = (input: Parameters<NonNullable<import('./adapters/base.js').RunOpts['onInvocationInput']>>[0], boundary: 'adapter' | 'model'): void => {
      // The public standalone worker API predates initialized run projections.
      // Keep it usable, but do not manufacture an authenticated run carrier.
      if (!existsSync(join(opts.runDir, 'run.json'))) {
        appendFileSync(liveLogPath, '\nINVOCATION_INPUT_UNAVAILABLE: standalone stage has no initialized run projection.\n');
        return;
      }
      recordInvocationInput(opts.runDir, {
        runId: opts.runId, stageId: opts.stageId, attemptIndex, attemptStartedAt,
        invocationIndex: ++inputRecordIndex, boundary,
        adapter: invocationRole.adapter ?? inferAdapterName(selectedAdapter) ?? 'custom',
        model: input.model ?? invocationRole.model ?? 'provider-default-unresolved', systemPrompt: input.systemPrompt, userPrompt: input.userPrompt,
        resumeSessionId: input.resumeSessionId, transport: input.transport, guidanceIds: guidanceForExecution(deliveredGuidance, attemptIndex).map((entry) => entry.id),
      });
    };
    // input.md remains a compatible latest alias; immutable records carry exact inputs.
    writeStageInput(opts.projectDir, opts.runId, opts.stageId, effectiveInvocationPrompt);
    const invocationAbortController = new AbortController();
    commandBoundaryControl = undefined;
    activeInvocationAbortController = invocationAbortController;
    activeInvocationIndex = invocationIndex;
    const invocationAbortSignal = AbortSignal.any([aggregateAbortSignal, invocationAbortController.signal]);
    const liveMonitor = liveConstraintGuard?.beginInvocation(invocationIndex, (reason) => {
      if (!invocationAbortController.signal.aborted) invocationAbortController.abort(reason);
    });
    const onCommandLifecycle = (event: CommandLifecycleEvent): void => {
      if (event.phase === 'started') {
        activeCommands.set(event.id, event);
        recordRunEvent(opts.projectDir, opts.runId, {
          type: 'stage_command_started',
          runId: opts.runId,
          timestamp: event.timestamp,
          stageId: opts.stageId,
          attemptIndex,
          attemptStartedAt,
          invocationIndex,
          commandId: event.id,
          ...(event.command ? {
            command: event.command,
            commandFingerprint: commandFingerprint(event.command),
          } : {}),
          source: 'worker',
        });
        const startGuidance = consumeNewGuidance(
          'tool_call_start', invocationIndex, { id: event.id, command: event.command },
        );
        if (startGuidance.length > 0) {
          commandBoundaryControl = { kind: 'guidance', command: event, guidance: startGuidance };

        }
        if (event.command) {
          const fingerprint = commandFingerprint(event.command);
          const interrupted = interruptedCommands.get(fingerprint);
          if (interrupted) {
            recordRunEvent(opts.projectDir, opts.runId, {
              type: 'interrupted_command_repeated',
              runId: opts.runId,
              timestamp: event.timestamp,
              stageId: opts.stageId,
              attemptIndex,
              attemptStartedAt,
              invocationIndex,
              commandId: event.id,
              command: event.command,
              commandFingerprint: fingerprint,
              originalRequestId: interrupted.requestId,
              guidanceId: interrupted.guidanceId,
              detail: interrupted.reason,
              level: 'warning',
              source: 'worker',
            });
          }
          const explicitTimeout = parseExplicitCommandTimeout(event.command);
          const remainingBudgetMs = Math.max(0, Math.floor(attemptDeadline.remainingMs()));
          if (explicitTimeout && explicitTimeout.timeoutMs > remainingBudgetMs) {
            const shortfallMs = explicitTimeout.timeoutMs - remainingBudgetMs;
            recordRunEvent(opts.projectDir, opts.runId, {
              type: 'command_timeout_projection',
              runId: opts.runId,
              timestamp: event.timestamp,
              stageId: opts.stageId,
              attemptIndex,
              attemptStartedAt,
              invocationIndex,
              commandId: event.id,
              command: event.command,
              commandFingerprint: fingerprint,
              commandTimeoutMs: explicitTimeout.timeoutMs,
              remainingBudgetMs,
              shortfallMs,
              detail: `command timeout exceeds the remaining attempt budget by ${shortfallMs}ms`,
              level: 'warning',
              source: 'worker',
            });
            appendGuidanceEnvelope({
              runDir: opts.runDir,
              target: opts.stageId,
              source: 'scheduler',
              knownStageIds: [opts.stageId],
              body: [
                'The command was stopped before it could silently exceed this attempt budget.',
                `Command: ${event.command}`,
                `Explicit command timeout: ${explicitTimeout.timeoutMs} ms.`,
                `Remaining stage budget at command start: ${remainingBudgetMs} ms.`,
                `Projected shortfall: ${shortfallMs} ms.`,
                'Choose a bounded alternative or report that the requested work is infeasible; the attempt deadline is unchanged.',
              ].join('\n'),
            });
            const projectionGuidance = consumeNewGuidance(
              'tool_call_start', invocationIndex, { id: event.id, command: event.command },
            );
            commandBoundaryControl = {
              kind: 'timeout_projection',
              command: event,
              guidance: [...startGuidance, ...projectionGuidance],
            };
            if (!invocationAbortController.signal.aborted) {
              invocationAbortController.abort('command_timeout_projection');
            }
          }
        }
        // Close a publication race where the operator signal landed between
        // the adapter's activity snapshot and this callback.
        pollCommandInterruptSignal();
        return;
      }

      const started = activeCommands.get(event.id);
      activeCommands.delete(event.id);
      const completed = started
        ? { ...event, ...(started.command ? { command: started.command } : {}) }
        : event;
      recordRunEvent(opts.projectDir, opts.runId, {
        type: 'stage_command_completed',
        runId: opts.runId,
        timestamp: event.timestamp,
        stageId: opts.stageId,
        attemptIndex,
        attemptStartedAt,
        invocationIndex,
        commandId: event.id,
        ...(completed.command ? {
          command: completed.command,
          commandFingerprint: commandFingerprint(completed.command),
        } : {}),
        source: 'worker',
      });
      const guidance = consumeNewGuidance(
        'tool_call_completion', invocationIndex, { id: event.id, command: completed.command },
      );
      if (guidance.length > 0 && !commandBoundaryControl) commandBoundaryControl = { kind: 'guidance', command: completed, guidance };
      // Scope admission is an immutable control fact, independent of which
      // operator guidance happened to arrive first. Finish every active tool
      // and wait for child closure before re-admitting a new execution.
      if (activeCommands.size === 0 && commandBoundaryControl?.kind !== 'operator_interrupt'
        && readAcceptedScopeRevisionDecisions(join(opts.runDir, 'stages', opts.stageId), {
          runId: opts.runId, stageId: opts.stageId, attemptIndex,
        }).length > 0) {
        commandBoundaryControl = { kind: 'scope_revision', command: completed, guidance: [] };
      }
      if ((commandBoundaryControl?.kind === 'guidance' || commandBoundaryControl?.kind === 'scope_revision')
        && activeCommands.size === 0 && !invocationAbortController.signal.aborted) {
        invocationAbortController.abort(commandBoundaryControl.kind === 'scope_revision'
          ? 'scope_revision_at_tool_completion' : 'guidance_delivery_at_tool_completion');
      }
    };
    latestLiveConstraintResult = undefined;
    const invocation = new Promise<RunResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      let closeObservationTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: RunResult): void => {
        if (settled) return;
        settled = true;
        if (closeObservationTimer) clearTimeout(closeObservationTimer);
        invocationAbortSignal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (closeObservationTimer) clearTimeout(closeObservationTimer);
        invocationAbortSignal.removeEventListener('abort', onAbort);
        rejectPromise(error);
      };
      const onAbort = (): void => {
        if (attemptDeadline.signal.aborted) terminationCause ??= 'attempt_timeout';
        // The signal initiates cancellation; the adapter promise is the child
        // lifecycle acknowledgement. Wait for it before claiming childClosedAt.
        // A broken adapter is bounded by the observation tolerance and is then
        // recorded without a child-close timestamp instead of hanging forever.
        if (!closeObservationTimer) {
          closeObservationTimer = setTimeout(() => {
            childCloseUnverified = true;
            finish(cancelledResult());
          }, ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS);
        }
      };
      invocationAbortSignal.addEventListener('abort', onAbort, { once: true });
      withEngineIntegrity({ projectDir: opts.projectDir, runDir: opts.runDir,
        stageId: opts.stageId, dynamicDispatch: opts.dynamicDispatch, structuredResult: Boolean(opts.outputSchema), artifactContract: opts.artifactContract! },
      () => {
        if (!selectedAdapter.capturesInvocationInput) {
          captureInput({ systemPrompt: invocationRole.prompt, userPrompt: effectiveInvocationPrompt,
            resumeSessionId: continuation?.sessionId }, 'adapter');
        }
        return selectedAdapter.run(effectiveInvocationPrompt, invocationRole, {
          timeout_ms: effectiveBudgetMs,
          workDir: opts.projectDir,
          runDir: opts.runDir,
          stageId: opts.stageId,
          attemptIndex,
          attemptStartedAt,
          resumeSessionId: continuation?.sessionId,
          sessionOwnerStageId: continuation?.ownerStageId,
          // The worker owns final cleanup; an adapter call may be corrected.
          preserveSession: true,
          freshSessionPrompt: fullPrompt,
          abortSignal: invocationAbortSignal,
          onCommandLifecycle,
          onInvocationInput: (input) => captureInput(input, 'model'),
          outputSchema: opts.outputSchema,
        });
      }).then(
        (value) => {
          if (value.writeAttribution === 'structured') liveMonitor?.observePaths(value.writes ?? []);
          if (isSessionUuid(value.sessionId)) {
            const recorded = readSession(opts.runDir, opts.stageId, selectedAdapter.sessionKind);
            continuations.set(selectedAdapter, {
              sessionId: value.sessionId,
              ownerStageId: recorded?.sessionId === value.sessionId ? recorded.ownerStageId
                : value.sessionId === continuation?.sessionId ? continuation.ownerStageId : opts.stageId,
            });
          }
          lastChildClosedAt = new Date().toISOString();
          observeAdapterSettlement();
          // Cancellation changes the attempt outcome, not telemetry already
          // parsed while the adapter was closing its child process.
          finish(aggregateAbortSignal.aborted ? cancelledResult(value) : value);
        },
        (error) => {
          lastChildClosedAt = new Date().toISOString();
          observeAdapterSettlement();
          if (error instanceof Error && /^ENGINE_STATE_(?:TAMPERED|REFUSED):/.test(error.message)) {
            approvalSuspended = false;
            finish({ output: error.message, friendlyError: error.message, exitCode: 125, duration_ms: Math.round(attemptElapsedMs()) });
          } else if (aggregateAbortSignal.aborted) finish(cancelledResult());
          else if (invocationAbortController.signal.aborted) finish(cancelledResult());
          else fail(error);
        },
      );
    });
    try {
      return await invocation;
    } finally {
      // Adapter settlement closes every command it owned, including one whose
      // stream ended without a trustworthy completion record. A later
      // interrupt must never bind to stale in-memory activity.
      activeCommands.clear();
      if (activeInvocationAbortController === invocationAbortController) {
        activeInvocationAbortController = undefined;
        activeInvocationIndex = undefined;
      }
      latestLiveConstraintResult = await liveMonitor?.finish();
    }
  };

  const mergeInvocationTelemetry = (prior: RunResult | undefined, next: RunResult): RunResult => {
    if (!prior) return next;
    const writes = [...new Set([...(prior.writes ?? []), ...(next.writes ?? [])])];
    const validationGeneratedWrites = [...new Set([
      ...(prior.validationGeneratedWrites ?? []),
      ...(next.validationGeneratedWrites ?? []),
    ])];
    const structured = prior.writeAttribution === 'structured' && next.writeAttribution === 'structured';
    return {
      ...next,
      output: opts.outputSchema ? next.output : [prior.output, next.output].filter(Boolean).join('\n\n[adapter reinvoked at a controlled same-attempt boundary]\n\n'),
      duration_ms: prior.duration_ms + next.duration_ms,
      ...sumInvocationUsage([prior, next]),
      invocations: [...(prior.invocations ?? []), ...(next.invocations ?? [])],
      ...(writes.length > 0 ? { writes } : {}),
      ...(writes.length > 0 ? { writeAttribution: structured ? 'structured' : 'unknown' } : {}),
      ...(validationGeneratedWrites.length > 0 ? { validationGeneratedWrites } : {}),
    };
  };

  const stageRecord = (output: string): Record<string, unknown> => {
    // Older native/fixture answers remain readable; only the response schema
    // advertises new output. Admission still checks every executable field.
    const record = parseStageRecord(output, opts.outputSchema === HANDOFF_SCHEMA ? RECORDED_HANDOFF_SCHEMA : opts.outputSchema!);
    if (opts.isGate) {
      const violation = validateGateCriterionEvidence(opts.runDir, opts.stageId, record)
        ?? validateGateRepairability(record) ?? explicitPassContradiction(record, 'verdict');
      if (violation) throw new Error(violation);
      const findings = AuditFindingsSchema.parse(record.audit_findings);
      if (record.pass === true && findings.findings.length) throw new Error('AUDIT_FINDINGS_OPEN: passing verdict has unresolved findings');
    }
    return record;
  };
  let correctionReinvocations = 0;
  const invokeAdapterWithCorrection = async (
    selectedAdapter: Adapter,
    selectedRole: AgentConfig,
  ): Promise<RunResult> => {
    let combined: RunResult | undefined;
    let invocationPrompt = prompt;
    while (true) {
      const current = await invokeAdapter(selectedAdapter, selectedRole, invocationPrompt);
      combined = mergeInvocationTelemetry(combined, current);
      const commandControl = commandBoundaryControl;
      // No correction may launch another child until the prior child is known
      // closed; a scope grant cannot turn missing closure into clean suspension.
      if (childCloseUnverified) return combined;
      if (!isRetryableAdapterFailure(current.adapterFailureKind)) return combined;
      if (commandControl && !aggregateAbortSignal.aborted) {
        activeCommands.delete(commandControl.command.id);
        // A durable current-execution grant stops at the closed child boundary.
        // The scheduler alone re-admits inherited capability for the next child.
        if (commandControl.kind === 'scope_revision'
            && (combined.exitCode !== 0 && combined.exitCode !== 137)) return combined;
        if (commandControl.kind === 'scope_revision'
            && !latestLiveConstraintResult?.monitorFailure
            && !(latestLiveConstraintResult?.incidents.length)) {
          scopeRevisionBoundaryReached = true;
          return {
            ...combined,
            exitCode: 0,
            timedOut: false,
            adapterError: false,
            providerFailure: undefined,
            output: `${combined.output}${combined.output ? '\n\n' : ''}Accepted scope revision ended this attempt at the control boundary.`,
          };
        }
        if (commandControl.kind === 'operator_interrupt' && commandControl.interrupt) {
          recordRunEvent(opts.projectDir, opts.runId, {
            type: 'stage_command_interrupted',
            runId: opts.runId,
            timestamp: new Date().toISOString(),
            stageId: opts.stageId,
            attemptIndex,
            attemptStartedAt,
            invocationIndex,
            requestId: commandControl.interrupt.requestId,
            guidanceId: commandControl.interrupt.guidanceId,
            commandId: commandControl.command.id,
            ...(commandControl.command.command ? {
              command: commandControl.command.command,
              commandFingerprint: commandControl.interrupt.commandFingerprint,
            } : {}),
            detail: commandControl.interrupt.reason,
            source: 'worker',
          });
        }
        const label = commandControl.kind === 'operator_interrupt'
          ? 'Operator command interrupt'
          : commandControl.kind === 'timeout_projection'
            ? 'Command timeout projection'
            : 'Live guidance delivered at tool completion';
        invocationPrompt = `# ${label}`;
        try {
          appendFileSync(
            liveLogPath,
            `\n${label}; reinvoking inside immutable attempt ${attemptIndex}.\n`,
          );
        } catch { /* event/guidance ledgers remain authoritative */ }
        continue;
      }
      const live = latestLiveConstraintResult;
      if (live?.validationGeneratedPaths.length) {
        combined.validationGeneratedWrites = [...new Set([
          ...(combined.validationGeneratedWrites ?? []),
          ...live.validationGeneratedPaths,
        ])];
      }
      if (live?.monitorFailure) {
        return {
          ...combined,
          exitCode: 1,
          timedOut: false,
          adapterError: false,
          friendlyError: live.monitorFailure.reason,
          providerFailure: undefined,
        };
      }
      const incidents = live?.incidents ?? [];
      let recordError: string | undefined;
      if (incidents.length === 0) {
        if (combined.exitCode !== 0 || !opts.outputSchema) return combined;
        try { stageRecord(combined.output); return combined; }
        catch (error) { recordError = `Stage record refused: ${error instanceof Error ? error.message : String(error)}`; }
      }
      const instructions = recordError
        ? [`# Stage result correction\n${recordError}\nDo not repeat the completed work. Correct only the final JSON document using the retained work and evidence. Preserve the substantive result; never invent evidence or change a rejection to pass to satisfy the format.\nSchema: ${JSON.stringify(opts.outputSchema)}\nRejected answer:\n${combined.output}`]
        : [...new Set(incidents.map((incident) => incident.scopeRevisionInstruction))];
      if (incidents.some((incident) => !incident.restored)) {
        return {
          ...combined,
          exitCode: 1,
          timedOut: false,
          adapterError: false,
          friendlyError: `live constraint rollback failed; ${instructions.join(' ')}`,
          providerFailure: undefined,
        };
      }
      if (correctionReinvocations >= 1 || aggregateAbortSignal.aborted) {
        return {
          ...combined,
          exitCode: aggregateAbortSignal.aborted ? combined.exitCode : 1,
          timedOut: aggregateAbortSignal.aborted ? combined.timedOut : false,
          adapterError: false,
          providerFailure: undefined,
          friendlyError: aggregateAbortSignal.aborted
            ? combined.friendlyError
            : recordError ?? `scope_violation: repeated live constraint violation after same-attempt correction; ${instructions.join(' ')}`,
        };
      }
      correctionReinvocations++;
      invocationPrompt = recordError ? instructions.join('\n') : `# Live constraint correction\n${instructions.join('\n')}`;
      try {
        appendFileSync(
          liveLogPath,
          `\n${recordError ?? `Live constraint guard restored ${incidents.map((incident) => incident.path).join(', ')}`}; reinvoking inside attempt ${attemptIndex}.\n`,
        );
      } catch { /* durable incident JSONL remains the audit source */ }
    }
  };
  const adapterRetryDelays = opts.technicalRetry?.delaysMs ?? ADAPTER_RETRY_DELAYS;
  const waitForRetry = (delayMs: number): Promise<boolean> => {
    if (delayMs <= 0) {
      return Promise.resolve(!aggregateAbortSignal.aborted && attemptDeadline.remainingMs() > 0);
    }
    return attemptDeadline.boundedSleep(delayMs, attemptAbortController.signal);
  };

  let result: RunResult;
  // All adapter work shares one immutable attempt boundary.
  try {
  try {
    const preflightErrors = artifactDeclarationErrors(opts.artifactContract, opts.stageId);
    let validationFailure: RunResult | undefined;
    if (!preflightErrors.length && opts.isGate && !aggregateAbortSignal.aborted) {
      const dependencies = {
        remainingMs: () => attemptDeadline.remainingMs(), abortSignal: aggregateAbortSignal,
      };
      let validation = await recordGateValidationDelta(opts.projectDir, opts.runId, opts.stageId, dependencies);
      if (validation && !validation.pass && !validation.delta.some(entry => entry.state === 'regression')) {
        const settlement = await settleGateValidationEvidence(opts.projectDir, opts.runId, opts.stageId, dependencies);
        if (settlement.kind === 'refused') validationFailure = {
          exitCode: 1, duration_ms: Math.round(attemptElapsedMs()), output: settlement.reason, friendlyError: settlement.reason,
          writes: [], writeAttribution: 'structured',
        };
        // Settlement owns the replay and its receipt; do not run commands again.
        validation = JSON.parse(readFileSync(join(opts.runDir, `validation_delta_${opts.stageId}.json`), 'utf8'));
      }
      // A no-regression pass can still carry failed or unlaunchable commands;
      // only commands that themselves passed make a rerun redundant.
      const configured = validation?.current.filter(command => command.state !== 'not_configured') ?? [];
      const commandsPassed = configured.length > 0 && configured.every(command => command.state === 'passed');
      if (validation?.pass) prompt += `\n\nEngine validation: pass=true; ${validation.current.map(command => `${command.display ?? command.role}: exit=${command.exitCode ?? 'unavailable'}, state=${command.state}`).join('; ')}. Receipt: ${join(opts.runDir, validation.immutablePath ?? `validation_delta_${opts.stageId}.json`)} (each command's result and output tail). The engine enforces this comparison. Review every assigned criterion lacking a prior independent conclusion; validation receipts contain no semantic conclusions.${commandsPassed ? ' Do not rerun configured commands without a concrete evidence gap.' : ''} Project writes require post-write validation.`;
      const regressions = validation?.delta.filter(entry => entry.state === 'regression') ?? [];
      if (validation && regressions.length) {
        // Use the existing verdict carrier and repair path without a model decision.
        const evidence = join(opts.runDir, validation.immutablePath!);
        const reason = regressions.map(entry => `${entry.display ?? entry.role}: ${entry.newFailureIdentifiers.join(', ') || entry.reason}`).join('; ');
        validationFailure = { exitCode: 0, duration_ms: Math.round(attemptElapsedMs()), writes: [], writeAttribution: 'structured', output: JSON.stringify({
          pass: false, reason,
          criteria: Object.fromEntries((opts.criterionRefs ?? []).map(id => [id, { status: 'fail', evidence }])),
          audit_findings: { version: 1, findings: [] },
          repairability: { version: 1, disposition: 'repairable', evidence },
        }) };
      } else if (direct && opts.isGate && !opts.resumeSessionId) {
        prompt += '\nThis is a fresh independent review. Evaluate the entire brief, including after an engine validation failure was repaired.';
      }
    }
    result = aggregateAbortSignal.aborted ? { ...cancelledResult(), output: preflightErrors.join('\n') }
      : preflightErrors.length ? { output: preflightErrors.join('\n'), exitCode: 1, duration_ms: Math.round(attemptElapsedMs()), friendlyError: preflightErrors.join('; ') }
      : validationFailure ?? await invokeAdapterWithCorrection(adapter, resolvedRole);

    // Adapter error detection + exponential backoff retry on the SAME adapter.
    if (result.exitCode !== 0 && result.adapterError === true && isRetryableAdapterFailure(result.adapterFailureKind)) {
      for (let attempt = 0; attempt < adapterRetryDelays.length; attempt++) {
        if (aggregateAbortSignal.aborted) break;
        const retryDelayMs = Math.max(0, adapterRetryDelays[attempt]);
        const delaySec = Math.round(retryDelayMs / 1000);
        try { appendFileSync(liveLogPath, `\n⏳ Adapter error detected — retrying in ${delaySec}s (attempt ${attempt + 2}/${adapterRetryDelays.length + 1})…\n`); } catch { /* ignore */ }
        attemptDeadline.append('adapter_backoff_started', { stageId: opts.stageId, attemptIndex, delayMs: retryDelayMs });
        if (!await waitForRetry(retryDelayMs)) {
          result = cancelledResult();
          break;
        }
        result = await invokeAdapterWithCorrection(adapter, resolvedRole);
        if (result.exitCode === 0 || result.adapterError !== true || !isRetryableAdapterFailure(result.adapterFailureKind)) break;
      }

      // The adapter classifies its own diagnostic channel. Worker output is an
      // agent message and may quote an error string without any adapter failure.
    }
  } catch (error) {
    observeAdapterSettlement();
    if (!aggregateAbortSignal.aborted) throw error;
    result = cancelledResult();
  }

  // The scheduler flushes requests written immediately before a synchronous close
  // while this attempt still owns its identity and immutable deadline.
  if (opts.settlementBoundary && !aggregateAbortSignal.aborted) {
    scopeRevisionBoundaryReached ||= await opts.settlementBoundary('child_closed');
  }
  const enginePublishedCarriers: string[] = [];
  let blockedStageResult = false;
  if (result.exitCode === 0 && opts.outputSchema && !scopeRevisionBoundaryReached) {
    try {
      const record = stageRecord(result.output);
      blockedStageResult = record.status === 'blocked';
      if (!opts.dynamicDispatch && !opts.isGate && !opts.gateReviewed && record.status === 'blocked') throw new Error(`Blocked: ${record.summary}`);
      const carriers = opts.isGate ? [`verdict_${opts.stageId}.json`] : [];
      const handoff = `handoff_${opts.stageId}.md`;
      if (opts.artifactContract?.produces.some(output => output.root === 'run' && output.path === handoff)) carriers.push(handoff);
      for (const carrier of carriers) {
        atomicWrite(join(opts.runDir, carrier), `${JSON.stringify(record)}\n`);
        enginePublishedCarriers.push(`run:${carrier}`);
      }
    } catch (error) {
      result.exitCode = 1;
      result.friendlyError = `Stage record refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (result.exitCode === 0 || (production && invocationIndex > 0 && !childCloseUnverified)) {
    try {
      const artifactInput = {
        attemptIndex,
        isGate: opts.isGate,
        stageId: opts.stageId,
        template: opts.artifactObligationTemplate ?? '',
        projectDir: opts.projectDir,
        runDir: opts.runDir,
        writes: [...(result.writes ?? []), ...enginePublishedCarriers],
        artifactContract: opts.artifactContract,
        statuses: opts.artifactStatuses,
      };
      const audit = inspectStageArtifactContract(artifactInput, blockedStageResult || scopeRevisionBoundaryReached || result.exitCode !== 0);
      const productFacts = existsSync(join(opts.runDir, 'run.json')) ? declaredOutputFacts(opts.projectDir, opts.runId) : [];
      // A single direct author owns the whole brief. Split plans settle each
      // stage's artifact contract; completion still requires every run product.
      const authors = runState?.planControl?.stages.filter(stage => !stage.is_gate && !stage.dynamic_dispatch && !stage.retry_to?.length);
      const dueProducts = direct && (authors?.length ?? 1) <= 1 && !opts.isGate && !opts.dynamicDispatch && !blockedStageResult && result.exitCode === 0 ? productFacts : [];
      const requiredProducts = new Map([...dueProducts, ...availableProductsAtStart].map(product => [product.path, product]));
      for (const product of requiredProducts.values()) {
        const current = productFacts.find(output => output.path === product.path);
        if (current?.available) continue;
        audit.violations.push({
          kind: 'declared_artifact', source: 'declaration', mention: product.path,
          path: resolve(opts.projectDir, product.path),
          reason: `${product.available ? 'DECLARED_OUTPUT_REMOVED' : 'DECLARED_OUTPUT_REQUIRED'}: ${product.path}; ${current?.reason ?? 'required product declaration disappeared'}`,
        });
      }
      if (production && !childCloseUnverified) audit.production = production;
      if (opts.artifactContract || audit.obligations.length > 0) writeStageArtifactContractAudit(opts.runDir, audit);
      if (audit.violations.length && result.exitCode === 0) {
        result.exitCode = 1;
        result.friendlyError = `Stage settlement refused: ${audit.violations.map(violation => violation.reason).join('; ')}`;
      }
    } catch (error) {
      result.exitCode = 1;
      result.timedOut = false;
      result.adapterError = false;
      result.adapterFailureKind = undefined;
      result.providerFailure = undefined;
      result.friendlyError = `artifact contract could not be checked: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  } finally {
    pollAbortSignal();
    clearInterval(abortPollTimer);
    clearInterval(commandInterruptPollTimer);
    for (const watcher of requestWatchers) watcher.close();
    cleanupAbortSignalAtExit();
    cleanupCommandInterruptSignalAtExit();
    // The execution attempt ends after adapter settlement.
    // A blocked event loop can settle after the immutable boundary before its
    // timer callback runs, so observe monotonic expiry before disposal.
    if (!stageAborted && !approvalSuspended) attemptDeadline.observeSettlement();
    // Dispose here as well on thrown adapter errors so no long deadline timer
    // survives this invocation and keeps the worker process alive.
    attemptDeadline.dispose();
  }

  if (attemptDeadline.signal.aborted && !stageAborted && !approvalSuspended) terminationCause = 'attempt_timeout';
  const timedOut = !stageAborted && !approvalSuspended && (
    terminationCause === 'attempt_timeout'
    || result.exitCode === 124
    || result.timedOut === true
    || (result.duration_ms >= effectiveBudgetMs && result.exitCode !== 0)
  );
  if (scopeRevisionBoundaryReached && !stageAborted && !timedOut && result.exitCode === 0) {
    result.suspended = true;
    result.suspensionReason = 'scope_revision';
  }
  if (approvalSuspended) {
    result.exitCode = 0;
    result.timedOut = false;
    result.suspended = true;
    result.suspensionReason = 'approval';
    result.suspensionRequestId = approvalRequestId;
    result.suspensionRequestingStageId = approvalRequestingStageId;
    terminationCause = 'approval_suspension';
  } else if (timedOut) {
    result.exitCode = 124;
    result.timedOut = true;
    terminationCause = 'attempt_timeout';
  } else if (stageAborted) {
    result.exitCode = 137;
    result.timedOut = false;
    terminationCause = 'stage_abort';
  } else if (result.suspensionReason === 'scope_revision') {
    terminationCause = 'scope_revision_suspension';
  } else if (result.exitCode === 0) {
    terminationCause = 'complete';
  } else if (result.adapterError) {
    terminationCause = 'adapter_error';
  } else {
    terminationCause ??= 'failed';
  }
  if (stageAborted) result.output = renderStageAbortOutput(result.output, opts.stageId, attemptIndex, abortReason);
  if (approvalSuspended || timedOut || stageAborted || result.exitCode === 0) result.providerFailure = undefined;
  result.effectiveTimeoutMs = effectiveBudgetMs;
  result.timeoutTerminationCause = terminationCause;

  writeStageOutput(opts.projectDir, opts.runId, opts.stageId, result.output, attemptIndex);

  const artifacts = diffScopedArtifacts(beforeSnapshot, opts.projectDir, projectWriteScope);
  const structuredWrites = result.writeAttribution === 'structured' ? result.writes : undefined;
  const writes = structuredWrites ?? artifacts;
  const writeAttribution = structuredWrites ? 'structured' as const : 'snapshot' as const;
  // If no adapter child was started, reaching settlement itself proves there is
  // no live child. Otherwise only an adapter promise settlement may certify it.
  const childClosedAt = childCloseUnverified ? undefined : (lastChildClosedAt ?? new Date().toISOString());
  const deadlineSnapshot = attemptDeadline.snapshot();
  const timeoutSummary: StageAttemptTimeoutSummary = {
    attemptId: attemptDeadline.attemptId,
    budgetMs: effectiveBudgetMs,
    attemptStartedAt: attemptDeadline.attemptStartedAt,
    deadlineAt: attemptDeadline.deadlineAt,
    elapsedMs: deadlineSnapshot.elapsedMs,
    remainingMs: deadlineSnapshot.remainingMs,
    terminationCause,
    deadlineReachedAt: deadlineSnapshot.deadlineReachedAt,
    ...(childClosedAt ? { childClosedAt } : {}),
    deadlineOverrunMs: attemptDeadline.deadlineOverrunMs(),
  };
  attemptDeadline.append('attempt_finished', {
    stageId: opts.stageId,
    attemptIndex,
    exitCode: result.exitCode,
    effectiveBudgetMs,
    terminationCause,
  });
  let final = closeStageAttempt(opts.projectDir, opts.runId, opts.stageId, attemptIndex, {
    ...(correctionReinvocations > 0 ? { disposition: 'repaired' as const } : {}),
    exitCode: result.exitCode,
    duration_ms: result.duration_ms,
    processExitCode: result.processExitCode,
    processSignal: result.processSignal,
    providerFailure: result.providerFailure,
    artifacts,
    completedAt: new Date().toISOString(),
    error: result.exitCode !== 0
      ? (
        stageAborted
          ? (abortReason ? `aborted by engine: ${abortReason}` : 'aborted by engine')
          : result.providerFailure ? providerFailureDetail(result.exitCode, result.providerFailure)
          : result.adapterError ? `upstream adapter failure (${result.adapterFailureKind ?? 'unclassified'})`
          : result.timedOut ? `timed out after ${Math.round(effectiveBudgetMs / 1000)}s`
          // A diagnosed failure explains itself in one actionable sentence
          // instead of leaving the operator with a bare exit code.
          : result.friendlyError ? `Exit code ${result.exitCode} — ${result.friendlyError}`
          : `Exit code ${result.exitCode}`
      )
      : undefined,
    ...invocationUsageFields(result),
    invocations: result.invocations,
    adapterFailureKind: result.adapterFailureKind,
    writes,
    writeAttribution,
    validationGeneratedWrites: result.validationGeneratedWrites,
    timeout: timeoutSummary,
  });

  let boundaryError: unknown;
  try {
    const suspended = await opts.settlementBoundary?.('attempt_closed');
    final = settleStageAttempt(opts.projectDir, opts.runId, opts.stageId, attemptIndex, result.suspended === true || suspended === true);
  } catch (error) {
    boundaryError = error;
    final = settleStageAttempt(opts.projectDir, opts.runId, opts.stageId, attemptIndex, false,
      { exitCode: 1, error: error instanceof Error ? error.message : String(error) });
  }
  {
    const settled = final.attempts?.at(-1);
    const suspended = settled?.status === 'suspended';
    if (settled?.exitCode !== undefined) result.exitCode = settled.exitCode;
    result.suspended = suspended;
    if (result.exitCode !== 0 && !suspended) result.timeoutTerminationCause = settled?.timeout?.terminationCause ?? 'failed';
    recordRunEvent(opts.projectDir, opts.runId, {
      type: approvalSuspended ? 'approval_attempt_suspended' : suspended ? 'attempt_suspended' : result.exitCode === 0 ? 'attempt_finished' : 'attempt_failed',
      runId: opts.runId,
      timestamp: final.attempts?.at(-1)?.completedAt ?? new Date().toISOString(),
      stageId: opts.stageId,
      ...attemptEventFields(settled),
      status: final.status,
      exitCode: result.exitCode,
      adapterFailure: result.adapterError === true,
      ...(result.processExitCode !== undefined ? { processExitCode: result.processExitCode } : {}),
      ...(result.processSignal !== undefined ? { processSignal: result.processSignal } : {}),
      ...(result.providerFailure ? { providerFailure: result.providerFailure } : {}),
      ...(result.adapterFailureKind ? { adapterFailureKind: result.adapterFailureKind } : {}),
      ...(approvalRequestId ? { requestId: approvalRequestId } : {}),
      ...(approvalRequestingStageId ? { requestingStageId: approvalRequestingStageId } : {}),
      detail: approvalSuspended
        ? `attempt suspended for approval ${approvalRequestId ?? 'unknown'}`
        : suspended ? 'attempt suspended at scheduler control boundary' : result.exitCode === 0 ? 'attempt completed' : (final.error ?? `exit ${result.exitCode}`),
      source: 'worker',
    });

    // Return reconciled write attribution to the scheduler.
    result.writes = final.attempts?.at(-1)?.writes;
    result.writeAttribution = final.attempts?.at(-1)?.writeAttribution;

    // Final classification and durable settlement, rather than a raw child zero,
    // determine whether the successful-home cleanup policy applies.
    if (final.status === RUN_STATUS.COMPLETE && !opts.preserveSession && !suspended) {
      for (const stageId of new Set([opts.stageId, ...[...continuations.values()].map(session => session.ownerStageId)])) {
        finalizeStageSessions(opts.runDir, stageId);
      }
    }
  }
  if (boundaryError !== undefined) throw new StageAttemptSettlementError(opts.stageId, attemptIndex, boundaryError);
  return result;
  } finally {
    // Setup failures and thrown settlement errors also own this timer.
    attemptDeadline.dispose();
  }
}
