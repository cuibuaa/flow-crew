/** Admitted terminal owner/scope lookup and shared normalized stage-write attribution; no terminal state mutation. */
import { type DispatchAdmissionReport } from '../sched_admission/dispatch.js';
import { join, posix } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { STAGE_STATUS, type StageStatus, type StoreState } from '../../store.js';
import { normalizedProjectContentPath, normalizedProjectPath, parseDeclaredScope, scopeMatchesProjectPath } from '../sched_admission/scope-services.js';

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

/** Content deltas, rather than conservative capability scopes, need review.
 * Terminal reports and declared round-verdict evidence are the outcome itself. */
export function terminalProductWrites(
  runDirPath: string, state: StoreState, stageId: string,
): Array<{ path: string; completedAt: number }> {
  const admission = readTerminalAdmission(runDirPath);
  const evidenceScopes = Object.values(state.terminalStates ?? {})
    .filter(entry => entry.paths.some(path => admission.terminalOwners[path] === stageId))
    .flatMap((entry) => {
      if (entry.floor?.minAttemptedStages === undefined) return entry.paths;
      const directory = posix.dirname(entry.paths[0] ?? '.');
      return [...entry.paths, entry.stageGlob ?? `${directory === '.' ? '' : `${directory}/`}stage_*_verdict.md`];
    }).map(parseDeclaredScope);
  const writes = attributedStageStatuses(state, stageId).flatMap((status) => (
    (status.attempts?.length ? status.attempts : [status]).flatMap((attempt) => {
      const paths = attempt.writes ?? [];
      const noReview = new Set<string>();
      // Publication can repeat identical bytes. Attribution stays with writes;
      // the existing audit preserves no-ops and review exemptions, including
      // writes whose content could not be compared.
      if (attempt.constraintAudit) try {
        const audit = JSON.parse(readFileSync(join(runDirPath, attempt.constraintAudit.path), 'utf8')) as Record<string, string[]>;
        for (const path of audit.exemptedWrites ?? []) noReview.add(path);
        for (const path of audit.unavailableComparisons ?? []) noReview.add(path);
        const classes = ['appliedWrites', 'exemptedWrites', 'rolledBackWrites', 'rollbackFailures', 'unavailableComparisons'];
        if (Array.isArray(audit.rawWrites) && classes.every(key => Array.isArray(audit[key]))) {
          for (const path of audit.rawWrites) if (!classes.some(key => audit[key].includes(path))) noReview.add(path);
        }
      } catch { /* Missing or legacy content evidence cannot prove a no-op. */ }
      return paths.flatMap(path => {
        const projectPath = normalizedProjectContentPath(normalizedProjectPath(path, state.projectDir) ?? '');
        return projectPath && !path.startsWith('run:') && !noReview.has(projectPath)
          ? [{ path: projectPath, completedAt: Date.parse(attempt.completedAt ?? '') }] : [];
      });
    })
  ));
  return writes.filter(({ path }) => !evidenceScopes.some((scope) => scopeMatchesProjectPath(scope, path)));
}

function terminalWriteMatcher(projectDir: string, terminalPath: string): (raw: string) => boolean {
  const wanted = normalizedProjectPath(terminalPath, projectDir);
  return raw => wanted !== undefined && normalizedProjectPath(raw, projectDir) === wanted;
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
      && !status.attempts?.length
      && (status.writes ?? []).some(matches);
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
    if (!status.attempts?.length && (status.writes ?? []).some(matches) && status.completedAt) {
      attempts.push(Date.parse(status.completedAt));
    }
    return attempts.filter(Number.isFinite);
  });
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}
