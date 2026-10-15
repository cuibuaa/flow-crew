/** Admitted terminal owner/scope lookup and shared normalized stage-write attribution; no terminal state mutation. */
import { type DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { join, posix, isAbsolute, relative } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { type TerminalStatesConfig, STAGE_STATUS, type StageStatus, type StoreState } from '../../store.js';
import { normalizedProjectPath } from '../sched_admission/scope-services.js';

/** Static plans and revisions carry the same admission as dispatches in the
 * authoritative plan record. The projection remains a legacy-run fallback. */
function readTerminalAdmission(runDirPath: string): DispatchAdmissionReport {
  const statePath = join(runDirPath, 'run.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as StoreState;
    const historyPath = state.queryState?.planRevision?.path;
    if (historyPath) {
      const record = JSON.parse(readFileSync(join(runDirPath, historyPath), 'utf8')) as { admission?: DispatchAdmissionReport };
      if (record.admission?.terminalOwners) return record.admission;
    }
  }
  return JSON.parse(readFileSync(join(runDirPath, 'dispatch_admission.json'), 'utf8')) as DispatchAdmissionReport;
}

export function admittedTerminalOwner(runDirPath: string, terminalPath: string): string | undefined {
  try {
    const admission = readTerminalAdmission(runDirPath);
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
    const admission = readTerminalAdmission(runDirPath);
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
  settledStatus: typeof STAGE_STATUS.COMPLETE | typeof STAGE_STATUS.FAILED = STAGE_STATUS.COMPLETE,
): boolean {
  const matches = terminalWriteMatcher(projectDir, terminalPath);
  const scopeRefused = (entry: { status: string; constraintAudit?: StageStatus['constraintAudit'] }): boolean => (
    (entry.constraintAudit?.unresolvedViolationCount ?? entry.constraintAudit?.violationCount ?? 0) > 0
    || (entry.status === STAGE_STATUS.FAILED && (entry.constraintAudit?.violationCount ?? 0) > 0)
  );
  // An ordinary process failure may explain a blocker; an engine-refused
  // execution cannot authorize terminal evidence, including via an older write.
  if (state.stages[stageId] && scopeRefused(state.stages[stageId])) return false;
  const statuses = attributedStageStatuses(state, stageId);
  return statuses.some((status) => {
    const settledAttempts = [...(status.attempts ?? [])]
      .reverse()
      .filter((attempt) => attempt.status === settledStatus && !scopeRefused(attempt));
    if (settledAttempts.some((attempt) => (attempt.writes ?? []).some(matches))) return true;
    return status.status === settledStatus && !scopeRefused(status)
      && (settledStatus !== STAGE_STATUS.FAILED || !status.attempts?.length)
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
