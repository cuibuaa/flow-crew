import { runRecordPath, stageWorkPath } from '../../run-layout.js';
/** Planner artifact retry decisions; run/campaign/guidance effects enter through typed callbacks. */
import { type StageStatus, type StoreState, RUN_STATUS } from '../../store.js';
import { join, posix } from 'node:path';
import { writeFileSync, unlinkSync, mkdirSync, copyFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publishJsonCreateOnly } from '../../canonical-json.js';
import { type DispatchAdmissionReport } from './dispatch.js';

export function restoreAdmittedRealityChecks(runDirPath: string, state: StoreState): void {
  const checksPath = runRecordPath(runDirPath, 'reality_checks.md');
  if (state.admittedRealityChecks) {
    writeFileSync(checksPath, state.admittedRealityChecks.markdown, 'utf-8');
  } else {
    try { if (existsSync(checksPath)) unlinkSync(checksPath); } catch { /* no prior admitted copy */ }
  }
}

export function promoteAdmittedRealityChecks(runDirPath: string, state: StoreState): void {
  const checksPath = runRecordPath(runDirPath, 'reality_checks.md');
  if (!existsSync(checksPath)) return;
  const markdown = readFileSync(checksPath, 'utf-8');
  state.admittedRealityChecks = {
    markdown,
    sha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    admittedAtIteration: state.currentIteration ?? 1,
  };
}

export function buildRetryPreamble(
  retries: number,
  timeoutMs: number | undefined,
  runDirPath: string,
  stageId: string,
  timeoutContext?: { previousBudgetMs?: number; nextBudgetMs?: number },
): string {
  const partialPath = runRecordPath(runDirPath, 'evidence-ledger.jsonl');
  let prevError: string | undefined;
  let admissionFailed = false;
  let previousExitCode: number | undefined;
  try {
    const statusRaw = readFileSync(runRecordPath(runDirPath, 'stages', stageId, 'status.json'), 'utf-8');
    const status = JSON.parse(statusRaw) as Pick<StageStatus, 'error' | 'exitCode' | 'admissionFailure' | 'attempts'>;
    admissionFailed = status.admissionFailure?.code === 'dispatch_refused'
      && status.admissionFailure.attemptIndex === (status.attempts?.at(-1)?.index ?? 0);
    // A nested adapter runs after the worker clears the live outcome. Its
    // settled ledger still explains the execution that is being retried.
    const previous = status.attempts?.filter(attempt => attempt.status !== RUN_STATUS.RUNNING).at(-1);
    prevError = status.error ?? previous?.error;
    previousExitCode = status.exitCode ?? previous?.exitCode;
  } catch { /* status not readable; fall through to generic message */ }
  let admissionBudget: StoreState['dispatchAdmission'];
  try { admissionBudget = JSON.parse(readFileSync(runRecordPath(runDirPath, 'run.json'), 'utf8')).dispatchAdmission; } catch { /* standalone retry context has no run projection */ }
  const replan = admissionFailed;
  const admission = replan ? currentDispatchAdmissionReport(runDirPath) : undefined;
  return [
    `# ${replan ? 'RE-PLAN' : 'RETRY'} facts\n${JSON.stringify({ stageId, attemptIndex: retries + 1,
      budgetMs: timeoutMs, previousError: prevError, previousExitCode, admissionBudget, ...timeoutContext,
      ledgerPath: partialPath, statusPath: runRecordPath(runDirPath, 'stages', stageId, 'status.json'),
      ...(replan ? { dispatchPath: stageWorkPath(runDirPath, 'dispatch.yaml') } : {}),
    })}`,
    admission ? `# Dispatch admission facts\n${JSON.stringify(admission)}` : undefined,
  ].filter(Boolean).join('\n\n');
}

interface ArchivedDispatchRefusal {
  report: DispatchAdmissionReport;
  proposalPath: string;
  admissionPath: string;
}

export function currentDispatchAdmissionReport(runDirPath: string): DispatchAdmissionReport | undefined {
  try {
    return JSON.parse(readFileSync(runRecordPath(runDirPath, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
  } catch {
    return undefined;
  }
}

export function archiveDispatchAdmissionRefusal(input: {
  runDirPath: string;
  stageId: string;
  attemptIndex: number;
  rawDispatchText: string;
}): ArchivedDispatchRefusal | undefined {
  const liveAdmissionPath = runRecordPath(input.runDirPath, 'dispatch_admission.json');
  let report: DispatchAdmissionReport;
  try {
    report = JSON.parse(readFileSync(liveAdmissionPath, 'utf-8')) as DispatchAdmissionReport;
  } catch {
    return undefined;
  }
  const proposalDigest = createHash('sha256').update(input.rawDispatchText, 'utf8').digest('hex');
  if (report.pass || report.errors.length === 0 || report.proposalDigest !== proposalDigest) return undefined;

  const relativeRoot = posix.join('dispatch_rejections', `attempt_${input.attemptIndex}`);
  const archiveRoot = runRecordPath(input.runDirPath, relativeRoot);
  mkdirSync(archiveRoot, { recursive: true });
  const proposalPath = posix.join(relativeRoot, 'dispatch.yaml');
  const admissionPath = posix.join(relativeRoot, 'dispatch_admission.json');
  const absoluteProposalPath = runRecordPath(input.runDirPath, proposalPath);
  const absoluteAdmissionPath = runRecordPath(input.runDirPath, admissionPath);
  if (!existsSync(absoluteProposalPath)) writeFileSync(absoluteProposalPath, input.rawDispatchText, 'utf-8');
  if (!existsSync(absoluteAdmissionPath)) copyFileSync(liveAdmissionPath, absoluteAdmissionPath);
  publishJsonCreateOnly(join(archiveRoot, 'rejection.json'), {
    version: 1,
    stageId: input.stageId,
    attemptIndex: input.attemptIndex,
    proposalDigest,
    proposalPath,
    admissionPath,
    errors: report.errors,
    archivedAt: new Date().toISOString(),
  });
  return { report, proposalPath, admissionPath };
}
