import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import {
  atomicWrite,
  isAwaitingApprovalRunStatus,
  isPausedRunStatus,
  isRunningStageStatus,
  isSettledStageStatus,
  isTerminalRunStatus,
  readStageStatus,
  readRunState,
  resolveRunStatus,
  RUN_STATUS,
  runDir as getRunDirPath,
  STAGE_STATUS,
  stageDir,
  updateRunState,
} from './store.js';
import type { RunStatus, StageStatus, StoreState, SupervisorAttempt, SupervisorUsage } from './store.js';
import type { SupervisorConfig } from './config.js';
import { appendTraceEvent } from './trace.js';
import { ABORT_SIGNAL_VERSION, type AbortSignalSource, type StageAbortSignal } from './abort-signal.js';
import { createLogger } from './logging.js';
import {
  appendGuidanceEnvelope,
  renderGuidanceEnvelope,
  RUN_WIDE_GUIDANCE_TARGET,
} from './guidance.js';
import { recordRunEvent } from './run-events.js';

const log = createLogger({ name: 'supervisor' });

/** Preserve the established progress wording while making every known row explicit. */
export const SUPERVISOR_PROGRESS_OUTCOME_LABELS = {
  [RUN_STATUS.PENDING]: 'In progress',
  [RUN_STATUS.RUNNING]: 'In progress',
  [RUN_STATUS.PARKED]: 'In progress',
  [RUN_STATUS.COMPLETE]: 'Complete',
  [RUN_STATUS.FAILED]: 'Failed',
  [RUN_STATUS.AWAITING_APPROVAL]: 'In progress',
  [RUN_STATUS.SHIPPED]: 'In progress',
  [RUN_STATUS.CEILING_HIT]: 'In progress',
  [RUN_STATUS.ESCALATED]: 'In progress',
  [RUN_STATUS.REALITY_GATE_FAILED]: 'In progress',
  [RUN_STATUS.PHASE_COMPLETE]: 'In progress',
  [RUN_STATUS.STOPPED]: 'In progress',
  [RUN_STATUS.INCOMPLETE]: 'In progress',
} as const satisfies Record<RunStatus, string>;

/**
 * Single source of truth for supervisor verdicts (P4 of the Atom Architecture).
 * The system prompt's verdict union + descriptions are RENDERED from this — no
 * second prose copy to drift. Adding a verdict = add a descriptor here.
 */
export const SUPERVISOR_VERDICTS = [
  { id: 'WAIT', description: 'Agents making progress. No intervention.' },
  { id: 'GUIDE', description: 'Agent going wrong direction. Provide corrective instruction in "guidance".' },
  { id: 'ABORT', description: 'Stage stuck/looping/wasting time. Kill it and let retry handle it.' },
  { id: 'REPLAN', description: 'Fundamental approach is wrong. Needs a new plan entirely.' },
  { id: 'REJECT', description: 'A stage emitted a deliverable that does NOT meet its own declared work/acceptance criteria (e.g. a verdict claims pass while its evidence shows otherwise, or a stage marked itself done with the required artifact missing/empty). The result must NOT be accepted — set "target_stage" to the stage and the work is re-done.' },
  { id: 'DONE', description: 'The original goal is fully met based on evidence in the output.' },
] as const;
export type SupervisorVerdict = typeof SUPERVISOR_VERDICTS[number]['id'];

export interface SupervisorAssessment {
  verdict: SupervisorVerdict;
  targetStage: string | null;
  reason: string;
  guidance: string | null;
}

export function summarizeSupervisorGuidanceHistory(
  actions: ReadonlyArray<{ assessment: SupervisorAssessment }>,
  runningStages: readonly string[],
): string {
  const running = new Set(runningStages);
  const byStage = new Map<string, SupervisorAssessment[]>();
  for (const action of actions) {
    const assessment = action.assessment;
    if (assessment.verdict !== 'GUIDE' || !assessment.targetStage || !running.has(assessment.targetStage)) continue;
    const prior = byStage.get(assessment.targetStage) ?? [];
    prior.push(assessment);
    byStage.set(assessment.targetStage, prior);
  }
  return runningStages.flatMap((stageId) => {
    const guidance = byStage.get(stageId) ?? [];
    if (guidance.length === 0) return [];
    const recentReasons = guidance.slice(-3).map((assessment) =>
      assessment.reason.replace(/\s+/g, ' ').trim().slice(0, 240) || '(reason unavailable)'
    );
    return [`- ${stageId}: ${guidance.length} cumulative GUIDE decisions; recent reasons: ${recentReasons.join(' | ')}`];
  }).join('\n');
}

interface SupervisorAction {
  timestamp: string;
  tick: number;
  assessment: SupervisorAssessment;
  runningStages: string[];
  /** Attempt that was running when the action targeted its stage. */
  targetAttemptIndex?: number;
  /** Operator additions remain guidance, but do not authorize direction ABORT. */
  source?: 'supervisor' | 'operator';
}

function actionAttemptIndex(action: SupervisorAction, status: StageStatus | undefined): number | undefined {
  if (Number.isInteger(action.targetAttemptIndex)) return action.targetAttemptIndex;
  if (!status) return undefined;
  const actionAt = Date.parse(action.timestamp);
  if (!Number.isFinite(actionAt)) return undefined;
  return status.attempts?.find((attempt) => {
    const startedAt = Date.parse(attempt.startedAt);
    const completedAt = attempt.completedAt ? Date.parse(attempt.completedAt) : Number.POSITIVE_INFINITY;
    return Number.isFinite(startedAt) && actionAt >= startedAt && actionAt <= completedAt;
  })?.index;
}

/**
 * Parse a supervisor verdict from raw adapter output. Pure + exported so it is unit-
 * testable (a prior JSON-parse bug silently killed the supervisor for whole runs).
 * Collects ALL `{...verdict...}` matches and scans LAST-to-FIRST — the real response is
 * at the end; the prompt's echoed template (with `<placeholders>`) appears earlier and
 * must not be mistaken for the answer. Valid verdicts derive from SUPERVISOR_VERDICTS.
 */
export function parseSupervisorVerdict(output: string): SupervisorAssessment | null {
  const matches = [...output.matchAll(/\{[^}]*"verdict"[^}]*\}/g)];
  if (matches.length === 0) return null;
  const valid = SUPERVISOR_VERDICTS.map((v) => v.id);
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i][0]);
      if (!valid.includes(parsed.verdict)) continue;
      return {
        verdict: parsed.verdict,
        targetStage: parsed.target_stage ?? null,
        reason: parsed.reason ?? '',
        guidance: parsed.guidance ?? null,
      };
    } catch { /* try the next earlier match */ }
  }
  return null;
}

/**
 * GAP-2: deterministic per-running-stage no-progress watchdog. PURE + exported so it is
 * unit-testable independent of the LLM supervisor verdict. Generic mechanism — no domain
 * knowledge: "progress" is any of the per-tick signals the supervisor already computes
 * (new live.log bytes for that stage, a new artifact, or a stage transition); the threshold
 * is config-owned.
 *
 * Tracks the last time each running stage showed progress in `lastProgressMs` (a map the
 * caller persists across ticks). On each tick:
 *   - a stage seen for the FIRST time is initialized to `now` (it just started — not stalled).
 *   - a stage that made progress this tick has its timestamp refreshed to `now`.
 *   - a stage that has shown no progress for >= thresholdMs is reported as STALLED.
 *   - stages no longer running are dropped from the map (completed / iteration transition).
 *
 * Returns the next map (caller stores it) and the list of stalled stage ids to abort.
 */
export function detectStalledStages(input: {
  runningStages: string[];
  /** Stage ids that showed progress THIS tick (new live.log bytes, new artifact, or a transition). */
  progressedStageIds: Set<string>;
  /** Per-stage last-progress timestamps carried across ticks (caller-owned). */
  lastProgressMs: Record<string, number>;
  now: number;
  thresholdMs: number;
}): { nextLastProgressMs: Record<string, number>; stalledStageIds: string[] } {
  const { runningStages, progressedStageIds, lastProgressMs, now, thresholdMs } = input;
  const running = new Set(runningStages);
  const next: Record<string, number> = {};
  const stalled: string[] = [];
  for (const stageId of runningStages) {
    if (progressedStageIds.has(stageId) || lastProgressMs[stageId] === undefined) {
      // First appearance OR fresh progress this tick → (re)set the clock; not stalled.
      next[stageId] = now;
      continue;
    }
    // No progress this tick — carry the prior timestamp forward and check the gap.
    next[stageId] = lastProgressMs[stageId];
    if (now - lastProgressMs[stageId] >= thresholdMs) stalled.push(stageId);
  }
  // Drop any tracked stage that is no longer running (completed / iteration transition).
  for (const stageId of Object.keys(lastProgressMs)) {
    if (!running.has(stageId)) delete next[stageId];
  }
  return { nextLastProgressMs: next, stalledStageIds: stalled };
}

export interface StageExecutionFacts {
  stageId: string;
  attemptIndex?: number;
  attemptStartedAt?: string;
  verdictObserved: boolean;
  outputObserved: boolean;
  handoffObserved: boolean;
  commitObserved: boolean;
  artifactProgressThisTick: boolean;
  activeCommandCount: number;
  commandActivityValid: boolean;
  finalizing: boolean;
  protectedFromIdleAbort: boolean;
}

interface ProjectCommitFact {
  hash: string;
  committedAtMs: number;
}

type AbortBasis =
  | { kind: 'idle'; stalledMs: number }
  | { kind: 'repeated_guidance'; guideCount: number };

interface VerifiedAbortResult {
  written: boolean;
  reason: string;
}

function currentRunningAttempt(status: StageStatus | undefined): { index: number; startedAt: string } | undefined {
  const attempts = status?.attempts ?? [];
  for (let index = attempts.length - 1; index >= 0; index--) {
    const attempt = attempts[index];
    if (attempt.status === STAGE_STATUS.RUNNING) return { index: attempt.index, startedAt: attempt.startedAt };
  }
  return undefined;
}

function operationalDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export interface SupervisorEvidenceBinding {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  generation: string;
  emittedDeliverable: boolean;
}

interface AttemptGenerationRecord {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  segmentStart: number;
  artifactBaselines?: Record<string, string | null>;
}

