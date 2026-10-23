/** Deployment uses the ordinary parked/continuation lifecycle. The store-wide
 * latch fences launches; only a scheduler at a settled group boundary parks. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fcGlobalDir, RUN_STATUS, STAGE_STATUS, updateRunState, type StoreState } from './store.js';
import { atomicWrite, mkdirSync } from './engine-fs.js';

const HoldSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), requestedAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
}).strict();
export type DeploymentHold = z.infer<typeof HoldSchema>;
export type RunDeploymentHold = DeploymentHold & { heldAt: string };

export function readDeploymentHold(baseDir = fcGlobalDir()): DeploymentHold | undefined {
  const path = join(baseDir, 'deployment-hold.json');
  if (!existsSync(path)) return undefined;
  // Corrupt control state is a refusal, never permission to launch.
  return HoldSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function deploymentHeld(baseDir = fcGlobalDir()): boolean {
  const hold = readDeploymentHold(baseDir);
  return Boolean(hold && !hold.releasedAt);
}

export function requestDeploymentHold(baseDir = fcGlobalDir()): DeploymentHold {
  const previous = readDeploymentHold(baseDir);
  if (previous && !previous.releasedAt) return previous;
  const hold: DeploymentHold = { version: 1, id: randomUUID(), requestedAt: new Date().toISOString() };
  mkdirSync(baseDir, { recursive: true });
  atomicWrite(join(baseDir, 'deployment-hold.json'), JSON.stringify(hold, null, 2));
  return hold;
}

export function releaseDeploymentHold(hold: DeploymentHold, baseDir = fcGlobalDir()): void {
  const current = readDeploymentHold(baseDir);
  if (current?.id !== hold.id) throw new Error('Deployment hold changed; refusing to release another hold');
  atomicWrite(join(baseDir, 'deployment-hold.json'), JSON.stringify({ ...current, releasedAt: current.releasedAt ?? new Date().toISOString() }, null, 2));
}

/** Called only after all children, monitors, audits and group settlement join.
 * Never interrupts an attempt or turns cancellation into a continuation. */
export function parkAtDeploymentBoundary(projectDir: string, runId: string): StoreState | undefined {
  const hold = readDeploymentHold();
  if (!hold || hold.releasedAt) return undefined;
  return updateRunState(projectDir, runId, state => {
    if (state.status !== RUN_STATUS.RUNNING && !(state.status === RUN_STATUS.PARKED && state.recovery?.kind === 'resumable')) return;
    if (Object.values(state.stages).some(stage => stage.status === STAGE_STATUS.RUNNING
        || stage.attempts?.some(attempt => attempt.status === STAGE_STATUS.RUNNING || attempt.status === 'closed'))) {
      throw new Error('DEPLOYMENT_BOUNDARY_UNSETTLED: cannot acknowledge hold while a stage attempt is unsettled');
    }
    state.status = RUN_STATUS.PARKED;
    state.deploymentHold = { ...hold, heldAt: new Date().toISOString() };
    delete state.completedAt;
  });
}
