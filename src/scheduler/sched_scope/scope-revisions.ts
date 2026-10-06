// Boundary: Authenticate attempt/path identity, validate capability expansion against frozen inputs/owners/peers/preimages, and read durable inherited decisions.
import { type RuntimeConstraintDecisionV1, type ScopeRevisionRequestV1, parseScopeRevisionRequest, scopePathDigest, negotiationIdentity, readConstraintDecision } from "../../runtime-negotiation.js";
import { SCOPE_REVISION_REQUEST_FILE } from "../../live-constraint-guard.js";
import { join, basename, relative } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { STAGE_STATUS, readStageStatus, readRunState, runDir } from "../../store.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { findScopeConflict, parseDeclaredScope } from "../sched_admission/frontier.js";
import { normalizedProjectPath, scopeMatchesProjectPath } from "../sched_admission/scope-services.js";
import { resolveResearchPaths } from "../../research-paths.js";
import { stableGeneratedScope } from "../../generated-path-policy.js";
import { firstDeclaredInputScopeConflict, listProjectFilesAt, resolveDeclaredInputWriteBindings, scopeRequestAlreadyAuthorized } from './path-capabilities.js';
import { type RepairRoundSnapshot, changedProjectPathsSinceSnapshot } from './snapshots.js';
import { baselineImage, readRollbackCurrentImage } from './rollback-baseline.js';
import { compareRepairFileContents } from './file-images.js';

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
  try {
    const state = readRunState(projectDir, runId);
    if (state.research) {
      const manifest = normalizedProjectPath(resolveResearchPaths(state.research).manifestFile);
      if (manifest && requestedScopes.some((scope) => scopeMatchesProjectPath(scope, manifest))) {
        return scopeRevisionRejection(
          { ...request, requestedPaths },
          priorScope,
          `requested capability contains framework-owned research manifest ${manifest}, which the scheduler rewrites between rounds`,
        );
      }
    }
  } catch { /* an initialized run is validated by the remaining identity checks */ }
  try {
    const briefPath = join(runDir(projectDir, runId), 'task_brief.md');
    const declaredInputs = existsSync(briefPath)
      ? resolveDeclaredInputWriteBindings(projectDir, readFileSync(briefPath, 'utf-8'))
      : [];
    const conflict = firstDeclaredInputScopeConflict(requestedPaths, declaredInputs, projectDir);
    if (conflict) {
      return scopeRevisionRejection(
        { ...request, requestedPaths },
        priorScope,
        `requested write capability ${JSON.stringify(conflict.scope)} overlaps declared read-only input ${conflict.inputPath} (${conflict.inputKind}, ${conflict.comparison})`,
      );
    }
  } catch (error) {
    return scopeRevisionRejection(
      { ...request, requestedPaths },
      priorScope,
      `could not verify declared-input reservations: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const admission = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'dispatch_admission.json'), 'utf-8')) as {
      terminalOwners?: Record<string, string>;
    };
    for (const [terminalPath, ownerId] of Object.entries(admission.terminalOwners ?? {})) {
      if (ownerId === stage.id) continue;
      const normalizedTerminal = normalizedProjectPath(terminalPath);
      if (normalizedTerminal && requestedScopes.some((scope) => scopeMatchesProjectPath(scope, normalizedTerminal))) {
        return scopeRevisionRejection(
          { ...request, requestedPaths },
          priorScope,
          `requested capability contains terminal path ${terminalPath}, whose admitted owner is ${ownerId}; scope revision cannot transfer terminal ownership`,
          ownerId,
        );
      }
    }
  } catch { /* static workflows may have no dispatch admission artifact */ }
  const priorScopes = (priorScope ?? []).map(parseDeclaredScope);
  const alreadyAuthorizedPaths = requestedPaths.filter((_path, index) => (
    scopeRequestAlreadyAuthorized(requestedScopes[index], priorScopes)
  ));
  const alreadyAuthorized = new Set(alreadyAuthorizedPaths);
  const capabilityRequestPaths = requestedPaths.filter((path) => !alreadyAuthorized.has(path));
  const effectiveScope = [...new Set([...(priorScope ?? []), ...capabilityRequestPaths])];
  const expanded: StageConfig = { ...stage, scope: effectiveScope };
  for (const peer of activePeers) {
    const conflict = findScopeConflict(expanded, peer);
    if (conflict) {
      return scopeRevisionRejection(
        { ...request, requestedPaths },
        priorScope,
        `scope revision conflicts with running peer ${peer.id}: ${conflict.reason}`,
        peer.id,
      );
    }
  }
  if (snapshot) {
    const capabilityRequestScopes = capabilityRequestPaths.map(parseDeclaredScope);
    const requestedCandidates = new Set(capabilityRequestPaths);
    for (const scope of capabilityRequestScopes) {
      const root = scope.kind === 'glob' ? scope.directoryPrefix
        : scope.kind === 'unknown' ? undefined : scope.value;
      if (!root) continue;
      for (const path of listProjectFilesAt(projectDir, root)) {
        if (scopeMatchesProjectPath(scope, path)) requestedCandidates.add(path);
      }
    }
    const changedPaths = new Set([...requestedCandidates].filter((path) => compareRepairFileContents(
      snapshot.files.get(path) ?? baselineImage(snapshot.rollbackBaseline, path),
      readRollbackCurrentImage(snapshot.rollbackBaseline, projectDir, path),
    ) === 'different'));
    for (const path of changedProjectPathsSinceSnapshot(snapshot, projectDir)) {
      if (capabilityRequestScopes.some((scope) => scopeMatchesProjectPath(scope, path))) changedPaths.add(path);
    }
    const unexpectedChange = [...changedPaths].find((path) => {
      const stableParent = stableGeneratedScope(path);
      return !stableParent || !capabilityRequestPaths.includes(stableParent);
    });
    if (unexpectedChange) {
      const stableParent = stableGeneratedScope(unexpectedChange);
      const correction = stableParent
        ? `Request the stable generated parent ${JSON.stringify(stableParent)} before running the generator, or request this literal before writing it.`
        : 'Request this capability before writing it, then retry the attempt.';
      return scopeRevisionRejection(
        request,
        priorScope,
        `requested content changed before scope approval: ${unexpectedChange}. ${correction}`,
      );
    }
  }

  // Capture the exact preimage before acknowledging the request. This turns the
  // newly accepted path into first-class repair-diff evidence rather than a
  // post-hoc scope escape with an unavailable preimage.
  if (snapshot) {
    for (const path of capabilityRequestPaths) {
      snapshot.files.set(path, readRollbackCurrentImage(snapshot.rollbackBaseline, projectDir, path));
    }
  }
  return {
    requestedPaths,
    authorizedPaths: capabilityRequestPaths,
    ...(alreadyAuthorizedPaths.length > 0 ? { alreadyAuthorizedPaths } : {}),
    accepted: true,
    decision: 'accepted',
    decidedAt: new Date().toISOString(),
    policyBasis: capabilityRequestPaths.length === 0
      ? 'requested paths are already authorized by the stable effective scope'
      : 'current attempt, unchanged requested-content preimage or recognized stable generated-parent churn, valid project path, and no active-peer scope conflict',
    priorScope,
    effectiveScope,
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
  let files: string[] = [];
  try { files = readdirSync(stagePath).filter((name) => /^scope_revision_decision_.*\.json$/.test(name)).sort(); } catch { /* no earlier decision */ }
  for (const file of files) {
    const path = join(stagePath, file);
    const decision = readConstraintDecision(path);
    if (!decision || decision.kind !== 'scope_revision' || decision.accepted !== true
      || decision.decision !== 'accepted' || decision.decidedBy !== 'scheduler-policy'
      || decision.stageId !== stage.id || decision.runId !== basename(runDirPath)) continue;
    const requestedPaths = Array.isArray(decision.requestedPaths)
      ? decision.requestedPaths.filter((value): value is string => typeof value === 'string')
      : [];
    if (requestedPaths.length === 0 || decision.pathDigest !== scopePathDigest(requestedPaths)) continue;
    if ((decision.requestedBy !== 'stage' && decision.requestedBy !== 'operator' && decision.requestedBy !== 'supervisor')
      || !Number.isSafeInteger(decision.attemptIndex) || typeof decision.reason !== 'string') continue;
    const persistedRequest: ScopeRevisionRequestV1 = {
      version: 1, kind: 'scope_revision', requestId: decision.requestId,
      runId: decision.runId, stageId: decision.stageId, attemptIndex: decision.attemptIndex,
      requestedBy: decision.requestedBy, reason: decision.reason,
      requestedPaths, pathDigest: decision.pathDigest,
    };
    if (decision.identityDigest !== negotiationIdentity(persistedRequest)) continue;
    const authorizedPaths = Array.isArray(decision.authorizedPaths)
      ? decision.authorizedPaths.filter((value): value is string => typeof value === 'string')
      : requestedPaths;
    const normalized = authorizedPaths.map(normalizedProjectPath);
    if (normalized.some((value) => value === undefined)
      || normalized.some((value) => !requestedPaths.includes(value!))) continue;
    for (const pathValue of normalized as string[]) scope.add(pathValue);
    decisionPaths.push(relative(runDirPath, path).replace(/\\/g, '/'));
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