function readAttemptGeneration(runDirectory: string, stageId: string): AttemptGenerationRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runDirectory, 'stages', stageId, 'attempt_generation.json'), 'utf-8')) as AttemptGenerationRecord;
    if (parsed.version !== 1 || parsed.stageId !== stageId || !Number.isSafeInteger(parsed.attemptIndex)
      || typeof parsed.attemptStartedAt !== 'string' || !Number.isSafeInteger(parsed.segmentStart) || parsed.segmentStart < 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isEnginePlaceholderMetric(path: string): boolean {
  if (!/metric\.json$/.test(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { source?: { kind?: unknown } };
    return parsed.source?.kind === 'engine_attempt_default';
  } catch {
    return false;
  }
}

/** Bind a rejection to exactly one scheduler attempt and its current evidence
 * bytes. Engine-written placeholder metrics never count as deliverables. */
export function computeSupervisorEvidenceBinding(
  runDirectory: string,
  stageId: string,
  status: StageStatus,
): SupervisorEvidenceBinding | undefined {
  const attempt = [...(status.attempts ?? [])].reverse().find((candidate) => (
    candidate.status === STAGE_STATUS.RUNNING || candidate.status === STAGE_STATUS.COMPLETE || candidate.status === STAGE_STATUS.FAILED
  ));
  if (!attempt) return undefined;
  const record = readAttemptGeneration(runDirectory, stageId);
  if (!record || record.attemptIndex !== attempt.index || record.attemptStartedAt !== attempt.startedAt) return undefined;
  const stagePath = join(runDirectory, 'stages', stageId);
  const logPath = join(stagePath, 'live.log');
  const outputPath = join(stagePath, `output_attempt_${attempt.index}.md`);
  const verdictPath = join(runDirectory, `verdict_${stageId}.json`);
  const metricPath = join(stagePath, 'metric.json');
  const hash = createHash('sha256').update(JSON.stringify(record));
  try {
    const bytes = readFileSync(logPath);
    hash.update(bytes.subarray(Math.min(record.segmentStart, bytes.length)));
  } catch { /* an empty current segment remains a valid generation */ }
  let emittedDeliverable = false;
  for (const [kind, path] of [['output', outputPath], ['verdict', verdictPath], ['metric', metricPath]] as const) {
    if (!existsSync(path) || isEnginePlaceholderMetric(path)) continue;
    try {
      const bytes = readFileSync(path);
      const fingerprint = createHash('sha256').update(bytes).digest('hex');
      if ((record.artifactBaselines?.[kind] ?? null) === fingerprint) continue;
      if (bytes.length > 0) emittedDeliverable = true;
      hash.update(path.slice(runDirectory.length)).update(bytes);
    } catch { /* ignore a file racing an atomic replacement */ }
  }
  return {
    version: 1,
    stageId,
    attemptIndex: attempt.index,
    attemptStartedAt: attempt.startedAt,
    generation: hash.digest('hex'),
    emittedDeliverable,
  };
}

export function supervisorEvidenceDigest(input: {
  tails: ReadonlyMap<string, string>;
  artifacts: readonly { path: string; content: string }[];
  anomalySignals: readonly string[];
  attemptKeys: readonly string[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    tails: [...input.tails.entries()].sort(([a], [b]) => a.localeCompare(b)),
    artifacts: [...input.artifacts].sort((a, b) => a.path.localeCompare(b.path)),
    anomalySignals: [...input.anomalySignals].sort(),
    attemptKeys: [...input.attemptKeys].sort(),
  })).digest('hex');
}

/**
 * Inspect only durable, current-attempt evidence. An output/verdict left by an
 * older attempt cannot make a new execution permanently immune to supervision.
 */
export function inspectStageExecutionFacts(input: {
  runDir: string;
  stageId: string;
  status: StageStatus;
  sinceMs: number;
  commitObserved?: boolean;
}): StageExecutionFacts {
  const attempt = currentRunningAttempt(input.status);
  const attemptStartedMs = attempt ? Date.parse(attempt.startedAt) : Number.NaN;
  const belongsToAttempt = (path: string): boolean => {
    if (!attempt || !Number.isFinite(attemptStartedMs)) return false;
    try {
      const stat = statSync(path);
      return stat.isFile() && stat.size > 0 && stat.mtimeMs >= attemptStartedMs;
    } catch {
      return false;
    }
  };
  const changedThisTick = (path: string): boolean => {
    if (!belongsToAttempt(path)) return false;
    try { return statSync(path).mtimeMs >= input.sinceMs; } catch { return false; }
  };

  const stageRoot = join(input.runDir, 'stages', input.stageId);
  const outputPath = join(stageRoot, 'output.md');
  const verdictPath = join(input.runDir, `verdict_${input.stageId}.json`);
  const handoffPath = join(input.runDir, `handoff_${input.stageId}.md`);
  const verdictObserved = belongsToAttempt(verdictPath);
  const outputObserved = belongsToAttempt(outputPath);
  const handoffObserved = belongsToAttempt(handoffPath);
  const commitObserved = input.commitObserved === true;
  let activeCommandCount = 0;
  let commandActivityValid = false;
  if (attempt) {
    try {
      const activity = JSON.parse(readFileSync(join(stageRoot, 'command_activity.json'), 'utf-8')) as Record<string, unknown>;
      const active = Array.isArray(activity.active) ? activity.active : undefined;
      const updatedAtMs = typeof activity.updatedAt === 'string' ? Date.parse(activity.updatedAt) : Number.NaN;
      commandActivityValid = activity.version === 1
        && activity.stageId === input.stageId
        && activity.attemptIndex === attempt.index
        && activity.attemptStartedAt === attempt.startedAt
        && activity.streamClosed === false
        && active !== undefined
        && Number.isFinite(updatedAtMs)
        && updatedAtMs >= attemptStartedMs;
      if (commandActivityValid) {
        activeCommandCount = active!.filter((record) => {
          if (!record || typeof record !== 'object') return false;
          const value = record as Record<string, unknown>;
          const startedAtMs = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : Number.NaN;
          return typeof value.id === 'string' && value.id.length > 0
            && Number.isFinite(startedAtMs) && startedAtMs >= attemptStartedMs;
        }).length;
      }
    } catch { /* missing/malformed activity never grants protection */ }
  }

  const internalNames = new Set([
    'live.log', 'status.json', 'input.md', 'guidance.md', 'guidance_consumed.md', 'command_activity.json',
  ]);
  let stageArtifactChanged = false;
  const walk = (dir: string, depth: number): void => {
    if (stageArtifactChanged || depth > 3) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[]; } catch { return; }
    for (const entry of entries) {
      if (internalNames.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && changedThisTick(path)) stageArtifactChanged = true;
      if (stageArtifactChanged) return;
    }
  };
  walk(stageRoot, 0);
  const artifactProgressThisTick = stageArtifactChanged
    || changedThisTick(verdictPath)
    || changedThisTick(handoffPath)
    || commitObserved;
  const finalizing = outputObserved && !verdictObserved;
  const protectedFromIdleAbort = verdictObserved || handoffObserved || commitObserved || finalizing || activeCommandCount > 0;
  return {
    stageId: input.stageId,
    attemptIndex: attempt?.index,
    attemptStartedAt: attempt?.startedAt,
    verdictObserved,
    outputObserved,
    handoffObserved,
    commitObserved,
    artifactProgressThisTick,
    activeCommandCount,
    commandActivityValid,
    finalizing,
    protectedFromIdleAbort,
  };
}

export function describeStageExecutionFacts(facts: StageExecutionFacts): string {
  const attempt = facts.attemptIndex === undefined ? 'no active attempt observed' : `active attempt ${facts.attemptIndex}`;
  return [
    attempt,
    facts.verdictObserved ? 'verdict observed' : 'no verdict observed',
    facts.outputObserved ? 'final output observed' : 'no final output observed',
    facts.handoffObserved ? 'handoff observed' : 'no handoff observed',
    facts.commitObserved ? 'commit observed' : 'no current-attempt commit observed',
    facts.activeCommandCount > 0
      ? `${facts.activeCommandCount} active command${facts.activeCommandCount === 1 ? '' : 's'} observed`
      : facts.commandActivityValid ? 'no active command observed' : 'no valid command activity record',
    facts.finalizing ? 'finalization window active' : 'finalization window inactive',
  ].join('; ');
}

export function buildSupervisorSystemPrompt(stuckThresholdMs: number): string {
  const stuckMinutes = Math.max(1, Math.round(stuckThresholdMs / 60_000));
  const verdictUnion = SUPERVISOR_VERDICTS.map((v) => v.id).join('|');
  const verdictList = SUPERVISOR_VERDICTS.map((v) => `- ${v.id}: ${v.description}`).join('\n');
  return `You are a workflow supervisor monitoring agent progress toward a goal.
Analyze the running stages below and respond with exactly ONE JSON object.
Do NOT explain your reasoning — output ONLY the JSON.

Format: {"verdict":"${verdictUnion}","target_stage":"<stage_id or null>","reason":"<1 sentence>","guidance":"<instruction if GUIDE, else null>"}

Verdicts:
${verdictList}

Rules:
- Default to WAIT when agents are making progress toward the goal.
- GUIDE only when you see a concrete wrong direction (not just slow progress).
- REJECT only when an EMITTED deliverable contradicts its OWN declared work or acceptance criteria — e.g. a gate verdict says pass:true while the evidence/metric it cites shows fail, a stage claims it produced an artifact that is missing or empty, or a result codifies a smoke/error as success. Set "target_stage" to that stage; "reason" must name the specific contradiction (what was claimed vs what the evidence shows). REJECT forces the work to be re-done — it is NOT for slow progress (use WAIT) or a wrong overall approach (use REPLAN). CRITICAL GUARD: an HONEST NEGATIVE is a VALID deliverable, not a rejection — do NOT REJECT a result simply because the target metric was not beaten, the hypothesis failed, or the run found no improvement. Only REJECT when the deliverable itself is internally inconsistent or does not actually do the work it declares.
- DONE only when the ORIGINAL GOAL (stated at the top of this prompt) is fully satisfied — not when an intermediate stage passes its own tests. A stage's tests passing means that STAGE succeeded, not that the overall goal is met. Only signal DONE if you see evidence that ALL acceptance criteria from the original goal are achieved (e.g., final QA gate passes, target metric exceeded, all deliverables confirmed). For exploration/research tasks where the goal is to improve a metric, NEVER signal DONE just because code compiles or intermediate tests pass.
- ABORT only in either of these cases: (1) a stage has made no real progress for ${stuckMinutes}+ minutes and is truly stuck, or (2) the same concrete wrong direction continues after repeated GUIDE decisions. Active or high-volume output is not proof that the direction is correct and must not prevent case (2) from escalating to ABORT. Note: codex agents often edit files silently via tool calls without printing to stdout; do NOT infer case (1) from stdout silence alone if you can see file/artifact activity in the snapshot.
- Treat the verified stage-facts line as authoritative. \`output.md\` is not a verdict: say a verdict exists only when the facts explicitly say "verdict observed". Never ABORT during a stated finalization window; the stage timeout remains the outer bound.
- Do not ABORT slow but correct work, ordinary progress, or an honestly reported negative result.
- Keep "reason" to one sentence. Keep "guidance" to 1-2 sentences max.`;
}

