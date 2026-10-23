import { processLiveness } from './process-liveness.js';
import { resolveCampaignStorageKey } from './campaigns.js';
import { observeRunStatusChange } from './run-events.js';
import { latestInvocationInput } from './run-state-view.js';
import { atomicWrite, writeFileSync, appendFileSync, closeSync, ftruncateSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeSync } from './engine-fs.js';
import { retireRunScratch } from './invocation-scratch.js';
import { stageLiveLogPath } from './stage-live-log.js';
import { existsSync, fstatSync, fsyncSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { renderRunSummary } from './run-summary.js';
import { listRunIdsFromIndex, upsertRunIndex } from './run-index.js';
import { projectPersistenceIdentity } from './project-identity.js';
import { cancelledRunPublicationError, canonicalRunDirectory, requireSafeRunId, resolveRunIdentity } from './cancellation-policy.js';
import { parseChecksFromBrief, readRealityGateReport, runAllChecks } from './reality-gate/index.js';
import type { RealityGateExit, RealityGateReport } from './reality-gate/types.js';
import type { BriefAdmissionRecord } from './brief-preflight.js';
import type { ResearchFeasibilityConfig } from './research-feasibility.js';
import type { AdapterFailureKind } from './adapters/base.js';
import type { ProviderFailure } from './provider-result.js';
import { invocationUsageFields, sumInvocationUsage, tokensComplete, type InvocationUsage, type NativeInvocationUsage, type TokenUsage } from './invocation-usage.js';

import {
  RUN_STATUS,
  STAGE_STATUS,
  UnknownRunStatusError,
  isTerminalRunStatus,
  requireKnownRunStatus,
  resolveRunStatus,
  type RunStatus,
  type RunStatusResolution,
  type StageState,
} from './lifecycle-status.js';
export {
  RUN_STATUS,
  STAGE_STATUS,
  RUN_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
  UnknownRunStatusError,
  isPausedRunStatus,
  isResumableRunStatus,
  isPendingRunStatus,
  isRunningRunStatus,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  requireKnownRunStatus,
  resolveRunStatus,
} from './lifecycle-status.js';
export type {
  RunLifecycleBucket,
  RunStatus,
  RunStatusResolution,
  RunStatusSemantics,
  StageState,
} from './lifecycle-status.js';

export type StageAttemptState = 'running' | 'closed' | 'complete' | 'failed' | 'suspended';
export type AttemptTokenUsage = TokenUsage;
export type WriteAttribution = 'structured' | 'snapshot' | 'unknown';

export type AttemptTerminationCause = 'exit' | 'stage_abort' | 'attempt_timeout' | 'cancelled' | 'host_restart' | 'engine_void';

export interface StageAttemptTimeoutSummary {
  attemptId: string;
  budgetMs: number;
  attemptStartedAt: string;
  deadlineAt: string;
  budgetDeadlineAt?: string;
  wrapUpAt?: string;
  finishingMs?: number;
  wrapUpRequestedAt?: string;
  wrapUpDeliveredAt?: string;
  elapsedMs: number;
  remainingMs: number;
  /** Historical extension receipts; new immutable deadlines never write these. */
  rejectedExtensionCount?: number;
  decisionPaths?: string[];
  mismatchPaths?: string[];
  /** Legacy records only; new outcomes belong to StageAttempt. */
  terminationCause?: string;
  deadlineReachedAt?: string;
  childClosedAt?: string;
  deadlineOverrunMs?: number;
}

export interface StageConstraintAuditSummary {
  path: string;
  declaredScope: string[] | null;
  effectiveScope: string[] | null;
  violationCount: number;
  unverifiedCount: number;
  rawWriteCount?: number;
  appliedWriteCount?: number;
  exemptedWriteCount?: number;
  rolledBackWriteCount?: number;
  unresolvedViolationCount?: number;
}

/** Attribution is optional only for execution ledgers written before this contract. */
export interface AttemptAttribution {
  role: string;
  iteration: number;
}
export type AttemptDisposition = 'pending' | 'accepted' | 'discarded' | 'superseded' | 'repaired';

/** A settled slice of work, not evidence that its duties or gates passed. */
export interface StageContinuation {
  reason: 'stage_budget';
  forced: boolean;
  /** Run-relative retained done/remaining handoff. */
  handoff: string;
  /** Engine retention facts, distinct from an author's schema-validated result. */
  summary?: string;
}

export interface StageAttempt extends InvocationUsage {
  role?: string;
  iteration?: number;
  /** Explicit result reclassification; timing and token evidence remain. */
  disposition?: AttemptDisposition;
  invocations?: NativeInvocationUsage[];
  index: number;
  startedAt: string;
  completedAt?: string;
  status: StageAttemptState;
  duration_ms?: number;
  exitCode?: number;
  processExitCode?: number | null;
  processSignal?: NodeJS.Signals | null;
  providerFailure?: ProviderFailure;
  tokens_in?: number;
  tokens_out?: number;
  /** Persisted evidence: both counters are known, or this settled attempt is explicitly unknown. */
  tokenUsage?: AttemptTokenUsage;
  error?: string;
  terminationCause?: AttemptTerminationCause;
  engineVoid?: boolean;
  adapterFailureKind?: AdapterFailureKind;
  writes?: string[];
  writeAttribution?: WriteAttribution;
  /** Exact generated paths proven by adapter command lifecycle evidence. */
  validationGeneratedWrites?: string[];
  /** Small summary plus path to the immutable attempt-level constraint audit. */
  constraintAudit?: StageConstraintAuditSummary;
  /** Attempt-local immutable deadline evidence. */
  timeout?: StageAttemptTimeoutSummary;
  continuation?: StageContinuation;
}

export interface StageStatus extends InvocationUsage {
  admissionFailure?: { code: 'dispatch_refused'; attemptIndex: number };
  /** Acceptance already settled in an isolated child; no local gate execution. */
  acceptedFrom?: { runId: string; verdict: GateVerdict };
  gate?: GateVerdict & { kind: NonNullable<GateVerdict['refusal']>['kind'] | 'pass' | 'repairable' | 'irreparable'; verdictSha256: string | null };
  status: StageState;
  exitCode?: number;
  processExitCode?: number | null;
  processSignal?: NodeJS.Signals | null;
  providerFailure?: ProviderFailure;
  duration_ms?: number;
  artifacts?: string[];
  retries: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Append-only execution ledger. Top-level timing/token fields aggregate this array. */
  attempts?: StageAttempt[];
  /** Number of executions after the first; deliberately distinct from technical retries. */
  reruns?: number;
  /** Union of files attributed to this stage across its attempts. */
  writes?: string[];
  writeAttribution?: WriteAttribution;
  validationGeneratedWrites?: string[];
  constraintAudit?: StageConstraintAuditSummary;
  timeout?: StageAttemptTimeoutSummary;
  continuation?: StageContinuation;
}

/** Control-boundary work may be complete or pending re-admission; neither is
 * permission to reset the workflow's spent iteration budget. */
export function isContinuingStage(stage: StageStatus): boolean {
  return Boolean(stage.continuation) && (stage.status === STAGE_STATUS.COMPLETE || stage.status === STAGE_STATUS.PENDING);
}

/**
 * Usage from a dynamic stage that was retired by an outer re-plan. The active
 * DAG intentionally drops those stages, but their completed work and cost are
 * still facts about the run and must remain available to aggregators.
 */
export interface RetiredStageUsage {
  stageId: string;
  iteration: number;
  status: StageStatus;
}

/**
 * Immutable evidence from a dynamic stage retired at an outer re-plan boundary.
 * The live `stages/<id>` files remain aliases for the active DAG, so every path
 * here points into an iteration-qualified archive that later same-ID work cannot
 * redirect or overwrite.
 */
export interface StageEvidenceRecord {
  stageId: string;
  iteration: number;
  status: StageStatus;
  /** Run-directory-relative immutable status snapshot. */
  statusPath: string;
  /** Run-directory-relative immutable latest-output snapshot, when one existed. */
  outputPath?: string;
  /** Attempt-indexed immutable outputs that existed at retirement time. */
  attemptOutputPaths: Array<{ attemptIndex: number; path: string }>;
  /** Run-directory-relative immutable gate verdict, when one existed. */
  verdictPath?: string;
}

/**
 * Scheduler-derived proof that a canonical brief criterion was completed and
 * independently verified in a retired dynamic DAG. Later settlement-only
 * plans may consume this proof, but planner text cannot create it.
 */
export interface CriterionDischargeRecord {
  criterionId: string;
  briefDigest: string;
  iteration: number;
  workStageId: string;
  gateStageId: string;
  /** Run-directory-relative immutable verdict captured at retirement. */
  verdictPath: string;
  verdictSha256: string;
}

/** Exact scheduler-owned bytes of the last atomically admitted check set. */
export interface AdmittedRealityChecks {
  markdown: string;
  sha256: string;
  admittedAtIteration: number;
}

/**
 * A required dynamic stage that was still pending/running when a plan could
 * otherwise be replaced or the run could otherwise complete. The scheduler,
 * not a later planner, owns this ledger so omitting the ID from a replacement
 * DAG cannot erase the work. Re-dispatching the same ID and reaching complete
 * or skipped discharges the obligation; an existing engine-owned scope
 * resolve/defer disposition is the only cross-ID exception.
 */
export interface UnresolvedStageObligation {
  stageId: string;
  declaredIteration: number;
  /** Existing explicit scope-planning dispositions that may safely supersede a blocked downstream stage. */
}

/**
 * Terminal-state config parsed from a task brief's `---` YAML frontmatter.
 *
 * Each top-level key is a status string (e.g. "shipped", "ceiling_hit",
 * "escalated"). When a file at one of `paths` exists at the start of an
 * iteration, the scheduler runs the optional `floor` check; if the floor is
 * satisfied, the run terminates with state.status set to that key.
 *
 * The floor exists so an agent cannot prematurely declare a negative verdict
 * (e.g. write ceiling_report.md after one stage) — a real ceiling result must
 * pass a minimum-effort gate the brief writer specifies.
 */
export interface TerminalStateFloor {
  /** Distinct stage_N_verdict.md files required under docs/.../ for the brief's research dir. */
  minAttemptedStages?: number;
  /** Total seconds of wall time since run started. */
  minWallMinutes?: number;
}
/**
 * Optional command to invoke after the scheduler has fully committed a
 * terminal state (status persisted, campaign entry written, run_completed
 * event recorded). Used by multi-phase research programs to chain into the
 * next phase: the hook reads the just-written verdict, decides what to do
 * next, and (e.g. via systemd-run) spawns the next FlowCrew run.
 *
 * The hook runs with these environment variables set by the scheduler:
 *   FC_PHASE          — the terminal status name (e.g. "phase_complete")
 *   FC_VERDICT_FILE   — absolute path to the matched terminal file
 *   FC_RUN_DIR        — absolute path to this run's directory
 *   FC_PROJECT_DIR    — absolute path to projectDir
 *   FC_RUN_ID         — the runId string
 *
 * Failure modes:
 *   - Non-zero exit: logged as warn; run still terminates cleanly
 *   - Timeout: hook killed; logged as warn; run still terminates cleanly
 *   - Hook is best-effort, never blocks scheduler termination
 */
export interface PostTerminateHook {
  /** Shell command (absolute path, or relative to projectDir). */
  command: string;
  /** Args passed to the command. */
  args?: string[];
  /** Max wall seconds before the hook is killed. Default 300. */
  timeoutSeconds?: number;
  /** Extra environment variables (merged on top of FC_* set by scheduler). */
  env?: Record<string, string>;
}
export interface TerminalStateEntry {
  /** File paths (relative to projectDir) that, when present, signal this status. */
  paths: string[];
  /** Optional floor — if specified, all conditions must be met before terminating. */
  floor?: TerminalStateFloor;
  /** Optional glob to count attempted research stages for floor.minAttemptedStages. */
  stageGlob?: string;
  /** Optional hook invoked after the terminal state is fully committed. */
  postTerminateHook?: PostTerminateHook;
}
export type TerminalStatesConfig = Record<string, TerminalStateEntry>;

/**
 * Research-mode config parsed from a brief's `research:` frontmatter block.
 * Drives the native research loop (researcher → implement → measure → decide).
 * Replaces the per-phase prose decision-tables that brief authors previously
 * hand-wrote for cumulative-stacking exploration.
 *
 * `policy` controls the keep/drop + continue/stop decision after each measured
 * round:
 *   - greedy_stack: keep a direction iff it improves the running-best;
 *     continue while any round improves; stop when a full round yields no gain.
 */
export type ResearchPolicy = 'greedy_stack';
export interface ResearchStopConditions {
  /** Ship + stop when running-best ≥ this value (the headline target / do-nothing baseline). */
  beat?: number;
  /** Stop after this many research rounds (phases). */
  maxRounds?: number;
  /** Stop when cumulative wall hours reach this. */
  maxWallHours?: number;
  /** Stop after N consecutive rounds with no improvement to running-best. */
  haltAfterNoImprovement?: number;
  /**
   * A round counts as a genuine IMPROVEMENT (resets the no-improvement streak + becomes
   * the new running-best) only if it beats the prior best by at least this ABSOLUTE margin.
   * Filters out within-noise knob-tuning that otherwise resets the ceiling counter forever. Default 0.
   */
  minImprovement?: number;
  /**
   * ...or by at least this multiple of the round's own cross-run standard error (result_std),
   * when reported. Default 1 — an improvement must exceed ~1 SE to count. Set 0 to disable.
   * The effective margin is max(minImprovement, improvementSEMultiple * result_std).
   */
  improvementSEMultiple?: number;
}
/**
 * Domain-AGNOSTIC per-round integrity gates, declared in the brief's `research.integrity`
 * block. The engine applies these generically — it has NO built-in knowledge of any
 * domain's fields/thresholds. A brief declares e.g.
 *   integrity: { field_floors: { worst_case_score: 50 }, reject_if_positive: [failure_count] }
 * and the engine rejects rounds violating them, without the engine knowing what
 * those fields mean. Variability and outlier bounds apply only when declared.
 */
export interface ResearchIntegrityConfig {
  /** Reject if result_std/|result| exceeds this brief-declared uncertainty bound. */
  maxStdRatio?: number;
  /** Brief-declared improvement bound as a multiple of |baseline| (baseline≠0). */
  outlierFactor?: number;
  /** Reject if round[field] < min — brief-declared numeric floors (domain-specific values live here, not in code). */
  fieldFloors?: Record<string, number>;
  /** Reject if round[field] > 0 — brief-declared "this field must be zero/absent". */
  rejectIfPositive?: string[];
}

export interface ResearchConfig {
  /** Entering running-best the loop builds on (the baseline metric value). */
  baseline: number;
  /** Higher metric is better (default true). */
  higherIsBetter?: boolean;
  policy: ResearchPolicy;
  stop?: ResearchStopConditions;
  /** Per-round integrity gates (brief-declared; engine stays domain-agnostic). */
  integrity?: ResearchIntegrityConfig;
  /** Structurally computable pre-run selection feasibility, parsed from the brief. */
  feasibility?: ResearchFeasibilityConfig;
  /** Present when a declared feasibility block was rejected instead of silently dropped. */
  feasibilityError?: string;
  /**
   * OPAQUE JSON Schema for the round_result file (single source of the output contract).
   * The engine never interprets the fields — it only (a) injects it into the planner as
   * {result_schema} so checks reference the declared shape, and (b) validates each round's
   * result against it. Domain field names live here (the brief), never in the engine.
   */
  resultSchema?: Record<string, unknown>;
  /**
   * Context primitive roots (project-relative) the engine inventories into {context_inventory}
   * so the planner's Propose step sees the real on-disk world-model. Default: ['data'].
   * Engineering objectives can widen this (e.g. ['src', 'data']).
   */
  contextRoots?: string[];
  /**
   * Project-relative file where the agent writes the latest round's measured
   * result as JSON `{ "label": "...", "result": <number> }`. The framework
   * reads it, journals it (framework-owned, in the run dir), computes the
   * decision via the policy, and drives continue/ship/ceiling — so the agent
   * never writes a prose decision table. Default: docs/research_round_result.json
   */
  resultFile?: string;
  /**
   * Optional project-relative directory for research evidence discovery and run_manifest.json.
   * Without it, the framework uses the directory containing resultFile; the
   * default result file therefore keeps the historical docs/ directory.
   */
  reportDir?: string;
  /**
   * Optional CONFIRM gate (A+(a)): before a candidate is accepted as a `ship`, the engine runs
   * this brief-declared shell command and only allows `shipped` if it exits 0; otherwise the
   * terminal status is downgraded to `ceiling_hit`. This is the verify-before-trust mechanism —
   * the engine carries NO domain knowledge; the command + its contract live entirely in the brief
   * (e.g. "re-run the candidate on a fresh independent split and assert it still beats baseline").
   * Generic: runs through the SAME exec-script-exit-zero check the reality gate uses.
   */
  confirm?: ResearchConfirmConfig;
}

/**
 * A+(a) confirm gate: a brief-declared, domain-agnostic verify-before-trust contract.
 * The engine treats `command` as opaque shell text run via the exec-script-exit-zero check
 * (exit 0 = confirmed). `requires` is optional human-readable documentation of the contract
 * (surfaced in events/reports); it does not alter engine behavior — the exit-zero contract is
 * the machine-checked assertion.
 */
export interface ResearchConfirmConfig {
  /** Explicit handler reads; old persisted configurations remain readable. */
  reads?: import('./artifact-declarations.js').ArtifactRead[];
  /** Shell command run before a `ship`; exit 0 confirms the candidate. */
  command: string;
  /** Optional human-readable assertion the command is expected to enforce (documentation only). */
  requires?: string;
  /** Optional timeout for the confirm command in seconds (default 300). */
  timeoutSeconds?: number;
}

/** Regression/plateau labels survive only in historical stored alerts. Current
 * campaign policy produces repeated_failure; research policy owns comparisons. */
export type CampaignTriggerType = 'repeated_failure' | 'regression' | 'plateau';

export interface RealityGateOutputTail {
  tail: string;
  /** Raw characters available in the durable check report. */
  sourceChars: number;
  sourceLines: number;
  capturedChars: number;
  capturedLines: number;
  truncated: boolean;
}

export interface RealityGateCheckDiagnostic {
  name: string;
  type: string;
  pass: boolean;
  advisory: boolean;
  details: string;
  exit?: RealityGateExit;
  stdout?: RealityGateOutputTail;
  stderr?: RealityGateOutputTail;
}

export interface RealityGateDiagnostics {
  /** Run-directory-relative canonical artifact; never reconstructed from this projection. */
  artifactPath: string;
  pass: boolean;
  checkedAt: string;
  checksRun: number;
  results: RealityGateCheckDiagnostic[];
}

export interface RunHistoryRef {
  version: 1;
  path: string;
  /** Only this durable prefix is acknowledged by the atomic projection. */
  committedBytes: number;
  counts: {
    retiredStageUsage: number;
    stageEvidence: number;
  };
}

export interface RunStateFormat {
  version: 2;
  revision: number;
  history?: RunHistoryRef;
}

export interface StoreState {
  deploymentHold?: import('./deployment-hold.js').RunDeploymentHold;
  continuationFailure?: { at: string; reason: string; generation?: string };
  /** Observed scheduler admissions only; legacy starts are never fabricated. */
  engineHistory?: Array<{ kind: 'start' | 'resume'; at: string; generation?: string; pid: number; processStart?: import('./run-lock.js').ProcessStartToken }>;
  engineCheckpoint?: import('./restart-recovery.js').EngineCheckpoint;
  recovery?: import('./restart-recovery.js').RestartRecovery;
  /** Durable authority for reconciling a partially published interruption. */
  recoveryIntent?: import('./restart-recovery.js').RecoveryIntent;
  planControl?: import('./plan-revisions.js').PlanControl;
  /** Transaction-bound revision decisions; stage files are replayable projections. */
  planRevisionDecisions?: Record<string, import('./plan-revisions.js').PlanRevisionDecision>;
  /** Scheduler-admitted query facts. Legacy runs remain readable without them. */
  queryState?: import('./run-state-view.js').RunQueryState;
  runId: string;
  workflowName: string;
  projectDir: string;
  /** git HEAD SHA captured at run start, used to compute a real diff in the run summary. Absent when projectDir is not a git repo. */
  baseCommit?: string;
  status: RunStatus;
  /** Engine-owned cause of the latest conclusion; absent in legacy records. */
  reasonCode?: import('./scheduler/sched_policy/run-completion.js').RunConclusionReason;
  /**
   * Set while status==='parked': the approval request this run suspended on.
   * `pausedAt` freezes the elapsed clock so a park that waits a day does not
   * render as a 24h hang.
   */
  parked?: {
    requestId: string;
    action: string;
    target?: string;
    reason: string;
    atIteration: number;
    stageId?: string;
    requestedAt: string;
    pausedAt: string;
  };
  /** Map of status → terminal-state file paths/floor (set from brief frontmatter). */
  terminalStates?: TerminalStatesConfig;
  /** Terminal content captured before producers execute; retained on continuation. */
  terminalArtifactBaselines?: Record<string, import('./content-identity.js').ContentIdentity>;
  /** Filename (basename) of the terminal file that triggered termination — used for handoff to /ship follow-ups. */
  terminalArtifact?: string;
  /** Research-mode config (set from brief `research:` block). */
  research?: ResearchConfig;
  /** Content identities captured before this research run dispatches producers. */
  researchInputGeneration?: import('./research-candidate.js').ResearchInputGeneration;
  /** Structurally declared brief outputs archived before terminal commit. */
  declaredOutputs?: Array<{
    path: string;
    line: number;
    source: string;
    disposition: 'create' | 'update' | 'append' | 'replace' | 'input';
    expectedType: 'file' | 'directory';
  }>;
  stages: Record<string, StageStatus>;
  /** Append-only cost ledger for dynamic stages replaced by later outer plans. */
  retiredStageUsage?: RetiredStageUsage[];
  /** Append-only, iteration-addressed status/output/verdict evidence for replaced dynamic stages. */
  stageEvidence?: StageEvidenceRecord[];
  /** Brief-digest-bound ordinary-work obligations already discharged by passing gates. */
  criterionDischarges?: CriterionDischargeRecord[];
  /** Canonical bytes inherited by later planner attempts until an amendment is admitted. */
  admittedRealityChecks?: AdmittedRealityChecks;
  /** Required dynamic stages that a later plan must not silently forget. */
  unresolvedStageObligations?: UnresolvedStageObligation[];
  /** Engine-owned model work outside dispatched stages, with the same attempt ledger. */
  auxiliaryAttempts?: Record<string, StageAttempt[]>;
  startedAt: string;
  completedAt?: string;
  plan?: unknown[];
  dispatchedStages?: unknown[];
  taskDescription?: string;
  /** Exact brief identity and recorded preflight findings admitted before launch. */
  briefAdmission?: BriefAdmissionRecord;
  currentIteration?: number;
  gateRetryRound?: { iteration: number; round: number };
  maxIterations?: number;
  maxRetries?: number;
  autoApproveRetries?: boolean;
  autoApprove?: boolean;
  timeoutMs?: number;
  failureReason?: string;
  /** Bounded, ANSI-free operator diagnostics copied from the terminal reality gate. */
  realityGate?: RealityGateDiagnostics;
  campaignId?: string;
  campaign_id?: string;
  brief_version?: string;
  brief_dir?: string;
  campaignStorageKey?: string;
  campaignName?: string;
  campaignSeq?: number;
  campaignIteration?: number;
  // When false, the run stays attached to its campaign for downstream telemetry,
  // but the scheduler skips injecting prior-phase context into stage prompts.
  // Used to escape inherited "fail-closed / phase-N continue" mindsets when the
  // current task has fundamentally pivoted from the campaign's recent history.
  inheritCampaignContext?: boolean;
  campaignAlert?: {
    type: CampaignTriggerType;
    action: 'inject_researcher';
    message: string;
    source: 'campaign_health';
    triggeredAt: string;
    iteration: number;
  };
  researchInjection?: {
    source: 'campaign_health';
    triggeredAt: string;
    iteration: number;
    alertType: CampaignTriggerType;
    message: string;
  };
  parentTaskId?: string;
  budget?: {
    totalTokens?: number;
    totalTimeMs?: number;
    usedTokens?: number;
    usedTimeMs?: number;
  };
  /** Compact projection format. Readers hydrate referenced history transparently. */
  stateFormat?: RunStateFormat;
}

/** Parsed archive shape before the status text has been trusted. */
export type ArchivedStoreState = Omit<StoreState, 'status'> & { status: unknown };

export interface ArchivedRunStateRead {
  state: ArchivedStoreState;
  status: RunStatusResolution;
}

export const FC_DIR = '.fc';
// FC_HOME (env) or setFcGlobalDir() override the configured store root.
// Consumers: engine-scenario tests and `flowcrew rehearse` run real workflows
// against a temp dir so they can never write runs/campaign ledgers into the
// developer's real store (openworker lesson: tests once read real machine
// state and emitted real telemetry; isolation must be structural, not
// disciplinary). The env var works when set before module load; the setter
// covers callers inside an already-loaded process (the CLI's rehearse path).
let _fcGlobalDir = process.env.FC_HOME ? process.env.FC_HOME : join(homedir(), FC_DIR);

export function fcGlobalDir(): string {
  return _fcGlobalDir;
}

export function setFcGlobalDir(path: string): void {
  _fcGlobalDir = path;
}

export function runsRoot(_projectDir?: string): string {
  return join(_fcGlobalDir, 'runs');
}

export function campaignsRoot(): string {
  return join(_fcGlobalDir, 'campaigns');
}

function appendCampaignEvent(campaignStorageKey: string, event: Record<string, unknown>): void {
  if (!campaignStorageKey) return;
  const filePath = join(campaignsRoot(), `${campaignStorageKey}.jsonl`);
  mkdirSync(campaignsRoot(), { recursive: true });
  appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

/** The verdict-file contract a gate stage must write to verdict_<stage_id>.json. */
export interface GateVerdict {
  pass: boolean;
  reason?: string;
  repairability?: { version: 1; disposition: 'repairable' | 'irreparable'; evidence: string };
  /** Engine-only refusal classification; authored fields never populate it. */
  refusal?: { kind: 'repairability' | 'validation_regression' | 'validation_unresolved' | 'declared_output' | 'audit_findings' | 'research_outcome_absent' | 'research_outcome_invalid' | 'contradiction' | 'criterion_evidence' | 'numeric_evidence' | 'score_contract' | 'missing_verdict' };
}
export const VERDICT_CONTRACT_DOC = '{"pass": true|false, "reason": "<why>"}  (scored gates may also set "score": <number>, "metric": "<name>", "threshold": <number>). '
  + 'A rejection may also declare "repairability": {"version":1,"disposition":"repairable"|"irreparable","evidence":"<reproducible evidence>"}. '
  + 'Use irreparable only when no repair or re-plan can undo the observed failure; it ends the run escalated and preserves the rejection. '
  + 'Omitting repairability preserves the legacy repair route. Never declare repairability with pass=true; unknown versions, dispositions, extra fields or empty evidence are refused. Keep failed criteria and their evidence in the verdict.';

/** Field names a campaign multi-phase gate verdict may carry (consumed by campaign code). */
export const PHASE_METADATA_FIELDS = 'phase, phaseComplete, nextPhase, outcome, artifactSummary, reason';

const SETTLED_STAGE_STATUSES = [STAGE_STATUS.COMPLETE, STAGE_STATUS.FAILED] as const;
const SATISFIED_STAGE_DEPENDENCY_STATUSES = [STAGE_STATUS.COMPLETE] as const;

export function isRunningStageStatus(status: string): boolean {
  return status === STAGE_STATUS.RUNNING;
}

export function isPendingStageStatus(status: string): boolean {
  return status === STAGE_STATUS.PENDING;
}

/** Complete or failed: execution has produced a settled stage outcome. */
export function isSettledStageStatus(status: string): boolean {
  return (SETTLED_STAGE_STATUSES as readonly string[]).includes(status);
}

/** Only successful completion can release a downstream DAG dependency. */
export function isSatisfiedStageDependencyStatus(status: string): boolean {
  return (SATISFIED_STAGE_DEPENDENCY_STATUSES as readonly string[]).includes(status);
}

function failureMarkdown(report: RealityGateReport, targetStatus: string): string {
  const failed = report.results.filter((item) => !item.pass && item.advisory !== true);
  const advisories = report.results.filter((item) => !item.pass && item.advisory === true);
  return [
    `# Reality Gate Failed`,
    ``,
    `Requested terminal status: ${targetStatus}`,
    `Checked at: ${report.checkedAt}`,
    ``,
    `## Failed checks`,
    ...(failed.length === 0 ? ['- none'] : failed.map((item) => `- ${item.name} (${item.type}): ${item.details}`)),
    ...(advisories.length === 0 ? [] : [
      ``,
      `## Advisory checks`,
      ...advisories.map((item) => `- ${item.name} (${item.type}): ${item.details}`),
    ]),
    ``,
  ].join('\n');
}

const REALITY_GATE_OUTPUT_TAIL_CHARS = 2_048;
const REALITY_GATE_FAILURE_DETAIL_CHARS = 240;
const REALITY_GATE_ARTIFACT_PATH = '.reality-gate.json';

function countOutputLines(value: string): number {
  if (value.length === 0) return 0;
  const lineBreaks = value.match(/\r\n|\r|\n/g)?.length ?? 0;
  return lineBreaks + (/\r\n$|\r$|\n$/.test(value) ? 0 : 1);
}

function captureRealityGateOutput(value: string): RealityGateOutputTail {
  const sanitized = stripVTControlCharacters(value);
  const tail = sanitized.slice(-REALITY_GATE_OUTPUT_TAIL_CHARS);
  return {
    tail,
    sourceChars: value.length,
    sourceLines: countOutputLines(value),
    capturedChars: tail.length,
    capturedLines: countOutputLines(tail),
    truncated: sanitized.length > tail.length,
  };
}

function realityGateDiagnostics(report: RealityGateReport): RealityGateDiagnostics {
  return {
    artifactPath: REALITY_GATE_ARTIFACT_PATH,
    pass: report.pass,
    checkedAt: report.checkedAt,
    checksRun: report.checksRun,
    results: report.results.map((item) => {
      const diagnostic: RealityGateCheckDiagnostic = {
        name: stripVTControlCharacters(item.name),
        type: stripVTControlCharacters(item.type),
        pass: item.pass,
        advisory: item.advisory === true,
        details: stripVTControlCharacters(item.details),
      };
      if (!item.pass && item.evidence && typeof item.evidence === 'object' && !Array.isArray(item.evidence)) {
        const evidence = item.evidence as Record<string, unknown>;
        if (isRealityGateExit(evidence.exit)) diagnostic.exit = { ...evidence.exit };
        if (typeof evidence.stdout === 'string') diagnostic.stdout = captureRealityGateOutput(evidence.stdout);
        if (typeof evidence.stderr === 'string') diagnostic.stderr = captureRealityGateOutput(evidence.stderr);
      }
      return diagnostic;
    }),
  };
}

function isRealityGateExit(value: unknown): value is RealityGateExit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const exit = value as Record<string, unknown>;
  return (exit.code === null || Number.isInteger(exit.code))
    && (exit.signal === null || typeof exit.signal === 'string')
    && typeof exit.timedOut === 'boolean';
}

function realityGateFailureReason(report: RealityGateDiagnostics, targetStatus: string): string {
  const failed = report.results.filter((item) => !item.pass && !item.advisory);
  const summaries = failed.map((item) => {
    const details = item.details.replace(/\s+/g, ' ').trim();
    const excerpt = details.length > REALITY_GATE_FAILURE_DETAIL_CHARS
      ? `${details.slice(0, REALITY_GATE_FAILURE_DETAIL_CHARS - 3)}...`
      : details;
    return `${item.name} (${item.type})${excerpt ? `: ${excerpt}` : ''}`;
  });
  return `Reality gate blocked terminal status ${targetStatus}; failed checks: ${summaries.join('; ')}`;
}

export async function evaluateRealityGate(
  projectDir: string, runId: string, targetStatus: StoreState['status'],
): Promise<Pick<StoreState, 'realityGate' | 'failureReason'>> {
  const dir = runDir(projectDir, runId);
  const briefPath = join(dir, 'task_brief.md');
  // Checks come from two sources, both in the `## Reality checks` block format:
  //   1. the human-authored brief (task_brief.md), and
  //   2. PLANNER-authored checks (reality_checks.md) — this is how the planner wires
  //      deterministic gates for the goal's hard constraints (Atom Architecture P1/P3),
  //      without having to edit the human brief.
  const checks = existsSync(briefPath) ? parseChecksFromBrief(briefPath) : [];
  const plannerChecksPath = join(dir, 'reality_checks.md');
  if (existsSync(plannerChecksPath)) checks.push(...parseChecksFromBrief(plannerChecksPath));
  if (checks.length === 0) return {};
  const report = await runAllChecks(checks, { taskDir: dir, projectDir, briefPath: existsSync(briefPath) ? briefPath : plannerChecksPath });
  const artifactPath = join(dir, REALITY_GATE_ARTIFACT_PATH);
  atomicWrite(artifactPath, JSON.stringify(report, null, 2) + '\n');
  const durableReport = readRealityGateReport(artifactPath);
  const advisoryFailures = durableReport.results.filter((item) => !item.pass && item.advisory === true);
  if (advisoryFailures.length > 0) {
    const { recordRunEvent } = await import('./run-events.js');
    recordRunEvent(projectDir, runId, {
      type: 'reality_gate_advisory',
      runId,
      timestamp: durableReport.checkedAt,
      detail: advisoryFailures.map((item) => `${item.name}: ${item.details}`).join('; '),
    });
  }
  const diagnostics = realityGateDiagnostics(durableReport);
  if (durableReport.pass) return { realityGate: diagnostics };
  appendFileSync(join(dir, '.reality-gate.failures.md'), failureMarkdown(durableReport, targetStatus), 'utf-8');
  return { realityGate: diagnostics, failureReason: realityGateFailureReason(diagnostics, targetStatus) };
}

function oneLineOutcome(value: string): string | undefined {
  const line = value
    .split(/\r?\n/)
    .map((part) => part.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  if (!line) return undefined;
  const compact = line.replace(/\s+/g, ' ');
  return compact.length > 200 ? compact.slice(0, 197) + '...' : compact;
}

function readTerminalOutcome(projectDir: string, runId: string, state: StoreState): string | undefined {
  const dir = runDir(projectDir, runId);
  if (state.terminalArtifact) {
    for (const name of [...recordedTerminalArtifactSnapshotNames(state.terminalArtifact), state.terminalArtifact]) {
      try {
        const outcome = oneLineOutcome(readFileSync(join(dir, name), 'utf-8'));
        if (outcome) return outcome;
      } catch { /* optional terminal artifact */ }
    }
  }
  return state.failureReason ? oneLineOutcome(state.failureReason) : undefined;
}

/** A bounded snapshot identity keeps every declared path distinct. */
export function terminalArtifactSnapshotName(path: string): string {
  return `terminal_snapshots/${createHash('sha256').update(path).digest('hex')}`;
}

/** Legacy reads use only the recorded basename identity, never a guessed declaration basename. */
export function recordedTerminalArtifactSnapshotNames(artifact: string): string[] {
  return [terminalArtifactSnapshotName(artifact), ...(!artifact.includes('/') ? [`terminal_${artifact}`] : [])];
}

function emitCampaignEnvelopeEvents(projectDir: string, runId: string, state: StoreState): void {
  const campaignStorageKey = resolveCampaignStorageKey(state);
  if (!campaignStorageKey) return;
  const dir = runDir(projectDir, runId);
  const startedMarker = join(dir, '.campaign_started_emitted');
  const endedMarker = join(dir, '.campaign_envelope_emitted');
  const now = new Date().toISOString();
  const baseEvent = {
    runId,
    projectIdentity: projectPersistenceIdentity(projectDir),
    seq: state.campaignSeq ?? 1,
    campaignId: state.campaignId ?? state.campaignName ?? campaignStorageKey,
    campaignStorageKey,
    campaignName: state.campaignName,
    workflow: state.workflowName,
  };

  if (!existsSync(startedMarker)) {
    appendCampaignEvent(campaignStorageKey, {
      ts: now,
      timestamp: now,
      kind: 'task_started',
      ...baseEvent,
      status: 'running',
    });
    writeFileSync(startedMarker, now + '\n', 'utf-8');
  }

  if (isTerminalRunStatus(String(state.status)) && !existsSync(endedMarker)) {
    const outcome = readTerminalOutcome(projectDir, runId, state);
    appendCampaignEvent(campaignStorageKey, {
      ts: now,
      timestamp: now,
      kind: 'task_ended',
      ...baseEvent,
      status: state.status,
      ...(outcome ? { outcome } : {}),
      ...(typeof state.currentIteration === 'number' ? { iteration: state.currentIteration } : {}),
    });
    writeFileSync(endedMarker, now + '\n', 'utf-8');
  }
}

/** Derive a one-line display title from an authored Markdown task brief. */
export function extractTaskTitle(desc?: string): string {
  if (!desc) return '';
  const lines = desc.split(/\r?\n/);
  if (lines[0]?.charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);

  let content = lines;
  if (lines[0]?.trim() === '---') {
    const closingDelimiter = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    // An incomplete block is ambiguous. Keep it visible and search through it
    // instead of swallowing the entire brief as frontmatter.
    if (closingDelimiter >= 0) content = lines.slice(closingDelimiter + 1);
  }

  const shorten = (value: string): string => (
    value.length > 80 ? `${value.slice(0, 77)}...` : value
  );
  for (const line of content) {
    const heading = line.match(/^\s{0,3}#{1,6}[\t ]+(.+?)\s*#*\s*$/)?.[1]?.trim();
    if (heading) return shorten(heading);
  }
  for (const line of content) {
    const fallback = line.trim();
    if (fallback && fallback !== '---') return shorten(fallback);
  }
  return '';
}

export function ensureGlobalRunsDir(): void {
  mkdirSync(join(_fcGlobalDir, 'runs'), { recursive: true });
}

export function runDir(projectDir: string, runId: string): string {
  return join(runsRoot(projectDir), runId);
}

export function stageDir(projectDir: string, runId: string, stageId: string): string {
  return join(runDir(projectDir, runId), 'stages', stageId);
}

function generateRunId(at = new Date()): string {
  const ts = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = randomBytes(3).toString('hex');
  return `${ts}-${suffix}`;
}

export const RUN_RESERVATION_FILE = '.run-reservation.json';
export const RUN_RESERVATION_TTL_MS = 15 * 60_000;

export interface RunReservation {
  version: 1;
  runId: string;
  projectDir: string;
  reservedAt: string;
}

/** Give pre-initialization artifact writers a classified, expiring identity. */
export function requireRunArtifactDirectory(projectDir: string, runId: string): string {
  requireSafeRunId(runId);
  // Validate before deriving or probing a path.  Otherwise a pre-existing
  // ../escape/run.json turns the state check itself into traversal authority.
  const dir = runDir(projectDir, runId);
  if (existsSync(join(dir, 'run.json'))) return dir;
  if (readRunReservation(projectDir, runId)) return dir;
  // Artifact APIs can precede scheduler initialization. Classify that window
  // with the same expiring reservation marker as reserveRun instead of
  // creating an unidentifiable directory or inventing run state.
  ensureGlobalRunsDir();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'run.json')) && !readRunReservation(projectDir, runId)) {
    const reservation: RunReservation = {
      version: 1,
      runId,
      projectDir: resolve(projectDir),
      reservedAt: new Date().toISOString(),
    };
    atomicWrite(join(dir, RUN_RESERVATION_FILE), JSON.stringify(reservation, null, 2) + '\n');
  }
  return dir;
}

