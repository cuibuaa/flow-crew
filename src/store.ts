import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
}

export interface CampaignTriggers {
  enabled?: boolean;
  regressionAfter?: number;
  plateauAfter?: number;
  plateauThreshold?: number;
  repeatedFailureAfter?: number;
}

export interface StoreState {
  runId: string;
  workflowName: string;
  projectDir: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'awaiting_approval';
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
  timeoutMs?: number;
  campaignTriggers?: CampaignTriggers;
  failureReason?: string;
  campaignId?: string;
  campaignStorageKey?: string;
  campaignName?: string;
  campaignSeq?: number;
  campaignIteration?: number;
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
}

function runsRoot(projectDir: string): string {
  return join(projectDir, '.fc', 'runs');
}

function runDir(projectDir: string, runId: string): string {
  return join(runsRoot(projectDir), runId);
}

function stageDir(projectDir: string, runId: string, stageId: string): string {
  return join(runDir(projectDir, runId), 'stages', stageId);
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + randomBytes(4).toString('hex');
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
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
  atomicWrite(join(dir, 'workflow.yaml'), workflowYaml);
  return { runId, runDirPath: dir };
}

export function readRunState(projectDir: string, runId: string): StoreState {
  return JSON.parse(readFileSync(join(runDir(projectDir, runId), 'run.json'), 'utf-8'));
}

export function writeRunState(projectDir: string, runId: string, state: StoreState): void {
  atomicWrite(join(runDir(projectDir, runId), 'run.json'), JSON.stringify(state, null, 2));
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
  } catch {
    return '';
  }
}

export function readStageOutput(projectDir: string, runId: string, stageId: string): string {
  try {
    return readFileSync(join(stageDir(projectDir, runId, stageId), 'output.md'), 'utf-8');
  } catch {
    return '';
  }
}

export function listRuns(projectDir: string): string[] {
  try {
    return readdirSync(runsRoot(projectDir)).sort();
  } catch {
    return [];
  }
}