export function buildSupervisorRolePrompt(stuckThresholdMs: number, taskDescription: string): string {
  return `${buildSupervisorSystemPrompt(stuckThresholdMs)}\n\n# Original Goal\n${taskDescription}`;
}

export type SupervisorAssessmentTrigger = 'anomaly' | 'routine' | 'none';

export function selectSupervisorAssessmentTrigger(input: {
  anomalySignals: string[];
  runningStageCount: number;
  accumulatedOutputBytes: number;
  minDeltaBytes: number;
  now: number;
  lastRoutineAssessmentAt: number;
  routineAssessmentIntervalMs: number;
  routineAssessmentsThisIteration: number;
  maxRoutineAssessmentsPerIteration: number;
  cooldownUntil: number;
}): SupervisorAssessmentTrigger {
  if (input.anomalySignals.length > 0) return 'anomaly';
  if (input.runningStageCount === 0) return 'none';
  if (input.accumulatedOutputBytes < input.minDeltaBytes) return 'none';
  if (input.now - input.lastRoutineAssessmentAt < input.routineAssessmentIntervalMs) return 'none';
  if (input.routineAssessmentsThisIteration >= input.maxRoutineAssessmentsPerIteration) return 'none';
  if (input.now < input.cooldownUntil) return 'none';
  return 'routine';
}

function artifactShowsFailedGate(artifact: { path: string; content: string }): boolean {
  if (!/(^|\/)verdict(?:[_.][^/]*)?\.json$/i.test(artifact.path)) return false;
  try {
    const parsed = JSON.parse(artifact.content) as { pass?: unknown };
    return parsed.pass === false;
  } catch { return false; }
}

/** Stable signal ids let the heartbeat edge-trigger anomalies instead of spamming every 30s. */
export function detectSupervisorAnomalySignals(input: {
  state: StoreState;
  stageTransitionFingerprint?: string;
  stalledStageIds?: string[];
  recentArtifacts?: Array<{ path: string; content: string }>;
  userInput?: string | null;
  pendingApprovalFingerprint?: string;
}): string[] {
  const signals: string[] = [];
  if (input.stageTransitionFingerprint) signals.push(`stage_transition:${input.stageTransitionFingerprint}`);
  for (const stageId of input.stalledStageIds ?? []) signals.push(`stalled:${stageId}`);
  if (input.userInput) signals.push(`user_input:${input.userInput.slice(0, 120)}`);
  if (input.pendingApprovalFingerprint) signals.push(`pending_approval:${input.pendingApprovalFingerprint}`);
  for (const artifact of input.recentArtifacts ?? []) {
    if (artifactShowsFailedGate(artifact)) signals.push(`gate_failed:${artifact.path}:${artifact.content.slice(0, 160)}`);
  }
  for (const [stageId, status] of Object.entries(input.state.stages)) {
    const failedAttempts = (status.attempts ?? []).filter((attempt) => attempt.status === STAGE_STATUS.FAILED).length;
    if (failedAttempts >= 2) signals.push(`repeated_failure:${stageId}:${failedAttempts}`);
  }
  if (input.state.campaignAlert?.type === 'plateau') {
    signals.push(`metric_plateau:${input.state.campaignAlert.triggeredAt}`);
  }
  const budget = input.state.budget;
  if (budget) {
    const tokenRatio = budget.totalTokens && budget.totalTokens > 0 ? (budget.usedTokens ?? 0) / budget.totalTokens : 0;
    const timeRatio = budget.totalTimeMs && budget.totalTimeMs > 0 ? (budget.usedTimeMs ?? 0) / budget.totalTimeMs : 0;
    if (Math.max(tokenRatio, timeRatio) >= 0.9) signals.push(`budget_near_exhaustion:${Math.max(tokenRatio, timeRatio).toFixed(3)}`);
  }
  if (isAwaitingApprovalRunStatus(input.state.status) || isPausedRunStatus(input.state.status)) {
    signals.push(`pending_approval_state:${input.state.status}`);
  }
  return [...new Set(signals)];
}

