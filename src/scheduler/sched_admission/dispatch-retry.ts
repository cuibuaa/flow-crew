import { concludeRun } from '../sched_policy/run-completion.js';
/** Planner artifact retry decisions; run/campaign/guidance effects enter through typed callbacks. */
import { renderPlanInterface } from '../../plan-interface.js';
import { type StageStatus, type StoreState, runDir, RUN_STATUS } from '../../store.js';
import { join, posix } from 'node:path';
import { writeFileSync, unlinkSync, mkdirSync, copyFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildMonotonePlanRetryContext, type PlanRetryRequirement, planRetryRequirement, readMonotonePlanRetryState } from '../../plan-retry-monotone.js';
import { readDispatchDocument } from '../../dispatch-document.js';
import { publishJsonCreateOnly } from '../../canonical-json.js';
import { type DispatchAdmissionReport } from './dispatch.js';

export function restoreAdmittedRealityChecks(runDirPath: string, state: StoreState): void {
  const checksPath = join(runDirPath, 'reality_checks.md');
  if (state.admittedRealityChecks) {
    writeFileSync(checksPath, state.admittedRealityChecks.markdown, 'utf-8');
  } else {
    try { if (existsSync(checksPath)) unlinkSync(checksPath); } catch { /* no prior admitted copy */ }
  }
}

export function promoteAdmittedRealityChecks(runDirPath: string, state: StoreState): void {
  const checksPath = join(runDirPath, 'reality_checks.md');
  if (!existsSync(checksPath)) return;
  const markdown = readFileSync(checksPath, 'utf-8');
  state.admittedRealityChecks = {
    markdown,
    sha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    admittedAtIteration: state.currentIteration ?? 1,
  };
}

// Canonical dispatch.yaml schema reminder, single-sourced for the re-prompt so
// the planner re-emits a well-formed file. Generic mechanism (no task content).
const DISPATCH_SCHEMA_REMINDER = renderPlanInterface();

export function buildRetryPreamble(
  retries: number,
  timeoutMs: number,
  runDirPath: string,
  stageId: string,
  timeoutContext?: { previousBudgetMs: number; nextBudgetMs: number },
): string {
  const partialPath = `${runDirPath}/stages/${stageId}/output.md`;
  let prevError: string | undefined;
  let admissionFailed = false;
  try {
    const statusRaw = readFileSync(join(runDirPath, 'stages', stageId, 'status.json'), 'utf-8');
    const status = JSON.parse(statusRaw) as Pick<StageStatus, 'error' | 'admissionFailure' | 'attempts'>;
    admissionFailed = status.admissionFailure?.code === 'dispatch_refused'
      && status.admissionFailure.attemptIndex === (status.attempts?.at(-1)?.index ?? 0);
    // A nested adapter runs after the worker clears the live outcome. Its
    // settled ledger still explains the execution that is being retried.
    prevError = status.error ?? status.attempts?.filter(attempt => attempt.status !== RUN_STATUS.RUNNING).at(-1)?.error;
  } catch { /* status not readable; fall through to generic message */ }
  const monotoneContext = buildMonotonePlanRetryContext(runDirPath, stageId);
  const withMonotoneContext = (message: string): string => monotoneContext
    ? `${message}\n\n${monotoneContext}`
    : message;
  const retryState = readMonotonePlanRetryState(runDirPath, stageId);
  if (admissionFailed && retryState && !retryState.terminal) {
    return withMonotoneContext([
      `RE-PLAN (attempt ${retryState.attempts.length + 1}): dispatch admission rejected the previous complete proposal before any proposed work stage ran.`,
      prevError ?? retryState.unsatisfied.map(requirement => `${requirement.id}: ${requirement.detail}`).join('\n'),
      DISPATCH_SCHEMA_REMINDER,
      `Address the observed requirements in a complete replacement at ${runDirPath}/dispatch.yaml. The archived proposal/report remain read-only evidence.`,
    ].join('\n\n'));
  }
  let cause: string;
  if (prevError && prevError.startsWith('aborted by engine')) {
    cause = `Previous execution was ${prevError}. The engine stopped the execution. Inspect its recorded reason and produce the required result within the current deadline.`;
  } else if (timeoutContext) {
    cause = `Previous attempt timed out with an effective budget of ${timeoutContext.previousBudgetMs}ms. `
      + `This new attempt has a strictly larger immutable budget of ${timeoutContext.nextBudgetMs}ms.`;
  } else if (prevError) {
    cause = `Previous execution failed: ${prevError}. Verify its partial work and complete the current duties.`;
  } else {
    cause = `Previous attempt timed out after ${Math.ceil(timeoutMs / 1000)}s.`;
  }
  return withMonotoneContext(`RETRY (attempt ${retries + 1}): ${cause} Read partial output at ${partialPath}. Preserve valid work and recorded evidence; repair or redo invalid partial work to complete the admitted result within the current scope and deadline.`);
}

