/** Terminal selection, floor/owner/freshness/reality enforcement and quiescent conclusion; receives validation, campaign and escalation services. */
import { type Adapter } from '../../adapters/base.js';
import { type ProjectValidationDependencies } from '../../project-validation.js';
import { type StoreState, type PostTerminateHook, RUN_STATUS, STAGE_STATUS, enforceRealityGateBeforeTerminal, rependStageStatus, writeRunState, writeStageStatus, isPendingStageStatus } from '../../store.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_WIDE_GUIDANCE_TARGET } from '../../guidance.js';
import { appendProgramLedger, evaluateTerminalFloor, markLeftoverStagesSkipped } from '../sched_admission/brief-contract.js';
import { archiveDeclaredOutputs } from '../../declared-output-archive.js';
import { evaluateResearchCeilingFloor } from '../../research-policy.js';
import { generateRunSummary } from '../../run-summary.js';
import { log } from '../sched_admission/shared.js';
import { recordRunEvent } from '../../run-events.js';
import { runAllChecks } from '../../reality-gate/index.js';
import { type StageConfig } from '../sched_admission/configuration.js';
import { lastAttributedStageWriteMs, admittedTerminalOwner, stageAttemptWroteProjectPath } from './terminal-ownership.js';
import { appendSchedulerGuidanceOnce, observeStableBlockage } from './guidance.js';
import { runPostTerminateHook } from './research.js';

type GateValidationDeltaArtifact = NonNullable<Awaited<ReturnType<typeof import('../../scheduler.js').recordGateValidationDelta>>>;

export interface TerminalEvaluationServices {
  validationDeltaMatchesCurrentExecution(projectDir: string, runId: string, delta: GateValidationDeltaArtifact): boolean;
  recordGateValidationDelta: typeof import('../../scheduler.js').recordGateValidationDelta;
  writeCampaignEntry(projectDir: string, state: StoreState): void;
  concludeRepeatedBlockage(state: StoreState, ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number }): StoreState | null;
}

export interface TerminalEvaluationContext {
  projectDir: string;
  runId: string;
  runDirPath: string;
  iteration: number;
  adapter: Adapter;
  /** Testable boundary for the terminal freshness revalidation. Production
   * callers omit this and execute the setup-recorded commands normally. */
  validationDependencies?: ProjectValidationDependencies;
}

export type TerminalEvaluation =
  | { decision: 'matched'; state: StoreState; reasons: string[] }
  | { decision: 'deferred' | 'not_matched'; reasons: string[] };

export interface TerminalValidationFreshnessResult {
  required: boolean;
  pass: boolean;
  disposition: 'no_baseline' | 'already_blessed' | 'revalidated' | 'rejected';
  writeAt: string;
  validationStageId?: string;
  checkedAt?: string;
  reason?: string;
}

interface ResearchTerminalSelection {
  terminalStatus: string;
  terminalPath: string;
}

function readResearchTerminalSelection(runDirPath: string): ResearchTerminalSelection | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runDirPath, 'research_decision.json'), 'utf-8')) as Record<string, unknown>;
    if (parsed.decision === 'continue') return undefined;
    if (typeof parsed.terminalStatus !== 'string' || typeof parsed.terminalPath !== 'string') return undefined;
    return { terminalStatus: parsed.terminalStatus, terminalPath: parsed.terminalPath };
  } catch {
    return undefined;
  }
}

