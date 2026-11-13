import { runRecordPath } from '../../run-layout.js';
import { freshTerminalArtifact, ARTIFACT_OWNERSHIP_UNVERIFIED } from '../../terminal-artifact-status.js';
import { concludeRun } from './run-completion.js';
/** Terminal selection, floor/freshness/gate/reality enforcement and quiescent conclusion; receives campaign and escalation services. */
import { type StoreState, isContinuingStage, RUN_STATUS, STAGE_STATUS, writeRunState, isPendingStageStatus, terminalArtifactSnapshotName, isSuccessfulRunStatus } from '../../store.js';
import { createHash } from 'node:crypto';
import { updateFileHashSync } from '../../rollback-content-store.js';
import { renameSync, copyFileSync, mkdirSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RUN_WIDE_GUIDANCE_TARGET } from '../../guidance.js';
import { evaluateTerminalFloor } from '../sched_admission/brief-contract.js';
import { archiveDeclaredOutputs } from '../../declared-output-archive.js';
import { log } from '../sched_admission/shared.js';

import { isStageInSkippedBranch } from '../sched_admission/frontier.js';
import { type StageConfig } from '../sched_admission/configuration.js';
import { appendSchedulerGuidanceOnce, observeStableBlockage } from './guidance.js';
import { reconcileUnresolvedStageObligations } from '../sched_settlement/completion.js';
import { collectGateRuntimeFacts } from '../sched_settlement/gate-recovery.js';
import { withAdmittedExecution } from '../../engine-integrity.js';
import { spawnOwnedCommand } from '../../adapters/base.js';
import { rethrowGitNotAnswered } from '../../git-facts.js';
import type { PostTerminateHook } from '../../store.js';

import { parseDeclaredScope, scopeMatchesProjectPath } from '../sched_admission/scope-services.js';

export interface TerminalEvaluationServices {
  writeCampaignEntry(projectDir: string, state: StoreState): void;
  concludeRepeatedBlockage(state: StoreState, ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number }): StoreState | null;
}

export interface TerminalEvaluationContext {
  projectDir: string;
  runId: string;
  runDirPath: string;
  iteration: number;
  /** Current executable graph, including a planner before its first dispatch.
   * Replaces the old hard-coded non-plan stage test. */
  stages: readonly StageConfig[];
}

export type TerminalEvaluation =
  | { decision: 'matched'; state: StoreState; reasons: string[] }
  | { decision: 'deferred' | 'not_matched'; reasons: string[]; reasonCode?: typeof ARTIFACT_OWNERSHIP_UNVERIFIED };

