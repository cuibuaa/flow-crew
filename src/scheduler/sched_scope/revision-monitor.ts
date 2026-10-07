// Boundary: Observe one revision transport slot per stage and publish immutable policy decisions before activating capabilities; receive only the validation-baseline reader.
import { type StoreState, readRunState, readStageStatus, runDir } from "../../store.js";
import { join, relative } from "node:path";
import { readFileSync, mkdirSync, watch } from "node:fs";
import { validationPathImpacts, type ProjectValidationBaseline } from "../../project-validation.js";
import { type StageConfig } from "../sched_admission/configuration.js";
import { appendGuidanceEnvelope } from "../../guidance.js";
import { constraintDecisionPath, negotiationIdentity, negotiationRequestDigest, publishConstraintDecision, readConstraintDecision } from "../../runtime-negotiation.js";
import { log } from "../sched_admission/shared.js";
import { recordRunEvent } from "../../run-events.js";
import { type ScopeBatchContext, addScopeArtifactPath, getScopeAttemptContext } from './scope-batch.js';
import { currentStageAttemptIndex, decideScopeRevision, readScopeRevisionRequest } from './scope-revisions.js';

interface ScopeRevisionMonitorServices {
  readRunValidationBaseline(runDirPath: string): { baseline: ProjectValidationBaseline } | undefined;
}

