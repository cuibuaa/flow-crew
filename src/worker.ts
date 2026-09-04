// Module: worker
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { loadAdapterByName } from './adapters/loader.js';
import { buildStagePrompt } from './handoff.js';
import { loadProjectDefaults } from './config.js';
import { parseStageAbortSignal } from './abort-signal.js';
import {
  beginStageAttempt,
  completeStageAttempt,
  writeStageStatus,
  writeStageInput,
  writeStageOutput,
  TERMINAL_STATUSES,
  VERDICT_CONTRACT_DOC,
  PHASE_METADATA_FIELDS,
} from './store.js';
import type { StageAttemptTimeoutSummary, StageStatus } from './store.js';
import {
  negotiationRequestDigest,
  parseTimeoutExtensionRequest,
  publishConstraintDecision,
  type NegotiationRequester,
  type TimeoutExtensionRequestV1,
} from './runtime-negotiation.js';
import {
  ATTEMPT_CLOSE_OBSERVATION_TOLERANCE_MS,
  AttemptDeadlineController,
  type AttemptDeadlineClock,
} from './attempt-deadline.js';
import { guidanceForStageFromText, readGuidanceForStage, renderGuidanceDelivery } from './guidance.js';
import { recordRunEvent } from './run-events.js';
import {
  acquireAttributableWriterLease,
  compareLiveConstraintContentIdentities,
  LIVE_CONSTRAINT_MAX_REINVOCATIONS,
  readLiveConstraintContentIdentity,
  type LiveConstraintContentIdentity,
  type LiveConstraintGuardFactory,
  type LiveConstraintInvocationResult,
} from './live-constraint-guard.js';

function getDefaultTimeout(projectDir: string): string {
  return String(loadProjectDefaults(projectDir).timeout_ms);
}

export interface StageOpts {
  stageId: string;
  role: AgentConfig;
  dependsOn: string[];
  promptTemplate: string;
  timeout_ms: number;
  /** Internal dependency injection for deterministic attempt-deadline tests. */
  deadlineClock?: AttemptDeadlineClock;
  /** Internal dependency injection for deterministic attempt-deadline tests. */
  technicalRetry?: {
    delaysMs?: readonly number[];
    loadFallbackAdapter?: (name: string) => Promise<Adapter>;
  };
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

const ADAPTER_ERROR_PATTERNS = ['403 Forbidden', 'connection refused', 'ECONNREFUSED', 'ECONNRESET', 'rate limit', 'ETIMEDOUT', '429 Too Many', '502 Bad Gateway', '503 Service Unavailable', 'overloaded'];
const ADAPTER_RETRY_DELAYS = [30_000, 60_000, 120_000];

export type TimeoutExtensionTimingBasis = 'requested_at' | 'legacy_consumption';

export interface TimeoutExtensionPolicyInput {
  request: TimeoutExtensionRequestV1;
  attemptStartedWallMs: number;
  attemptElapsedMs: number;
  effectiveBudgetMs: number;
  supervisorAborted: boolean;
  attemptAborted: boolean;
  deadlineAborted: boolean;
}

export interface TimeoutExtensionPolicyDecision {
  accepted: boolean;
  requestedExtensionMs: number;
  grantedExtensionMs: number;
  rejectionReason?: string;
  timingBasis: TimeoutExtensionTimingBasis;
  adjudicatedAttemptElapsedMs: number;
  requestedAtAttemptElapsedMs?: number;
}

export function evaluateTimeoutExtensionRequest(
  input: TimeoutExtensionPolicyInput,
): TimeoutExtensionPolicyDecision {
  const requestedAtMs = input.request.requestedAt === undefined
    ? undefined
    : Date.parse(input.request.requestedAt);
  const usesRequestedAt = requestedAtMs !== undefined
    && Number.isFinite(requestedAtMs)
    && Number.isFinite(input.attemptStartedWallMs);
  const requestedAtAttemptElapsedMs = usesRequestedAt
    ? Math.max(0, requestedAtMs - input.attemptStartedWallMs)
    : undefined;
  const adjudicatedAttemptElapsedMs = requestedAtAttemptElapsedMs ?? input.attemptElapsedMs;
  const timingBasis: TimeoutExtensionTimingBasis = usesRequestedAt ? 'requested_at' : 'legacy_consumption';
  let rejectionReason: string | undefined;
  if (!input.request.reason) rejectionReason = 'timeout extension reason must be non-empty';
  else if (!Number.isSafeInteger(input.request.requestedExtensionMs) || input.request.requestedExtensionMs <= 0) rejectionReason = 'requestedExtensionMs must be a positive safe integer';
  else if (input.supervisorAborted) rejectionReason = 'a current-attempt ABORT already exists';
  else if (adjudicatedAttemptElapsedMs >= input.effectiveBudgetMs || input.attemptAborted || input.deadlineAborted) rejectionReason = 'request arrived at or after the immutable attempt deadline';
  else rejectionReason = 'running attempt deadlines are immutable; edit config/defaults.yaml::default_timeout_ms before launch';

  const requestedExtensionMs = Number.isSafeInteger(input.request.requestedExtensionMs)
    && input.request.requestedExtensionMs > 0
    ? input.request.requestedExtensionMs
    : 0;
  return {
    accepted: false,
    requestedExtensionMs,
    grantedExtensionMs: 0,
    ...(rejectionReason ? { rejectionReason } : {}),
    timingBasis,
    adjudicatedAttemptElapsedMs,
    ...(requestedAtAttemptElapsedMs === undefined ? {} : { requestedAtAttemptElapsedMs }),
  };
}

function isAdapterError(output: string): boolean {
  // Scan only the TAIL: an adapter's real connection/rate-limit error surfaces at
  // the end. Scanning the whole output false-matches when the agent's prompt or a
  // prior-stage transcript merely mentions "rate limit"/"overloaded" (codex echoes
  // the full prompt), which would mislabel a real task failure as transient and
  // trigger needless backoff + cross-adapter fallback.
  const tail = output.length > 2048 ? output.slice(-2048) : output;
  return ADAPTER_ERROR_PATTERNS.some(p => tail.includes(p));
}

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
  extraFiles: string[] = [],
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
  for (const file of extraFiles) {
    const identity = readLiveConstraintContentIdentity(file);
    if (identity.state !== 'absent') snap.set(file, identity);
  }
  return snap;
}

