/** Deployment uses the ordinary parked/continuation lifecycle. The store-wide
 * latch fences launches; only a scheduler at a settled group boundary parks. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fcGlobalDir, RUN_STATUS, STAGE_STATUS, updateRunState, withRunStateLock, type StoreState } from './store.js';
import { atomicWrite, mkdirSync } from './engine-fs.js';

const HoldSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), requestedAt: z.string().datetime(),
  stopRequestedAt: z.string().datetime().nullable().optional(),
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
  mkdirSync(baseDir, { recursive: true });
  return withRunStateLock(baseDir, () => {
    const previous = readDeploymentHold(baseDir);
    if (previous && !previous.releasedAt) return previous;
    const hold: DeploymentHold = { version: 1, id: randomUUID(), requestedAt: new Date().toISOString(), stopRequestedAt: null };
    atomicWrite(join(baseDir, 'deployment-hold.json'), JSON.stringify(hold, null, 2));
    return hold;
  });
}

/** Persist before sending stop: a lost reply still needs a recovery fence. */
export function markDeploymentStopping(hold: DeploymentHold, baseDir = fcGlobalDir()): void {
  withRunStateLock(baseDir, () => {
    const current = readDeploymentHold(baseDir);
    if (current?.id !== hold.id || current.releasedAt) throw new Error('Deployment hold changed before stop');
    atomicWrite(join(baseDir, 'deployment-hold.json'), JSON.stringify({ ...current,
      stopRequestedAt: current.stopRequestedAt ?? new Date().toISOString() }, null, 2));
  });
}

/** Abandonment checks the phase under the same lock that publishes stop intent. */
export function releaseDeploymentHold(hold: DeploymentHold, baseDir = fcGlobalDir(), beforeStop = false): void {
  withRunStateLock(baseDir, () => {
    const current = readDeploymentHold(baseDir);
    if (current?.id !== hold.id) throw new Error('Deployment hold changed; refusing to release another hold');
    if (beforeStop && current.stopRequestedAt !== null) throw new Error('Deployment stop was requested; retain the recovery hold');
    atomicWrite(join(baseDir, 'deployment-hold.json'), JSON.stringify({ ...current, releasedAt: current.releasedAt ?? new Date().toISOString() }, null, 2));
  });
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
