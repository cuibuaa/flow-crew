import { appendFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { listRunIdsFromIndex, upsertRunIndex } from './run-index.js';
import { parseChecksFromBrief, runAllChecks } from './reality-gate/index.js';
import type { RealityGateReport } from './reality-gate/types.js';

export interface StageStatus {
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
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
 * When a phase terminates via phase_complete and no explicit
 * post_terminate_hook was set on that state, the scheduler invokes the
 * default advance script (skills/program_advance.sh installed to the project)
 * with FC_PROGRAM_* env vars added.
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
  /** Ship + stop when running-best ≥ this value (the headline target, e.g. HODL). */
  beat?: number;
  /** Stop after this many research rounds (phases). */
  maxRounds?: number;
  /** Stop when cumulative wall hours reach this. */
  maxWallHours?: number;
  /** Stop after N consecutive rounds with no improvement to running-best. */
  haltAfterNoImprovement?: number;
}
export interface ResearchConfig {
  /** Entering running-best the loop builds on (the baseline metric value). */
  baseline: number;
  /** Higher metric is better (default true). */
  higherIsBetter?: boolean;
  policy: ResearchPolicy;
  stop?: ResearchStopConditions;
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
}

export interface StoreState {
  runId: string;
  workflowName: string;
  projectDir: string;
  /** git HEAD SHA captured at run start, used to compute a real diff in the run summary. Absent when projectDir is not a git repo. */
  baseCommit?: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'awaiting_approval' | 'shipped' | 'ceiling_hit' | 'escalated' | 'reality_gate_failed' | 'phase_complete' | 'stopped';
  /** Map of status → terminal-state file paths/floor (set from brief frontmatter). */
  terminalStates?: TerminalStatesConfig;
  /** Filename (basename) of the terminal file that triggered termination — used for handoff to /ship follow-ups. */
  terminalArtifact?: string;
  /** Multi-phase program config (set from brief `program:` block). */
  program?: ProgramConfig;
  /** Research-mode config (set from brief `research:` block). */
  research?: ResearchConfig;
  stages: Record<string, StageStatus>;
  startedAt: string;
  completedAt?: string;
  plan?: unknown[];
  dispatchedStages?: unknown[];
  taskDescription?: string;
  currentIteration?: number;
  maxIterations?: number;
  maxRetries?: number;
  autoApproveRetries?: boolean;
  autoApprove?: boolean;
  supervise?: boolean;
  timeoutMs?: number;
  campaignTriggers?: CampaignTriggers;
  failureReason?: string;
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
    type: 'regression' | 'plateau' | 'repeated_failure';
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
    alertType: 'regression' | 'plateau' | 'repeated_failure';
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

export const FC_DIR = '.fc';
export const FC_GLOBAL_DIR = join(homedir(), FC_DIR);

export function runsRoot(_projectDir?: string): string {
  return join(FC_GLOBAL_DIR, 'runs');
}

export function campaignsRoot(): string {
  return join(FC_GLOBAL_DIR, 'campaigns');
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

/** Single source of truth for "this run has reached a terminal state". */
export function isTerminalRunStatus(status: string): boolean {
  return status === 'complete'
    || status === 'failed'
    || status === 'shipped'
    || status === 'ceiling_hit'
    || status === 'escalated'
    || status === 'reality_gate_failed'
    || status === 'phase_complete'
    || status === 'stopped';
}

function isRealityGatedTerminal(status: string): boolean {
  return status === 'complete' || status === 'shipped' || status === 'ceiling_hit';
}

function failureMarkdown(report: RealityGateReport, targetStatus: string): string {
  const failed = report.results.filter((item) => !item.pass);
  return [
    `# Reality Gate Failed`,
    ``,
    `Requested terminal status: ${targetStatus}`,
    `Checked at: ${report.checkedAt}`,
    ``,
    `## Failed checks`,
    ...(failed.length === 0 ? ['- none'] : failed.map((item) => `- ${item.name} (${item.type}): ${item.details}`)),
    ``,
  ].join('\n');
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
  if (!existsSync(briefPath)) return { allowed: true, state };
  const checks = parseChecksFromBrief(briefPath);
  if (checks.length === 0) return { allowed: true, state };
  const report = await runAllChecks(checks, { taskDir: dir, projectDir, briefPath });
  atomicWrite(join(dir, '.reality-gate.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.pass) return { allowed: true, state, report };
  const next: StoreState = {
    ...state,
    status: 'reality_gate_failed',
    failureReason: `Reality gate blocked terminal status ${targetStatus}`,
    completedAt: new Date().toISOString(),
  };
  appendFileSync(join(dir, '.reality-gate.failures.md'), failureMarkdown(report, targetStatus), 'utf-8');
  writeRunState(projectDir, runId, next);
  return { allowed: false, state: next, report };
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

/**
 * Derive a one-line display title from a task brief. Strips a leading YAML
 * frontmatter block (`--- ... ---`) so briefs that open with `research:`/etc.
 * frontmatter don't surface as a bare "---" name, then takes the first
 * meaningful line (skipping delimiters), dropping markdown heading markers.
 */
export function extractTaskTitle(desc?: string): string {
  if (!desc) return '';
  let body = desc;
  const fm = body.match(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (fm) body = body.slice(fm[0].length);
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed && trimmed !== '---' && trimmed.length > 2) {
      return trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed;
    }
  }
  return body.trim().slice(0, 80) || desc.slice(0, 80);
}

export function ensureGlobalRunsDir(): void {
  mkdirSync(join(FC_GLOBAL_DIR, 'runs'), { recursive: true });
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

function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = randomBytes(3).toString('hex');
  return `${ts}-${suffix}`;
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
  const runId = generateRunId();
  const dir = runDir(projectDir, runId);
  mkdirSync(join(dir, 'stages'), { recursive: true });
  for (const sid of stageIds) {
    mkdirSync(stageDir(projectDir, runId, sid), { recursive: true });
  }
  const stages: Record<string, StageStatus> = {};
  for (const sid of stageIds) {
    stages[sid] = { status: 'pending', retries: 0 };
  }
  const state: StoreState = {
    runId,
    workflowName,
    projectDir,
    status: 'running',
    stages,
    startedAt: new Date().toISOString(),
  };
  const baseCommit = captureGitHead(projectDir);
  if (baseCommit) state.baseCommit = baseCommit;
  atomicWrite(join(dir, 'run.json'), JSON.stringify(state, null, 2));
  try { upsertRunIndex(projectDir, state); } catch { /* index is best-effort */ }
  atomicWrite(join(dir, 'workflow.yaml'), workflowYaml);
  return { runId, runDirPath: dir };
}

export function readRunState(projectDir: string, runId: string): StoreState {
  return JSON.parse(readFileSync(join(runDir(projectDir, runId), 'run.json'), 'utf-8'));
}

export function writeRunState(projectDir: string, runId: string, state: StoreState): void {
  atomicWrite(join(runDir(projectDir, runId), 'run.json'), JSON.stringify(state, null, 2));
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
}

export function writeStageInput(
  projectDir: string,
  runId: string,
  stageId: string,
  input: string,
): void {
  atomicWrite(join(stageDir(projectDir, runId, stageId), 'input.md'), input);
}

export function writeStageOutput(
  projectDir: string,
  runId: string,
  stageId: string,
  output: string,
): void {
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