/** Variant for consumers which already received the exact run directory. */
export function requireExistingRunArtifactDirectory(runDirectory: string): string {
  if (existsSync(join(runDirectory, 'run.json'))) return runDirectory;
  try {
    const marker = JSON.parse(readFileSync(join(runDirectory, RUN_RESERVATION_FILE), 'utf-8')) as Partial<RunReservation>;
    const reservedAt = Date.parse(String(marker.reservedAt ?? ''));
    if (marker.version === 1 && marker.runId === basename(runDirectory)
      && Number.isFinite(reservedAt) && Date.now() - reservedAt <= RUN_RESERVATION_TTL_MS) return runDirectory;
  } catch { /* classified below */ }
  throw new Error(`Run directory ${runDirectory} is neither initialized nor actively reserved`);
}

/**
 * Allocate the run identity before a daemon launches the CLI. The directory and
 * marker are the durable task→run association; run.json is deliberately absent
 * until the scheduler initializes the reserved run.
 */
export function reserveRun(projectDir: string, at = new Date()): { runId: string; runDirPath: string } {
  ensureGlobalRunsDir();
  const normalizedProjectDir = resolve(projectDir);
  for (let attempt = 0; attempt < 10; attempt++) {
    const runId = generateRunId(at);
    const dir = runDir(normalizedProjectDir, runId);
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    const reservation: RunReservation = {
      version: 1,
      runId,
      projectDir: normalizedProjectDir,
      reservedAt: at.toISOString(),
    };
    try {
      atomicWrite(join(dir, RUN_RESERVATION_FILE), JSON.stringify(reservation, null, 2) + '\n');
      return { runId, runDirPath: dir };
    } catch (err) {
      try { rmdirSync(dir); } catch { /* retain evidence if the directory is no longer empty */ }
      throw err;
    }
  }
  throw new Error('Unable to allocate a unique FlowCrew run id');
}

