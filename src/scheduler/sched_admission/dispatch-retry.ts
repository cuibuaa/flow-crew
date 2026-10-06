/** Planner artifact retry decisions and supervisor rejection consumption; run/campaign/guidance effects enter through typed callbacks. */
import { type StoreState, runDir, RUN_STATUS, writeRunState, STAGE_STATUS, rependStageStatus } from '../../store.js';
import { join, posix } from 'node:path';
import { writeFileSync, existsSync, unlinkSync, readFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildMonotonePlanRetryContext, type PlanRetryRequirement, planRetryRequirement, planRetryRealityCheckName, readMonotonePlanRetryState } from '../../plan-retry-monotone.js';
import { parse as parseYaml } from 'yaml';
import { type RealityCheckPreflightFinding, formatRealityCheckPreflightFindings, type RealityCheckPreflightReport } from '../../reality-check-preflight.js';
import { parseChecksFromMarkdown } from '../../reality-gate/index.js';
import { recordRunEvent } from '../../run-events.js';
import { publishJsonCreateOnly } from '../../runtime-negotiation.js';
import { type SupervisorEvidenceBinding, computeSupervisorEvidenceBinding } from '../../supervisor.js';
import { type DispatchAdmissionReport, readBriefCriteriaForAdmission, collectTransitiveDependents } from './dispatch.js';
import { type StageConfig, loadDefaults } from './configuration.js';
import { markLeftoverStagesSkipped } from './brief-contract.js';
import { log } from './shared.js';
import type { recordBlockageOccurrence } from '../../blockage-ledger.js';

// Error-string prefix written into a plan stage's status.json when it exited 0
// but produced zero valid injected stages (empty/invalid dispatch.yaml). The
// retry preamble keys off this prefix to render a dispatch-specific re-prompt.
const INVALID_DISPATCH_ERROR_PREFIX = 'invalid dispatch.yaml';

const INVALID_REALITY_CHECKS_ERROR_PREFIX = 'invalid reality_checks.md';

const REALITY_CHECK_PREFLIGHT_ARTIFACT = 'reality_check_preflight.json';

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
const DISPATCH_SCHEMA_REMINDER = [
  'Required dispatch.yaml schema — a YAML list at top level (or {stages: [...]}), each item:',
  '  - id: <snake_case, unique>',
  '    role: <one of the available roles named above>',
  '    prompt_template: |',
  '      <short, stage-specific instructions>',
  '    scope: [<project-relative file paths or globs>]',
  '    depends_on: [<stage_ids>]   # required; [] is an explicit root',
  '    dependency_reasons: {<stage_id>: <one-sentence reason>}   # required for each dependency',
  '    criterion_refs: [<canonical criterion IDs from brief_criteria.json>]',
  '    is_gate: true               # optional — quality gate (writes a verdict file)',
  '    retry_to: [<gate_ids>]      # optional',
].join('\n');

