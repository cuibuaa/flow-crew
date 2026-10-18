// Boundary: Authenticate attempt/path identity, validate capability expansion against frozen inputs/owners/peers, and read durable inherited decisions.
import { type RuntimeConstraintDecisionV1, type ScopeRevisionRequestV1, parseScopeRevisionRequest, readAcceptedScopeRevisionDecisions } from "../../runtime-negotiation.js";
import { SCOPE_REVISION_REQUEST_FILE } from "../../live-constraint-guard.js";
import { join, basename, relative } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { readStageStatus, runningStageAttempt, readRunState, runDir } from "../../store.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { parseDeclaredScope } from "../sched_admission/frontier.js";
import { normalizedProjectContentPath, normalizedProjectPath, scopeMatchesProjectPath } from "../sched_admission/scope-services.js";
import { listProjectFiles, listProjectFilesAt, resolveDeclaredInputWriteBindings, scopeRequestAlreadyAuthorized } from './path-capabilities.js';
import { type RepairRoundSnapshot } from './snapshots.js';
import { captureRollbackCurrentImage, trackedGitlinkAncestor } from './rollback-baseline.js';
import { createDispatchAdmission, inspectCapabilityAdmission, readBriefCriteriaForAdmission, validatedCriterionDischarges } from '../sched_admission/dispatch.js';
import { firstDeclaredInputScopeConflict } from './path-capabilities.js';

type ScopeRevisionDecision = RuntimeConstraintDecisionV1;

export function readScopeRevisionRequest(stagePath: string, runId: string): ScopeRevisionRequestV1 | undefined {
  try {
    const parsed = parseScopeRevisionRequest(
      JSON.parse(readFileSync(join(stagePath, SCOPE_REVISION_REQUEST_FILE), 'utf-8')),
      'stage',
      { runId },
    );
    return parsed.ok ? parsed.request : undefined;
  } catch {
    return undefined;
  }
}

export function currentStageAttemptIndex(projectDir: string, runId: string, stageId: string): number | undefined {
  try {
    return runningStageAttempt(readStageStatus(projectDir, runId, stageId))?.index;
  } catch { /* the request will be rejected until a running attempt exists */ }
  return undefined;
}

function scopeRevisionRejection(
  request: ScopeRevisionRequestV1,
  priorScope: string[] | null,
  rejectionReason: string,
  conflictingStageId?: string,
): Record<string, unknown> & { accepted: false; decision: 'rejected' } {
  return {
    accepted: false,
    decision: 'rejected',
    decidedAt: new Date().toISOString(),
    policyBasis: rejectionReason,
    requestedPaths: request.requestedPaths,
    authorizedPaths: [],
    priorScope,
    effectiveScope: priorScope ?? [],
    rejectionReason,
    ...(conflictingStageId ? { conflictingStageId } : {}),
  };
}