export function readRunReservation(
  projectDir: string,
  runId: string,
  nowMs = Date.now(),
  maxAgeMs = RUN_RESERVATION_TTL_MS,
): RunReservation | undefined {
  const dir = runDir(projectDir, runId);
  try {
    const reservation = JSON.parse(readFileSync(join(dir, RUN_RESERVATION_FILE), 'utf-8')) as Partial<RunReservation>;
    if (
      reservation.version !== 1 ||
      reservation.runId !== runId ||
      basename(dir) !== runId ||
      typeof reservation.projectDir !== 'string' ||
      resolve(reservation.projectDir) !== resolve(projectDir) ||
      typeof reservation.reservedAt !== 'string'
    ) return undefined;
    const reservedAt = Date.parse(reservation.reservedAt);
    if (!Number.isFinite(reservedAt) || reservedAt > nowMs + 5_000 || nowMs - reservedAt > maxAgeMs) return undefined;
    return reservation as RunReservation;
  } catch {
    return undefined;
  }
}

export function initializeReservedRun(
  projectDir: string,
  runId: string,
  workflowName: string,
  workflowYaml: string,
  stageIds: string[],
): { runId: string; runDirPath: string } {
  const normalizedProjectDir = resolve(projectDir);
  const reservation = readRunReservation(normalizedProjectDir, runId, Date.now(), Number.POSITIVE_INFINITY);
  if (!reservation) throw new Error(`Run reservation is missing or invalid: ${runId}`);
  const dir = runDir(normalizedProjectDir, runId);
  if (existsSync(join(dir, 'run.json'))) throw new Error(`Reserved run is already initialized: ${runId}`);
  const stages: Record<string, StageStatus> = {};
  for (const sid of stageIds) stages[sid] = { status: 'pending', retries: 0 };
  const state: StoreState = {
    runId,
    workflowName,
    projectDir: normalizedProjectDir,
    terminalArtifactBaselines: {},
    status: 'running',
    stages,
    startedAt: new Date().toISOString(),
  };
  const baseCommit = captureGitHead(normalizedProjectDir);
  if (baseCommit) state.baseCommit = baseCommit;
  // State is the directory's identity. Publish it before any optional child
  // directories so every observable initialization point is classifiable.
  writeRunState(normalizedProjectDir, runId, state);
  mkdirSync(join(dir, 'stages'), { recursive: true });
  for (const sid of stageIds) {
    mkdirSync(stageDir(normalizedProjectDir, runId, sid), { recursive: true });
  }
  atomicWrite(join(dir, 'workflow.yaml'), workflowYaml);
  try { unlinkSync(join(dir, RUN_RESERVATION_FILE)); } catch { /* initialized state is authoritative */ }
  return { runId, runDirPath: dir };
}

