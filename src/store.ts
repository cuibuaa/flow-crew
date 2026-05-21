import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { listRunIdsFromIndex, upsertRunIndex } from './run-index.js';

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
export interface TerminalStateEntry {
  /** File paths (relative to projectDir) that, when present, signal this status. */
  paths: string[];
  /** Optional floor — if specified, all conditions must be met before terminating. */
  floor?: TerminalStateFloor;
  /** Optional glob to count attempted research stages for floor.minAttemptedStages. */
  stageGlob?: string;
}
export type TerminalStatesConfig = Record<string, TerminalStateEntry>;

export interface StoreState {
  runId: string;
  workflowName: string;
  projectDir: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'awaiting_approval' | 'shipped' | 'ceiling_hit' | 'escalated';
  /** Map of status → terminal-state file paths/floor (set from brief frontmatter). */
  terminalStates?: TerminalStatesConfig;
  /** Filename (basename) of the terminal file that triggered termination — used for handoff to /ship follow-ups. */
  terminalArtifact?: string;
  stages: Record<string, StageStatus>;
  startedAt: string;
  completedAt?: string;
  discussion?: unknown[];
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
}

export function updateRunState(projectDir: string, runId: string, mutator: (state: StoreState) => void): StoreState {
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
  // Always use filesystem as source of truth — index may be stale after concurrent writes
  // The index is still maintained (upsertRunIndex on writes) for future query optimization
  listRunIdsFromIndex(projectDir); // triggers index seed/rebuild as side effect
  try {
    const root = runsRoot(projectDir);
    return readdirSync(root)
      .filter(d => existsSync(join(root, d, 'run.json')))
      .sort();
  } catch { /* expected - optional resource */
    return [];
  }
}
