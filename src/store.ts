import { appendFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync, statSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { listRunIdsFromIndex, upsertRunIndex } from './run-index.js';
import { parseChecksFromBrief, readRealityGateReport, runAllChecks } from './reality-gate/index.js';
import type { RealityGateExit, RealityGateReport } from './reality-gate/types.js';
import type { BriefAdmissionRecord } from './brief-preflight.js';
import type { ResearchFeasibilityConfig } from './research-feasibility.js';
import {
  UnknownRunStatusError,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  requireKnownRunStatus,
  resolveRunStatus,
  type RunStatus,
  type RunStatusResolution,
} from './lifecycle-status.js';
export {
  PAUSED_STATUSES,
  RUN_STATUS,
  RUN_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
  UnknownRunStatusError,
  isActiveRunStatus,
  isAwaitingApprovalRunStatus,
  isPausedRunStatus,
  isPendingRunStatus,
  isRunMutationBlockedStatus,
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
} from './lifecycle-status.js';

/** Stage execution is a separate state machine from the enclosing run. */
export const STAGE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;
export type StageState = typeof STAGE_STATUS[keyof typeof STAGE_STATUS];

export type StageAttemptState = 'running' | 'complete' | 'failed';
export type AttemptTokenUsage = 'known' | 'unknown';
export type WriteAttribution = 'structured' | 'snapshot' | 'unknown';

export interface StageAttemptTimeoutSummary {
  attemptId: string;
  budgetMs: number;
  attemptStartedAt: string;
  deadlineAt: string;
  elapsedMs: number;
  remainingMs: number;
  rejectedExtensionCount: number;
  decisionPaths: string[];
  mismatchPaths: string[];
  terminationCause?: 'complete' | 'supervisor_abort' | 'attempt_timeout' | 'adapter_error' | 'failed';
  deadlineReachedAt?: string;
  childClosedAt?: string;
  deadlineOverrunMs?: number;
}

export interface StageConstraintAuditSummary {
  path: string;
  declaredScope: string[] | null;
  effectiveScope: string[] | null;
  acceptedRevisionCount: number;
  rejectedRevisionCount: number;
  mismatchCount: number;
  violationCount: number;
  unverifiedCount: number;
  rawWriteCount?: number;
  appliedWriteCount?: number;
  rolledBackWriteCount?: number;
  rejectedDigestCount?: number;
}

export interface StageAttempt {
  index: number;
  startedAt: string;
  completedAt?: string;
  status: StageAttemptState;
  duration_ms?: number;
  exitCode?: number;
  tokens_in?: number;
  tokens_out?: number;
  /** Persisted evidence: both counters are known, or this settled attempt is explicitly unknown. */
  tokenUsage?: AttemptTokenUsage;
  error?: string;
  writes?: string[];
  writeAttribution?: WriteAttribution;
  /** Small summary plus path to the immutable attempt-level constraint audit. */
  constraintAudit?: StageConstraintAuditSummary;
  /** Attempt-local immutable deadline evidence. */
  timeout?: StageAttemptTimeoutSummary;
}

export interface StageStatus {
  status: StageState;
  exitCode?: number;
  duration_ms?: number;
  artifacts?: string[];
  retries: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
  kgChanged?: boolean;
  /** Append-only execution ledger. Top-level timing/token fields aggregate this array. */
  attempts?: StageAttempt[];
  /** Number of executions after the first; deliberately distinct from technical retries. */
  reruns?: number;
  /** Union of files attributed to this stage across its attempts. */
  writes?: string[];
  writeAttribution?: WriteAttribution;
  constraintAudit?: StageConstraintAuditSummary;
  timeout?: StageAttemptTimeoutSummary;
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
  scopePlanningDigests?: string[];
}

export interface SupervisorAttempt {
  index: number;
  startedAt: string;
  completedAt: string;
  status: 'complete' | 'failed';
  duration_ms: number;
  exitCode: number;
  tokens_in?: number;
  tokens_out?: number;
  /** Raw model output is retained for audit only and is never an effective action. */
  unverifiedAssessment?: {
    verdict: string;
    targetStage: string | null;
    reason: string;
  };
  /** Verdict and reason after supervisor-side fact validation and action guards. */
  verdict?: string;
  effectiveReason?: string;
  error?: string;
}

/** Supervisor usage is separate from stages so it cannot affect DAG completion semantics. */
export interface SupervisorUsage {
  status: 'running' | 'complete';
  calls: number;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  startedAt: string;
  completedAt?: string;
  attempts: SupervisorAttempt[];
}

export interface CampaignTriggers {
  enabled?: boolean;
  regressionAfter?: number;
  plateauAfter?: number;
  plateauThreshold?: number;
  repeatedFailureAfter?: number;
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
 * Multi-phase program config parsed from a task brief's `---` YAML frontmatter
 * `program:` block. Each phase of a research program is one FlowCrew run; this
 * block lets the scheduler enforce program-level safeguards (max phases, max
 * cumulative wall time, manual stop file) and auto-append the phase's outcome
 * to a findings ledger when the run terminates via phase_complete.
 *
 * When a phase terminates via phase_complete, the scheduler runs that state's
 * post_terminate_hook command if the brief declared one — passing FC_PROGRAM_*
 * env vars so the hook can advance the program (parse the verdict, generate the
 * next phase's brief, launch the next run). If no hook is declared, the run
 * simply terminates; there is no implicit default script.
 *
 * Backwards-compatible: briefs without a `program:` block behave exactly as
 * before. Only multi-phase programs need this.
 */
export interface ProgramSafeguards {
  /** Refuse to start if findings_ledger.json already has >= this many phase rows. */
  maxPhases?: number;
  /** Refuse to start if findings_ledger.json sum of wall_hours >= this. */
  maxWallHours?: number;
  /** Refuse to start if this file exists (project-relative path). */
  stopFile?: string;
  /** After N consecutive phases with no improvement, write program_ceiling_report and stop. */
  haltAfterConsecutiveNoImprovement?: number;
}
export interface ProgramConfig {
  name: string;
  phase: string;
  roadmap?: string;   // project-relative path to ROADMAP.md
  ledger?: string;    // project-relative path to findings_ledger.json
  safeguards?: ProgramSafeguards;
}

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
 *   - best_of_n: keep the single best direction (no stacking); stop after one round.
 *   - replace_if_better: replace the kept direction only if strictly better.
 */
export type ResearchPolicy = 'greedy_stack' | 'best_of_n' | 'replace_if_better';
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
 * those fields mean. Generic gates (no-op / variance / outlier) apply with sensible
 * defaults regardless.
 */
export interface ResearchIntegrityConfig {
  /** Reject a round whose result equals the baseline within tolerance (no-op/proxy). Default on. */
  noop?: boolean;
  /** Reject if result_std/|result| exceeds this (cross-run variance). Default 0.30 when result_std present. */
  maxStdRatio?: number;
  /** Reject if |result| is beyond this multiple of |baseline| in the improving direction (baseline≠0). Default 5. */
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
   * Project-relative dir where the framework writes ship/ceiling reports.
   * Default: docs/.
   */
  reportDir?: string;
  /**
   * OUTER-LOOP portfolio: the declared candidate direction labels a campaign must COVER before a
   * frontier verdict is accepted. The campaign loop forces each untested entry through one real
   * (gated) round BEFORE honoring any frontier — from either the proposer (null) or the policy
   * (stop_ceiling). This is the OUTER analogue of the inner loop's empirical floor: it stops the
   * LLM proposer from confabulating that an untested direction "failed" and frontier-ing early.
   * Engine-agnostic: these are opaque labels; their meaning lives in the brief.
   */
  directions?: string[];
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
  /** Shell command run before a `ship`; exit 0 confirms the candidate. */
  command: string;
  /** Optional human-readable assertion the command is expected to enforce (documentation only). */
  requires?: string;
  /** Optional timeout for the confirm command in seconds (default 300). */
  timeoutSeconds?: number;
}

/**
 * Single source of truth for campaign health trigger types (P4 of the Atom
 * Architecture). The interface fields below derive their type from this — no
 * duplicated string-literal unions. checkCampaignHealth() detects these.
 */
export const CAMPAIGN_TRIGGER_TYPES = [
  { id: 'regression', description: 'A new run scored materially worse than the campaign best — alert and inject a researcher.' },
  { id: 'plateau', description: 'No improvement over the campaign best for N runs — alert and inject a researcher.' },
  { id: 'repeated_failure', description: 'N consecutive runs failed/terminated without a passing result — alert and inject a researcher.' },
] as const;
export type CampaignTriggerType = typeof CAMPAIGN_TRIGGER_TYPES[number]['id'];

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

export interface StoreState {
  runId: string;
  workflowName: string;
  projectDir: string;
  /** git HEAD SHA captured at run start, used to compute a real diff in the run summary. Absent when projectDir is not a git repo. */
  baseCommit?: string;
  status: RunStatus;
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
  /** Filename (basename) of the terminal file that triggered termination — used for handoff to /ship follow-ups. */
  terminalArtifact?: string;
  /** Multi-phase program config (set from brief `program:` block). */
  program?: ProgramConfig;
  /** Research-mode config (set from brief `research:` block). */
  research?: ResearchConfig;
  stages: Record<string, StageStatus>;
  /** Append-only cost ledger for dynamic stages replaced by later outer plans. */
  retiredStageUsage?: RetiredStageUsage[];
  /** Append-only, iteration-addressed status/output/verdict evidence for replaced dynamic stages. */
  stageEvidence?: StageEvidenceRecord[];
  /** Required dynamic stages that a later plan must not silently forget. */
  unresolvedStageObligations?: UnresolvedStageObligation[];
  /** Framework-owned supervisor cost ledger, rendered as a synthetic `_supervisor` row. */
  supervisor?: SupervisorUsage;
  startedAt: string;
  completedAt?: string;
  plan?: unknown[];
  dispatchedStages?: unknown[];
  taskDescription?: string;
  /** Exact brief and visible acknowledgement decision admitted before launch. */
  briefAdmission?: BriefAdmissionRecord;
  currentIteration?: number;
  maxIterations?: number;
  maxRetries?: number;
  autoApproveRetries?: boolean;
  autoApprove?: boolean;
  supervise?: boolean;
  timeoutMs?: number;
  campaignTriggers?: CampaignTriggers;
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
}

/** Parsed archive shape before the status text has been trusted. */
export type ArchivedStoreState = Omit<StoreState, 'status'> & { status: unknown };

export interface ArchivedRunStateRead {
  state: ArchivedStoreState;
  status: RunStatusResolution;
}

export const FC_DIR = '.fc';
// FC_HOME (env) or setFcGlobalDir() override the global state root (~/.fc).
// Consumers: engine-scenario tests and `flowcrew rehearse` run real workflows
// against a temp dir so they can never write runs/campaign ledgers into the
// developer's real ~/.fc (openworker lesson: tests once read real machine
// state and emitted real telemetry; isolation must be structural, not
// disciplinary). The env var works when set before module load; the setter
// covers callers inside an already-loaded process (the CLI's rehearse path).
let _fcGlobalDir = process.env.FC_HOME ? process.env.FC_HOME : join(homedir(), FC_DIR);
export const FC_GLOBAL_DIR = _fcGlobalDir;

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

export function campaignDir(id: string): string {
  return join(campaignsRoot(), id);
}

function campaignEventStorageKey(state: StoreState): string | undefined {
  const value = state.campaignStorageKey ?? state.campaignId ?? state.campaignName;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().replace(/^new:/i, '').trim();
  if (!cleaned) return undefined;
  return cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || undefined;
}

function appendCampaignEvent(campaignStorageKey: string, event: Record<string, unknown>): void {
  if (!campaignStorageKey) return;
  const filePath = join(campaignsRoot(), `${campaignStorageKey}.jsonl`);
  mkdirSync(campaignsRoot(), { recursive: true });
  appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

/** The verdict-file contract a gate stage must write to verdict_<stage_id>.json. */
export const VERDICT_CONTRACT_DOC = '{"pass": true|false, "reason": "<why>"}  (scored gates may also set "score": <number>, "metric": "<name>", "threshold": <number>)';

/** Field names a campaign multi-phase gate verdict may carry (consumed by campaign code). */
export const PHASE_METADATA_FIELDS = 'phase, phaseComplete, nextPhase, outcome, artifactSummary, reason';

function isRealityGatedTerminal(status: string): boolean {
  return isSuccessfulRunStatus(status);
}

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

export async function enforceRealityGateBeforeTerminal(
  projectDir: string,
  runId: string,
  state: StoreState,
  targetStatus: StoreState['status'],
): Promise<{ allowed: boolean; state: StoreState; report?: RealityGateReport }> {
  if (!isRealityGatedTerminal(targetStatus)) return { allowed: true, state };
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
  if (checks.length === 0) return { allowed: true, state };
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
  if (durableReport.pass) {
    // Callers persist the original state object after an allowed gate, so attach
    // advisory evidence in place rather than returning an otherwise-lost copy.
    state.realityGate = diagnostics;
    return { allowed: true, state, report: durableReport };
  }
  const next: StoreState = {
    ...state,
    status: 'reality_gate_failed',
    failureReason: realityGateFailureReason(diagnostics, targetStatus),
    realityGate: diagnostics,
    completedAt: new Date().toISOString(),
  };
  appendFileSync(join(dir, '.reality-gate.failures.md'), failureMarkdown(durableReport, targetStatus), 'utf-8');
  writeRunState(projectDir, runId, next);
  return { allowed: false, state: next, report: durableReport };
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
    for (const name of [`terminal_${state.terminalArtifact}`, state.terminalArtifact]) {
      try {
        const outcome = oneLineOutcome(readFileSync(join(dir, name), 'utf-8'));
        if (outcome) return outcome;
      } catch { /* optional terminal artifact */ }
    }
  }
  return state.failureReason ? oneLineOutcome(state.failureReason) : undefined;
}

function emitCampaignEnvelopeEvents(projectDir: string, runId: string, state: StoreState): void {
  const campaignStorageKey = campaignEventStorageKey(state);
  if (!campaignStorageKey) return;
  const dir = runDir(projectDir, runId);
  const startedMarker = join(dir, '.campaign_started_emitted');
  const endedMarker = join(dir, '.campaign_envelope_emitted');
  const now = new Date().toISOString();
  const baseEvent = {
    runId,
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

export function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + randomBytes(4).toString('hex');
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw err;
  }
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
  mkdirSync(join(dir, 'stages'), { recursive: true });
  for (const sid of stageIds) {
    mkdirSync(stageDir(normalizedProjectDir, runId, sid), { recursive: true });
  }
  const stages: Record<string, StageStatus> = {};
  for (const sid of stageIds) stages[sid] = { status: 'pending', retries: 0 };
  const state: StoreState = {
    runId,
    workflowName,
    projectDir: normalizedProjectDir,
    status: 'running',
    stages,
    startedAt: new Date().toISOString(),
  };
  const baseCommit = captureGitHead(normalizedProjectDir);
  if (baseCommit) state.baseCommit = baseCommit;
  atomicWrite(join(dir, 'run.json'), JSON.stringify(state, null, 2));
  try { upsertRunIndex(normalizedProjectDir, state); } catch { /* index is best-effort */ }
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

export function createRun(
  projectDir: string,
  workflowName: string,
  workflowYaml: string,
  stageIds: string[],
): { runId: string; runDirPath: string } {
  const reservation = reserveRun(projectDir);
  return initializeReservedRun(projectDir, reservation.runId, workflowName, workflowYaml, stageIds);
}

export function readArchivedRunState(projectDir: string, runId: string): ArchivedRunStateRead {
  const parsed = JSON.parse(
    readFileSync(join(runDir(projectDir, runId), 'run.json'), 'utf-8'),
  ) as ArchivedStoreState;
  return { state: parsed, status: resolveRunStatus(parsed?.status) };
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
  const runJsonPath = join(runDir(projectDir, runId), 'run.json');
  requireKnownRunStatus(state.status, `write run state ${runId}`);
  if (existsSync(runJsonPath)) {
    try {
      const current = JSON.parse(readFileSync(runJsonPath, 'utf-8')) as { status?: unknown };
      const currentStatus = resolveRunStatus(current.status);
      if (currentStatus.kind === 'unknown') {
        throw new UnknownRunStatusError(
          current.status,
          `overwrite archived run ${runId}; update the tool or migrate the archive explicitly`,
        );
      }
    } catch (error) {
      if (error instanceof UnknownRunStatusError) throw error;
      // Preserve existing recovery behavior for malformed JSON. Unknown but
      // well-formed status text is handled above and never reaches this arm.
    }
  }
  atomicWrite(runJsonPath, JSON.stringify(state, null, 2));
  try { upsertRunIndex(projectDir, state); } catch { /* index is best-effort */ }
  emitCampaignEnvelopeEvents(projectDir, runId, state);
}

export function updateRunState(projectDir: string, runId: string, mutator: (state: StoreState) => void): StoreState {
  // Compare-and-swap: another process (e.g. dashboard cancel vs scheduler write)
  // can rename run.json between our read and write, so a plain read-modify-write
  // silently loses one side's update (last-writer-wins). Re-read + re-apply the
  // mutator if the file changed since we read it. atomicWrite makes each write
  // atomic; this shrinks the lost-update window to the tiny check→rename gap.
  const runJsonPath = join(runDir(projectDir, runId), 'run.json');
  const mtimeOf = (): number => { try { return statSync(runJsonPath).mtimeMs; } catch { return -1; } };
  for (let attempt = 0; attempt < 5; attempt++) {
    const mtimeBefore = mtimeOf();
    const state = readRunState(projectDir, runId);
    mutator(state);
    if (mtimeOf() !== mtimeBefore) continue; // raced — re-read and re-apply
    writeRunState(projectDir, runId, state);
    return state;
  }
  // Retries exhausted (heavy contention) — apply once more best-effort.
  const state = readRunState(projectDir, runId);
  mutator(state);
  writeRunState(projectDir, runId, state);
  return state;
}

export function readStageStatus(projectDir: string, runId: string, stageId: string): StageStatus {
  return JSON.parse(
    readFileSync(join(stageDir(projectDir, runId, stageId), 'status.json'), 'utf-8'),
  );
}

export function writeStageStatus(
  projectDir: string,
  runId: string,
  stageId: string,
  status: StageStatus,
): void {
  const dir = stageDir(projectDir, runId, stageId);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, 'status.json'), JSON.stringify(status, null, 2));
  // The per-stage file is the execution ledger, while run.json is the public
  // aggregate consumed by the dashboard and campaign views. Keep the current
  // attempt visible there immediately instead of waiting for the parent
  // scheduler to finish the attempt. updateRunState re-applies this narrow
  // mutation if a parallel stage updates run.json at the same time.
  const runJsonPath = join(runDir(projectDir, runId), 'run.json');
  if (existsSync(runJsonPath)) {
    updateRunState(projectDir, runId, (state) => {
      state.stages[stageId] = status;
    });
  }
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
): StageStatus {
  const previous = readStageStatusIfPresent(projectDir, runId, stageId);
  const attempts = [...(previous?.attempts ?? [])];
  const nextIndex = attempts.reduce((max, attempt) => Math.max(max, attempt.index), 0) + 1;
  attempts.push({ index: nextIndex, startedAt, status: 'running' });
  const running: StageStatus = {
    ...previous,
    status: STAGE_STATUS.RUNNING,
    retries,
    attempts,
    reruns: Math.max(0, attempts.length - 1),
    startedAt: attempts[0]?.startedAt ?? startedAt,
  };
  writeStageStatus(projectDir, runId, stageId, running);
  return running;
}

export interface CompleteStageAttemptInput {
  exitCode: number;
  duration_ms: number;
  completedAt?: string;
  artifacts?: string[];
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
  kgChanged?: boolean;
  writes?: string[];
  writeAttribution?: WriteAttribution;
  constraintAudit?: StageConstraintAuditSummary;
  timeout?: StageAttemptTimeoutSummary;
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
  const completedAt = completion.completedAt ?? new Date().toISOString();
  const attempts = [...(previous?.attempts ?? [])];
  let currentIndex = attempts.length - 1;
  if (currentIndex < 0 || attempts[currentIndex].status !== 'running') {
    const startedAt = previous?.startedAt ?? completedAt;
    const nextIndex = attempts.reduce((max, attempt) => Math.max(max, attempt.index), 0) + 1;
    attempts.push({ index: nextIndex, startedAt, status: 'running' });
    currentIndex = attempts.length - 1;
  }
  const current = attempts[currentIndex];
  const tokensIn = typeof completion.tokens_in === 'number' && Number.isFinite(completion.tokens_in)
    ? completion.tokens_in
    : undefined;
  const tokensOut = typeof completion.tokens_out === 'number' && Number.isFinite(completion.tokens_out)
    ? completion.tokens_out
    : undefined;
  attempts[currentIndex] = {
    ...current,
    completedAt,
    status: completion.exitCode === 0 ? 'complete' : 'failed',
    duration_ms: completion.duration_ms,
    exitCode: completion.exitCode,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokenUsage: tokensIn !== undefined && tokensOut !== undefined ? 'known' : 'unknown',
    error: completion.error,
    writes: completion.writes,
    writeAttribution: completion.writeAttribution,
    constraintAudit: completion.constraintAudit,
    timeout: completion.timeout,
  };
  const writes = uniqueStrings(previous?.writes, completion.writes);
  const final: StageStatus = {
    status: completion.exitCode === 0 ? STAGE_STATUS.COMPLETE : STAGE_STATUS.FAILED,
    exitCode: completion.exitCode,
    duration_ms: sumAttemptField(attempts, 'duration_ms'),
    artifacts: uniqueStrings(previous?.artifacts, completion.artifacts),
    retries,
    startedAt: attempts[0]?.startedAt,
    completedAt,
    error: completion.error,
    tokens_in: sumAttemptField(attempts, 'tokens_in'),
    tokens_out: sumAttemptField(attempts, 'tokens_out'),
    kgChanged: previous?.kgChanged === true || completion.kgChanged === true,
    attempts,
    reruns: Math.max(0, attempts.length - 1),
    writes,
    writeAttribution: completion.writeAttribution ?? previous?.writeAttribution,
    constraintAudit: completion.constraintAudit ?? previous?.constraintAudit,
    timeout: completion.timeout ?? previous?.timeout,
  };
  writeStageStatus(projectDir, runId, stageId, final);
  return final;
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
    ...(violationError ? { status: 'failed', exitCode: 1, error: violationError } : {}),
  };
  const updated: StageStatus = {
    ...status,
    attempts,
    constraintAudit: audit,
    ...(violationError ? {
      status: STAGE_STATUS.FAILED,
      exitCode: 1,
      error: violationError,
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
  };
}

export function writeStageInput(
  projectDir: string,
  runId: string,
  stageId: string,
  input: string,
): void {
  atomicWrite(join(stageDir(projectDir, runId, stageId), 'input.md'), input);
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
    return readFileSync(join(stageDir(projectDir, runId, stageId), 'input.md'), 'utf-8');
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
  // Prefer the SQLite index: every createRun/writeRunState upserts into it, so it
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