export function createScopeRevisionMonitor(services: ScopeRevisionMonitorServices) {
  const { readRunValidationBaseline } = services;

  function scopeRevisionValidationConsequence(input: {
    projectDir: string;
    runDirPath: string;
    state: StoreState;
    requestedPaths: readonly string[];
  }): string | undefined {
    if (!input.state.research) return undefined;
    let completedRounds = 0;
    try {
      const journal = JSON.parse(readFileSync(join(input.runDirPath, 'research_journal.json'), 'utf-8')) as { rounds?: unknown[] };
      completedRounds = Array.isArray(journal.rounds) ? journal.rounds.length : 0;
    } catch { /* an absent journal means round zero */ }
    const configuredRounds = input.state.research.stop?.maxRounds;
    const remainingRounds = configuredRounds === undefined
      ? Math.max(0, (input.state.maxIterations ?? 0) - (input.state.currentIteration ?? 1))
      : Math.max(0, Math.floor(configuredRounds) - completedRounds);
    if (remainingRounds < 1) return undefined;
    const baseline = readRunValidationBaseline(input.runDirPath);
    if (!baseline) return undefined;
    const impacts = validationPathImpacts(
      input.projectDir,
      baseline.baseline.discovery.commands,
      input.requestedPaths,
    );
    if (impacts.length === 0) return undefined;
    const rows = impacts.map((impact) => (
      `${impact.path} -> ${impact.role} command ${JSON.stringify(impact.command)} (${impact.evidence})`
    ));
    return ` Validation consequence: ${rows.join('; ')}. ${remainingRounds} research round${remainingRounds === 1 ? '' : 's'} remain; these inputs will be exercised by the named configured validation command after later gated work, and a new failing identifier will block acceptance. Keep round-specific assertions bound to immutable scheduler-consumed evidence rather than mutable latest-round state.`;
  }

  async function monitorScopeRevisionRequests(input: {
    selected: StageConfig[];
    activeStageIds: Set<string>;
    projectDir: string;
    runId: string;
    context: ScopeBatchContext;
    isComplete: () => boolean;
  }): Promise<void> {
    const processed = new Set<string>();
    const runDirPath = runDir(input.projectDir, input.runId);
    const inspect = (): void => {
      for (const stage of input.selected) {
        const stagePath = join(runDirPath, 'stages', stage.id);
        const request = readScopeRevisionRequest(stagePath, input.runId);
        if (!request) continue;
        const activeAttemptIndex = currentStageAttemptIndex(input.projectDir, input.runId, stage.id);
        const recordedRequestedAttempt = (() => {
          try {
            return readStageStatus(input.projectDir, input.runId, stage.id).attempts
              ?.some((attempt) => attempt.index === request.attemptIndex)
              ? request.attemptIndex
              : undefined;
          } catch { return undefined; }
        })();
        // A synchronous adapter can write its request and settle before the fs
        // notification runs. The final inspection must still adjudicate that
        // exact recorded attempt; otherwise exit 0 silently loses the request.
        const attemptIndex = activeAttemptIndex ?? (input.isComplete() ? recordedRequestedAttempt : undefined);
        const key = negotiationRequestDigest(request);
        if (attemptIndex === undefined) continue;
        if (processed.has(key)) continue;
        // The request file is a transport slot and commonly survives into a
        // technical retry. Once this exact request has an immutable decision,
        // do not reconsider it against the later attempt or emit duplicate
        // request/decision events. Accepted capability is rehydrated separately
        // by acceptedInheritedScope().
        const existingDecision = readConstraintDecision(constraintDecisionPath(stagePath, request));
        if (
          existingDecision?.identityDigest === negotiationIdentity(request)
          && existingDecision.requestDigest === key
        ) {
          processed.add(key);
          continue;
        }
        const attemptContext = getScopeAttemptContext(input.context, stage.id, attemptIndex);
        recordRunEvent(input.projectDir, input.runId, {
          type: 'scope_revision_requested', runId: input.runId, timestamp: new Date().toISOString(),
          stageId: stage.id, attemptIndex: request.attemptIndex, requestId: request.requestId,
          detail: `${request.requestedPaths.join(', ')}: ${request.reason}`, source: 'scheduler',
        });
        const activePeers = input.selected.filter((peer) => (
          peer.id !== stage.id && input.activeStageIds.has(peer.id)
        )).map((peer) => {
          const peerAttemptIndex = currentStageAttemptIndex(input.projectDir, input.runId, peer.id);
          const peerScope = peerAttemptIndex === undefined
            ? input.context.declaredScopes.get(peer.id) ?? null
            : getScopeAttemptContext(input.context, peer.id, peerAttemptIndex).effectiveScope;
          return { ...peer, scope: peerScope ?? undefined };
        });
        const policyDecision = decideScopeRevision({
          request,
          stage,
          priorScope: attemptContext.effectiveScope,
          activePeers,
          projectDir: input.projectDir,
          runId: input.runId,
          attemptIndex,
          snapshot: input.context.snapshot,
        });
        const publication = publishConstraintDecision({
          stagePath,
          request,
          decidedBy: 'scheduler-policy',
          decision: policyDecision as Parameters<typeof publishConstraintDecision>[0]['decision'],
        });
        processed.add(key);
        if (publication.kind === 'mismatch') {
          addScopeArtifactPath(attemptContext.mismatchPaths, publication.path, runDirPath);
          log.warn({ stage: stage.id, requestId: request.requestId }, 'Scope revision request body mismatched an immutable decision');
          continue;
        }
        addScopeArtifactPath(attemptContext.decisionPaths, publication.path, runDirPath);
        if (publication.decision.accepted === true && Array.isArray(publication.decision.effectiveScope)) {
          // The accepted record is durable before the effective scope changes.
          attemptContext.effectiveScope = [...publication.decision.effectiveScope] as string[];
          input.context.inheritedScopes.set(stage.id, [...attemptContext.effectiveScope]);
          const inheritedPaths = input.context.inheritedDecisionPaths.get(stage.id) ?? new Set<string>();
          addScopeArtifactPath(inheritedPaths, publication.path, runDirPath);
          input.context.inheritedDecisionPaths.set(stage.id, inheritedPaths);
          attemptContext.acceptedDuringAttempt = true;
          const consequence = scopeRevisionValidationConsequence({
            projectDir: input.projectDir,
            runDirPath,
            state: readRunState(input.projectDir, input.runId),
            requestedPaths: request.requestedPaths,
          });
          appendGuidanceEnvelope({
            runDir: runDirPath,
            target: stage.id,
            source: 'scheduler',
            attemptIndex: request.attemptIndex + 1,
            knownStageIds: input.selected.map((candidate) => candidate.id),
            body: `# Accepted scope revision\nContinue the stage work in execution ${request.attemptIndex + 1}. Newly admitted paths: ${JSON.stringify(publication.decision.authorizedPaths ?? [])}. Read the run-local decision ${relative(runDirPath, publication.path).replace(/\\/g, '/')} for the exact grant and any denied paths; denied paths remain outside your authority.${consequence ?? ''}`,
          });
        }
        recordRunEvent(input.projectDir, input.runId, {
          type: 'scope_revision_decided', runId: input.runId,
          timestamp: publication.decision.decidedAt,
          stageId: stage.id, attemptIndex: request.attemptIndex, requestId: request.requestId,
          decision: publication.decision.accepted ? 'accepted' : 'rejected',
          detail: String(publication.decision.policyBasis), source: 'scheduler',
          level: publication.decision.accepted ? 'info' : 'warning',
        });
        log.info(
          { stage: stage.id, requestId: request.requestId, accepted: publication.decision.accepted, reason: publication.decision.rejectionReason },
          'Scope revision decided',
        );
      }
    };
  
    const watchers: import('node:fs').FSWatcher[] = [];
    let wake: (() => void) | undefined;
    try {
      for (const stage of input.selected) {
        const stagePath = join(runDirPath, 'stages', stage.id);
        mkdirSync(stagePath, { recursive: true });
        watchers.push(watch(stagePath, { persistent: false }, () => wake?.()));
      }
    } catch { /* one-second reconciliation is the portable fallback */ }
    try {
      while (!input.isComplete()) {
        inspect();
        await new Promise<void>((resolvePromise) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            wake = undefined;
            resolvePromise();
          };
          wake = finish;
          timer = setTimeout(finish, 1000);
          // Close the event-registration race: a synchronous adapter may have
          // completed after the loop condition but before `wake` was installed.
          if (input.isComplete()) finish();
        });
      }
      inspect();
    } finally {
      for (const watcher of watchers) watcher.close();
    }
  }

  return { scopeRevisionValidationConsequence, monitorScopeRevisionRequests };
}
