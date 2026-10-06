/** Admitted terminal owner/scope lookup and shared normalized stage-write attribution; no terminal state mutation. */
import { type DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { join, posix, isAbsolute, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { type TerminalStatesConfig, STAGE_STATUS, type StageStatus, type StoreState } from '../../store.js';
import { normalizedProjectPath } from '../sched_admission/scope-services.js';

export function admittedTerminalOwner(runDirPath: string, terminalPath: string): string | undefined {
  try {
    const admission = JSON.parse(readFileSync(join(runDirPath, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
    return admission.pass ? admission.terminalOwners[terminalPath] : undefined;
  } catch {
    return undefined;
  }
}

export function admittedTerminalDurableScope(
  runDirPath: string,
  stageId: string,
  terminalStates: TerminalStatesConfig | undefined,
): string[] | undefined {
  try {
    const admission = JSON.parse(readFileSync(join(runDirPath, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
    if (!admission.pass || !(admission.terminalValidationScopes?.[stageId]?.length)) return undefined;
    const allowed = new Set<string>();
    for (const entry of Object.values(terminalStates ?? {})) {
      const ownedPaths = entry.paths.filter((path) => admission.terminalOwners[path] === stageId);
      for (const path of ownedPaths) allowed.add(path);
      if (ownedPaths.length === 0 || entry.floor?.minAttemptedStages === undefined) continue;
      if (entry.stageGlob) allowed.add(entry.stageGlob);
      else {
        const normalized = normalizedProjectPath(ownedPaths[0]);
        if (!normalized) continue;
        const directory = posix.dirname(normalized);
        allowed.add(`${directory === '.' ? '' : `${directory}/`}stage_*_verdict.md`);
      }
    }
    return [...allowed];
  } catch {
    return undefined;
  }
}

function terminalWriteMatcher(
  projectDir: string,
  terminalPath: string,
): (raw: string) => boolean {
  const wanted = posix.normalize(terminalPath.replace(/\\/g, '/'));
  return (raw: string): boolean => {
    const normalized = raw.replace(/\\/g, '/');
    const projectRelative = isAbsolute(normalized)
      ? relative(projectDir, normalized).replace(/\\/g, '/')
      : normalized.replace(/^\.\//, '');
    return posix.normalize(projectRelative) === wanted;
  };
}

function attributedStageStatuses(state: StoreState, stageId: string): StageStatus[] {
  return [
    state.stages[stageId],
    ...(state.stageEvidence ?? [])
      .filter((entry) => entry.stageId === stageId)
      .map((entry) => entry.status),
  ].filter((status): status is StageStatus => Boolean(status));
}

export function stageAttemptWroteProjectPath(
  projectDir: string,
  state: StoreState,
  stageId: string,
  terminalPath: string,
): boolean {
  const matches = terminalWriteMatcher(projectDir, terminalPath);
  const statuses = attributedStageStatuses(state, stageId);
  return statuses.some((status) => {
    const completedAttempts = [...(status.attempts ?? [])]
      .reverse()
      .filter((attempt) => attempt.status === STAGE_STATUS.COMPLETE);
    if (completedAttempts.some((attempt) => (attempt.writes ?? []).some(matches))) return true;
    return status.status === STAGE_STATUS.COMPLETE
      && (status.writes ?? status.artifacts ?? []).some(matches);
  });
}

export function lastAttributedStageWriteMs(
  projectDir: string,
  state: StoreState,
  stageId: string,
  terminalPath: string,
): number | undefined {
  const matches = terminalWriteMatcher(projectDir, terminalPath);
  const statuses = attributedStageStatuses(state, stageId);
  const timestamps = statuses.flatMap((status) => {
    const attempts = (status.attempts ?? []).flatMap((attempt) => (
      attempt.status === STAGE_STATUS.COMPLETE
      && (attempt.writes ?? []).some(matches)
      && attempt.completedAt
        ? [Date.parse(attempt.completedAt)]
        : []
    ));
    if ((status.writes ?? status.artifacts ?? []).some(matches) && status.completedAt) {
      attempts.push(Date.parse(status.completedAt));
    }
    return attempts.filter(Number.isFinite);
  });
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}