export class Supervisor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private byteOffsets = new Map<string, number>();
  private attemptEvidenceKeys = new Map<string, string>();
  private attemptSegmentFloors = new Map<string, number>();
  private stageEvidenceDigests = new Map<string, string>();
  private artifactEvidenceDigests = new Map<string, string>();
  private lastAssessmentEvidenceDigest?: string;
  private lastActionTime = 0;
  private assessmentCount = 0;
  /** Consecutive failed assessments (null returns from assess()). After a
   * threshold, the supervisor writes a visible `supervisor_degraded.json`
   * signal instead of silently producing zero ticks (the Phase E failure mode,
   * where a JSON-parse bug made the supervisor silently dead for a whole run). */
  private consecutiveAssessFailures = 0;
  private static readonly DEGRADED_AFTER_FAILURES = 3;
  private tickCount = 0;
  private actions: SupervisorAction[] = [];
  private stopped = false;
  private startTime = Date.now();
  private decisions: string[] = [];
  private deliverables: string[] = [];
  private observations: string[] = [];
  private knownStages = new Set<string>();
  private completedStages = new Map<string, { role: string; duration: number }>();
  private lastState: StoreState | null = null;
  private usage: SupervisorUsage | null = null;

  constructor(
    private projectDir: string,
    private runId: string,
    private adapter: Adapter,
    private config: SupervisorConfig,
    private taskDescription: string,
  ) {}

  // Heartbeats stay cheap and fixed-rate. Semantic LLM reviews have their own
  // routine cadence; anomaly signals bypass that cadence and routine budget.
  private effectivePollIntervalMs: number = 0;
  private consecutiveWaits = 0;
  private prevStageStatusSnapshot: Record<string, string> = {};
  private lastRoutineAssessmentAt = Date.now();
  private accumulatedOutputBytes = 0;
  private pendingTails = new Map<string, string>();
  private pendingArtifacts = new Map<string, { path: string; content: string }>();
  private seenAnomalySignals = new Set<string>();
  // Per-iteration ROUTINE budget refills when state.currentIteration advances.
  private lastSeenIteration = 0;
  private iterationAssessmentCount = 0;
  // GAP-2 watchdog: last-progress timestamp per running stage (carried across ticks).
  private stageLastProgressMs: Record<string, number> = {};
  // Idempotency is attempt-scoped, so an immediate same-name rerun remains supervisable.
  private watchdogAbortedStages = new Set<string>();
  private watchdogAttemptKeys: Record<string, string> = {};
  // Cursor for stage-attributed durable artifact checks (independent of the LLM scan).
  private watchdogLastArtifactCheckMs = 0;

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.effectivePollIntervalMs = this.config.pollIntervalMs;
    const startedAt = new Date().toISOString();
    try {
      const state = readRunState(this.projectDir, this.runId);
      const prior = state.supervisor;
      this.usage = prior ? {
        ...prior,
        status: 'running',
        completedAt: undefined,
        attempts: [...prior.attempts],
      } : {
        status: 'running',
        calls: 0,
        tokens_in: 0,
        tokens_out: 0,
        duration_ms: 0,
        startedAt,
        attempts: [],
      };
      this.assessmentCount = this.usage.calls;
      this.startTime = Date.parse(this.usage.startedAt) || Date.now();
      this.lastRoutineAssessmentAt = Date.now();
      this.persistUsage();
    } catch { /* run state may not be initialized yet */ }
    const logPath = this.logPath();
    mkdirSync(join(this.runDir(), 'signals'), { recursive: true });
    appendFileSync(logPath, `# Supervisor Log\n\nGoal: ${this.taskDescription.slice(0, 200)}\nStarted: ${startedAt}\nConfig: heartbeat=${this.config.pollIntervalMs}ms, routine=${this.config.routineAssessmentIntervalMs}ms, model=${this.config.model}, routine-max/iter=${this.config.maxAssessmentsPerIteration}\n\n`);
    log.info({ runId: this.runId }, 'Supervisor started');
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch(err => log.error(err, 'Supervisor tick error'))
        .finally(() => this.scheduleNextTick());
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Re-read final state for accurate progress report
    try {
      const finalState = readRunState(this.projectDir, this.runId);
      this.trackMilestones(finalState);
    } catch { /* ignore */ }
    if (this.usage) {
      this.usage.status = STAGE_STATUS.COMPLETE;
      this.usage.completedAt = new Date().toISOString();
      this.persistUsage();
    }
    appendFileSync(this.logPath(), `\n---\nSupervisor stopped: ${new Date().toISOString()}, ${this.assessmentCount} assessments made.\n`);
    this.writeProgress();
    log.info({ runId: this.runId, assessments: this.assessmentCount }, 'Supervisor stopped');
  }

  private persistUsage(): void {
    if (!this.usage) return;
    const usage: SupervisorUsage = {
      ...this.usage,
      attempts: [...this.usage.attempts],
    };
    try {
      const dir = stageDir(this.projectDir, this.runId, '_supervisor');
      mkdirSync(dir, { recursive: true });
      atomicWrite(join(dir, 'status.json'), JSON.stringify(usage, null, 2));
    } catch { /* non-critical */ }
    try {
      updateRunState(this.projectDir, this.runId, (state) => { state.supervisor = usage; });
    } catch { /* non-critical */ }
    // Summaries are normally generated just before the scheduler's finally
    // block stops the supervisor. Refresh only the deterministic usage line
    // here so the final call cannot remain invisible (and do not trigger a
    // second, costly summary-model invocation).
    if (usage.status === STAGE_STATUS.COMPLETE) this.refreshSummaryUsage(usage);
  }

  private refreshSummaryUsage(usage: SupervisorUsage): void {
    const summaryPath = join(this.runDir(), 'summary.md');
    if (!existsSync(summaryPath)) return;
    try {
      const tokensTotal = usage.tokens_in + usage.tokens_out;
      const line = `- _supervisor: ${usage.calls} calls, ${Math.round(usage.duration_ms / 1000)}s cumulative, ${tokensTotal} tokens total (${usage.tokens_in} in + ${usage.tokens_out} out)`;
      let summary = readFileSync(summaryPath, 'utf-8');
      if (/^- _supervisor:.*$/m.test(summary)) {
        summary = summary.replace(/^- _supervisor:.*$/m, line);
      } else if (/^## Stages\s*$/m.test(summary)) {
        summary = summary.replace(/^## Stages\s*$/m, (heading) => `${heading}\n${line}`);
      } else {
        summary = `${summary.trimEnd()}\n\n## Stages\n${line}\n`;
      }
      atomicWrite(summaryPath, summary);
    } catch { /* non-critical observability refresh */ }
  }

  private recordAssessmentUsage(
    startedAt: string,
    result: RunResult | undefined,
    verdict: SupervisorAssessment | null,
    error?: string,
  ): void {
    if (!this.usage) {
      this.usage = {
        status: 'running', calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0,
        startedAt, attempts: [],
      };
    }
    const completedAt = new Date().toISOString();
    const durationMs = typeof result?.duration_ms === 'number'
      ? result.duration_ms
      : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
    const exitCode = result?.exitCode ?? 1;
    const attempt: SupervisorAttempt = {
      index: this.usage.attempts.length + 1,
      startedAt,
      completedAt,
      status: exitCode === 0 && verdict ? 'complete' : 'failed',
      duration_ms: durationMs,
      exitCode,
      tokens_in: result?.tokens_in,
      tokens_out: result?.tokens_out,
      ...(verdict ? {
        unverifiedAssessment: {
          verdict: verdict.verdict,
          targetStage: verdict.targetStage,
          reason: verdict.reason,
        },
      } : {}),
      error,
    };
    this.usage.attempts.push(attempt);
    this.usage.calls = this.usage.attempts.length;
    this.usage.tokens_in += result?.tokens_in ?? 0;
    this.usage.tokens_out += result?.tokens_out ?? 0;
    this.usage.duration_ms += durationMs;
    this.assessmentCount = this.usage.calls;
    try {
      appendTraceEvent(this.projectDir, this.runId, '_supervisor', {
        timestamp: completedAt,
        stageId: '_supervisor',
        type: 'llm_call',
        inputSummary: 'Supervisor semantic assessment',
        outputSummary: verdict
          ? `Unverified model assessment — ${verdict.verdict}: ${verdict.reason}`
          : (error ?? `exit ${exitCode}`),
        tokensIn: result?.tokens_in,
        tokensOut: result?.tokens_out,
        durationMs,
      });
    } catch { /* non-critical */ }
    this.persistUsage();
  }

  private recordEffectiveAssessment(assessment: SupervisorAssessment): void {
    const attempt = this.usage?.attempts.at(-1);
    if (!attempt || attempt.status !== STAGE_STATUS.COMPLETE || !attempt.unverifiedAssessment) return;
    attempt.verdict = assessment.verdict;
    attempt.effectiveReason = assessment.reason;
    this.persistUsage();
  }

  private writeProgress(): void {
    const state = this.lastState;
    const elapsed = operationalDuration(Date.now() - this.startTime);
    const status = state?.status ?? 'unknown';
    const iteration = state?.currentIteration ?? 1;
    const maxIter = state?.maxIterations ?? '?';
    const retries = this.actions.filter(a => a.assessment.verdict !== 'WAIT').length;

    // No Goal section — page header / tab title already show the task name,
    // and the full brief is one click away. Repeating 300 chars of Goal here
    // pushes the actually-actionable Outcome below the fold.
    const lines: string[] = [
      `# Run: ${this.runId}`,
      '',
    ];

    // Outcome first — single most actionable line. Read this and you know
    // whether you need to do anything.
    const statusResolution = resolveRunStatus(status);
    const outcomeLabel = statusResolution.kind === 'known'
      ? SUPERVISOR_PROGRESS_OUTCOME_LABELS[statusResolution.status]
      : `Unrecognized status ${statusResolution.display}`;
    lines.push('## Outcome');
    lines.push(`${outcomeLabel} (${elapsed}, iteration ${iteration}/${maxIter}, ${retries} supervisor interventions)`);
    lines.push('');

    lines.push('## Current work');
    const running = Object.entries(state?.stages ?? {})
      .flatMap(([stageId, stage]) => {
        if (!isRunningStageStatus(stage.status)) return [];
        const execution = currentRunningAttempt(stage);
        const startedAt = execution ? Date.parse(execution.startedAt) : NaN;
        const runningFor = Number.isFinite(startedAt) ? operationalDuration(Date.now() - startedAt) : 'unknown duration';
        return [`- ${stageId}: execution ${execution?.index ?? '?'} · ${runningFor}`];
      });
    lines.push(...(running.length > 0 ? running : ['- No stage is executing.']));
    lines.push('');

    if (this.decisions.length > 0) {
      lines.push('## What was decided');
      for (const d of this.decisions) lines.push(`- ${d}`);
      lines.push('');
    }

    // Deliverables: don't dump every artifact path (a single run with images +
    // keyframes can produce 100+ paths and turn this section into a wall of
    // text). Show artifact count per stage, surface the final_package path if
    // one is present, and cap individual entries to a readable preview.
    if (this.deliverables.length > 0) {
      lines.push('## What was delivered');
      let finalPackagePath: string | null = null;
      for (const d of this.deliverables) {
        const colon = d.indexOf(':');
        const stageId = colon > 0 ? d.slice(0, colon).trim() : d;
        const rest = colon > 0 ? d.slice(colon + 1).trim() : '';
        const items = rest ? rest.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!finalPackagePath) {
          const fp = items.find(p => /\/final_package(?:\/|$)/.test(p));
          if (fp) finalPackagePath = fp.split('/final_package')[0] + '/final_package';
        }
        if (items.length === 0) {
          lines.push(`- ${stageId}: (no artifacts)`);
        } else if (items.length === 1) {
          lines.push(`- ${stageId}: ${items[0]}`);
        } else {
          lines.push(`- ${stageId}: ${items.length} artifacts (e.g. ${items[0]})`);
        }
      }
      if (finalPackagePath) {
        lines.push(`- final_package: ${finalPackagePath}`);
      }
      lines.push('');
    }

    // Observations: only keep the recent non-WAIT verdicts and user-guidance
    // events. Per-tick WAIT reasons ("stage still making progress") are noise
    // here — they're already visible in the SupervisorPane action list. The
    // tag convention in act(): WAIT pushes a bare reason, non-WAIT pushes
    // "VERDICT: reason"; user input pushes "User guidance received: ...".
    if (this.observations.length > 0) {
      const noteworthy = this.observations.filter(o =>
        /^(GUIDE|ABORT|REPLAN|REJECT|DONE):/.test(o) || o.startsWith('User guidance received:'),
      );
      const recent = noteworthy.slice(-5);
      if (recent.length > 0) {
        lines.push('## Notable supervisor events');
        for (const o of recent) lines.push(`- ${o}`);
        lines.push('');
      }
    }

    writeFileSync(this.progressPath(), lines.join('\n'), 'utf-8');
    this.writeSupervisorState();
  }

  private progressPath(): string {
    return join(this.runDir(), 'progress.md');
  }

  /**
   * Structured state for the dashboard UI to render the supervisor activity pane.
   * Refreshed on every assessment, on idle ticks, and at stop. Keeps last 30 actions.
   */
  private writeSupervisorState(): void {
    const path = join(this.runDir(), 'supervisor_state.json');
    const payload = {
      runId: this.runId,
      startedAt: new Date(this.startTime).toISOString(),
      stoppedAt: this.stopped ? new Date().toISOString() : null,
      assessmentCount: this.assessmentCount,
      iterationAssessmentCount: this.iterationAssessmentCount,
      maxAssessmentsPerIteration: this.config.maxAssessmentsPerIteration,
      currentIteration: this.lastSeenIteration,
      basePollIntervalMs: this.config.pollIntervalMs,
      routineAssessmentIntervalMs: this.config.routineAssessmentIntervalMs,
      effectivePollIntervalMs: this.effectivePollIntervalMs,
      consecutiveWaits: this.consecutiveWaits,
      tickCount: this.tickCount,
      tokensIn: this.usage?.tokens_in ?? 0,
      tokensOut: this.usage?.tokens_out ?? 0,
      assessmentDurationMs: this.usage?.duration_ms ?? 0,
      actions: this.actions.slice(-30).map(a => ({
        tick: a.tick,
        timestamp: a.timestamp,
        runningStages: a.runningStages,
        verdict: a.assessment.verdict,
        targetStage: a.assessment.targetStage,
        reason: a.assessment.reason,
        guidance: a.assessment.guidance,
        targetAttemptIndex: a.targetAttemptIndex,
        source: a.source,
      })),
    };
    try { writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8'); } catch { /* non-critical */ }
  }

  private readUserInput(): string | null {
    const inputPath = join(this.runDir(), 'user_input.md');
    if (!existsSync(inputPath)) return null;
    try {
      const content = readFileSync(inputPath, 'utf-8').trim();
      unlinkSync(inputPath); // consume it
      if (content) return content;
    } catch { /* ignore */ }
    return null;
  }

  private trackMilestones(state: StoreState): void {
    this.lastState = state;

    // Detect new stages starting
    for (const [id, ss] of Object.entries(state.stages)) {
      if (isRunningStageStatus(ss.status) && !this.knownStages.has(id)) {
        this.knownStages.add(id);
      }
      // Detect stage completions
      if (isSettledStageStatus(ss.status) && !this.completedStages.has(id)) {
        const duration = ss.duration_ms ? Math.round(ss.duration_ms / 1000) : 0;
        this.completedStages.set(id, { role: '', duration });

        if (ss.status === STAGE_STATUS.COMPLETE) {
          // Check for deliverables (artifacts)
          if (ss.artifacts && ss.artifacts.length > 0) {
            this.deliverables.push(`${id}: ${ss.artifacts.join(', ')}`);
          }
        }
      }
    }

    // Detect dispatch decisions
    if (state.dispatchedStages && Array.isArray(state.dispatchedStages)) {
      const dispatched = state.dispatchedStages as unknown[];
      const dispatchCount = dispatched.length;
      const stageNames = dispatched.map((s) => (s && typeof s === 'object' && 'id' in s ? (s as { id: string }).id : 'unknown')).join(', ');
      const decision = `Planner dispatched ${dispatchCount} stages: ${stageNames}`;
      if (!this.decisions.includes(decision)) {
        this.decisions.push(decision);
      }
    }
  }

  private runDir(): string {
    return getRunDirPath(this.projectDir, this.runId);
  }

  private logPath(): string {
    return join(this.runDir(), 'supervisor_log.md');
  }

  private signalDir(): string {
    return join(this.runDir(), 'signals');
  }

  private pendingApprovalFingerprint(): string | undefined {
    const stagesRoot = join(this.runDir(), 'stages');
    try {
      const found: string[] = [];
      for (const stageId of readdirSync(stagesRoot)) {
        const path = join(stagesRoot, stageId, 'approval_request.json');
        if (!existsSync(path)) continue;
        const stat = statSync(path);
        found.push(`${stageId}:${stat.mtimeMs}`);
      }
      return found.sort().join('|') || undefined;
    } catch {
      return undefined;
    }
  }

  private readProjectCommit(): ProjectCommitFact | undefined {
    try {
      const output = execFileSync('git', ['show', '-s', '--format=%H%x00%cI', 'HEAD'], {
        cwd: this.projectDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      const [hash, committedAt] = output.split('\0');
      const committedAtMs = Date.parse(committedAt);
      if (!/^[0-9a-f]{7,40}$/i.test(hash) || !Number.isFinite(committedAtMs)) return undefined;
      return { hash, committedAtMs };
    } catch {
      return undefined;
    }
  }

  private inspectFacts(
    stageId: string,
    status: StageStatus,
    sinceMs: number,
    baseCommit?: string,
    projectCommit = this.readProjectCommit(),
  ): StageExecutionFacts {
    const attempt = currentRunningAttempt(status);
    const attemptStartedMs = attempt ? Date.parse(attempt.startedAt) : Number.NaN;
    const commitObserved = Boolean(
      attempt
      && projectCommit
      && projectCommit.hash !== baseCommit
      && Number.isFinite(attemptStartedMs)
      // Git commit timestamps have one-second precision; tolerate that
      // truncation when the commit and attempt start share a second.
      && projectCommit.committedAtMs + 999 >= attemptStartedMs,
    );
    return inspectStageExecutionFacts({
      runDir: this.runDir(),
      stageId,
      status,
      sinceMs,
      commitObserved,
    });
  }

  private authoritativeStageStatus(stageId: string, fallback: StageStatus): StageStatus {
    try { return readStageStatus(this.projectDir, this.runId, stageId); } catch { return fallback; }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;

    // Read current state
    let state: StoreState;
    try {
      state = readRunState(this.projectDir, this.runId);
    } catch { /* non-critical */
      return; // run not ready yet
    }

    // Track milestones and update progress
    this.trackMilestones(state);

    // Refill the ROUTINE semantic-review budget when the iteration advances.
    const currentIter = state.currentIteration ?? 1;
    if (currentIter !== this.lastSeenIteration) {
      if (this.lastSeenIteration !== 0) {
        log.info({ from: this.lastSeenIteration, to: currentIter, perIterUsed: this.iterationAssessmentCount }, 'Supervisor per-iteration budget refilled');
      }
      this.lastSeenIteration = currentIter;
      this.iterationAssessmentCount = 0;
    }

    // Stop if run is no longer active (any terminal state, not just complete/failed)
    if (isTerminalRunStatus(state.status)) {
      this.stop();
      return;
    }

    // Check for user input
    const userInput = this.readUserInput();
    const addressedOperatorTarget = (() => {
      if (!userInput) return undefined;
      const targets = [...userInput.matchAll(/(?:^|\n)\s*\[([a-z][a-z0-9_]{0,19}|all|\*)\]\s*:/g)]
        .map((match) => match[1] === 'all' ? RUN_WIDE_GUIDANCE_TARGET : match[1]);
      return new Set(targets).size === 1 ? targets[0] : undefined;
    })();
    if (userInput) {
      this.observations.push(`User guidance received: "${userInput.slice(0, 100)}"`);
      // Preserve the operator's exact text in the audit ledger, but quarantine
      // it until the supervisor has selected a concrete target. Delivering it
      // run-wide here races the later targeted decision and leaks stage-specific
      // instructions to every concurrently running worker.
      appendGuidanceEnvelope({
        runDir: this.runDir(),
        target: null,
        body: `[user]: ${userInput}`,
        source: 'operator',
        knownStageIds: Object.keys(state.stages),
      });
      log.info({ runId: this.runId }, 'User input received and queued for targeted guidance routing');
      this.writeProgress();
    }

    // Find running stages
    const runningStages = Object.entries(state.stages)
      .filter(([, s]) => isRunningStageStatus(s.status))
      .map(([id]) => id);

    // Freeze the rejection authority before reading any prompt evidence. If
    // an output/verdict/metric changes during tail collection, artifact scan,
    // prompt assembly, or the model call, act()'s fresh comparison suppresses
    // REJECT instead of binding a judgement to bytes the assessor never saw.
    const observedEvidenceBindings = new Map<string, SupervisorEvidenceBinding>();
    for (const [stageId, fallback] of Object.entries(state.stages)) {
      try {
        const binding = computeSupervisorEvidenceBinding(
          this.runDir(),
          stageId,
          this.authoritativeStageStatus(stageId, fallback),
        );
        if (binding) observedEvidenceBindings.set(stageId, binding);
      } catch { /* a racing artifact cannot become reject authority */ }
    }

    // Read and ACCUMULATE live.log tails across cheap heartbeats. The previous
    // implementation advanced byte offsets every 30s, so a 180s LLM cadence
    // would otherwise see only the final 30s and miss the wrong-direction arc.
    const tails = this.readStageTails(runningStages, state);
    const totalDelta = [...tails.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    this.accumulatedOutputBytes += totalDelta;
    for (const [stageId, text] of tails) {
      const accumulated = (this.pendingTails.get(stageId) ?? '') + text;
      this.pendingTails.set(stageId, accumulated.slice(-this.config.tailBytes));
    }

    // Stage transitions are anomaly signals and therefore bypass routine cadence.
    const currentSnapshot: Record<string, string> = {};
    for (const [id, s] of Object.entries(state.stages)) currentSnapshot[id] = s.status;
    const transitionParts: string[] = [];
    const transitionedStageIds = new Set<string>();
    const allStageIds = new Set([...Object.keys(this.prevStageStatusSnapshot), ...Object.keys(currentSnapshot)]);
    for (const id of allStageIds) {
      const before = this.prevStageStatusSnapshot[id] ?? 'absent';
      const after = currentSnapshot[id] ?? 'absent';
      if (before !== after) {
        transitionParts.push(`${id}:${before}>${after}`);
        transitionedStageIds.add(id);
      }
    }
    this.prevStageStatusSnapshot = currentSnapshot;

    // === GAP-2: deterministic no-progress watchdog ===
    // BEFORE the idle / minDeltaBytes early-returns below (which would otherwise skip the
    // whole tick on a quiet run — the exact condition under which a stage silently hangs).
    // This fires the SAME abort_<stage> signal the LLM ABORT verdict uses, but
    // deterministically, independent of the model: a stage that has shown NO progress
    // signal (new live.log bytes, new artifact, or a stage transition) for
    // config.stuckThresholdMs is killed and left to the retry machinery.
    let stalledStageIds: string[];
    const stageFacts = new Map<string, StageExecutionFacts>();
    {
      const now = Date.now();
      const artifactCutoff = this.watchdogLastArtifactCheckMs || (now - this.config.stuckThresholdMs);
      this.watchdogLastArtifactCheckMs = now;
      const projectCommit = this.readProjectCommit();
      const progressedStageIds = new Set<string>();
      for (const stageId of runningStages) {
        const stageStatus = this.authoritativeStageStatus(stageId, state.stages[stageId]);
        const facts = this.inspectFacts(
          stageId,
          stageStatus,
          artifactCutoff,
          state.baseCommit,
          projectCommit,
        );
        stageFacts.set(stageId, facts);
        const attemptKey = `${stageId}:${facts.attemptIndex ?? 'unknown'}:${facts.attemptStartedAt ?? 'unknown'}`;
        const attemptChanged = this.watchdogAttemptKeys[stageId] !== attemptKey;
        this.watchdogAttemptKeys[stageId] = attemptKey;
        const stageProgressed = (tails.get(stageId)?.length ?? 0) > 0
          || transitionedStageIds.has(stageId)
          || attemptChanged
          || facts.artifactProgressThisTick
          || facts.protectedFromIdleAbort;
        if (stageProgressed) progressedStageIds.add(stageId);
      }
      const detected = detectStalledStages({
        runningStages,
        progressedStageIds,
        lastProgressMs: this.stageLastProgressMs,
        now,
        thresholdMs: this.config.stuckThresholdMs,
      });
      this.stageLastProgressMs = detected.nextLastProgressMs;
      stalledStageIds = detected.stalledStageIds;
      const activeAttemptKeys = new Set(runningStages.map((stageId) => {
        const facts = stageFacts.get(stageId)!;
        return `${stageId}:${facts.attemptIndex ?? 'unknown'}:${facts.attemptStartedAt ?? 'unknown'}`;
      }));
      for (const aborted of [...this.watchdogAbortedStages]) {
        if (!activeAttemptKeys.has(aborted)) this.watchdogAbortedStages.delete(aborted);
      }
      for (const stageId of stalledStageIds) {
        const facts = stageFacts.get(stageId)!;
        const attemptKey = `${stageId}:${facts.attemptIndex ?? 'unknown'}:${facts.attemptStartedAt ?? 'unknown'}`;
        if (this.watchdogAbortedStages.has(attemptKey)) continue;
        const stalledMs = now - (this.stageLastProgressMs[stageId] ?? now);
        const abort = this.writeVerifiedAbort(
          stageId,
          'watchdog',
          { kind: 'idle', stalledMs },
          undefined,
          artifactCutoff,
        );
        if (abort.written) {
          this.watchdogAbortedStages.add(attemptKey);
          log.warn({ runId: this.runId, stageId, stalledMs }, 'Watchdog ABORT — stage made no progress past threshold');
          this.observations.push(`Watchdog aborted stuck stage '${stageId}' (${Math.round(stalledMs / 1000)}s no progress)`);
        } else {
          log.warn({ runId: this.runId, stageId, reason: abort.reason }, 'Watchdog ABORT suppressed by verified stage facts');
        }
      }
    }

    // Scan artifacts on every heartbeat, retaining them until the next semantic
    // call. Failed gates are immediate anomaly signals; ordinary artifacts stay
    // in the pending prompt for the next routine call.
    const recentArtifacts = this.readRecentArtifacts();
    for (const artifact of recentArtifacts) {
      this.pendingArtifacts.set(artifact.path, artifact);
      this.artifactEvidenceDigests.set(
        artifact.path,
        createHash('sha256').update(artifact.content).digest('hex'),
      );
    }

    const detectedSignals = detectSupervisorAnomalySignals({
      state,
      stageTransitionFingerprint: transitionParts.length > 0 ? transitionParts.sort().join('|') : undefined,
      stalledStageIds,
      recentArtifacts,
      userInput,
      pendingApprovalFingerprint: this.pendingApprovalFingerprint(),
    }).map((signal) => (
      signal.startsWith('user_input:')
      || signal.startsWith('gate_failed:')
      || signal.startsWith('stage_transition:')
    ) ? `${signal}:tick${this.tickCount}` : signal);
    const anomalySignals = detectedSignals.filter((signal) => !this.seenAnomalySignals.has(signal));
    for (const signal of anomalySignals) this.seenAnomalySignals.add(signal);

    const now = Date.now();
    const trigger = selectSupervisorAssessmentTrigger({
      anomalySignals,
      runningStageCount: runningStages.length,
      accumulatedOutputBytes: this.accumulatedOutputBytes,
      minDeltaBytes: this.config.minDeltaBytes,
      now,
      lastRoutineAssessmentAt: this.lastRoutineAssessmentAt,
      routineAssessmentIntervalMs: this.config.routineAssessmentIntervalMs,
      routineAssessmentsThisIteration: this.iterationAssessmentCount,
      maxRoutineAssessmentsPerIteration: this.config.maxAssessmentsPerIteration,
      cooldownUntil: this.lastActionTime + this.config.cooldownAfterActionMs,
    });
    if (trigger === 'none') {
      this.writeProgress();
      return;
    }

    let extraContext = anomalySignals.length > 0
      ? `\n\n# Immediate anomaly signals\n${anomalySignals.map((signal) => `- ${signal}`).join('\n')}\nAssess now; this call bypassed routine throttling.`
      : '';
    if (userInput) {
      extraContext += `\n\n# User Guidance (just received)\n${userInput}\nIncorporate this into your assessment.`;
    }
    const assessmentTails = new Map(this.pendingTails);
    const assessmentArtifacts = [...this.pendingArtifacts.values()];
    const evidenceDigest = supervisorEvidenceDigest({
      // The prompt contains only deltas, but novelty is cumulative. Otherwise
      // clearing a delivered tail would itself look like new evidence and
      // trigger a second static WAIT call.
      tails: new Map(runningStages.map((stageId) => [
        stageId,
        this.stageEvidenceDigests.get(stageId) ?? this.attemptEvidenceKeys.get(stageId) ?? stageId,
      ])),
      artifacts: [...this.artifactEvidenceDigests].map(([path, content]) => ({ path, content })),
      // Edge-triggered anomalies remain part of the cumulative semantic state
      // after delivery. Otherwise their disappearance on the next heartbeat
      // would itself look novel and spend another call concluding WAIT.
      anomalySignals: [...this.seenAnomalySignals],
      attemptKeys: runningStages.map((stageId) => {
        const facts = stageFacts.get(stageId);
        return `${stageId}:${facts?.attemptIndex ?? 'unknown'}:${facts?.attemptStartedAt ?? 'unknown'}`;
      }),
    });
    if (trigger === 'routine' && evidenceDigest === this.lastAssessmentEvidenceDigest) {
      // Advance cadence without spending a semantic-call budget slot. The
      // evidence was already assessed, but a later novel byte/artifact/attempt
      // must still retain the iteration's remaining review capacity.
      this.lastRoutineAssessmentAt = now;
      this.writeProgress();
      return;
    }
    if (trigger === 'routine') {
      this.lastRoutineAssessmentAt = now;
      this.iterationAssessmentCount++;
    }
    const prompt = this.buildAssessmentPrompt(assessmentTails, state, runningStages, assessmentArtifacts, stageFacts) + extraContext;
    const assessmentStartedAt = Date.now();
    let assessment = await this.assess(prompt);
    this.accumulatedOutputBytes = 0;
    this.pendingTails.clear();
    this.pendingArtifacts.clear();
    if (!assessment) {
      // Track consecutive failures so a silently-broken supervisor (e.g. an
      // adapter that keeps returning unparseable output) becomes observable
      // instead of just emitting zero ticks.
      this.consecutiveAssessFailures++;
      if (this.consecutiveAssessFailures >= Supervisor.DEGRADED_AFTER_FAILURES) {
        try {
          writeFileSync(join(this.signalDir(), 'supervisor_degraded.json'), JSON.stringify({
            runId: this.runId,
            consecutiveFailures: this.consecutiveAssessFailures,
            timestamp: new Date().toISOString(),
            note: 'Supervisor assess() returned null repeatedly — it is NOT steering the run. Check adapter output / model availability.',
          }, null, 2), 'utf-8');
        } catch { /* non-critical */ }
        log.warn({ runId: this.runId, consecutiveFailures: this.consecutiveAssessFailures }, 'Supervisor DEGRADED — repeated assessment failures, not steering the run');
      }
      this.writeProgress();
      return;
    }
    this.lastAssessmentEvidenceDigest = evidenceDigest;
    if (userInput && addressedOperatorTarget && assessment.verdict === 'GUIDE') {
      const targetIsKnown = addressedOperatorTarget === RUN_WIDE_GUIDANCE_TARGET
        || Object.hasOwn(state.stages, addressedOperatorTarget);
      assessment = targetIsKnown
        ? { ...assessment, targetStage: addressedOperatorTarget }
        : {
            verdict: 'WAIT',
            targetStage: null,
            guidance: null,
            reason: `Operator guidance remains quarantined because addressed stage ${addressedOperatorTarget} is not admitted in this run.`,
          };
    }
    // Recovered: a successful assessment clears the degraded state.
    if (this.consecutiveAssessFailures > 0) {
      this.consecutiveAssessFailures = 0;
      try { const p = join(this.signalDir(), 'supervisor_degraded.json'); if (existsSync(p)) unlinkSync(p); } catch { /* non-critical */ }
    }

    // Validate any consequential verdict against fresh on-disk facts before it
    // becomes an action, log entry, dashboard state, or signal.
    const effectiveAssessment = await this.act(
      assessment,
      assessmentStartedAt,
      userInput ? 'operator' : 'supervisor',
      observedEvidenceBindings,
    );
    this.recordEffectiveAssessment(effectiveAssessment);

    // Keep WAIT streak telemetry, but do not let it slow the 30s anomaly heartbeat.
    if (effectiveAssessment.verdict === 'WAIT') {
      this.consecutiveWaits++;
    } else {
      this.consecutiveWaits = 0;
    }

    // Record action
    const action: SupervisorAction = {
      timestamp: new Date().toISOString(),
      tick: this.tickCount,
      assessment: effectiveAssessment,
      runningStages,
      targetAttemptIndex: effectiveAssessment.targetStage
        ? currentRunningAttempt(this.authoritativeStageStatus(
            effectiveAssessment.targetStage,
            state.stages[effectiveAssessment.targetStage] ?? { status: STAGE_STATUS.PENDING, retries: 0 },
          ))?.index
        : undefined,
      source: userInput ? 'operator' : 'supervisor',
    };
    this.actions.push(action);

    // Log
    this.appendLog(action);

    // Record observation
    if (effectiveAssessment.verdict === 'WAIT') {
      this.observations.push(effectiveAssessment.reason);
    } else {
      this.observations.push(`${effectiveAssessment.verdict}: ${effectiveAssessment.reason}`);
      if (effectiveAssessment.verdict === 'GUIDE' && effectiveAssessment.guidance) {
        this.decisions.push(`Guided ${effectiveAssessment.targetStage}: ${effectiveAssessment.guidance.slice(0, 100)}`);
      } else if (effectiveAssessment.verdict === 'REPLAN') {
        this.decisions.push(`Triggered replan: ${effectiveAssessment.reason}`);
      } else if (effectiveAssessment.verdict === 'REJECT') {
        this.decisions.push(`Rejected ${effectiveAssessment.targetStage ?? 'deliverable'}: ${effectiveAssessment.reason.slice(0, 100)}`);
      } else if (effectiveAssessment.verdict === 'DONE') {
        this.decisions.push(`Goal confirmed met: ${effectiveAssessment.reason}`);
      }
      log.info({ tick: this.tickCount, verdict: effectiveAssessment.verdict, target: effectiveAssessment.targetStage, reason: effectiveAssessment.reason }, 'Supervisor action');
    }

    // Update progress file
    this.writeProgress();
  }

  private readStageTails(stageIds: string[], state: StoreState): Map<string, string> {
    const tails = new Map<string, string>();
    for (const stageId of stageIds) {
      const logPath = join(this.runDir(), 'stages', stageId, 'live.log');
      if (!existsSync(logPath)) continue;

      try {
        const stat = statSync(logPath);
        const attempt = currentRunningAttempt(state.stages[stageId]);
        const generation = readAttemptGeneration(this.runDir(), stageId);
        const generationMatches = Boolean(attempt && generation
          && generation.attemptIndex === attempt.index
          && generation.attemptStartedAt === attempt.startedAt);
        const attemptKey = generationMatches
          ? `${stageId}:${generation!.attemptIndex}:${generation!.attemptStartedAt}`
          : `${stageId}:unbound:${attempt?.index ?? 'unknown'}:${attempt?.startedAt ?? 'unknown'}`;
        const previousKey = this.attemptEvidenceKeys.get(stageId);
        if (previousKey !== attemptKey) {
          this.attemptEvidenceKeys.set(stageId, attemptKey);
          this.pendingTails.delete(stageId);
          // Without a current generation record, fail closed by observing only
          // future appends. Never inherit a prior attempt's tail.
          const boundary = generationMatches ? generation!.segmentStart : stat.size;
          this.attemptSegmentFloors.set(stageId, boundary);
          this.byteOffsets.set(stageId, boundary);
          this.stageEvidenceDigests.set(stageId, createHash('sha256').update(attemptKey).digest('hex'));
        }
        const floor = this.attemptSegmentFloors.get(stageId) ?? stat.size;
        const prevOffset = Math.max(floor, this.byteOffsets.get(stageId) ?? floor);
        const bytesToRead = Math.min(this.config.tailBytes, stat.size - prevOffset);
        if (bytesToRead <= 0) continue;

        const fd = openSync(logPath, 'r');
        const buf = Buffer.alloc(bytesToRead);
        const bytesRead = readSync(fd, buf, 0, bytesToRead, prevOffset);
        closeSync(fd);

        const delta = buf.subarray(0, bytesRead);
        this.byteOffsets.set(stageId, prevOffset + bytesRead);
        const previousDigest = this.stageEvidenceDigests.get(stageId) ?? attemptKey;
        this.stageEvidenceDigests.set(stageId, createHash('sha256').update(previousDigest).update(delta).digest('hex'));
        tails.set(stageId, delta.toString('utf-8'));
      } catch { /* file access error, skip */ }
    }
    return tails;
  }

  private buildAssessmentPrompt(
    tails: Map<string, string>,
    state: StoreState,
    runningStages: string[],
    recentArtifacts: Array<{ path: string; content: string }>,
    stageFacts: ReadonlyMap<string, StageExecutionFacts>,
  ): string {
    const parts: string[] = [];

    parts.push(`# Iteration ${state.currentIteration ?? 1}/${state.maxIterations ?? 5}`);

    // Running stages with output (8 KB per stage so silent fallbacks are visible in stdout)
    parts.push('\n# Running Stages');
    for (const stageId of runningStages) {
      const ss = state.stages[stageId];
      const facts = stageFacts.get(stageId);
      const elapsed = facts?.attemptStartedAt ? Math.round((Date.now() - new Date(facts.attemptStartedAt).getTime()) / 1000) : 0;
      const tail = tails.get(stageId) ?? '(no output yet)';
      parts.push(`\n## ${stageId} — ${elapsed}s elapsed`);
      if (facts) parts.push(`Verified facts: ${describeStageExecutionFacts(facts)}.`);
      parts.push(`\`\`\`\n${tail.slice(-8000)}\n\`\`\``);
    }

    // Recent JSON artifacts: capability reports, gate verdicts, metric files modified
    // since the previous tick. Catches silent fallbacks (e.g. "selected_provider falls back")
    // that show up in JSON files but not in live.log stdout.
    if (recentArtifacts.length > 0) {
      parts.push('\n# Recent Artifacts (modified since last tick)');
      parts.push('These JSON files were written by stages and may signal silent fallbacks, blockers, or completion. Read them carefully — gates lying with `pass:true` while `value<threshold` is a known failure mode.');
      for (const { path, content } of recentArtifacts) {
        parts.push(`\n## ${path}\n\`\`\`json\n${content}\n\`\`\``);
      }
    }

    // Completed stages summary
    const completed = Object.entries(state.stages)
      .filter(([, s]) => isSettledStageStatus(s.status))
      .map(([id, s]) => `- ${id}: ${s.status}${s.error ? ` (${s.error})` : ''}`);
    if (completed.length > 0) {
      parts.push(`\n# Completed Stages\n${completed.join('\n')}`);
    }

    const currentStatuses = new Map(runningStages.map((stageId) => {
      const fallback = state.stages[stageId];
      return [stageId, fallback ? this.authoritativeStageStatus(stageId, fallback) : undefined] as const;
    }));
    const guidanceHistory = summarizeSupervisorGuidanceHistory(
      this.actions.filter((action) => (
        (action.source ?? 'supervisor') === 'supervisor'
        && action.assessment.targetStage !== null
        && actionAttemptIndex(action, currentStatuses.get(action.assessment.targetStage))
          === currentRunningAttempt(currentStatuses.get(action.assessment.targetStage))?.index
      )),
      runningStages,
    );
    if (guidanceHistory) {
      parts.push(`\n# Cumulative GUIDE History\n${guidanceHistory}\nRepeatedly unheeded concrete guidance may justify ABORT even when the stage remains highly productive; output volume alone does not establish correctness.`);
    }

    // Previous supervisor actions (last 3)
    if (this.actions.length > 0) {
      const recent = this.actions.slice(-3).map(a =>
        `- Tick ${a.tick}: ${a.assessment.verdict}${a.assessment.targetStage ? ` → ${a.assessment.targetStage}` : ''} — ${a.assessment.reason}`
      );
      parts.push(`\n# Previous Supervisor Actions\n${recent.join('\n')}`);
    }

    return parts.join('\n');
  }

  /**
   * Scan the run dir for JSON artifacts that were modified since the last assessment.
   * Caps results so the assessment prompt stays bounded.
   */
  private lastArtifactScanAt: number = 0;
  private readRecentArtifacts(): Array<{ path: string; content: string }> {
    const runDirAbs = this.runDir();
    const since = this.lastArtifactScanAt;
    const now = Date.now();
    this.lastArtifactScanAt = now;
    // First tick: look back one poll interval so the first assessment isn't empty.
    const cutoff = since > 0 ? since : now - Math.max(this.config.pollIntervalMs * 2, 30_000);

    const interesting = (name: string) =>
      /capability_report\.json$/.test(name) ||
      /^verdict[_.].*\.json$/.test(name) ||
      /^metric\.json$/.test(name) ||
      /capability_blocker\.json$/.test(name);

    const walk = (dir: string, depth: number, acc: Array<{ path: string; mtime: number }>) => {
      if (depth > 4) return;
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[]; } catch { return; }
      for (const e of entries) {
        if (e.name === 'codex_home' || e.name === 'node_modules' || e.name === '.tmp') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p, depth + 1, acc);
        } else if (e.isFile() && interesting(e.name)) {
          try {
            const st = statSync(p);
            if (st.mtimeMs >= cutoff) acc.push({ path: p, mtime: st.mtimeMs });
          } catch { /* skip */ }
        }
      }
    };

    const found: Array<{ path: string; mtime: number }> = [];
    walk(runDirAbs, 0, found);

    // Most recent first, cap at 5 files, 4 KB each to keep prompt bounded.
    found.sort((a, b) => b.mtime - a.mtime);
    const top = found.filter(({ path }) => !isEnginePlaceholderMetric(path)).slice(0, 5);
    return top.map(({ path }) => {
      let content: string;
      try {
        const raw = readFileSync(path, 'utf-8');
        content = raw.length > 4000 ? raw.slice(0, 4000) + '\n... [truncated]' : raw;
      } catch { content = '[unreadable]'; }
      return { path: relative(runDirAbs, path), content };
    });
  }

  private async assess(prompt: string): Promise<SupervisorAssessment | null> {
    const agentConfig: AgentConfig = {
      name: 'supervisor',
      description: 'Workflow supervisor',
      model: this.config.model,
      reasoning_effort: this.config.reasoningEffort,
      tools: [],
      prompt: buildSupervisorRolePrompt(this.config.stuckThresholdMs, this.taskDescription),
    };

    const startedAt = new Date().toISOString();
    let result: RunResult;
    try {
      result = await this.adapter.run(prompt, agentConfig, {
        timeout_ms: 30000,
        workDir: this.projectDir,
        runDir: this.runDir(),
        stageId: '_supervisor',
      });
    } catch (err) {
      this.recordAssessmentUsage(startedAt, undefined, null, err instanceof Error ? err.message : String(err));
      log.warn({ err }, 'Supervisor assessment call failed');
      return null;
    }

    if (result.exitCode !== 0) {
      this.recordAssessmentUsage(startedAt, result, null, `adapter exit ${result.exitCode}`);
      log.warn({ exitCode: result.exitCode }, 'Supervisor assessment returned non-zero');
      return null;
    }

    // Parse the verdict (codex echoes the prompt+template before the real answer;
    // parseSupervisorVerdict scans last-to-first to skip the echoed template).
    const verdict = parseSupervisorVerdict(result.output);
    if (!verdict) {
      this.recordAssessmentUsage(startedAt, result, null, 'unparseable supervisor verdict');
      log.warn({ outputPreview: result.output.slice(-500) }, 'No parseable supervisor verdict in response');
      return null;
    }
    this.recordAssessmentUsage(startedAt, result, verdict);
    return verdict;
  }

  private writeVerifiedAbort(
    stageId: string,
    source: AbortSignalSource,
    basis: AbortBasis,
    unverifiedAssessmentReason?: string,
    progressSinceMs = Date.now(),
  ): VerifiedAbortResult {
    let state: StoreState;
    try {
      state = readRunState(this.projectDir, this.runId);
    } catch {
      return { written: false, reason: `ABORT suppressed for ${stageId}: no readable run state observed.` };
    }
    const status = state.stages[stageId];
    if (!status || !isRunningStageStatus(status.status)) {
      return { written: false, reason: `ABORT suppressed for ${stageId}: no active running stage observed.` };
    }
    const authoritativeStatus = this.authoritativeStageStatus(stageId, status);
    if (!isRunningStageStatus(authoritativeStatus.status)) {
      return { written: false, reason: `ABORT suppressed for ${stageId}: no active running execution observed.` };
    }
    const facts = this.inspectFacts(stageId, authoritativeStatus, progressSinceMs, state.baseCommit);
    const factSummary = describeStageExecutionFacts(facts);
    if (facts.attemptIndex === undefined) {
      return { written: false, reason: `ABORT suppressed for ${stageId}: ${factSummary}.` };
    }
    if (facts.finalizing) {
      return {
        written: false,
        reason: `ABORT suppressed for ${stageId}: ${factSummary}; the current execution is in its finalization window.`,
      };
    }
    if (basis.kind === 'idle' && facts.protectedFromIdleAbort) {
      return {
        written: false,
        reason: `Idle ABORT suppressed for ${stageId}: durable current-execution completion evidence exists; ${factSummary}.`,
      };
    }
    if (basis.kind === 'idle' && facts.artifactProgressThisTick) {
      this.stageLastProgressMs[stageId] = Date.now();
      return {
        written: false,
        reason: `Idle ABORT suppressed for ${stageId}: durable artifact progress was observed during final verification; ${factSummary}.`,
      };
    }

    let verifiedBasis: string;
    if (basis.kind === 'idle') {
      const lastProgressAt = this.stageLastProgressMs[stageId];
      const verifiedIdleMs = lastProgressAt === undefined ? -1 : Date.now() - lastProgressAt;
      if (verifiedIdleMs < this.config.stuckThresholdMs) {
        return {
          written: false,
          reason: `Idle ABORT suppressed for ${stageId}: verified idle duration is unavailable or below the configured threshold; ${factSummary}.`,
        };
      }
      verifiedBasis = `no verified live/artifact/transition progress for ${Math.round(verifiedIdleMs / 1000)}s (threshold ${Math.round(this.config.stuckThresholdMs / 1000)}s)`;
    } else {
      if (basis.guideCount < 2) {
        return {
          written: false,
          reason: `Direction ABORT suppressed for ${stageId}: only ${basis.guideCount} prior GUIDE decision(s) observed; ${factSummary}.`,
        };
      }
      verifiedBasis = `${basis.guideCount} prior GUIDE decisions observed for the same running stage`;
    }

    const reason = `${source === 'watchdog' ? 'Watchdog' : 'Supervisor'} ABORT verified for ${stageId} attempt ${facts.attemptIndex}: ${verifiedBasis}; ${factSummary}.`;
    const signal: StageAbortSignal = {
      version: ABORT_SIGNAL_VERSION,
      stageId,
      attemptIndex: facts.attemptIndex,
      reason,
      timestamp: new Date().toISOString(),
      source,
      ...(unverifiedAssessmentReason
        ? { unverifiedAssessmentReason: unverifiedAssessmentReason.slice(0, 500) }
        : {}),
    };
    try {
      mkdirSync(this.signalDir(), { recursive: true });
      atomicWrite(join(this.signalDir(), `abort_${stageId}.json`), JSON.stringify(signal, null, 2));
      return { written: true, reason };
    } catch {
      return { written: false, reason: `ABORT suppressed for ${stageId}: the owned signal could not be persisted; ${factSummary}.` };
    }
  }

  private async act(
    assessment: SupervisorAssessment,
    progressSinceMs = Date.now(),
    source: 'supervisor' | 'operator' = 'supervisor',
    observedEvidenceBindings?: ReadonlyMap<string, SupervisorEvidenceBinding>,
  ): Promise<SupervisorAssessment> {
    const signalDir = this.signalDir();

    switch (assessment.verdict) {
      case 'WAIT':
        return assessment;

      case 'GUIDE':
        if (assessment.targetStage && assessment.guidance) {
          let knownStageIds: string[] = [];
          try { knownStageIds = Object.keys(readRunState(this.projectDir, this.runId).stages); } catch { /* quarantine below */ }
          const envelope = appendGuidanceEnvelope({
            runDir: this.runDir(),
            target: assessment.targetStage,
            body: assessment.guidance,
            source,
            knownStageIds,
          });
          if (!envelope.quarantined && assessment.targetStage !== RUN_WIDE_GUIDANCE_TARGET) {
            const guidancePath = join(this.runDir(), 'stages', assessment.targetStage, 'guidance.md');
            mkdirSync(join(this.runDir(), 'stages', assessment.targetStage), { recursive: true });
            appendFileSync(guidancePath, `${existsSync(guidancePath) ? '\n\n' : ''}${renderGuidanceEnvelope(envelope)}\n`, 'utf-8');
          }
        }
        this.lastActionTime = Date.now();
        return assessment;

      case 'ABORT':
        if (!assessment.targetStage) {
          return {
            verdict: 'WAIT', targetStage: null, guidance: null,
            reason: 'ABORT suppressed: the assessment named no target stage.',
          };
        }
        {
          let targetAttemptIndex: number | undefined;
          let targetStatus: StageStatus | undefined;
          try {
            const state = readRunState(this.projectDir, this.runId);
            const status = state.stages[assessment.targetStage];
            if (status) {
              targetStatus = this.authoritativeStageStatus(assessment.targetStage, status);
              targetAttemptIndex = currentRunningAttempt(targetStatus)?.index;
            }
          } catch { /* writeVerifiedAbort performs the authoritative fail-closed check */ }
          const guideCount = this.actions.filter((action) => (
            action.assessment.verdict === 'GUIDE'
            && action.assessment.targetStage === assessment.targetStage
            && (action.source ?? 'supervisor') === 'supervisor'
            && actionAttemptIndex(action, targetStatus) === targetAttemptIndex
          )).length;
          const lastProgressAt = this.stageLastProgressMs[assessment.targetStage];
          const idleMs = lastProgressAt === undefined ? -1 : Date.now() - lastProgressAt;
          const basis: AbortBasis = idleMs >= this.config.stuckThresholdMs
            ? { kind: 'idle', stalledMs: idleMs }
            : { kind: 'repeated_guidance', guideCount };
          const abort = this.writeVerifiedAbort(
            assessment.targetStage,
            'supervisor',
            basis,
            assessment.reason,
            progressSinceMs,
          );
          if (!abort.written) {
            return {
              verdict: 'WAIT', targetStage: assessment.targetStage, guidance: null,
              reason: abort.reason,
            };
          }
          this.lastActionTime = Date.now();
          return { ...assessment, reason: abort.reason };
        }

      case 'REPLAN':
        writeFileSync(join(signalDir, 'replan.json'),
          JSON.stringify({ reason: assessment.reason, timestamp: new Date().toISOString() }), 'utf-8');
        this.lastActionTime = Date.now();
        return assessment;

      case 'REJECT':
        // Reject an emitted deliverable that does not meet its declared work.
        // The scheduler-side consumer re-pends the target stage so the work is
        // re-done rather than accepted. Bounded there by a max reject count.
        if (assessment.targetStage) {
          let current: SupervisorEvidenceBinding | undefined;
          try {
            const state = readRunState(this.projectDir, this.runId);
            const status = state.stages[assessment.targetStage];
            if (status) current = computeSupervisorEvidenceBinding(this.runDir(), assessment.targetStage, this.authoritativeStageStatus(assessment.targetStage, status));
          } catch { /* fail closed below */ }
          // Production assessments supply the generation captured immediately
          // before the model call. Direct unit callers retain the historical
          // immediate-check behavior by omitting the map.
          const observed = observedEvidenceBindings
            ? observedEvidenceBindings.get(assessment.targetStage)
            : current;
          if (!observed?.emittedDeliverable) {
            return {
              verdict: 'WAIT',
              targetStage: assessment.targetStage,
              guidance: null,
              reason: `REJECT suppressed for ${assessment.targetStage}: no emitted deliverable was bound to the evidence assessed for the current execution.`,
            };
          }
          if (
            !current?.emittedDeliverable
            || current.stageId !== observed.stageId
            || current.attemptIndex !== observed.attemptIndex
            || current.attemptStartedAt !== observed.attemptStartedAt
            || current.generation !== observed.generation
          ) {
            return {
              verdict: 'WAIT',
              targetStage: assessment.targetStage,
              guidance: null,
              reason: `REJECT suppressed for ${assessment.targetStage}: its attempt evidence changed while the assessment was running.`,
            };
          }
          const timestamp = new Date().toISOString();
          writeFileSync(join(signalDir, `reject_${assessment.targetStage}.json`),
            JSON.stringify({ version: 2, stage: assessment.targetStage, reason: assessment.reason, timestamp, evidence: observed }), 'utf-8');
          recordRunEvent(this.projectDir, this.runId, {
            type: 'supervisor_reject_requested', runId: this.runId, timestamp,
            stageId: assessment.targetStage, attemptIndex: observed.attemptIndex,
            attemptStartedAt: observed.attemptStartedAt, evidenceGeneration: observed.generation,
            detail: assessment.reason, source: 'supervisor', level: 'warning',
          });
        } else {
          return {
            verdict: 'WAIT', targetStage: null, guidance: null,
            reason: 'REJECT suppressed: the assessment named no target stage, so no attempt-bound evidence can be identified.',
          };
        }
        this.lastActionTime = Date.now();
        return assessment;

      case 'DONE':
        writeFileSync(join(signalDir, 'goal_met.json'),
          JSON.stringify({ reason: assessment.reason, timestamp: new Date().toISOString() }), 'utf-8');
        this.lastActionTime = Date.now();
        return assessment;
    }
  }

  private appendLog(action: SupervisorAction): void {
    const entry = [
      `## Tick ${action.tick} — ${action.timestamp}`,
      `Running: ${action.runningStages.join(', ')}`,
      `Source: ${action.source ?? 'supervisor (legacy)'}${action.targetAttemptIndex === undefined ? '' : ` · execution ${action.targetAttemptIndex}`}`,
      `Verdict: **${action.assessment.verdict}**${action.assessment.targetStage ? ` → ${action.assessment.targetStage}` : ''}`,
      `Reason: ${action.assessment.reason}`,
    ];
    if (action.assessment.guidance) {
      entry.push(`Guidance: ${action.assessment.guidance}`);
    }
    entry.push('');
    appendFileSync(this.logPath(), entry.join('\n') + '\n');
  }
}