export function decideScopeRevision(input: {
  request: ScopeRevisionRequestV1;
  stage: StageConfig;
  priorScope: string[] | null;
  activePeers: StageConfig[];
  projectDir: string;
  runId: string;
  attemptIndex?: number;
  snapshot?: RepairRoundSnapshot;
}): Record<string, unknown> & { accepted: boolean; decision: 'accepted' | 'rejected' } {
  const { request, stage, priorScope, activePeers, projectDir, runId, snapshot } = input;
  if (request.runId !== runId) {
    return scopeRevisionRejection(request, priorScope, `request runId ${request.runId} does not match ${runId}`);
  }
  if (request.stageId !== stage.id) {
    return scopeRevisionRejection(request, priorScope, `request stageId ${request.stageId} does not match ${stage.id}`);
  }
  const attemptIndex = input.attemptIndex ?? currentStageAttemptIndex(projectDir, runId, stage.id);
  if (request.attemptIndex !== attemptIndex) {
    return scopeRevisionRejection(request, priorScope, `request attempt ${String(request.attemptIndex)} does not match running attempt ${String(attemptIndex)}`);
  }
  if (request.requestedPaths.length === 0) {
    return scopeRevisionRejection(request, priorScope, 'requestedPaths must contain at least one project-relative path');
  }
  const normalizedPaths: string[] = [];
  for (const rawPath of request.requestedPaths) {
    const normalized = normalizedProjectPath(rawPath);
    if (!normalized) {
      return scopeRevisionRejection(request, priorScope, `requested path is not project-relative: ${rawPath}`);
    }
    normalizedPaths.push(normalized);
  }
  const requestedPaths = [...new Set(normalizedPaths)];
  const requestedScopes = requestedPaths.map(parseDeclaredScope);
  if (requestedScopes.some((scope) => scope.kind === 'unknown')) {
    return scopeRevisionRejection(request, priorScope, 'every requested capability must have a valid project-relative scope');
  }
  // Reservations are loaded once; an unavailable inventory proves no subset safe.
  let state: ReturnType<typeof readRunState> | undefined;
  try { state = readRunState(projectDir, runId); } catch (error) {
    if (existsSync(join(runDir(projectDir, runId), 'run.json'))) return scopeRevisionRejection(request, priorScope,
      `could not revalidate plan admission: ${error instanceof Error ? error.message : String(error)}`);
  }
  let declaredInputs: ReturnType<typeof resolveDeclaredInputWriteBindings>;
  try {
    const briefPath = join(runDir(projectDir, runId), 'task_brief.md');
    declaredInputs = existsSync(briefPath)
      ? resolveDeclaredInputWriteBindings(projectDir, readFileSync(briefPath, 'utf-8')) : [];
  } catch (error) {
    return scopeRevisionRejection(request, priorScope,
      `could not verify declared-input reservations: ${error instanceof Error ? error.message : String(error)}`);
  }
  let terminalOwners: Record<string, string> = {};
  try {
    terminalOwners = (JSON.parse(readFileSync(join(runDir(projectDir, runId), 'dispatch_admission.json'), 'utf-8')) as {
      terminalOwners?: Record<string, string>;
    }).terminalOwners ?? {};
  } catch { /* static workflows may have no dispatch admission artifact */ }
  const priorScopes = (priorScope ?? []).map(parseDeclaredScope);
  const capability = { stage: { ...stage, scope: priorScope ?? [] }, paths: requestedPaths, activePeers, declaredInputs, projectDir, research: state?.research };
  let conflicts: ReturnType<typeof inspectCapabilityAdmission>;
  if (state?.planControl?.stages.some(candidate => candidate.dynamic_dispatch)) {
    try {
      const directory = runDir(projectDir, runId);
      if (!state.dispatchedStages?.length) throw new Error('admitted dispatch population is unavailable');
      const dispatchedIds = new Set(state.dispatchedStages.map(candidate => {
        if (candidate && typeof candidate === 'object' && 'id' in candidate && typeof candidate.id === 'string') return candidate.id;
        throw new Error('admitted dispatch stage identity is invalid');
      }));
      const stages = state.planControl.stages.map(candidate => ({
        ...stageWithInheritedScope(directory, candidate),
        ...(candidate.id === stage.id ? { scope: [...new Set([...(priorScope ?? []), ...requestedPaths])] } : {}),
      }));
      const recordedCriteria = readBriefCriteriaForAdmission(directory);
      const criteria = recordedCriteria?.criteria.length === 0 && !state.briefAdmission ? undefined : recordedCriteria;
      const admission = createDispatchAdmission(firstDeclaredInputScopeConflict)({
        dispatched: stages.filter(candidate => dispatchedIds.has(candidate.id)),
        baseStages: stages.filter(candidate => !dispatchedIds.has(candidate.id)),
        dispatchStageId: stages.find(candidate => candidate.dynamic_dispatch)?.id ?? 'plan',
        criteria, criterionDischarges: validatedCriterionDischarges(directory, state, criteria?.briefDigest),
        terminalStates: state.terminalStates, research: state.research,
        declaredInputs, projectDir, runDir: directory,
        scopeRevision: { stageId: stage.id, paths: requestedPaths, priorScope: priorScope ?? [], activePeers },
      });
      if (!admission.pass) return { ...scopeRevisionRejection(request, priorScope, admission.errors.join('; ')),
        ...(admission.capabilityConflicts?.length ? { conflicts: admission.capabilityConflicts,
          rejectedPaths: [...new Set(admission.capabilityConflicts.map(conflict => conflict.path))] } : {}) };
      for (const [path, owner] of Object.entries(terminalOwners)) {
        if (admission.terminalOwners[path] !== owner) return scopeRevisionRejection(request, priorScope,
          `scope revision cannot transfer terminal ownership of ${path} from ${owner} to ${admission.terminalOwners[path] ?? 'no owner'}`);
      }
      conflicts = admission.capabilityConflicts ?? [];
    } catch (error) {
      return scopeRevisionRejection(request, priorScope,
        `could not revalidate plan admission: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    conflicts = inspectCapabilityAdmission(capability, firstDeclaredInputScopeConflict);
  }
  const withheld = new Set(conflicts.map(conflict => conflict.path));
  const authorizedPaths: string[] = [];
  const alreadyAuthorizedPaths: string[] = [];
  for (const path of requestedPaths) if (!withheld.has(path)) {
    (scopeRequestAlreadyAuthorized(parseDeclaredScope(path), priorScopes) ? alreadyAuthorizedPaths : authorizedPaths).push(path);
  }
  const rejectedPaths = [...new Set(conflicts.map(conflict => conflict.path))];
  const diagnostics = conflicts.length ? { rejectedPaths, conflicts } : {};
  if (authorizedPaths.length === 0 && alreadyAuthorizedPaths.length === 0) {
    return { ...scopeRevisionRejection({ ...request, requestedPaths }, priorScope,
      conflicts.map(conflict => `${conflict.path}: ${conflict.reason}`).join('; '),
      conflicts.find(conflict => conflict.conflictingStageId)?.conflictingStageId), ...diagnostics };
  }
  // Capture only the admitted subset before publication. Withheld capabilities
  // never become inherited scope or retrospective write authorization.
  if (snapshot) for (const path of authorizedPaths) {
    const scope = parseDeclaredScope(path);
    const root = scope.kind === 'glob' ? scope.directoryPrefix : scope.kind === 'unknown' ? undefined : scope.value;
    const inventory = { complete: true, skipDirectory: (directory: string) => !normalizedProjectContentPath(directory) };
    const members = root ? listProjectFilesAt(projectDir, root, true, inventory) : listProjectFiles(projectDir, inventory);
    members.push(...snapshot.rollbackBaseline.trackedPaths);
    if (scope.kind === 'exact') members.push(path);
    const captured = new Set<string>();
    for (const member of new Set(members)) if (normalizedProjectContentPath(member) && scopeMatchesProjectPath(scope, member)) {
      const target = trackedGitlinkAncestor(snapshot.rollbackBaseline, member) ?? member;
      if (captured.has(target)) continue;
      const image = captureRollbackCurrentImage(snapshot.rollbackBaseline, projectDir, target, snapshot.files.get(target));
      if (image.inspectionFailure || (image.materializationFailure && !image.gitObjectId)) {
        throw new Error(image.inspectionFailure ?? image.materializationFailure);
      }
      snapshot.files.set(target, image);
      captured.add(target);
    }
  }
  return {
    requestedPaths,
    authorizedPaths,
    ...(alreadyAuthorizedPaths.length > 0 ? { alreadyAuthorizedPaths } : {}),
    ...diagnostics,
    accepted: true,
    decision: 'accepted',
    decidedAt: new Date().toISOString(),
    policyBasis: (authorizedPaths.length === 0
      ? 'requested paths are already authorized by the stable effective scope'
      : 'current attempt, admitted ownership and reservations; current pre-write baseline captured; authority is prospective')
      + (rejectedPaths.length ? `; ${rejectedPaths.length} requested capabilities withheld: ${conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`).join('; ')}` : ''),
    priorScope,
    effectiveScope: [...new Set([...(priorScope ?? []), ...authorizedPaths])],
  };
}

export function readScopeRevisionDecisions(runDirPath: string, stageIds: string[]): ScopeRevisionDecision[] {
  const decisions: ScopeRevisionDecision[] = [];
  for (const stageId of stageIds) {
    const stagePath = join(runDirPath, 'stages', stageId);
    let files: string[];
    try { files = readdirSync(stagePath); } catch { continue; }
    for (const file of files.filter((name) => /^scope_revision_decision_.*\.json$/.test(name)).sort()) {
      try { decisions.push(JSON.parse(readFileSync(join(stagePath, file), 'utf-8')) as ScopeRevisionDecision); } catch { /* incomplete artifact */ }
    }
  }
  return decisions;
}

export function acceptedInheritedScope(
  runDirPath: string,
  stage: StageConfig,
): { scope: string[]; decisionPaths: string[] } {
  const scope = new Set(stage.scope ?? []);
  const decisionPaths: string[] = [];
  const stagePath = join(runDirPath, 'stages', stage.id);
  for (const grant of readAcceptedScopeRevisionDecisions(stagePath, { runId: basename(runDirPath), stageId: stage.id })) {
    for (const path of grant.authorizedPaths) scope.add(path);
    decisionPaths.push(relative(runDirPath, grant.path).replace(/\\/g, '/'));
  }
  return { scope: [...scope], decisionPaths };
}

/** Rehydrate accepted capability before scheduling so ordinary peer-conflict
 * checks revalidate the inherited paths in the new batch. */
export function stageWithInheritedScope(runDirPath: string, stage: StageConfig): StageConfig {
  const inherited = acceptedInheritedScope(runDirPath, stage);
  if (stage.scope === undefined && inherited.decisionPaths.length === 0) return stage;
  return { ...stage, scope: inherited.scope };
}
