// Boundary: Combine attributed writes, live incidents and scope decisions into one durable attempt audit; use the same enforcement and transient-output service as the live boundary.
import { type ScopeStageKind, buildScopeNegotiationTrace, publishJsonCreateOnly, readConstraintDecision, rejectedScopeDigest, scopePathDigest } from "../../runtime-negotiation.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { type StageStatus, attachStageConstraintAudit, readRunState, readStageStatus, runDir, writeStageStatus, isRunningStageStatus } from "../../store.js";
import { discoverConfiguredCommandScopes } from "../sched_admission/project-capabilities.js";
import { join } from "node:path";
import { loadProjectDefaults } from "../../config.js";
import { normalizedProjectPath } from "../sched_admission/scope-services.js";
import { scopeRevisionInstruction } from "../../live-constraint-guard.js";
import { changedProjectPathsSinceSnapshot } from './snapshots.js';
import { SCOPE_PLANNING_INPUT_PREFIX, type ScopePlanningInputV1 } from './scope-planning.js';
import { type ScopeBatchContext, getScopeAttemptContext, peerScopeContainsPath } from './scope-batch.js';
import { enforceStageScopeWrites, readLiveConstraintIncidents, type ScopeValidationOutputs } from './write-enforcement.js';
import { canonicalProjectWriteUnion, scopeContainsPath } from './path-capabilities.js';
import { trackedGitlinkAncestor } from './rollback-baseline.js';