/** Return the current git HEAD SHA for `projectDir`, or undefined when it is not a git repo / git is unavailable. */
function captureGitHead(projectDir: string): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
  } catch { /* not a git repo, or git not installed — fall back to LLM extraction */
    return undefined;
  }
}

export const RUN_HISTORY_FILE = 'run-history.jsonl' as const;
export const RUN_STATE_LOCK_FILE = '.run-state.lock';
const RUN_STATE_LOCK_TIMEOUT_MS = 5_000;
const RUN_STATE_STALE_LOCK_MS = 30_000;

type RunHistoryKind = keyof RunHistoryRef['counts'];

interface RunHistoryRecord {
  kind: RunHistoryKind;
  index: number;
  value: unknown;
}

interface RunHistories {
  retiredStageUsage: RetiredStageUsage[];
  stageEvidence: StageEvidenceRecord[];
}

class RunStateProjectionConflictError extends Error {}

interface RunStateProjectionExpectation {
  raw: string;
}

function emptyRunHistories(): RunHistories {
  return { retiredStageUsage: [], stageEvidence: [] };
}

/**
 * Compare values as they exist in the JSON-backed store. Optional properties
 * whose value is `undefined` are intentionally absent after persistence; a
 * comparison against the pre-serialization object must not turn that harmless
 * representation change into another history record on every write.
 */
function isJsonPersistedEqual(left: unknown, right: unknown): boolean {
  const persisted = (value: unknown): unknown => {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded) as unknown;
  };
  return isDeepStrictEqual(persisted(left), persisted(right));
}

function historyRef(value: unknown): RunHistoryRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const format = value as Partial<RunStateFormat>;
  if (format.version !== 2) throw new Error(`Unsupported run state projection version: ${String(format.version)}`);
  if (!Number.isSafeInteger(format.revision) || (format.revision ?? -1) < 0) {
    throw new Error('Invalid run state projection revision in run.json');
  }
  if (!format.history) return undefined;
  const ref = format.history as Partial<RunHistoryRef>;
  const counts = ref.counts as Partial<RunHistoryRef['counts']> | undefined;
  if (
    ref.version !== 1
    || typeof ref.path !== 'string'
    || !/^run-history[^/\\]*\.jsonl$/.test(ref.path)
    || !Number.isSafeInteger(ref.committedBytes)
    || (ref.committedBytes ?? -1) < 0
    || !counts
    || !Number.isSafeInteger(counts.retiredStageUsage) || (counts.retiredStageUsage ?? -1) < 0
    || !Number.isSafeInteger(counts.stageEvidence) || (counts.stageEvidence ?? -1) < 0
  ) throw new Error('Invalid run history reference in run.json');
  return ref as RunHistoryRef;
}