function diffScopedArtifacts(
  before: Map<string, LiveConstraintContentIdentity>,
  projectDir: string,
  scopes: readonly string[],
  extraFiles: string[] = [],
  runDirectory?: string,
): string[] {
  const after = snapshotScopedContent(projectDir, scopes, extraFiles);
  const changed: string[] = [];
  const absent: LiveConstraintContentIdentity = { state: 'absent' };
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (compareLiveConstraintContentIdentities(before.get(path) ?? absent, after.get(path) ?? absent) !== 'different') continue;
    const runRelative = runDirectory ? relative(runDirectory, path) : undefined;
    changed.push(runRelative !== undefined && runRelative !== '' && !runRelative.startsWith('..')
      ? `run:${runRelative.replace(/\\/g, '/')}`
      : relative(projectDir, path).replace(/\\/g, '/'));
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
    'kgChanged', 'writes', 'writeAttribution', 'constraintAudit', 'timeout',
  ] as const) delete next[field];
  return next;
}

export function renderSupervisorAbortOutput(
  output: string,
  stageId: string,
  executionIndex: number,
  reason?: string,
): string {
  if (output.trim().length > 0) return output;
  return [
    '# Execution aborted by supervisor',
    '',
    reason?.trim() || 'The supervisor stopped this execution before it produced output.',
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
   * unchanged prior-attempt verdict/metric is therefore never current evidence. */
  artifactBaselines: Record<string, string | null>;
  recordedAt: string;
}

function attemptArtifactFingerprint(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

/** Delimit the append-only live log so every supervisor read can prove which
 * scheduler attempt produced its bytes. */
export function beginAttemptEvidenceGeneration(
  runDirectory: string,
  stageId: string,
  attemptIndex: number,
  attemptStartedAt: string,
): AttemptEvidenceGeneration {
  const stagePath = join(runDirectory, 'stages', stageId);
  const logPath = join(stagePath, 'live.log');
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
      metric: attemptArtifactFingerprint(join(stagePath, 'metric.json')),
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
  // Preserve the synchronous launch edge only when the scheduler supplied no
  // live policy. An explicitly empty scope still needs an attributable lease:
  // any project write from that invocation is necessarily a violation.
  if (!opts.liveConstraintGuardFactory) {
    return runStageWithWriterLease(adapter, opts);
  }
  const releaseWriterLease = await acquireAttributableWriterLease(
    opts.projectDir,
    true,
  );
  try {
    return await runStageWithWriterLease(adapter, opts);
  } finally {
    releaseWriterLease();
  }
}

async function runStageWithWriterLease(
  adapter: Adapter,
  opts: StageOpts,
): Promise<RunResult> {
  const skillNames = opts.stageSkills ?? [];
  let prompt = buildStagePrompt({
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
  });

  const runningStatus = beginStageAttempt(opts.projectDir, opts.runId, opts.stageId, opts.retries);
  const attemptIndex = runningStatus.attempts?.at(-1)?.index;
  if (attemptIndex === undefined) throw new Error(`Stage ${opts.stageId} started without an execution index`);
  const attemptStartedAt = runningStatus.attempts?.at(-1)?.startedAt;
  if (!attemptStartedAt) throw new Error(`Stage ${opts.stageId} started without an execution start timestamp`);
  const liveConstraintGuard = opts.liveConstraintGuardFactory?.({ attemptIndex, attemptStartedAt });
  // Compatibility aggregates remain in the attempt ledger; live top-level
  // outcome fields must describe this execution, not the one it retried.
  const freshRunningStatus = freshRunningStageProjection(runningStatus, opts.retries, attemptStartedAt);
  writeStageStatus(opts.projectDir, opts.runId, opts.stageId, freshRunningStatus);
  prompt = prompt
    .replace(/<current execution index>/g, String(attemptIndex))
    .replace(/<current attempt>/g, String(attemptIndex)); // legacy prompt templates
  writeStageInput(opts.projectDir, opts.runId, opts.stageId, prompt);
  beginAttemptEvidenceGeneration(opts.runDir, opts.stageId, attemptIndex, attemptStartedAt);
  recordRunEvent(opts.projectDir, opts.runId, {
    type: 'attempt_started',
    runId: opts.runId,
    timestamp: attemptStartedAt,
    stageId: opts.stageId,
    attemptIndex,
    attemptStartedAt,
    source: 'worker',
  });

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
    .replace(/\{result_schema\}/g, opts.resultSchema ?? 'none')
    .replace(/\{context_inventory\}/g, opts.contextInventory ?? 'none')
    .replace(/\{ledger_digest\}/g, opts.ledgerDigest ?? 'none')
    .replace(/\{terminal_statuses\}/g, TERMINAL_STATUSES.join(', '))
    .replace(/\{verdict_contract\}/g, VERDICT_CONTRACT_DOC)
    .replace(/\{phase_metadata_fields\}/g, PHASE_METADATA_FIELDS)
    .replace(/\{project_contract\}/g, projectContract)
    .replace(/\{run_dir\}/g, opts.runDir)
    .replace(/\{project\}/g, opts.projectDir)
    .replace(/\{default_timeout_ms\}/g, getDefaultTimeout(opts.projectDir));
  try {
    const taskBriefPath = join(opts.runDir, 'task_brief.md');
    if (existsSync(taskBriefPath)) {
      const brief = readFileSync(taskBriefPath, 'utf-8').trim();
      if (brief) {
        resolvedSystemPrompt = `# Task Brief\n\n${brief}\n\n---\n\n${resolvedSystemPrompt}`;
      }
    }
  } catch { /* non-critical */ }

  // Planner-only history remains target-filtered. An archived instruction for
  // an implementation or gate stage must not become a planner instruction.
  if (opts.role.name === 'planner') {
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
            resolvedSystemPrompt = `# Previous iteration's targeted supervisor guidance\n\n${targeted}\n\n---\n\n${resolvedSystemPrompt}`;
          }
        }
      }
    } catch { /* non-critical */ }
  }

  // Receipt is exactly the filtered delivery for this stage, never a copy of
  // the global audit ledger.
  try {
    const delivered = renderGuidanceDelivery(readGuidanceForStage(opts.runDir, opts.stageId));
    const stageDirPath = join(opts.runDir, 'stages', opts.stageId);
    mkdirSync(stageDirPath, { recursive: true });
    writeFileSync(
      join(stageDirPath, 'guidance_consumed.md'),
      delivered ? `${delivered}\n` : 'No supervisor guidance was delivered to this execution.\n',
      'utf-8',
    );
  } catch { /* non-critical */ }

  const resolvedRole = { ...opts.role, prompt: resolvedSystemPrompt };

  const kgPath = join(opts.runDir, 'knowledge_graph.json');
  const projectWriteScope = opts.projectWriteScope ?? [];
  const beforeSnapshot = snapshotScopedContent(opts.projectDir, projectWriteScope, [kgPath]);

  const attemptDeadline = new AttemptDeadlineController({
    budgetMs: opts.timeout_ms,
    ledgerDir: join(opts.runDir, 'stages', opts.stageId),
    executionIndex: attemptIndex,
    ...(opts.deadlineClock ? { clock: opts.deadlineClock } : {}),
  });
  const attemptStartedWallMs = Date.parse(attemptDeadline.attemptStartedAt);
  const effectiveBudgetMs = attemptDeadline.budgetMs;

  // Abort files are one-shot envelopes owned by this exact stage attempt. A
  // crash can leave a file behind, so ownership is validated on every launch;
  // stale/malformed envelopes are warned about and removed without firing.
  const attemptAbortController = new AbortController();
  const abortSignalPath = join(opts.runDir, 'signals', `abort_${opts.stageId}.json`);
  const liveLogPath = join(opts.runDir, 'stages', opts.stageId, 'live.log');
  let supervisorAborted = false;
  let abortReason = '';
  let terminationCause: StageAttemptTimeoutSummary['terminationCause'];
  let rejectedExtensionCount = 0;
  const timeoutDecisionPaths: string[] = [];
  const timeoutMismatchPaths: string[] = [];
  const handledRequestDigests = new Set<string>();

  const attemptElapsedMs = (): number => attemptDeadline.elapsedMs();
  const relativeAuditPath = (path: string): string => relative(opts.runDir, path).replace(/\\/g, '/');

  const removeAbortSignal = (): void => {
    try {
      if (existsSync(abortSignalPath)) unlinkSync(abortSignalPath);
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
          `Ignored stale supervisor ABORT signal: expected attempt ${attemptIndex} for stage "${opts.stageId}", `
          + `observed attempt ${parsed.observedAttemptIndex ?? 'unknown'} for stage "${parsed.observedStageId ?? 'unknown'}" `
          + `(${parsed.error}); signal removed without aborting.`,
        );
        return;
      }
      if (parsed.signal.stageId !== opts.stageId || parsed.signal.attemptIndex !== attemptIndex) {
        removeAbortSignal();
        appendAbortWarning(
          `Ignored stale supervisor ABORT signal: expected attempt ${attemptIndex} for stage "${opts.stageId}", `
          + `observed attempt ${parsed.signal.attemptIndex} for stage "${parsed.signal.stageId}"; `
          + 'signal removed without aborting.',
        );
        return;
      }

      // Consume before killing the child. If the adapter throws or the child is
      // SIGKILLed, the next same-name attempt cannot replay this cancellation.
      abortReason = parsed.signal.reason.slice(0, 240);
      removeAbortSignal();
      supervisorAborted = true;
      terminationCause ??= 'supervisor_abort';
      try {
        appendFileSync(
          liveLogPath,
          `\nSupervisor ABORT signal consumed for attempt ${attemptIndex}; killing stage child process.\n`,
        );
      } catch { /* non-critical */ }
      attemptAbortController.abort('supervisor_abort');
    } catch { /* non-critical */ }
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
  const stageTimeoutRequestPath = join(opts.runDir, 'stages', opts.stageId, 'timeout_extension_request.json');
  const engineTimeoutRequestPath = join(opts.runDir, 'signals', `timeout_extension_${opts.stageId}.json`);

  const processTimeoutRequest = (request: TimeoutExtensionRequestV1): void => {
    const digest = negotiationRequestDigest(request);
    if (handledRequestDigests.has(digest)) return;
    handledRequestDigests.add(digest);

    // A transport slot can outlive its attempt. It is not an audit source and
    // must not cause an old accepted decision to be published/replayed into a
    // later attempt. Current-attempt requests alone reach worker policy.
    if (request.stageId !== opts.stageId || request.attemptIndex !== attemptIndex) {
      appendAbortWarning(
        `Ignored stale timeout extension request: expected attempt ${attemptIndex} for stage "${opts.stageId}", `
        + `observed attempt ${request.attemptIndex} for stage "${request.stageId}".`,
      );
      return;
    }

    const elapsed = attemptElapsedMs();
    const policy = evaluateTimeoutExtensionRequest({
      request,
      attemptStartedWallMs,
      attemptElapsedMs: elapsed,
      effectiveBudgetMs,
      supervisorAborted: supervisorAborted || terminationCause === 'supervisor_abort',
      attemptAborted: attemptAbortController.signal.aborted,
      deadlineAborted: attemptDeadline.signal.aborted,
    });
    const { rejectionReason } = policy;
    const publication = publishConstraintDecision({
      stagePath: join(opts.runDir, 'stages', opts.stageId),
      request,
      decidedBy: 'worker-policy',
      decision: {
        accepted: false,
        decision: 'rejected',
        decidedAt: new Date().toISOString(),
        policyBasis: rejectionReason ?? 'running attempt deadlines are immutable',
        requestedExtensionMs: request.requestedExtensionMs,
        grantedExtensionMs: 0,
        effectiveBudgetMs,
        attemptBudgetMs: effectiveBudgetMs,
        deadlineAt: attemptDeadline.deadlineAt,
        attemptElapsedMs: Math.round(elapsed),
        timingBasis: policy.timingBasis,
        adjudicatedAttemptElapsedMs: Math.round(policy.adjudicatedAttemptElapsedMs),
        ...(request.requestedAt === undefined ? {} : { requestedAt: request.requestedAt }),
        ...(policy.requestedAtAttemptElapsedMs === undefined
          ? {}
          : { requestedAtAttemptElapsedMs: Math.round(policy.requestedAtAttemptElapsedMs) }),
        requestRemainingMs: Math.max(0, Math.round(effectiveBudgetMs - policy.adjudicatedAttemptElapsedMs)),
        remainingMs: Math.max(0, Math.round(attemptDeadline.remainingMs())),
        rejectedExtensionCount: rejectedExtensionCount + 1,
        ...(rejectionReason ? { rejectionReason } : {}),
      },
    });
    if (publication.kind === 'mismatch') {
      timeoutMismatchPaths.push(relativeAuditPath(publication.path));
      return;
    }
    if (!timeoutDecisionPaths.includes(relativeAuditPath(publication.path))) timeoutDecisionPaths.push(relativeAuditPath(publication.path));
    rejectedExtensionCount++;
    attemptDeadline.append('timeout_extension_rejected', {
      stageId: opts.stageId,
      attemptIndex,
      requestedBy: request.requestedBy,
      requestedExtensionMs: request.requestedExtensionMs,
      decisionPath: relativeAuditPath(publication.path),
      rejectionReason,
    });
  };

  function pollTimeoutExtensionRequests(): void {
    const channels: Array<{ path: string; requestedBy: NegotiationRequester }> = [
      { path: stageTimeoutRequestPath, requestedBy: 'stage' },
    ];
    try {
      if (existsSync(engineTimeoutRequestPath)) {
        const raw = JSON.parse(readFileSync(engineTimeoutRequestPath, 'utf-8')) as Record<string, unknown>;
        channels.push({ path: engineTimeoutRequestPath, requestedBy: raw.source === 'operator' ? 'operator' : 'supervisor' });
      }
    } catch { /* the normal parse below will retry after a complete write */ }
    for (const channel of channels) {
      try {
        if (!existsSync(channel.path)) continue;
        const parsed = parseTimeoutExtensionRequest(JSON.parse(readFileSync(channel.path, 'utf-8')), channel.requestedBy);
        if (parsed.ok) processTimeoutRequest(parsed.request);
      } catch { /* request slot may be between writes; retry on the next poll */ }
    }
  }

  pollAbortSignal();
  pollTimeoutExtensionRequests();
  const abortPollTimer = setInterval(pollAbortSignal, 2000);
  const extensionPollTimer = setInterval(pollTimeoutExtensionRequests, 1000);
  const requestWatchers: import('node:fs').FSWatcher[] = [];
  try {
    const signalsDir = join(opts.runDir, 'signals');
    mkdirSync(signalsDir, { recursive: true });
    for (const directory of [join(opts.runDir, 'stages', opts.stageId), signalsDir]) {
      requestWatchers.push(watch(directory, { persistent: false }, (_event, fileName) => {
        const name = fileName?.toString() ?? '';
        if (!name || name.includes('timeout_extension')) pollTimeoutExtensionRequests();
      }));
    }
  } catch { /* one-second reconciliation remains the portable fallback */ }
  const aggregateAbortSignal = AbortSignal.any([attemptAbortController.signal, attemptDeadline.signal]);
  const PHASE_ABORTED = Symbol('phase-aborted');
  const racePhaseWithAbort = <T>(phase: Promise<T>): Promise<T | typeof PHASE_ABORTED> => {
    if (aggregateAbortSignal.aborted) return Promise.resolve(PHASE_ABORTED);
    return new Promise<T | typeof PHASE_ABORTED>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (value: T | typeof PHASE_ABORTED): void => {
        if (settled) return;
        settled = true;
        aggregateAbortSignal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        aggregateAbortSignal.removeEventListener('abort', onAbort);
        rejectPromise(error);
      };
      const onAbort = (): void => finish(PHASE_ABORTED);
      aggregateAbortSignal.addEventListener('abort', onAbort, { once: true });
      phase.then(finish, fail);
    });
  };

  const cancelledResult = (telemetry?: RunResult): RunResult => {
    const tokensIn = typeof telemetry?.tokens_in === 'number' && Number.isFinite(telemetry.tokens_in)
      ? telemetry.tokens_in
      : undefined;
    const tokensOut = typeof telemetry?.tokens_out === 'number' && Number.isFinite(telemetry.tokens_out)
      ? telemetry.tokens_out
      : undefined;
    const timedOut = terminationCause === 'attempt_timeout' || attemptDeadline.signal.aborted;
    return {
      output: '',
      exitCode: timedOut ? 124 : 137,
      duration_ms: Math.round(attemptElapsedMs()),
      timedOut,
      ...(tokensIn !== undefined ? { tokens_in: tokensIn } : {}),
      ...(tokensOut !== undefined ? { tokens_out: tokensOut } : {}),
    };
  };
  const observeAdapterSettlement = (): void => {
    // Timer starvation delays both deadline and supervisor polling. Consume a
    // current-attempt ABORT first because supervisor authority takes
    // precedence, then observe the monotonic deadline synchronously.
    pollAbortSignal();
    if (!supervisorAborted) attemptDeadline.observeSettlement();
  };
  let lastChildClosedAt: string | undefined;
  let childCloseUnverified = false;
  let invocationIndex = 0;
  let latestLiveConstraintResult: LiveConstraintInvocationResult | undefined;
  const invokeAdapter = async (
    selectedAdapter: Adapter,
    selectedRole: AgentConfig,
    session: boolean,
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
    const invocationAbortController = new AbortController();
    const invocationAbortSignal = AbortSignal.any([aggregateAbortSignal, invocationAbortController.signal]);
    const liveMonitor = liveConstraintGuard?.beginInvocation(invocationIndex, (reason) => {
      if (!invocationAbortController.signal.aborted) invocationAbortController.abort(reason);
    });
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
      selectedAdapter.run(invocationPrompt, selectedRole, {
        timeout_ms: effectiveBudgetMs,
        workDir: opts.projectDir,
        runDir: opts.runDir,
        stageId: opts.stageId,
        attemptIndex,
        attemptStartedAt,
        resumeSessionId: session && opts.retries === 0 ? opts.resumeSessionId : undefined,
        sessionOwnerStageId: session && opts.retries === 0 ? opts.sessionOwnerStageId : undefined,
        preserveSession: opts.preserveSession,
        abortSignal: invocationAbortSignal,
      }).then(
        (value) => {
          lastChildClosedAt = new Date().toISOString();
          observeAdapterSettlement();
          // Cancellation changes the attempt outcome, not telemetry already
          // parsed while the adapter was closing its child process.
          finish(aggregateAbortSignal.aborted ? cancelledResult(value) : value);
        },
        (error) => {
          lastChildClosedAt = new Date().toISOString();
          observeAdapterSettlement();
          if (aggregateAbortSignal.aborted) finish(cancelledResult());
          else if (invocationAbortController.signal.aborted) finish(cancelledResult());
          else fail(error);
        },
      );
    });
    try {
      return await invocation;
    } finally {
      latestLiveConstraintResult = await liveMonitor?.finish();
    }
  };

  const mergeInvocationTelemetry = (prior: RunResult | undefined, next: RunResult): RunResult => {
    if (!prior) return next;
    const writes = [...new Set([...(prior.writes ?? []), ...(next.writes ?? [])])];
    const structured = prior.writeAttribution === 'structured' && next.writeAttribution === 'structured';
    return {
      ...next,
      output: [prior.output, next.output].filter(Boolean).join('\n\n[adapter reinvoked after live scope correction]\n\n'),
      duration_ms: prior.duration_ms + next.duration_ms,
      tokens_in: (prior.tokens_in === undefined && next.tokens_in === undefined)
        ? undefined
        : (prior.tokens_in ?? 0) + (next.tokens_in ?? 0),
      tokens_out: (prior.tokens_out === undefined && next.tokens_out === undefined)
        ? undefined
        : (prior.tokens_out ?? 0) + (next.tokens_out ?? 0),
      ...(writes.length > 0 ? { writes } : {}),
      ...(writes.length > 0 ? { writeAttribution: structured ? 'structured' : 'unknown' } : {}),
    };
  };

  let liveReinvocations = 0;
  const invokeAdapterWithLiveCorrection = async (
    selectedAdapter: Adapter,
    selectedRole: AgentConfig,
    session: boolean,
  ): Promise<RunResult> => {
    let combined: RunResult | undefined;
    let invocationPrompt = prompt;
    let mayResume = session;
    while (true) {
      const current = await invokeAdapter(selectedAdapter, selectedRole, mayResume, invocationPrompt);
      combined = mergeInvocationTelemetry(combined, current);
      const live = latestLiveConstraintResult;
      if (live?.monitorFailure) {
        return {
          ...combined,
          exitCode: 1,
          timedOut: false,
          adapterError: false,
          friendlyError: live.monitorFailure.reason,
        };
      }
      const incidents = live?.incidents ?? [];
      if (incidents.length === 0) return combined;
      const instructions = [...new Set(incidents.map((incident) => incident.scopeRevisionInstruction))];
      if (incidents.some((incident) => !incident.restored)) {
        return {
          ...combined,
          exitCode: 1,
          timedOut: false,
          adapterError: false,
          friendlyError: `live constraint rollback failed; ${instructions.join(' ')}`,
        };
      }
      if (liveReinvocations >= LIVE_CONSTRAINT_MAX_REINVOCATIONS || aggregateAbortSignal.aborted) {
        return {
          ...combined,
          exitCode: aggregateAbortSignal.aborted ? combined.exitCode : 1,
          timedOut: aggregateAbortSignal.aborted ? combined.timedOut : false,
          adapterError: false,
          friendlyError: aggregateAbortSignal.aborted
            ? combined.friendlyError
            : `scope_violation: repeated live constraint violation after same-attempt correction; ${instructions.join(' ')}`,
        };
      }
      liveReinvocations++;
      mayResume = false;
      invocationPrompt = `${prompt}\n\n# Live constraint correction\n${instructions.join('\n')}`;
      try {
        appendFileSync(
          liveLogPath,
          `\nLive constraint guard restored ${incidents.map((incident) => incident.path).join(', ')}; reinvoking inside attempt ${attemptIndex}.\n`,
        );
      } catch { /* durable incident JSONL remains the audit source */ }
    }
  };
  const adapterRetryDelays = opts.technicalRetry?.delaysMs ?? ADAPTER_RETRY_DELAYS;
  const waitForRetry = (delayMs: number): Promise<boolean> => attemptDeadline.boundedSleep(delayMs, attemptAbortController.signal);

  let result: RunResult;
  // Abort and legacy-extension polling live through adapter backoff and
  // fallback so every phase remains governed by this attempt's one deadline.
  try {
    result = await invokeAdapterWithLiveCorrection(adapter, resolvedRole, true);

    // Adapter error detection + exponential backoff retry on the SAME adapter.
    if (result.exitCode !== 0 && isAdapterError(result.output)) {
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
        result = await invokeAdapterWithLiveCorrection(adapter, resolvedRole, false);
        if (result.exitCode === 0 || !isAdapterError(result.output)) break;
      }

      // Final escape hatch: a different configured adapter may run once, but
      // loading and execution consume the same immutable attempt deadline.
      if (!aggregateAbortSignal.aborted && result.exitCode !== 0 && isAdapterError(result.output)) {
        try {
          const projectDefaults = loadProjectDefaults(opts.projectDir);
          const primaryName = opts.role.adapter ?? inferAdapterName(adapter) ?? projectDefaults.adapter;
          const fallbackName = projectDefaults.adapter;
          if (fallbackName && fallbackName !== primaryName && attemptDeadline.remainingMs() > 0) {
            try { appendFileSync(liveLogPath, `\n↩︎ Same-adapter retries exhausted (${primaryName}). Falling back to defaults.yaml adapter=${fallbackName} model=${projectDefaults.model}…\n`); } catch { /* ignore */ }
            const fallbackAdapter = await racePhaseWithAbort(
              (opts.technicalRetry?.loadFallbackAdapter ?? loadAdapterByName)(fallbackName),
            );
            if (fallbackAdapter === PHASE_ABORTED) {
              if (attemptDeadline.signal.aborted) terminationCause ??= 'attempt_timeout';
              result = cancelledResult();
            } else if (!aggregateAbortSignal.aborted && attemptDeadline.remainingMs() > 0) {
              const fallbackRole: AgentConfig = {
                ...resolvedRole,
                adapter: fallbackName,
                model: projectDefaults.model,
                reasoning_effort: projectDefaults.reasoning_effort,
              };
              result = await invokeAdapterWithLiveCorrection(fallbackAdapter, fallbackRole, false);
              try { appendFileSync(liveLogPath, `\n↪︎ Fallback ${fallbackName} returned exit=${result.exitCode}.\n`); } catch { /* ignore */ }
            }
          }
        } catch (err) {
          try { appendFileSync(liveLogPath, `\n⚠️  Cross-adapter fallback failed to load: ${err instanceof Error ? err.message : String(err)}\n`); } catch { /* ignore */ }
        }
      }

      if (result.exitCode !== 0 && isAdapterError(result.output)) result.adapterError = true;
    }
  } catch (error) {
    observeAdapterSettlement();
    if (!aggregateAbortSignal.aborted) throw error;
    result = cancelledResult();
  } finally {
    pollAbortSignal();
    clearInterval(abortPollTimer);
    clearInterval(extensionPollTimer);
    for (const watcher of requestWatchers) watcher.close();
    cleanupAbortSignalAtExit();
    // The execution attempt ends when adapter/fallback child settlement ends.
    // A blocked event loop can settle after the immutable boundary before its
    // timer callback runs, so observe monotonic expiry before disposal.
    if (!supervisorAborted) attemptDeadline.observeSettlement();
    // Dispose here as well on thrown adapter errors so no long deadline timer
    // survives this invocation and keeps the worker process alive.
    attemptDeadline.dispose();
  }

  if (attemptDeadline.signal.aborted && !supervisorAborted) terminationCause = 'attempt_timeout';
  const timedOut = !supervisorAborted && (
    terminationCause === 'attempt_timeout'
    || result.exitCode === 124
    || result.timedOut === true
    || (result.duration_ms >= effectiveBudgetMs && result.exitCode !== 0)
  );
  if (timedOut) {
    result.exitCode = 124;
    result.timedOut = true;
    terminationCause = 'attempt_timeout';
  } else if (supervisorAborted) {
    result.exitCode = 137;
    result.timedOut = false;
    terminationCause = 'supervisor_abort';
  } else if (result.exitCode === 0) {
    terminationCause = 'complete';
  } else if (result.adapterError) {
    terminationCause = 'adapter_error';
  } else {
    terminationCause ??= 'failed';
  }
  if (supervisorAborted) result.output = renderSupervisorAbortOutput(result.output, opts.stageId, attemptIndex, abortReason);
  result.effectiveTimeoutMs = effectiveBudgetMs;
  result.timeoutTerminationCause = terminationCause;

  writeStageOutput(opts.projectDir, opts.runId, opts.stageId, result.output, attemptIndex);

  const artifacts = diffScopedArtifacts(beforeSnapshot, opts.projectDir, projectWriteScope, [kgPath], opts.runDir);
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
    rejectedExtensionCount,
    decisionPaths: timeoutDecisionPaths,
    mismatchPaths: timeoutMismatchPaths,
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
    rejectedExtensionCount,
    terminationCause,
  });
  const final = completeStageAttempt(opts.projectDir, opts.runId, opts.stageId, opts.retries, {
    exitCode: result.exitCode,
    duration_ms: result.duration_ms,
    artifacts,
    completedAt: new Date().toISOString(),
    error: result.exitCode !== 0
      ? (
        supervisorAborted
          ? (abortReason ? `aborted by supervisor: ${abortReason}` : 'aborted by supervisor')
          : result.adapterError ? 'adapter connection failed'
          : result.timedOut ? `timed out after ${Math.round(effectiveBudgetMs / 1000)}s`
          // A diagnosed failure explains itself in one actionable sentence
          // instead of leaving the operator with a bare exit code.
          : result.friendlyError ? `Exit code ${result.exitCode} — ${result.friendlyError}`
          : `Exit code ${result.exitCode}`
      )
      : undefined,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    kgChanged: artifacts.some(a => a.endsWith('knowledge_graph.json')),
    writes,
    writeAttribution,
    timeout: timeoutSummary,
  });
  recordRunEvent(opts.projectDir, opts.runId, {
    type: result.exitCode === 0 ? 'attempt_finished' : 'attempt_failed',
    runId: opts.runId,
    timestamp: final.attempts?.at(-1)?.completedAt ?? new Date().toISOString(),
    stageId: opts.stageId,
    attemptIndex,
    attemptStartedAt,
    status: final.status,
    exitCode: result.exitCode,
    adapterFailure: result.adapterError === true,
    detail: result.exitCode === 0 ? 'attempt completed' : (final.error ?? `exit ${result.exitCode}`),
    source: 'worker',
  });

  // Surface fallback attribution to callers without changing adapter semantics.
  result.writes = final.attempts?.at(-1)?.writes;
  result.writeAttribution = final.attempts?.at(-1)?.writeAttribution;

  return result;
}