export function buildRetryPreamble(
  retries: number,
  timeoutMs: number,
  runDirPath: string,
  stageId: string,
  timeoutContext?: { previousBudgetMs: number; nextBudgetMs: number },
): string {
  const partialPath = `${runDirPath}/stages/${stageId}/output.md`;
  let prevError: string | undefined;
  try {
    const statusRaw = readFileSync(join(runDirPath, 'stages', stageId, 'status.json'), 'utf-8');
    const status = JSON.parse(statusRaw) as { error?: string };
    prevError = status.error;
  } catch { /* status not readable; fall through to generic message */ }
  const monotoneContext = buildMonotonePlanRetryContext(runDirPath, stageId);
  const withMonotoneContext = (message: string): string => monotoneContext
    ? `${message}\n\n${monotoneContext}`
    : message;
  if (prevError && prevError.startsWith(INVALID_REALITY_CHECKS_ERROR_PREFIX)) {
    const detail = prevError.slice(INVALID_REALITY_CHECKS_ERROR_PREFIX.length).replace(/^[:\s]+/, '').trim();
    return withMonotoneContext([
      `RE-PLAN (attempt ${retries + 1}): pre-dispatch lint refused one or more hard checks in your previous reality_checks.md before any work stage ran.`,
      detail ? `Specific preflight finding(s): ${detail}` : 'A hard check could false-block a result that satisfies the task brief.',
      `Read ${runDirPath}/${REALITY_CHECK_PREFLIGHT_ARTIFACT} for the complete blocking and advisory findings from that proposal.`,
      'Repair the scheduler-materialized incumbent pair. Passing reality-check bytes and dispatch components are retained; replace only the check/component implicated by a still-unsatisfied requirement.',
      `Write the repaired dispatch.yaml in ${runDirPath}. An amended reality_checks.md is admitted only together with the repaired proposal.`,
    ].join('\n\n'));
  }
  // Empty/invalid dispatch.yaml — re-plan, do NOT "continue from partial". The
  // detail (parse error / unknown roles) is carried in the error string itself.
  if (prevError && prevError.startsWith(INVALID_DISPATCH_ERROR_PREFIX)) {
    const detail = prevError.slice(INVALID_DISPATCH_ERROR_PREFIX.length).replace(/^[:\s]+/, '').trim();
    const admissionRefusal = detail.startsWith('dispatch admission rejected the complete proposal');
    return withMonotoneContext([
      admissionRefusal
        ? `RE-PLAN (attempt ${retries + 1}): your previous dispatch.yaml was schema-valid but admission rejected its topology or coverage before any proposed work stage ran.`
        : `RE-PLAN (attempt ${retries + 1}): your previous attempt exited cleanly but you failed to emit a valid dispatch.yaml — it produced ZERO usable stages.`,
      detail ? `Specific problem: ${detail}` : 'The file was missing, empty, unparseable, or contained no schema-valid stages.',
      DISPATCH_SCHEMA_REMINDER,
      admissionRefusal
        ? `Repair every still-unsatisfied admission requirement in the materialized incumbent at ${runDirPath}/dispatch.yaml. The archived proposal/report remain read-only evidence; do not repeat an identical or cycling refusal.`
        : `Replace the structurally invalid dispatch.yaml at ${runDirPath}/dispatch.yaml with at least one schema-valid stage that uses a known role.`,
    ].join('\n\n'));
  }
  if (prevError?.startsWith('Temporal test contract rejected')) {
    return withMonotoneContext([
      `RETRY FIX (attempt ${retries + 1}): the previous execution completed, but the temporal test contract rejected a generated test.`,
      `Specific finding(s): ${prevError}`,
      `Read ${join(runDirPath, 'stages', stageId, 'temporal_test_guard.json')} and the rejected test file before editing. Replace the invalid temporal assertion, then run the corrected test. A file with the same invalid assertion will be rejected again.`,
      `Read the prior output at ${partialPath} for context; this is a test correction, not a timeout continuation.`,
    ].join('\n\n'));
  }
  let cause: string;
  if (prevError && prevError.startsWith('aborted by supervisor')) {
    cause = `Previous execution was ${prevError}. The supervisor judged that execution stuck or off-direction. Use this signal: re-read the goal, identify what concrete progress you should produce in this execution, and START making file edits within a few minutes; do NOT spend the whole execution only inspecting code.`;
  } else if (prevError && prevError.startsWith('adapter connection failed')) {
    cause = `Previous attempt failed with an adapter connection error (transient). Retry the same plan.`;
  } else if (timeoutContext) {
    cause = `Previous attempt timed out with an effective budget of ${timeoutContext.previousBudgetMs}ms. `
      + `This new attempt has a strictly larger immutable budget of ${timeoutContext.nextBudgetMs}ms.`;
  } else {
    cause = `Previous attempt timed out after ${Math.ceil(timeoutMs / 1000)}s.`;
  }
  return withMonotoneContext(`RETRY (attempt ${retries + 1}): ${cause} Read partial output at ${partialPath} and continue from where you left off. Do not start over.`);
}