function quarantineTerminalCandidate(runDirPath: string, sourcePath: string, label: string): string | undefined {
  if (!existsSync(sourcePath)) return undefined;
  const safeLabel = label.replace(/[^A-Za-z0-9_.-]+/g, '_');
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const target = runRecordPath(runDirPath, `${safeLabel}${suffix === 0 ? '' : `_${suffix}`}`);
    if (existsSync(target)) continue;
    try {
      renameSync(sourcePath, target);
      return target;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function terminalDagHasNoRemainingTransition(
  state: StoreState,
  stages: readonly StageConfig[],
): boolean {
  const entries = Object.entries(state.stages ?? {});
  if (entries.length === 0) return false;
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  return entries.every(([stageId, stageState]) => {
    if (
      stageState.status === STAGE_STATUS.COMPLETE
      || stageState.status === STAGE_STATUS.FAILED
      || stageState.status === STAGE_STATUS.SKIPPED
      || isStageInSkippedBranch(stageId, byId, state)
    ) {
      return true;
    }
    const config = byId.get(stageId);
    return isPendingStageStatus(stageState.status)
      && config?.is_gate !== true
      && (config?.retry_to?.length ?? 0) > 0;
  });
}

export const RUN_VALIDATION_BASELINE_FILE = 'validation_baseline.json';

export function createTerminalEvaluator(services: TerminalEvaluationServices) {
  const { writeCampaignEntry, concludeRepeatedBlockage } = services;

  async function tryTerminateOnTerminalState(
    state: StoreState,
    ctx: TerminalEvaluationContext,
  ): Promise<TerminalEvaluation> {
    if (!state.terminalStates) {
      return { decision: 'not_matched', reasons: ['the brief declares no terminal states'] };
    }
    if (Object.values(state.stages).some(isContinuingStage)) {
      return { decision: 'deferred', reasons: ['retained stage budget work must continue before terminal settlement'] };
    }
    if (Object.values(state.terminalStates).some(entry => entry.paths.some(path => !state.terminalArtifactBaselines?.[path]))) {
      return { decision: 'deferred', reasonCode: ARTIFACT_OWNERSHIP_UNVERIFIED, reasons: ['terminal launch content baseline is unavailable'] };
    }
    const stages = state.planControl?.stages ?? (state.dispatchedStages as StageConfig[] | undefined) ?? ctx.stages ?? [];
    const byId = new Map(stages.map(stage => [stage.id, stage]));
    const freshCandidate = (path: string): boolean => freshTerminalArtifact(
      state, path, join(ctx.projectDir, path), ctx.projectDir,
    );
    const notMatchedReasons: string[] = [];
    const deferredReasons: string[] = [];
    {
      const freshLogicalCandidates = Object.entries(state.terminalStates).flatMap(([terminalStatus, entry]) => (
        entry.paths.flatMap((path) => {
          const projectPath = join(ctx.projectDir, path);
          const sources = freshCandidate(path) ? [projectPath] : [];
          return sources.length > 0 ? [{ terminalStatus, path, sources }] : [];
        })
      ));
      if (freshLogicalCandidates.length > 1) {
        const evidence = createHash('sha256');
        for (const candidate of freshLogicalCandidates.sort((left, right) => left.path.localeCompare(right.path))) {
          evidence.update(`${candidate.terminalStatus}:${candidate.path}\n`, 'utf8');
          try { updateFileHashSync(candidate.sources[0], evidence); } catch { evidence.update('<unreadable>', 'utf8'); }
        }
        const detail = `multiple fresh terminal outcomes exist: ${freshLogicalCandidates.map((candidate) => `${candidate.terminalStatus}=${candidate.path}`).join(', ')}`;
        const blockage = observeStableBlockage({
          runDirPath: ctx.runDirPath,
          kind: 'ambiguous_terminal_outcome',
          detail,
          evidenceDigest: evidence.digest('hex'),
        });
        if (blockage?.escalatedNow) {
          const escalated = concludeRepeatedBlockage(state, ctx);
          if (escalated) return { decision: 'matched', state: escalated, reasons: [] };
        }
        for (const candidate of freshLogicalCandidates) {
          for (const source of candidate.sources) {
            quarantineTerminalCandidate(
              ctx.runDirPath,
              source,
              `ambiguous_terminal_${candidate.terminalStatus}_${candidate.path.split('/').pop() ?? 'artifact'}`,
            );
          }
        }
        appendSchedulerGuidanceOnce(
          ctx.runDirPath, RUN_WIDE_GUIDANCE_TARGET,
          `[ambiguous-terminal:${blockage?.occurrence.fingerprint ?? 'unknown'}]`,
          `Terminal output rejected: ${detail}. Choose the single path matching the outcome that actually happened and write only that path.`,
        );
        return { decision: 'deferred', reasons: [detail] };
      }
    }
    for (const [terminalStatus, entry] of Object.entries(state.terminalStates)) {
      const accepting = isSuccessfulRunStatus(terminalStatus);
      for (const path of entry.paths) {

        const projPath = join(ctx.projectDir, path);
        const snapPath = runRecordPath(ctx.runDirPath, terminalArtifactSnapshotName(path));
        if (!existsSync(projPath)) {
          notMatchedReasons.push(`${terminalStatus}: ${path} is absent`);
          continue;
        }
        if (!freshCandidate(path)) {
          const hintMarker = `[scheduler-hint:${terminalStatus}:${path}:freshness]`;
          const reason = `${path} exists but its content is unchanged from this run's initial content`;
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            RUN_WIDE_GUIDANCE_TARGET,
            hintMarker,
            `Terminal artifact rejected: ${reason}. Continue planned work and produce a fresh terminal artifact after a non-plan stage completes.`,
          );
          log.warn({ runId: ctx.runId, terminalStatus, path, reason }, 'Terminal-state file exists but is stale — NOT terminating');
          notMatchedReasons.push(`${terminalStatus}: ${reason}`);
          continue;
        }
        const sourcePath = projPath;
        const floorCheck = evaluateTerminalFloor(state, entry, ctx.projectDir);
        if (!floorCheck.passed) {
          if (floorCheck.reasonCode) return { decision: 'deferred', reasonCode: floorCheck.reasonCode, reasons: [floorCheck.reason!] };

          const hintMarker = `[scheduler-hint:${terminalStatus}:${path}]`;
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            RUN_WIDE_GUIDANCE_TARGET,
            hintMarker,
            `${path} exists but does not meet the floor for terminal status '${terminalStatus}': ${floorCheck.reason}. Continue planned work OR write escalation_note with a clear blocker plus 2-3 candidate options.`,
          );
          log.warn(
            { runId: ctx.runId, terminalStatus, path, reason: floorCheck.reason, stageGlob: entry.stageGlob },
            'Terminal-state file exists but floor unmet — NOT terminating (check stage_glob / floor config)',
          );
          deferredReasons.push(`${terminalStatus}: ${floorCheck.reason ?? `${path} did not satisfy its floor`}`);
          continue;
        }
        // Planning can emit files before dispatch admission. Settled execution,
        // rather than a stage ID or publication attribution, proves work began.
        if (!Object.entries(state.stages).some(([id, stage]) => (
          !byId.get(id)?.dynamic_dispatch && !byId.get(id)?.decision
          && (stage.status === STAGE_STATUS.COMPLETE || stage.status === STAGE_STATUS.FAILED)
        ))) {
          const reason = `${path} is fresh, but required work has not executed`;
          appendSchedulerGuidanceOnce(ctx.runDirPath, RUN_WIDE_GUIDANCE_TARGET,
            `[scheduler-hint:${terminalStatus}:${path}:execution]`, reason);
          deferredReasons.push(`${terminalStatus}: ${reason}`);
          continue;
        }

        // A terminal artifact selects the outcome; required settlement owns
        // permission to finish, regardless of where the producer sits in the DAG.
        const obligations = reconcileUnresolvedStageObligations(
          state, stages, state.currentIteration ?? ctx.iteration, ctx.runDirPath,
        );
        if (obligations.changed) writeRunState(ctx.projectDir, ctx.runId, state);
        const unresolved = obligations.stageIds.filter((id) => accepting || state.stages[id]?.status !== STAGE_STATUS.FAILED);
        const gates = collectGateRuntimeFacts([...stages], state, ctx.projectDir, ctx.runId);
        const unsettledGates = gates.evaluations.filter((gate) => (
          gate.status !== STAGE_STATUS.COMPLETE && gate.status !== STAGE_STATUS.FAILED
        ));
        const failedWork = accepting ? Object.entries(state.stages)
          .filter(([, stage]) => stage.status === STAGE_STATUS.FAILED).map(([id]) => id) : [];
        // A stage-authored report, including a blocker report, must pass its own review.
        const rejectedGates = gates.failedGateIds;
        if (unresolved.length > 0 || unsettledGates.length > 0 || failedWork.length > 0 || rejectedGates.length > 0) {
          deferredReasons.push(`${terminalStatus}: required settlement is pending or rejected (${[...new Set([
            ...unresolved, ...unsettledGates.map((gate) => gate.id), ...failedWork, ...rejectedGates,
          ])].join(', ')})`);
          continue;
        }

        // Preserve independent review of product deltas using the existing
        // write-enforcement receipts, for every author including repairs. These
        // receipts do not decide whether a terminal artifact was published.
        // This replaces the terminal owner's attempt-write ledger review check.
        const terminalScopes = Object.values(state.terminalStates).flatMap(entry => [
          ...entry.paths, ...(entry.floor?.minAttemptedStages === undefined ? [] : [
            entry.stageGlob ?? `${dirname(entry.paths[0] ?? '.')}/stage_*_verdict.md`,
          ]),
        ]).map(parseDeclaredScope);
        let unavailableWrites = false;
        const unreviewed = Object.entries(state.stages).flatMap(([writerId, stage]) => (
          (stage.attempts?.length ? stage.attempts : [stage]).flatMap(attempt => {
            if (!attempt.constraintAudit) return [];
            let applied: string[];
            try {
              const receipt = JSON.parse(readFileSync(runRecordPath(ctx.runDirPath, attempt.constraintAudit.path), 'utf8'));
              if (receipt.appliedWrites === null) { unavailableWrites = true; return []; }
              applied = receipt.appliedWrites ?? [];
            } catch { return []; } // Legacy records have no content-delta receipt.
            return applied.filter(product => !terminalScopes.some(scope => scopeMatchesProjectPath(scope, product)))
              .filter(() => !gates.evaluations.some(gate => (
                gate.id !== writerId && gate.status === STAGE_STATUS.COMPLETE && gate.effectiveVerdict?.pass === true
                && Date.parse(state.stages[gate.id]?.attempts?.at(-1)?.startedAt ?? state.stages[gate.id]?.startedAt ?? '')
                  >= Date.parse(attempt.completedAt ?? '')
              )));
          })
        ));
        if (unavailableWrites) {
          deferredReasons.push(`${terminalStatus}: actual content delta unavailable`);
          continue;
        }
        if (unreviewed.length > 0) {
          deferredReasons.push(`${terminalStatus}: unreviewed product writes (${[...new Set(unreviewed)].join(', ')})`);
          continue;
        }

        if (state.declaredOutputs?.length) {
          try {
            archiveDeclaredOutputs(ctx.projectDir, ctx.runDirPath, state.declaredOutputs);
          } catch (error) {
            const reason = `declared output archival failed: ${error instanceof Error ? error.message : String(error)}`;
            appendSchedulerGuidanceOnce(
              ctx.runDirPath,
              RUN_WIDE_GUIDANCE_TARGET,
              `[scheduler-hint:${terminalStatus}:${path}:declared-outputs]`,
              `${path} reached a terminal outcome, but ${reason}. Produce every declared output with its declared type before terminalization.`,
            );
            deferredReasons.push(`${terminalStatus}: ${reason}`);
            continue;
          }
        }
        state.terminalArtifact = path;

        try {
          mkdirSync(dirname(snapPath), { recursive: true });
          copyFileSync(sourcePath, snapPath);
        } catch { /* non-critical */ }
        state = await concludeRun(state, {
          status: terminalStatus as StoreState['status'], reasonCode: 'terminal_artifact',
          pendingStageNote: `terminal state '${terminalStatus}' reached before this stage ran`,
          eventFields: () => ({ iteration: ctx.iteration, detail: `Terminal state '${terminalStatus}' reached via ${path}` }),
          writeCampaignEntry,
        });
        if (state.status === RUN_STATUS.REALITY_GATE_FAILED) {
          quarantineTerminalCandidate(
            ctx.runDirPath,
            sourcePath,
            `reality_rejected_${terminalStatus}_${path.split('/').pop() ?? 'terminal_candidate'}`,
          );
          return { decision: 'matched', state, reasons: [] };
        }
        log.info({ runId: ctx.runId, iteration: ctx.iteration, terminalStatus, path }, 'Terminal-state file detected; ending iteration loop');
        if (entry.postTerminateHook) {
          await runPostTerminateHook(entry.postTerminateHook, {
            projectDir: ctx.projectDir,
            runDir: ctx.runDirPath,
            runId: ctx.runId,
            terminalStatus,
            verdictPath: sourcePath,
          }).catch((err) => {
            rethrowGitNotAnswered(err);
            log.warn({ runId: ctx.runId, err: String(err) }, 'post_terminate_hook threw unexpectedly');
          });
        }
        return { decision: 'matched', state, reasons: [] };
      }
    }
    if (deferredReasons.length > 0) {
      return { decision: 'deferred', reasons: [...deferredReasons, ...notMatchedReasons] };
    }
    return {
      decision: 'not_matched',
      reasons: notMatchedReasons.length > 0
        ? notMatchedReasons
        : ['the brief declares terminal states, but none has an eligible artifact path'],
    };
  }

  async function concludeDeclaredTerminalAtQuiescence(
    state: StoreState,
    stages: readonly StageConfig[],
    ctx: TerminalEvaluationContext,
    completionPath: string,
  ): Promise<StoreState | null> {
    if (!state.terminalStates || !terminalDagHasNoRemainingTransition(state, stages)) return null;
    const evaluation = await tryTerminateOnTerminalState(state, { ...ctx, stages });
    if (evaluation.decision === 'matched') return evaluation.state;

    const reasonDetail = evaluation.reasons.slice(0, 8).join('; ')
      || 'no terminal candidate supplied a reason';
    const conclusion = evaluation.decision === 'not_matched'
      ? `All stages settled, but no declared terminal state matched (${completionPath}): ${reasonDetail}`
      : `All stages settled, but declared terminal evaluation could not decide (${completionPath}): ${reasonDetail}`;
    state = concludeRun(state, { status: RUN_STATUS.INCOMPLETE, reasonCode: evaluation.reasonCode ?? 'terminal_unmatched', detail: conclusion, pendingStageNote: conclusion, eventFields: () => ({
      iteration: ctx.iteration,
      detail: `terminal evaluation ${evaluation.decision}: ${conclusion}`,
    }), writeCampaignEntry });
    log.warn({
      runId: ctx.runId,
      iteration: ctx.iteration,
      completionPath,
      terminalDecision: evaluation.decision,
      reasons: evaluation.reasons,
    }, 'Settled DAG reached an explicit unmatched terminal conclusion');
    return state;
  }

  return { tryTerminateOnTerminalState, concludeDeclaredTerminalAtQuiescence };
}