function quarantineTerminalCandidate(runDirPath: string, sourcePath: string, label: string): string | undefined {
  if (!existsSync(sourcePath)) return undefined;
  const safeLabel = label.replace(/[^A-Za-z0-9_.-]+/g, '_');
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const target = join(runDirPath, `${safeLabel}${suffix === 0 ? '' : `_${suffix}`}`);
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
  const { validationDeltaMatchesCurrentExecution, recordGateValidationDelta, writeCampaignEntry, concludeRepeatedBlockage } = services;

  async function ensureTerminalArtifactValidation(input: {
    projectDir: string;
    runId: string;
    runDirPath: string;
    state: StoreState;
    ownerStageId: string;
    terminalPath: string;
    artifactMtimeMs: number;
    dependencies?: ProjectValidationDependencies;
  }): Promise<TerminalValidationFreshnessResult> {
    const baselinePath = join(input.runDirPath, RUN_VALIDATION_BASELINE_FILE);
    const attributedWriteMs = lastAttributedStageWriteMs(
      input.projectDir,
      input.state,
      input.ownerStageId,
      input.terminalPath,
    );
    const writeAtMs = attributedWriteMs ?? input.artifactMtimeMs;
    const writeAt = new Date(writeAtMs).toISOString();
    if (!existsSync(baselinePath)) {
      return { required: false, pass: true, disposition: 'no_baseline', writeAt };
    }

    const baselineSha256 = createHash('sha256').update(readFileSync(baselinePath)).digest('hex');
    const laterDeltas: GateValidationDeltaArtifact[] = [];
    for (const file of readdirSync(input.runDirPath)) {
      if (!/^validation_delta_.+\.json$/.test(file)) continue;
      try {
        const delta = JSON.parse(readFileSync(join(input.runDirPath, file), 'utf-8')) as GateValidationDeltaArtifact;
        const checkedAtMs = Date.parse(delta.checkedAt);
        if (delta.version !== 2 || delta.baselineSha256 !== baselineSha256
            || !validationDeltaMatchesCurrentExecution(input.projectDir, input.runId, delta)
            || !Number.isFinite(checkedAtMs) || checkedAtMs < writeAtMs) continue;
        laterDeltas.push(delta);
      } catch { /* malformed deltas cannot bless a terminal write */ }
    }
    laterDeltas.sort((left, right) => Date.parse(left.checkedAt) - Date.parse(right.checkedAt));
    const latest = laterDeltas.at(-1);
    if (latest) {
      return latest.pass
        ? {
            required: true,
            pass: true,
            disposition: 'already_blessed',
            writeAt,
            validationStageId: latest.stageId,
            checkedAt: latest.checkedAt,
          }
        : {
            required: true,
            pass: false,
            disposition: 'rejected',
            writeAt,
            validationStageId: latest.stageId,
            checkedAt: latest.checkedAt,
            reason: `validation delta ${latest.stageId} recorded a regression after the terminal write`,
          };
    }

    const validationStageId = `terminal_${input.ownerStageId.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
    try {
      const delta = await recordGateValidationDelta(
        input.projectDir,
        input.runId,
        validationStageId,
        input.dependencies,
      );
      if (!delta) {
        return {
          required: true,
          pass: false,
          disposition: 'rejected',
          writeAt,
          validationStageId,
          reason: 'the run validation baseline disappeared before terminal revalidation',
        };
      }
      return {
        required: true,
        pass: delta.pass,
        disposition: delta.pass ? 'revalidated' : 'rejected',
        writeAt,
        validationStageId,
        checkedAt: delta.checkedAt,
        ...(delta.pass ? {} : { reason: 'terminal revalidation regressed from the setup baseline' }),
      };
    } catch (error) {
      return {
        required: true,
        pass: false,
        disposition: 'rejected',
        writeAt,
        validationStageId,
        reason: `terminal revalidation could not run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function tryTerminateOnTerminalState(
    state: StoreState,
    ctx: TerminalEvaluationContext,
  ): Promise<TerminalEvaluation> {
    if (!state.terminalStates) {
      return { decision: 'not_matched', reasons: ['the brief declares no terminal states'] };
    }
    const notMatchedReasons: string[] = [];
    const deferredReasons: string[] = [];
    const researchSelection = state.research
      ? readResearchTerminalSelection(ctx.runDirPath)
      : undefined;
    if (!researchSelection) {
      const startedAtMs = Date.parse(state.startedAt);
      const freshLogicalCandidates = Object.entries(state.terminalStates).flatMap(([terminalStatus, entry]) => (
        entry.paths.flatMap((path) => {
          const projectPath = join(ctx.projectDir, path);
          const snapshotPath = join(ctx.runDirPath, `terminal_${path.split('/').pop()}`);
          const admittedOwner = admittedTerminalOwner(ctx.runDirPath, path);
          const attributedToCurrentRun = Boolean(
            admittedOwner
            && stageAttemptWroteProjectPath(ctx.projectDir, state, admittedOwner, path),
          );
          const sources = [projectPath, snapshotPath].filter((candidate) => {
            try {
              return existsSync(candidate)
                && Number.isFinite(startedAtMs)
                && (statSync(candidate).mtimeMs >= startedAtMs
                  || (candidate === projectPath && attributedToCurrentRun));
            } catch { return false; }
          });
          return sources.length > 0 ? [{ terminalStatus, path, sources }] : [];
        })
      ));
      if (freshLogicalCandidates.length > 1) {
        const evidence = createHash('sha256');
        for (const candidate of freshLogicalCandidates.sort((left, right) => left.path.localeCompare(right.path))) {
          evidence.update(`${candidate.terminalStatus}:${candidate.path}\n`, 'utf8');
          try { evidence.update(readFileSync(candidate.sources[0])); } catch { evidence.update('<unreadable>', 'utf8'); }
        }
        const ownerIds = [...new Set(freshLogicalCandidates
          .map((candidate) => admittedTerminalOwner(ctx.runDirPath, candidate.path))
          .filter((owner): owner is string => Boolean(owner)))];
        const detail = `multiple fresh terminal outcomes exist: ${freshLogicalCandidates.map((candidate) => `${candidate.terminalStatus}=${candidate.path}`).join(', ')}`;
        const blockage = observeStableBlockage({
          runDirPath: ctx.runDirPath,
          kind: 'ambiguous_terminal_outcome',
          stageId: ownerIds.length === 1 ? ownerIds[0] : undefined,
          detail,
          evidenceDigest: evidence.digest('hex'),
          threshold: state.campaignTriggers?.repeatedFailureAfter,
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
        for (const ownerId of ownerIds) {
          if (!state.stages[ownerId]) continue;
          state.stages[ownerId] = rependStageStatus(state.stages[ownerId], 0);
          writeStageStatus(ctx.projectDir, ctx.runId, ownerId, state.stages[ownerId]);
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            ownerId,
            `[ambiguous-terminal:${blockage?.occurrence.fingerprint ?? 'unknown'}:${ownerId}]`,
            `Terminal output rejected: ${detail}. Choose the single path matching the outcome that actually happened and write only that path.`,
            Object.keys(state.stages),
          );
        }
        if (ownerIds.some((ownerId) => state.stages[ownerId])) writeRunState(ctx.projectDir, ctx.runId, state);
        return { decision: 'deferred', reasons: [detail] };
      }
    }
    for (const [terminalStatus, entry] of Object.entries(state.terminalStates)) {
      for (const path of entry.paths) {
        
        const projPath = join(ctx.projectDir, path);
        const snapPath = join(ctx.runDirPath, `terminal_${path.split('/').pop()}`);
        const startedAtMs = Date.parse(state.startedAt);
        const candidates = [projPath, snapPath].flatMap((candidate) => {
          if (!existsSync(candidate)) return [];
          try { return [{ path: candidate, mtimeMs: statSync(candidate).mtimeMs }]; } catch { return []; }
        });
        if (candidates.length === 0) {
          notMatchedReasons.push(`${terminalStatus}: ${path} is absent`);
          continue;
        }
        const admittedOwner = admittedTerminalOwner(ctx.runDirPath, path);
        const attributedToCurrentRun = Boolean(
          admittedOwner
          && stageAttemptWroteProjectPath(ctx.projectDir, state, admittedOwner, path),
        );
        const source = Number.isFinite(startedAtMs)
          ? candidates.find((candidate) => candidate.mtimeMs >= startedAtMs)
            ?? (attributedToCurrentRun
              ? candidates.find((candidate) => candidate.path === projPath)
              : undefined)
          : undefined;
        if (!source) {
          const hintMarker = `[scheduler-hint:${terminalStatus}:${path}:freshness]`;
          const newestMtime = candidates.reduce((latest, candidate) => Math.max(latest, candidate.mtimeMs), Number.NEGATIVE_INFINITY);
          const reason = Number.isFinite(startedAtMs)
            ? `${path} exists but predates this run start: newest mtime ${new Date(newestMtime).toISOString()} < startedAt ${state.startedAt}`
            : `${path} exists, but run startedAt '${state.startedAt}' is invalid; freshness cannot be proven`;
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
        const sourcePath = source.path;
        if (admittedOwner && !stageAttemptWroteProjectPath(ctx.projectDir, state, admittedOwner, path)) {
          const marker = `[scheduler-hint:${terminalStatus}:${path}:owner]`;
          const reason = `${path} is owned by terminal stage '${admittedOwner}', but that stage has no completed-attempt write attribution for the path`;
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            admittedOwner,
            marker,
            `Terminal artifact rejected: ${reason}. The owner must run after its declared ancestors and write the terminal path itself.`,
            Object.keys(state.stages),
          );
          const quarantined = sourcePath === projPath
            ? quarantineTerminalCandidate(ctx.runDirPath, sourcePath, `non_owner_terminal_${terminalStatus}_${path.split('/').pop() ?? 'artifact'}`)
            : undefined;
          if (quarantined) {
            recordRunEvent(ctx.projectDir, ctx.runId, {
              type: 'terminal_candidate_quarantined', runId: ctx.runId, timestamp: new Date().toISOString(),
              stageId: admittedOwner,
              detail: `${path} moved to ${quarantined} because no write was attributed to its admitted owner`,
              artifacts: [quarantined], level: 'warning', source: 'scheduler',
            });
          }
          log.warn({ runId: ctx.runId, terminalStatus, path, admittedOwner, quarantined }, 'Terminal-state file rejected because its admitted owner did not produce it');
          deferredReasons.push(`${terminalStatus}: ${reason}`);
          continue;
        }
        if (researchSelection
            && (researchSelection.terminalStatus !== terminalStatus || researchSelection.terminalPath !== path)) {
          const reason = `${path} declares '${terminalStatus}', but the settled research policy selected '${researchSelection.terminalStatus}' via ${researchSelection.terminalPath}`;
          if (sourcePath === projPath && admittedOwner) {
            quarantineTerminalCandidate(
              ctx.runDirPath,
              sourcePath,
              `wrong_terminal_${terminalStatus}_${path.split('/').pop() ?? 'artifact'}`,
            );
          }
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            admittedOwner ?? RUN_WIDE_GUIDANCE_TARGET,
            `[scheduler-hint:${terminalStatus}:${path}:research-selection]`,
            `Terminal artifact rejected: ${reason}. Read research_decision.json and write only its terminalPath.`,
            Object.keys(state.stages),
          );
          deferredReasons.push(`${terminalStatus}: ${reason}`);
          continue;
        }
        
        const floorCheck = state.research && admittedOwner && terminalStatus === RUN_STATUS.CEILING_HIT
          ? (() => {
              let measuredRounds = 0;
              try {
                const journal = JSON.parse(readFileSync(join(ctx.runDirPath, 'research_journal.json'), 'utf-8')) as { rounds?: unknown[] };
                measuredRounds = Array.isArray(journal.rounds) ? journal.rounds.length : 0;
              } catch { /* missing/corrupt journal fails the floor as zero rounds */ }
              const startedAtMs = Date.parse(state.startedAt);
              const elapsedMinutes = Number.isFinite(startedAtMs) ? (Date.now() - startedAtMs) / 60000 : 0;
              return evaluateResearchCeilingFloor(entry.floor, measuredRounds, elapsedMinutes);
            })()
          : evaluateTerminalFloor(state, entry, ctx.projectDir);
        if (!floorCheck.passed) {
          
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
        const hasSettledNonPlanStage = Object.entries(state.stages ?? {})
          .some(([stageId, stage]) => stageId !== 'plan'
            && (stage.status === STAGE_STATUS.COMPLETE || stage.status === STAGE_STATUS.FAILED));
        if (!hasSettledNonPlanStage) {
          const hintMarker = `[scheduler-hint:${terminalStatus}:${path}:non-plan-complete]`;
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            RUN_WIDE_GUIDANCE_TARGET,
            hintMarker,
            `${path} is fresh, but terminal status '${terminalStatus}' requires at least one non-plan stage to complete during this run (a failed non-plan stage that reached execution also counts as settled proof). Continue planned work; the plan stage alone is not proof of execution.`,
          );
          log.warn({ runId: ctx.runId, terminalStatus, path }, 'Fresh terminal-state file exists before any non-plan stage settled — NOT terminating');
          deferredReasons.push(`${terminalStatus}: ${path} is fresh, but no non-plan stage has settled as complete or failed`);
          continue;
        }
        
        if (terminalStatus === RUN_STATUS.SHIPPED && state.research?.confirm) {
          let confirmReport: { pass: boolean; results: Array<{ details: string }> };
          try {
            confirmReport = await runAllChecks(
              [{ name: 'research_confirm', type: 'exec-script-exit-zero', reads: state.research.confirm.reads ?? [], params: { script: state.research.confirm.command, timeout_seconds: state.research.confirm.timeoutSeconds ?? 300 } }],
              { taskDir: ctx.runDirPath, projectDir: ctx.projectDir },
            );
          } catch (err) {
            confirmReport = { pass: false, results: [{ details: `confirm command threw: ${err instanceof Error ? err.message : String(err)}` }] };
          }
          try { writeFileSync(join(ctx.runDirPath, 'research_confirm.json'), JSON.stringify({ ...confirmReport, command: state.research.confirm.command, requires: state.research.confirm.requires, trigger: `terminal file ${path}` }, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
          if (!confirmReport.pass) {
            const detail = confirmReport.results.map((r) => r.details).join('; ') || 'confirm command did not exit 0';
            const hintMarker = `[scheduler-hint:shipped-confirm:${path}]`;
            appendSchedulerGuidanceOnce(
              ctx.runDirPath,
              RUN_WIDE_GUIDANCE_TARGET,
              hintMarker,
              `${path} declares a ship but the brief's confirm gate REJECTED it: ${detail}. A ship claim must pass confirm — remove/replace the premature ship artifact and either continue measuring or write an honest ceiling/escalation.`,
            );
            log.warn({ runId: ctx.runId, terminalStatus, path, detail }, 'Shipped terminal file REJECTED by confirm gate — NOT terminating');
            deferredReasons.push(`${terminalStatus}: ${path} was rejected by research confirm: ${detail}`);
            continue;
          }
          log.info({ runId: ctx.runId, path }, 'Shipped terminal file passed confirm gate');
        }
        if (admittedOwner) {
          const validation = await ensureTerminalArtifactValidation({
            projectDir: ctx.projectDir,
            runId: ctx.runId,
            runDirPath: ctx.runDirPath,
            state,
            ownerStageId: admittedOwner,
            terminalPath: path,
            artifactMtimeMs: source.mtimeMs,
            dependencies: ctx.validationDependencies,
          });
          if (!validation.pass) {
            const reason = `${path} was written at ${validation.writeAt}, but ${validation.reason ?? 'no later passing validation blessed it'}`;
            appendSchedulerGuidanceOnce(
              ctx.runDirPath,
              admittedOwner,
              `[scheduler-hint:${terminalStatus}:${path}:validation-freshness:${validation.writeAt}]`,
              `Terminal artifact rejected: ${reason}. Fix the regression, rerun the configured validation set, and rewrite the terminal artifact only after the delivered bytes are green.`,
              Object.keys(state.stages),
            );
            log.warn({
              runId: ctx.runId,
              terminalStatus,
              path,
              admittedOwner,
              validation,
            }, 'Terminal-state file rejected because its validation evidence predates or rejects the attributed write');
            deferredReasons.push(`${terminalStatus}: ${reason}`);
            continue;
          }
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
        state.status = terminalStatus as StoreState['status'];
        state.terminalArtifact = path.split('/').pop();
        state.completedAt = new Date().toISOString();
        markLeftoverStagesSkipped(state, `terminal state '${terminalStatus}' reached before this stage ran`);
        
        try {
          if (sourcePath !== snapPath) copyFileSync(sourcePath, snapPath);
        } catch { /* non-critical */ }
        const gate = await enforceRealityGateBeforeTerminal(ctx.projectDir, ctx.runId, state, state.status);
        if (!gate.allowed) {
          if (sourcePath === projPath && admittedOwner) {
            quarantineTerminalCandidate(
              ctx.runDirPath,
              sourcePath,
              `reality_rejected_${terminalStatus}_${path.split('/').pop() ?? 'terminal_candidate'}`,
            );
          }
          return { decision: 'matched', state: gate.state, reasons: [] };
        }
        writeRunState(ctx.projectDir, ctx.runId, state);
        writeCampaignEntry(ctx.projectDir, state);
        recordRunEvent(ctx.projectDir, ctx.runId, {
          type: 'run_completed',
          runId: ctx.runId,
          timestamp: state.completedAt,
          iteration: ctx.iteration,
          detail: `Terminal state '${terminalStatus}' reached via ${path}`,
        });
        log.info({ runId: ctx.runId, iteration: ctx.iteration, terminalStatus, path }, 'Terminal-state file detected; ending iteration loop');
        await generateRunSummary(ctx.projectDir, ctx.runId, ctx.adapter).catch(() => { /* non-critical */ });
        // Auto-append ledger row only on phase_complete (other terminal states
        // are program-level, not phase-level).
        if (state.program && terminalStatus === RUN_STATUS.PHASE_COMPLETE) {
          const startedMs = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
          const wallHours = (Date.now() - startedMs) / 3600000;
          appendProgramLedger(ctx.projectDir, state.program, {
            phase: state.program.phase,
            run_id: ctx.runId,
            started_utc: state.startedAt,
            completed_utc: state.completedAt,
            wall_hours: Number(wallHours.toFixed(3)),
            terminal_artifact: path,
          });
        }
        if (entry.postTerminateHook) {
          const extraEnv: Record<string, string> = state.program ? {
            FC_PROGRAM_NAME: state.program.name,
            FC_PROGRAM_PHASE: state.program.phase,
            ...(state.program.roadmap ? { FC_PROGRAM_ROADMAP: join(ctx.projectDir, state.program.roadmap) } : {}),
            ...(state.program.ledger ? { FC_PROGRAM_LEDGER: join(ctx.projectDir, state.program.ledger) } : {}),
          } : {};
          const hookWithEnv: PostTerminateHook = {
            ...entry.postTerminateHook,
            env: { ...(entry.postTerminateHook.env ?? {}), ...extraEnv },
          };
          await runPostTerminateHook(hookWithEnv, {
            projectDir: ctx.projectDir,
            runDir: ctx.runDirPath,
            runId: ctx.runId,
            terminalStatus,
            verdictPath: sourcePath,
          }).catch((err) => {
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
    const evaluation = await tryTerminateOnTerminalState(state, ctx);
    if (evaluation.decision === 'matched') return evaluation.state;

    const reasonDetail = evaluation.reasons.slice(0, 8).join('; ')
      || 'no terminal candidate supplied a reason';
    const conclusion = evaluation.decision === 'not_matched'
      ? `All stages settled, but no declared terminal state matched (${completionPath}): ${reasonDetail}`
      : `All stages settled, but declared terminal evaluation could not decide (${completionPath}): ${reasonDetail}`;
    state.status = RUN_STATUS.INCOMPLETE;
    state.failureReason = conclusion;
    state.completedAt = new Date().toISOString();
    markLeftoverStagesSkipped(state, conclusion);
    writeRunState(ctx.projectDir, ctx.runId, state);
    writeCampaignEntry(ctx.projectDir, state);
    recordRunEvent(ctx.projectDir, ctx.runId, {
      type: 'run_completed',
      runId: ctx.runId,
      timestamp: state.completedAt,
      iteration: ctx.iteration,
      detail: `terminal evaluation ${evaluation.decision}: ${conclusion}`,
    });
    log.warn({
      runId: ctx.runId,
      iteration: ctx.iteration,
      completionPath,
      terminalDecision: evaluation.decision,
      reasons: evaluation.reasons,
    }, 'Settled DAG reached an explicit unmatched terminal conclusion');
    await generateRunSummary(ctx.projectDir, ctx.runId, ctx.adapter).catch(() => { /* non-critical */ });
    return state;
  }

  return { ensureTerminalArtifactValidation, tryTerminateOnTerminalState, concludeDeclaredTerminalAtQuiescence };
}