export function diagnoseEmptyDispatch(
  dispatchExists: boolean,
  rawDispatchText: string | null,
  knownRoles: string[],
): { detail: string; unknownRoles: string[]; transient: boolean } {
  if (!dispatchExists) {
    return { detail: 'No dispatch.yaml was written (the plan stage produced no execution plan).', unknownRoles: [], transient: true };
  }
  let items: Record<string, unknown>[];
  try {
    items = readDispatchDocument(rawDispatchText ?? '').stages as Record<string, unknown>[];
  } catch (e) {
    return {
      detail: `dispatch.yaml could not be parsed as YAML (${e instanceof Error ? e.message : String(e)}) — likely truncated, malformed or without a stage list.`,
      unknownRoles: [], transient: true,
    };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { detail: 'dispatch.yaml parsed but contained no stages (expected a top-level list, or a {stages: [...]} object).', unknownRoles: [], transient: true };
  }
  const known = new Set(knownRoles);
  const unknownRoles = items
    .filter((i) => i?.role && !known.has(i.role as string))
    .map((i) => `"${i.role}"`)
    .filter((v, idx, arr) => arr.indexOf(v) === idx);
  // GENUINE failure: every stage names a role the registry does not have. This
  // is unsatisfiable as written — re-planning the same brief tends to repeat it.
  if (unknownRoles.length > 0 && unknownRoles.length >= items.filter((i) => i?.role).length) {
    return {
      detail: `every stage referenced an unknown role: ${unknownRoles.join(', ')}. Available roles: ${knownRoles.join(', ')}.`,
      unknownRoles,
      transient: false,
    };
  }
  // Some unknown roles but not all, or schema-invalid stages — treat as transient.
  if (unknownRoles.length > 0) {
    return {
      detail: `some stages referenced unknown role(s): ${unknownRoles.join(', ')}. Available roles: ${knownRoles.join(', ')}.`,
      unknownRoles,
      transient: true,
    };
  }
  return { detail: 'dispatch.yaml contained stages but none were schema-valid (check id/role/prompt_template fields).', unknownRoles: [], transient: true };
}

interface ArchivedDispatchRefusal {
  report: DispatchAdmissionReport;
  proposalPath: string;
  admissionPath: string;
}

export function currentDispatchAdmissionReport(runDirPath: string): DispatchAdmissionReport | undefined {
  try {
    return JSON.parse(readFileSync(join(runDirPath, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
  } catch {
    return undefined;
  }
}

export function planRetryRequirementsFromAdmission(report: DispatchAdmissionReport | undefined): PlanRetryRequirement[] {
  return (report?.errors ?? []).map((error) => planRetryRequirement(error, 'admission'));
}

export function concludePlanRetryFailure(input: {
  state: StoreState;
  projectDir: string;
  runId: string;
  stageId: string;
  reason: string;
}): StoreState {
  return concludeRun(input.state, { status: RUN_STATUS.FAILED, reasonCode: 'dispatch_refused', detail: input.reason, eventFields: () => ({
    iteration: input.state.currentIteration ?? 1,
    stageId: input.stageId,
    detail: `failed: ${input.reason}`,
  }) });
}

export function archiveDispatchAdmissionRefusal(input: {
  runDirPath: string;
  stageId: string;
  attemptIndex: number;
  rawDispatchText: string;
}): ArchivedDispatchRefusal | undefined {
  const liveAdmissionPath = join(input.runDirPath, 'dispatch_admission.json');
  let report: DispatchAdmissionReport;
  try {
    report = JSON.parse(readFileSync(liveAdmissionPath, 'utf-8')) as DispatchAdmissionReport;
  } catch {
    return undefined;
  }
  const proposalDigest = createHash('sha256').update(input.rawDispatchText, 'utf8').digest('hex');
  if (report.pass || report.errors.length === 0 || report.proposalDigest !== proposalDigest) return undefined;

  const relativeRoot = posix.join('dispatch_rejections', `attempt_${input.attemptIndex}`);
  const archiveRoot = join(input.runDirPath, relativeRoot);
  mkdirSync(archiveRoot, { recursive: true });
  const proposalPath = posix.join(relativeRoot, 'dispatch.yaml');
  const admissionPath = posix.join(relativeRoot, 'dispatch_admission.json');
  const absoluteProposalPath = join(input.runDirPath, proposalPath);
  const absoluteAdmissionPath = join(input.runDirPath, admissionPath);
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

/** Action the engine takes when a plan stage emits zero valid injected stages and
 * there is no static follow-up. Pure + exported for unit testing. */
export type EmptyDispatchAction =
  | { action: 'retry'; detail: string }
  | { action: 'escalate'; status: 'escalated' | 'failed'; reason: string; unknownRoles: string[] };

export function decideEmptyDispatchAction(
  diagnosis: { detail: string; unknownRoles: string[]; transient: boolean },
): EmptyDispatchAction {
  if (diagnosis.transient) {
    return {
      action: 'retry',
      detail: diagnosis.detail,
    };
  }
  // Escalate with specifics. A genuine unknown-role failure is unsatisfiable as
  // written → prefer the structured 'escalated' terminal (it carries the named
  // roles). A transient failure that merely exhausted its budget → 'failed' with
  // the specific parse/dispatch detail (still specific, never the generic punt).
  if (diagnosis.unknownRoles.length > 0) {
    return {
      action: 'escalate',
      status: 'escalated',
      reason: `Planner cannot satisfy this brief: ${diagnosis.detail} These roles do not exist in the registry — the brief asks for capabilities the engine has no agent for. Add the missing role(s) or rewrite the brief to use available roles.`,
      unknownRoles: diagnosis.unknownRoles,
    };
  }
  return { action: 'escalate', status: 'failed', reason: diagnosis.detail, unknownRoles: [] };
}