function readPrefix(path: string, length: number): Buffer {
  if (length === 0) return Buffer.alloc(0);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size < length) {
      throw new Error(`Run history is truncated: ${path} has ${size} bytes; run.json acknowledges ${length}`);
    }
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, out, offset, length - offset, offset);
      if (count <= 0) throw new Error(`Run history ended before acknowledged byte ${length}: ${path}`);
      offset += count;
    }
    return out;
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
  }
}

function readRunHistories(runPath: string, ref: RunHistoryRef | undefined): RunHistories {
  if (!ref) return emptyRunHistories();
  const slots: Record<RunHistoryKind, Map<number, unknown>> = {
    retiredStageUsage: new Map(),
    stageEvidence: new Map(),
  };
  const raw = readPrefix(join(runPath, ref.path), ref.committedBytes).toString('utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: Partial<RunHistoryRecord>;
    try { record = JSON.parse(line) as Partial<RunHistoryRecord>; } catch {
      throw new Error(`Malformed acknowledged run history record in ${join(runPath, ref.path)}`);
    }
    if (
      (record.kind !== 'retiredStageUsage' && record.kind !== 'stageEvidence')
      || !Number.isSafeInteger(record.index)
      || (record.index ?? -1) < 0
      || !Object.prototype.hasOwnProperty.call(record, 'value')
    ) throw new Error(`Invalid acknowledged run history record in ${join(runPath, ref.path)}`);
    slots[record.kind].set(record.index as number, record.value);
  }

  const materialize = <T>(kind: RunHistoryKind, count: number): T[] => {
    const values: T[] = [];
    for (let index = 0; index < count; index += 1) {
      if (!slots[kind].has(index)) throw new Error(`Run history ${kind}[${index}] is missing from acknowledged prefix`);
      values.push(slots[kind].get(index) as T);
    }
    return values;
  };
  return {
    retiredStageUsage: materialize<RetiredStageUsage>('retiredStageUsage', ref.counts.retiredStageUsage),
    stageEvidence: materialize<StageEvidenceRecord>('stageEvidence', ref.counts.stageEvidence),
  };
}

function hydrateRunProjection(runPath: string, parsed: ArchivedStoreState): ArchivedStoreState {
  if (parsed.workflowName === 'default') parsed.workflowName = 'planner';
  const status = resolveRunStatus(parsed.status);
  if (status.kind === 'known') parsed.status = status.status;
  for (const status of Object.values(parsed.stages ?? {})) projectAttemptCauses(status);
  // Old in-flight runs predate the persisted gate coordinate. Project once at
  // read time; the next ordinary state write retains it without rescanning.
  if (!parsed.gateRetryRound && parsed.currentIteration !== undefined) {
    const archive = join(runPath, 'gate_reevaluation', `iteration_${parsed.currentIteration}`);
    let round = 0;
    if (existsSync(archive)) for (const name of readdirSync(archive)) {
      const match = /^round_(\d+)$/.exec(name);
      if (match && existsSync(join(archive, name, 'repair_diff.json'))) round = Math.max(round, Number(match[1]));
    }
    if (round > 0) parsed.gateRetryRound = { iteration: parsed.currentIteration, round };
  }
  if (!parsed.stateFormat) return parsed;
  const ref = historyRef(parsed.stateFormat);
  const histories = readRunHistories(runPath, ref);
  if (histories.retiredStageUsage.length > 0) parsed.retiredStageUsage = histories.retiredStageUsage;
  if (histories.stageEvidence.length > 0) parsed.stageEvidence = histories.stageEvidence;
  return parsed;
}

function stateLockSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withRunStateLock<T>(directory: string, fn: () => T): T {
  const path = join(directory, RUN_STATE_LOCK_FILE);
  const token = randomBytes(12).toString('hex');
  const started = Date.now();
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`, 'utf-8');
      } catch (error) {
        try { closeSync(fd); } catch { /* best effort */ }
        fd = undefined;
        try { unlinkSync(path); } catch { /* best effort */ }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(path, 'utf-8')) as { pid?: unknown; acquiredAt?: unknown };
        const acquiredAt = typeof owner.acquiredAt === 'string' ? Date.parse(owner.acquiredAt) : Number.NaN;
        stale = typeof owner.pid === 'number'
          ? processLiveness(owner.pid) === 'dead'
          : Number.isFinite(acquiredAt) && Date.now() - acquiredAt >= RUN_STATE_STALE_LOCK_MS;
      } catch {
        try { stale = Date.now() - statSync(path).mtimeMs >= RUN_STATE_STALE_LOCK_MS; } catch { /* leave the lock non-stale */ }
      }
      if (stale) {
        try { unlinkSync(path); } catch { /* another owner won */ }
        continue;
      }
      if (Date.now() - started >= RUN_STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for run state lock ${path}`, { cause: error });
      }
      stateLockSleep(10);
    }
  }
  try {
    return fn();
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
    try {
      const owner = JSON.parse(readFileSync(path, 'utf-8')) as { token?: unknown };
      if (owner.token === token) unlinkSync(path);
    } catch { /* an old owner never removes a replacement lock */ }
  }
}

function mergeImmutableHistory<T>(name: string, current: T[], incoming: T[] | undefined): T[] {
  if (!incoming) return current;
  const overlap = Math.min(current.length, incoming.length);
  for (let index = 0; index < overlap; index += 1) {
    if (!isJsonPersistedEqual(current[index], incoming[index])) {
      throw new Error(`Refusing to rewrite acknowledged append-only ${name}[${index}]`);
    }
  }
  return incoming.length > current.length ? incoming : current;
}

function mergeStateHistories(current: StoreState | undefined, incoming: StoreState): StoreState {
  return {
    ...incoming,
    retiredStageUsage: mergeImmutableHistory(
      'retiredStageUsage',
      current?.retiredStageUsage ?? [],
      incoming.retiredStageUsage,
    ),
    stageEvidence: mergeImmutableHistory(
      'stageEvidence',
      current?.stageEvidence ?? [],
      incoming.stageEvidence,
    ),
  };
}

function historiesFromState(state: StoreState): RunHistories {
  return {
    retiredStageUsage: state.retiredStageUsage ?? [],
    stageEvidence: state.stageEvidence ?? [],
  };
}

function normalizeHistoryTail(path: string, committedBytes: number): void {
  if (!existsSync(path)) {
    if (committedBytes > 0) throw new Error(`Acknowledged run history is missing: ${path}`);
    return;
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const size = fstatSync(fd).size;
    if (size < committedBytes) {
      throw new Error(`Run history is truncated: ${path} has ${size} bytes; run.json acknowledges ${committedBytes}`);
    }
    if (size > committedBytes) {
      // Bytes beyond the projection's commit pointer came from a crashed,
      // unacknowledged write. Removing only that tail cannot erase an
      // acknowledged record and makes the next append transactionally clean.
      ftruncateSync(fd, committedBytes);
      fsyncSync(fd);
    }
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
  }
}

function appendHistoryDelta(
  path: string,
  committed: RunHistories,
  desired: RunHistories,
  committedBytes: number,
): number {
  const records: RunHistoryRecord[] = [];
  for (const kind of ['retiredStageUsage', 'stageEvidence'] as const) {
    for (let index = 0; index < desired[kind].length; index += 1) {
      if (index >= committed[kind].length || !isJsonPersistedEqual(committed[kind][index], desired[kind][index])) {
        records.push({ kind, index, value: desired[kind][index] });
      }
    }
  }
  if (records.length === 0) return committedBytes;

  const existed = existsSync(path);
  const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8');
  let fd: number | undefined;
  try {
    fd = openSync(path, 'a');
    if (fstatSync(fd).size !== committedBytes) throw new Error(`Run history append offset changed for ${path}`);
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error(`Run history append made no progress for ${path}`);
      written += count;
    }
    fsyncSync(fd);
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
  }
  if (!existed) {
    let parent: number | undefined;
    try {
      parent = openSync(dirname(path), 'r');
      fsyncSync(parent);
    } finally {
      try { if (parent !== undefined) closeSync(parent); } catch { /* best effort */ }
    }
  }
  return committedBytes + bytes.length;
}

function compactProjection(state: StoreState, ref: RunHistoryRef | undefined, revision: number): StoreState {
  const projection: StoreState = { ...state };
  delete projection.retiredStageUsage;
  delete projection.stageEvidence;
  projection.stateFormat = {
    version: 2,
    revision,
    ...(ref ? { history: ref } : {}),
  };
  return projection;
}

function copyPersistedHistoryState(target: StoreState, source: StoreState): void {
  target.stateFormat = source.stateFormat;
  target.retiredStageUsage = source.retiredStageUsage;
  target.stageEvidence = source.stageEvidence;
}

