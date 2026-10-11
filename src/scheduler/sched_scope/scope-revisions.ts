// Boundary: Authenticate attempt/path identity, validate capability expansion against frozen inputs/owners/peers/preimages, and read durable inherited decisions.
import { type RuntimeConstraintDecisionV1, type ScopeRevisionRequestV1, parseScopeRevisionRequest, scopePathDigest, readAcceptedScopeRevisionDecisions } from "../../runtime-negotiation.js";
import { readLiveConstraintIncidents, readLiveConstraintContentIdentity, compareLiveConstraintContentIdentities, type LiveConstraintContentIdentity, SCOPE_REVISION_REQUEST_FILE } from "../../live-constraint-guard.js";
import { join, basename, relative } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { STAGE_STATUS, readStageStatus, readRunState, runDir } from "../../store.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { findScopeConflict, parseDeclaredScope } from "../sched_admission/frontier.js";
import { normalizedProjectPath, scopeMatchesProjectPath } from "../sched_admission/scope-services.js";
import { resolveResearchPaths } from "../../research-paths.js";
import { stableGeneratedScope } from "../../generated-path-policy.js";
import { declaredInputScopeConflict, listProjectFilesAt, resolveDeclaredInputWriteBindings, scopeRequestAlreadyAuthorized } from './path-capabilities.js';
import { type RepairRoundSnapshot, changedProjectPathsSinceSnapshot } from './snapshots.js';
import { baselineImage, readRollbackCurrentImage } from './rollback-baseline.js';
import { compareRepairFileContents } from './file-images.js';
import { createDispatchAdmission, readBriefCriteriaForAdmission, validatedCriterionDischarges } from '../sched_admission/dispatch.js';
import { firstDeclaredInputScopeConflict } from './path-capabilities.js';
import { producesEngineOwnedArtifact } from '../../artifact-declarations.js';

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
    const attempts = readStageStatus(projectDir, runId, stageId).attempts ?? [];
    for (let index = attempts.length - 1; index >= 0; index--) {
      if (attempts[index].status === STAGE_STATUS.RUNNING) return attempts[index].index;
    }
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
  if (!Number.isInteger(request.attemptIndex) || request.attemptIndex < 1 || request.attemptIndex !== attemptIndex) {
    return scopeRevisionRejection(request, priorScope, `request attempt ${String(request.attemptIndex)} does not match running attempt ${String(attemptIndex)}`);
  }
  if (!request.reason) {
    return scopeRevisionRejection(request, priorScope, 'scope revision reason must be non-empty');
  }
  if (!Array.isArray(request.requestedPaths) || request.requestedPaths.length === 0) {
    return scopeRevisionRejection(request, priorScope, 'requestedPaths must contain at least one project-relative path');
  }
  if (request.pathDigest !== scopePathDigest(request.requestedPaths)) {
    return scopeRevisionRejection(request, priorScope, 'pathDigest does not match canonical requestedPaths');
  }
  const normalizedPaths: string[] = [];
  for (const rawPath of request.requestedPaths) {
    if (typeof rawPath !== 'string') {
      return scopeRevisionRejection(request, priorScope, 'every requested path must be a string');
    }
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
  // Reservations are loaded once. An unavailable input inventory cannot prove
  // any subset safe; path conflicts below, unlike identity failures, are local.
  let manifest: string | undefined;
  try {
    const state = readRunState(projectDir, runId);
    if (state.research) manifest = normalizedProjectPath(resolveResearchPaths(state.research).manifestFile);
  } catch { /* static fixtures may have no run state */ }
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
  // An invalid active admission is not repaired by granting a subset.
  const priorConflicts = (priorScope?.length ? activePeers : []).flatMap((peer) => {
    const conflict = findScopeConflict({ ...stage, scope: priorScope ?? [] }, peer);
    return conflict ? [{ conflictingStageId: peer.id, reason: `existing scope conflicts with running peer ${peer.id}: ${conflict.reason}` }] : [];
  });
  if (priorConflicts.length > 0) return {
    ...scopeRevisionRejection(request, priorScope, priorConflicts.map((conflict) => conflict.reason).join('; '), priorConflicts[0].conflictingStageId),
    priorScopeConflicts: priorConflicts,
  };
  const conflicts: Array<{ path: string; reason: string; conflictingStageId?: string }> = [];
  const authorizedPaths: string[] = [];
  const alreadyAuthorizedPaths: string[] = [];
  // Retries can recreate the batch. Recovery evidence belongs to the existing
  // durable engine incident stream, never the stage's cleanup assertion.
  const unrestoredWrites = new Map<string, LiveConstraintContentIdentity>();
  for (let index = 1; index <= request.attemptIndex; index++) {
    for (const incident of readLiveConstraintIncidents(runDir(projectDir, runId), stage.id, index)) {
      if (incident.restored) { unrestoredWrites.delete(incident.path); continue; }
      if (incident.changeObserved && incident.rollbackAttempted && incident.rollbackFailure
          && incident.unrestoredContent?.state === 'present') {
        unrestoredWrites.set(incident.path, incident.unrestoredContent);
      }
    }
  }
  const changedSinceSnapshot = snapshot ? changedProjectPathsSinceSnapshot(snapshot, projectDir) : [];
  for (let index = 0; index < requestedPaths.length; index++) {
    const path = requestedPaths[index], scope = requestedScopes[index];
    const deny = (reason: string, conflictingStageId?: string): void => {
      conflicts.push({ path, reason, ...(conflictingStageId ? { conflictingStageId } : {}) });
    };
    const conflictStart = conflicts.length;
    if (manifest && scopeMatchesProjectPath(scope, manifest)) {
      deny(`requested capability contains framework-owned research manifest ${manifest}, which the scheduler rewrites between rounds`);
    }
    for (const input of declaredInputs) {
      const conflict = declaredInputScopeConflict(path, input, projectDir);
      if (conflict) deny(`requested write capability ${JSON.stringify(conflict.scope)} overlaps declared read-only input ${conflict.inputPath} (${conflict.inputKind}, ${conflict.comparison})`);
    }
    for (const [terminalPath, ownerId] of Object.entries(terminalOwners)) {
      const normalizedTerminal = normalizedProjectPath(terminalPath);
      if (ownerId !== stage.id && normalizedTerminal && scopeMatchesProjectPath(scope, normalizedTerminal)) {
        deny(`requested capability contains terminal path ${terminalPath}, whose admitted owner is ${ownerId}; scope revision cannot transfer terminal ownership`, ownerId);
      }
    }
    for (const peer of activePeers) {
      // Compare every peer capability, not just the first overlapping member.
      for (const peerScope of peer.scope ?? [undefined]) {
        const conflict = findScopeConflict({ ...stage, scope: [path] }, {
          ...peer, scope: peerScope === undefined ? undefined : [peerScope],
        });
        if (conflict) deny(`scope revision conflicts with running peer ${peer.id}: ${conflict.reason}`, peer.id);
      }
    }
    const alreadyAuthorized = scopeRequestAlreadyAuthorized(scope, priorScopes);
    if (snapshot && !alreadyAuthorized) {
      const candidates = new Set([path]);
      for (const member of unrestoredWrites.keys()) {
        if (scopeMatchesProjectPath(scope, member)) candidates.add(member);
      }
      const root = scope.kind === 'glob' ? scope.directoryPrefix : scope.kind === 'unknown' ? undefined : scope.value;
      if (root) for (const member of listProjectFilesAt(projectDir, root)) {
        if (scopeMatchesProjectPath(scope, member)) candidates.add(member);
      }
      const changedPaths = new Set([...candidates].filter((member) => compareRepairFileContents(
        snapshot.files.get(member) ?? baselineImage(snapshot.rollbackBaseline, member),
        readRollbackCurrentImage(snapshot.rollbackBaseline, projectDir, member),
      ) === 'different'));
      for (const member of changedSinceSnapshot) if (scopeMatchesProjectPath(scope, member)) changedPaths.add(member);
      for (const member of [...changedPaths].sort()) {
        // A failed rollback must not make future authority impossible. Admit
        // only the exact recorded path, still at the engine-observed content;
        // the ordinary reservation/peer/admission checks above remain binding.
        // This captures today's preimage below, without ratifying the old write
        // or claiming that an unobserved baseline can be restored safely.
        const unrestored = unrestoredWrites.get(member);
        if (scope.kind === 'exact' && path === member && unrestored?.state === 'present'
            && (unrestored.type === 'file' || unrestored.type === 'symlink')
            && !member.split('/').some(segment => ['.git', '.fc', '.github', '.codex', '.claude'].includes(segment)
              || segment.startsWith('.env'))
            && compareLiveConstraintContentIdentities(unrestored,
              readLiveConstraintContentIdentity(join(projectDir, member))) === 'equal') {
          try {
            if (!producesEngineOwnedArtifact({ id: 'scope-recovery', root: 'project', path: member, kind: 'file', nonempty: false },
              stage, runDir(projectDir, runId), projectDir)) continue;
          } catch { /* Unverifiable identities cannot acquire recovery authority. */ }
        }
        const stableParent = stableGeneratedScope(member);
        if (stableParent === path) continue;
        const correction = stableParent
          ? `Request the stable generated parent ${JSON.stringify(stableParent)} before running the generator, or request this literal before writing it.`
          : 'Request this capability before writing it, then retry the attempt.';
        deny(`requested content changed before scope approval: ${member}. ${correction}`);
      }
    }
    if (conflicts.length === conflictStart) {
      (alreadyAuthorized ? alreadyAuthorizedPaths : authorizedPaths).push(path);
    }
  }
  const rejectedPaths = [...new Set(conflicts.map((conflict) => conflict.path))];
  const diagnostics = conflicts.length > 0 ? { rejectedPaths, conflicts } : {};
  if (authorizedPaths.length === 0 && alreadyAuthorizedPaths.length === 0) {
    return { ...scopeRevisionRejection({ ...request, requestedPaths }, priorScope,
      conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`).join('; '),
      conflicts.find((conflict) => conflict.conflictingStageId)?.conflictingStageId), ...diagnostics };
  }
  // A scope grant changes the plan's authority, so use initial-plan admission
  // again before publishing it. In particular a read-only audit cannot become
  // its own product author. Static workflows never passed dispatch admission.
  try {
    const state = readRunState(projectDir, runId);
    if (state.planControl?.stages.some((candidate) => candidate.dynamic_dispatch)) {
      const directory = runDir(projectDir, runId);
      if (!state.dispatchedStages?.length) throw new Error('admitted dispatch population is unavailable');
      const dispatchedIds = new Set(state.dispatchedStages.map((candidate) => {
        if (candidate && typeof candidate === 'object' && 'id' in candidate && typeof candidate.id === 'string') return candidate.id;
        throw new Error('admitted dispatch stage identity is invalid');
      }));
      const stages = state.planControl.stages.map((candidate) => ({
        ...stageWithInheritedScope(directory, candidate),
        ...(candidate.id === stage.id ? { scope: [...new Set([...(priorScope ?? []), ...authorizedPaths])] } : {}),
      }));
      const recordedCriteria = readBriefCriteriaForAdmission(directory);
      const criteria = recordedCriteria?.criteria.length === 0 && !state.briefAdmission ? undefined : recordedCriteria;
      const admission = createDispatchAdmission(firstDeclaredInputScopeConflict)({
        dispatched: stages.filter((candidate) => dispatchedIds.has(candidate.id)),
        baseStages: stages.filter((candidate) => !dispatchedIds.has(candidate.id)),
        dispatchStageId: stages.find((candidate) => candidate.dynamic_dispatch)?.id ?? 'plan',
        criteria, criterionDischarges: validatedCriterionDischarges(directory, state, criteria?.briefDigest),
        terminalStates: state.terminalStates, research: state.research,
        declaredInputs, projectDir, runDir: directory,
      });
      if (!admission.pass) return scopeRevisionRejection(request, priorScope, admission.errors.join('; '));
    }
  } catch (error) {
    // Standalone static fixtures have no run; a real run must prove admission.
    if (existsSync(join(runDir(projectDir, runId), 'run.json'))) {
      return scopeRevisionRejection(request, priorScope,
        `could not revalidate plan admission: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Capture only the admitted subset before publication. Withheld capabilities
  // never become inherited scope or retrospective write authorization.
  if (snapshot) for (const path of authorizedPaths) {
    snapshot.files.set(path, readRollbackCurrentImage(snapshot.rollbackBaseline, projectDir, path));
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
      : 'current attempt, unchanged requested-content preimage, exact engine-recorded failed rollback, or recognized stable generated-parent churn; valid project path and no active-peer scope conflict; authority is prospective')
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