export async function runPostTerminateHook(
  hook: PostTerminateHook,
  ctx: {
    projectDir: string;
    runDir: string;
    runId: string;
    terminalStatus: string;
    verdictPath: string;
  },
): Promise<void> {
  const timeoutMs = hook.timeoutSeconds === undefined ? undefined : hook.timeoutSeconds * 1000;
  const hookEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    FC_PHASE: ctx.terminalStatus,
    FC_VERDICT_FILE: ctx.verdictPath,
    FC_RUN_DIR: ctx.runDir,
    FC_PROJECT_DIR: ctx.projectDir,
    FC_RUN_ID: ctx.runId,
    ...(hook.env ?? {}),
  };
  const args = hook.args ?? [];
  const logPath = runRecordPath(ctx.runDir, 'post_terminate_hook.log');
  const startedAt = new Date().toISOString();

  await withAdmittedExecution({ projectDir: ctx.projectDir, runDir: ctx.runDir,
    stageId: '_terminal_hook',
  }, () => new Promise<void>((resolve, reject) => {
    let spawnError: Error | undefined;
    let unfinished = false;
    const { child, stop, publication } = spawnOwnedCommand(hook.command, args, {
      cwd: ctx.projectDir,
      env: hookEnv,
    });
    const chunks: string[] = [
      `# post_terminate_hook log\n`,
      `started_at: ${startedAt}\n`,
      `command: ${hook.command}\n`,
      `args: ${JSON.stringify(args)}\n`,
      `timeout_seconds: ${hook.timeoutSeconds ?? 'undeclared'}\n`,
      `\n--- stdout/stderr ---\n`,
    ];
    child.stdout?.on('data', (d) => chunks.push(d.toString()));
    child.stderr?.on('data', (d) => chunks.push(d.toString()));
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      unfinished = true;
      log.warn({ runId: ctx.runId, command: hook.command, timeoutMs }, 'post_terminate_hook unfinished at declared allowance');
      stop();
    }, timeoutMs);
    child.once('error', (err) => { spawnError = err; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // Publication belongs to this command; a missing fact must reach its
      // awaited completion before any hook-result evidence is written.
      void publication.then(() => {
        if (spawnError) {
          log.warn({ runId: ctx.runId, command: hook.command, err: String(spawnError) }, 'post_terminate_hook spawn failed');
          try { writeFileSync(logPath, chunks.join('') + `\nspawn error: ${spawnError}\n`, 'utf-8'); } catch { /* noop */ }
          resolve();
          return;
        }
        chunks.push(`\n--- exit ---\ncode: ${code}\nsignal: ${signal}\nunfinished: ${unfinished}\ncompleted_at: ${new Date().toISOString()}\n`);
        try { writeFileSync(logPath, chunks.join(''), 'utf-8'); } catch { /* noop */ }
        if (unfinished) {
          log.info({ runId: ctx.runId, command: hook.command }, 'post_terminate_hook unfinished (best-effort, recorded)');
        } else if (code !== 0) {
          log.warn({ runId: ctx.runId, command: hook.command, exitCode: code, signal }, 'post_terminate_hook exited non-zero (best-effort, ignored)');
        } else {
          log.info({ runId: ctx.runId, command: hook.command }, 'post_terminate_hook completed');
        }
        resolve();
      }, reject);
    });
  })).catch((error: unknown) => {
    rethrowGitNotAnswered(error);
    const message = `ENGINE_STATE_REFUSED: terminal hook was not executed: ${String(error)}`;
    log.warn({ runId: ctx.runId, message }, 'post_terminate_hook refused (best-effort, ignored)');
    writeFileSync(logPath, message + '\n', 'utf8');
  });
}