function persistRunStateUnlocked(
  projectDir: string,
  runId: string,
  state: StoreState,
  expectation?: RunStateProjectionExpectation,
  runPath = runDir(projectDir, runId),
): void {
  const runJsonPath = join(runPath, 'run.json');
  const publishesToSelectedStore = canonicalRunDirectory(runPath)
    === canonicalRunDirectory(runDir(projectDir, runId));
  state.status = requireKnownRunStatus(state.status, `write run state ${runId}`);
  if (state.runId !== runId) throw new Error(`Run state id ${state.runId} does not match target ${runId}`);

  let currentProjection: ArchivedStoreState | undefined;
  let currentState: StoreState | undefined;
  let currentRaw: string | undefined;
  if (existsSync(runJsonPath)) {
    let parsed: ArchivedStoreState | undefined;
    try {
      currentRaw = readFileSync(runJsonPath, 'utf-8');
      parsed = JSON.parse(currentRaw) as ArchivedStoreState;
    } catch { /* malformed legacy state may be replaced */ }
    if (parsed) {
      const currentStatus = resolveRunStatus(parsed.status);
      if (currentStatus.kind === 'unknown') {
        throw new UnknownRunStatusError(
          parsed.status,
          `overwrite archived run ${runId}; update the tool or migrate the archive explicitly`,
        );
      }
      currentProjection = parsed;
      currentState = hydrateRunProjection(runPath, structuredClone(parsed)) as StoreState;
    }
  }
  if (expectation && currentRaw !== expectation.raw) {
    throw new RunStateProjectionConflictError(`Run state changed before mutation commit for ${runId}`);
  }
  if (currentState?.status === RUN_STATUS.CANCELLED) {
    if (isJsonPersistedEqual(currentState, state)) {
      copyPersistedHistoryState(state, currentState);
      observeRunStatusChange(runPath, runId, state.status);
      return;
    }
    // A fresh locked transition can continue admitted work. Compatibility
    // snapshots and stage publishers cannot resurrect acknowledged cancellation.
    // Explicit continuation uses the fresh locked stopped -> running transition.
    if (!expectation || state.status !== 'running') throw cancelledRunPublicationError(runId);
  }

  const currentRef = currentProjection?.stateFormat ? historyRef(currentProjection.stateFormat) : undefined;
  const historyPath = currentRef?.path ?? RUN_HISTORY_FILE;
  const committedBytes = currentRef?.committedBytes ?? 0;
  normalizeHistoryTail(join(runPath, historyPath), committedBytes);
  const committedHistories = readRunHistories(runPath, currentRef);
  const merged = mergeStateHistories(currentState, state);
  // Compatibility snapshot writers cannot drop admissions published by the
  // scheduler. Admission appends itself under this same run-local lock.
  merged.engineHistory = [...new Map([...(currentState?.engineHistory ?? []), ...(merged.engineHistory ?? [])]
    .map(entry => [JSON.stringify(entry), entry])).values()];
  // Command ownership is append-only within one checkpoint. Compatibility
  // writers may carry an older snapshot while another stage starts a child.
  if (currentState?.engineCheckpoint?.at === merged.engineCheckpoint?.at && currentState?.engineCheckpoint?.pid === merged.engineCheckpoint?.pid && merged.engineCheckpoint?.processes) {
    merged.engineCheckpoint.processes = [...new Map([
      ...merged.engineCheckpoint.processes, ...(currentState?.engineCheckpoint?.processes ?? []),
    ].map(group => [JSON.stringify(group), group])).values()];
  }
  const desiredHistories = historiesFromState(merged);
  const nextCommittedBytes = appendHistoryDelta(
    join(runPath, historyPath),
    committedHistories,
    desiredHistories,
    committedBytes,
  );
  const counts: RunHistoryRef['counts'] = {
    retiredStageUsage: desiredHistories.retiredStageUsage.length,
    stageEvidence: desiredHistories.stageEvidence.length,
  };
  const hasHistory = nextCommittedBytes > 0 || Object.values(counts).some((count) => count > 0);
  const ref: RunHistoryRef | undefined = hasHistory
    ? { version: 1, path: historyPath, committedBytes: nextCommittedBytes, counts }
    : undefined;
  const currentRevision = currentProjection?.stateFormat?.version === 2
    ? currentProjection.stateFormat.revision
    : 0;
  const comparable = compactProjection(merged, ref, currentRevision);

  const assertProjectionUnchanged = (): void => {
    let latestRaw: string | undefined;
    try { latestRaw = readFileSync(runJsonPath, 'utf-8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (latestRaw !== currentRaw) {
      throw new RunStateProjectionConflictError(`Run state changed during mutation commit for ${runId}`);
    }
  };

  if (currentProjection && isJsonPersistedEqual(currentProjection, comparable)) {
    assertProjectionUnchanged();
    copyPersistedHistoryState(state, { ...merged, stateFormat: comparable.stateFormat });
    observeRunStatusChange(runPath, runId, comparable.status);
    if (publishesToSelectedStore) {
      try { upsertRunIndex(projectDir, comparable); } catch { /* index is best-effort */ }
      emitCampaignEnvelopeEvents(projectDir, runId, merged);
    }
    return;
  }

  // Project the selected legacy ledger on its first v2 write, including the
  // metadata-only writes that precede resumed execution.
  if (currentProjection && !currentProjection.stateFormat) for (const [id, stage] of Object.entries(merged.stages)) {
    const directory = join(runPath, 'stages', id);
    mkdirSync(directory, { recursive: true });
    const statusPath = join(directory, 'status.json');
    if (existsSync(statusPath)) {
      const ledger = JSON.parse(readFileSync(statusPath, 'utf8')) as StageStatus;
      // Keep execution evidence absent from the selected legacy projection;
      // run.json still selects the current stage status and matching attempt rows.
      if (ledger.attempts?.length) stage.attempts = [...new Map([
        ...ledger.attempts, ...(stage.attempts ?? []).map(attempt => ({
          ...ledger.attempts?.find(previous => previous.index === attempt.index), ...attempt,
        })),
      ].map(attempt => [attempt.index, attempt])).values()].sort((a, b) => a.index - b.index);
    }
    atomicWrite(statusPath, JSON.stringify(stage, null, 2));
  }
  const projection = compactProjection(merged, ref, currentRevision + 1);
  publishRunProjection(projectDir, runPath, projection, merged, assertProjectionUnchanged);
  copyPersistedHistoryState(state, { ...merged, stateFormat: projection.stateFormat });
}

/** Both history and operational writers share the terminal commit boundary. */
function publishRunProjection(projectDir: string, runPath: string, projection: StoreState, summaryState: StoreState, assertProjectionUnchanged: () => void): void {
  assertProjectionUnchanged();
  // Terminal status is the commit record for the final reader artifacts.
  // A failed artifact write leaves the previous status observable.
  if (isTerminalRunStatus(projection.status)) {
    const summary = renderRunSummary(projectDir, runPath, summaryState);
    atomicWrite(join(runPath, 'summary.md'), summary);
    assertProjectionUnchanged();
  }

  atomicWrite(join(runPath, 'run.json'), JSON.stringify(projection) + '\n');
  observeRunStatusChange(runPath, projection.runId, projection.status);
  if (isTerminalRunStatus(projection.status)) {
    retireRunScratch(runPath);
  }
  if (canonicalRunDirectory(runPath) === canonicalRunDirectory(runDir(projectDir, projection.runId))) {
    try { upsertRunIndex(projectDir, projection); } catch { /* index is best-effort */ }
    emitCampaignEnvelopeEvents(projectDir, projection.runId, summaryState);
  }
}

export function readArchivedRunState(projectDir: string, runId: string): ArchivedRunStateRead {
  return readArchivedRunStateFromDirectory(runDir(projectDir, runId));
}

/** Read the exact run context without selecting or changing a global store. */
export function readArchivedRunStateFromDirectory(path: string): ArchivedRunStateRead {
  const parsed = hydrateRunProjection(path, JSON.parse(
    readFileSync(join(path, 'run.json'), 'utf-8'),
  ) as ArchivedStoreState);
  return { state: parsed, status: resolveRunStatus(parsed?.status) };
}

/**
 * Read only the compact operational projection in run.json. Timer/watch
 * callbacks whose decisions use projected fields must use this path so their
 * cost is independent of the append-only history size. The history reference
 * is still validated fail-closed, but its acknowledged bytes are deliberately
 * not read or hydrated.
 */
export function readOperationalRunState(projectDir: string, runId: string): StoreState {
  const path = runDir(projectDir, runId);
  const parsed = JSON.parse(readFileSync(join(path, 'run.json'), 'utf-8')) as ArchivedStoreState;
  if (parsed.workflowName === 'default') parsed.workflowName = 'planner';
  parsed.status = requireKnownRunStatus(parsed.status, `read operational run state ${runId}`);
  if (parsed.runId !== runId) {
    throw new Error(`Run state id ${String(parsed.runId)} does not match target ${runId}`);
  }
  if (parsed.stateFormat) historyRef(parsed.stateFormat);
  return parsed as StoreState;
}

/**
 * Typed compatibility reader for engine-owned runs. Archive-facing and
 * consequential callers should use readArchivedRunState/resolveRunStatus.
 * This cast does not coerce at runtime: unknown raw text remains intact.
 */
export function readRunState(projectDir: string, runId: string): StoreState {
  return readArchivedRunState(projectDir, runId).state as StoreState;
}

export function writeRunState(projectDir: string, runId: string, state: StoreState): void {
  const identity = resolveRunIdentity(runDir(projectDir, runId), runsRoot(projectDir));
  withRunStateLock(identity.directory, () => persistRunStateUnlocked(projectDir, identity.runId, state, undefined, identity.directory));
}

export function updateRunState(projectDir: string, runId: string, mutator: (state: StoreState) => void, afterCommit?: (state: StoreState) => void): StoreState {
  const identity = resolveRunIdentity(runDir(projectDir, runId), runsRoot(projectDir));
  return updateRunStateInDirectory(projectDir, identity.runId, identity.directory, mutator, afterCommit);
}

/** Mutate control state without requiring historical evidence. History bytes,
 * references and inline records remain untouched, even when evidence is lost. */
export function updateOperationalRunStateAtPath(directory: string, mutator: (state: StoreState) => void): StoreState {
  return updateOperationalRunState(directory, mutator);
}

/** Cancellation publishes matching changed stage ledgers under the run lock.
 * Preserve pre-existing disagreements; ordinary writers retain the cancelled fence. */
export function updateOperationalRunState(directory: string, mutator: (state: StoreState) => void, interruption?: 'cancellation', afterCommit?: () => void): StoreState {
  const identity = resolveRunIdentity(directory);
  if (!identity.projectDir) throw new Error('RUN_IDENTITY_BINDING: run has no project directory');
  return withRunStateLock(identity.directory, () => {
    const path = join(identity.directory, 'run.json');
    const raw = readFileSync(path, 'utf8');
    const previous = JSON.parse(raw) as StoreState;
    const status = resolveRunStatus(previous.status);
    if (status.kind === 'known') previous.status = status.status;
    const state = structuredClone(previous);
    mutator(state);
    if (state.runId !== identity.runId || state.projectDir !== identity.projectDir) throw new Error('RUN_IDENTITY_BINDING: operational mutation changed run identity');
    if (!isJsonPersistedEqual(previous.stateFormat, state.stateFormat)
        || !isJsonPersistedEqual(historiesFromState(previous), historiesFromState(state))) {
      throw new Error('Operational mutation cannot change run history');
    }
    if (isJsonPersistedEqual(previous, state)) {
      observeRunStatusChange(identity.directory, identity.runId, state.status);
      return state;
    }
    requireKnownRunStatus(state.status, `write operational run state ${identity.runId}`);
    if (previous.status === RUN_STATUS.CANCELLED && !interruption) throw cancelledRunPublicationError(identity.runId);
    if (interruption) for (const [id, status] of Object.entries(state.stages)) {
      if (isJsonPersistedEqual(previous.stages[id], status)) continue;
      const stagePath = join(identity.directory, 'stages', id);
      let ledger: unknown;
      try { ledger = JSON.parse(readFileSync(join(stagePath, 'status.json'), 'utf8')); }
      catch { continue; } // Missing or unreadable evidence cannot authorize a ledger write.
      if (!isJsonPersistedEqual(previous.stages[id], ledger)) continue;
      mkdirSync(stagePath, { recursive: true });
      atomicWrite(join(stagePath, 'status.json'), JSON.stringify(status, null, 2));
    }
    if (state.stateFormat) state.stateFormat.revision += 1;
    publishRunProjection(identity.projectDir, identity.directory, state, state, () => {
      if (readFileSync(path, 'utf8') !== raw) throw new RunStateProjectionConflictError(`Run state changed during operational mutation for ${identity.runId}`);
    });
    afterCommit?.();
    return state;
  });
}

/** Close exactly the current interrupted execution without inventing another attempt. */
export function interruptedStageStatus(previous: StageStatus, completedAt: string, error: string, terminationCause: 'cancelled' | 'host_restart' = 'cancelled'): StageStatus {
  const attempt = previous.attempts?.at(-1);
  if (attempt?.status === 'closed') return settledStageAttemptStatus(previous, attempt.index, false, { exitCode: 143, error, terminationCause });
  if (attempt?.status === 'running') return completedStageAttemptStatus(previous, previous.retries, {
    // Sampled calls are a lower bound: interruption supplies no final usage.
    ...sumInvocationUsage([{ ...attempt, tokenUsage: 'unknown', costUsage: 'unknown' }]),
    terminationCause, exitCode: 143, completedAt, duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(attempt.startedAt)), error,
  });
  return previous.status === STAGE_STATUS.RUNNING ? { ...previous, status: STAGE_STATUS.FAILED } : previous;
}

function updateRunStateInDirectory(projectDir: string, runId: string, runPath: string, mutator: (state: StoreState) => void, afterCommit?: (state: StoreState) => void): StoreState {
  // Serialize read/mutate/commit under the run-local lock. This closes the old
  // mtime check-to-rename race while retaining a byte-exact CAS for a legacy
  // writer that does not yet participate in the lock.
  return withRunStateLock(runPath, () => {
    const runJsonPath = join(runPath, 'run.json');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const raw = readFileSync(runJsonPath, 'utf-8');
      const state = hydrateRunProjection(runPath, JSON.parse(raw) as ArchivedStoreState) as StoreState;
      mutator(state);
      try {
        persistRunStateUnlocked(projectDir, runId, state, { raw }, runPath);
        // Opt-in recovery notification stays ordered before cancellation's
        // acknowledgement. This callback must not re-enter the run-state lock.
        afterCommit?.(state);
        return state;
      } catch (error) {
        if (!(error instanceof RunStateProjectionConflictError)) throw error;
      }
    }
    throw new RunStateProjectionConflictError(`Run state changed during five mutation attempts for ${runId}`);
  });
}

