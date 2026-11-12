import { classifyEnding } from './attempt-ending.js';
import { runProjectCommand, VALIDATION_SELECTION_JSON_SCHEMA } from './project-validation.js';
import { runRecordPath, stageWorkPath, stageWritePath, requestPath } from './run-layout.js';
import { startCommandRecorder } from './recorded-command.js';
import { listProjectFiles } from './scheduler/sched_scope/path-capabilities.js';
import { stageLiveLogPath } from './stage-live-log.js';
import { isRetryableAdapterFailure } from './adapters/failure.js';
import { atomicWrite, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from './engine-fs.js';


// Module: worker
import { EngineStateError, withEngineIntegrity } from './engine-integrity.js';
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { recordInvocationInput } from './run-state-view.js';
import { finalizeStageSessions } from './adapter-session.js';
import { declaredOutputFacts, runStateContext } from './run-state-access.js';
import { providerFailureDetail } from './provider-result.js';
import { invocationUsageFields, sumInvocationUsage } from './invocation-usage.js';
import { renderPlanInterface, renderPlannerAdmissionCheck } from './plan-interface.js';
import { ARTIFACT_CONTRACT_SCHEMA_DOC, artifactDeclarationErrors, type ArtifactContract } from './artifact-declarations.js';
import { dirname, join, relative, resolve } from 'node:path';
import type { Adapter, AgentConfig, CommandLifecycleEvent, RunResult } from './adapters/base.js';
import { runProcessAbortSignal } from './adapters/base.js';
export { classifyAdapterFailure } from './adapters/failure.js';
import { appendEvidence, captureProjectTree, changedTreeFiles, evidenceContext } from './evidence-ledger.js';
import { adapterInputLimit, adapterInputLength, INPUT_RESERVE_CHARS, runAdapter } from './adapter-input.js';
import { createHash } from 'node:crypto';
import { buildStagePrompt, HANDOFF_SCHEMA, RECORDED_HANDOFF_SCHEMA, parseStageRecord } from './handoff.js';
import type { Schema } from './reality-gate/checks/json-schema-match.js';
import { recordValidationSelection, readRunValidationBaseline, recordGateValidationDelta, ensureAttemptValidationPlan } from './scheduler/sched_settlement/gate-validation.js';
import { validateGateCriterionEvidence, validateGateRepairability, explicitPassContradiction } from './scheduler/sched_settlement/gate-evidence.js';
import { AuditFindingsSchema } from './scoped-audit-repair.js';
import { readBriefCriteriaArtifact } from './brief-criteria.js';
import { normalizedProjectPath, parseDeclaredScope } from './scheduler/sched_admission/scope-services.js';
import { parseStageAbortSignal } from './abort-signal.js';
import {
  RUN_STATUS,
  STAGE_STATUS,
  beginStageAttempt,
  closeStageAttempt,
  settleStageAttempt,
  StageAttemptSettlementError,
  readRunState,
  writeStageStatus,
  writeStageOutput,
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
import {
  commandFingerprint,
  parseStageCommandInterrupt,
  type StageCommandInterruptSignal,
} from './command-interrupt.js';
import {
  compareContentIdentities,
  readContentIdentity,
  type ContentIdentity,
} from './content-identity.js';
import {
  inspectStageArtifactContract,
  writeStageArtifactContractAudit,
  stageArtifactProduction,
} from './stage-artifact-contract.js';
import { SINGLE_AUTHOR_NOTICE } from './scheduler/sched_policy/prompt-contracts.js';
import { buildGateDispatchPreamble } from './scheduler/sched_settlement/gate-archives.js';

/** Put the canonical IDs beside the planner's first proposal instructions. */
export function plannerCriterionAssignmentContext(_brief: string, runDir: string): string {
  const criteria = readBriefCriteriaArtifact(runDir)?.criteria ?? [];
  if (criteria.length === 0) return '';
  return [
    '# First-proposal criterion assignments',
    'Empty/omitted criterion_refs assign all criteria conservatively. Use these exact IDs only when assigning explicit subsets. Ordinary work needs a downstream independent gate.',
    JSON.stringify({ criterion_refs: criteria.map(criterion => criterion.id), path: runRecordPath(runDir, 'brief_criteria.json') }),
    'Read criterion text at this path; the system brief owns its full context.',
  ].join('\n');
}

export interface StageOpts {
  /** Scheduled stages return JSON; standalone legacy workers remain readable. */
  outputSchema?: Schema;
  /** Engine-built allowlist input; excludes handoffs, guidance and previous sessions. */
  isolatedInput?: { system: string; user: string };
  decisionResult?: boolean | 'shape';
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
  /** The worker awaits the scheduler settlement projection before publication. */
  settlementBoundary?: (phase: 'attempt_closed') => Promise<void>;
  projectDir: string;
  runId: string;
  runDir: string;
  retries: number;
  skills?: string;
  stageSkills?: string[];
  availableRoles?: string;
  availableChecks?: string;
  availableSkills?: string;
  contextInventory?: string;
  ledgerDigest?: string;
  taskDescription?: string;
  isGate?: boolean;
  gateContext?: Pick<Parameters<typeof buildGateDispatchPreamble>[0], 'authorIds' | 'fixStageIds' | 'roundDiffPath'>;
  /** A gate reviews this author's result, so a blocked result settles the stage for that gate to confirm or reject. */
  gateReviewed?: boolean;
  dynamicDispatch?: boolean;
  criterionRefs?: string[];
  resumeSessionId?: string;
  sessionOwnerStageId?: string;
  preserveSession?: boolean;
}

const ADAPTER_RETRY_DELAYS = [30_000, 60_000, 120_000];

function inferAdapterName(adapter: Adapter): string | undefined {
  const name = adapter.constructor?.name;
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return lower.endsWith('adapter') ? lower.slice(0, -'adapter'.length) : lower;
}

function snapshotScopedContent(projectDir: string, paths: string[] = []): Map<string, ContentIdentity> {
  return new Map([...new Set([...listProjectFiles(projectDir), ...paths])].map(path => [join(projectDir, path), readContentIdentity(join(projectDir, path))]));
}

function diffScopedArtifacts(
  before: Map<string, ContentIdentity>,
  projectDir: string,
): string[] {
  const after = snapshotScopedContent(projectDir, [...before.keys()].map(path => relative(projectDir, path)));
  const changed: string[] = [];
  const absent: ContentIdentity = { state: 'absent' };
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const prior = before.get(path) ?? absent;
    const current = after.get(path) ?? absent;
    // Unavailable content cannot prove equality across a state transition.
    // Nominate it for settlement without inventing a restorable preimage.
    if (compareContentIdentities(prior, current) !== 'different' && prior.state === current.state) continue;
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
    'writes', 'writeAttribution', 'constraintAudit', 'timeout', 'acceptedFrom', 'continuation', 'gate',
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
  // Old version-1 records stored bare hashes (or null for absence).
  artifactBaselines: Record<string, ContentIdentity | string | null>;
  recordedAt: string;
}

/** Mark the attempt stream so the watchdog excludes its bookkeeping bytes. */
export function beginAttemptEvidenceGeneration(
  runDirectory: string,
  stageId: string,
  attemptIndex: number,
  attemptStartedAt: string,
): AttemptEvidenceGeneration {
  const stagePath = runRecordPath(runDirectory, 'stages', stageId);
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
      output: readContentIdentity(join(stagePath, 'output.md')),
      verdict: readContentIdentity(runRecordPath(runDirectory, `verdict_${stageId}.json`)),
      handoff: readContentIdentity(runRecordPath(runDirectory, `handoff_${stageId}.md`)),
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
  const runState = existsSync(runRecordPath(opts.runDir, 'run.json'))
    ? readRunState(opts.projectDir, opts.runId) : undefined;
  mkdirSync(stageWritePath(opts.runDir, 'stages', opts.stageId), { recursive: true });
  const direct = runState?.workflowName === 'direct';
  const skillNames = opts.stageSkills ?? [];
  let prompt = opts.isolatedInput?.user ?? buildStagePrompt({
    dependsOn: opts.dependsOn,
    promptTemplate: opts.promptTemplate,
    projectDir: opts.projectDir,
    runId: opts.runId,
    runDir: opts.runDir,
    skills: opts.skills,
    skillNames,
    availableRoles: opts.availableRoles,
    availableSkills: opts.availableSkills,
    taskDescription: opts.taskDescription,
    isGate: opts.isGate,
    criterionRefs: opts.criterionRefs,
    stageId: opts.stageId,
    role: opts.role.name,
    handoffVisibility: opts.role.handoff_visibility,
  }, '');

  // Isolated decisions are read-only consumers. A repair can also return a
  // decision, but keeps the ordinary author boundary and its one validation.
  let attemptValidationPlan = !opts.isGate && !opts.dynamicDispatch && !(opts.decisionResult && opts.isolatedInput)
    ? ensureAttemptValidationPlan(opts.projectDir, opts.runId) : undefined;
  // Use the same raw declarations as configured validation, including ignored
  // artifacts. The rendered task description has already lost frontmatter.
  const evidenceBriefPath = runRecordPath(opts.runDir, 'task_brief.md');
  const evidenceBrief = existsSync(evidenceBriefPath) ? readFileSync(evidenceBriefPath, 'utf8') : opts.taskDescription ?? '';
  const evidenceTreeBefore = captureProjectTree(opts.projectDir, evidenceBrief, opts.runDir);

  const attribution = opts.attribution ?? {
    role: opts.role.name,
    iteration: existsSync(runRecordPath(opts.runDir, 'run.json'))
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
    wrapUp: true,
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
  const guidanceBeforePrompt = opts.isolatedInput ? [] : readGuidanceForStage(opts.runDir, opts.stageId, attemptIndex);
  // Retain delivered, targeted notices across execution boundaries. Their
  // original attempt identity remains explicit; only re-admission grants scope.
  try {
    const priorReceipt = opts.isolatedInput ? '' : readFileSync(runRecordPath(opts.runDir, 'stages', opts.stageId, 'guidance_consumed.md'), 'utf-8');
    for (const attempt of runningStatus.attempts ?? []) {
      for (const entry of guidanceForStageFromText(priorReceipt, opts.stageId, attempt.index)) {
        if (!guidanceBeforePrompt.some((current) => current.id === entry.id)) guidanceBeforePrompt.push(entry);
      }
    }
  } catch { /* first execution has no delivery receipt */ }
  const guidanceBlock = (entries: ReturnType<typeof readGuidanceForStage>): string =>
    renderGuidanceDelivery(guidanceForExecution(entries, attemptIndex));
  prompt = prompt
    .replace(/<current execution index>/g, String(attemptIndex))
    .replace(/<current attempt>/g, String(attemptIndex)); // legacy prompt templates
  beginAttemptEvidenceGeneration(opts.runDir, opts.stageId, attemptIndex, attemptStartedAt);
  recordRunEvent(opts.projectDir, opts.runId, {
    type: 'attempt_started',
    ...attemptEventFields(runningStatus.attempts?.at(-1)),
    runId: opts.runId,
    timestamp: attemptStartedAt,
    stageId: opts.stageId,
    source: 'worker',
  });

  const guidanceReceiptPath = runRecordPath(opts.runDir, 'stages', opts.stageId, 'guidance_consumed.md');
  const collectedGuidanceIds = new Set(guidanceBeforePrompt.map((entry) => entry.id));
  const collectedGuidance = [...guidanceBeforePrompt];
  const submittedGuidanceIds = new Set<string>();
  const retiredForGuidance = new Map<string, string[]>();
  let receiptContent: string | undefined;
  const persistGuidanceReceipt = (): void => {
    if (!submittedGuidanceIds.size && existsSync(guidanceReceiptPath)) return;
    try {
      mkdirSync(runRecordPath(opts.runDir, 'stages', opts.stageId), { recursive: true });
      const rendered = renderGuidanceDelivery(collectedGuidance.filter(entry => submittedGuidanceIds.has(entry.id)));
      const retired = [...new Set([...submittedGuidanceIds].flatMap(id => retiredForGuidance.get(id) ?? []))];
      const content = rendered ? `${rendered}\nRetired command IDs: ${JSON.stringify(retired)}\n` : 'No guidance was delivered to this execution.\n';
      if (content === receiptContent) return;
      writeFileSync(guidanceReceiptPath, content, 'utf-8');
      receiptContent = content;
    } catch { /* the run event remains the delivery audit */ }
  };
  const consumeNewGuidance = (
    boundary: 'attempt_start' | 'adapter_invocation' | 'tool_call_start' | 'tool_call_completion' | 'operator_interrupt',
    boundaryInvocationIndex?: number,
    commandEvent?: Pick<CommandLifecycleEvent, 'id' | 'command'>,
  ): void => {
    if (opts.isolatedInput) return;
    let entries: ReturnType<typeof readGuidanceForStage> = [];
    let checkFailed = false;
    try {
      routePendingOperatorGuidanceToStage(opts.runDir, opts.stageId);
      entries = readGuidanceForStage(opts.runDir, opts.stageId, attemptIndex)
        .filter((entry) => !collectedGuidanceIds.has(entry.id));
      for (const entry of entries) {
        collectedGuidanceIds.add(entry.id);
        collectedGuidance.push(entry);
      }
      persistGuidanceReceipt();
    } catch { checkFailed = true; }
    if (!entries.length && !checkFailed && boundary !== 'attempt_start' && boundary !== 'adapter_invocation') return;
    const currentDelivery = guidanceForExecution(boundary === 'attempt_start' ? collectedGuidance : entries, attemptIndex);
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
      delivered: false,
      detail: entries.length > 0
        ? `pending ${entries.length} new guidance envelope${entries.length === 1 ? '' : 's'} at ${boundary}`
        : boundary === 'attempt_start' && currentDelivery.length > 0
          ? `pending ${currentDelivery.length} guidance envelope${currentDelivery.length === 1 ? '' : 's'} at attempt start`
          : `no new guidance available at ${boundary}`,
      source: 'worker',
    });
  };
  consumeNewGuidance('attempt_start');

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
  let resolvedSystemPrompt = opts.role.prompt
    .replace(/\{available_roles\}/g, opts.availableRoles ?? '')
    .replace(/\{available_checks\}/g, opts.availableChecks ?? 'none')
    .replace(/\{available_skills\}/g, opts.availableSkills ?? 'none')
    .replace(/\{context_inventory\}/g, opts.contextInventory ?? 'none')
    .replace(/\{ledger_digest\}/g, opts.ledgerDigest ?? 'none')
    .replace(/\{terminal_statuses\}/g, TERMINAL_STATUSES.join(', '))
    .replace(/\{verdict_contract\}/g, VERDICT_CONTRACT_DOC)
    .replace(/\{artifact_contract_schema\}/g, () => ARTIFACT_CONTRACT_SCHEMA_DOC)
    .replace(/\{phase_metadata_fields\}/g, PHASE_METADATA_FIELDS)
    .replace(/\{project_contract\}/g, projectContract)
    .replace(/\{run_dir\}/g, stageWorkPath(opts.runDir))
    .replace(/\{project\}/g, opts.projectDir);
  try {
    const taskBriefPath = runRecordPath(opts.runDir, 'task_brief.md');
    if (existsSync(taskBriefPath)) {
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
      const historyDir = runRecordPath(opts.runDir, 'guidance_history');
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
    const criterionContext = plannerCriterionAssignmentContext(opts.taskDescription ?? '', opts.runDir);
    if (criterionContext) resolvedSystemPrompt += `\n\n${criterionContext}`;
    if (opts.dynamicDispatch) resolvedSystemPrompt += `\n\n${renderPlanInterface()}\n\n${renderPlannerAdmissionCheck(opts.projectDir, opts.runDir)}`;

  }

  if (opts.isolatedInput) {
    resolvedSystemPrompt = opts.isolatedInput.system;
    prompt = opts.isolatedInput.user;
  }
  const resolvedRole = { ...opts.role, prompt: resolvedSystemPrompt };
  // A wrap-up may suppress publication when the validated work is unfinished.
  const publicationCarriers = (record?: Record<string, unknown>): string[] => {
    if (!opts.outputSchema) return [];
    const carriers = opts.isGate && (!record || !wrapUpRequestedAt || finishedStageRecord(record)) ? [`verdict_${opts.stageId}.json`] : [];
    const handoff = `handoff_${opts.stageId}.md`;
    if (opts.artifactContract?.produces.some(output => output.root === 'run' && output.path === `work/${handoff}`)) carriers.push(handoff);
    return carriers;
  };
  // Preserve the existing legacy reader when the generated author schema gains
  // the optional selection field. Custom stage-result contracts stay exact.
  const recordedOutputSchema = opts.outputSchema === HANDOFF_SCHEMA ? { ...RECORDED_HANDOFF_SCHEMA,
    properties: { ...RECORDED_HANDOFF_SCHEMA.properties, validation: VALIDATION_SELECTION_JSON_SCHEMA } } : undefined;
  if (attemptValidationPlan && !attemptValidationPlan.baseline.discovery.commands.length && attemptValidationPlan.source !== 'model-selection'
    && opts.outputSchema === HANDOFF_SCHEMA && existsSync(runRecordPath(opts.runDir, 'task_brief.md'))) {
    // Reuse the author result, not a third decision stage or another model call.
    if (opts.outputSchema?.properties) opts = { ...opts, outputSchema: { ...opts.outputSchema,
      properties: { ...opts.outputSchema.properties, validation: VALIDATION_SELECTION_JSON_SCHEMA } } };
    prompt += '\n\n# Validation command selection\nNo project or brief command declaration is available. Read the repository and choose exact validation executable/argv and non-secret env inputs, preserving any data-isolating environment used in your measurements. Put required project inputs in each command env map; never rerun a bare command with an isolating variable omitted. Return commands in the optional validation field of your final result, using this fixed schema: '
      + JSON.stringify(VALIDATION_SELECTION_JSON_SCHEMA)
      + '. Use exact executable/argv and optional structured reporters; include dependency preparation in those commands if needed. Do not guess from names alone. An empty commands object states that no validation could be chosen, with the reason. Omitted or invalid selection remains explicitly unmeasured.';
  }
  if (opts.outputSchema) {
    const judgement = opts.isGate
      ? 'Judge assigned criteria in the context of the full brief, including permitted outcomes and stopping conditions. Stage instructions and extracted criteria cannot narrow or replace the outcomes the brief permits. Pass when an allowed outcome has all required evidence, including a permitted negative or blocked report. Reject missing required attempts, measurements or artifacts. '
      : '';
    prompt += `\n\n# Stage result\nReturn your final answer as one JSON document matching this schema:\n${JSON.stringify(opts.outputSchema)}\nThe engine validates and publishes that answer as the stage record${opts.isGate ? ` and verdict_${opts.stageId}.json` : ''}. This result contract supersedes older prose handoff, stage or verdict-file instructions. ${judgement}Write declared human deliverables within admitted capabilities. Evidence references name reproducible files or commands. List unfinished duties/checks in remaining_work; use [] only when all assigned work is complete.`;
  }
  if (opts.artifactContract) prompt += `\n\n# Declared output and input locations\n${JSON.stringify(opts.artifactContract)}`;

  prompt += `\n\nStage workspace: ${stageWorkPath(opts.runDir, 'stages', opts.stageId)}. Put probes and evidence here. The engine tree ${runRecordPath(opts.runDir, '.')} and the root run.json/events.jsonl are read-only. Run artifact paths must be inside work/.\n\n${SINGLE_AUTHOR_NOTICE}`;
  const historicalCandidates = readdirSync(runRecordPath(opts.runDir, 'stages', opts.stageId)).filter(name => /^(?:race_.*\.json|candidate_.*\.patch)$/.test(name));
  if (historicalCandidates.length) prompt += `\n\nHistorical candidate evidence (retained without selection or execution): ${historicalCandidates.map(name => runRecordPath(opts.runDir, 'stages', opts.stageId, name)).join(', ')}. Inspect unfinished candidate work and patches before continuing in this project; preserve accepted gate provenance.`;
  const terminalPaths = Object.values(runState?.terminalStates ?? {}).flatMap(entry => entry.paths);
  const beforeSnapshot = snapshotScopedContent(opts.projectDir, [
    ...terminalPaths, ...(opts.artifactContract?.produces ?? []).filter(artifact => artifact.root === 'project').map(artifact => artifact.path),
  ]);
  // A declared run product may belong to later work, but an available product
  // cannot disappear during this attempt. This fact was only model advice;
  // deletion alone cannot preserve it, so bind the engine check to this start.
  const availableProductsAtStart = existsSync(runRecordPath(opts.runDir, 'run.json'))
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
  const parentAbortSignal = runProcessAbortSignal();
  const abortSignalPath = runRecordPath(opts.runDir, 'signals', `abort_${opts.stageId}.json`);
  const commandInterruptSignalPath = requestPath(opts.runDir, 'signals', `interrupt_${opts.stageId}.json`);
  const liveLogPath = stageLiveLogPath(opts.runDir, opts.stageId, attemptIndex, attemptStartedAt);
  const activeCommands = new Map<string, CommandLifecycleEvent>();
  const interruptedCommands = new Map<string, StageCommandInterruptSignal>();
  let activeInvocationAbortController: AbortController | undefined;
  let activeInvocationIndex: number | undefined;
  type CommandBoundaryControl = {
    kind: 'guidance' | 'budget_wrap_up' | 'operator_interrupt';
    interrupt?: StageCommandInterruptSignal;
    retiredCommandIds?: string[];
  };
  let commandBoundaryControl: CommandBoundaryControl | undefined;
  let stageAborted = false;
  let abortReason = '';
  let terminationCause: RunResult['terminationCause'];
  let wrapUpRequestedAt: string | undefined;
  let wrapUpDeliveredAt: string | undefined;
  let wrapUpGuidanceId: string | undefined;
  const requestWrapUp = (): void => {
    if (wrapUpRequestedAt || attemptAbortController.signal.aborted) return;
    wrapUpRequestedAt = new Date(attemptDeadline.wallNow()).toISOString();
    const envelope = appendGuidanceEnvelope({ runDir: opts.runDir, target: opts.stageId, source: 'scheduler',
      knownStageIds: [opts.stageId], attemptIndex,
      body: `# Stage budget wrap-up\nTime is nearly up. Stop starting new work. Keep all admitted files. Finish safely and return your normal result with a concrete done/remaining handoff: what changed, evidence, unfinished duties and the next bounded action. Return remaining_work as a list of unfinished duties/checks, or [] only when all assigned work is complete. Do not claim unfinished work or unrun checks passed. If work remains, the next iteration continues these files. Hard stop: ${attemptDeadline.deadlineAt}; finishing interval: at least ${attemptDeadline.finishingMs} ms after the current child retires within its bounded closure window.` });
    wrapUpGuidanceId = envelope.id;
    consumeNewGuidance('adapter_invocation', activeInvocationIndex);
    if (activeInvocationAbortController && !activeInvocationAbortController.signal.aborted) {
      commandBoundaryControl = { kind: 'budget_wrap_up' };
      activeInvocationAbortController.abort('guidance_delivery_for_budget_wrap_up');
    }

    recordRunEvent(opts.projectDir, opts.runId, { type: 'stage_wrap_up_requested', runId: opts.runId,
      timestamp: wrapUpRequestedAt, stageId: opts.stageId, attemptIndex, attemptStartedAt,
      guidanceId: envelope.id, finishingMs: attemptDeadline.finishingMs, deadlineAt: attemptDeadline.deadlineAt, source: 'worker' });
  };
  attemptDeadline.wrapUpSignal.addEventListener('abort', requestWrapUp, { once: true });
  if (attemptDeadline.wrapUpSignal.aborted) requestWrapUp();
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
    if (parentAbortSignal?.aborted) {
      stageAborted = true;
      terminationCause = 'stage_abort';
      abortReason ||= 'enclosing run cancelled';
      if (!attemptAbortController.signal.aborted) attemptAbortController.abort('stage_abort');
    }
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
      stageAborted = true;
      terminationCause ??= 'stage_abort';
      try { appendFileSync(liveLogPath, `\nStage abort signal consumed for attempt ${attemptIndex}; killing stage child process.\n`); }
      catch { /* non-critical */ }
      attemptAbortController.abort('stage_abort');
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
      const invocationMatches = signal.invocationIndex === undefined
        ? active && commandFingerprint(active.command ?? '') === signal.commandFingerprint
        : signal.invocationIndex === activeInvocationIndex;
      if (signal.stageId !== opts.stageId
        || signal.attemptIndex !== attemptIndex
        || signal.attemptStartedAt !== attemptStartedAt
        || !invocationMatches) {
        removeCommandInterruptSignal();
        appendAbortWarning(
          `Ignored stale operator command interrupt ${signal.requestId}: it does not match the active invocation in attempt ${attemptIndex}.`,
        );
        return;
      }

      const acceptedGuidance = appendGuidanceEnvelope({ runDir: opts.runDir, target: opts.stageId,
        source: 'operator', body: signal.reason, knownStageIds: [opts.stageId], createdAt: signal.requestedAt, attemptIndex });
      signal.guidanceId = acceptedGuidance.id;
      recordRunEvent(opts.projectDir, opts.runId, { type: 'stage_command_interrupt_requested', runId: opts.runId,
        timestamp: signal.requestedAt, stageId: opts.stageId, attemptIndex, attemptStartedAt,
        requestId: signal.requestId, guidanceId: signal.guidanceId, commandId: signal.commandId, commandIds: [...activeCommands.keys()],
        command: signal.command, commandFingerprint: signal.commandFingerprint, detail: signal.reason, source: 'operator' });
      // Consume before stopping the child so a crash cannot replay this exact
      // request into a later command or attempt.
      removeCommandInterruptSignal();
      for (const command of activeCommands.values()) interruptedCommands.set(commandFingerprint(command.command ?? ''), signal);
      consumeNewGuidance('operator_interrupt', activeInvocationIndex, active ?? { id: signal.commandId, command: signal.command });
      commandBoundaryControl = {
        kind: 'operator_interrupt',
        interrupt: signal,
        retiredCommandIds: [...activeCommands.keys()],
      };
      try {
        appendFileSync(
          liveLogPath,
          `\nOperator interrupt ${signal.requestId} matched command ${signal.commandId}; stopping all commands of the current adapter invocation.\n`,
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
  const pollRequests = (): void => {
    pollAbortSignal();
    pollCommandInterruptSignal();
  };
  pollRequests();
  const requestPollTimer = setInterval(pollRequests, 1000);
  const requestWatchers: import('node:fs').FSWatcher[] = [];
  try {
    const signalsDir = runRecordPath(opts.runDir, 'signals');
    mkdirSync(requestPath(opts.runDir, 'signals'), { recursive: true });
    mkdirSync(signalsDir, { recursive: true });
    for (const directory of [runRecordPath(opts.runDir, 'stages', opts.stageId), signalsDir, requestPath(opts.runDir, 'signals')]) {
      requestWatchers.push(watch(directory, { persistent: false }, (_event, fileName) => {
        const name = fileName?.toString() ?? '';
        if (!name || name === `abort_${opts.stageId}.json`) pollAbortSignal();
        if (!name || name === `interrupt_${opts.stageId}.json`) pollCommandInterruptSignal();
      }));
    }
  } catch { /* one-second reconciliation remains the portable fallback */ }
  const aggregateAbortSignal = AbortSignal.any([attemptAbortController.signal, attemptDeadline.signal,
    ...(parentAbortSignal ? [parentAbortSignal] : [])]);
  const cancelledResult = (telemetry?: RunResult): RunResult => {
    const tokensIn = typeof telemetry?.tokens_in === 'number' && Number.isFinite(telemetry.tokens_in)
      ? telemetry.tokens_in
      : undefined;
    const tokensOut = typeof telemetry?.tokens_out === 'number' && Number.isFinite(telemetry.tokens_out)
      ? telemetry.tokens_out
      : undefined;
    const timedOut = !stageAborted && (terminationCause === 'attempt_timeout' || attemptDeadline.signal.aborted);
    return {
      output: '',
      exitCode: timedOut ? 124 : 137,
      ...(telemetry?.processExitCode !== undefined ? { processExitCode: telemetry.processExitCode } : {}),
      ...(telemetry?.processSignal !== undefined ? { processSignal: telemetry.processSignal } : {}),
      // Telemetry belongs to this invocation; adding the whole attempt here
      // would count earlier turns twice when the warning retired a child.
      duration_ms: telemetry?.duration_ms ?? Math.round(attemptElapsedMs()),
      timedOut,
      ...invocationUsageFields({ ...telemetry, tokens_in: tokensIn, tokens_out: tokensOut }),
      invocations: telemetry?.invocations,
    };
  };
  const observeAdapterSettlement = (): void => {
    // Timer starvation delays both deadline and abort polling. Consume a
    // current-attempt ABORT first because abort authority takes
    // precedence, then observe the monotonic deadline synchronously.
    pollAbortSignal();
    if (!stageAborted) attemptDeadline.observeSettlement();
  };
  let lastChildClosedAt: string | undefined;
  let childCloseUnverified = false;
  let invocationIndex = 0;
  let inputRecordIndex = 0;
  // No live-session exceptions: all continuation state is reconstructible from
  // the ledger, current files, delivered guidance and the last final record.
  let previousInvocation: object | undefined;

  const deadlineContext = (): string => `# Execution clock\nExecution ${attemptIndex}: started ${attemptDeadline.attemptStartedAt}; stage budget ends ${attemptDeadline.budgetDeadlineAt}; wrap-up warning ${attemptDeadline.wrapUpAt}; absolute deadline (hard stop) ${attemptDeadline.deadlineAt}; remaining ${Math.floor(attemptDeadline.remainingMs())} ms at ${new Date(attemptDeadline.wallNow()).toISOString()}. This deadline is immutable. Retries, backoff and fallback consume that same budget; corrections share this hard stop. Query UTC time with node -e "console.log(new Date().toISOString())".`;
  const invokeAdapter = async (
    selectedAdapter: Adapter,
    selectedRole: AgentConfig,
    invocationPrompt = prompt,
  ): Promise<RunResult> => {
    if (aggregateAbortSignal.aborted || attemptDeadline.remainingMs() <= 0) {
      if (attemptDeadline.signal.aborted) terminationCause ??= 'attempt_timeout';
      return cancelledResult();
    }

    invocationIndex++;
    const invocationRole = selectedRole;
    consumeNewGuidance('adapter_invocation', invocationIndex);
    const additionalGuidance = (opts.isolatedInput ? [] : collectedGuidance).filter((entry) => !prompt.includes(renderGuidanceEnvelope(entry)));
    const stateContext = opts.isolatedInput ? '' : runStateContext(opts.projectDir, opts.runId, opts.planRevision);
    // Fresh children read current facts and bytes. The own-stage predecessor
    // stays bound to the attempt that preceded this execution, not its children.
    const rest = `${prompt}${invocationPrompt === prompt ? '' : `\n\n${invocationPrompt}`}\n\n${guidanceBlock(additionalGuidance)}\n\n${previousInvocation ? `# Previous invocation record\n${JSON.stringify(previousInvocation)}\n\n` : ''}${deadlineContext()}\n\n${stateContext}`;
    const currentEvidence = opts.isolatedInput ? '' : evidenceContext(opts.projectDir, opts.runDir, opts.stageId, previous ?? null,
      adapterInputLimit(selectedAdapter, runState?.inputLimitChars) - INPUT_RESERVE_CHARS - adapterInputLength(invocationRole.prompt, rest));
    const effectiveInvocationPrompt = `${currentEvidence ? `${currentEvidence}\n\n` : ''}${rest}`;
    const captureInput = (input: Parameters<NonNullable<import('./adapters/base.js').RunOpts['onInvocationInput']>>[0], boundary: 'adapter' | 'model'): void => {
      // The public standalone worker API predates initialized run projections.
      // Keep it usable, but do not manufacture an authenticated run carrier.
      if (!existsSync(runRecordPath(opts.runDir, 'run.json'))) {
        appendFileSync(liveLogPath, '\nINVOCATION_INPUT_UNAVAILABLE: standalone stage has no initialized run projection.\n');
        return;
      }
      const submitted = guidanceForExecution(collectedGuidance, attemptIndex).filter(entry =>
        input.userPrompt.includes(renderGuidanceEnvelope(entry)) || input.systemPrompt.includes(renderGuidanceEnvelope(entry)));
      recordInvocationInput(opts.runDir, {
        runId: opts.runId, stageId: opts.stageId, attemptIndex, attemptStartedAt,
        invocationIndex: ++inputRecordIndex, boundary,
        adapter: invocationRole.adapter ?? inferAdapterName(selectedAdapter) ?? 'custom',
        model: input.model ?? invocationRole.model ?? 'provider-default-unresolved', systemPrompt: input.systemPrompt, userPrompt: input.userPrompt,
        resumeSessionId: input.resumeSessionId, transport: input.transport, guidanceIds: submitted.map(entry => entry.id),
      });
      const newlySubmitted = submitted.filter(entry => !submittedGuidanceIds.has(entry.id));
      for (const entry of newlySubmitted) submittedGuidanceIds.add(entry.id);
      if (newlySubmitted.length) {
        persistGuidanceReceipt();
        recordRunEvent(opts.projectDir, opts.runId, { type: 'guidance_delivery_checked', runId: opts.runId,
          timestamp: new Date().toISOString(), stageId: opts.stageId, attemptIndex, attemptStartedAt, invocationIndex,
          boundary: 'model_submission', guidanceIds: newlySubmitted.map(entry => entry.id), delivered: true,
          retiredCommandIds: [...new Set(newlySubmitted.flatMap(entry => retiredForGuidance.get(entry.id) ?? []))],
          detail: 'Guidance delivered in submitted invocation input', source: 'worker' });
      }
      // Record submitted input at the adapter's existing input boundary. Merely
      // preparing a prompt does not establish that a native call received it.
      if (wrapUpRequestedAt && !wrapUpDeliveredAt && submitted.some(entry => entry.id === wrapUpGuidanceId)) {
        wrapUpDeliveredAt = new Date(attemptDeadline.wallNow()).toISOString();

        recordRunEvent(opts.projectDir, opts.runId, { type: 'stage_wrap_up_delivered', runId: opts.runId,
          timestamp: wrapUpDeliveredAt, stageId: opts.stageId, attemptIndex, attemptStartedAt, invocationIndex,
          remainingMs: attemptDeadline.remainingMs(), source: 'worker' });
      }
    };
    const invocationAbortController = new AbortController();
    commandBoundaryControl = undefined;
    activeInvocationAbortController = invocationAbortController;
    activeInvocationIndex = invocationIndex;
    const invocationAbortSignal = AbortSignal.any([aggregateAbortSignal, invocationAbortController.signal]);
    const onCommandLifecycle = (event: CommandLifecycleEvent): void => {
      if (event.phase === 'completed') appendEvidence(opts.runDir, { kind: 'command', stageId: opts.stageId, attemptIndex, invocationIndex,
        commandId: event.id, command: activeCommands.get(event.id)?.command ?? event.command ?? null,
        context: activeCommands.get(event.id)?.context,
        exitCode: event.exitCode ?? null, owner: 'adapter-event',
        ...(event.output === undefined ? {} : { outputDigest: createHash('sha256').update(event.output).digest('hex') }) });
      if (event.phase === 'started') {
        activeCommands.set(event.id, event);
        consumeNewGuidance('tool_call_start', invocationIndex, event);
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
      consumeNewGuidance('tool_call_completion', invocationIndex, completed);
      if (!commandBoundaryControl && guidanceForExecution(collectedGuidance, attemptIndex).some(entry => !submittedGuidanceIds.has(entry.id))) commandBoundaryControl = { kind: 'guidance' };
      if (commandBoundaryControl?.kind === 'guidance' && !invocationAbortController.signal.aborted) {
        commandBoundaryControl.retiredCommandIds = [...activeCommands.keys()];
        invocationAbortController.abort('guidance_delivery_at_tool_completion');
      }
    };
    let recordedCommandIndex = 0;
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
        if (commandBoundaryControl) commandBoundaryControl.retiredCommandIds ??= [...activeCommands.keys()];
        // The signal initiates cancellation; the adapter promise is the child
        // lifecycle acknowledgement. Wait for it before claiming childClosedAt.
        // A broken adapter is bounded by the observation tolerance and is then
        // recorded without a child-close timestamp instead of hanging forever.
        if (!closeObservationTimer) {
          closeObservationTimer = setTimeout(() => {
            childCloseUnverified = true;
            finish({ ...cancelledResult(), exitCode: 125, timedOut: false, engineVoid: true, terminationCause: 'engine_void',
              friendlyError: 'ENGINE_STATE_REFUSED: adapter child closure is unverified; preserve its ownership evidence and exclude live consumers before continuing' });
          }, ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS);
        }
      };
      invocationAbortSignal.addEventListener('abort', onAbort, { once: true });
      withEngineIntegrity({ projectDir: opts.projectDir, runDir: opts.runDir,
        stageId: opts.stageId, artifactContract: opts.artifactContract!,
        },
      async () => {
        const recorder = opts.isGate ? await startCommandRecorder(opts.runDir, async (request, signal) => {
          const before = captureProjectTree(opts.projectDir, evidenceBrief, opts.runDir);
          const response = await runProjectCommand({ role: 'test', command: request.shell, args: ['-c', request.command],
            display: request.command, cwd: request.cwd, runDir: opts.runDir,
            timeoutMs: Math.max(1, Math.min(60_000, attemptDeadline.remainingMs())),
            abortSignal: AbortSignal.any([invocationAbortSignal, signal]) });
          const record = appendEvidence(opts.runDir, { kind: 'command', owner: 'code', stageId: opts.stageId, attemptIndex, invocationIndex,
            commandId: `recorded-${invocationIndex}-${++recordedCommandIndex}`, command: request.command,
            context: { cwd: request.cwd, shell: request.shell }, exitCode: response.error ? null : response.exitCode,
            outputDigest: createHash('sha256').update(JSON.stringify([response.stdout ?? '', response.stderr ?? ''])).digest('hex'),
            treeHash: before.hash, treeAfterHash: captureProjectTree(opts.projectDir, evidenceBrief, opts.runDir).hash });
          return { record, stdout: response.stdout ?? '', stderr: response.stderr ?? '', ...(response.error ? { error: response.error } : {}) };
        }) : undefined;
        const recordingInstruction = recorder ? `\n\n## Engine-recorded command\nRun ${recorder.command} '<JSON>' through your native shell tool, replacing <JSON> with {"command":"your targeted command","cwd":"${opts.projectDir}","shell":"/bin/bash"} (properly shell-quoted). The engine executes shell -c command in that cwd with its isolated command environment and a maximum 60-second bound, returns the output and records command, context, exit, digest and tree hashes in the ledger. Read the returned record.sequence and cite it as reproduction. Use this path when native command events omit execution context. The endpoint closes with this invocation. This is a targeted experiment, never configured validation.\n` : '';
        const recordedPrompt = effectiveInvocationPrompt + recordingInstruction;
        try {
        return await runAdapter(selectedAdapter, recordedPrompt, invocationRole, {
          timeout_ms: Math.max(1, Math.floor(attemptDeadline.remainingMs())),
          workDir: opts.projectDir,
          runDir: opts.runDir,
          stageId: opts.stageId,
          attemptIndex,
          attemptStartedAt,
          invocationIndex,
          // The worker owns final cleanup; an adapter call may be corrected.
          preserveSession: true,
          abortSignal: invocationAbortSignal,
          onCommandLifecycle,
          onInvocationInput: (input) => captureInput(input, 'model'),
          outputSchema: opts.outputSchema,
        }, runState?.inputLimitChars, () => {
          if (!selectedAdapter.capturesInvocationInput) captureInput({ systemPrompt: invocationRole.prompt, userPrompt: recordedPrompt }, 'adapter');
        });
        } finally { await recorder?.close(); }
      }).then(
        (value) => {
          let finalRecord: unknown;
          try { finalRecord = JSON.parse(value.output); } catch { /* no structured final record */ }
          previousInvocation = { invocationIndex, exitCode: value.exitCode, finalRecord,
            guidanceIds: [...submittedGuidanceIds] };
          lastChildClosedAt = new Date().toISOString();
          observeAdapterSettlement();
          // Cancellation changes the attempt outcome, not telemetry already
          // parsed while the adapter was closing its child process.
          finish(value.engineVoid
            ? value : aggregateAbortSignal.aborted ? cancelledResult(value) : value);
        },
        (error) => {
          lastChildClosedAt = new Date().toISOString();
          observeAdapterSettlement();
          if (error instanceof EngineStateError) {
            finish({ engineVoid: true, terminationCause: 'engine_void', output: error.message, friendlyError: error.message, exitCode: 125, duration_ms: Math.round(attemptElapsedMs()) });
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
      for (const command of activeCommands.values()) appendEvidence(opts.runDir, { kind: 'command', stageId: opts.stageId, attemptIndex, invocationIndex,
        commandId: command.id, command: command.command ?? null, exitCode: null, owner: 'adapter-event',
        evidence: 'Native stream closed without a completion exit; outcome unknown' });
      activeCommands.clear();
      if (activeInvocationAbortController === invocationAbortController) {
        activeInvocationAbortController = undefined;
        activeInvocationIndex = undefined;
      }
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
    if (opts.decisionResult && opts.decisionResult !== 'shape') return {}; // Review/successor defaults remain scheduler-owned.
    const record = parseStageRecord(output, recordedOutputSchema ?? opts.outputSchema!);
    if (opts.isGate) {
      const violation = validateGateCriterionEvidence(opts.runDir, opts.stageId, record)
        ?? validateGateRepairability(record) ?? explicitPassContradiction(record, 'verdict');
      if (violation) throw new Error(violation);
      const findings = AuditFindingsSchema.parse(record.audit_findings);
      if (record.pass === true && findings.findings.length) throw new Error('AUDIT_FINDINGS_OPEN: passing verdict has unresolved findings');
    }
    return record;
  };
  const finishedStageRecord = (record: Record<string, unknown>): boolean => {
    // A completed rejection keeps its existing authority. Otherwise require an
    // explicit empty list: delivered/pass alone can also describe partial work.
    return Boolean(opts.decisionResult) || record.status === 'environment_gap' || opts.isGate && record.pass === false
      || Array.isArray(record.remaining_work) && record.remaining_work.length === 0
        && (opts.isGate ? record.pass === true : record.status === 'delivered');
  };
  let stageWorkFinished = false;
  let validatedStageRecord: Record<string, unknown> | undefined;
  let unreviewedGap = false;
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
      // closed before another child is started.
      if (childCloseUnverified) return combined;
      if (!isRetryableAdapterFailure(current.providerFailure?.kind)) return combined;
      if (commandControl && !aggregateAbortSignal.aborted) {
        for (const entry of collectedGuidance.filter(entry => !submittedGuidanceIds.has(entry.id))) retiredForGuidance.set(entry.id, commandControl.retiredCommandIds ?? []);
        // A valid completed result needs no replacement finishing turn, even
        // when the warning arrived before the child's result was observed.
        if (commandControl.kind === 'budget_wrap_up' && current.exitCode === 0 && opts.outputSchema) {
          try { if (finishedStageRecord(stageRecord(current.output))) return combined; }
          catch { /* malformed results still need the bounded finishing turn */ }
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
            commandId: commandControl.interrupt.commandId,
            commandIds: commandControl.retiredCommandIds ?? [],
            ...(commandControl.interrupt.command ? {
              command: commandControl.interrupt.command,
              commandFingerprint: commandControl.interrupt.commandFingerprint,
            } : {}),
            detail: commandControl.interrupt.reason,
            source: 'worker',
          });
        }
        const label = commandControl.kind === 'budget_wrap_up' ? 'Stage budget wrap-up' : commandControl.kind === 'operator_interrupt'
          ? 'Operator command interrupt'
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
      if (combined.exitCode !== 0 || !opts.outputSchema || opts.decisionResult) return combined;
      let recordError: string;
      try {
        stageRecord(combined.output);
        return combined;
      }
      catch (error) { recordError = `Stage record refused: ${error instanceof Error ? error.message : String(error)}`; }
      const instruction = `# Stage result correction\n${recordError}\nDo not repeat the completed work. Correct only the final JSON document using the retained work and evidence. Preserve the substantive result; never invent evidence or change a rejection to pass to satisfy the format.\n${JSON.stringify({ error: recordError, rejectedAnswer: combined.output })}`;
      if (correctionReinvocations >= 1 || aggregateAbortSignal.aborted) {
        return {
          ...combined,
          exitCode: aggregateAbortSignal.aborted ? combined.exitCode : 1,
          timedOut: aggregateAbortSignal.aborted ? combined.timedOut : false,
          providerFailure: undefined,
          friendlyError: aggregateAbortSignal.aborted
            ? combined.friendlyError
            : recordError,
        };
      }
      correctionReinvocations++;
      invocationPrompt = instruction;
      try {
        appendFileSync(
          liveLogPath,
          `\n${recordError}; reinvoking inside attempt ${attemptIndex}.\n`,
        );
      } catch { /* durable incident JSONL remains the audit source */ }
    }
  };
  const adapterRetryDelays = opts.technicalRetry?.delaysMs ?? ADAPTER_RETRY_DELAYS;
  const waitForRetry = async (delayMs: number): Promise<boolean> => {
    const canInvoke = () => !aggregateAbortSignal.aborted && attemptDeadline.remainingMs() > 0;
    if (!canInvoke()) return false;
    // Backoff cannot spend the finishing interval before its instruction gets
    // a native turn. The warning wakes the existing finite retry loop.
    if (delayMs <= 0 || attemptDeadline.wrapUpSignal.aborted) return true;
    const completed = await attemptDeadline.boundedSleep(delayMs,
      AbortSignal.any([aggregateAbortSignal, attemptDeadline.wrapUpSignal]));
    return (completed || attemptDeadline.wrapUpSignal.aborted) && canInvoke();
  };

  let result: RunResult;
  // All adapter work shares one immutable attempt boundary.
  try {
  try {
    const preflightErrors = artifactDeclarationErrors(opts.artifactContract, opts.stageId);
    if (!preflightErrors.length && opts.isGate && !aggregateAbortSignal.aborted) {
      await recordGateValidationDelta(opts.projectDir, opts.runId, opts.stageId);
    }
    result = aggregateAbortSignal.aborted ? { ...cancelledResult(), output: preflightErrors.join('\n') }
      : preflightErrors.length ? { output: preflightErrors.join('\n'), exitCode: 1, duration_ms: Math.round(attemptElapsedMs()), friendlyError: preflightErrors.join('; ') }
      : await invokeAdapterWithCorrection(adapter, resolvedRole);

    // Adapter error detection + exponential backoff retry on the SAME adapter.
    if (result.exitCode !== 0 && result.providerFailure !== undefined && isRetryableAdapterFailure(result.providerFailure?.kind)) {
      for (let attempt = 0; attempt < adapterRetryDelays.length; attempt++) {
        if (aggregateAbortSignal.aborted) break;
        const retryDelayMs = Math.max(0, adapterRetryDelays[attempt]);
        const delaySec = Math.round(retryDelayMs / 1000);
        try { appendFileSync(liveLogPath, `\n⏳ Adapter error detected — retrying in ${delaySec}s (attempt ${attempt + 2}/${adapterRetryDelays.length + 1})…\n`); } catch { /* ignore */ }

        if (!await waitForRetry(retryDelayMs)) {
          result = cancelledResult();
          break;
        }
        result = await invokeAdapterWithCorrection(adapter, resolvedRole);
        if (result.exitCode === 0 || !result.providerFailure || !isRetryableAdapterFailure(result.providerFailure?.kind)) break;
      }

      // The adapter classifies its own diagnostic channel. Worker output is an
      // agent message and may quote an error string without any adapter failure.
    }
  } catch (error) {
    observeAdapterSettlement();
    if (!aggregateAbortSignal.aborted) throw error;
    result = cancelledResult();
  }

  const enginePublishedCarriers: string[] = [];
  let blockedStageResult = false;
  if (result.exitCode === 0 && opts.outputSchema) {
    try {
      const resultPath = stageWritePath(opts.runDir, 'stages', opts.stageId, 'result.json');
      mkdirSync(dirname(resultPath), { recursive: true });
      atomicWrite(resultPath, result.output);
      const record = stageRecord(readFileSync(resultPath, 'utf8'));
      validatedStageRecord = record;
      blockedStageResult = record.status === 'blocked' || record.status === 'environment_gap';
      stageWorkFinished = finishedStageRecord(record);
      if (!opts.dynamicDispatch && !opts.isGate && !opts.gateReviewed && blockedStageResult) {
        unreviewedGap = record.status === 'environment_gap';
        throw new Error(`Blocked: ${record.summary}`);
      }
      const destinations = publicationCarriers(record).map(carrier => ({ carrier, work: stageWritePath(opts.runDir, carrier) }));
      for (const { carrier, work } of destinations) {
        atomicWrite(runRecordPath(opts.runDir, carrier), `${JSON.stringify(record)}\n`);
        atomicWrite(work, `${JSON.stringify(record)}\n`);
        enginePublishedCarriers.push(`run:work/${carrier}`);
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
      const audit = inspectStageArtifactContract(artifactInput, blockedStageResult || Boolean(wrapUpRequestedAt && !stageWorkFinished) || result.exitCode !== 0);
      const productFacts = existsSync(runRecordPath(opts.runDir, 'run.json')) ? declaredOutputFacts(opts.projectDir, opts.runId) : [];
      // A single direct author owns the whole brief. Split plans settle each
      // stage's artifact contract; completion still requires every run product.
      const authors = runState?.planControl?.stages.filter(stage => !stage.is_gate && !stage.dynamic_dispatch && !stage.retry_to?.length);
      const dueProducts = direct && (authors?.length ?? 1) <= 1 && !opts.isGate && !opts.dynamicDispatch && !blockedStageResult && (!wrapUpRequestedAt || stageWorkFinished) && result.exitCode === 0 ? productFacts : [];
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
      result.providerFailure = undefined;
      result.friendlyError = `artifact contract could not be checked: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  } finally {
    pollAbortSignal();
    clearInterval(requestPollTimer);
    for (const watcher of requestWatchers) watcher.close();
    attemptDeadline.wrapUpSignal.removeEventListener('abort', requestWrapUp);
    cleanupAbortSignalAtExit();
    cleanupCommandInterruptSignalAtExit();
    // The execution attempt ends after adapter settlement.
    // A blocked event loop can settle after the immutable boundary before its
    // timer callback runs, so observe monotonic expiry before disposal.
    if (!stageAborted) attemptDeadline.observeSettlement();
    // Dispose here as well on thrown adapter errors so no long deadline timer
    // survives this invocation and keeps the worker process alive.
    attemptDeadline.dispose();
  }

  const settlementRefused = result.exitCode === 125 || Boolean(result.exitCode !== 0 && result.friendlyError && !result.timedOut);
  const environmentGap = (result.exitCode === 0 || unreviewedGap) && validatedStageRecord?.status === 'environment_gap';
  if (attemptDeadline.signal.aborted && !stageAborted) terminationCause = 'attempt_timeout';
  const timedOut = !environmentGap && result.providerFailure?.kind !== 'quota' && !settlementRefused && !stageAborted && (
    terminationCause === 'attempt_timeout'
    || result.exitCode === 124
    || result.timedOut === true
    || (result.duration_ms >= effectiveBudgetMs && result.exitCode !== 0)
  );
  if (result.engineVoid) {
    terminationCause = 'engine_void';
  } else if (timedOut) {
    result.exitCode = 124;
    result.timedOut = true;
    terminationCause = 'attempt_timeout';
  } else if (stageAborted) {
    result.exitCode = 137;
    result.timedOut = false;
    terminationCause = 'stage_abort';

  } else {
    terminationCause = 'exit';
  }
  const structuredWrites = result.writeAttribution === 'structured' ? result.writes : undefined;
  const artifacts = diffScopedArtifacts(beforeSnapshot, opts.projectDir);
  if (!result.engineVoid && !stageAborted && !environmentGap && result.providerFailure?.kind !== 'quota'
    && (result.exitCode === 0 && wrapUpRequestedAt && !stageWorkFinished || timedOut)) {
    const forced = timedOut;
    const retainedPaths = artifacts;
    const summary = `Engine budget handoff. Done/evidence: retained changed files ${JSON.stringify(retainedPaths)} and the execution log at ${liveLogPath}. Their bytes are kept; unfinished duties are not certified complete. Remaining: ${JSON.stringify(validatedStageRecord?.remaining_work ?? ["Complete declared duties and unfinished checks; verify retained work before continuing."])}. Disposition: ${forced ? 'bounded grace expired; child stopped with work kept' : 'cooperative wrap-up completed normally'}.`;
    result.continuation = { reason: 'stage_budget', forced, summary,
      handoff: `stages/${opts.stageId}/output_attempt_${attemptIndex}.md` };
    result.exitCode = 0;
    result.timedOut = false;
    result.friendlyError = undefined;
    terminationCause = 'exit';
    // Keep authored JSON intact. A forced stop has no authored result; publish
    // a typed control handoff rather than inventing a gate verdict or checks.
    if (forced) result.output = JSON.stringify({ status: 'delivered', summary, checks: [],
      caveats: ['Engine-retained partial work; no authored completion or gate acceptance is inferred.'] });
    recordRunEvent(opts.projectDir, opts.runId, { type: forced ? 'stage_wrap_up_forced' : 'stage_wrap_up_completed',
      runId: opts.runId, timestamp: new Date().toISOString(), stageId: opts.stageId, attemptIndex, attemptStartedAt,
      handoff: result.continuation.handoff, source: 'worker' });
  }
  if (stageAborted) result.output = renderStageAbortOutput(result.output, opts.stageId, attemptIndex, abortReason);
  if (timedOut || stageAborted || result.exitCode === 0) result.providerFailure = undefined;
  result.effectiveTimeoutMs = effectiveBudgetMs;
  result.terminationCause = terminationCause;
  result.endingCause = classifyEnding({ ...result, cancelled: stageAborted, providerQuota: result.providerFailure?.kind === 'quota', environmentGap, unfinished: Boolean(result.continuation) });

  writeStageOutput(opts.projectDir, opts.runId, opts.stageId, result.output, attemptIndex);

  const writes = [...new Set([...(structuredWrites ?? []), ...artifacts])];
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
    budgetDeadlineAt: attemptDeadline.budgetDeadlineAt,
    wrapUpAt: attemptDeadline.wrapUpAt,
    finishingMs: attemptDeadline.finishingMs,
    wrapUpRequestedAt, wrapUpDeliveredAt,
    elapsedMs: deadlineSnapshot.elapsedMs,
    remainingMs: deadlineSnapshot.remainingMs,
    deadlineReachedAt: deadlineSnapshot.deadlineReachedAt,
    ...(childClosedAt ? { childClosedAt } : {}),
    deadlineOverrunMs: attemptDeadline.deadlineOverrunMs(),
  };

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
          : result.timedOut ? `timed out after ${Math.round(effectiveBudgetMs / 1000)}s`
          // A diagnosed failure explains itself in one actionable sentence
          // instead of leaving the operator with a bare exit code.
          : result.friendlyError ? `Exit code ${result.exitCode} — ${result.friendlyError}`
          : `Exit code ${result.exitCode}`
      )
      : undefined,
    ...invocationUsageFields(result),
    invocations: result.invocations,
    terminationCause,
    endingCause: result.endingCause,
    engineVoid: result.engineVoid,
    writes,
    writeAttribution,
    validationGeneratedWrites: result.validationGeneratedWrites,
    timeout: timeoutSummary,
    continuation: result.continuation,
  });

  let boundaryError: unknown;
  try {
    await opts.settlementBoundary?.('attempt_closed');
    final = settleStageAttempt(opts.projectDir, opts.runId, opts.stageId, attemptIndex);
  } catch (error) {
    boundaryError = error;
    final = settleStageAttempt(opts.projectDir, opts.runId, opts.stageId, attemptIndex,
      { exitCode: 1, error: error instanceof Error ? error.message : String(error) });
  }
  if (attemptValidationPlan && !attemptValidationPlan.baseline.discovery.commands.length
    && attemptValidationPlan.source !== 'model-selection' && final.status === STAGE_STATUS.COMPLETE && result.exitCode === 0 && !result.engineVoid && !childCloseUnverified && !result.continuation) {
    let selection: unknown;
    try { selection = JSON.parse(result.output).validation; } catch { /* unavailable stays unknown */ }
    recordValidationSelection(opts.projectDir, opts.runId, selection);
    attemptValidationPlan = readRunValidationBaseline(opts.runDir);
  }
  const evidenceTreeAfter = captureProjectTree(opts.projectDir, evidenceBrief, opts.runDir);
  let finalRecord: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(result.output);
    if (value && typeof value === 'object' && !Array.isArray(value)) finalRecord = value as Record<string, unknown>;
  } catch { /* No structured final answer; never substitute transcript or summary. */ }
  const settled = final.attempts?.at(-1);
  const gapBlocks = settled?.endingCause === 'environment_gap'
    ? validatedStageRecord!.blocks as { criterion_ids: string[]; paths: string[] } | undefined : undefined;
  const criterionIds = new Set(gapBlocks ? (readBriefCriteriaArtifact(opts.runDir)?.criteria.map(criterion => criterion.id) ?? opts.criterionRefs ?? []) : []);
  const unknownCriterionIds = gapBlocks?.criterion_ids.filter(id => !criterionIds.has(id)) ?? [];
  appendEvidence(opts.runDir, { kind: 'attempt', stageId: opts.stageId, attemptIndex, attemptStartedAt,
    exitCode: settled?.exitCode ?? result.exitCode, status: final.status, treeHash: evidenceTreeAfter.hash,
    files: changedTreeFiles(evidenceTreeBefore, evidenceTreeAfter),
    remainingWork: Array.isArray(validatedStageRecord?.remaining_work) ? validatedStageRecord.remaining_work as string[] : null,
    continuation: Boolean(settled?.continuation), endingCause: settled?.endingCause ?? result.endingCause,
    environmentGap: settled?.endingCause === 'environment_gap' ? { reason: String(validatedStageRecord!.summary),
      blocks: gapBlocks ? { ...gapBlocks, paths: gapBlocks.paths.map(path => {
        const scope = parseDeclaredScope(path);
        return scope.kind === 'unknown' ? path : scope.kind === 'glob' ? normalizedProjectPath(path)! : scope.value;
      }) } : null,
      ...(unknownCriterionIds.length ? { unknownCriterionIds } : {}) } : undefined, finalRecord,
    guidanceIds: [...submittedGuidanceIds], measurements: {
      inputTokens: result.tokens_in ?? null, outputTokens: result.tokens_out ?? null,
      durationMs: result.duration_ms, provenance: 'adapter-reported',
    } });
  if (validatedStageRecord?.status === 'blocked') {
    appendEvidence(opts.runDir, { kind: 'declaration', stageId: opts.stageId, attemptIndex, status: 'blocked',
      reason: String(validatedStageRecord.summary).slice(0, 2000),
      caveats: (validatedStageRecord.caveats as string[] ?? []).slice(0, 10), owner: 'declaration' });
    for (const [index, check] of ((validatedStageRecord.checks ?? []) as Array<{ command: string; exit_code: number; evidence: string }>).entries()) {
      appendEvidence(opts.runDir, { kind: 'command', stageId: opts.stageId, attemptIndex, commandId: `declaration-${index}`,
        command: check.command, exitCode: check.exit_code, evidence: check.evidence, owner: 'declaration' });
    }
  }
  if (result.exitCode === 0 && opts.isGate && !result.continuation) {
    const verdict = stageRecord(result.output);
    appendEvidence(opts.runDir, { kind: 'decision', stageId: opts.stageId, attemptIndex,
      verdict, owner: 'closed-schema-model' });
  }
  {
    if (settled?.exitCode !== undefined) result.exitCode = settled.exitCode;
    if (result.exitCode !== 0) result.continuation = undefined;
    result.terminationCause = settled?.terminationCause ?? 'exit';
    result.endingCause = settled?.endingCause;
    if (settled?.engineVoid) result.friendlyError ??= final.error;
    recordRunEvent(opts.projectDir, opts.runId, {
      type: result.exitCode === 0 ? 'attempt_finished' : 'attempt_failed',
      runId: opts.runId,
      timestamp: final.attempts?.at(-1)?.completedAt ?? new Date().toISOString(),
      stageId: opts.stageId,
      ...attemptEventFields(settled),
      status: final.status,
      exitCode: result.exitCode,
      ...(result.processExitCode !== undefined ? { processExitCode: result.processExitCode } : {}),
      ...(result.processSignal !== undefined ? { processSignal: result.processSignal } : {}),
      ...(result.providerFailure ? { providerFailure: result.providerFailure } : {}),
      detail: result.exitCode === 0 ? 'attempt completed' : (final.error ?? `exit ${result.exitCode}`),
      source: 'worker',
    });

    // Return reconciled write attribution to the scheduler.
    result.writes = final.attempts?.at(-1)?.writes;
    result.writeAttribution = final.attempts?.at(-1)?.writeAttribution;

    // Final classification and durable settlement, rather than a raw child zero,
    // determine whether the successful-home cleanup policy applies.
    if (final.status === RUN_STATUS.COMPLETE && !result.continuation && !opts.preserveSession) {
      finalizeStageSessions(opts.runDir, opts.stageId);
    }
  }
  if (boundaryError !== undefined) throw new StageAttemptSettlementError(opts.stageId, attemptIndex, boundaryError);
  return result;
  } finally {
    // Setup failures and thrown settlement errors also own this timer.
    attemptDeadline.dispose();
  }
}
