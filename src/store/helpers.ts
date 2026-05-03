import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class StoreError extends Error {
  override name = 'StoreError';
  readonly operation: string;
  readonly filePath: string;
  constructor(message: string, operation: string, filePath: string, options?: { cause?: unknown }) {
    super(message, options);
    this.operation = operation;
    this.filePath = filePath;
  }
}

export function runsRoot(projectDir: string): string {
  return join(projectDir, '.fc', 'runs');
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
    const msg = err instanceof Error ? err.message : String(err);
    throw new StoreError(`atomicWrite failed for ${filePath}: ${msg}`, 'atomicWrite', filePath, { cause: err });
  }
}

export function createRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = randomBytes(3).toString('hex');
  return `${ts}-${suffix}`;
}