/** Project only pre-cause records; typed outcomes are never reclassified from prose. */
function projectAttemptCauses(status: StageStatus): StageStatus {
  if (!Array.isArray(status?.attempts)) return status;
  for (const attempt of status.attempts ?? []) {
    if (attempt.terminationCause !== undefined || attempt.status === 'running') continue;
    const legacy = attempt.timeout?.terminationCause;
    // A legacy restart marker requires intent even when an old nested cause
    // disagrees. Neither legacy field authenticates an interruption.
    const cause = attempt.error?.startsWith('HOST_RESTART_INTERRUPTED:') ? 'host_restart'
      : legacy ? (legacy === 'attempt_timeout' || legacy === 'stage_abort' ? legacy : 'exit')
        : attempt.exitCode === 143 ? 'cancelled'
        : attempt.exitCode === 124 || attempt.error?.startsWith('timed out after') ? 'attempt_timeout'
        : attempt.exitCode === 137 ? 'stage_abort'
        : attempt.engineVoid ? 'engine_void' : undefined;
    // Ordinary old outcomes need no new field: a no-op publication must retain
    // their original bytes rather than materializing a default exit cause.
    if (cause !== undefined) attempt.terminationCause = cause;
  }
  return status;
}

export function readStageStatus(projectDir: string, runId: string, stageId: string): StageStatus {
  return projectAttemptCauses(JSON.parse(
    readFileSync(join(stageDir(projectDir, runId, stageId), 'status.json'), 'utf-8'),
  ));
}

/** The newest running execution in the ledger, shared by scope authority and
 * supervision. Historical incomplete rows retain their established meaning. */
export function runningStageAttempt(status: StageStatus | undefined): StageAttempt | undefined {
  return [...(status?.attempts ?? [])].reverse().find(attempt => attempt.status === STAGE_STATUS.RUNNING);
}

export function writeStageStatus(
  projectDir: string,
  runId: string,
  stageId: string,
  status: StageStatus,
): void {
  // The per-stage file is the execution ledger, while run.json is the public
  // aggregate consumed by the dashboard and campaign views. Keep the current
  // attempt visible there immediately instead of waiting for the parent
  // scheduler to finish the attempt. updateRunState re-applies this narrow
  // mutation if a parallel stage updates run.json at the same time.
  const identity = resolveRunIdentity(runDir(projectDir, runId), runsRoot(projectDir));
  const dir = join(identity.directory, 'stages', stageId);
  const runJsonPath = join(identity.directory, 'run.json');
  if (existsSync(runJsonPath)) {
    updateRunState(projectDir, identity.runId, (state) => {
      if (state.status === RUN_STATUS.CANCELLED) throw cancelledRunPublicationError(identity.runId);
      mkdirSync(dir, { recursive: true });
      atomicWrite(join(dir, 'status.json'), JSON.stringify(status, null, 2));
      state.stages[stageId] = status;
    });
  } else {
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, 'status.json'), JSON.stringify(status, null, 2));
  }
}

/** Opt-in publication for recovery: validate fresh authority and write the
 * execution ledger and aggregate while holding cancellation's run-local lock.
 * Returning undefined preserves a lifecycle that superseded recovery. A crash
 * between the two files remains repairable from the attempt-bound intent. */
export function updateStageStatusUnderRunLock(
  projectDir: string,
  runId: string,
  stageId: string,
  mutator: (state: StoreState, ledger: StageStatus) => StageStatus | undefined,
): StoreState {
  const identity = resolveRunIdentity(runDir(projectDir, runId), runsRoot(projectDir));
  runId = identity.runId;
  return withRunStateLock(identity.directory, () => {
    const directory = identity.directory;
    const raw = readFileSync(join(directory, 'run.json'), 'utf8');
    const state = hydrateRunProjection(directory, JSON.parse(raw) as ArchivedStoreState) as StoreState;
    const status = mutator(state, readStageStatus(projectDir, runId, stageId));
    if (status === undefined) return state;
    if (state.status === RUN_STATUS.CANCELLED) throw cancelledRunPublicationError(runId);
    atomicWrite(join(stageDir(projectDir, runId, stageId), 'status.json'), JSON.stringify(status, null, 2));
    state.stages[stageId] = status;
    persistRunStateUnlocked(projectDir, runId, state, { raw }, directory);
    return state;
  });
}

function readStageStatusIfPresent(projectDir: string, runId: string, stageId: string): StageStatus | undefined {
  try { return readStageStatus(projectDir, runId, stageId); } catch { return undefined; }
}

