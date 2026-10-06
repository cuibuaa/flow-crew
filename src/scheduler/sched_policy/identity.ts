/** Scheduler PID/process-identity claims and terminal lifecycle predicate; heartbeat implementation remains in scheduler-heartbeat. */
import { isTerminalRunStatus } from '../../store.js';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalRunDirectory } from '../../cancellation-policy.js';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { removeSchedulerProcessIdentity, writeSchedulerProcessIdentity, isLiveFlowcrewSchedulerForRun, parseSchedulerPidMarker } from '../../run-lock.js';

export function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && isTerminalRunStatus(status);
}

const localSchedulerClaims = new Set<string>();

function establishLocalSchedulerClaim(schedulerPidPath: string, runId: string): boolean {
  const claimPath = join(canonicalRunDirectory(dirname(schedulerPidPath)), basename(schedulerPidPath));
  try {
    writeSchedulerProcessIdentity(dirname(claimPath), runId);
    localSchedulerClaims.add(claimPath);
    return true;
  } catch {
    try {
      if (readFileSync(schedulerPidPath, 'utf-8').trim() === String(process.pid)) {
        unlinkSync(schedulerPidPath);
      }
    } catch { /* absent or replaced */ }
    removeSchedulerProcessIdentity(dirname(claimPath), process.pid);
    return false;
  }
}

export function claimSchedulerPid(schedulerPidPath: string, runId: string): boolean {
  const claimPath = join(canonicalRunDirectory(dirname(schedulerPidPath)), basename(schedulerPidPath));
  const runPath = dirname(claimPath);
  if (localSchedulerClaims.has(claimPath)) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(schedulerPidPath, String(process.pid), { encoding: 'utf-8', flag: 'wx' });
      return establishLocalSchedulerClaim(schedulerPidPath, runId);
    } catch {
      let owner: number | null = null;
      try { owner = parseSchedulerPidMarker(readFileSync(schedulerPidPath, 'utf-8')); } catch { /* missing again */ }
      if (owner === process.pid) {
        return establishLocalSchedulerClaim(schedulerPidPath, runId);
      }
      if (owner !== null && isLiveFlowcrewSchedulerForRun(owner, runId, runPath)) return false;
      try { unlinkSync(schedulerPidPath); } catch { return false; }
      removeSchedulerProcessIdentity(runPath);
    }
  }
  return false;
}

export function removeSchedulerPidIfOwned(schedulerPidPath: string): void {
  localSchedulerClaims.delete(join(canonicalRunDirectory(dirname(schedulerPidPath)), basename(schedulerPidPath)));
  try {
    if (readFileSync(schedulerPidPath, 'utf-8').trim() === String(process.pid)) {
      unlinkSync(schedulerPidPath);
      removeSchedulerProcessIdentity(dirname(resolve(schedulerPidPath)), process.pid);
    }
  } catch { /* already removed or replaced by a newer owner */ }
}

