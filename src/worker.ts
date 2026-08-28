// Module: worker
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { loadAdapterByName } from './adapters/loader.js';
import { buildStagePrompt } from './handoff.js';
import { loadProjectDefaults } from './config.js';
import { parseStageAbortSignal } from './abort-signal.js';
import {
  beginStageAttempt,
  completeStageAttempt,
  writeStageInput,
  writeStageOutput,
  TERMINAL_STATUSES,
  VERDICT_CONTRACT_DOC,
  PHASE_METADATA_FIELDS,
} from './store.js';
import type { StageAttemptTimeoutSummary } from './store.js';
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
  resumeSessionId?: string;
  sessionOwnerStageId?: string;
  preserveSession?: boolean;
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

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.fc', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', '.tox', 'target', 'out', '.gradle']);

function snapshotMtimes(projectDir: string, extraFiles: string[] = []): Map<string, number> {
  const snap = new Map<string, number>();
  function walk(dir: string, depth: number) {
    if (depth > 5) return; // limit depth to avoid scanning huge trees
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const full = join(dir, e);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full, depth + 1);
        else snap.set(full, st.mtimeMs);
      } catch { /* skip */ }
    }
  }
  walk(projectDir, 0);
  for (const file of extraFiles) {
    try {
      const st = statSync(file);
      if (st.isFile()) snap.set(file, st.mtimeMs);
    } catch { /* optional file may not exist yet */ }
  }
  return snap;
}

function diffArtifacts(before: Map<string, number>, projectDir: string, extraFiles: string[] = []): string[] {
  const after = snapshotMtimes(projectDir, extraFiles);
  const changed: string[] = [];
  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined || mtime > prev) {
      changed.push(relative(projectDir, path));
    }
  }
  return changed;
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
  const skillNames = opts.stageSkills ?? [];
  const prompt = buildStagePrompt({
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
    stageId: opts.stageId,
    role: opts.role.name,
    handoffVisibility: opts.role.handoff_visibility,
  });

  writeStageInput(opts.projectDir, opts.runId, opts.stageId, prompt);

  const runningStatus = beginStageAttempt(opts.projectDir, opts.runId, opts.stageId, opts.retries);
  const attemptIndex = runningStatus.attempts?.at(-1)?.index;
  if (attemptIndex === undefined) throw new Error(`Stage ${opts.stageId} started without an attempt index`);

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

  // Bug ② fix — planner-only: inject the most-recent archived supervisor
  // guidance from a prior iteration so cross-iteration GUIDE signals still
  // reach the planner even after the iteration-boundary archive in
  // scheduler.ts emptied `supervisor_guidance.md`. Safe by default: missing
  // history dir or empty archive file results in no injection.
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
          const prev = readFileSync(join(historyDir, latest), 'utf-8').trim();
          if (prev) {
            resolvedSystemPrompt = `# Previous iteration's supervisor guidance (cumulative)\n\nThe lines below were emitted by the supervisor across the prior iteration. They represent observations and course-corrections from before this re-plan. Use them to inform this iteration's plan — especially any "do not do X" constraints.\n\n${prev}\n\n---\n\n${resolvedSystemPrompt}`;
          }
        }
      }
    } catch { /* non-critical */ }
  }

  // Snapshot the current run-level supervisor guidance (if any) into this
  // stage's directory so we have an audit trail of what the stage saw when
  // it started, even if the live file is later appended to or archived.
  try {
    const guidancePath = join(opts.runDir, 'supervisor_guidance.md');
    if (existsSync(guidancePath)) {
      const stageDirPath = join(opts.runDir, 'stages', opts.stageId);
      mkdirSync(stageDirPath, { recursive: true });
      copyFileSync(guidancePath, join(stageDirPath, 'guidance_consumed.md'));
    }
  } catch { /* non-critical */ }

  const resolvedRole = { ...opts.role, prompt: resolvedSystemPrompt };

  const kgPath = join(opts.runDir, 'knowledge_graph.json');
  const beforeSnapshot = snapshotMtimes(opts.projectDir, [kgPath]);

  const attemptDeadline = new AttemptDeadlineController({
    budgetMs: opts.timeout_ms,
    ledgerDir: join(opts.runDir, 'stages', opts.stageId),
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
  const extensionPollTimer = setInterval(pollTimeoutExtensionRequests, 20);
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
  const invokeAdapter = async (
    selectedAdapter: Adapter,
    selectedRole: AgentConfig,
    session: boolean,
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
    return new Promise<RunResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      let closeObservationTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: RunResult): void => {
        if (settled) return;
        settled = true;
        if (closeObservationTimer) clearTimeout(closeObservationTimer);
        aggregateAbortSignal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (closeObservationTimer) clearTimeout(closeObservationTimer);
        aggregateAbortSignal.removeEventListener('abort', onAbort);
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
      aggregateAbortSignal.addEventListener('abort', onAbort, { once: true });
      selectedAdapter.run(prompt, selectedRole, {
        timeout_ms: effectiveBudgetMs,
        workDir: opts.projectDir,
        runDir: opts.runDir,
        stageId: opts.stageId,
        resumeSessionId: session && opts.retries === 0 ? opts.resumeSessionId : undefined,
        sessionOwnerStageId: session && opts.retries === 0 ? opts.sessionOwnerStageId : undefined,
        preserveSession: opts.preserveSession,
        abortSignal: aggregateAbortSignal,
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
          else fail(error);
        },
      );
    });
  };
  const adapterRetryDelays = opts.technicalRetry?.delaysMs ?? ADAPTER_RETRY_DELAYS;
  const waitForRetry = (delayMs: number): Promise<boolean> => attemptDeadline.boundedSleep(delayMs, attemptAbortController.signal);

  let result: RunResult;
  // Abort and legacy-extension polling live through adapter backoff and
  // fallback so every phase remains governed by this attempt's one deadline.
  try {
    result = await invokeAdapter(adapter, resolvedRole, true);

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
        result = await invokeAdapter(adapter, resolvedRole, false);
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
              result = await invokeAdapter(fallbackAdapter, fallbackRole, false);
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
  result.effectiveTimeoutMs = effectiveBudgetMs;
  result.timeoutTerminationCause = terminationCause;

  writeStageOutput(opts.projectDir, opts.runId, opts.stageId, result.output, attemptIndex);

  const artifacts = diffArtifacts(beforeSnapshot, opts.projectDir, [kgPath]);
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

  // Surface fallback attribution to callers without changing adapter semantics.
  result.writes = final.attempts?.at(-1)?.writes;
  result.writeAttribution = final.attempts?.at(-1)?.writeAttribution;

  return result;
}