export function createScopeReconciler(services: ScopeValidationOutputs) {
  const { transientVitestOutputScopes } = services;

  function reconcileStageScope(input: {
    stage: StageConfig;
    projectDir: string;
    runId: string;
    context: ScopeBatchContext;
    attemptIndex: number;
    terminalDurableScope?: string[];
  }): { status: StageStatus; violation: boolean; acceptedRevisionDuringAttempt: boolean } {
    const status = readStageStatus(input.projectDir, input.runId, input.stage.id);
    const attempt = status.attempts?.find((candidate) => candidate.index === input.attemptIndex);
    if (!attempt) return { status, violation: false, acceptedRevisionDuringAttempt: false };
    const declaredScope = input.context.declaredScopes.get(input.stage.id) ?? null;
    const attemptContext = getScopeAttemptContext(input.context, input.stage.id, attempt.index);
    const effectiveScope = attemptContext.effectiveScope;
    const decisions = [...attemptContext.decisionPaths];
    const mismatches = [...attemptContext.mismatchPaths];
    const runDirPath = runDir(input.projectDir, input.runId);
    const liveIncidents = readLiveConstraintIncidents(runDirPath, input.stage.id, attempt.index);
    const liveWriteIncidents = liveIncidents.filter((incident) => incident.changeObserved !== false);
    const attributedWrites = attempt.writes ?? [];
    const schedulerObservedWrites = changedProjectPathsSinceSnapshot(input.context.snapshot, input.projectDir);
    const canonicalAttributedWrites = attributedWrites.map((rawPath) => {
      const normalized = normalizedProjectPath(rawPath);
      return normalized
        ? trackedGitlinkAncestor(input.context.snapshot.rollbackBaseline, normalized) ?? normalized
        : rawPath;
    });
    const rawWrites = canonicalProjectWriteUnion(
      canonicalAttributedWrites,
      schedulerObservedWrites,
      liveWriteIncidents.map((incident) => incident.path),
    );
    const definiteWrites = new Set(
      attempt.writeAttribution === 'structured'
        ? canonicalProjectWriteUnion(canonicalAttributedWrites)
        : [],
    );
    if (attempt.writeAttribution !== 'structured') {
      attempt.writes = rawWrites;
      attempt.writeAttribution = 'snapshot';
      writeStageStatus(input.projectDir, input.runId, input.stage.id, status);
    }
    // Three states, not two. A declared scope governs the stage. A missing declaration the
    // stage NEGOTIATED is governed by the resulting decision — accepted paths apply, rejected
    // ones are restored. A missing declaration the stage never negotiated has no policy to
    // enforce: auditing those writes is right, destroying them is not.
    //
    // P3/M3 collapsed `string[] | null` into `string[]` (`stage.scope ?? []`) and dropped
    // `scopeContainsPath`'s `scope === null → true` branch, which merged the third state into
    // the second. Every brief that declares no scope then had its writes rolled back, so
    // `terminal_states` artifacts never landed and a declared `result_file` never reached the
    // engine — measured as 9 red tracked tests and a research loop that cannot finish a round.
    // Keeping `null` distinct here does NOT reopen `undefined => allow all`: a missing
    // declaration still grants nothing in the negotiation path, so a request can only ever
    // authorize the exact paths it names.
    const negotiated = attemptContext.decisionPaths.size > 0 || attemptContext.mismatchPaths.size > 0;
    const ordinaryGovernedScope: string[] | null = declaredScope === null && !negotiated ? null : effectiveScope;
    // A terminal finalizer may declare generated/report-support paths so it can
    // rerun validation after authoring the terminal candidate. Those paths are
    // touch-only: a content-object delta would be new work performed after
    // the last gate. Reconcile against the terminal/evidence subset so any such
    // durable delta is restored from the pre-attempt snapshot and fails the
    // attempt before terminal evaluation.
    const governedScope: string[] | null = input.terminalDurableScope ?? ordinaryGovernedScope;
    const terminalValidationOnly = input.terminalDurableScope !== undefined;
    const restoredLivePaths = new Set(liveWriteIncidents
      .filter((incident) => incident.restored)
      .map((incident) => normalizedProjectPath(incident.path) ?? incident.path));
    const enforcement = enforceStageScopeWrites({
      projectDir: input.projectDir,
      snapshot: input.context.snapshot,
      // A peer guard can observe and provisionally settle a write before the
      // structured writer finishes. Use the batch's first preimage so that the
      // writer's own post-attempt audit can still restore a cross-scope write.
      preimages: input.context.liveWritePreimages,
      effectiveScope: governedScope,
      exemptPatterns: [
        ...loadProjectDefaults(input.projectDir).live_constraint_exempt_patterns,
        ...transientVitestOutputScopes(
          input.projectDir,
          input.runId,
          discoverConfiguredCommandScopes(input.projectDir),
        ),
      ],
      configuredGeneratedPatterns: discoverConfiguredCommandScopes(input.projectDir),
      validationGeneratedWrites: attempt.validationGeneratedWrites,
      rawWrites,
      definiteWrites,
      preserveUnverifiedPath: (path) => peerScopeContainsPath(input.context, input.stage.id, path),
    });
    const contentChangedPaths = new Set(enforcement.contentChangedWrites);
    const violations: Array<{
      path: string;
      certainty: 'definite' | 'unverified';
      reason: string;
      resolution?: 'live_reverted';
    }> = [];
    for (const rawPath of enforcement.rawWrites) {
      const normalized = normalizedProjectPath(rawPath);
      // A live incident is attributable even when an adapter has no structured
      // write report. For partitioned batches the shared incident ledger records
      // a path only after proving that it lies outside every admitted partition,
      // then conservatively assigns that fact to the batch cohort.
      const definitelyAttributed = definiteWrites.has(normalized ?? rawPath)
        || restoredLivePaths.has(normalized ?? rawPath);
      if (!definitelyAttributed && !normalized) continue;
      const liveReverted = restoredLivePaths.has(normalized ?? rawPath)
        && !enforcement.rolledBackWrites.includes(normalized ?? rawPath)
        && !enforcement.rollbackFailures.includes(normalized ?? rawPath);
      const invalidAttributedPath = normalized === undefined
        && enforcement.rollbackFailures.includes(rawPath);
      if (!liveReverted
        && !contentChangedPaths.has(normalized ?? rawPath)
        && !invalidAttributedPath) continue;
      // The incident's captured effective scope is the authority for the moment
      // of violation. A later accepted revision permits the corrected write; it
      // does not erase the fact that the first write was unauthorized.
      if (!liveReverted && (governedScope === null || scopeContainsPath(governedScope, rawPath))) continue;
      violations.push({
        path: rawPath,
        certainty: definitelyAttributed ? 'definite' : 'unverified',
        reason: liveReverted
          ? 'live enforcement restored the unauthorized project write before the adapter invocation ended; post-attempt audit verified the preimage remained restored'
          : definitelyAttributed
          ? enforcement.rolledBackWrites.includes(normalizedProjectPath(rawPath) ?? rawPath)
            ? terminalValidationOnly
              ? 'terminal finalizer left a durable non-terminal validation-scope delta; enforcement restored its preimage before terminal evaluation'
              : 'adapter attributed an unauthorized project write; enforcement restored its preimage before durable apply'
            : terminalValidationOnly
              ? 'terminal finalizer left a durable non-terminal validation-scope delta that could not be restored'
              : 'adapter attributed a project write outside the accepted effective scope'
          : enforcement.rolledBackWrites.includes(normalizedProjectPath(rawPath) ?? rawPath)
            ? 'snapshot observed a change outside the complete batch capability; enforcement restored its preimage while ownership remains unverified'
            : 'snapshot observed a change outside effective scope but cannot prove ownership',
        ...(liveReverted ? { resolution: 'live_reverted' as const } : {}),
      });
    }
    const stagePath = join(runDir(input.projectDir, input.runId), 'stages', input.stage.id);
    const decisionRecords = decisions.flatMap((path) => {
      const decision = readConstraintDecision(join(runDir(input.projectDir, input.runId), path));
      return decision ? [decision] : [];
    });
    const acceptedRevisionCount = decisionRecords.filter((decision) => decision.accepted === true).length;
    const rejectedRevisionCount = decisionRecords.filter((decision) => decision.accepted === false).length;
    const definite = violations.filter((violation) => violation.certainty === 'definite');
    const unresolvedDefinite = definite.filter((violation) => violation.resolution !== 'live_reverted');
    const unverified = violations.filter((violation) => violation.certainty === 'unverified');
    const auditPath = join(stagePath, `constraint_audit_attempt_${attempt.index}.json`);
    const auditRelativePath = auditPath.slice(runDirPath.length + 1).replace(/\\/g, '/');
    const stageKind: ScopeStageKind = input.stage.is_gate ? 'gate' : 'ordinary';
    const iteration = readRunState(input.projectDir, input.runId).currentIteration ?? 1;
    const rejectedDecisions = decisionRecords.filter((decision) => decision.accepted === false
      || Array.isArray(decision.rejectedPaths) && decision.rejectedPaths.length > 0);
    const planningDigests = rejectedDecisions.flatMap((decision) => {
      const withheld = Array.isArray(decision.rejectedPaths) ? decision.rejectedPaths : decision.requestedPaths;
      const requestedPaths = Array.isArray(withheld)
        ? withheld.filter((value): value is string => typeof value === 'string') : [];
      if (requestedPaths.length === 0) return [];
      const digest = rejectedScopeDigest({ stageKind, requestedPaths });
      const planningInput: ScopePlanningInputV1 = {
        version: 1,
        kind: 'scope_negotiation_planning_input',
        digest,
        runId: input.runId,
        sourceIteration: iteration,
        stageId: input.stage.id,
        stageKind,
        requestedPaths,
        pathDigest: Array.isArray(decision.rejectedPaths) ? scopePathDigest(requestedPaths)
          : typeof decision.pathDigest === 'string' ? decision.pathDigest : scopePathDigest(requestedPaths),
        rejectionReason: typeof decision.rejectionReason === 'string' ? decision.rejectionReason : decision.policyBasis,
        auditPath: auditRelativePath,
      };
      publishJsonCreateOnly(join(runDirPath, `${SCOPE_PLANNING_INPUT_PREFIX}${digest}.json`), planningInput);
      return [digest];
    });
    const stateTransitions = decisionRecords.flatMap((decision) => {
      const requestedPaths = Array.isArray(decision.requestedPaths)
        ? decision.requestedPaths.filter((value): value is string => typeof value === 'string')
        : [];
      if (requestedPaths.length === 0) return [];
      return [buildScopeNegotiationTrace({
        stageKind,
        scopePresence: declaredScope === null ? 'missing' : 'present',
        declaredScope: declaredScope ?? [],
        requestedPaths,
        authorizedPaths: Array.isArray(decision.authorizedPaths)
          ? decision.authorizedPaths.filter((value): value is string => typeof value === 'string') : undefined,
        decision: decision.accepted === true ? 'accepted' : 'rejected',
        effectiveScope: Array.isArray(decision.effectiveScope)
          ? decision.effectiveScope.filter((value): value is string => typeof value === 'string')
          : effectiveScope,
        durableWrites: enforcement.durableWrites,
      })];
    });
    const postAttemptInstruction = unresolvedDefinite.length > 0
      ? scopeRevisionInstruction({
          runDir: runDirPath,
          runId: input.runId,
          stageId: input.stage.id,
          attemptIndex: '<current execution index>',
          scope: effectiveScope,
          scopePresence: declaredScope === null ? 'missing' : 'present',
          gate: input.stage.is_gate === true,
          violatingPaths: unresolvedDefinite.map((violation) => violation.path),
        })
      : undefined;
    const scopeRevisionInstructions = [...new Set([
      ...liveWriteIncidents.flatMap((incident) => incident.scopeRevisionInstruction
        ? [incident.scopeRevisionInstruction]
        : []),
      ...(postAttemptInstruction ? [postAttemptInstruction] : []),
    ])];
    const rolledBackSet = new Set([
      ...enforcement.rolledBackWrites,
      ...restoredLivePaths,
    ]);
    const allRolledBackWrites = [
      ...enforcement.rawWrites.filter((path) => rolledBackSet.has(normalizedProjectPath(path) ?? path)),
      ...[...rolledBackSet].filter((path) => !enforcement.rawWrites.some(
        (rawPath) => (normalizedProjectPath(rawPath) ?? rawPath) === path,
      )),
    ];
    const audit = {
      version: 1,
      stageId: input.stage.id,
      attemptIndex: attempt.index,
      requester: 'stage',
      scopeApprover: 'scheduler-policy',
      declaredScope,
      effectiveScope,
      ...(terminalValidationOnly ? { terminalDurableScope: input.terminalDurableScope } : {}),
      decisionPaths: decisions,
      mismatchPaths: mismatches,
      decisions: decisionRecords,
      rawWrites: enforcement.rawWrites,
      appliedWrites: enforcement.appliedWrites,
      exemptedWrites: enforcement.exemptedWrites,
      rolledBackWrites: allRolledBackWrites,
      rollbackFailures: enforcement.rollbackFailures,
      rollbackFailureReasons: enforcement.rollbackFailureReasons,
      durableWrites: enforcement.durableWrites,
      planningDigests,
      stateTransitions,
      writes: attempt.writes ?? [],
      writeAttribution: attempt.writeAttribution ?? 'unknown',
      liveIncidents,
      scopeRevisionInstructions,
      violations,
      timeout: attempt.timeout,
      completedAt: new Date().toISOString(),
    };
    publishJsonCreateOnly(auditPath, audit);
    const summary = {
      path: auditRelativePath,
      declaredScope,
      effectiveScope,
      acceptedRevisionCount,
      rejectedRevisionCount,
      mismatchCount: mismatches.length,
      violationCount: definite.length,
      liveViolationCount: liveWriteIncidents.length,
      liveComparisonUnavailableCount: liveIncidents.filter((incident) => incident.changeObserved === false).length,
      liveRestoredCount: liveWriteIncidents.filter((incident) => incident.restored).length,
      unresolvedViolationCount: unresolvedDefinite.length,
      unverifiedCount: unverified.length,
      rawWriteCount: enforcement.rawWrites.length,
      appliedWriteCount: enforcement.appliedWrites.length,
      exemptedWriteCount: enforcement.exemptedWrites.length,
      rolledBackWriteCount: allRolledBackWrites.length,
      rejectedDigestCount: planningDigests.length,
    };
    const error = unresolvedDefinite.length > 0
      ? terminalValidationOnly
        ? `terminal_scope_violation: ${unresolvedDefinite.map((violation) => violation.path).join(', ')} left a durable non-terminal delta after the finalizer's gates. ${postAttemptInstruction}`
        : `scope_violation: ${unresolvedDefinite.map((violation) => violation.path).join(', ')} attempted outside accepted effective scope. ${postAttemptInstruction}`
      : undefined;
    return {
      status: attachStageConstraintAudit(input.projectDir, input.runId, input.stage.id, attempt.index, summary, error),
      violation: unresolvedDefinite.length > 0,
      acceptedRevisionDuringAttempt: attemptContext.acceptedDuringAttempt,
    };
  }

  function reconcileCompletedStageAttempts(input: {
    stage: StageConfig;
    projectDir: string;
    runId: string;
    context: ScopeBatchContext;
    terminalDurableScope?: string[];
  }): { status: StageStatus; violation: boolean; acceptedRevisionDuringAttempt: boolean; attemptIndex?: number } {
    let status = readStageStatus(input.projectDir, input.runId, input.stage.id);
    let violation = false;
    let acceptedRevisionDuringAttempt = false;
    let acceptedAttemptIndex: number | undefined;
    for (const attempt of status.attempts ?? []) {
      if (isRunningStageStatus(attempt.status) || attempt.constraintAudit) continue;
      const reconciled = reconcileStageScope({ ...input, attemptIndex: attempt.index });
      status = reconciled.status;
      violation ||= reconciled.violation;
      if (reconciled.acceptedRevisionDuringAttempt) {
        acceptedRevisionDuringAttempt = true;
        acceptedAttemptIndex = attempt.index;
      }
    }
    return { status, violation, acceptedRevisionDuringAttempt, attemptIndex: acceptedAttemptIndex };
  }

  return { reconcileStageScope, reconcileCompletedStageAttempts };
}
