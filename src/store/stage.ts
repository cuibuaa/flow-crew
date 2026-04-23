import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StageStatus } from './types.js';
import { stageDir, atomicWrite } from './helpers.js';

export function stageStatus(projectDir: string, runId: string, stageId: string): StageStatus;
export function stageStatus(projectDir: string, runId: string, stageId: string, status: StageStatus): void;
export function stageStatus(projectDir: string, runId: string, stageId: string, status?: StageStatus): StageStatus | void {
  if (status !== undefined) {
    const dir = stageDir(projectDir, runId, stageId);
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, 'status.json'), JSON.stringify(status, null, 2));
  } else {
    return JSON.parse(
      readFileSync(join(stageDir(projectDir, runId, stageId), 'status.json'), 'utf-8'),
    );
  }
}

export function stageInput(projectDir: string, runId: string, stageId: string): string;
export function stageInput(projectDir: string, runId: string, stageId: string, input: string): void;
export function stageInput(projectDir: string, runId: string, stageId: string, input?: string): string | void {
  if (input !== undefined) {
    atomicWrite(join(stageDir(projectDir, runId, stageId), 'input.md'), input);
  } else {
    try {
      return readFileSync(join(stageDir(projectDir, runId, stageId), 'input.md'), 'utf-8');
    } catch {
      return '';
    }
  }
}

export function stageOutput(projectDir: string, runId: string, stageId: string): string;
export function stageOutput(projectDir: string, runId: string, stageId: string, output: string): void;
export function stageOutput(projectDir: string, runId: string, stageId: string, output?: string): string | void {
  if (output !== undefined) {
    atomicWrite(join(stageDir(projectDir, runId, stageId), 'output.md'), output);
  } else {
    try {
      return readFileSync(join(stageDir(projectDir, runId, stageId), 'output.md'), 'utf-8');
    } catch {
      return '';
    }
  }
}

export const readStageStatus = (projectDir: string, runId: string, stageId: string): StageStatus =>
  stageStatus(projectDir, runId, stageId);

export const writeStageStatus = (projectDir: string, runId: string, stageId: string, status: StageStatus): void =>
  stageStatus(projectDir, runId, stageId, status);

export const writeStageInput = (projectDir: string, runId: string, stageId: string, input: string): void =>
  stageInput(projectDir, runId, stageId, input);

export const writeStageOutput = (projectDir: string, runId: string, stageId: string, output: string): void =>
  stageOutput(projectDir, runId, stageId, output);

export const readStageInput = (projectDir: string, runId: string, stageId: string): string =>
  stageInput(projectDir, runId, stageId);

export const readStageOutput = (projectDir: string, runId: string, stageId: string): string =>
  stageOutput(projectDir, runId, stageId);
