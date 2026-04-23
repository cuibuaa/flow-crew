import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StageStatus, StoreState } from './types.js';
import { runDir, runsRoot, stageDir, atomicWrite, createRunId } from './helpers.js';

/**
 * Initializes a new workflow run by generating a unique run ID, creating the
 * directory structure under `.fc/runs/`, and writing initial run state and
 * workflow YAML to disk.
 *
 * @param projectDir - absolute path to the project root
 * @param workflowName - name of the workflow being executed
 * @param workflowYaml - raw YAML content of the workflow definition
 * @param stageIds - array of stage identifiers to create subdirectories for
 * @returns an object with `runId` (the generated identifier) and `runDirPath` (absolute path to the run directory)
 */
export function createRun(
  projectDir: string,
  workflowName: string,
  workflowYaml: string,
  stageIds: string[],
): { runId: string; runDirPath: string } {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') throw new TypeError('projectDir must be a non-empty string');
  if (typeof workflowName !== 'string' || workflowName.trim() === '') throw new TypeError('workflowName must be a non-empty string');
  if (!Array.isArray(stageIds) || stageIds.length === 0) throw new TypeError('stageIds must be a non-empty array');
  const runId = createRunId();
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

export function listRuns(projectDir: string): string[] {
  try {
    return readdirSync(runsRoot(projectDir)).sort();
  } catch {
    return [];
  }
}