function sumAttemptField(attempts: StageAttempt[], key: 'duration_ms' | 'tokens_in' | 'tokens_out'): number | undefined {
  const values = attempts
    .map((attempt) => attempt[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function uniqueStrings(...groups: Array<string[] | undefined>): string[] | undefined {
  const values = [...new Set(groups.flatMap((group) => group ?? []).filter(Boolean))];
  return values.length > 0 ? values : undefined;
}

/**
 * Append a new running attempt without discarding any prior execution. The
 * returned top-level timestamps keep their compatibility meaning:
 * `startedAt` is the first attempt start and `completedAt` is the latest
 * completed attempt (if one exists while the new attempt is running).
 */
export function beginStageAttempt(
  projectDir: string,
  runId: string,
  stageId: string,
  retries: number,
  startedAt = new Date().toISOString(),
  attribution?: AttemptAttribution,
): StageStatus {
  const previous = readStageStatusIfPresent(projectDir, runId, stageId);
  const attempts = [...(previous?.attempts ?? [])];
  const prior = attempts.at(-1);
  if (prior?.status === STAGE_STATUS.COMPLETE && (prior.disposition === undefined || prior.disposition === 'accepted' || prior.disposition === 'repaired')) {
    attempts[attempts.length - 1] = { ...prior, disposition: 'superseded' };
  }
  const nextIndex = attempts.reduce((max, attempt) => Math.max(max, attempt.index), 0) + 1;
  attempts.push({ index: nextIndex, startedAt, status: 'running', ...attribution });
  const running: StageStatus = {
    ...previous,
    gate: undefined,
    status: STAGE_STATUS.RUNNING,
    retries,
    attempts,
    reruns: Math.max(0, attempts.length - 1),
    startedAt: attempts[0]?.startedAt ?? startedAt,
  };
  // Publish the empty stream before its attempt becomes current, so followers
  // cannot briefly mistake an older build's legacy log for this execution.
  const liveLog = stageLiveLogPath(runDir(projectDir, runId), stageId, nextIndex, startedAt);
  mkdirSync(dirname(liveLog), { recursive: true });
  appendFileSync(liveLog, '');
  writeStageStatus(projectDir, runId, stageId, running);
  return running;
}

export interface CompleteStageAttemptInput extends InvocationUsage {
  attribution?: AttemptAttribution;
  disposition?: AttemptDisposition;
  invocations?: NativeInvocationUsage[];
  exitCode: number;
  /** Real control-boundary suspension, never a verification placeholder. */
  suspended?: boolean;
  processExitCode?: number | null;
  processSignal?: NodeJS.Signals | null;
  providerFailure?: ProviderFailure;
  duration_ms: number;
  completedAt?: string;
  artifacts?: string[];
  error?: string;
  terminationCause?: AttemptTerminationCause;
  engineVoid?: boolean;
  adapterFailureKind?: AdapterFailureKind;
  tokens_in?: number;
  tokens_out?: number;
  writes?: string[];
  writeAttribution?: WriteAttribution;
  validationGeneratedWrites?: string[];
  constraintAudit?: StageConstraintAuditSummary;
  timeout?: StageAttemptTimeoutSummary;
  continuation?: StageContinuation;
}

/** Complete only the current attempt, then rebuild compatibility aggregates. */
export function completeStageAttempt(
  projectDir: string,
  runId: string,
  stageId: string,
  retries: number,
  completion: CompleteStageAttemptInput,
): StageStatus {
  const previous = readStageStatusIfPresent(projectDir, runId, stageId);
  const final = completedStageAttemptStatus(previous, retries, completion);
  writeStageStatus(projectDir, runId, stageId, final);
  return final;
}

/** Pure completion calculation, shared with lock-serialized recovery. */
export function completedStageAttemptStatus(
  previous: StageStatus | undefined,
  retries: number,
  completion: CompleteStageAttemptInput,
): StageStatus {
  const completedAt = completion.completedAt ?? new Date().toISOString();
  const attempts = [...(previous?.attempts ?? [])];
  let currentIndex = attempts.length - 1;
  if (currentIndex < 0 || attempts[currentIndex].status !== 'running') {
    const startedAt = previous?.startedAt ?? completedAt;
    const nextIndex = attempts.reduce((max, attempt) => Math.max(max, attempt.index), 0) + 1;
    attempts.push({ index: nextIndex, startedAt, status: 'running', ...completion.attribution });
    currentIndex = attempts.length - 1;
  }
  const current = attempts[currentIndex];
  attempts[currentIndex] = {
    ...current,
    ...(completion.disposition ? { disposition: completion.disposition } : {}),
    completedAt,
    status: completion.suspended ? 'suspended' : completion.exitCode === 0 ? 'complete' : 'failed',
    duration_ms: completion.duration_ms,
    exitCode: completion.exitCode,
    processExitCode: completion.processExitCode,
    processSignal: completion.processSignal,
    providerFailure: completion.providerFailure,
    ...invocationUsageFields(completion),
    tokenUsage: completion.tokenUsage ?? current.tokenUsage ?? (tokensComplete(completion) ? 'known' : 'unknown'),
    invocations: completion.invocations ?? current.invocations,
    error: completion.error,
    terminationCause: completion.terminationCause ?? 'exit',
    engineVoid: completion.engineVoid,
    adapterFailureKind: completion.adapterFailureKind,
    writes: completion.writes,
    writeAttribution: completion.writeAttribution,
    validationGeneratedWrites: completion.validationGeneratedWrites,
    constraintAudit: completion.constraintAudit,
    timeout: completion.timeout,
    continuation: completion.continuation,
  };
  const writes = uniqueStrings(previous?.writes, completion.writes);
  const usage = sumInvocationUsage(attempts);
  const final: StageStatus = {
    status: completion.suspended ? STAGE_STATUS.PENDING : completion.exitCode === 0 ? STAGE_STATUS.COMPLETE : STAGE_STATUS.FAILED,
    exitCode: completion.exitCode,
    processExitCode: completion.processExitCode,
    processSignal: completion.processSignal,
    providerFailure: completion.providerFailure,
    duration_ms: sumAttemptField(attempts, 'duration_ms'),
    artifacts: uniqueStrings(previous?.artifacts, completion.artifacts),
    retries,
    startedAt: attempts[0]?.startedAt,
    completedAt: completion.suspended ? undefined : completedAt,
    error: completion.suspended ? undefined : completion.error,
    tokens_in: sumAttemptField(attempts, 'tokens_in'),
    tokens_out: sumAttemptField(attempts, 'tokens_out'),
    tokens_cached: usage.tokens_cached,
    tokens_cache_created: usage.tokens_cache_created,
    tokens_reasoning: usage.tokens_reasoning,
    cost_usd: usage.cost_usd,
    costUsage: usage.costUsage,
    attempts,
    reruns: Math.max(0, attempts.length - 1),
    writes,
    writeAttribution: completion.writeAttribution ?? previous?.writeAttribution,
    validationGeneratedWrites: uniqueStrings(
      previous?.validationGeneratedWrites,
      completion.validationGeneratedWrites,
    ),
    constraintAudit: completion.constraintAudit ?? previous?.constraintAudit,
    timeout: completion.timeout ?? previous?.timeout,
    continuation: completion.continuation,
  };
  return final;
}

/** A classified worker refusal carries its exact ledger identity through scheduler catches. */
export class StageAttemptSettlementError extends Error {
  constructor(readonly stageId: string, readonly attemptIndex: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'StageAttemptSettlementError';
  }
}

/** Persist adapter closure without releasing dependencies or making work runnable. */
export function closeStageAttempt(
  projectDir: string, runId: string, stageId: string, attemptIndex: number,
  completion: CompleteStageAttemptInput,
): StageStatus {
  const previous = readStageStatus(projectDir, runId, stageId);
  const active = previous.attempts?.at(-1);
  if (active?.index !== attemptIndex || active.status !== 'running') throw new Error(`Cannot close attempt ${attemptIndex}: execution identity changed`);
  const status = completedStageAttemptStatus(previous, previous.retries, completion);
  status.attempts!.at(-1)!.status = 'closed';
  status.status = STAGE_STATUS.RUNNING;
  status.completedAt = undefined;
  status.error = undefined;
  writeStageStatus(projectDir, runId, stageId, status);
  return status;
}

/** One owner projects a closed execution's final classification onto its stage. */
export function settledStageAttemptStatus(
  previous: StageStatus, attemptIndex: number, suspended = false,
  failure?: { exitCode: number; error: string; terminationCause?: AttemptTerminationCause },
): StageStatus {
  const attempts = (previous.attempts ?? []).map(attempt => ({ ...attempt }));
  const attempt = attempts.at(-1);
  if (!attempt || attempt.index !== attemptIndex || attempt.status === 'running') {
    throw new Error(`Cannot settle attempt ${attemptIndex}: current execution is not the matching closed child`);
  }
  if (failure) Object.assign(attempt, failure, { terminationCause: failure.terminationCause ?? 'exit' });
  if (attempt.exitCode !== 0) delete attempt.continuation;
  // Reconciliation can already have refused or suspended this exact execution.
  attempt.status = attempt.exitCode !== 0 ? 'failed'
    : suspended || attempt.status === 'suspended' ? 'suspended' : 'complete';
  return {
    ...previous, attempts,
    continuation: attempt.continuation,
    status: attempt.status === 'suspended' ? STAGE_STATUS.PENDING : attempt.status,
    exitCode: attempt.status === 'suspended' ? undefined : attempt.exitCode,
    completedAt: attempt.status === 'suspended' ? undefined : attempt.completedAt,
    error: attempt.status === 'suspended' ? undefined : attempt.error,
  };
}

export function settleStageAttempt(
  projectDir: string, runId: string, stageId: string, attemptIndex: number,
  suspended = false, failure?: { exitCode: number; error: string; terminationCause?: AttemptTerminationCause },
): StageStatus {
  const status = settledStageAttemptStatus(readStageStatus(projectDir, runId, stageId), attemptIndex, suspended, failure);
  writeStageStatus(projectDir, runId, stageId, status);
  return status;
}

/** Attach scheduler-owned scope reconciliation after the worker has settled an attempt. */
export function attachStageConstraintAudit(
  projectDir: string,
  runId: string,
  stageId: string,
  attemptIndex: number,
  audit: StageConstraintAuditSummary,
  violationError?: string,
): StageStatus {
  const status = readStageStatus(projectDir, runId, stageId);
  const attempts = [...(status.attempts ?? [])];
  const index = attempts.findIndex((attempt) => attempt.index === attemptIndex);
  if (index < 0) throw new Error(`Cannot attach constraint audit: stage ${stageId} attempt ${attemptIndex} does not exist`);
  attempts[index] = {
    ...attempts[index],
    constraintAudit: audit,
    ...(violationError ? { status: 'failed', exitCode: 1, error: violationError, continuation: undefined } : {}),
  };
  const updated: StageStatus = {
    ...status,
    attempts,
    constraintAudit: audit,
    ...(violationError ? {
      status: STAGE_STATUS.FAILED,
      exitCode: 1,
      error: violationError,
      continuation: undefined,
    } : {}),
  };
  writeStageStatus(projectDir, runId, stageId, updated);
  return updated;
}

function stageEvidenceArchiveRoot(iteration: number, stageId: string): {
  relativePath: string;
  directoryName: string;
} {
  if (!Number.isSafeInteger(iteration) || iteration < 1) {
    throw new Error(`Stage evidence iteration must be a positive integer, got ${iteration}`);
  }
  const directoryName = Buffer.from(stageId, 'utf-8').toString('base64url') || '_';
  return {
    relativePath: join('stage_evidence', `iteration_${iteration}`, directoryName),
    directoryName,
  };
}

function materializeImmutableStageEvidenceFile(source: string, destination: string): boolean {
  if (existsSync(destination)) return true;
  if (!existsSync(source)) return false;
  atomicWrite(destination, readFileSync(source, 'utf-8'));
  return true;
}

/**
 * Materialize the files referenced by one retired-stage record before that
 * record is made reachable from the next atomic run.json write. Existing
 * archive files are never overwritten, making retries after an interrupted
 * boundary idempotent.
 */
export function captureStageEvidence(
  projectDir: string,
  runId: string,
  iteration: number,
  stageId: string,
  status: StageStatus,
): StageEvidenceRecord {
  const runDirPath = runDir(projectDir, runId);
  const liveStageDir = stageDir(projectDir, runId, stageId);
  const archive = stageEvidenceArchiveRoot(iteration, stageId);
  const archiveDir = join(runDirPath, archive.relativePath);
  mkdirSync(archiveDir, { recursive: true });

  const statusPath = join(archive.relativePath, 'status.json');
  const absoluteStatusPath = join(runDirPath, statusPath);
  if (!existsSync(absoluteStatusPath)) {
    atomicWrite(absoluteStatusPath, `${JSON.stringify(status, null, 2)}\n`);
  }
  const persistedStatus = JSON.parse(readFileSync(absoluteStatusPath, 'utf-8')) as StageStatus;

  const outputPath = join(archive.relativePath, 'output.md');
  const hasOutput = materializeImmutableStageEvidenceFile(
    join(liveStageDir, 'output.md'),
    join(runDirPath, outputPath),
  );

  const attemptOutputPaths: Array<{ attemptIndex: number; path: string }> = [];
  for (const attempt of persistedStatus.attempts ?? []) {
    const filename = `output_attempt_${attempt.index}.md`;
    const path = join(archive.relativePath, filename);
    if (materializeImmutableStageEvidenceFile(join(liveStageDir, filename), join(runDirPath, path))) {
      attemptOutputPaths.push({ attemptIndex: attempt.index, path });
    }
  }

  const verdictPath = join(archive.relativePath, 'verdict.json');
  const hasVerdict = materializeImmutableStageEvidenceFile(
    join(runDirPath, `verdict_${stageId}.json`),
    join(runDirPath, verdictPath),
  );

  return {
    stageId,
    iteration,
    status: persistedStatus,
    statusPath,
    ...(hasOutput ? { outputPath } : {}),
    attemptOutputPaths,
    ...(hasVerdict ? { verdictPath } : {}),
  };
}

/**
 * Start a later same-ID stage with live aliases that describe only the new DAG.
 * The previous aliases are removed only after captureStageEvidence has created
 * immutable iteration-qualified copies.
 */
export function resetStageLiveAttemptAliases(
  projectDir: string,
  runId: string,
  stageId: string,
  status: StageStatus,
): void {
  const dir = stageDir(projectDir, runId, stageId);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'status.json'), JSON.stringify(status, null, 2));
  for (const filename of readdirSync(dir)) {
    if (filename === 'output.md' || /^output_attempt_\d+\.md$/.test(filename)) {
      try { unlinkSync(join(dir, filename)); } catch { /* already absent */ }
    }
  }
}

/** Re-pend a stage while retaining its immutable attempt ledger and aggregates. */
export function rependStageStatus(
  previous: StageStatus | undefined,
  retries = previous?.retries ?? 0,
  error = previous?.error,
): StageStatus {
  return {
    ...(previous ?? {}),
    status: STAGE_STATUS.PENDING,
    retries,
    error,
    gate: undefined,
    acceptedFrom: undefined,
    continuation: undefined,
  };
}

/**
 * Convert one settled execution into a durable control-boundary suspension.
 * The attempt remains in history, while the stage becomes runnable again and
 * cannot release downstream dependencies.
 */
export function suspendStageAttempt(
  projectDir: string,
  runId: string,
  stageId: string,
  attemptIndex: number,
): StageStatus {
  const previous = readStageStatus(projectDir, runId, stageId);
  const attempts = [...(previous.attempts ?? [])];
  const index = attempts.findIndex((attempt) => attempt.index === attemptIndex);
  if (index < 0) throw new Error(`Cannot suspend stage ${stageId} attempt ${attemptIndex}: attempt not found`);
  attempts[index] = {
    ...attempts[index],
    status: 'suspended',
    completedAt: attempts[index].completedAt ?? new Date().toISOString(),
  };
  const suspended: StageStatus = {
    ...previous,
    status: STAGE_STATUS.PENDING,
    exitCode: undefined,
    completedAt: undefined,
    error: undefined,
    attempts,
  };
  writeStageStatus(projectDir, runId, stageId, suspended);
  return suspended;
}

/**
 * `output.md` keeps its meaning — the latest attempt's output — because eighteen readers
 * depend on it. What it could not do was preserve an earlier attempt: each attempt
 * overwrote it, so a retry told to "read your previous output" could be handed whatever
 * the most recent attempt left, and a successful attempt's output could be destroyed by a
 * later one that failed in two seconds. Observed: a stage whose second attempt passed
 * ended with a 125-byte `output.md` written by a third attempt that never ran.
 *
 * Passing `attemptIndex` also writes `output_attempt_<n>.md`, following the
 * `constraint_audit_attempt_<n>.json` convention already used in the same directory, so a
 * retry can be pointed at the attempt it actually needs to read.
 */
export function writeStageOutput(
  projectDir: string,
  runId: string,
  stageId: string,
  output: string,
  attemptIndex?: number,
): void {
  if (attemptIndex !== undefined && Number.isInteger(attemptIndex) && attemptIndex > 0) {
    atomicWrite(join(stageDir(projectDir, runId, stageId), `output_attempt_${attemptIndex}.md`), output);
  }
  atomicWrite(join(stageDir(projectDir, runId, stageId), 'output.md'), output);
}

export function readStageInput(projectDir: string, runId: string, stageId: string): string {
  try {
    return latestInvocationInput(runDir(projectDir, runId), stageId)?.record.userPrompt ?? '';
  } catch { /* expected - optional resource */
    return '';
  }
}

export function readStageOutput(projectDir: string, runId: string, stageId: string): string {
  try {
    return readFileSync(join(stageDir(projectDir, runId, stageId), 'output.md'), 'utf-8');
  } catch { /* expected - optional resource */
    return '';
  }
}

export function listRuns(projectDir: string): string[] {
  // Prefer the SQLite index: every writeRunState upserts into it, so it
  // stays as fresh as the filesystem for listing, and returns ids directly without
  // a ~9900-entry readdir + a per-entry existsSync(run.json) on every call.
  const indexed = listRunIdsFromIndex(projectDir);
  if (indexed && indexed.length > 0) return indexed;
  // Fallback: SQLite unavailable, or index genuinely empty — scan the filesystem.
  try {
    const root = runsRoot(projectDir);
    return readdirSync(root)
      .filter(d => existsSync(join(root, d, 'run.json')))
      .sort();
  } catch { /* expected - optional resource */
    return [];
  }
}