export function diagnoseEmptyDispatch(
  dispatchExists: boolean,
  rawDispatchText: string | null,
  knownRoles: string[],
): { detail: string; unknownRoles: string[]; transient: boolean } {
  if (!dispatchExists) {
    return { detail: 'No dispatch.yaml was written (the plan stage produced no execution plan).', unknownRoles: [], transient: true };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(rawDispatchText ?? '');
  } catch (e) {
    return {
      detail: `dispatch.yaml could not be parsed as YAML (${e instanceof Error ? e.message : String(e)}) — likely truncated or malformed.`,
      unknownRoles: [],
      transient: true,
    };
  }
  const items = (Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).stages)
        ? (parsed as Record<string, unknown>).stages
        : [])) as Record<string, unknown>[];
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

export function planRetrySatisfiedRequirements(input: {
  runDirPath: string;
  state: StoreState;
  report?: DispatchAdmissionReport;
  checksMarkdown?: string;
  preflightFindings?: readonly RealityCheckPreflightFinding[];
}): PlanRetryRequirement[] {
  const satisfied: PlanRetryRequirement[] = [];
  const failures = new Set(planRetryRequirementsFromAdmission(input.report).map((requirement) => requirement.id));
  const completeAdmissionObserved = Boolean(
    input.report
    && input.report.terminalValidationScopes !== undefined
    && input.report.criterionGateRefs !== undefined
    && input.report.criterionTerminalRefs !== undefined
    && input.report.dischargedCriteria !== undefined,
  );
  for (const entry of Object.values(input.state.terminalStates ?? {})) {
    for (const path of entry.paths) {
      const fact = planRetryRequirement(`terminal_states path ${path}: has its admitted scoped owner`, 'admission');
      if (!failures.has(fact.id) && input.report?.terminalOwners[path]) {
        satisfied.push({ ...fact, detail: `terminal path ${path} retains scoped owner ${input.report.terminalOwners[path]}` });
      }
    }
  }
  try {
    const artifact = readBriefCriteriaForAdmission(input.runDirPath);
    for (const criterion of artifact?.criteria ?? []) {
      const fact = planRetryRequirement(`criterion ${criterion.id}: complete admission assignment passed`, 'admission');
      if (completeAdmissionObserved
        && input.report?.criteriaDigest === artifact?.briefDigest
        && !failures.has(fact.id)) satisfied.push(fact);
    }
  } catch {
    // The admission report itself carries a digest/shape failure in this case.
  }
  const failedCheckNames = new Set((input.preflightFindings ?? []).map((finding) => finding.checkName));
  for (const error of input.report?.errors ?? []) {
    const checkName = planRetryRealityCheckName(error);
    if (checkName !== undefined) failedCheckNames.add(checkName);
  }
  for (const check of parseChecksFromMarkdown(input.checksMarkdown ?? '')) {
    if (!completeAdmissionObserved || check.kind === 'invalid' || failedCheckNames.has(check.name)) continue;
    satisfied.push(planRetryRequirement(`reality check "${check.name}" passed preflight and reachability`, 'admission'));
  }
  return satisfied;
}

export function concludePlanRetryFailure(input: {
  state: StoreState;
  projectDir: string;
  runId: string;
  stageId: string;
  reason: string;
}): StoreState {
  const retryState = readMonotonePlanRetryState(
    runDir(input.projectDir, input.runId),
    input.stageId,
    input.state.currentIteration ?? 1,
  );
  const causalRequirements = retryState?.attempts.at(-1)?.unsatisfied ?? [];
  const reason = causalRequirements.length > 0 && input.reason.includes('Unsatisfied requirement(s):')
    ? `${input.reason.slice(0, input.reason.indexOf('Unsatisfied requirement(s):'))}`
      + `Unsatisfied requirement(s): ${causalRequirements.map((requirement) => `${requirement.id} — ${requirement.detail}`).join('; ')}`
    : input.reason;
  input.state.status = RUN_STATUS.FAILED;
  input.state.failureReason = reason;
  input.state.completedAt = new Date().toISOString();
  writeRunState(input.projectDir, input.runId, input.state);
  recordRunEvent(input.projectDir, input.runId, {
    type: 'run_completed',
    runId: input.runId,
    timestamp: input.state.completedAt,
    iteration: input.state.currentIteration ?? 1,
    stageId: input.stageId,
    detail: `failed: ${reason}`,
  });
  return input.state;
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
  | { action: 'retry'; nextRetry: number; error: string; detail: string }
  | { action: 'escalate'; status: 'escalated' | 'failed'; reason: string; unknownRoles: string[] };

export function decideEmptyDispatchAction(
  diagnosis: { detail: string; unknownRoles: string[]; transient: boolean },
  retriesUsed: number,
  maxRetries: number,
): EmptyDispatchAction {
  const canRetry = diagnosis.transient && retriesUsed < maxRetries;
  if (canRetry) {
    return {
      action: 'retry',
      nextRetry: retriesUsed + 1,
      error: `${INVALID_DISPATCH_ERROR_PREFIX}: ${diagnosis.detail}`,
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
  return {
    action: 'escalate',
    status: 'failed',
    reason: `Planner failed to emit a valid dispatch.yaml after ${maxRetries} bounded retr${maxRetries === 1 ? 'y' : 'ies'}. Last problem: ${diagnosis.detail}`,
    unknownRoles: [],
  };
}

export type RealityCheckPreflightAction =
  | { action: 'retry'; nextRetry: number; error: string; detail: string }
  | { action: 'fail'; status: 'failed'; reason: string };

/** Apply the existing bounded plan-artifact retry budget to refused hard checks. */
export function decideRealityCheckPreflightAction(
  findings: readonly RealityCheckPreflightFinding[],
  retriesUsed: number,
  maxRetries: number,
): RealityCheckPreflightAction {
  const detail = formatRealityCheckPreflightFindings(findings);
  if (retriesUsed < maxRetries) {
    return {
      action: 'retry',
      nextRetry: retriesUsed + 1,
      error: `${INVALID_REALITY_CHECKS_ERROR_PREFIX}: ${detail}`,
      detail,
    };
  }
  return {
    action: 'fail',
    status: 'failed',
    reason: `Planner emitted inadmissible hard Reality-Gate checks after ${maxRetries} bounded retr${maxRetries === 1 ? 'y' : 'ies'}: ${detail}`,
  };
}

export function writeRealityCheckPreflightArtifact(
  runDirPath: string,
  plannerStageId: string,
  report: RealityCheckPreflightReport,
  disposition: 'admitted' | 'admitted_with_advisories' | 'refused',
  demotedCheckIndexes: readonly number[] = [],
): void {
  writeFileSync(join(runDirPath, REALITY_CHECK_PREFLIGHT_ARTIFACT), JSON.stringify({
    version: 1,
    writtenAt: new Date().toISOString(),
    plannerStageId,
    checksInspected: report.checksInspected,
    disposition,
    blockingTierFindings: report.blockingTierFindings,
    structuralFindings: report.structuralFindings,
    advisoryFindings: report.advisoryFindings,
    demotedCheckIndexes,
    delivery: {
      runtime: 'advisory findings are applied to reality_checks.md before dispatch and cannot reject terminal success',
      operator: 'a reality_gate_advisory entry is appended to events.jsonl when advisory findings are present',
      planner: `the planner prompt requires reading ${REALITY_CHECK_PREFLIGHT_ARTIFACT} on a later planning attempt`,
    },
  }, null, 2) + '\n', 'utf-8');
}

/** A pending supervisor REJECT signal read off disk (signals/reject_<stage>.json
 * or the run-level signals/reject.json). */
export interface SupervisorRejectSignal {
  /** Target stage to re-work. null when the supervisor wrote a run-level reject
   * with no target named (the caller maps it to the most-recently-completed stage). */
  targetStage: string | null;
  reason: string;
  /** Present on v2 signals. Legacy signals remain readable for old on-disk
   * runs, while every newly written signal is attempt/generation bound. */
  evidence?: SupervisorEvidenceBinding;
}

/** Decision for a supervisor REJECT. A bounded budget prevents an infinite
 * repair loop, but exhausting it can never turn rejected work into accepted
 * work; the only safe fallback is an explicit escalation. */
export type RejectDecision =
  | { action: 'rework'; targetStage: string; nextCount: number; reason: string }
  | { action: 'escalate'; targetStage?: string; reason: string };

export function decideRejectAction(
  signal: SupervisorRejectSignal,
  resolvedTargetStage: string | null,
  rejectsUsedForStage: number,
  maxRejects: number,
): RejectDecision {
  if (!resolvedTargetStage) {
    return { action: 'escalate', reason: `REJECT had no resolvable target stage; rejected work cannot be accepted. (${signal.reason})` };
  }
  if (rejectsUsedForStage >= maxRejects) {
    return {
      action: 'escalate',
      targetStage: resolvedTargetStage,
      reason: `REJECT budget exhausted for stage "${resolvedTargetStage}" (${maxRejects} re-work${maxRejects === 1 ? '' : 's'} already forced); rejected work remains unsatisfied. Last reason: ${signal.reason}`,
    };
  }
  return {
    action: 'rework',
    targetStage: resolvedTargetStage,
    nextCount: rejectsUsedForStage + 1,
    reason: signal.reason,
  };
}

/** Read any pending supervisor REJECT signal from the run's signals dir. Returns
 * the per-stage signal first (reject_<stage>.json), else the run-level reject.json.
 * Does NOT consume (delete) — the caller deletes once it acts. */
export function readPendingRejectSignal(runDirPath: string): { path: string; signal: SupervisorRejectSignal } | null {
  const signalsDir = join(runDirPath, 'signals');
  let entries: string[];
  try { entries = readdirSync(signalsDir); } catch { return null; }
  const perStage = entries
    .filter((file) => file !== 'reject_counts.json' && /^reject_.+\.json$/.test(file))
    .sort();
  const pick = perStage.length > 0 ? perStage[0] : (entries.includes('reject.json') ? 'reject.json' : null);
  if (!pick) return null;
  const path = join(signalsDir, pick);
  let reason = 'supervisor rejected the deliverable as not meeting its declared work';
  let targetStage: string | null = null;
  try {
    const sig = JSON.parse(readFileSync(path, 'utf-8')) as { reason?: string; stage?: string; evidence?: SupervisorEvidenceBinding };
    if (sig.reason) reason = sig.reason;
    if (typeof sig.stage === 'string') targetStage = sig.stage;
    if (sig.evidence && sig.evidence.version === 1) {
      return { path, signal: { targetStage, reason, evidence: sig.evidence } };
    }
  } catch { /* malformed; keep generic reason */ }
  if (!targetStage && pick.startsWith('reject_')) targetStage = pick.slice('reject_'.length, -'.json'.length);
  return { path, signal: { targetStage, reason } };
}

/** Read/persist the per-stage reject counts (bounds re-work loops across iterations). */
function readRejectCounts(runDirPath: string): Record<string, number> {
  try { return JSON.parse(readFileSync(join(runDirPath, 'signals', 'reject_counts.json'), 'utf-8')); } catch { return {}; }
}

function writeRejectCounts(runDirPath: string, counts: Record<string, number>): void {
  try {
    mkdirSync(join(runDirPath, 'signals'), { recursive: true });
    writeFileSync(join(runDirPath, 'signals', 'reject_counts.json'), JSON.stringify(counts), 'utf-8');
  } catch { /* non-critical */ }
}

function rawGateVerdict(path: string): { pass: boolean; reason: string } | undefined {
  try {
    const verdict = JSON.parse(readFileSync(path, 'utf8')) as { pass?: unknown; reason?: unknown };
    if (typeof verdict.pass === 'boolean') return {
      pass: verdict.pass, reason: typeof verdict.reason === 'string' ? verdict.reason : '',
    };
  } catch { /* missing or malformed verdict */ }
  return undefined;
}

export interface SupervisorRejectEffects {
  observeStableBlockage(input: { runDirPath: string; kind: string; detail: string; stageId?: string; evidenceDigest?: string; repairDigest?: string; threshold?: number }): ReturnType<typeof recordBlockageOccurrence> | undefined;
  concludeRepeatedBlockage(state: StoreState, ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number }): StoreState | null;
  writeCampaignEntry(projectDir: string, state: StoreState): void;
  appendSchedulerGuidanceOnce(runDirPath: string, target: string, marker: string, body: string, knownStageIds?: readonly string[]): void;
}

export function createSupervisorRejectConsumer({ observeStableBlockage, concludeRepeatedBlockage, writeCampaignEntry, appendSchedulerGuidanceOnce }: SupervisorRejectEffects) {
  return (function consumeSupervisorReject(
    state: StoreState,
    sorted: StageConfig[],
    iterationDispatchedIds: string[],
    ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number },
  ): boolean {
    const pending = readPendingRejectSignal(ctx.runDirPath);
    if (!pending) return false;

    // Resolve the target stage. A named target must be a real stage that ran this
    // iteration. A run-level reject (no target) maps to the most-recently-completed
    // dispatched stage in this iteration.
    const completedThisIter = (id: string) =>
      state.stages[id]?.status === STAGE_STATUS.COMPLETE &&
      (iterationDispatchedIds.includes(id) || sorted.some((s) => s.id === id));
    let resolved: string | null = null;
    if (pending.signal.targetStage && completedThisIter(pending.signal.targetStage)) {
      resolved = pending.signal.targetStage;
    } else if (!pending.signal.targetStage) {
      const candidates = iterationDispatchedIds
        .filter(completedThisIter)
        .map((id) => ({ id, at: state.stages[id]?.completedAt ?? '' }))
        .sort((a, b) => (a.at < b.at ? 1 : -1));
      resolved = candidates.length > 0 ? candidates[0].id : null;
    }

    if (pending.signal.evidence) {
      const target = pending.signal.targetStage;
      const current = target && state.stages[target]
        ? computeSupervisorEvidenceBinding(ctx.runDirPath, target, state.stages[target])
        : undefined;
      const bound = pending.signal.evidence;
      const matches = Boolean(current?.emittedDeliverable
        && target === bound.stageId
        && current.attemptIndex === bound.attemptIndex
        && current.attemptStartedAt === bound.attemptStartedAt
        && current.generation === bound.generation);
      if (!matches) {
        const discardedAt = new Date().toISOString();
        const archiveDir = join(ctx.runDirPath, 'supervisor_rejections', 'discarded');
        mkdirSync(archiveDir, { recursive: true });
        publishJsonCreateOnly(join(archiveDir, `${discardedAt.replace(/[:.]/g, '-')}_${bound.stageId}_${bound.attemptIndex}.json`), {
          version: 1,
          discardedAt,
          reason: 'attempt/evidence generation no longer matches the rejected deliverable',
          signal: pending.signal,
          currentEvidence: current ?? null,
        });
        try { unlinkSync(pending.path); } catch { /* already consumed */ }
        recordRunEvent(ctx.projectDir, ctx.runId, {
          type: 'supervisor_reject_discarded', runId: ctx.runId, timestamp: discardedAt,
          stageId: bound.stageId, attemptIndex: bound.attemptIndex,
          attemptStartedAt: bound.attemptStartedAt, evidenceGeneration: bound.generation,
          decision: 'discarded', detail: 'stale attempt/evidence generation', source: 'scheduler', level: 'warning',
        });
        return false;
      }
    }

    const counts = readRejectCounts(ctx.runDirPath);
    const usedForStage = resolved ? (counts[resolved] ?? 0) : 0;
    const maxRejects = Math.max(0, Math.floor(Number(loadDefaults(ctx.projectDir).supervisor_max_rejects)));
    const decision = decideRejectAction(pending.signal, resolved, usedForStage, maxRejects);
    const targetConfig = decision.targetStage
      ? sorted.find((stage) => stage.id === decision.targetStage)
      : undefined;
    // A gate verdict identifies a gate attempt, while a supervisor signal binds
    // to a producer attempt. Neither carries a shared defect ID. Even identical
    // free-text reasons can describe separate failures, so retain the REJECT's
    // bounded rework/escalation path instead of discarding it as gate-covered.
    const rejectedEvidencePath = decision.targetStage
      ? targetConfig?.is_gate
        ? join(ctx.runDirPath, `verdict_${decision.targetStage}.json`)
        : join(ctx.runDirPath, 'stages', decision.targetStage, 'output.md')
      : pending.path;
    let rejectedEvidenceDigest: string | undefined;
    try {
      rejectedEvidenceDigest = createHash('sha256').update(readFileSync(rejectedEvidencePath)).digest('hex');
    } catch { /* absence is still represented by the structured target/cause */ }
    const blockage = observeStableBlockage({
      runDirPath: ctx.runDirPath,
      kind: 'supervisor_reject',
      stageId: decision.targetStage,
      detail: pending.signal.reason,
      evidenceDigest: rejectedEvidenceDigest,
      threshold: state.campaignTriggers?.repeatedFailureAfter,
    });

    // Consume the signal (one-shot) regardless of outcome.
    try { unlinkSync(pending.path); } catch { /* already gone */ }

    if (blockage?.escalatedNow) {
      concludeRepeatedBlockage(state, ctx);
      return false;
    }

    if (decision.action === 'escalate') {
      state.status = RUN_STATUS.ESCALATED;
      state.failureReason = decision.reason;
      state.completedAt = new Date().toISOString();
      markLeftoverStagesSkipped(state, `supervisor rejection escalated: ${decision.reason}`);
      writeRunState(ctx.projectDir, ctx.runId, state);
      writeCampaignEntry(ctx.projectDir, state);
      recordRunEvent(ctx.projectDir, ctx.runId, {
        type: 'run_completed',
        runId: ctx.runId,
        timestamp: state.completedAt,
        iteration: ctx.iteration,
        ...(decision.targetStage ? { stageId: decision.targetStage } : {}),
        detail: decision.reason,
      });
      log.warn({ runId: ctx.runId, iteration: ctx.iteration, reason: decision.reason }, 'Supervisor REJECT escalated; rejected work was not accepted');
      return false;
    }

    // Re-pend the target stage so it is re-done; clear its verdict; re-pend (and
    // clear verdict for) any gate stage that depends on it so the gate re-evaluates
    // the re-worked deliverable instead of the stale pass.
    const repend = (id: string) => {
      state.stages[id] = rependStageStatus(state.stages[id], 0);
      try { mkdirSync(join(ctx.runDirPath, 'stages', id), { recursive: true }); } catch { /* ignore */ }
      const v = join(ctx.runDirPath, `verdict_${id}.json`);
      try { if (existsSync(v)) unlinkSync(v); } catch { /* ignore */ }
      const m = join(ctx.runDirPath, 'stages', id, 'metric.json');
      try { if (existsSync(m)) unlinkSync(m); } catch { /* ignore */ }
    };
    if (targetConfig?.is_gate) {
      const repairStages = sorted.filter((stage) => !stage.is_gate && stage.retry_to?.includes(targetConfig.id));
      if (repairStages.length === 0) {
        state.status = RUN_STATUS.ESCALATED;
        state.failureReason = `Supervisor rejected gate '${targetConfig.id}', but the admitted dispatch has no retry_to repair route: ${decision.reason}`;
        state.completedAt = new Date().toISOString();
        markLeftoverStagesSkipped(state, state.failureReason);
        writeRunState(ctx.projectDir, ctx.runId, state);
        writeCampaignEntry(ctx.projectDir, state);
        recordRunEvent(ctx.projectDir, ctx.runId, {
          type: 'run_completed', runId: ctx.runId, timestamp: state.completedAt,
          iteration: ctx.iteration, stageId: targetConfig.id, detail: state.failureReason,
        });
        return false;
      }
      // Preserve the accepted gate evidence before converting the supervisor's
      // rejection into the same authoritative pass:false fact consumed by the
      // normal bounded retry loop.
      const verdictPath = join(ctx.runDirPath, `verdict_${targetConfig.id}.json`);
      const archiveDir = join(
        ctx.runDirPath,
        'supervisor_rejections',
        targetConfig.id,
        `reject_${decision.nextCount}`,
      );
      mkdirSync(archiveDir, { recursive: true });
      try { if (existsSync(verdictPath)) copyFileSync(verdictPath, join(archiveDir, 'verdict_before.json')); } catch { /* audit best effort */ }
      writeFileSync(join(archiveDir, 'decision.json'), `${JSON.stringify({
        version: 1,
        targetStage: targetConfig.id,
        reason: decision.reason,
        rejectedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf-8');
      const existingNegative = rawGateVerdict(verdictPath)?.pass === false;
      const statusOnlyObjection = /complete.*(?:rejecting|negative|pass:false).*verdict|completion contradicts its own verdict/i.test(decision.reason);
      if (!(existingNegative && statusOnlyObjection)) {
        writeFileSync(verdictPath, `${JSON.stringify({
          pass: false,
          outcome: 'repair-required',
          reason: `Supervisor REJECT: ${decision.reason}`,
          source: 'supervisor_reject',
        }, null, 2)}\n`, 'utf-8');
      }
      for (const repair of repairStages) {
        state.stages[repair.id] = rependStageStatus(state.stages[repair.id], 0);
        appendSchedulerGuidanceOnce(
          ctx.runDirPath,
          repair.id,
          `[supervisor-reject:${targetConfig.id}:${decision.nextCount}]`,
          `Gate "${targetConfig.id}" was rejected by the supervisor: ${decision.reason}\nRun this admitted repair route, change the rejected evidence, and let ${targetConfig.id} re-evaluate it.`,
          sorted.map((stage) => stage.id),
        );
      }
      for (const dependentId of collectTransitiveDependents(targetConfig.id, sorted)) {
        const dependent = sorted.find((stage) => stage.id === dependentId);
        if (dependent && !dependent.retry_to?.includes(targetConfig.id)) repend(dependent.id);
      }
    } else {
      repend(decision.targetStage);
      for (const s of sorted) {
        if (s.is_gate && (s.depends_on ?? []).includes(decision.targetStage)) repend(s.id);
      }
      // Inject the rejection reason only into the target stage's delivery.
      appendSchedulerGuidanceOnce(
        ctx.runDirPath,
        decision.targetStage,
        `[supervisor-reject:${decision.targetStage}:${decision.nextCount}]`,
        `⚠️ DELIVERABLE REJECTED (supervisor REJECT) — stage "${decision.targetStage}": ${decision.reason}\n`
          + 'The previous deliverable did NOT meet its declared work/criteria. Re-do this stage and produce a deliverable that actually satisfies the stated criteria; do not re-submit the same result.',
        sorted.map((stage) => stage.id),
      );
    }

    counts[decision.targetStage] = decision.nextCount;
    writeRejectCounts(ctx.runDirPath, counts);
    state.status = 'running';
    writeRunState(ctx.projectDir, ctx.runId, state);
    recordRunEvent(ctx.projectDir, ctx.runId, {
      type: 'supervisor_reject',
      runId: ctx.runId,
      timestamp: new Date().toISOString(),
      iteration: ctx.iteration,
      stageId: decision.targetStage,
      detail: `reject ${decision.nextCount}/${maxRejects}: ${decision.reason}`,
    });
    log.warn({ runId: ctx.runId, iteration: ctx.iteration, stage: decision.targetStage, count: decision.nextCount, max: maxRejects }, 'Supervisor REJECT — deliverable not accepted, forcing re-work');
    return true;
  });
}
