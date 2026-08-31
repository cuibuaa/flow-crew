import { readFileSync, readlinkSync, mkdirSync, readdirSync, writeFileSync, existsSync, unlinkSync, appendFileSync, statSync, lstatSync, renameSync, copyFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { loadAdapterByName } from './adapters/loader.js';
import {
  APPROVAL_REQUEST_FILE,
  APPROVALS_DIR,
  approvalArtifactPath,
  isValidApprovalRequestId,
} from './approval-artifacts.js';
import { evaluateCondition } from './condition.js';
import {
  enforceRealityGateBeforeTerminal,
  initializeReservedRun,
  readRunReservation,
  readRunState,
  requireKnownRunStatus,
  reserveRun,
  writeRunState,
  writeStageStatus,
  readStageStatus,
  completeStageAttempt,
  attachStageConstraintAudit,
  captureStageEvidence,
  resetStageLiveAttemptAliases,
  rependStageStatus,
  runDir,
  stageDir,
  isAwaitingApprovalRunStatus,
  isPendingStageStatus,
  isRunningStageStatus,
  isSatisfiedStageDependencyStatus,
  isTerminalRunStatus,
  isPausedRunStatus,
  RUN_STATUS,
  STAGE_STATUS,
  TERMINAL_STATUSES,
} from './store.js';
import {
  claimLaunchIntent,
  describeLiveRunOwner,
  findLiveRunOwnerForProject,
  invalidateRunLockCache,
  isLiveFlowcrewSchedulerForRun,
  parseSchedulerPidMarker,
  releaseLaunchIntent,
  removeSchedulerProcessIdentity,
  writeSchedulerProcessIdentity,
} from './run-lock.js';
import {
  foldItems,
  INBOX_ITEM_STATE,
  isPendingInboxItemState,
  matchStandingRule,
  recordRequest,
  resolveRequest,
  type ApprovalRisk,
} from './inbox.js';
import type { StoreState, StageStatus, WriteAttribution, TerminalStatesConfig, TerminalStateEntry, PostTerminateHook, ProgramConfig, ResearchConfig, ResearchIntegrityConfig, ResearchConfirmConfig } from './store.js';
import { listCheckTypes, parseChecksFromMarkdown, runAllChecks } from './reality-gate/index.js';
import { evaluateResearch, evaluateResearchCeilingFloor, RESEARCH_POLICY_IDS, ResearchPolicySchema, type ResearchRound } from './research-policy.js';
import { parseResearchFeasibility, type ResearchFeasibilityConfig } from './research-feasibility.js';
import { summarizeContext } from './context-inventory.js';
import { summarizeLedger } from './campaign-ledger.js';
import { validate as validateResultSchema } from './reality-gate/checks/json-schema-match.js';
import { runStage } from './worker.js';
import {
  createTechnicalRetryBudgetState,
  nextTechnicalRetryBudget,
  transitionTechnicalRetryBudget,
  type AttemptDeadlineClock,
  type TechnicalRetryBudgetState,
} from './attempt-deadline.js';
import {
  buildScopeNegotiationTrace,
  negotiationRequestDigest,
  parseScopeRevisionRequest,
  publishConstraintDecision,
  publishJsonCreateOnly,
  readConstraintDecision,
  rejectedScopeDigest,
  scopePathDigest,
  type RuntimeConstraintDecisionV1,
  type ScopeStageKind,
  type ScopeRevisionRequestV1,
} from './runtime-negotiation.js';
import {
  canonicalCampaignId,
  collapseEntriesForHealth,
  readCampaignEntries,
  resolveCampaignStorageKey,
} from './campaigns.js';
import { formatCampaignContextBlock, selectRelevantCampaignContext } from './campaign-context.js';
import { recordRunEvent, recordStageOutcome } from './run-events.js';
import { readKG, summarizeKG, ratchetCheck, markDeadEnd, updateMetadata } from './knowledge-graph.js';
import { appendTraceEvent } from './trace.js';
import { generateRunSummary } from './run-summary.js';
import { Supervisor } from './supervisor.js';
import { isSessionReuseEnabled, loadProjectDefaults, loadSupervisorConfig } from './config.js';
import { readCodexSession, type CodexSessionMetadata } from './adapters/codex.js';
import { createLogger } from './logging.js';
import { verifyBriefAdmission, type BriefAdmissionRecord } from './brief-preflight.js';
import {
  demoteRealityCheckAdvisories,
  formatRealityCheckPreflightFindings,
  inspectRealityChecks,
  type RealityCheckPreflightFinding,
  type RealityCheckPreflightReport,
} from './reality-check-preflight.js';
import { readShipSetupReadyValidationBaseline } from './ship-setup-record.js';
import { writeBriefCriteriaArtifact, type BriefCriteriaArtifact } from './brief-criteria.js';
import {
  appendGuidanceEnvelope,
  RUN_WIDE_GUIDANCE_TARGET,
} from './guidance.js';
import { recordBlockageOccurrence } from './blockage-ledger.js';
import { inspectTemporalResearchTests } from './temporal-test-guard.js';

const log = createLogger({ name: 'scheduler' });
const CAMPAIGN_PHASE_COMPLETE_SENTINEL = 'complete';

/**
 * FIX D — confirm-gate observability on non-ship terminals. The confirm gate runs ONLY on a
 * `ship` decision, so a brief-declared `research.confirm` is silently SKIPPED on a non-ship
 * terminal (e.g. ceiling_hit / incomplete) with no record at all. This records that a declared
 * confirm was NOT run (and why), so a declared confirm is never silently invisible. It does NOT
 * run the confirm and does NOT alter the terminal status — the safer of the two options. No-ops
 * (returns without writing) when no confirm is declared, or when a real research_confirm.json
 * already exists (don't clobber an actual confirm result on the ship path).
 */
function recordConfirmNotRun(runDirPath: string, confirm: ResearchConfirmConfig | undefined, terminalStatus: string): void {
  if (!confirm?.command) return;
  const path = join(runDirPath, 'research_confirm.json');
  if (existsSync(path)) return; // a real confirm result was already written (ship path) — leave it.
  try {
    writeFileSync(path, JSON.stringify({
      status: 'not_run',
      reason: `confirm runs on a 'ship' terminal; this run terminated '${terminalStatus}', so the brief-declared confirm was not executed`,
      command: confirm.command,
      requires: confirm.requires,
    }, null, 2) + '\n', 'utf-8');
  } catch { /* non-critical */ }
}

/**
 * Parse `---` YAML frontmatter from the top of a task brief. Used to extract
 * `terminal_states` config that tells the scheduler which file paths signal a
 * legitimate completion (so a research-exploration brief can declare
 * ceiling_report.md as a valid terminal state instead of being treated as
 * "goal metric not met → retry forever").
 *
 * Accepted shapes inside `terminal_states`:
 *   shipped: docs/.../ship_report.md                    (string → single path)
 *   shipped: [docs/a.md, docs/b.md]                     (array → multiple paths)
 *   ceiling_hit:                                        (object → with floor)
 *     paths: [docs/.../ceiling_report.md]
 *     floor: { min_attempted_stages: 4, min_wall_minutes: 60 }
 *     stage_glob: docs/v8_research/stage_*_verdict.md   (used to count attempted stages)
 *
 * `min_attempted_stages` counts files matching `stage_glob` — inferred as
 * `<dir of the first declared path>/stage_*_verdict.md` when it is absent. NOTHING IN THIS
 * ENGINE WRITES THOSE FILES: they exist only when the brief itself tells a stage to write
 * them, so a floor declared without that instruction can never be satisfied. `brief-preflight`
 * reports that case rather than letting the run spend its whole budget unable to terminate.
 * The research-loop ceiling is the one exception and it does not glob at all — it counts
 * measured rounds instead, for exactly this reason; see `evaluateResearchCeilingFloor`.
 *
 * Returns the stripped brief (with frontmatter removed so the planner doesn't
 * see internal config) plus the parsed config. Briefs without frontmatter,
 * with malformed YAML, or with unknown shapes are passed through unchanged.
 */
export interface ParsedBriefFrontmatter {
  terminalStates?: TerminalStatesConfig;
  program?: ProgramConfig;
  /** Metric-loop config. A numeric baseline is the sole activator. */
  research?: ResearchConfig;
  /** Static preflight contract, independently reachable without activating a metric loop. */
  researchFeasibility?: ResearchFeasibilityConfig;
  /** Strict-parser error retained even when no metric-loop config is created. */
  researchFeasibilityError?: string;
  researchPolicyError?: string;
  stripped: string;
  frontmatterError?: string;
}

export function parseBriefFrontmatter(brief: string): ParsedBriefFrontmatter {
  if (!brief.startsWith('---\n') && !brief.startsWith('---\r\n')) return { stripped: brief };
  const open = brief.indexOf('\n', 3) + 1;
  const closeIdx = brief.indexOf('\n---', open);
  // GAP-3: a brief that OPENED a frontmatter fence but never closed it is
  // malformed — surface that instead of silently passing the whole brief through
  // (which would hide a research: block the author intended to declare).
  if (closeIdx < 0) return { stripped: brief, frontmatterError: 'frontmatter fence opened with `---` but never closed (no closing `---` line)' };
  const fm = brief.slice(open, closeIdx);
  // Find the newline that ends the closing fence so we can slice past it
  const afterFence = brief.indexOf('\n', closeIdx + 4);
  const stripped = afterFence < 0 ? '' : brief.slice(afterFence + 1);
  let parsed: unknown;
  // GAP-3: RETURN the YAML parse error instead of swallowing it — the caller can
  // then fail loud / record an event rather than silently falling back to plain dispatch.
  try { parsed = parseYaml(fm); } catch (err) { return { stripped: brief, frontmatterError: `frontmatter YAML parse error: ${err instanceof Error ? err.message : String(err)}` }; }
  if (!parsed || typeof parsed !== 'object') return { stripped, frontmatterError: 'frontmatter parsed but is not a YAML mapping/object' };
  const out: ParsedBriefFrontmatter = { stripped };

  // `research:` and `objective:` are exact aliases. Static feasibility is parsed
  // independently; only a numeric baseline creates the native metric-loop config.
  const resRaw = (parsed as Record<string, unknown>).research ?? (parsed as Record<string, unknown>).objective;
  if (resRaw && typeof resRaw === 'object') {
    const r = resRaw as Record<string, unknown>;
    if (r.feasibility !== undefined) {
      const feasibility = parseResearchFeasibility(r.feasibility);
      if (feasibility.status === 'valid') out.researchFeasibility = feasibility.value;
      else out.researchFeasibilityError = feasibility.error;
    }
    if (typeof r.baseline === 'number') {
      // An unrecognised policy used to fall through to greedy_stack without a word.
      // That silence cost a real campaign: a brief wrote `policy: heuristic_policy_v1`,
      // believing the field named the opponent rather than the keep/drop rule, got the
      // default, and the run's premature ceiling was only traced back to it by reading
      // this line. Report it the way the neighbouring feasibility parse reports its
      // failures -- an error on `out` that brief-preflight raises as a finding -- rather
      // than throwing, because nothing in this function throws.
      const policyParse = ResearchPolicySchema.safeParse(r.policy ?? 'greedy_stack');
      if (!policyParse.success) {
        out.researchPolicyError =
          `${JSON.stringify(r.policy)} is not one of ${RESEARCH_POLICY_IDS.join(', ')}`;
      }
      const policy: ResearchConfig['policy'] = policyParse.success ? policyParse.data : 'greedy_stack';
      const research: ResearchConfig = { baseline: r.baseline, policy };
      // Honor higher_is_better; coerce the common YAML-quoting mistake ("false"/"true"
      // as strings) instead of silently dropping it (which would flip every keep/ship
      // decision for a lower-is-better metric). Warn on an uncoercible value.
      if (typeof r.higher_is_better === 'boolean') {
        research.higherIsBetter = r.higher_is_better;
      } else if (typeof r.higher_is_better === 'string') {
        const v = r.higher_is_better.trim().toLowerCase();
        if (v === 'false' || v === 'true') research.higherIsBetter = v === 'true';
        else log.warn({ value: r.higher_is_better }, 'research.higher_is_better is not a boolean — ignoring (defaults to higher-is-better)');
      } else if (r.higher_is_better !== undefined) {
        log.warn({ value: r.higher_is_better }, 'research.higher_is_better is not a boolean — ignoring (defaults to higher-is-better)');
      }
      if (typeof r.result_file === 'string') research.resultFile = r.result_file;
      if (typeof r.report_dir === 'string') research.reportDir = r.report_dir;
      if (out.researchFeasibility !== undefined) research.feasibility = out.researchFeasibility;
      if (out.researchFeasibilityError !== undefined) research.feasibilityError = out.researchFeasibilityError;
      // Per-round integrity gates — brief-declared so the engine carries no domain
      // field/threshold knowledge. snake_case in YAML → camelCase in config.
      if (r.integrity && typeof r.integrity === 'object') {
        const ig = r.integrity as Record<string, unknown>;
        const integrity: ResearchIntegrityConfig = {};
        if (typeof ig.noop === 'boolean') integrity.noop = ig.noop;
        if (typeof ig.max_std_ratio === 'number') integrity.maxStdRatio = ig.max_std_ratio;
        if (typeof ig.outlier_factor === 'number') integrity.outlierFactor = ig.outlier_factor;
        if (ig.field_floors && typeof ig.field_floors === 'object') {
          const ff: Record<string, number> = {};
          for (const [k, v] of Object.entries(ig.field_floors as Record<string, unknown>)) if (typeof v === 'number') ff[k] = v;
          if (Object.keys(ff).length) integrity.fieldFloors = ff;
        }
        if (Array.isArray(ig.reject_if_positive)) {
          const rip = ig.reject_if_positive.filter((x): x is string => typeof x === 'string');
          if (rip.length) integrity.rejectIfPositive = rip;
        }
        research.integrity = integrity;
      }
      // Single-source output contract: an opaque JSON Schema for round_result, used to
      // validate each round + injected to the planner so its checks reference the declared shape.
      if (r.result_schema && typeof r.result_schema === 'object') research.resultSchema = r.result_schema as Record<string, unknown>;
      if (Array.isArray(r.context_roots)) {
        const roots = r.context_roots.filter((x): x is string => typeof x === 'string');
        if (roots.length) research.contextRoots = roots;
      }
      // OUTER-loop portfolio: direction labels the campaign must cover before a frontier is honored.
      if (Array.isArray(r.directions)) {
        const dirs = r.directions.filter((x): x is string => typeof x === 'string');
        if (dirs.length) research.directions = dirs;
      }
      // A+(a) CONFIRM gate — verify-before-trust as a generic mechanism. The brief declares a
      // shell command (and optional human-readable contract); the engine runs it before a `ship`
      // (via the same exec-script-exit-zero check the reality gate uses) and only allows `shipped`
      // if it exits 0, else downgrades to `ceiling_hit`. The engine holds NO domain knowledge —
      // the command/assertion is entirely brief-owned (e.g. "re-run on a fresh split, assert beat").
      if (r.confirm && typeof r.confirm === 'object') {
        const c = r.confirm as Record<string, unknown>;
        if (typeof c.command === 'string' && c.command.trim()) {
          const confirm: ResearchConfirmConfig = { command: c.command };
          if (typeof c.requires === 'string') confirm.requires = c.requires;
          if (typeof c.timeout_seconds === 'number') confirm.timeoutSeconds = c.timeout_seconds;
          research.confirm = confirm;
        }
      }
      if (r.stop && typeof r.stop === 'object') {
        const s = r.stop as Record<string, unknown>;
        research.stop = {};
        if (typeof s.beat === 'number') research.stop.beat = s.beat;
        if (typeof s.max_rounds === 'number') research.stop.maxRounds = s.max_rounds;
        if (typeof s.max_wall_hours === 'number') research.stop.maxWallHours = s.max_wall_hours;
        if (typeof s.halt_after_no_improvement === 'number') research.stop.haltAfterNoImprovement = s.halt_after_no_improvement;
        if (typeof s.min_improvement === 'number') research.stop.minImprovement = s.min_improvement;
        if (typeof s.improvement_se_multiple === 'number') research.stop.improvementSEMultiple = s.improvement_se_multiple;
      }
      out.research = research;
    }
  }

  // Parse the optional `program:` block first — used for multi-phase research
  // programs that need safeguards + auto-ledger. Schema is permissive: missing
  // fields fall back to defaults.
  const progRaw = (parsed as Record<string, unknown>).program;
  if (progRaw && typeof progRaw === 'object') {
    const p = progRaw as Record<string, unknown>;
    if (typeof p.name === 'string' && typeof p.phase === 'string') {
      const program: ProgramConfig = { name: p.name, phase: p.phase };
      if (typeof p.roadmap === 'string') program.roadmap = p.roadmap;
      if (typeof p.ledger === 'string') program.ledger = p.ledger;
      if (p.safeguards && typeof p.safeguards === 'object') {
        const s = p.safeguards as Record<string, unknown>;
        program.safeguards = {};
        if (typeof s.max_phases === 'number') program.safeguards.maxPhases = s.max_phases;
        if (typeof s.max_wall_hours === 'number') program.safeguards.maxWallHours = s.max_wall_hours;
        if (typeof s.stop_file === 'string') program.safeguards.stopFile = s.stop_file;
        if (typeof s.halt_after_consecutive_no_improvement === 'number') {
          program.safeguards.haltAfterConsecutiveNoImprovement = s.halt_after_consecutive_no_improvement;
        }
      }
      out.program = program;
    }
  }

  const raw = (parsed as Record<string, unknown>).terminal_states;
  if (!raw || typeof raw !== 'object') return out;
  const ts: TerminalStatesConfig = {};
  for (const [status, val] of Object.entries(raw as Record<string, unknown>)) {
    // Only a REAL terminal status may be declared here. Without this check a
    // brief could declare e.g. `terminal_states: { parked: ... }` and the
    // terminal gate would blind-cast it into run.json WITH completedAt while
    // every terminal guard reports false — an agent-reachable way to forge a
    // zombie run that no consumer treats as finished or alive.
    if (!isTerminalRunStatus(status)) {
      log.warn({ status, allowed: TERMINAL_STATUSES }, 'terminal_states declares a non-terminal status — ignoring that key');
      continue;
    }
    let entry: TerminalStateEntry | null = null;
    if (typeof val === 'string') entry = { paths: [val] };
    else if (Array.isArray(val)) {
      const paths = val.filter((x): x is string => typeof x === 'string');
      if (paths.length > 0) entry = { paths };
    } else if (val && typeof val === 'object') {
      const v = val as Record<string, unknown>;
      const paths = Array.isArray(v.paths)
        ? (v.paths as unknown[]).filter((x): x is string => typeof x === 'string')
        : typeof v.path === 'string' ? [v.path] : [];
      if (paths.length === 0) continue;
      entry = { paths };
      if (v.floor && typeof v.floor === 'object') {
        const f = v.floor as Record<string, unknown>;
        entry.floor = {};
        if (typeof f.min_attempted_stages === 'number') entry.floor.minAttemptedStages = f.min_attempted_stages;
        if (typeof f.min_wall_minutes === 'number') entry.floor.minWallMinutes = f.min_wall_minutes;
        // stage_glob is logically a floor parameter, so accept it INSIDE the
        // floor block (the intuitive placement). Entry-level placement below
        // takes precedence if both are present (entry level is canonical).
        if (typeof f.stage_glob === 'string') entry.stageGlob = f.stage_glob;
      }
      if (typeof v.stage_glob === 'string') entry.stageGlob = v.stage_glob;
      // post_terminate_hook: optional command to run after this terminal state
      // is committed — used for chaining into the next phase of a multi-phase
      // research program. See PostTerminateHook docs in store.ts.
      if (v.post_terminate_hook && typeof v.post_terminate_hook === 'object') {
        const h = v.post_terminate_hook as Record<string, unknown>;
        if (typeof h.command === 'string' && h.command.length > 0) {
          const hook: PostTerminateHook = { command: h.command };
          if (Array.isArray(h.args)) {
            hook.args = (h.args as unknown[]).filter((x): x is string => typeof x === 'string');
          }
          if (typeof h.timeout_seconds === 'number' && h.timeout_seconds > 0) {
            hook.timeoutSeconds = h.timeout_seconds;
          }
          if (h.env && typeof h.env === 'object') {
            const envIn = h.env as Record<string, unknown>;
            const envOut: Record<string, string> = {};
            for (const [k, vv] of Object.entries(envIn)) {
              if (typeof vv === 'string') envOut[k] = vv;
            }
            if (Object.keys(envOut).length > 0) hook.env = envOut;
          }
          entry.postTerminateHook = hook;
        }
      }
    }
    if (entry) ts[status] = entry;
  }
  if (Object.keys(ts).length > 0) out.terminalStates = ts;
  return out;
}

/**
 * Evaluate the optional `floor` on a terminal-state entry. Returns passed=true
 * when no floor is configured or all floor conditions are satisfied; otherwise
 * returns passed=false with a human-readable reason for the supervisor hint.
 *
 * Two condition types are supported (extensible):
 *   - minWallMinutes: total wall time since run start
 *   - minAttemptedStages: count of files matching `stage_glob` (or inferred
 *     `<terminalDir>/stage_*_verdict.md` when not provided)
 */
function evaluateTerminalFloor(
  state: StoreState,
  entry: TerminalStateEntry,
  projectDir: string,
): { passed: boolean; reason?: string } {
  if (!entry.floor) return { passed: true };
  const { floor, stageGlob, paths } = entry;
  const startedAtMs = Date.parse(state.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return { passed: false, reason: `run startedAt '${state.startedAt}' is invalid; freshness cannot be proven` };
  }
  const elapsedMin = ((Date.now() - startedAtMs) / 60000);

  // Bug #7 fix: minAttemptedStages is the PRIMARY proof-of-work gate. Counting
  // real stage_*_verdict.md files (each backed by selection/OOS/checkpoint
  // artifacts) is a far better "did the agent do the work" signal than wall
  // time. When stages are satisfied, the floor passes regardless of wall —
  // min_wall_minutes as a hard gate produced false negatives where genuine
  // work finished fast (Phase G: 34 real min < 45 floor → hook never fired).
  if (floor.minAttemptedStages !== undefined) {
    let glob = stageGlob;
    if (!glob && paths.length > 0) {
      const first = paths[0];
      const dir = first.includes('/') ? first.substring(0, first.lastIndexOf('/')) : '.';
      glob = `${dir}/stage_*_verdict.md`;
    }
    const matches = glob
      ? countGlobMatches(projectDir, glob, startedAtMs)
      : { fresh: 0, stale: 0 };
    if (matches.fresh < floor.minAttemptedStages) {
      const globSource = stageGlob ? 'configured stage_glob' : 'inferred stage_glob';
      const staleDetail = matches.stale > 0
        ? `; ${matches.stale} matching file(s) exist but predate this run start`
        : '';
      return {
        passed: false,
        reason: `only ${matches.fresh} fresh stage verdict file(s) match ${globSource} '${glob}'${staleDetail}; need ${floor.minAttemptedStages}`,
      };
    }
    // Stages satisfied → floor passes. Wall time is informational only.
    if (floor.minWallMinutes !== undefined && elapsedMin < floor.minWallMinutes) {
      log.info(
        { minAttemptedStages: floor.minAttemptedStages, matches: matches.fresh, elapsedMin: Number(elapsedMin.toFixed(1)), minWallMinutes: floor.minWallMinutes },
        'Terminal floor: stages satisfied; passing despite wall time below min_wall_minutes (wall is advisory when stages are set)',
      );
    }
    return { passed: true };
  }

  // No stage requirement configured — fall back to wall time as the sole gate.
  if (floor.minWallMinutes !== undefined && elapsedMin < floor.minWallMinutes) {
    return { passed: false, reason: `wall time ${elapsedMin.toFixed(1)} min < required ${floor.minWallMinutes} min (no min_attempted_stages set)` };
  }
  return { passed: true };
}

/**
 * Mark all still-pending stages as skipped when a run commits a terminal
 * status mid-iteration (research loop termination, terminal-state file), so
 * run.json never shows stages silently frozen at 'pending' forever
 * (event-drift audit, engine bug #3: verify_r4_pead/fix_r4_pead left pending).
 */
function markLeftoverStagesSkipped(state: StoreState, note: string): void {
  for (const st of Object.values(state.stages ?? {})) {
    if (isPendingStageStatus(st.status)) {
      st.status = STAGE_STATUS.SKIPPED;
      st.error = note;
    }
  }
}

/**
 * Validate program-level safeguards before launching a new run. Returns
 * null if all checks pass, or a short violation reason string otherwise.
 *
 * Checks (in order, fail-fast):
 *   1. stopFile exists in projectDir → user has signaled halt
 *   2. ledger has >= maxPhases rows
 *   3. sum(ledger[*].wall_hours) >= maxWallHours
 *   4. haltAfterConsecutiveNoImprovement: last N rows all have verdict != "breakthrough"
 *
 * Missing ledger is treated as empty (first phase is always allowed).
 */
function checkProgramSafeguards(projectDir: string, program: ProgramConfig): string | null {
  const sg = program.safeguards;
  if (!sg) return null;
  if (sg.stopFile) {
    const p = join(projectDir, sg.stopFile);
    if (existsSync(p)) return `stop_file present: ${sg.stopFile}`;
  }
  let phases: Array<Record<string, unknown>> = [];
  if (program.ledger) {
    const ledgerPath = join(projectDir, program.ledger);
    if (existsSync(ledgerPath)) {
      try {
        const data = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { phases?: unknown };
        if (Array.isArray(data.phases)) {
          phases = data.phases.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object');
        }
      } catch { /* malformed ledger; treat as empty */ }
    }
  }
  if (typeof sg.maxPhases === 'number' && phases.length >= sg.maxPhases) {
    return `max_phases reached (${phases.length} >= ${sg.maxPhases})`;
  }
  if (typeof sg.maxWallHours === 'number') {
    const sum = phases.reduce((acc, p) => acc + (typeof p.wall_hours === 'number' ? p.wall_hours : 0), 0);
    if (sum >= sg.maxWallHours) {
      return `max_wall_hours reached (${sum.toFixed(2)} >= ${sg.maxWallHours})`;
    }
  }
  if (typeof sg.haltAfterConsecutiveNoImprovement === 'number' && sg.haltAfterConsecutiveNoImprovement > 0) {
    const tail = phases.slice(-sg.haltAfterConsecutiveNoImprovement);
    if (tail.length >= sg.haltAfterConsecutiveNoImprovement && tail.every((p) => p.verdict !== 'breakthrough')) {
      return `${sg.haltAfterConsecutiveNoImprovement} consecutive phases without breakthrough`;
    }
  }
  return null;
}

/**
 * Append a phase outcome row to the program's findings_ledger.json. Best
 * effort: malformed existing JSON is overwritten with a fresh object; missing
 * fields default to undefined and are omitted.
 *
 * Called by the scheduler immediately after a phase_complete terminal state
 * commits, before any post_terminate_hook fires — so the hook reads the
 * updated ledger.
 */
function appendProgramLedger(
  projectDir: string,
  program: ProgramConfig,
  row: Record<string, unknown>,
): void {
  if (!program.ledger) return;
  const ledgerPath = join(projectDir, program.ledger);
  let data: { phases: Array<Record<string, unknown>> } = { phases: [] };
  if (existsSync(ledgerPath)) {
    try {
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
      if (parsed && Array.isArray(parsed.phases)) {
        data.phases = parsed.phases.filter((x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object');
      }
    } catch { /* malformed; reset */ }
  }
  data.phases.push(row);
  try {
    const dir = ledgerPath.substring(0, ledgerPath.lastIndexOf('/')) || '.';
    mkdirSync(dir, { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch (err) {
    log.warn({ ledgerPath, err: String(err) }, 'failed to write program ledger row');
  }
}

/**
 * Check terminal_states and, if any matches with floor satisfied, commit the
 * terminal status (run.json, campaign entry, run_completed event, summary),
 * auto-append the program ledger row (when applicable), and fire the
 * post_terminate_hook. Every call returns an explicit decision: `matched`
 * carries the committed state, `deferred` names a terminal candidate whose
 * proof is not yet sufficient, and `not_matched` says no declared artifact is
 * currently eligible.
 *
 * This is the SINGLE unified terminal-state gate. It is called at exactly two
 * places (consolidated from the prior 5 scattered call sites):
 *   1. Iteration TOP — catches verdicts written by a PRIOR iteration.
 *   2. EAGER post-batch (inside executeIteration) — catches verdicts written
 *      DURING this iteration's stages, BEFORE a later stage's git hygiene can
 *      delete them (bug #8).
 * Plain completion paths also re-evaluate after repair/re-plan continuations
 * are exhausted. That final decision point turns an unmatched declared
 * terminal contract into an explicit `incomplete` outcome instead of silence
 * or an unrelated plain `complete` status.
 *
 * Detection accepts the project-dir artifact OR a run-dir snapshot (if the
 * project copy was clobbered). Floor-unmet writes a one-time supervisor hint.
 */
/** Terminal program statuses set by the unified terminal-state gate. Once any
 * of these is set, the run is done and the iteration loop must exit without
 * re-processing (prevents double-firing the post_terminate_hook / ledger).
 *
 * GAP-1 fix: this DEFERS to store.ts's isTerminalRunStatus (the single source of
 * truth, TERMINAL_STATUSES) so it returns true for ALL terminal statuses —
 * including `reality_gate_failed` and `failed`, which the prior narrow set
 * OMITTED. That omission let the post-iteration guards (after executeIteration
 * and after the supervisor-REJECT rework loop) fall through on an eager
 * reality_gate_failed / failed, and let the max-iters handler unconditionally
 * clobber an already-terminal status to 'failed'. The narrow set existed only
 * to avoid double-firing the post_terminate_hook — but that hook does NOT run on
 * these branches (it runs only from the unified terminal-state gate), so
 * widening the predicate is safe. Exported for tests. */
export function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && isTerminalRunStatus(status);
}

// A PID alone cannot distinguish two concurrent runWorkflow() calls inside
// one Node process. Track paths claimed by this module so a same-process
// duplicate is rejected, while legacy/in-process callers that pre-created
// scheduler.pid with the current PID can safely transfer that claim here.
const localSchedulerClaims = new Set<string>();

function establishLocalSchedulerClaim(schedulerPidPath: string, runId: string): boolean {
  const claimPath = resolve(schedulerPidPath);
  try {
    writeSchedulerProcessIdentity(dirname(claimPath), runId);
    localSchedulerClaims.add(claimPath);
    return true;
  } catch {
    try {
      if (readFileSync(schedulerPidPath, 'utf-8').trim() === String(process.pid)) {
        unlinkSync(schedulerPidPath);
      }
    } catch { /* absent or replaced */ }
    removeSchedulerProcessIdentity(dirname(claimPath), process.pid);
    return false;
  }
}

function claimSchedulerPid(schedulerPidPath: string, runId: string): boolean {
  const claimPath = resolve(schedulerPidPath);
  const runPath = dirname(claimPath);
  if (localSchedulerClaims.has(claimPath)) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(schedulerPidPath, String(process.pid), { encoding: 'utf-8', flag: 'wx' });
      return establishLocalSchedulerClaim(schedulerPidPath, runId);
    } catch {
      let owner: number | null = null;
      try { owner = parseSchedulerPidMarker(readFileSync(schedulerPidPath, 'utf-8')); } catch { /* missing again */ }
      if (owner === process.pid) {
        return establishLocalSchedulerClaim(schedulerPidPath, runId);
      }
      if (owner !== null && isLiveFlowcrewSchedulerForRun(owner, runId, runPath)) return false;
      try { unlinkSync(schedulerPidPath); } catch { return false; }
      removeSchedulerProcessIdentity(runPath);
    }
  }
  return false;
}

function removeSchedulerPidIfOwned(schedulerPidPath: string): void {
  localSchedulerClaims.delete(resolve(schedulerPidPath));
  try {
    if (readFileSync(schedulerPidPath, 'utf-8').trim() === String(process.pid)) {
      unlinkSync(schedulerPidPath);
      removeSchedulerProcessIdentity(dirname(resolve(schedulerPidPath)), process.pid);
    }
  } catch { /* already removed or replaced by a newer owner */ }
}

interface ApprovalRequestSource {
  path: string;
  stageId?: string;
}

/**
 * Stable multi-request scan. The root file remains supported for old briefs;
 * new stages get an isolated slot at stages/<stageId>/approval_request.json.
 * Named root slots are accepted as an additional compatibility path.
 */
function approvalRequestSources(runDirPath: string): ApprovalRequestSource[] {
  const sources: ApprovalRequestSource[] = [];
  try {
    for (const name of readdirSync(runDirPath).sort()) {
      if (name === APPROVAL_REQUEST_FILE || /^approval_request[._-][A-Za-z0-9._-]+\.json$/.test(name)) {
        sources.push({ path: join(runDirPath, name) });
      }
    }
  } catch { /* run directory disappeared */ }

  const stagesPath = join(runDirPath, 'stages');
  try {
    for (const entry of readdirSync(stagesPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const path = join(stagesPath, entry.name, APPROVAL_REQUEST_FILE);
      if (existsSync(path)) sources.push({ path, stageId: entry.name });
    }
  } catch { /* no stages directory */ }
  return sources;
}

function archiveApprovalRequest(runDirPath: string, sourcePath: string, requestId: string): void {
  const target = approvalArtifactPath(runDirPath, requestId, 'request');
  mkdirSync(join(runDirPath, APPROVALS_DIR), { recursive: true });
  if (existsSync(target)) {
    // Keep the first audit copy, matching the append log's first-request-wins
    // arbitration, and merely consume a duplicate slot.
    if (sourcePath !== target) unlinkSync(sourcePath);
    return;
  }
  renameSync(sourcePath, target);
}

/**
 * Approval park gate — the engine-side half of the approval inbox.
 *
 * The agent↔engine contract is a FILE, like every other one in this engine
 * (dispatch.yaml, round_result.json, terminal artifacts): a stage writes its
 * isolated `<run_dir>/stages/<stageId>/approval_request.json` slot containing
 * {id, action, target?, risk?, title, body?}. The legacy root slot remains
 * readable. This function ingests every slot and then either
 *   (a) auto-approves it, when a standing rule already authorizes exactly this
 *       action→target for this project (rules are only mintable for
 *       external-risk targeted actions), or
 *   (b) PARKS the run: status='parked', request recorded durably in the inbox,
 *       and the caller returns so the process exits — freeing the project lock
 *       and the daemon queue slot while a human decides.
 *
 * Idempotent by (runId, requestId): re-ingesting the same request appends
 * nothing, so a resumed run that still sees the file cannot double-create it.
 * The request file is consumed (moved under approvals/) once recorded, and the
 * decision is written back beside it for the resumed agent to read.
 *
 * Returns the parked state, or null when there is nothing to park on.
 */
async function tryParkOnApprovalRequest(
  state: StoreState,
  ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number },
): Promise<StoreState | null> {
  // Ingestion is deliberately separate from choosing which request parks the
  // run: parallel stages may produce several slots in one batch, and all must
  // reach the append-only inbox before the first pending item suspends us.
  for (const source of approvalRequestSources(ctx.runDirPath)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(source.path, 'utf-8')); } catch {
      log.warn({ runId: ctx.runId, reqPath: source.path }, 'approval request is not valid JSON — ignoring');
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn({ runId: ctx.runId, reqPath: source.path }, 'approval request is not a JSON object — ignoring');
      continue;
    }
    const raw = parsed as {
      id?: unknown;
      requestId?: unknown;
      action?: unknown;
      target?: unknown;
      risk?: unknown;
      title?: unknown;
      body?: unknown;
      stageId?: unknown;
    };
    const requestIdRaw = typeof raw.requestId === 'string' ? raw.requestId : typeof raw.id === 'string' ? raw.id : '';
    const requestId = requestIdRaw.trim();
    const action = typeof raw.action === 'string' ? raw.action.trim() : '';
    if (!requestId || !action) {
      log.warn({ runId: ctx.runId, reqPath: source.path }, 'approval request needs at least {id, action} — ignoring');
      continue;
    }
    if (!isValidApprovalRequestId(requestId)) {
      log.warn({ runId: ctx.runId, requestId, reqPath: source.path }, 'unsafe approval request id — rejecting artifact');
      continue;
    }
    const target = typeof raw.target === 'string' && raw.target.trim() ? raw.target.trim() : undefined;
    const risk: ApprovalRisk = raw.risk === 'external' || raw.risk === 'exec' || raw.risk === 'write' ? raw.risk : 'unknown';
    const stageId = typeof raw.stageId === 'string' && raw.stageId.trim() ? raw.stageId.trim() : source.stageId;
    const req = {
      runId: ctx.runId,
      projectDir: ctx.projectDir,
      requestId,
      action,
      ...(target ? { target } : {}),
      risk,
      title: typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim()
        : `${action}${target ? ` → ${target}` : ''}`,
      ...(typeof raw.body === 'string' && raw.body ? { body: raw.body } : {}),
      createdAt: new Date().toISOString(),
      atIteration: ctx.iteration,
      ...(stageId ? { stageId } : {}),
    };
    try {
      recordRequest(req);
      archiveApprovalRequest(ctx.runDirPath, source.path, requestId);
    } catch (err) {
      log.warn({ runId: ctx.runId, requestId, reqPath: source.path, err }, 'failed to ingest approval request');
    }
  }

  // Resolve every rule-covered request and materialize every settled decision
  // before selecting the first still-pending item.
  let items = [...foldItems(ctx.runId).values()];
  for (const item of items) {
    if (!isValidApprovalRequestId(item.requestId)) {
      log.warn({ runId: ctx.runId, requestId: item.requestId }, 'unsafe stored approval request id — ignoring');
      continue;
    }
    if (isPendingInboxItemState(item.state)) {
      const rule = matchStandingRule(item);
      if (rule) {
        const resolution = resolveRequest(ctx.projectDir, ctx.runId, item.requestId, 'approve', {
          by: 'standing-rule',
          viaRule: `${rule.action}→${rule.target}`,
        });
        if (resolution.won) {
          recordRunEvent(ctx.projectDir, ctx.runId, {
            type: 'approval_resolved',
            runId: ctx.runId,
            timestamp: new Date().toISOString(),
            iteration: ctx.iteration,
            detail: `auto-approved ${item.action}${item.target ? ` → ${item.target}` : ''} via standing rule (${item.requestId})`,
          });
          log.info({ runId: ctx.runId, requestId: item.requestId, rule: `${rule.action}→${rule.target}` }, 'Approval auto-granted by standing rule');
        }
      }
    }
  }
  items = [...foldItems(ctx.runId).values()];
  for (const item of items) {
    if (!isValidApprovalRequestId(item.requestId) || isPendingInboxItemState(item.state)) continue;
    writeApprovalDecision(
      ctx.runDirPath,
      item.requestId,
      item.state === INBOX_ITEM_STATE.APPROVED ? 'approve' : 'deny',
      item.resolution?.reason,
    );
  }
  const item = items
    .filter((candidate) => isPendingInboxItemState(candidate.state) && isValidApprovalRequestId(candidate.requestId))
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      const byTime = (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
      return byTime || a.requestId.localeCompare(b.requestId);
    })[0];
  if (!item) return null;
  const { requestId, action } = item;

  // ---- park ----
  // The requesting stage must NOT be left 'running': findAllReady only picks
  // 'pending', so a stage frozen mid-flight can never be re-dispatched and the
  // resumed iteration would fall through to the re-plan boundary that deletes
  // dispatch.yaml — losing the DAG this park exists to preserve.
  for (const [stageId, st] of Object.entries(state.stages)) {
    if (isRunningStageStatus(st.status)) {
      st.status = STAGE_STATUS.COMPLETE;
      st.completedAt = new Date().toISOString();
      log.info({ runId: ctx.runId, stageId }, 'Normalizing in-flight stage to complete for park');
    }
  }
  const pausedAt = new Date().toISOString();
  state.status = RUN_STATUS.PARKED;
  state.parked = {
    requestId, action,
    ...(item.target ? { target: item.target } : {}),
    reason: item.title,
    atIteration: ctx.iteration,
    ...(item.stageId ? { stageId: item.stageId } : {}),
    requestedAt: item.createdAt,
    pausedAt,
  };
  // Deliberately NO completedAt: that field is what every reader treats as
  // "this run finished".
  writeRunState(ctx.projectDir, ctx.runId, state);
  writeCampaignEntryUnlessPaused(ctx.projectDir, state);
  recordRunEvent(ctx.projectDir, ctx.runId, {
    type: 'approval_parked', runId: ctx.runId, timestamp: pausedAt, iteration: ctx.iteration,
    detail: `${action}${item.target ? ` → ${item.target}` : ''} awaiting approval (${requestId})`,
  });
  appendApprovalGuidance(ctx.runDirPath, requestId, item.title);
  log.warn({ runId: ctx.runId, requestId, action, target: item.target },
    'PARKED awaiting human approval — resolve with `flowcrew inbox approve <requestId>`');
  return state;
}

/** The agent-readable decision record, written beside the consumed request. */
function writeApprovalDecision(runDirPath: string, requestId: string, decision: 'approve' | 'deny', reason?: string): void {
  try {
    const target = approvalArtifactPath(runDirPath, requestId, 'decision');
    mkdirSync(join(runDirPath, APPROVALS_DIR), { recursive: true });
    writeFileSync(target,
      JSON.stringify({ requestId, decision, reason: reason ?? '', at: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
  } catch (err) {
    log.warn({ requestId, err }, 'failed to write approval decision artifact');
  }
}

/**
 * Pin the approval outcome where the resumed agent will actually see it.
 * supervisor_guidance.md is rotated per iteration and re-injected only for the
 * planner, so the durable copy lives in approvals/<id>.decision.json (above)
 * and this note is the human-readable breadcrumb.
 */
function appendApprovalGuidance(runDirPath: string, requestId: string, title: string): void {
  appendSchedulerGuidanceOnce(
    runDirPath,
    RUN_WIDE_GUIDANCE_TARGET,
    `[approval-parked:${requestId}]`,
    `This run PARKED awaiting human approval for: ${title}.\n`
      + `When you resume, read approvals/${requestId}.decision.json FIRST. If decision is "deny", do NOT perform the action — `
      + 'record the denial and continue with the remaining work (or write an honest terminal artifact explaining what the denial blocks).',
  );
}

/** Append a scheduler-authored instruction to the immutable audit ledger once.
 * Every instruction carries an explicit target; the run-wide target is a
 * deliberate broadcast rather than an unaddressed legacy entry. */
function appendSchedulerGuidanceOnce(
  runDirPath: string,
  target: string,
  marker: string,
  body: string,
  knownStageIds: readonly string[] = [],
): void {
  try {
    const ledgerPath = join(runDirPath, 'supervisor_guidance.md');
    const prior = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf-8') : '';
    if (prior.includes(marker)) return;
    appendGuidanceEnvelope({
      runDir: runDirPath,
      target,
      source: 'scheduler',
      body: `${marker}\n${body}`,
      knownStageIds,
    });
  } catch { /* non-critical */ }
}

function observeStableBlockage(input: {
  runDirPath: string;
  kind: string;
  detail: string;
  stageId?: string;
  evidenceDigest?: string;
  repairDigest?: string;
  threshold?: number;
}): ReturnType<typeof recordBlockageOccurrence> | undefined {
  try {
    const observed = recordBlockageOccurrence({
      runDir: input.runDirPath,
      kind: input.kind,
      detail: input.detail,
      stageId: input.stageId,
      evidenceDigest: input.evidenceDigest,
      repairDigest: input.repairDigest,
      threshold: input.threshold,
    });
    if (!observed.escalatedNow) return observed;
    const signalsDir = join(input.runDirPath, 'signals');
    mkdirSync(signalsDir, { recursive: true });
    writeFileSync(join(signalsDir, 'repeated_blockage.json'), `${JSON.stringify({
      version: 1,
      ...observed.occurrence,
      action: 'escalate',
    }, null, 2)}\n`, 'utf-8');
    appendSchedulerGuidanceOnce(
      input.runDirPath,
      RUN_WIDE_GUIDANCE_TARGET,
      `[repeated-blockage:${observed.occurrence.fingerprint}]`,
      `The same blockage has recurred ${observed.occurrence.consecutive} consecutive times without a state change: ${input.detail}. Stop repeating the same repair. Route the run through its declared escalation/finalizer outcome and name the external change needed.`,
    );
    return observed;
  } catch { /* non-critical */ }
  return undefined;
}

function concludeRepeatedBlockage(
  state: StoreState,
  ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number },
): StoreState | null {
  const signalPath = join(ctx.runDirPath, 'signals', 'repeated_blockage.json');
  if (!existsSync(signalPath)) return null;
  let signal: Record<string, unknown>;
  try {
    signal = JSON.parse(readFileSync(signalPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (signal.action !== 'escalate') return null;
  const detail = typeof signal.detail === 'string' ? signal.detail : 'unchanged structured blockage';
  const consecutive = typeof signal.consecutive === 'number' ? signal.consecutive : 3;
  const stageId = typeof signal.stageId === 'string' ? signal.stageId : undefined;
  const reason = `Escalated after ${consecutive} consecutive observations of the same blockage${stageId ? ` at ${stageId}` : ''}: ${detail}. A different repair/evidence state or external intervention is required.`;
  state.status = RUN_STATUS.ESCALATED;
  state.failureReason = reason;
  state.completedAt = new Date().toISOString();
  markLeftoverStagesSkipped(state, reason);
  const escalationPath = state.terminalStates?.[RUN_STATUS.ESCALATED]?.paths?.[0];
  const terminalOwner = escalationPath ? admittedTerminalOwner(ctx.runDirPath, escalationPath) : undefined;
  if (terminalOwner) {
    appendSchedulerGuidanceOnce(
      ctx.runDirPath,
      terminalOwner,
      `[repeated-blockage-final:${String(signal.fingerprint ?? 'unknown')}]`,
      `${reason} The run has stopped; any resumption must write only the declared escalation evidence at ${escalationPath}.`,
      Object.keys(state.stages),
    );
  }
  writeRunState(ctx.projectDir, ctx.runId, state);
  writeCampaignEntry(ctx.projectDir, state);
  recordRunEvent(ctx.projectDir, ctx.runId, {
    type: 'run_completed',
    runId: ctx.runId,
    timestamp: state.completedAt,
    iteration: ctx.iteration,
    ...(stageId ? { stageId } : {}),
    detail: reason,
  });
  return state;
}

function appendApprovalRequestContract(prompt: string, runDirPath: string, stageId: string): string {
  return `${prompt}\n\nApproval artifact contract: if this stage needs human authorization before a consequential action, `
    + `write exactly one JSON request ({id, action, target?, risk?, title?, body?}) to `
    + `${join(runDirPath, 'stages', stageId, APPROVAL_REQUEST_FILE)} and stop before performing the action. `
    + `Each stage has its own slot so parallel requests are not overwritten.`;
}

const SCOPE_REVISION_REQUEST_FILE = 'scope_revision_request.json';

function appendScopeRevisionContract(
  prompt: string,
  runDirPath: string,
  runId: string,
  stage: StageConfig,
): string {
  const declaredScope = stage.scope ?? [];
  const scopePresence = stage.scope === undefined ? 'missing' : 'present';
  const gateIsolation = stage.is_gate
    ? ' Gate project writes remain subject to isolation policy; if rejected, use a planner-predeclared path in a later iteration or an OS temporary probe lane.'
    : '';
  return `${prompt}\n\nDeclared project-write scope: ${JSON.stringify(declaredScope)} (declaration ${scopePresence}). `
    + `A missing declaration is closed, never allow-all. Before any project write outside this initial capability, produce `
    + `exactly one JSON request to ${join(runDirPath, 'stages', stage.id, SCOPE_REVISION_REQUEST_FILE)} `
    + `with {"version":1,"kind":"scope_revision","requestId":"<unique id>","runId":"${runId}","stageId":"${stage.id}",`
    + `"attemptIndex":<current attempt>,"requestedPaths":["path"],"pathDigest":"<sha256 of the canonical requestedPaths set>",`
    + `"reason":"<why the declared work requires it>"}. The scheduler canonicalizes and verifies the run/stage/attempt/path binding. `
    + `Wait for a scope_revision_decision_*.json file with the same requestId. Write the new path only when accepted; `
    + `a rejection is an auditable request to stop or re-plan, not permission to bypass scope with casts or indirection.`
    + gateIsolation;
}

function appendAttemptDeadlineContract(
  prompt: string,
  attemptBudgetMs: number,
): string {
  return `${prompt}\n\nRuntime timeout contract: this attempt has an immutable ${attemptBudgetMs}ms deadline. `
    + `The base stage timeout comes only from config/defaults.yaml::default_timeout_ms. Adapter retries, backoff, `
    + `fallback loading, and fallback execution all consume this same attempt deadline; runtime extension requests `
    + `are rejected and cannot move it. If this attempt times out and a configured technical retry remains, the next `
    + `attempt receives a strictly larger derived budget. A current-attempt supervisor ABORT remains authoritative.`;
}

function appendGateConstraintAuditContext(
  prompt: string,
  stage: StageConfig,
  allStages: StageConfig[],
  state: StoreState,
  runDirPath: string,
): string {
  if (!stage.is_gate) return prompt;
  const byId = new Map(allStages.map((candidate) => [candidate.id, candidate]));
  const closure = new Set<string>();
  const queue = [...(stage.depends_on ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    closure.add(id);
    queue.push(...(byId.get(id)?.depends_on ?? []));
  }
  const rows = [...closure].flatMap((id) => {
    const status = state.stages[id];
    return (status?.attempts ?? []).flatMap((attempt) => {
      if (!attempt.constraintAudit) return [];
      const summary = attempt.constraintAudit;
      return [`- ${id} attempt ${attempt.index}: ${join(runDirPath, summary.path)} `
        + `(accepted=${summary.acceptedRevisionCount}, rejected=${summary.rejectedRevisionCount}, `
        + `mismatch=${summary.mismatchCount}, violations=${summary.violationCount}, unverified=${summary.unverifiedCount})`];
    });
  });
  if (rows.length === 0) return prompt;
  return `${prompt}\n\n# Runtime Constraint Audits\nRead these dependency-closure audits as gate evidence:\n${rows.join('\n')}`;
}

/**
 * Campaign ledger rows carry pass/fail + live status and feed the
 * regression/plateau/repeated-failure heuristics. A paused run has no outcome
 * to score, so parking must not append a row.
 */
function writeCampaignEntryUnlessPaused(projectDir: string, state: StoreState): void {
  if (isPausedRunStatus(state.status)) return;
  writeCampaignEntry(projectDir, state);
}

interface TerminalEvaluationContext {
  projectDir: string;
  runId: string;
  runDirPath: string;
  iteration: number;
  adapter: Adapter;
}

type TerminalEvaluation =
  | { decision: 'matched'; state: StoreState; reasons: string[] }
  | { decision: 'deferred' | 'not_matched'; reasons: string[] };

function admittedTerminalOwner(runDirPath: string, terminalPath: string): string | undefined {
  try {
    const admission = JSON.parse(readFileSync(join(runDirPath, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
    return admission.pass ? admission.terminalOwners[terminalPath] : undefined;
  } catch {
    return undefined;
  }
}

function stageAttemptWroteProjectPath(
  projectDir: string,
  status: StageStatus | undefined,
  terminalPath: string,
): boolean {
  if (status?.status !== STAGE_STATUS.COMPLETE) return false;
  const attempt = status.attempts?.at(-1);
  const writes = attempt?.writes ?? status.writes ?? status.artifacts ?? [];
  const wanted = posix.normalize(terminalPath.replace(/\\/g, '/'));
  return writes.some((raw) => {
    const normalized = raw.replace(/\\/g, '/');
    const projectRelative = isAbsolute(normalized)
      ? relative(projectDir, normalized).replace(/\\/g, '/')
      : normalized.replace(/^\.\//, '');
    return posix.normalize(projectRelative) === wanted;
  });
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

export async function tryTerminateOnTerminalState(
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
        const sources = [projectPath, snapshotPath].filter((candidate) => {
          try {
            return existsSync(candidate)
              && Number.isFinite(startedAtMs)
              && statSync(candidate).mtimeMs >= startedAtMs;
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
      if (ownerIds.length === 1 && state.stages[ownerIds[0]]) {
        state.stages[ownerIds[0]] = rependStageStatus(state.stages[ownerIds[0]], 0);
        writeStageStatus(ctx.projectDir, ctx.runId, ownerIds[0], state.stages[ownerIds[0]]);
        appendSchedulerGuidanceOnce(
          ctx.runDirPath,
          ownerIds[0],
          `[ambiguous-terminal:${blockage?.occurrence.fingerprint ?? 'unknown'}]`,
          `Terminal output rejected: ${detail}. Choose the single path matching the outcome that actually happened and write only that path.`,
          Object.keys(state.stages),
        );
        writeRunState(ctx.projectDir, ctx.runId, state);
      }
      return { decision: 'deferred', reasons: [detail] };
    }
  }
  for (const [terminalStatus, entry] of Object.entries(state.terminalStates)) {
    for (const path of entry.paths) {
      // Detect the artifact at its project path, OR — if a prior detection
      // already snapshotted it to the run dir but the project copy was later
      // clobbered (bug #8: agent git hygiene) — fall back to the snapshot so
      // the run-dir copy is the authoritative control-plane source.
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
      const source = Number.isFinite(startedAtMs)
        ? candidates.find((candidate) => candidate.mtimeMs >= startedAtMs)
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
      const admittedOwner = admittedTerminalOwner(ctx.runDirPath, path);
      if (admittedOwner && !stageAttemptWroteProjectPath(ctx.projectDir, state.stages[admittedOwner], path)) {
        const marker = `[scheduler-hint:${terminalStatus}:${path}:owner]`;
        const reason = `${path} is owned by terminal stage '${admittedOwner}', but that stage has no completed-attempt write attribution for the path`;
        appendSchedulerGuidanceOnce(
          ctx.runDirPath,
          admittedOwner,
          marker,
          `Terminal artifact rejected: ${reason}. The owner must run after its declared ancestors and write the terminal path itself.`,
          Object.keys(state.stages),
        );
        log.warn({ runId: ctx.runId, terminalStatus, path, admittedOwner }, 'Terminal-state file rejected because its admitted owner did not produce it');
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
      // Research floors count settled research rounds. Reapplying the generic
      // file-glob floor after the admitted finalizer writes would impose a
      // second, different contract (`stage_*_verdict.md`) that the research
      // policy never emitted and can make an already-settled ceiling impossible.
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
        // Floor unmet — don't terminate. Write a one-time hint to
        // supervisor_guidance.md so the NEXT iteration sees a clear directive,
        // and log loudly so this isn't a silent "run completed without firing
        // hook" mystery (cf. Phase D bug #5, misplaced stage_glob).
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
      // Engine hole #5 (found by the engine-fix validation campaign): the research-loop
      // ship path runs the brief-declared confirm gate, but an agent could bypass it
      // entirely by writing the shipped terminal FILE directly — this gate would commit
      // 'shipped' without confirm ever running. Verify-before-trust must hold on both
      // doors: a 'shipped' terminal file on a research run must pass the same confirm
      // command; on failure the file is rejected (run continues), like the floor path.
      if (terminalStatus === RUN_STATUS.SHIPPED && state.research?.confirm) {
        let confirmReport: { pass: boolean; results: Array<{ details: string }> };
        try {
          confirmReport = await runAllChecks(
            [{ name: 'research_confirm', type: 'exec-script-exit-zero', params: { script: state.research.confirm.command, timeout_seconds: state.research.confirm.timeoutSeconds ?? 300 } }],
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
      state.status = terminalStatus as StoreState['status'];
      state.terminalArtifact = path.split('/').pop();
      state.completedAt = new Date().toISOString();
      markLeftoverStagesSkipped(state, `terminal state '${terminalStatus}' reached before this stage ran`);
      // Bug #8 defense: snapshot the terminal artifact into the run dir
      // immediately. The artifact lives in the project's git tree, which the
      // agent also manipulates (a fix-stage `git clean`/hygiene op deleted a
      // phase verdict between stages in Phase I). The run-dir copy is outside
      // the agent's reach and preserves an audit trail even if the project
      // copy is later clobbered.
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

/**
 * A declared terminal contract owns the final conclusion once the DAG has no
 * transition left. Matching still wins; otherwise persist why the scheduler
 * could not select a declared terminal instead of falling through to a plain
 * completion or leaving the run `running`.
 */
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

/**
 * Research-mode advance gate. When `state.research` is set, the agent writes
 * each round's measured result to a JSON file ({ label, result }); the
 * FRAMEWORK reads it, journals it (framework-owned in the run dir — outside the
 * agent's git tree, so bug #8 can't touch it), computes the keep/drop +
 * continue/ship/ceiling decision via evaluateResearch (NOT a prose decision
 * table the agent writes), and acts:
 *   - ship       → status='shipped',     write program_ship_report,    terminate
 *   - stop_ceiling → status='ceiling_hit', write program_ceiling_report, terminate
 *   - continue   → write a guidance hint with running-best + kept set, keep looping
 *
 * Idempotent: a round result is consumed (renamed) after processing so it is
 * not double-counted across iterations.
 *
 * Returns the terminated state on ship/ceiling, else null (continue).
 */
/** Dedicated cap for integrity-gate rejections, independent of the research round
 * budget (rc.stop.maxRounds) so a run can't ceiling "by being right". */
const INTEGRITY_REJECTION_CEILING = 30;

export async function tryAdvanceResearch(
  state: StoreState,
  ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number; adapter: Adapter },
): Promise<StoreState | null> {
  const rc = state.research;
  if (!rc) return null;
  const resultRel = rc.resultFile ?? 'docs/research_round_result.json';
  const resultAbs = join(ctx.projectDir, resultRel);
  const noCandidateAbs = `${resultAbs}.no_candidate.json`;
  // Only count a result file freshly written during this run. A result_file
  // left over from a previous run (e.g. on relaunch) would otherwise be
  // journaled as round 1 with ~0 wall time, burning a no-improvement slot
  // before the agent does any new work and forcing a premature ceiling.
  const startedMs = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
  const fresh = (path: string): boolean => {
    try { return existsSync(path) && statSync(path).mtimeMs >= startedMs; } catch { return false; }
  };
  const freshResult = fresh(resultAbs);
  const freshNoCandidate = fresh(noCandidateAbs);
  if (!freshResult && !freshNoCandidate) return null;
  const digestSources = (paths: readonly string[]): string => {
    const hash = createHash('sha256');
    for (const path of [...paths].sort()) {
      hash.update(path === resultAbs ? resultRel : `${resultRel}.no_candidate.json`, 'utf8');
      try { hash.update(readFileSync(path)); } catch { hash.update('<unreadable>', 'utf8'); }
    }
    return hash.digest('hex');
  };
  const rejectRoundInput = (kind: string, detail: string, sources: readonly string[]): null => {
    const evidenceDigest = digestSources(sources);
    try {
      writeFileSync(join(ctx.runDirPath, 'research_round_input_error.json'), `${JSON.stringify({
        error: detail,
        kind,
        resultFile: resultRel,
        noCandidateFile: `${resultRel}.no_candidate.json`,
        evidenceDigest,
      }, null, 2)}\n`, 'utf-8');
    } catch { /* non-critical */ }
    observeStableBlockage({
      runDirPath: ctx.runDirPath,
      kind: 'research_round_input',
      detail: kind,
      evidenceDigest,
      threshold: state.campaignTriggers?.repeatedFailureAfter,
    });
    appendSchedulerGuidanceOnce(
      ctx.runDirPath,
      RUN_WIDE_GUIDANCE_TARGET,
      `[research-round-input:${kind}:${evidenceDigest}]`,
      `${detail} Correct or replace the named round artifact; the framework will not invent missing fields or silently choose between conflicting files.`,
    );
    return null;
  };
  if (freshResult && freshNoCandidate) {
    return rejectRoundInput(
      'ambiguous_measured_and_no_candidate',
      'Ambiguous research round: both the measured result and no-candidate sidecar are fresh.',
      [resultAbs, noCandidateAbs],
    );
  }
  const sourceAbs = freshNoCandidate ? noCandidateAbs : resultAbs;
  let round: { label?: string; result?: number; outcome?: string; reason?: string; evidence?: unknown };
  try {
    round = JSON.parse(readFileSync(sourceAbs, 'utf-8'));
  } catch {
    return rejectRoundInput('malformed_json', `Research round artifact ${sourceAbs} is not valid JSON.`, [sourceAbs]);
  }
  const noCandidate = freshNoCandidate;
  if (typeof round.label !== 'string' || !round.label.trim()) {
    return rejectRoundInput('missing_label', 'Research round artifacts require a non-empty string label.', [sourceAbs]);
  }
  if (noCandidate) {
    if (round.outcome !== 'no_candidate' || typeof round.reason !== 'string' || !round.reason.trim()) {
      return rejectRoundInput(
        'invalid_no_candidate_shape',
        'The no-candidate sidecar requires outcome="no_candidate", a non-empty label, and a non-empty reason.',
        [sourceAbs],
      );
    }
  } else if (typeof round.result !== 'number' || !Number.isFinite(round.result)) {
    return rejectRoundInput('invalid_measured_result', 'A measured research result requires a finite numeric result.', [sourceAbs]);
  }
  const measuredResult = noCandidate ? undefined : round.result;
  const sourceEvidenceDigest = digestSources([sourceAbs]);

  // Journal lives in the run dir (framework-owned, agent-unreachable).
  const journalPath = join(ctx.runDirPath, 'research_journal.json');
  const journal: { rounds: ResearchRound[] } = { rounds: [] };
  if (existsSync(journalPath)) {
    try {
      const parsed = JSON.parse(readFileSync(journalPath, 'utf-8'));
      if (parsed && Array.isArray(parsed.rounds)) journal.rounds = parsed.rounds;
    } catch { /* reset on corruption */ }
  }
  const label = round.label.trim();
  // A shared latest-result path is mutable, but journal labels are immutable
  // round identities. Re-submitting an already-journaled identity is a stable
  // blockage, not another budget-consuming round.
  const duplicate = journal.rounds.some((r) => r.label === label);
  if (duplicate) {
    observeStableBlockage({
      runDirPath: ctx.runDirPath,
      kind: 'research_round_duplicate',
      detail: `duplicate research round label ${label}`,
      evidenceDigest: sourceEvidenceDigest,
      threshold: state.campaignTriggers?.repeatedFailureAfter,
    });
    appendSchedulerGuidanceOnce(
      ctx.runDirPath,
      RUN_WIDE_GUIDANCE_TARGET,
      `[research-round-duplicate:${label}]`,
      `Research round label ${JSON.stringify(label)} is already journaled and is an immutable identity. Use a fresh label for a genuinely new measurement; do not rewrite an earlier round by changing the shared result file.`,
    );
    return null;
  }

  // Integrity gates — reject rounds that look like no-ops / noise / overflow before
  // they pollute the journal. DOMAIN-AGNOSTIC: the engine has NO built-in field or
  // threshold knowledge. Generic gates (no-op / cross-run variance / outlier cap)
  // apply with defaults; any domain-specific gate (e.g. a trading floor on a custom
  // field) is declared in the brief's `research.integrity` block and applied generically.
  //
  // Gates evaluated in order:
  //   #1 no-op            (result == baseline within tolerance)      — generic
  //   #2 variance         (result_std/|mean| > maxStdRatio)          — generic, default 0.30
  //   #3 field floors     (round[field] < min, per brief)            — brief-declared
  //   #4 reject-if-positive (round[field] > 0, per brief)            — brief-declared
  //   #5 outlier          (beyond outlierFactor× baseline, directional) — generic, default 5
  //
  // Each gate is "soft": absent field / disabled config → gate doesn't fire.
  const rejectGate = async (reason: string, message: string): Promise<StoreState | null> => {
    const rejPath = join(ctx.runDirPath, 'research_integrity_rejections.json');
    let rejData: Record<string, number> = {};
    if (existsSync(rejPath)) { try { rejData = JSON.parse(readFileSync(rejPath, 'utf-8')); } catch { /* reset */ } }
    rejData[reason] = (rejData[reason] || 0) + 1;
    const totalRej = Object.values(rejData).reduce((s, n) => s + (n || 0), 0);
    try { writeFileSync(rejPath, JSON.stringify(rejData, null, 2), 'utf-8'); } catch { /* non-critical */ }
    observeStableBlockage({
      runDirPath: ctx.runDirPath,
      kind: 'research_integrity',
      detail: `research integrity rejection: ${reason}`,
      evidenceDigest: sourceEvidenceDigest,
      threshold: state.campaignTriggers?.repeatedFailureAfter,
    });
    try { unlinkSync(sourceAbs); } catch { /* non-critical */ }
    appendSchedulerGuidanceOnce(
      ctx.runDirPath,
      RUN_WIDE_GUIDANCE_TARGET,
      `[research-integrity:${reason}:${label}=${measuredResult}]`,
      message,
    );
    log.warn({ runId: ctx.runId, reason, label, result: measuredResult, total_rejections: totalRej }, 'Research round rejected by integrity gate');
    // Integrity-rejection budget is SEPARATE from the research round budget
    // (rc.stop.maxRounds): a run shouldn't hit "ceiling" at the same count as
    // legitimate journaled rounds just because some results tripped a gate — that
    // would let a run terminate "by being right". Use a dedicated, independent cap.
    const maxRej = Math.max(rc.stop?.maxRounds ?? 24, INTEGRITY_REJECTION_CEILING);
    if (totalRej >= maxRej) {
      const terminalPath = state.terminalStates?.[RUN_STATUS.CEILING_HIT]?.paths?.[0];
      const terminalOwner = terminalPath
        ? admittedTerminalOwner(ctx.runDirPath, terminalPath)
        : undefined;
      if (terminalPath && terminalOwner) {
        const terminalReason = `Research ceiling: ${totalRej} integrity-gate rejections (reasons: ${Object.keys(rejData).join(',')})`;
        writeFileSync(join(ctx.runDirPath, 'research_decision.json'), `${JSON.stringify({
          version: 1,
          decision: 'stop_ceiling',
          terminalStatus: RUN_STATUS.CEILING_HIT,
          terminalPath,
          terminalOwner,
          reason: terminalReason,
          integrityRejectionCeiling: true,
        }, null, 2)}\n`, 'utf-8');
        mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
        writeFileSync(join(ctx.runDirPath, 'signals', 'research_terminal_ready.json'), `${JSON.stringify({
          version: 1,
          decision: 'stop_ceiling',
          terminalStatus: RUN_STATUS.CEILING_HIT,
          terminalPath,
          terminalOwner,
          reason: terminalReason,
        }, null, 2)}\n`, 'utf-8');
        appendSchedulerGuidanceOnce(
          ctx.runDirPath,
          terminalOwner,
          `[research-terminal-ready:integrity-${totalRej}]`,
          `The mechanically settled research decision is stop_ceiling after ${totalRej} integrity rejections. Read research_decision.json and write exactly ${terminalPath}; do not write any other terminal path.`,
          Object.keys(state.stages),
        );
        recordConfirmNotRun(ctx.runDirPath, rc.confirm, RUN_STATUS.CEILING_HIT);
        return null;
      }
      state.status = 'ceiling_hit';
      // FIX D — non-ship terminal: record any brief-declared confirm as not-run (observability).
      recordConfirmNotRun(ctx.runDirPath, rc.confirm, state.status);
      state.completedAt = new Date().toISOString();
      const gate = await enforceRealityGateBeforeTerminal(ctx.projectDir, ctx.runId, state, state.status);
      // GAP-1: the reality-gate may downgrade to `reality_gate_failed`. That is a
      // TERMINAL status the outer loop must see — write a campaign jsonl row on
      // this eager branch too, else the run silently returns reality_gate_failed
      // with no campaign envelope.
      if (!gate.allowed) { writeCampaignEntry(ctx.projectDir, gate.state); return gate.state; }
      writeRunState(ctx.projectDir, ctx.runId, state);
      writeCampaignEntry(ctx.projectDir, state);
      recordRunEvent(ctx.projectDir, ctx.runId, { type: 'run_completed', runId: ctx.runId, timestamp: state.completedAt, iteration: ctx.iteration, detail: `Research ceiling: ${totalRej} integrity-gate rejections (reasons: ${Object.keys(rejData).join(',')})` });
      await generateRunSummary(ctx.projectDir, ctx.runId, ctx.adapter).catch(() => { /* non-critical */ });
      return state;
    }
    try {
      mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
      writeFileSync(join(ctx.runDirPath, 'signals', 'research_continue.json'), JSON.stringify({ round: journal.rounds.length, runningBest: rc.baseline, timestamp: new Date().toISOString(), rejected_reason: reason, rejected_label: label }), 'utf-8');
    } catch { /* non-critical */ }
    return null;
  };

  const ig = rc.integrity;
  const roundFields = round as Record<string, unknown>;

  // Gate #0: output-contract — round_result must match the brief's declared research.result_schema.
  // Single-sourced: the SAME schema is injected to the planner ({result_schema}); the engine treats
  // it as an opaque JSON Schema. This is what stops plan-time checks and execute-time output drifting.
  if (rc.resultSchema && !noCandidate) {
    const schemaErrs = validateResultSchema(round, rc.resultSchema, '$');
    if (schemaErrs.length) {
      return rejectGate('schema_mismatch',
        `Rejected '${label}': round_result violates the brief-declared research.result_schema — ${schemaErrs.slice(0, 5).join('; ')}. Write EXACTLY the declared fields (don't invent or omit), then re-measure.`);
    }
  }

  // Gate #1: no-op (result == baseline within tolerance) — generic; on unless disabled.
  if (ig?.noop !== false && !noCandidate) {
    const noopEps = Math.max(1e-4, Math.abs(rc.baseline) * 1e-5);
    if (Math.abs(measuredResult! - rc.baseline) <= noopEps) {
      return rejectGate('noop',
        `Rejected '${label}' = ${measuredResult}: equals baseline (${rc.baseline}) within tolerance — the change did nothing (no-op/proxy). Implement a direction that genuinely alters behavior and re-measure.`);
    }
  }

  // Gate #2: cross-run variance (result_std/|mean| too high → unstable/lucky). Generic, default 0.30.
  const stdField = (round as { result_std?: number }).result_std;
  const meanReference = measuredResult;  // measured result is the mean by convention
  const maxStdRatio = ig?.maxStdRatio ?? 0.30;
  if (!noCandidate && typeof stdField === 'number' && Math.abs(meanReference!) > 1e-6) {
    const stdRatio = Math.abs(stdField) / Math.abs(meanReference!);
    if (stdRatio > maxStdRatio) {
      const r = await rejectGate('unstable',
        `Rejected '${label}' = ${measuredResult}: result_std/mean = ${stdRatio.toFixed(2)} > ${maxStdRatio} — cross-run variance too high to trust the mean. Reduce variance (more seeds/runs) before reporting.`);
      if (r) return r; else return null;
    }
  }

  // Gate #3: brief-declared numeric floors. The engine knows nothing about the field
  // names; a brief declares e.g. field_floors: { worst_case_score: 50 }.
  for (const [field, min] of Object.entries(noCandidate ? {} : (ig?.fieldFloors ?? {}))) {
    const v = roundFields[field];
    if (typeof v === 'number' && v < min) {
      const r = await rejectGate(`field_floor_${field}`,
        `Rejected '${label}' = ${measuredResult}: ${field} = ${v} < ${min} (brief-declared floor).`);
      if (r) return r; else return null;
    }
  }

  // Gate #4: brief-declared "must be zero" fields, e.g. reject_if_positive: [failure_count].
  for (const field of noCandidate ? [] : (ig?.rejectIfPositive ?? [])) {
    const v = roundFields[field];
    if (typeof v === 'number' && v > 0) {
      const r = await rejectGate(`nonzero_${field}`,
        `Rejected '${label}' = ${measuredResult}: ${field} = ${v} > 0 (brief mandates 0 for this field).`);
      if (r) return r; else return null;
    }
  }

  // Gate #5: outlier cap (implausible improvement). Generic, default factor 5.
  //   (a) baseline ≈ 0 → a relative ceiling is undefined; skip (else it rejects everything).
  //   (b) DIRECTIONAL — only an implausible IMPROVEMENT is suspect; a big loss is a valid result.
  const baseAbs = Math.abs(rc.baseline);
  const higherIsBetter = rc.higherIsBetter !== false;
  const outlierFactor = ig?.outlierFactor ?? 5;
  const tooGood = !noCandidate && (higherIsBetter
    ? measuredResult! > baseAbs * outlierFactor
    : measuredResult! < -(baseAbs * outlierFactor));
  if (!noCandidate && baseAbs > 1e-9 && tooGood) {
    const r = await rejectGate('outlier_too_high',
      `Rejected '${label}' = ${measuredResult}: implausibly far beyond ${outlierFactor}× baseline (${rc.baseline}) in the improving direction — likely numerical explosion, data leakage, overfit, or a units bug. Verify the calculation and reproduce before trusting.`);
    if (r) return r; else return null;
  }

  journal.rounds.push({
    label,
    outcome: noCandidate ? 'no_candidate' : 'measured',
    ...(noCandidate
      ? { reason: round.reason!.trim(), ...(round.evidence === undefined ? {} : { evidence: round.evidence }) }
      : { result: measuredResult! }),
    resultStd: (round as { result_std?: number }).result_std,
    wallHoursCumulative: (Date.now() - startedMs) / 3600000,
  });
  try { writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
  // Project-relative mirror of the round record (the journal lives in the run dir, which a
  // planner's project-relative reality check can't reach). The planner is told to reference
  // <report_dir>/run_manifest.json for any round-level check — so it never invents a missing
  // artifact and false-blocks an honest ceiling (observed: planner required run_manifest.json).
  try {
    const manifestDir = join(ctx.projectDir, rc.reportDir ?? 'docs');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'run_manifest.json'), JSON.stringify({ runId: ctx.runId, rounds: journal.rounds }, null, 2) + '\n', 'utf-8');
  } catch { /* non-critical */ }

  const evalResult = evaluateResearch(rc, journal.rounds);
  try { writeFileSync(join(ctx.runDirPath, 'research_decision.json'), JSON.stringify(evalResult, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }

  // Consume the round result so the next iteration doesn't re-process it.
  try {
    renameSync(
      sourceAbs,
      join(ctx.runDirPath, `research_round_${journal.rounds.length}_${noCandidate ? 'no_candidate_' : ''}consumed.json`),
    );
  } catch { /* non-critical */ }

  log.info({ runId: ctx.runId, iteration: ctx.iteration, label, result: measuredResult, outcome: noCandidate ? 'no_candidate' : 'measured', runningBest: evalResult.runningBest, decision: evalResult.decision }, 'Research round evaluated');
  const roundSummary = noCandidate
    ? `Research round '${label}' reported no acting candidate (${round.reason})`
    : `Research round '${label}' = ${measuredResult}`;

  if (evalResult.decision === 'continue') {
    // Steer the next iteration: tell the agent the running-best + kept set and
    // ask for the next direction. Idempotent marker per round.
    const marker = `[research-advance:round-${journal.rounds.length}]`;
    const nextRound = journal.rounds.length + 1;
    appendSchedulerGuidanceOnce(
      ctx.runDirPath,
      RUN_WIDE_GUIDANCE_TARGET,
      marker,
      `${roundSummary} (running-best ${evalResult.runningBest}, kept: ${evalResult.keptLabels.join(', ') || 'none'}). Decision: CONTINUE.\n`
        + `▶ START ROUND ${nextRound} — a NEW, genuinely DIFFERENT mechanism. Do NOT reuse, rename, or lightly re-tune the previous round's plan or candidate; a within-noise tweak will NOT count as an improvement (it must beat running-best by more than its standard error) and will burn the ceiling budget. Build on the kept stack, implement the new direction, then write its measured result to ${resultRel}.`,
    );
    // Signal the outer iteration loop to re-plan the next round instead of
    // falling through to allDone completion. The signal is consumed (deleted)
    // by the outer loop when it continues, so a stuck iteration that produces
    // no new round won't loop forever.
    try {
      mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
      writeFileSync(join(ctx.runDirPath, 'signals', 'research_continue.json'), JSON.stringify({ round: journal.rounds.length, runningBest: evalResult.runningBest, timestamp: new Date().toISOString() }), 'utf-8');
    } catch { /* non-critical */ }
    return null;
  }

  // ship | stop_ceiling → terminate the run via a framework-owned status.
  let terminalDecision: 'ship' | 'stop_ceiling' = evalResult.decision === 'ship' ? 'ship' : 'stop_ceiling';
  let finalEval = evalResult;

  // A+(a) CONFIRM gate (verify-before-trust): before ACCEPTING a 'ship', run the brief-declared
  // confirm command (generic mechanism — the exact exec-script-exit-zero check the reality gate
  // uses). Only allow `shipped` if it exits 0; on failure DOWNGRADE to `ceiling_hit` (the candidate
  // is unconfirmed, not shippable). The engine carries no domain knowledge — the command/contract
  // is entirely brief-owned. This internalizes "confirm a candidate beat on a fresh independent
  // split before accepting" as an engine primitive rather than trusting the agent's self-report.
  if (terminalDecision === 'ship' && rc.confirm) {
    let confirmReport: { pass: boolean; results: Array<{ details: string }> };
    try {
      confirmReport = await runAllChecks(
        [{ name: 'research_confirm', type: 'exec-script-exit-zero', params: { script: rc.confirm.command, timeout_seconds: rc.confirm.timeoutSeconds ?? 300 } }],
        { taskDir: ctx.runDirPath, projectDir: ctx.projectDir },
      );
    } catch (err) {
      confirmReport = { pass: false, results: [{ details: `confirm command threw: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    try { writeFileSync(join(ctx.runDirPath, 'research_confirm.json'), JSON.stringify({ ...confirmReport, command: rc.confirm.command, requires: rc.confirm.requires }, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
    if (!confirmReport.pass) {
      const detail = confirmReport.results.map((r) => r.details).join('; ') || 'confirm command did not exit 0';
      log.warn({ runId: ctx.runId, command: rc.confirm.command, detail }, 'Confirm gate FAILED — candidate unconfirmed; excluding round and re-evaluating');
      // Event-drift audit fix (engine bug #1a): a confirm failure kills THIS CANDIDATE,
      // not the research program. Mark the round confirm-failed so the policy excludes
      // it from kept/running-best (else the same unconfirmed number re-triggers
      // ship→confirm→fail forever), then let the NORMAL stop rules decide continue vs ceiling.
      const lastRound = journal.rounds[journal.rounds.length - 1];
      if (lastRound) lastRound.confirmFailed = true;
      try { writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
      try {
        const manifestDir = join(ctx.projectDir, rc.reportDir ?? 'docs');
        writeFileSync(join(manifestDir, 'run_manifest.json'), JSON.stringify({ runId: ctx.runId, rounds: journal.rounds }, null, 2) + '\n', 'utf-8');
      } catch { /* non-critical */ }
      finalEval = evaluateResearch(rc, journal.rounds);
      finalEval.reason = `confirm gate failed on '${label}' (${detail}) — candidate excluded from kept stack | ${finalEval.reason}`;
      try { writeFileSync(join(ctx.runDirPath, 'research_decision.json'), JSON.stringify(finalEval, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
      if (finalEval.decision === 'continue') {
        const marker = `[research-confirm-fail:round-${journal.rounds.length}]`;
        appendSchedulerGuidanceOnce(
          ctx.runDirPath,
          RUN_WIDE_GUIDANCE_TARGET,
          marker,
          `Round '${label}' = ${measuredResult} FAILED the confirm gate: ${detail}. The candidate is UNCONFIRMED and has been excluded from the kept stack (running-best ${finalEval.runningBest}).\n`
            + `▶ START ROUND ${journal.rounds.length + 1} — a NEW, genuinely DIFFERENT mechanism (do not re-tune the failed candidate; fix what the confirm gate named only if a distinct mechanism addresses it). Write its measured result to ${resultRel}.`,
        );
        try {
          mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
          writeFileSync(join(ctx.runDirPath, 'signals', 'research_continue.json'), JSON.stringify({ round: journal.rounds.length, runningBest: finalEval.runningBest, confirmFailed: label, timestamp: new Date().toISOString() }), 'utf-8');
        } catch { /* non-critical */ }
        log.info({ runId: ctx.runId, label, decision: finalEval.decision }, 'Confirm-failed candidate excluded — research budget remains, continuing loop');
        return null;
      }
      terminalDecision = 'stop_ceiling';
    } else {
      log.info({ runId: ctx.runId, command: rc.confirm.command }, 'Confirm gate PASSED — ship confirmed');
    }
  }

  // Engine bug #1b (event-drift audit): a ceiling claim must satisfy the brief-declared
  // floor on terminal_states.ceiling_hit — the research loop previously bypassed the
  // unified terminal gate entirely and could commit ceiling_hit at 4 rounds / 32 min
  // against a declared floor of 5 stages / 180 min. Research semantics: rounds are the
  // attempted stages. If the floor is unmet and round/wall budget remains, keep
  // researching; if hard budgets are exhausted, commit but say so honestly.
  if (terminalDecision === 'stop_ceiling') {
    const ceilingEntry = state.terminalStates?.['ceiling_hit'];
    const elapsedMinutes = (Date.now() - startedMs) / 60000;
    const floorCheck = evaluateResearchCeilingFloor(ceilingEntry?.floor, journal.rounds.length, elapsedMinutes);
    if (!floorCheck.passed) {
      const stop = rc.stop ?? {};
      const budgetRemains = (stop.maxRounds === undefined || journal.rounds.length < stop.maxRounds)
        && (stop.maxWallHours === undefined || (elapsedMinutes / 60) < stop.maxWallHours);
      if (budgetRemains) {
        const marker = `[research-floor:round-${journal.rounds.length}]`;
        appendSchedulerGuidanceOnce(
          ctx.runDirPath,
          RUN_WIDE_GUIDANCE_TARGET,
          marker,
          `A ceiling was proposed (${finalEval.reason}) but the brief's ceiling floor is unmet: ${floorCheck.reason}.\n`
            + `▶ START ROUND ${journal.rounds.length + 1} — a NEW direction from the brief's portfolio. Write its measured result to ${resultRel}.`,
        );
        try {
          mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
          writeFileSync(join(ctx.runDirPath, 'signals', 'research_continue.json'), JSON.stringify({ round: journal.rounds.length, runningBest: finalEval.runningBest, floorDeferred: floorCheck.reason, timestamp: new Date().toISOString() }), 'utf-8');
        } catch { /* non-critical */ }
        // The floor owns the effective decision. Leaving a durable
        // `stop_ceiling` fact here makes the conditional finalizer eligible at
        // the start of the next iteration, before the extra round just required.
        finalEval.decision = 'continue';
        finalEval.reason = `${finalEval.reason} | ceiling deferred: floor unmet (${floorCheck.reason})`;
        try { writeFileSync(join(ctx.runDirPath, 'research_decision.json'), JSON.stringify(finalEval, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
        log.warn({ runId: ctx.runId, reason: floorCheck.reason }, 'Ceiling floor unmet — NOT terminating; steering next research round');
        return null;
      }
      finalEval.reason = `${finalEval.reason} | WARNING: ceiling committed with floor unmet (${floorCheck.reason}) — hard round/wall budget exhausted`;
    }
  }

  const policyTerminalStatus = terminalDecision === 'ship' ? RUN_STATUS.SHIPPED : RUN_STATUS.CEILING_HIT;
  const policyTerminalPath = state.terminalStates?.[policyTerminalStatus]?.paths?.[0];
  const policyTerminalOwner = policyTerminalPath
    ? admittedTerminalOwner(ctx.runDirPath, policyTerminalPath)
    : undefined;
  if (policyTerminalOwner) {
    // Dynamic runs commit terminal state through their admitted owner stage.
    // Publish the settled policy fact, then let that conditional DAG sink write
    // exactly one matching artifact. The terminal detector will verify its
    // write attribution and reality checks before committing run state.
    try {
      writeFileSync(join(ctx.runDirPath, 'research_decision.json'), `${JSON.stringify({
        ...finalEval,
        decision: terminalDecision,
        terminalStatus: policyTerminalStatus,
        terminalPath: policyTerminalPath,
        terminalOwner: policyTerminalOwner,
      }, null, 2)}\n`, 'utf-8');
      mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
      writeFileSync(join(ctx.runDirPath, 'signals', 'research_terminal_ready.json'), `${JSON.stringify({
        version: 1,
        decision: terminalDecision,
        terminalStatus: policyTerminalStatus,
        terminalPath: policyTerminalPath,
        terminalOwner: policyTerminalOwner,
        reason: finalEval.reason,
      }, null, 2)}\n`, 'utf-8');
      const lastRound = journal.rounds.at(-1);
      const lastConsumed = join(ctx.runDirPath, `research_round_${journal.rounds.length}_consumed.json`);
      if (lastRound?.outcome !== 'no_candidate' && !existsSync(resultAbs) && existsSync(lastConsumed)) {
        copyFileSync(lastConsumed, resultAbs);
      }
    } catch { /* terminal owner will expose missing decision evidence */ }
    appendSchedulerGuidanceOnce(
      ctx.runDirPath,
      policyTerminalOwner,
      `[research-terminal-ready:${journal.rounds.length}:${terminalDecision}]`,
      `The mechanically settled research decision is ${terminalDecision}. Read research_decision.json and write exactly the matching declared terminal artifact ${policyTerminalPath}; do not write any other terminal path.`,
      Object.keys(state.stages),
    );
    return null;
  }

  // Legacy/static workflows without an admitted terminal owner retain the
  // framework-authored terminal path for compatibility.
  state.status = policyTerminalStatus;
  // FIX D — if confirm was declared but this is a non-ship terminal, record that it was not run
  // (the confirm gate above only writes research_confirm.json on a ship). Observability only.
  if (terminalDecision !== 'ship') recordConfirmNotRun(ctx.runDirPath, rc.confirm, state.status);
  state.completedAt = new Date().toISOString();
  // Engine bug #3 (event-drift audit): the research loop terminates the run between
  // iterations, so stages dispatched for the current iteration (verify_*/fix_*) can be
  // left 'pending' forever in run.json. Mark them skipped with the reason, honestly.
  markLeftoverStagesSkipped(state, `research loop terminated (${state.status}) before this stage ran`);
  // Engine bug #2 (event-drift audit): the brief declares terminal artifact paths
  // (terminal_states.<status>.paths); an engine-initiated terminal used to write only
  // the framework-owned program_*_report.md, leaving the declared contract path
  // nonexistent. Mirror the report to the first declared path (never clobbering an
  // agent-authored one) so the terminal contract is truthful.
  const declaredPath = state.terminalStates?.[state.status]?.paths?.[0];
  if (declaredPath) state.terminalArtifact = declaredPath.split('/').pop();
  // Engine bug #4 (found by the engine-fix validation run): each round's result file is
  // consumed (renamed into the run dir) so the next iteration doesn't re-process it — but
  // planner-authored reality checks may reference the result file at its project path, and
  // the terminal gate re-runs those checks AFTER consumption, false-blocking an honest
  // terminal (FileNotFoundError → reality_gate_failed on a truthful ceiling). Restore the
  // latest consumed round result to its declared path before the gate: it is the agent's
  // real, engine-evaluated measurement, not a fabrication.
  try {
    const lastConsumed = join(ctx.runDirPath, `research_round_${journal.rounds.length}_consumed.json`);
    if (!existsSync(resultAbs) && existsSync(lastConsumed)) copyFileSync(lastConsumed, resultAbs);
  } catch { /* non-critical */ }

  // Materialize the terminal candidate before evaluating reality checks. The
  // old order asked checks to prove an artifact that the framework only wrote
  // after those checks passed, creating an unsatisfiable gate. These writes are
  // candidates, not a committed terminal state; a rejected candidate is moved
  // into the run directory for audit and removed from the live project path.
  const reportDir = join(ctx.projectDir, rc.reportDir ?? 'docs');
  const reportName = terminalDecision === 'ship' ? 'program_ship_report.md' : 'program_ceiling_report.md';
  const reportAbs = join(reportDir, reportName);
  const reportBody = `# Research ${terminalDecision === 'ship' ? 'Ship' : 'Ceiling'} Report\n\n`
    + `Decision: ${terminalDecision}\n`
    + `Running-best: ${finalEval.runningBest}\n`
    + `Baseline: ${rc.baseline}\n`
    + `Kept directions: ${finalEval.keptLabels.join(', ') || 'none'}\n`
    + `Reason: ${finalEval.reason}\n\n`
    + `## Rounds\n` + journal.rounds.map((r) => r.outcome === 'no_candidate'
      ? `- ${r.label}: no candidate (${r.reason ?? 'no reason recorded'})`
      : `- ${r.label}: ${r.result}${r.confirmFailed ? ' (confirm gate FAILED — unconfirmed)' : ''}`).join('\n') + '\n';
  let wroteReportCandidate = false;
  let wroteDeclaredCandidate = false;
  try {
    mkdirSync(reportDir, { recursive: true });
    if (!existsSync(reportAbs)) {
      writeFileSync(reportAbs, reportBody, 'utf-8');
      wroteReportCandidate = true;
    }
    if (declaredPath) {
      const declaredAbs = join(ctx.projectDir, declaredPath);
      if (!existsSync(declaredAbs)) {
        mkdirSync(dirname(declaredAbs), { recursive: true });
        writeFileSync(declaredAbs, `> Engine-authored terminal candidate; acceptance remains subject to the declared reality checks.\n\n${reportBody}`, 'utf-8');
        wroteDeclaredCandidate = true;
      }
    }
  } catch (error) {
    log.warn({ runId: ctx.runId, error }, 'Could not materialize the research terminal candidate before reality verification');
  }
  const gate = await enforceRealityGateBeforeTerminal(ctx.projectDir, ctx.runId, state, state.status);
  // GAP-1: write a campaign jsonl row on the reality_gate_failed downgrade too, so the
  // outer loop sees the truthful terminal status (not a silent return with no envelope).
  if (!gate.allowed) {
    const quarantine = (source: string, label: string): void => {
      if (!existsSync(source)) return;
      try { renameSync(source, join(ctx.runDirPath, `reality_rejected_${label}`)); } catch { /* preserve evidence in place if move fails */ }
    };
    if (wroteReportCandidate) quarantine(reportAbs, reportName);
    if (wroteDeclaredCandidate && declaredPath) quarantine(join(ctx.projectDir, declaredPath), declaredPath.split('/').pop() ?? 'terminal_candidate');
    writeCampaignEntry(ctx.projectDir, gate.state);
    return gate.state;
  }
  writeRunState(ctx.projectDir, ctx.runId, state);
  writeCampaignEntry(ctx.projectDir, state);
  recordRunEvent(ctx.projectDir, ctx.runId, {
    type: 'run_completed',
    runId: ctx.runId,
    timestamp: state.completedAt,
    iteration: ctx.iteration,
    detail: `Research ${terminalDecision}: ${finalEval.reason}`,
  });
  log.info({ runId: ctx.runId, decision: terminalDecision, runningBest: finalEval.runningBest }, 'Research loop terminated');
  await generateRunSummary(ctx.projectDir, ctx.runId, ctx.adapter).catch(() => { /* non-critical */ });
  return state;
}

/**
 * Run a terminal-state post_terminate_hook after the run's terminal status
 * has already been committed (run.json persisted, campaign entry written,
 * run_completed event recorded). The hook is best-effort: a non-zero exit or
 * timeout is logged as warn but never blocks the scheduler from returning.
 *
 * The hook receives FC_* env vars so the script can locate the run, the
 * verdict file, and the project without parsing CLI args.
 *
 * stdout/stderr are captured to <run_dir>/post_terminate_hook.log for
 * post-mortem inspection.
 */
async function runPostTerminateHook(
  hook: PostTerminateHook,
  ctx: {
    projectDir: string;
    runDir: string;
    runId: string;
    terminalStatus: string;
    verdictPath: string;
  },
): Promise<void> {
  const { spawn } = await import('node:child_process');
  const timeoutMs = (hook.timeoutSeconds ?? 300) * 1000;
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
  const logPath = join(ctx.runDir, 'post_terminate_hook.log');
  const startedAt = new Date().toISOString();

  await new Promise<void>((resolve) => {
    let settled = false;
    const child = spawn(hook.command, args, {
      cwd: ctx.projectDir,
      env: hookEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [
      `# post_terminate_hook log\n`,
      `started_at: ${startedAt}\n`,
      `command: ${hook.command}\n`,
      `args: ${JSON.stringify(args)}\n`,
      `timeout_seconds: ${hook.timeoutSeconds ?? 300}\n`,
      `\n--- stdout/stderr ---\n`,
    ];
    child.stdout?.on('data', (d) => chunks.push(d.toString()));
    child.stderr?.on('data', (d) => chunks.push(d.toString()));
    const timer = setTimeout(() => {
      if (settled) return;
      log.warn({ runId: ctx.runId, command: hook.command, timeoutMs }, 'post_terminate_hook exceeded timeout, killing');
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 5000);
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn({ runId: ctx.runId, command: hook.command, err: String(err) }, 'post_terminate_hook spawn failed');
      try { writeFileSync(logPath, chunks.join('') + `\nspawn error: ${err}\n`, 'utf-8'); } catch { /* noop */ }
      resolve();
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.push(`\n--- exit ---\ncode: ${code}\nsignal: ${signal}\ncompleted_at: ${new Date().toISOString()}\n`);
      try { writeFileSync(logPath, chunks.join(''), 'utf-8'); } catch { /* noop */ }
      if (code !== 0) {
        log.warn({ runId: ctx.runId, command: hook.command, exitCode: code, signal }, 'post_terminate_hook exited non-zero (best-effort, ignored)');
      } else {
        log.info({ runId: ctx.runId, command: hook.command }, 'post_terminate_hook completed');
      }
      resolve();
    });
  });
}

// Minimum bytes for a stage-verdict file to count as "real work" toward the
// floor. Bug #7 demoted wall-time from a hard gate; this restores the
// anti-premature-quit safety net via artifact realness instead of elapsed
// time — an agent can't satisfy `min_attempted_stages` with empty/stub files.
// A genuine stage verdict (markdown headers + a result line) is well over this.
const MIN_STAGE_VERDICT_BYTES = 40;

function countGlobMatches(projectDir: string, glob: string, startedAtMs: number): { fresh: number; stale: number } {
  const slash = glob.lastIndexOf('/');
  const dir = slash >= 0 ? glob.substring(0, slash) : '.';
  const pattern = slash >= 0 ? glob.substring(slash + 1) : glob;
  // Convert simple `*` glob to anchored regex (escape dots, expand stars)
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  try {
    const fullDir = join(projectDir, dir);
    if (!existsSync(fullDir)) return { fresh: 0, stale: 0 };
    let fresh = 0;
    let stale = 0;
    for (const f of readdirSync(fullDir)) {
      if (!re.test(f)) continue;
      // Realness filter: ignore empty/stub files so the floor reflects
      // substantive stage work, not placeholder touches.
      try {
        const stat = statSync(join(fullDir, f));
        if (stat.size < MIN_STAGE_VERDICT_BYTES) continue;
        if (stat.mtimeMs >= startedAtMs) fresh += 1;
        else stale += 1;
      } catch { /* a disappearing/unreadable file does not count */ }
    }
    return { fresh, stale };
  } catch {
    return { fresh: 0, stale: 0 };
  }
}

// Error-string prefix written into a plan stage's status.json when it exited 0
// but produced zero valid injected stages (empty/invalid dispatch.yaml). The
// retry preamble keys off this prefix to render a dispatch-specific re-prompt.
const INVALID_DISPATCH_ERROR_PREFIX = 'invalid dispatch.yaml';
const INVALID_REALITY_CHECKS_ERROR_PREFIX = 'invalid reality_checks.md';
const REALITY_CHECK_PREFLIGHT_ARTIFACT = 'reality_check_preflight.json';

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

/**
 * Build the retry preamble injected before the resolved prompt on attempt >= 2.
 * Distinguishes supervisor-abort failures, transient adapter errors, and the
 * empty/invalid-dispatch re-plan case from true wall-clock timeouts by reading
 * the previous attempt's status.error string written by worker.ts (or, for the
 * dispatch case, by the empty-dispatch handler in executeIteration).
 */
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
  if (prevError && prevError.startsWith(INVALID_REALITY_CHECKS_ERROR_PREFIX)) {
    const detail = prevError.slice(INVALID_REALITY_CHECKS_ERROR_PREFIX.length).replace(/^[:\s]+/, '').trim();
    return [
      `RE-PLAN (attempt ${retries + 1}): pre-dispatch lint refused one or more hard checks in your previous reality_checks.md before any work stage ran.`,
      detail ? `Specific preflight finding(s): ${detail}` : 'A hard check could false-block a result that satisfies the task brief.',
      `Read ${runDirPath}/${REALITY_CHECK_PREFLIGHT_ARTIFACT} for the complete blocking and advisory findings from that proposal.`,
      'Write fresh, complete dispatch.yaml and reality_checks.md files. Replace or omit each rejected hard check; preserve the brief\'s explicit exceptions and test the claimed contract property rather than a presentation or bookkeeping proxy.',
      `Write both files in ${runDirPath}. Do not continue from partial planner artifacts: the rejected dispatch and checks were removed before this retry.`,
    ].join('\n\n');
  }
  // Empty/invalid dispatch.yaml — re-plan, do NOT "continue from partial". The
  // detail (parse error / unknown roles) is carried in the error string itself.
  if (prevError && prevError.startsWith(INVALID_DISPATCH_ERROR_PREFIX)) {
    const detail = prevError.slice(INVALID_DISPATCH_ERROR_PREFIX.length).replace(/^[:\s]+/, '').trim();
    return [
      `RE-PLAN (attempt ${retries + 1}): your previous attempt exited cleanly but you failed to emit a valid dispatch.yaml — it produced ZERO usable stages.`,
      detail ? `Specific problem: ${detail}` : 'The file was missing, empty, unparseable, or contained no schema-valid stages.',
      DISPATCH_SCHEMA_REMINDER,
      `Write ONLY the dispatch.yaml file (at ${runDirPath}/dispatch.yaml) with at least one schema-valid stage that uses a known role. Do not continue from any partial output; emit a fresh, complete file.`,
    ].join('\n\n');
  }
  let cause: string;
  if (prevError && prevError.startsWith('aborted by supervisor')) {
    cause = `Previous attempt was ${prevError}. The supervisor judged that the previous attempt was stuck or off-direction. Use this signal: re-read the goal, identify what concrete progress you should produce in this attempt, and START making file edits within a few minutes; do NOT spend the whole attempt only inspecting code.`;
  } else if (prevError && prevError.startsWith('adapter connection failed')) {
    cause = `Previous attempt failed with an adapter connection error (transient). Retry the same plan.`;
  } else if (timeoutContext) {
    cause = `Previous attempt timed out with an effective budget of ${timeoutContext.previousBudgetMs}ms. `
      + `This new attempt has a strictly larger immutable budget of ${timeoutContext.nextBudgetMs}ms.`;
  } else {
    cause = `Previous attempt timed out after ${Math.ceil(timeoutMs / 1000)}s.`;
  }
  return `RETRY (attempt ${retries + 1}): ${cause} Read partial output at ${partialPath} and continue from where you left off. Do not start over.`;
}

/**
 * The detail string diagnosing WHY a plan stage's dispatch.yaml yielded zero
 * valid injected stages. Pure + exported for unit testing. Distinguishes:
 *   - no dispatch.yaml written at all (the planner emitted nothing)
 *   - dispatch.yaml present but unparseable (truncated/malformed YAML)
 *   - dispatch.yaml parsed but every stage referenced an unknown role
 *   - dispatch.yaml parsed but contained no stages / no schema-valid stages
 * The unknown-role case is GENUINE (unsatisfiable as written) — surfaced so the
 * caller can fail faster with the specific roles named; the others are typically
 * TRANSIENT LLM flakes worth a bounded retry.
 */
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

/** Action the engine takes when a plan stage emits zero valid injected stages and
 * there is no static follow-up. Pure + exported for unit testing. */
export type EmptyDispatchAction =
  | { action: 'retry'; nextRetry: number; error: string; detail: string }
  | { action: 'escalate'; status: 'escalated' | 'failed'; reason: string; unknownRoles: string[] };

/**
 * Decide whether an empty/invalid-dispatch plan stage should be RETRIED (a
 * bounded re-plan of the plan stage) or ESCALATED with specifics. Generic engine
 * mechanism: a transient flake under budget retries; an exhausted budget OR a
 * genuine (every-stage-unknown-role) failure escalates with the precise detail
 * instead of the old generic "refine the brief" punt. A genuine unknown-role
 * failure escalates immediately (re-planning the same brief just repeats it).
 */
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

function writeRealityCheckPreflightArtifact(
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
function readPendingRejectSignal(runDirPath: string): { path: string; signal: SupervisorRejectSignal } | null {
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
    const sig = JSON.parse(readFileSync(path, 'utf-8')) as { reason?: string; stage?: string };
    if (sig.reason) reason = sig.reason;
    if (typeof sig.stage === 'string') targetStage = sig.stage;
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

/**
 * Consume a pending supervisor REJECT before a deliverable is accepted as
 * terminal (FIX 2). If a REJECT signal targets a stage that completed this
 * iteration and the per-stage reject budget is not exhausted, re-pend that stage
 * (and any gate that consumes it, clearing its verdict) so the work is RE-DONE
 * rather than accepted, then return true (caller `continue`s the loop). Returns
 * false to let the run proceed (no reject pending, budget exhausted, or no
 * resolvable target). The signal is one-shot (deleted on consume).
 */
export function consumeSupervisorReject(
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

  const counts = readRejectCounts(ctx.runDirPath);
  const usedForStage = resolved ? (counts[resolved] ?? 0) : 0;
  const maxRejects = Math.max(0, Math.floor(Number(loadDefaults(ctx.projectDir).supervisor_max_rejects)));
  const decision = decideRejectAction(pending.signal, resolved, usedForStage, maxRejects);
  const targetConfig = decision.targetStage
    ? sorted.find((stage) => stage.id === decision.targetStage)
    : undefined;
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
    writeFileSync(verdictPath, `${JSON.stringify({
      pass: false,
      outcome: 'repair-required',
      reason: `Supervisor REJECT: ${decision.reason}`,
      source: 'supervisor_reject',
    }, null, 2)}\n`, 'utf-8');
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
}

/** Load project defaults, creating config/defaults.yaml from FlowCrew's template if absent. */
function loadDefaults(projectDir?: string) {
  return loadProjectDefaults(projectDir);
}

/** Operator-owned bound for technical timeout retries; plans cannot override it. */
function configuredTechnicalRetryLimit(projectDir?: string): number {
  return Math.max(0, Math.floor(Number(loadDefaults(projectDir).stage_technical_retries)));
}

const AgentConfigSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  model: z.string().default('default'),
  reasoning_effort: z.string().default('default'),
  tools: z.array(z.string()).default([]),
  prompt: z.string(),
  adapter: z.string().optional(),
  handoff_visibility: z.enum(['full', 'minimal', 'none']).optional(),
});

function parseAgent(raw: unknown, projectDir?: string): AgentConfig {
  const agent = AgentConfigSchema.parse(raw);
  if (agent.model === 'default') agent.model = loadDefaults(projectDir).model;
  if (agent.reasoning_effort === 'default') agent.reasoning_effort = loadDefaults(projectDir).reasoning_effort;
  return agent;
}

const TIMEOUT_OVERRIDE_MIGRATION = 'Stage timeout overrides were removed; edit config/defaults.yaml::default_timeout_ms instead.';

export const StageConfigSchema = z.object({
  id: z.string(),
  role: z.string(),
  depends_on: z.array(z.string()).optional().default([]),
  /** Project-relative write capability. Missing is closed for writes and conflicting for parallel dispatch. */
  scope: z.array(z.string()).optional(),
  /** One concrete planner explanation per real dependency edge. */
  dependency_reasons: z.record(z.string(), z.string()).optional(),
  condition: z.string().optional(),
  prompt_template: z.string().optional().default(''),
  // Compatibility guards only: these fields cannot survive parsing and are
  // deliberately absent from all runtime timeout resolution.
  timeout_ms: z.never({ error: TIMEOUT_OVERRIDE_MIGRATION }).optional(),
  timeout_total_ms: z.never({ error: TIMEOUT_OVERRIDE_MIGRATION }).optional(),
  max_retries: z.number().optional(),
  skills: z.array(z.string()).optional().default([]),
  dynamic_dispatch: z.boolean().optional().default(false),
  is_gate: z.boolean().optional().default(false),
  retry_to: z.array(z.string()).optional(),
  /** Canonical IDs from the run-local brief_criteria.json artifact. */
  criterion_refs: z.array(z.string()).optional().default([]),
});

const StrictDispatchedStageConfigSchema = StageConfigSchema.extend({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/, 'must be snake_case and at most 20 characters'),
  depends_on: z.array(z.string()),
  scope: z.array(z.string()),
  dependency_reasons: z.record(z.string(), z.string()),
}).superRefine((stage, context) => {
  const dependencies = new Set(stage.depends_on);
  const reasons = new Set(Object.keys(stage.dependency_reasons));
  for (const dependency of dependencies) {
    if (!stage.dependency_reasons[dependency]?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['dependency_reasons', dependency],
        message: 'must contain one non-empty reason for this depends_on edge',
      });
    }
  }
  for (const reason of reasons) {
    if (!dependencies.has(reason)) {
      context.addIssue({
        code: 'custom',
        path: ['dependency_reasons', reason],
        message: 'has no matching depends_on edge',
      });
    }
  }
  if (stage.is_gate && stage.retry_to?.length) {
    context.addIssue({
      code: 'custom',
      path: ['retry_to'],
      message: 'gate stages cannot declare retry_to; repairs own retry_to edges',
    });
  }
});

export const WorkflowConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional().default(''),
  defaults: z.object({
    timeout_ms: z.never({ error: TIMEOUT_OVERRIDE_MIGRATION }).optional(),
    timeout_total_ms: z.never({ error: TIMEOUT_OVERRIDE_MIGRATION }).optional(),
    max_retries: z.number().optional(),
    max_iterations: z.number().optional(),
  }).optional().default({}),
  stages: z.array(StageConfigSchema).min(1),
});

export type StageConfig = z.infer<typeof StageConfigSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

/**
 * Dynamic plans describe the DAG, not scheduler recovery policy. Keep accepting
 * the historical field so an otherwise usable plan is not discarded, but strip
 * it before the stage reaches state, workflow persistence, or execution.
 */
export function parseDispatchedStageConfig(raw: unknown): StageConfig {
  const stage = StrictDispatchedStageConfigSchema.parse(raw);
  delete stage.max_retries;
  return stage;
}

/** Normalize the quality topology for both static workflows and dynamic dispatch. */
export function normalizeRetryGateRelationships(stages: StageConfig[]): StageConfig[] {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  for (const repair of stages) {
    if (repair.is_gate || !repair.retry_to?.length) continue;
    repair.dependency_reasons ??= {};
    for (const gateId of repair.retry_to) {
      const gate = byId.get(gateId);
      if (!gate) continue;
      gate.is_gate = true;
      if (!repair.depends_on.includes(gateId)) repair.depends_on = [...repair.depends_on, gateId];
      repair.dependency_reasons[gateId] ??= 'Framework retry dependency: fixes run only after this gate reports a failure.';
    }
  }
  return stages;
}

type CampaignMetric = { score: number; metric: string; gate: string; pass: boolean; threshold?: number };
type CampaignPhaseMetadata = {
  gate: string;
  pass: boolean;
  phase?: string;
  phaseComplete?: boolean;
  nextPhase?: string;
  outcome?: string;
  artifactSummary?: string;
  reason?: string;
};
type GateMetricLookup = { found: boolean; metric: CampaignMetric | null };

function isTerminalStudyCompletionArtifact(record: Record<string, unknown>): boolean {
  // Domain-agnostic contract: a gate verdict may declare that the STUDY is complete
  // even though the model did NOT succeed — a rigorous negative result is itself a
  // valid terminal outcome. Recognized by the verdict's OWN fields, NOT by any
  // hardcoded gate name, so any brief/gate can opt in by emitting this contract.
  if (record.phase_complete === true || record.phaseComplete === true || record.continue_next_phase === true) return false;
  return record.study_complete === true
    && record.model_success === false
    && record.reason === 'study_complete_without_model_success';
}

function topoSort(stages: StageConfig[]): StageConfig[] {
  const ids = new Set(stages.map((s) => s.id));
  if (ids.size !== stages.length) throw new Error('Duplicate stage IDs detected');
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of stages) {
    inDeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of stages) {
    for (const d of s.depends_on ?? []) {
      if (!ids.has(d)) throw new Error(`Unknown dependency "${d}" in stage "${s.id}"`);
      adj.get(d)!.push(s.id);
      inDeg.set(s.id, (inDeg.get(s.id) ?? 0) + 1);
    }
  }
  const queue = [...inDeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const sorted: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    sorted.push(n);
    for (const nb of adj.get(n) ?? []) {
      const d = inDeg.get(nb)! - 1;
      inDeg.set(nb, d);
      if (d === 0) queue.push(nb);
    }
  }
  if (sorted.length !== stages.length) throw new Error('Cycle detected in workflow stages');
  const order = new Map(sorted.map((id, i) => [id, i]));
  return [...stages].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function findAllReady(stages: StageConfig[], state: StoreState): StageConfig[] {
  const ready: StageConfig[] = [];
  const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
  let contract: ReturnType<typeof loadGateContract> | undefined;
  for (const s of stages) {
    const ss = state.stages[s.id];
    if (!ss || !isPendingStageStatus(ss.status)) continue;
    const depsReady = (s.depends_on ?? []).every((d) => {
      const ds = state.stages[d];
      if (!ds || !isSatisfiedStageDependencyStatus(ds.status)) return false;
      const dependency = stagesById.get(d);
      const hasRunLocation = typeof state.projectDir === 'string' && typeof state.runId === 'string';
      if (hasRunLocation && contract === undefined) {
        contract = loadGateContract(state.projectDir, state.runId, state.campaignStorageKey);
      }
      const hasSpecificVerdict = hasRunLocation && existsSync(join(
        runDir(state.projectDir, state.runId),
        `verdict_${d}.json`,
      ));
      const verdict = hasRunLocation && (dependency?.is_gate === true || hasSpecificVerdict)
        ? readGateVerdict(state.projectDir, d, state.runId, contract, false)
        : undefined;
      // A negative verdict is authoritative even if an older/static workflow
      // forgot to mark the producing stage as a gate. Stage status describes
      // process completion; it must never turn an explicit rejection into a
      // satisfied dependency.
      if (verdict?.pass === false) return false;
      // A `retry_to` edge is retry wiring, not an ordinary dependency.
      // `normalizeRetryGateRelationships` puts the gate into `depends_on` so a fix can be
      // dispatched when the gate REJECTS, and records exactly that on the edge: "fixes run
      // only after this gate reports a failure". Letting a PASSING gate satisfy the same
      // edge dispatches the fix again after the work was accepted — the opposite of the
      // recorded reason — and lets an unreviewed change land on a verified state. Rejection
      // reaches the fix through the retry loop ("Reset and run all active retry stages"),
      // never through here, so refusing the edge cannot strand a failing gate.
      //
      // Measured before this guard: a run whose gate passed on its second attempt then ran
      // fix → gate → fix → gate for another 46 minutes and 20M input tokens, committing
      // nothing. `gate_retry_loops` does not bound it, because this path is not the retry
      // loop, so within one iteration the cycle had no bound of its own.
      if (s.retry_to?.includes(d)) return false;
      if (dependency?.is_gate !== true) return true;
      // A completed gate is not a satisfied dependency until it has said
      // `pass: true`. Skipped gates were rejected by the dependency-status
      // check above and cannot release ordinary downstream work.
      return verdict?.pass === true;
    });
    if (depsReady) ready.push(s);
  }
  return ready;
}

type ParsedScope =
  | { kind: 'exact'; raw: string; value: string }
  | { kind: 'tree'; raw: string; value: string }
  | { kind: 'glob'; raw: string; directoryPrefix: string }
  | { kind: 'unknown'; raw: string; reason: string };

function parseDeclaredScope(rawValue: string): ParsedScope {
  const raw = rawValue.trim();
  const slashNormalized = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!slashNormalized) return { kind: 'unknown', raw, reason: 'empty scope entry' };
  if (isAbsolute(slashNormalized) || /^[A-Za-z]:\//.test(slashNormalized)) {
    return { kind: 'unknown', raw, reason: 'scope must be project-relative' };
  }
  const segments = slashNormalized.split('/');
  if (segments.includes('..')) return { kind: 'unknown', raw, reason: 'scope may not traverse outside the project' };
  // Preserve an explicit directory marker while canonicalizing harmless path
  // aliases. In particular, `dir/`, `dir/.`, and `./dir/` must all conflict
  // with the ambiguous bare literal `dir` and with descendants of `dir`.
  const explicitDirectory = slashNormalized.endsWith('/') || slashNormalized.endsWith('/.');
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!normalized) return { kind: 'unknown', raw, reason: 'empty scope entry' };
  const globAt = normalized.search(/[*!?[{]/);
  if (globAt >= 0) {
    const literal = normalized.slice(0, globAt);
    const slash = literal.lastIndexOf('/');
    return { kind: 'glob', raw, directoryPrefix: slash >= 0 ? literal.slice(0, slash) : '' };
  }
  if (explicitDirectory) return { kind: 'tree', raw, value: normalized };
  return { kind: 'exact', raw, value: normalized };
}

function prefixesAreProvablyDisjoint(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = a.replace(/\/$/, '').split('/');
  const right = b.replace(/\/$/, '').split('/');
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) return true;
  }
  return false;
}

function parsedScopesMayOverlap(a: ParsedScope, b: ParsedScope): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown') return true;
  // A literal without a trailing slash is ambiguous: it may name either a
  // file or a directory. Treat path-segment ancestry as a possible overlap,
  // while still proving similarly named siblings (for example src vs src-ui)
  // disjoint.
  if (a.kind !== 'glob' && b.kind !== 'glob') {
    return !prefixesAreProvablyDisjoint(a.value, b.value);
  }

  const aPrefix = a.kind === 'glob' ? a.directoryPrefix : a.kind === 'tree' ? a.value : a.value;
  const bPrefix = b.kind === 'glob' ? b.directoryPrefix : b.kind === 'tree' ? b.value : b.value;
  // A differing literal directory segment is a proof of disjointness. Any
  // ambiguity inside the same directory is conservatively serialized.
  return !prefixesAreProvablyDisjoint(aPrefix, bPrefix);
}

export interface ScopeConflict {
  leftStageId: string;
  rightStageId: string;
  leftScope?: string;
  rightScope?: string;
  reason: string;
}

export function findScopeConflict(left: StageConfig, right: StageConfig): ScopeConflict | undefined {
  if (!left.scope) return { leftStageId: left.id, rightStageId: right.id, reason: `${left.id} has no declared scope` };
  if (!right.scope) return { leftStageId: left.id, rightStageId: right.id, reason: `${right.id} has no declared scope` };
  // An explicitly empty scope means the stage declares no project writes.
  if (left.scope.length === 0 || right.scope.length === 0) return undefined;
  const leftParsed = left.scope.map(parseDeclaredScope);
  const rightParsed = right.scope.map(parseDeclaredScope);
  for (const a of leftParsed) {
    if (a.kind === 'unknown') return { leftStageId: left.id, rightStageId: right.id, leftScope: a.raw, reason: `${left.id}: ${a.reason}` };
    for (const b of rightParsed) {
      if (b.kind === 'unknown') return { leftStageId: left.id, rightStageId: right.id, rightScope: b.raw, reason: `${right.id}: ${b.reason}` };
      if (parsedScopesMayOverlap(a, b)) {
        return {
          leftStageId: left.id,
          rightStageId: right.id,
          leftScope: a.raw,
          rightScope: b.raw,
          reason: `declared scopes may overlap: ${a.raw} ↔ ${b.raw}`,
        };
      }
    }
  }
  return undefined;
}

export function selectRunnableBatch(ready: StageConfig[]): {
  selected: StageConfig[];
  deferred: Array<{ stage: StageConfig; conflict: ScopeConflict }>;
} {
  const selected: StageConfig[] = [];
  const deferred: Array<{ stage: StageConfig; conflict: ScopeConflict }> = [];
  for (const stage of ready) {
    let conflict: ScopeConflict | undefined;
    for (const admitted of selected) {
      conflict = findScopeConflict(admitted, stage);
      if (conflict) break;
    }
    if (conflict) deferred.push({ stage, conflict });
    else selected.push(stage);
  }
  return { selected, deferred };
}

export interface ParallelWriteConflict {
  stageIds: [string, string];
  files: string[];
  attribution: [WriteAttribution, WriteAttribution];
}

function latestAttemptWrites(status: StageStatus | undefined): { files: string[]; attribution: WriteAttribution } {
  const attempt = status?.attempts?.at(-1);
  const files = (attempt?.writes ?? [])
    .map((file) => file.trim().replace(/\\/g, '/'))
    .filter((file) => !!file)
    // These are factual adapter observations, not declared project scopes.
    // Normalize lexically for comparison but retain `../` paths so two stages
    // writing the same run-owned artifact outside the project remain visible.
    .map((file) => posix.normalize(file));
  return { files: [...new Set(files)], attribution: attempt?.writeAttribution ?? 'unknown' };
}

function directlyAttributesWrites(attribution: WriteAttribution): boolean {
  switch (attribution) {
    case 'structured':
      return true;
    case 'snapshot':
    case 'unknown':
      return false;
    default: {
      const exhaustive: never = attribution;
      void exhaustive;
      return false;
    }
  }
}

export function detectParallelWriteConflicts(
  stageIds: string[],
  statuses: Record<string, StageStatus>,
): ParallelWriteConflict[] {
  const conflicts: ParallelWriteConflict[] = [];
  for (let i = 0; i < stageIds.length; i++) {
    const left = latestAttemptWrites(statuses[stageIds[i]]);
    const leftSet = new Set(left.files);
    for (let j = i + 1; j < stageIds.length; j++) {
      const right = latestAttemptWrites(statuses[stageIds[j]]);
      // A shared-worktree snapshot observes that a path changed while the stage
      // ran; it cannot establish which concurrent stage authored the change.
      // Require direct attribution from both sides before claiming co-authorship.
      if (!directlyAttributesWrites(left.attribution) || !directlyAttributesWrites(right.attribution)) continue;
      const files = [...new Set(right.files.filter((file) => leftSet.has(file)))].sort();
      if (files.length > 0) {
        conflicts.push({
          stageIds: [stageIds[i], stageIds[j]],
          files,
          attribution: [left.attribution, right.attribution],
        });
      }
    }
  }
  return conflicts;
}

export function isValidationStage(stage: StageConfig): boolean {
  const tagged = `${stage.id} ${stage.role}`;
  return stage.role.toLowerCase() === 'qa'
    || stage.is_gate === true
    || /(^|[\s_-])(gate|verify|verification)(?=$|[\s_-])/i.test(tagged);
}

function reusableDirectSuccessors(stage: StageConfig, allStages: StageConfig[]): StageConfig[] {
  if (isValidationStage(stage)) return [];
  return allStages.filter((candidate) =>
    candidate.depends_on.length === 1
    && candidate.depends_on[0] === stage.id
    && !isValidationStage(candidate),
  );
}

export function canReuseCodexSession(input: {
  stage: StageConfig;
  predecessor: StageConfig;
  allStages: StageConfig[];
  predecessorStatus: StageStatus | undefined;
  destinationStatus: StageStatus | undefined;
  session: CodexSessionMetadata | undefined;
}): boolean {
  const { stage, predecessor, allStages, predecessorStatus, destinationStatus, session } = input;
  if (stage.depends_on.length !== 1 || stage.depends_on[0] !== predecessor.id) return false;
  if (isValidationStage(stage) || isValidationStage(predecessor)) return false;
  const successors = reusableDirectSuccessors(predecessor, allStages);
  if (successors.length !== 1 || successors[0].id !== stage.id) return false;
  if (!session) return false;
  if (predecessorStatus?.status !== STAGE_STATUS.COMPLETE) return false;
  const attempts = predecessorStatus.attempts ?? [];
  if (attempts.length !== 1 || attempts[0].status !== STAGE_STATUS.COMPLETE) return false;
  if ((predecessorStatus.retries ?? 0) !== 0 || (predecessorStatus.reruns ?? 0) !== 0) return false;
  if ((destinationStatus?.retries ?? 0) !== 0 || (destinationStatus?.attempts?.length ?? 0) !== 0) return false;
  return true;
}

function sessionResumeForStage(
  stage: StageConfig,
  allStages: StageConfig[],
  state: StoreState,
  runDirPath: string,
  enabled: boolean,
): { sessionId: string; ownerStageId: string } | undefined {
  if (!enabled || stage.depends_on.length !== 1) return undefined;
  const predecessor = allStages.find((candidate) => candidate.id === stage.depends_on[0]);
  if (!predecessor) return undefined;
  const session = readCodexSession(runDirPath, predecessor.id);
  if (!canReuseCodexSession({
    stage,
    predecessor,
    allStages,
    predecessorStatus: state.stages[predecessor.id],
    destinationStatus: state.stages[stage.id],
    session,
  })) return undefined;
  return { sessionId: session!.sessionId, ownerStageId: session!.ownerStageId };
}

export const GATE_VERDICT_CORRECTION_VERSION = 1;

export interface GateVerdictCorrection {
  version: typeof GATE_VERDICT_CORRECTION_VERSION;
  gateId: string;
  previousVerdictWrong: true;
  reason: string;
  evidence: string;
}

export function gateVerdictCorrectionPath(runDirPath: string, gateId: string): string {
  return join(runDirPath, 'gate_reevaluation', `verdict_correction_${gateId}.json`);
}

function readAndConsumeGateVerdictCorrection(runDirPath: string, gateId: string): GateVerdictCorrection | undefined {
  const path = gateVerdictCorrectionPath(runDirPath, gateId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GateVerdictCorrection>;
    if (
      parsed.version !== GATE_VERDICT_CORRECTION_VERSION
      || parsed.gateId !== gateId
      || parsed.previousVerdictWrong !== true
      || typeof parsed.reason !== 'string'
      || !parsed.reason.trim()
      || typeof parsed.evidence !== 'string'
      || !parsed.evidence.trim()
    ) return undefined;
    return parsed as GateVerdictCorrection;
  } catch {
    return undefined;
  } finally {
    // A correction applies to exactly one re-evaluation. Invalid files are also
    // consumed so stale/malformed run-local state cannot poison later rounds.
    try { unlinkSync(path); } catch { /* best effort */ }
  }
}

export function canResumeOwnGateSession(
  stage: StageConfig,
  session: CodexSessionMetadata | undefined,
  previousVerdictWrong: boolean,
): boolean {
  return stage.is_gate === true
    && previousVerdictWrong === false
    && session !== undefined
    && session.ownerStageId === stage.id;
}

function clearGateContinuationArtifacts(runDirPath: string, gateId: string): void {
  try { rmSync(join(runDirPath, 'stages', gateId, 'codex_home'), { recursive: true, force: true }); } catch { /* best effort */ }
  try { unlinkSync(join(runDirPath, 'stages', gateId, 'session.json')); } catch { /* best effort */ }
  try { unlinkSync(gateVerdictCorrectionPath(runDirPath, gateId)); } catch { /* best effort */ }
}

function clearGateContinuationsForStages(runDirPath: string, stages: StageConfig[]): void {
  for (const gate of stages) {
    if (gate.is_gate && stages.some((candidate) => candidate.retry_to?.includes(gate.id))) {
      clearGateContinuationArtifacts(runDirPath, gate.id);
    }
  }
}

function gateContinuationSessionForStage(
  stage: StageConfig,
  runDirPath: string,
  isReevaluation: boolean,
): { sessionId: string; ownerStageId: string } | undefined {
  if (!isReevaluation || stage.is_gate !== true) return undefined;
  const correction = readAndConsumeGateVerdictCorrection(runDirPath, stage.id);
  if (correction) {
    // Persisting a disproved line of reasoning is worse than rebuilding it.
    clearGateContinuationArtifacts(runDirPath, stage.id);
    return undefined;
  }
  const session = readCodexSession(runDirPath, stage.id);
  if (!canResumeOwnGateSession(stage, session, false)) return undefined;
  return { sessionId: session!.sessionId, ownerStageId: stage.id };
}

function shouldPreserveSession(stage: StageConfig, allStages: StageConfig[], enabled: boolean): boolean {
  // Gate continuation is deliberately independent of ordinary predecessor
  // reuse. It retains only this gate's own isolated home when a fix loop can
  // bring the same gate back; validation still never inherits a builder home.
  if (stage.is_gate === true) {
    return allStages.some((candidate) => candidate.retry_to?.includes(stage.id));
  }
  if (!enabled || isValidationStage(stage)) return false;
  // Dynamic children do not exist until this stage returns; retain its home
  // provisionally, then the eligibility check still requires exactly one child.
  return stage.dynamic_dispatch || reusableDirectSuccessors(stage, allStages).length === 1;
}

const REPAIR_DIFF_SKIP_DIRS = new Set([
  '.git', '.fc', 'node_modules', '.cache', '__pycache__', '.venv', 'venv', '.tox', '.gradle',
]);

interface RepairFileImage {
  exists: boolean;
  sha256?: string;
  binary?: boolean;
  text?: string;
  /** In-memory rollback bytes; omitted from serialized audit artifacts. */
  bytes?: Buffer;
  symlink?: boolean;
  type?: 'file' | 'symlink';
  mode?: number;
}

interface RepairFileFingerprint {
  sha256: string;
  type: 'file' | 'symlink';
  mode: number;
}

export interface RepairRoundSnapshot {
  startedAt: string;
  declaredScopes: Record<string, string[] | null>;
  captureAll: boolean;
  /** Full-tree fingerprints detect content, type, and mode changes, including scope escapes. */
  allFileFingerprints: Map<string, RepairFileFingerprint>;
  /** Full preimages make definite unauthorized writes atomically reversible. */
  allFileImages: Map<string, RepairFileImage>;
  files: Map<string, RepairFileImage>;
}

function normalizedProjectPath(value: string): string | undefined {
  const normalized = posix.normalize(value.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return undefined;
  return normalized;
}

function listProjectFiles(projectDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (REPAIR_DIFF_SKIP_DIRS.has(name)) continue;
      const absolute = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) files.push(relative);
        else if (stat.isDirectory()) walk(absolute, relative);
        else if (stat.isFile()) files.push(relative);
      } catch { /* file changed while being enumerated */ }
    }
  };
  walk(projectDir, '');
  return files.sort();
}

function scopeMatchesProjectPath(scope: ParsedScope, path: string): boolean {
  if (scope.kind === 'unknown') return true;
  if (scope.kind === 'glob') {
    // Capturing the complete literal-prefix tree is intentionally conservative:
    // it cannot miss brace/extglob variants that a narrow home-grown matcher would.
    return !scope.directoryPrefix
      || path === scope.directoryPrefix
      || path.startsWith(`${scope.directoryPrefix}/`);
  }
  return path === scope.value || path.startsWith(`${scope.value}/`);
}

function readRepairFileImage(projectDir: string, relativePath: string): RepairFileImage {
  const normalized = normalizedProjectPath(relativePath);
  if (!normalized) return { exists: false };
  const absolute = join(projectDir, normalized);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      const bytes = Buffer.from(target, 'utf-8');
      return {
        exists: true,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        binary: false,
        text: target,
        symlink: true,
        type: 'symlink',
        mode: stat.mode & 0o7777,
      };
    }
    if (!stat.isFile()) return { exists: false };
    const bytes = readFileSync(absolute);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let text: string | undefined;
    if (!bytes.includes(0)) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary/non-UTF8 */ }
    }
    return text === undefined
      ? { exists: true, sha256, binary: true, bytes, type: 'file', mode: stat.mode & 0o7777 }
      : { exists: true, sha256, binary: false, text, type: 'file', mode: stat.mode & 0o7777 };
  } catch {
    return { exists: false };
  }
}

function repairFileFingerprint(image: RepairFileImage): RepairFileFingerprint | undefined {
  if (!image.exists || image.sha256 === undefined || image.type === undefined || image.mode === undefined) return undefined;
  return { sha256: image.sha256, type: image.type, mode: image.mode };
}

function repairFileFingerprintsEqual(
  before: RepairFileFingerprint | undefined,
  after: RepairFileFingerprint | undefined,
): boolean {
  if (before === undefined || after === undefined) return before === after;
  return before.sha256 === after.sha256
    && before.type === after.type
    && before.mode === after.mode;
}

function changedProjectPathsSinceSnapshot(
  snapshot: RepairRoundSnapshot,
  projectDir: string,
): string[] {
  const currentFingerprints = new Map<string, RepairFileFingerprint>();
  for (const path of listProjectFiles(projectDir)) {
    const fingerprint = repairFileFingerprint(readRepairFileImage(projectDir, path));
    if (fingerprint) currentFingerprints.set(path, fingerprint);
  }
  return [...new Set([
    ...snapshot.allFileFingerprints.keys(),
    ...currentFingerprints.keys(),
  ])]
    .sort()
    .filter((path) => !repairFileFingerprintsEqual(
      snapshot.allFileFingerprints.get(path),
      currentFingerprints.get(path),
    ));
}

export function captureRepairRoundSnapshot(projectDir: string, repairStages: StageConfig[]): RepairRoundSnapshot {
  const declaredScopes: Record<string, string[] | null> = {};
  const parsedScopes: ParsedScope[] = [];
  let captureAll = false;
  for (const stage of repairStages) {
    declaredScopes[stage.id] = stage.scope ?? null;
    if (stage.scope === undefined) {
      captureAll = true;
      continue;
    }
    for (const raw of stage.scope) {
      const parsed = parseDeclaredScope(raw);
      parsedScopes.push(parsed);
      if (parsed.kind === 'unknown') captureAll = true;
    }
  }

  const files = new Map<string, RepairFileImage>();
  const allFileFingerprints = new Map<string, RepairFileFingerprint>();
  const allFileImages = new Map<string, RepairFileImage>();
  for (const path of listProjectFiles(projectDir)) {
    const image = readRepairFileImage(projectDir, path);
    const fingerprint = repairFileFingerprint(image);
    if (fingerprint) {
      allFileFingerprints.set(path, fingerprint);
      allFileImages.set(path, image);
    }
    if (captureAll || parsedScopes.some((scope) => scopeMatchesProjectPath(scope, path))) {
      files.set(path, image);
    }
  }
  // Exact paths need an explicit absent preimage so a newly-created file is
  // distinguishable from an out-of-scope write whose preimage was unavailable.
  for (const scope of parsedScopes) {
    if (scope.kind === 'exact' && !files.has(scope.value)) {
      files.set(scope.value, readRepairFileImage(projectDir, scope.value));
    }
  }
  return { startedAt: new Date().toISOString(), declaredScopes, captureAll, allFileFingerprints, allFileImages, files };
}

function restoreProjectPath(
  projectDir: string,
  rawPath: string,
  before: RepairFileImage,
): boolean {
  const normalized = normalizedProjectPath(rawPath);
  if (!normalized) return false;
  const absolute = join(projectDir, normalized);
  try {
    let currentIsDirectory = false;
    try { currentIsDirectory = lstatSync(absolute).isDirectory(); } catch { /* absent */ }
    // Never recursively erase an unexpected directory as part of rollback.
    if (currentIsDirectory) return false;
    if (!before.exists) {
      rmSync(absolute, { force: true });
      return !readRepairFileImage(projectDir, normalized).exists;
    }
    rmSync(absolute, { force: true });
    mkdirSync(dirname(absolute), { recursive: true });
    if (before.symlink) {
      symlinkSync(before.text ?? '', absolute);
    } else {
      writeFileSync(absolute, before.binary ? (before.bytes ?? Buffer.alloc(0)) : (before.text ?? ''));
      if (before.mode !== undefined) chmodSync(absolute, before.mode);
    }
    return repairFileFingerprintsEqual(
      repairFileFingerprint(before),
      repairFileFingerprint(readRepairFileImage(projectDir, normalized)),
    );
  } catch {
    return false;
  }
}

type ScopeRevisionDecision = RuntimeConstraintDecisionV1;

function readScopeRevisionRequest(stagePath: string, runId: string): ScopeRevisionRequestV1 | undefined {
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

function currentStageAttemptIndex(projectDir: string, runId: string, stageId: string): number | undefined {
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

function decideScopeRevision(input: {
  request: ScopeRevisionRequestV1;
  stage: StageConfig;
  priorScope: string[] | null;
  activePeers: StageConfig[];
  projectDir: string;
  runId: string;
  snapshot?: RepairRoundSnapshot;
}): Record<string, unknown> & { accepted: boolean; decision: 'accepted' | 'rejected' } {
  const { request, stage, priorScope, activePeers, projectDir, runId, snapshot } = input;
  if (request.runId !== runId) {
    return scopeRevisionRejection(request, priorScope, `request runId ${request.runId} does not match ${runId}`);
  }
  if (request.stageId !== stage.id) {
    return scopeRevisionRejection(request, priorScope, `request stageId ${request.stageId} does not match ${stage.id}`);
  }
  const attemptIndex = currentStageAttemptIndex(projectDir, runId, stage.id);
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
  const effectiveScope = [...new Set([...(priorScope ?? []), ...requestedPaths])];
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
    const requestedScopes = requestedPaths.map(parseDeclaredScope);
    const changedPath = changedProjectPathsSinceSnapshot(snapshot, projectDir)
      .find((path) => requestedScopes.some((scope) => scopeMatchesProjectPath(scope, path)));
    if (changedPath) {
      return scopeRevisionRejection(request, priorScope, `requested path changed before scope approval: ${changedPath}`);
    }
  }

  // Capture the exact preimage before acknowledging the request. This turns the
  // newly accepted path into first-class repair-diff evidence rather than a
  // post-hoc scope escape with an unavailable preimage.
  if (snapshot) {
    for (const path of requestedPaths) snapshot.files.set(path, readRepairFileImage(projectDir, path));
  }
  return {
    requestedPaths,
    authorizedPaths: requestedPaths,
    accepted: true,
    decision: 'accepted',
    decidedAt: new Date().toISOString(),
    policyBasis: 'current attempt, unchanged preimage, valid project path, and no active-peer scope conflict',
    priorScope,
    effectiveScope,
  };
}

function readScopeRevisionDecisions(runDirPath: string, stageIds: string[]): ScopeRevisionDecision[] {
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

function serializableRepairFileMode(mode: number): string {
  return mode.toString(8).padStart(4, '0');
}

function serializableRepairFileImage(image: RepairFileImage): Record<string, unknown> {
  if (!image.exists) return { exists: false };
  return {
    exists: true,
    sha256: image.sha256,
    binary: image.binary === true,
    type: image.type,
    mode: image.mode === undefined ? undefined : serializableRepairFileMode(image.mode),
    ...(image.symlink ? { symlink: true } : {}),
    ...(image.binary ? {} : { text: image.text ?? '' }),
  };
}

export function writeRepairRoundDiffArtifact(input: {
  snapshot: RepairRoundSnapshot;
  projectDir: string;
  runDirPath: string;
  iteration: number;
  round: number;
  repairStages: StageConfig[];
  statuses: Record<string, StageStatus>;
}): string {
  const { snapshot, projectDir, runDirPath, iteration, round, repairStages, statuses } = input;
  const postScope = captureRepairRoundSnapshot(projectDir, repairStages);
  const writeOwners = new Map<string, Set<string>>();
  for (const stage of repairStages) {
    const { files } = latestAttemptWrites(statuses[stage.id]);
    for (const raw of files) {
      const path = normalizedProjectPath(raw);
      if (!path) continue;
      const owners = writeOwners.get(path) ?? new Set<string>();
      owners.add(stage.id);
      writeOwners.set(path, owners);
    }
  }

  const allPaths = new Set<string>([
    ...snapshot.files.keys(),
    ...postScope.files.keys(),
    ...writeOwners.keys(),
  ]);
  for (const path of new Set([...snapshot.allFileFingerprints.keys(), ...postScope.allFileFingerprints.keys()])) {
    if (!repairFileFingerprintsEqual(
      snapshot.allFileFingerprints.get(path),
      postScope.allFileFingerprints.get(path),
    )) allPaths.add(path);
  }
  const files: Record<string, unknown>[] = [];
  for (const path of [...allPaths].sort()) {
    const before = snapshot.files.get(path);
    const after = readRepairFileImage(projectDir, path);
    const authoritativeOwners = [...(writeOwners.get(path) ?? [])].sort();
    const beforeFingerprint = repairFileFingerprint(before ?? { exists: false })
      ?? snapshot.allFileFingerprints.get(path);
    const afterFingerprint = repairFileFingerprint(after);
    const beforeExisted = before?.exists ?? beforeFingerprint !== undefined;
    const same = beforeExisted === after.exists
      && repairFileFingerprintsEqual(beforeFingerprint, afterFingerprint);
    if (same && authoritativeOwners.length === 0) continue;

    let status: string;
    if (!beforeExisted && after.exists) status = 'added';
    else if (beforeExisted && !after.exists) status = 'deleted';
    else if (same) status = 'reported-touched';
    else status = 'modified';
    const declaredScopeMatch = before !== undefined || postScope.files.has(path);
    const preimageAvailable = before !== undefined || (!beforeExisted && declaredScopeMatch);
    files.push({
      path,
      status,
      preimageAvailable,
      declaredScopeMatch,
      authoritativeWriteStageIds: authoritativeOwners,
      before: before
        ? serializableRepairFileImage(before)
        : beforeExisted
          ? {
              exists: true,
              sha256: beforeFingerprint?.sha256,
              type: beforeFingerprint?.type,
              mode: beforeFingerprint === undefined ? undefined : serializableRepairFileMode(beforeFingerprint.mode),
              contentCaptured: false,
            }
          : { exists: false, contentCaptured: false },
      after: serializableRepairFileImage(after),
      ...(!preimageAvailable ? { note: 'The path was outside the captured declared scope. Its full-tree fingerprint proves the change; the complete postimage is included when present, but preimage content was unavailable.' } : {}),
    });
  }

  const coordinate = gateArchiveCoordinate(iteration, round);
  const artifactDir = canonicalGateRoundArtifactDir(runDirPath, coordinate);
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, 'repair_diff.json');
  const scopeRevisions = readScopeRevisionDecisions(
    runDirPath,
    repairStages.map((stage) => stage.id),
  );
  const effectiveRepairScopes = Object.fromEntries(repairStages.map((stage) => {
    const accepted = scopeRevisions
      .filter((decision) => decision.stageId === stage.id && decision.accepted === true && Array.isArray(decision.effectiveScope))
      .sort((left, right) => left.attemptIndex - right.attemptIndex)
      .at(-1);
    return [stage.id, accepted?.effectiveScope ?? stage.scope ?? []];
  }));
  writeFileSync(artifactPath, JSON.stringify({
    version: 1,
    iteration,
    round,
    truncated: false,
    capturedAt: snapshot.startedAt,
    completedAt: new Date().toISOString(),
    repairStageIds: repairStages.map((stage) => stage.id),
    declaredScopes: snapshot.declaredScopes,
    effectiveScopes: effectiveRepairScopes,
    scopeRevisions,
    authoritativeWrites: [...writeOwners.entries()].map(([path, owners]) => ({ path, stageIds: [...owners].sort() })),
    files,
  }, null, 2) + '\n', 'utf-8');
  return artifactPath;
}

function allDone(state: StoreState): boolean {
  return Object.values(state.stages).every(
    // A skip is a terminal disposition for whole-DAG settlement, but it is not
    // successful production and therefore cannot satisfy a dependency.
    (s) => s.status === STAGE_STATUS.COMPLETE || s.status === STAGE_STATUS.SKIPPED,
  );
}

function gateAttemptCoordinate(iteration: number, innerRetry?: number): GateArchiveCoordinate {
  return gateArchiveCoordinate(iteration, innerRetry === undefined ? 1 : innerRetry + 2);
}

function initializeGateMetricAttempt(
  runDirPath: string,
  stageId: string,
  iteration: number,
  round: number,
  technicalRetry: number,
): void {
  const metricDirectory = join(runDirPath, 'stages', stageId);
  const metricPath = join(metricDirectory, 'metric.json');
  mkdirSync(metricDirectory, { recursive: true });
  if (existsSync(metricPath)) unlinkSync(metricPath);
  writeFileSync(metricPath, JSON.stringify({
    version: 1,
    hasMetric: false,
    reason: 'This gate attempt did not supply a trustworthy numeric campaign metric.',
    source: {
      kind: 'engine_attempt_default',
      iteration,
      round,
      technicalRetry,
    },
  }, null, 2) + '\n', 'utf-8');
}

function appendGateMetricInstruction(
  prompt: string,
  runDirPath: string,
  stageId: string,
  coordinate: GateArchiveCoordinate,
): string {
  const metricPath = join(runDirPath, 'stages', stageId, 'metric.json');
  const durableVerdictPath = archivedGateVerdictWritePath(runDirPath, coordinate, stageId);
  return `${prompt}

## Gate Verdict Evidence Lifetime

Write the live verdict to ${join(runDirPath, `verdict_${stageId}.json`)}. If the verdict rejects,
the scheduler archives that exact attempt after evaluation. Reports must cite the durable archive,
not the live root path that a retry or later iteration clears.

Durable rejected-verdict citation: ${durableVerdictPath}

## Optional Campaign Metric Artifact

If this gate evaluates evidence that contains a numeric campaign metric, write a metric artifact to:

${metricPath}

Use exactly this JSON shape when a trustworthy numeric metric exists:

{
  "hasMetric": true,
  "metric": "metric name",
  "value": 0,
  "higherIsBetter": true,
  "threshold": null,
  "pass": false,
  "source": {
    "path": "path to the evidence file used",
    "evidence": "short exact evidence text"
  },
  "notes": "short explanation"
}

Rules:
- Write this file only from gate stages.
- Do not invent a metric.
- Use only evidence you verified in this gate stage.
- If multiple numeric metrics exist, choose the primary campaign metric stated in the task, workflow, or evidence.
- If no trustworthy numeric campaign metric exists, write:

{
  "hasMetric": false,
  "reason": "No trustworthy numeric campaign metric was found for this gate."
}

- Keep the normal workflow verdict file separate. The workflow verdict remains pass/reason only unless explicitly instructed otherwise.
- If this gate controls a campaign phase, also include phase metadata in the verdict or metric artifact:
  phase, phaseComplete, nextPhase, outcome, artifactSummary, reason.
  This lets future planner iterations use the existing campaign file to continue from the next phase instead of redispatching all phases.
- If you write a metric value, ensure it is a JSON number, not a string.`;
}

function anyFailed(state: StoreState): boolean {
  return Object.values(state.stages).some((s) => s.status === STAGE_STATUS.FAILED);
}

export function loadWorkflow(yamlPath: string): { config: WorkflowConfig; raw: string } {
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw);
  const config = WorkflowConfigSchema.parse(parsed);
  normalizeRetryGateRelationships(config.stages);
  return { config, raw };
}

/** Load _base.md from agents dir and prepend to agent prompt */
export function loadBasePrompt(agentsDir: string): string {
  try {
    return readFileSync(join(agentsDir, '_base.md'), 'utf-8');
  } catch { return ''; }
}

export function applyBasePrompt(agent: AgentConfig, basePrompt: string): AgentConfig {
  if (!basePrompt) return agent;
  return { ...agent, prompt: basePrompt + '\n\n' + agent.prompt };
}

export function buildRoleRegistry(agentsDir: string): Map<string, { name: string; description: string }> {
  const registry = new Map<string, { name: string; description: string }>();
  try {
    const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
    for (const f of files) {
      try {
        const parsed = parseYaml(readFileSync(join(agentsDir, f), 'utf-8'));
        if (parsed?.name) registry.set(parsed.name, { name: parsed.name, description: parsed.description ?? '' });
      } catch { /* skip malformed file */ }
    }
  } catch { /* agents dir may not exist */ }
  return registry;
}

/** List available skills from config/skills/, surfacing each skill's self-described
 * `description:` front-matter (like roles) so the planner sees WHAT each skill is for,
 * not just its name. Falls back to name-only when a skill has no front-matter. */
function listAvailableSkills(projectDir: string): string {
  const skillsDir = join(projectDir, 'config', 'skills');
  try {
    const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return 'none';
    return files.map(f => {
      const name = f.replace('.md', '');
      let desc = '';
      try {
        const head = readFileSync(join(skillsDir, f), 'utf-8').slice(0, 800);
        const fm = head.match(/^---\s*\n([\s\S]*?)\n---/);
        const m = (fm?.[1] ?? '').match(/(?:^|\n)description:\s*(.+)/);
        if (m) desc = m[1].trim().replace(/^["']|["']$/g, '');
      } catch { /* name-only */ }
      return desc ? `- ${name}: ${desc}` : `- ${name}`;
    }).join('\n');
  } catch { return 'none'; }
}

export function parseDispatchBlock(
  output: string,
  roleRegistry: Map<string, { name: string; description: string }>,
): StageConfig[] {
  // Strip diff-format line prefixes (e.g. "  123, 150: " or "+      148: " or "- 143     : ")
  const cleaned = output.replace(/^[-+ ] *\d*[, ]*\d* *: /gm, '');
  const match = cleaned.match(/## DISPATCH\s*\n```(?:yaml)?\s*\n([\s\S]*?)```/);
  if (!match) return [];
  const items = parseYaml(match[1]);
  if (!Array.isArray(items)) return [];
  const stages: StageConfig[] = [];
  const seenIds = new Set<string>();
  let refused = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') { refused = true; continue; }
    if (seenIds.has(item.id)) {
      log.warn({ id: item.id }, 'Duplicate stage ID in DISPATCH block, skipping');
      refused = true;
      continue;
    }
    if (!roleRegistry.has(item.role)) {
      log.warn({ role: item.role, id: item.id }, 'Unknown role in DISPATCH block, skipping');
      refused = true;
      continue;
    }
    try {
      // Bug 2: map task: to prompt_template: if planner used that format
      if (item.task && !item.prompt_template) {
        item.prompt_template = item.task;
        delete item.task;
      }
      stages.push(parseDispatchedStageConfig(item));
      seenIds.add(item.id);
    } catch (error) { /* non-critical */
      refused = true;
      log.warn({ id: item.id, diagnostic: formatDispatchStageSchemaFailure(error) }, 'Invalid stage in DISPATCH block');
    }
  }
  return refused ? [] : stages;
}

export function resolveDispatchDependencies(dispatched: StageConfig[], _dispatchStageId: string): void {
  // Compatibility export retained for callers compiled against older builds.
  // Dynamic dependencies are now admitted exactly as authored; the framework
  // no longer expands pseudo-edges or inserts planner edges behind the plan's
  // back. Strict parsing/admission reports malformed or unknown dependencies.
  void dispatched;
}

/** Collect all stage IDs that transitively depend on the given stage */
export function collectTransitiveDependents(stageId: string, stages: StageConfig[]): Set<string> {
  const dependents = new Set<string>();
  const queue = [stageId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const s of stages) {
      if (!dependents.has(s.id) && s.id !== stageId && s.depends_on.includes(current)) {
        dependents.add(s.id);
        queue.push(s.id);
      }
    }
  }
  return dependents;
}

/** BFS: find all stages that transitively depend on stageId (returns array of IDs) */
export function findDownstream(stageId: string, stages: StageConfig[]): string[] {
  return [...collectTransitiveDependents(stageId, stages)];
}

/** Preserve bounded Zod paths and a repair action in planner-facing schema refusals. */
export function formatDispatchStageSchemaFailure(error: unknown): string {
  const issues = error instanceof z.ZodError
    ? error.issues.slice(0, 8).map((issue) =>
        `${issue.path.length > 0 ? issue.path.join('.') : '(stage root)'}: ${issue.message}`)
    : [error instanceof Error ? error.message : String(error)];
  const omitted = error instanceof z.ZodError ? error.issues.length - issues.length : 0;
  return `invalid schema at ${issues.join('; ')}${omitted > 0 ? ` (+${omitted} more)` : ''}; fix the named fields and regenerate dispatch.yaml`;
}

interface DispatchAdmissionReport {
  version: 1;
  pass: boolean;
  checkedAt: string;
  errors: string[];
  terminalOwners: Record<string, string>;
  criteriaDigest?: string;
  criterionGateRefs?: Record<string, string[]>;
}

function readBriefCriteriaForAdmission(runDirPath: string): BriefCriteriaArtifact | undefined {
  const path = join(runDirPath, 'brief_criteria.json');
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BriefCriteriaArtifact;
  if (parsed.version !== 1 || typeof parsed.briefDigest !== 'string' || !Array.isArray(parsed.criteria)) {
    throw new Error('brief_criteria.json has an invalid shape');
  }
  const briefPath = join(runDirPath, 'task_brief.md');
  if (existsSync(briefPath)) {
    const currentDigest = createHash('sha256').update(readFileSync(briefPath, 'utf-8'), 'utf8').digest('hex');
    if (currentDigest !== parsed.briefDigest) throw new Error('brief_criteria.json digest does not match task_brief.md');
  }
  return parsed;
}

function dispatchGlobRegex(raw: string): RegExp | undefined {
  const normalized = normalizedProjectPath(raw);
  if (!normalized) return undefined;
  const globstarSentinel = '__FLOWCREW_GLOBSTAR__';
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, globstarSentinel)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll(globstarSentinel, '.*');
  try { return new RegExp(`^${escaped}$`); } catch { return undefined; }
}

function stageScopeOwnsPath(stage: StageConfig, rawPath: string): boolean {
  const path = normalizedProjectPath(rawPath);
  if (!path || !stage.scope) return false;
  return stage.scope.some((rawScope) => {
    const scope = parseDeclaredScope(rawScope);
    if (scope.kind === 'exact') return scope.value === path;
    if (scope.kind === 'tree') return scope.value === path || path.startsWith(`${scope.value}/`);
    if (scope.kind === 'glob') return dispatchGlobRegex(rawScope)?.test(path) === true;
    return false;
  });
}

function transitivelyDependsOn(stageId: string, ancestorId: string, byId: ReadonlyMap<string, StageConfig>): boolean {
  const seen = new Set<string>();
  const queue = [...(byId.get(stageId)?.depends_on ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === ancestorId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(byId.get(current)?.depends_on ?? []));
  }
  return false;
}

export function inspectDispatchAdmission(input: {
  dispatched: StageConfig[];
  baseStages: StageConfig[];
  dispatchStageId: string;
  terminalStates?: TerminalStatesConfig;
  research?: ResearchConfig;
  criteria?: BriefCriteriaArtifact;
}): DispatchAdmissionReport {
  const errors: string[] = [];
  const all = [...input.baseStages, ...input.dispatched];
  const byId = new Map(all.map((stage) => [stage.id, stage]));
  const knownIds = new Set(byId.keys());

  for (const stage of input.dispatched) {
    if (input.research && stage.id === 'research') {
      errors.push(`${stage.id}.id: reserved for framework-owned research policy facts; choose a different stage ID`);
    }
    for (const [index, scope] of (stage.scope ?? []).entries()) {
      const parsed = parseDeclaredScope(scope);
      if (parsed.kind === 'unknown') errors.push(`${stage.id}.scope.${index}: ${parsed.reason}`);
    }
    for (const dependency of stage.depends_on) {
      if (dependency === stage.id) errors.push(`${stage.id}.depends_on: self dependency is forbidden`);
      else if (!knownIds.has(dependency)) {
        errors.push(`${stage.id}.depends_on: unknown stage ${JSON.stringify(dependency)}`);
      }
    }
    if (stage.retry_to?.length) {
      const retrySet = new Set(stage.retry_to);
      for (const gateId of retrySet) {
        const gate = byId.get(gateId);
        if (!gate) errors.push(`${stage.id}.retry_to: unknown gate ${JSON.stringify(gateId)}`);
        else if (gate.is_gate !== true) errors.push(`${stage.id}.retry_to: ${gateId} is not declared is_gate: true`);
        if (!stage.depends_on.includes(gateId)) errors.push(`${stage.id}.depends_on: missing retry gate ${gateId}`);
      }
      const retryGateDeps = stage.depends_on.filter((dependency) => byId.get(dependency)?.is_gate === true);
      for (const gateId of retryGateDeps) {
        if (!retrySet.has(gateId)) errors.push(`${stage.id}.retry_to: missing gate dependency ${gateId}`);
      }
    }
  }

  // Refuse cycles instead of rewriting their edges.
  for (const stage of input.dispatched) {
    if (transitivelyDependsOn(stage.id, stage.id, byId)) errors.push(`${stage.id}.depends_on: dependency cycle detected`);
  }

  const terminalOwners: Record<string, string> = {};
  const ownerIds = new Set<string>();
  const terminalDeclarations = Object.entries(input.terminalStates ?? {})
    .flatMap(([status, entry]) => entry.paths.map((path) => ({ status, path })));
  const declaredTerminalPaths = new Set(terminalDeclarations
    .map((entry) => normalizedProjectPath(entry.path))
    .filter((path): path is string => Boolean(path)));
  const declaredTerminalEvidenceGlobs = Object.values(input.terminalStates ?? {}).flatMap((entry) => {
    if (entry.floor?.minAttemptedStages === undefined) return [];
    if (entry.stageGlob) return [entry.stageGlob];
    const first = entry.paths[0];
    if (!first) return [];
    const normalized = normalizedProjectPath(first);
    if (!normalized) return [];
    const directory = posix.dirname(normalized);
    return [`${directory === '.' ? '' : `${directory}/`}stage_*_verdict.md`];
  });
  const declarationsByPath = new Map<string, Array<{ status: string; path: string }>>();
  const declarationsByBasename = new Map<string, Array<{ status: string; path: string }>>();
  for (const declaration of terminalDeclarations) {
    const normalized = normalizedProjectPath(declaration.path) ?? declaration.path;
    const pathRows = declarationsByPath.get(normalized) ?? [];
    pathRows.push(declaration);
    declarationsByPath.set(normalized, pathRows);
    const basename = posix.basename(normalized.replace(/\\/g, '/'));
    const basenameRows = declarationsByBasename.get(basename) ?? [];
    basenameRows.push(declaration);
    declarationsByBasename.set(basename, basenameRows);
  }
  for (const [path, declarations] of declarationsByPath) {
    if (declarations.length > 1) {
      errors.push(`terminal_states path ${path}: declared more than once (${declarations.map((item) => item.status).join(', ')}); one path cannot encode multiple outcomes`);
    }
  }
  for (const [basename, declarations] of declarationsByBasename) {
    const paths = [...new Set(declarations.map((item) => normalizedProjectPath(item.path) ?? item.path))];
    if (paths.length > 1) {
      errors.push(`terminal_states snapshot basename ${basename}: collides across ${paths.join(', ')}; terminal recovery requires unique basenames`);
    }
  }
  for (const entry of Object.values(input.terminalStates ?? {})) {
    for (const rawPath of entry.paths) {
      const owners = input.dispatched.filter((stage) => stageScopeOwnsPath(stage, rawPath));
      if (owners.length !== 1) {
        errors.push(`terminal_states path ${rawPath}: expected exactly one scoped owner, found ${owners.length}${owners.length ? ` (${owners.map((stage) => stage.id).join(', ')})` : ''}`);
        continue;
      }
      const owner = owners[0];
      terminalOwners[rawPath] = owner.id;
      ownerIds.add(owner.id);
      if (owner.is_gate || owner.retry_to?.length) errors.push(`terminal owner ${owner.id}: must be a non-gate, non-repair stage`);
      const nonTerminalScopes = (owner.scope ?? []).filter((scope) => {
        const normalized = normalizedProjectPath(scope);
        if (!normalized || declaredTerminalPaths.has(normalized)) return !normalized;
        return !declaredTerminalEvidenceGlobs.some((glob) => {
          const normalizedGlob = normalizedProjectPath(glob);
          if (!normalizedGlob) return false;
          if (normalized === normalizedGlob) return true;
          return !/[?*]/.test(normalized) && dispatchGlobRegex(glob)?.test(normalized) === true;
        });
      });
      if (nonTerminalScopes.length > 0) {
        errors.push(`terminal owner ${owner.id}.scope: terminal finalizers may write only exact declared terminal paths or declared floor-evidence paths; remove ${nonTerminalScopes.join(', ')}`);
      }
      const dependents = input.dispatched.filter((stage) => stage.depends_on.includes(owner.id));
      if (dependents.length > 0) errors.push(`terminal owner ${owner.id}: must be a DAG sink; depended on by ${dependents.map((stage) => stage.id).join(', ')}`);
      if (input.research && owner.condition?.replace(/\s+/g, ' ').trim() !== 'research.decision != continue') {
        errors.push(`terminal owner ${owner.id}.condition: research finalizers must use "research.decision != continue" so policy continue cannot force a terminal write`);
      }
      for (const required of input.dispatched) {
        if (required.id === owner.id || required.condition?.trim() || (!required.is_gate && required.retry_to?.length)) continue;
        if (!transitivelyDependsOn(owner.id, required.id, byId)) {
          errors.push(`terminal owner ${owner.id}.depends_on: mandatory stage ${required.id} is not an ancestor`);
        }
      }
    }
  }
  if (ownerIds.size > 1) errors.push(`terminal_states: all terminal paths must share one owner stage; found ${[...ownerIds].join(', ')}`);

  const criteria = input.criteria?.criteria ?? [];
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  for (const stage of input.dispatched) {
    for (const ref of stage.criterion_refs ?? []) {
      if (!criterionIds.has(ref)) errors.push(`${stage.id}.criterion_refs: unknown criterion ${JSON.stringify(ref)}`);
    }
  }
  for (const criterion of criteria) {
    const workers = input.dispatched.filter((stage) => !stage.is_gate && !stage.retry_to?.length && stage.criterion_refs.includes(criterion.id));
    const gates = input.dispatched.filter((stage) => stage.is_gate && stage.criterion_refs.includes(criterion.id));
    if (workers.length === 0) errors.push(`criterion ${criterion.id}: not assigned to a capable work/finalizer stage`);
    if (gates.length === 0) errors.push(`criterion ${criterion.id}: not assigned to a gate`);
    else if (workers.length > 0 && !gates.some((gate) => workers.some((worker) => transitivelyDependsOn(gate.id, worker.id, byId)))) {
      errors.push(`criterion ${criterion.id}: no assigned gate is downstream of an assigned work stage`);
    }
  }

  return {
    version: 1,
    pass: errors.length === 0,
    checkedAt: new Date().toISOString(),
    errors,
    terminalOwners,
    criterionGateRefs: Object.fromEntries(
      input.dispatched
        .filter((stage) => stage.is_gate && stage.criterion_refs.length > 0)
        .map((stage) => [stage.id, [...stage.criterion_refs]]),
    ),
    ...(input.criteria ? { criteriaDigest: input.criteria.briefDigest } : {}),
  };
}

function addRealityCheckLiteralPath(value: string, out: Set<string>): void {
  const candidate = normalizedProjectPath(value);
  if (candidate
      && !/[\s$<>{}|;&]/.test(value)
      && (candidate.includes('/') || /\.[A-Za-z0-9]{1,12}$/.test(candidate))) {
    out.add(candidate);
  }
}

function realityCheckScriptLiteralPaths(script: string, out: Set<string>): void {
  // Shell scripts commonly leave simple file operands unquoted (`test -s
  // docs/report.json`). Tokenize only literal words: quoted values are handled
  // separately below, and anything containing expansion syntax stays dynamic.
  for (const rawToken of script.split(/[\s;|&()<>]+/)) {
    if (!rawToken) continue;
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(rawToken);
    const token = (assignment?.[1] ?? rawToken)
      .replace(/^["'`]+|["'`,:]+$/g, '');
    if (!token
        || !/^(?:\.\.?\/)?[A-Za-z0-9_.@%+-]+(?:\/[A-Za-z0-9_.@%+-]+)*$/.test(token)
        || /[$*?[\]]/.test(token)
        || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) continue;
    addRealityCheckLiteralPath(token, out);
  }
}

function realityCheckLiteralPaths(value: unknown, out: Set<string>, field?: string): void {
  if (typeof value === 'string') {
    addRealityCheckLiteralPath(value, out);
    // Exec checks carry their paths inside a script string rather than a
    // structured `file:` field. Extract only literal quote/assignment tokens;
    // variables, substitutions, commands, and prose remain deliberately
    // uninterpreted so reachability never guesses a dynamic path.
    for (const match of value.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`/g)) {
      addRealityCheckLiteralPath(match[1] ?? match[2] ?? match[3] ?? '', out);
    }
    if (field === 'script') realityCheckScriptLiteralPaths(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) realityCheckLiteralPaths(item, out, field);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    realityCheckLiteralPaths(nested, out, key);
  }
}

/** A hard reality check may reference an absent future artifact only when an
 * admitted stage or framework output contract can produce it before terminal
 * verification. */
export function inspectRealityCheckReachability(input: {
  markdown: string;
  projectDir: string;
  stages: StageConfig[];
  terminalStates?: TerminalStatesConfig;
  research?: ResearchConfig;
}): string[] {
  const allowedFrameworkPaths = new Set<string>();
  const optionalResearchResultPath = input.research
    ? normalizedProjectPath(input.research.resultFile ?? 'docs/research_round_result.json')
    : undefined;
  if (input.research) {
    allowedFrameworkPaths.add(normalizedProjectPath(join(input.research.reportDir ?? 'docs', 'run_manifest.json')) ?? '');
  }
  const terminalPaths = new Set(
    Object.values(input.terminalStates ?? {}).flatMap((entry) => entry.paths)
      .map((path) => normalizedProjectPath(path))
      .filter((path): path is string => Boolean(path)),
  );
  const byId = new Map(input.stages.map((stage) => [stage.id, stage]));
  const terminalOwners = [...terminalPaths].flatMap((path) => {
    const owners = input.stages.filter((stage) => stageScopeOwnsPath(stage, path));
    return owners.length === 1 ? owners : [];
  });
  const errors: string[] = [];
  for (const check of parseChecksFromMarkdown(input.markdown)) {
    if (check.kind === 'invalid' || check.advisory === true) continue;
    const paths = new Set<string>();
    realityCheckLiteralPaths(check.params, paths);
    for (const path of paths) {
      const producers = input.stages.filter((stage) => stageScopeOwnsPath(stage, path));
      if (optionalResearchResultPath === path) {
        // Stage reachability cannot make this artifact mandatory: the admitted
        // research protocol lets the same stage emit only the no-candidate
        // sidecar. Hard checks must target the framework's always-emitted
        // manifest instead of assuming which branch the stage will take.
        errors.push(`reality check ${JSON.stringify(check.name)} references mutable optional result path ${path}; a valid no-candidate round writes only its sidecar, so check the framework-emitted run_manifest.json instead`);
        continue;
      }
      if (allowedFrameworkPaths.has(path) || existsSync(join(input.projectDir, path))) continue;
      if (producers.length === 0) {
        errors.push(`reality check ${JSON.stringify(check.name)} references absent ${path}, but no admitted stage or framework emitter owns it`);
        continue;
      }
      if (terminalPaths.has(path)) {
        // The unified terminal evaluator materializes the finalizer's candidate
        // before running hard checks. Admission still requires the path to have
        // exactly one owner; a mere terminal declaration is not an emitter.
        if (producers.length !== 1) {
          errors.push(`reality check ${JSON.stringify(check.name)} references terminal path ${path}, but it has ${producers.length} admitted owners`);
        }
        continue;
      }
      if (terminalOwners.length > 0) {
        const reachesEveryFinalizer = producers.some((producer) => terminalOwners.every((owner) => (
          producer.id === owner.id || transitivelyDependsOn(owner.id, producer.id, byId)
        )));
        if (!reachesEveryFinalizer) {
          errors.push(`reality check ${JSON.stringify(check.name)} references absent ${path}, but no producer is an ancestor of every terminal owner`);
        }
      } else {
        const mandatoryProducer = producers.some((producer) => (
          !producer.condition?.trim() && (producer.is_gate || !producer.retry_to?.length)
        ));
        if (!mandatoryProducer) {
          errors.push(`reality check ${JSON.stringify(check.name)} references absent ${path}, but every producer is conditional or repair-only`);
        }
      }
    }
  }
  return errors;
}

/**
 * Read dispatch.yaml from the run directory (or project docs/), parse it,
 * validate stage configs, resolve dependencies, inject into the running workflow,
 * and mark replaced static stages as skipped.
 */
function injectDispatchedStages(
  dispatchStageId: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  sorted: StageConfig[],
  state: StoreState,
  projectDir: string,
  runId: string,
): StageConfig[] {
  // Read dispatch.yaml from run dir
  const runDirPath = runDir(projectDir, runId);
  const dispatchPath = join(runDirPath, 'dispatch.yaml');
  if (!existsSync(dispatchPath)) return [];

  let items: unknown;
  try {
    items = parseYaml(readFileSync(dispatchPath, 'utf-8'));
  } catch { /* non-critical */
    log.warn('Failed to parse dispatch.yaml');
    return [];
  }
  // Accept both bare list and {stages: [...]} wrapper
  let itemList: unknown[];
  if (Array.isArray(items)) {
    itemList = items;
  } else if (items && typeof items === 'object' && Array.isArray((items as Record<string, unknown>).stages)) {
    itemList = (items as Record<string, unknown>).stages as unknown[];
  } else {
    return [];
  }

  const dispatched: StageConfig[] = [];
  const skippedReasons: string[] = [];
  const seenIds = new Set<string>(sorted.map(s => s.id));
  for (let i = 0; i < itemList.length; i++) {
    const item = itemList[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') {
      skippedReasons.push(`${i}: stage item must be an object`);
      continue;
    }
    if (seenIds.has(item.id as string)) {
      skippedReasons.push(`${item.id}: duplicate stage ID; rename this stage to a unique ID and update its dependency references`);
      log.warn({ id: item.id }, 'Duplicate stage ID in dispatch.yaml; refusing the whole proposal');
      continue;
    }
    if (!roleRegistry.has(item.role as string)) {
      skippedReasons.push(`${item.id}: unknown role "${item.role}"; replace it with one of the available configured roles`);
      log.warn({ role: item.role, id: item.id }, 'Unknown role in dispatch.yaml; refusing the whole proposal');
      continue;
    }
    // Map task: to prompt_template:
    if (item.task && !item.prompt_template) {
      item.prompt_template = item.task;
      delete item.task;
    }
    try {
      dispatched.push(parseDispatchedStageConfig(item));
      seenIds.add(item.id as string);
    } catch (error) {
      const diagnostic = formatDispatchStageSchemaFailure(error);
      skippedReasons.push(`${item.id}: ${diagnostic}`);
      log.warn({ id: item.id, diagnostic }, 'Invalid stage in dispatch.yaml; refusing the whole proposal');
    }
  }
  if (dispatched.length === 0 || skippedReasons.length > 0) {
    const report: DispatchAdmissionReport = {
      version: 1,
      pass: false,
      checkedAt: new Date().toISOString(),
      errors: skippedReasons.length > 0 ? skippedReasons : ['dispatch contains no stages'],
      terminalOwners: {},
    };
    writeFileSync(join(runDirPath, 'dispatch_admission.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    log.warn({ errors: report.errors }, 'Dynamic dispatch refused before any proposed stage was injected');
    return [];
  }

  resolveDispatchDependencies(dispatched, dispatchStageId);
  let criteria: BriefCriteriaArtifact | undefined;
  try {
    criteria = readBriefCriteriaForAdmission(runDirPath);
  } catch (error) {
    const report: DispatchAdmissionReport = {
      version: 1,
      pass: false,
      checkedAt: new Date().toISOString(),
      errors: [error instanceof Error ? error.message : String(error)],
      terminalOwners: {},
    };
    writeFileSync(join(runDirPath, 'dispatch_admission.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    return [];
  }
  const admission = inspectDispatchAdmission({
    dispatched,
    baseStages: sorted,
    dispatchStageId,
    terminalStates: state.terminalStates,
    research: state.research,
    criteria,
  });
  if (admission.pass) {
    const checksPath = join(runDirPath, 'reality_checks.md');
    if (existsSync(checksPath)) {
      const reachabilityErrors = inspectRealityCheckReachability({
        markdown: readFileSync(checksPath, 'utf-8'),
        projectDir,
        stages: dispatched,
        terminalStates: state.terminalStates,
        research: state.research,
      });
      if (reachabilityErrors.length > 0) {
        admission.pass = false;
        admission.errors.push(...reachabilityErrors);
      }
    }
  }
  writeFileSync(join(runDirPath, 'dispatch_admission.json'), `${JSON.stringify(admission, null, 2)}\n`, 'utf-8');
  if (!admission.pass) {
    log.warn({ errors: admission.errors }, 'Dynamic dispatch topology refused before stage injection');
    return [];
  }

  applyScopePlanningDispositions(runDirPath, state.currentIteration ?? 1, items, dispatched);

  // Create stage directories and add to state (preserve existing status for
  // same-iteration reruns). A same-ID stage from an outer replacement is new
  // active work: its old live aliases were archived at the iteration boundary
  // and must not seed or suppress this execution.
  for (const s of dispatched) {
    mkdirSync(stageDir(projectDir, runId, s.id), { recursive: true });
    if (!state.stages[s.id]) {
      const pending: StageStatus = { status: STAGE_STATUS.PENDING, retries: 0 };
      if (state.stageEvidence?.some((entry) => entry.stageId === s.id)) {
        resetStageLiveAttemptAliases(projectDir, runId, s.id, pending);
      }
      state.stages[s.id] = pending;
    }
  }

  // Mark static stages that transitively depend on dispatch stage as skipped
  const transitive = collectTransitiveDependents(dispatchStageId, sorted);
  for (const id of transitive) {
    if (state.stages[id] && isPendingStageStatus(state.stages[id].status)) {
      state.stages[id] = { status: STAGE_STATUS.SKIPPED, retries: 0 };
      log.info({ stage: id }, 'Skipped (replaced by dispatched stages)');
    }
  }

  // Add dispatched stages to sorted list
  sorted.push(...dispatched);

  // Update stored workflow.yaml
  const wfPath = join(runDir(projectDir, runId), 'workflow.yaml');
  try {
    const wfRaw = readFileSync(wfPath, 'utf-8');
    const wfParsed = parseYaml(wfRaw) ?? {};
    if (!Array.isArray(wfParsed.stages)) wfParsed.stages = [];
    for (const s of dispatched) wfParsed.stages.push({
      id: s.id,
      role: s.role,
      scope: s.scope,
      depends_on: s.depends_on,
      dependency_reasons: s.dependency_reasons,
      condition: s.condition,
      prompt_template: s.prompt_template,
      skills: s.skills.length ? s.skills : undefined,
      dynamic_dispatch: s.dynamic_dispatch || undefined,
      is_gate: s.is_gate || undefined,
      retry_to: s.retry_to?.length ? s.retry_to : undefined,
      criterion_refs: s.criterion_refs.length ? s.criterion_refs : undefined,
    });
    writeFileSync(wfPath, stringifyYaml(wfParsed), 'utf-8');
  } catch { /* best effort */ }

  state.dispatchedStages = dispatched;
  // Auto-execute: planner output runs immediately, no manual approval gate.
  // The dashboard's "Plan Review" tab still renders the DAG for inspection,
  // but execution does not block on user click. The legacy `awaiting_approval`
  // status and the dashboard's `/approve` endpoint remain available for
  // backward compatibility (older runs may still be in that state), but new
  // runs never enter it.
  writeRunState(projectDir, runId, state);

  return dispatched;
}

export function appendIterationLog(
  projectDir: string,
  runId: string,
  iteration: number,
  state: StoreState,
  dispatchedStageIds: string[],
  baseStageIds?: string[],
  innerRetriesUsed?: number,
  maxInnerRetries?: number,
): void {
  const runDirPath = runDir(projectDir, runId);
  const logPath = join(runDirPath, 'iteration_log.md');
  mkdirSync(runDirPath, { recursive: true });
  const lines: string[] = [`# Iteration ${iteration}`];
  if (innerRetriesUsed !== undefined && maxInnerRetries !== undefined && maxInnerRetries > 0) {
    lines.push(`Fix→gate retries used: ${innerRetriesUsed}/${maxInnerRetries}`);
  }
  // Include base stages (e.g. plan) so re-plan iterations have context on failures
  const allIds = [...(baseStageIds ?? []), ...dispatchedStageIds];
  const seen = new Set<string>();
  for (const sid of allIds) {
    if (seen.has(sid)) continue;
    seen.add(sid);
    const ss = state.stages[sid];
    if (!ss) continue;
    lines.push(`## ${sid} (${ss.status})`);
    lines.push(`Output: ${runDirPath}/stages/${sid}/output.md`);
    lines.push(`Artifacts: ${ss.artifacts?.join(', ') || 'none'}`);
    if (ss.error) {
      const isAdapter = ss.error === 'adapter connection failed';
      lines.push(`Error: ${ss.error}${isAdapter ? ' (transient — not a code issue, retry may succeed)' : ''}`);
    }
    if (ss.duration_ms !== undefined) lines.push(`Duration: ${Math.round(ss.duration_ms / 1000)}s`);
    // Include actual gate verdict if available
    const verdict = readGateVerdict(projectDir, sid, runId);
    if (verdict) {
      lines.push(`Gate verdict: ${verdict.pass ? 'PASS' : 'FAIL'}${verdict.reason ? ' — ' + verdict.reason : ''}`);
    }
    // Include campaign metric if available
    const metricLookup = parseGateMetric(projectDir, state, sid);
    if (metricLookup.metric) {
      const m = metricLookup.metric;
      lines.push(`Metric: ${m.metric} = ${m.score}${m.threshold !== undefined ? ` (threshold: ${m.threshold})` : ''}`);
    }
  }
  const pendingScope = pendingScopePlanningInputs(runDirPath);
  if (pendingScope.length > 0) {
    lines.push('## Pending scope-negotiation planning input');
    for (const entry of pendingScope) {
      lines.push(`- ${entry.digest}: ${entry.stageKind} requested ${entry.requestedPaths.join(', ')}; ${entry.rejectionReason}`);
    }
  }
  lines.push('');
  const content = lines.join('\n');
  if (existsSync(logPath)) {
    const existing = readFileSync(logPath, 'utf-8');
    writeFileSync(logPath, existing + '\n' + content, 'utf-8');
  } else {
    writeFileSync(logPath, content, 'utf-8');
  }
}

/** Persist the latest scored and/or phase campaign entry for the current run iteration. */
export function writeCampaignEntry(projectDir: string, state: StoreState): void {
  const campaignStorageKey = resolveCampaignStorageKey({
    campaignId: state.campaignId,
    campaignStorageKey: state.campaignStorageKey,
    campaignName: state.campaignName,
  });
  if (!campaignStorageKey) return;
  const campaignsDir = join(projectDir, '.fc', 'campaigns');
  mkdirSync(campaignsDir, { recursive: true });
  const filePath = join(campaignsDir, `${campaignStorageKey}.jsonl`);
  const runPath = runDir(projectDir, state.runId);
  const metric = findCampaignMetric(projectDir, state);
  const phase = findCampaignPhaseMetadata(projectDir, state);
  if (!metric && !phase) return;
  let gatesPassed = 0;
  let gatesTotal = 0;
  try {
    const files = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const v = JSON.parse(readFileSync(join(runPath, f), 'utf-8'));
        if (typeof v.pass === 'boolean') { gatesTotal++; if (v.pass) gatesPassed++; }
      } catch { /* skip */ }
    }
  } catch { /* no verdicts */ }
  const entry: Record<string, unknown> = {
    seq: state.campaignSeq ?? 1,
    runId: state.runId,
    iteration: state.currentIteration ?? 1,
    gate: metric?.gate ?? phase?.gate ?? 'campaign_phase',
    pass: metric?.pass ?? phase?.pass ?? false,
    gates: `${gatesPassed}/${gatesTotal}`,
    status: state.status,
    timestamp: new Date().toISOString(),
    campaignId: canonicalCampaignId(state.campaignId ?? state.campaignName ?? campaignStorageKey)
      ?? campaignStorageKey,
    campaignStorageKey,
    campaignName: state.campaignName,
  };
  const terminalStudyComplete = metric ? readTerminalStudyCompletionEvidence(projectDir, state.runId, metric.gate) : null;
  if (terminalStudyComplete) {
    entry.pass = true;
    entry.status = 'complete';
    entry.gates = '1/1';
    entry.workflowSatisfied = true;
    entry.terminalStudyComplete = true;
    entry.modelPass = false;
    entry.modelSuccess = false;
    entry.outcome = 'study_complete_without_model_success';
  }
  if (metric) {
    entry.score = metric.score;
    entry.metric = metric.metric;
    entry.threshold = metric.threshold;
  }
  if (phase?.phase) entry.phase = phase.phase;
  if (typeof phase?.phaseComplete === 'boolean') entry.phaseComplete = phase.phaseComplete;
  if (phase?.nextPhase) entry.nextPhase = phase.nextPhase;
  if (phase?.outcome) entry.outcome = phase.outcome;
  if (phase?.artifactSummary) entry.artifactSummary = phase.artifactSummary;
  if (phase?.reason) entry.reason = phase.reason;
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

function parseGateMetric(projectDir: string, state: StoreState, gateId: string): GateMetricLookup {
  const metricPath = join(stageDir(projectDir, state.runId, gateId), 'metric.json');
  if (!existsSync(metricPath)) return { found: false, metric: null };
  try {
    const artifact = JSON.parse(readFileSync(metricPath, 'utf-8'));
    if (artifact?.hasMetric !== true) return { found: true, metric: null };
    if (typeof artifact.value !== 'number' || !Number.isFinite(artifact.value)) return { found: true, metric: null };
    return {
      found: true,
      metric: {
        score: artifact.value,
        metric: typeof artifact.metric === 'string' ? artifact.metric : '',
        gate: gateId,
        pass: artifact.pass === true,
        threshold: typeof artifact.threshold === 'number' && Number.isFinite(artifact.threshold) ? artifact.threshold : undefined,
      },
    };
  } catch { /* non-critical */
    return { found: true, metric: null };
  }
}

function parseLegacyVerdictMetric(projectDir: string, state: StoreState, gateId: string): CampaignMetric | null {
  const verdictPath = join(runDir(projectDir, state.runId), `verdict_${gateId}.json`);
  try {
    const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
    const value = typeof verdict.score === 'number' && Number.isFinite(verdict.score)
      ? verdict.score
      : typeof verdict.value === 'number' && Number.isFinite(verdict.value)
        ? verdict.value
        : undefined;
    if (value === undefined) return null;
    return {
      score: value,
      metric: typeof verdict.metric === 'string' ? verdict.metric : '',
      gate: gateId,
      pass: verdict.pass === true,
      threshold: typeof verdict.threshold === 'number' && Number.isFinite(verdict.threshold) ? verdict.threshold : undefined,
    };
  } catch { /* non-critical */
    return null;
  }
}

function phaseMetadataFromArtifact(artifact: unknown, gateId: string): CampaignPhaseMetadata | null {
  if (!artifact || typeof artifact !== 'object') return null;
  const record = artifact as Record<string, unknown>;
  const phase = typeof record.phase === 'string' ? record.phase : undefined;
  const nextPhase = typeof record.nextPhase === 'string'
    ? record.nextPhase
    : typeof record.next_phase === 'string'
      ? record.next_phase
      : undefined;
  const outcome = typeof record.outcome === 'string' ? record.outcome : undefined;
  const artifactSummary = typeof record.artifactSummary === 'string'
    ? record.artifactSummary
    : typeof record.artifact_summary === 'string'
      ? record.artifact_summary
      : undefined;
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const phaseComplete = typeof record.phaseComplete === 'boolean'
    ? record.phaseComplete
    : typeof record.phase_complete === 'boolean'
      ? record.phase_complete
      : undefined;
  const hasPhaseMetadata = phase !== undefined
    || nextPhase !== undefined
    || outcome !== undefined
    || artifactSummary !== undefined
    || phaseComplete !== undefined;
  if (!hasPhaseMetadata) return null;
  return {
    gate: gateId,
    pass: record.pass === true,
    phase,
    phaseComplete,
    nextPhase,
    outcome,
    artifactSummary,
    reason,
  };
}

function parseGatePhaseMetadata(projectDir: string, state: StoreState, gateId: string): CampaignPhaseMetadata | null {
  const paths = [
    join(stageDir(projectDir, state.runId, gateId), 'metric.json'),
    join(runDir(projectDir, state.runId), `verdict_${gateId}.json`),
  ];
  for (const artifactPath of paths) {
    try {
      const parsed = JSON.parse(readFileSync(artifactPath, 'utf-8'));
      const metadata = phaseMetadataFromArtifact(parsed, gateId);
      if (metadata) return metadata;
    } catch { /* non-critical */
      // Missing or malformed artifacts are ignored for phase tracking.
    }
  }
  return null;
}

function orderedGateIdsForState(projectDir: string, state: StoreState): string[] {
  const runPath = runDir(projectDir, state.runId);
  if (state.dispatchedStages && Array.isArray(state.dispatchedStages)) {
    return (state.dispatchedStages as { id: string; is_gate?: boolean }[])
      .filter(s => s.is_gate)
      .map(s => s.id);
  }

  const ids = new Set<string>();
  try {
    const files = readdirSync(runPath).filter(f => f.startsWith('verdict_') && f.endsWith('.json'));
    for (const file of files) ids.add(file.replace('verdict_', '').replace('.json', ''));
  } catch { /* non-critical */
    // No verdicts yet.
  }
  try {
    const stagesPath = join(runPath, 'stages');
    for (const stageId of readdirSync(stagesPath)) {
      if (existsSync(join(stagesPath, stageId, 'metric.json'))) ids.add(stageId);
    }
  } catch { /* non-critical */
    // No stage metrics yet.
  }
  return [...ids];
}

/** Find the last scored gate in pipeline order for campaign tracking */
export function findCampaignMetric(projectDir: string, state: StoreState): CampaignMetric | null {
  let best: CampaignMetric | null = null;
  for (const gateId of orderedGateIdsForState(projectDir, state)) {
    const metricLookup = parseGateMetric(projectDir, state, gateId);
    const metric = metricLookup.found ? metricLookup.metric : parseLegacyVerdictMetric(projectDir, state, gateId);
    if (metric) best = metric;
  }
  return best;
}

/** Find the last gate phase metadata in pipeline order for campaign tracking. */
export function findCampaignPhaseMetadata(projectDir: string, state: StoreState): CampaignPhaseMetadata | null {
  let latest: CampaignPhaseMetadata | null = null;
  for (const gateId of orderedGateIdsForState(projectDir, state)) {
    const metadata = parseGatePhaseMetadata(projectDir, state, gateId);
    if (metadata) latest = metadata;
  }
  return latest;
}

export interface CampaignAlert {
  type: 'regression' | 'plateau' | 'repeated_failure';
  action: 'inject_researcher';
  message: string;
}

export interface CampaignEntry {
  seq: number;
  runId: string;
  iteration?: number;
  score?: number;
  metric?: string;
  gate?: string;
  pass: boolean;
  timestamp: string;
  phase?: string;
  phaseComplete?: boolean;
  nextPhase?: string;
  outcome?: string;
  workflowSatisfied?: boolean;
  terminalStudyComplete?: boolean;
  modelSuccess?: boolean;
}

type ScoredCampaignEntry = CampaignEntry & { score: number; metric: string };

/** Check campaign health from JSONL entries */
export function checkCampaignHealth(entries: CampaignEntry[], triggers?: { enabled?: boolean; regressionAfter?: number; plateauAfter?: number; plateauThreshold?: number; repeatedFailureAfter?: number }): CampaignAlert | null {
  if (triggers?.enabled === false) return null;
  if (entries.at(-1)?.terminalStudyComplete === true || entries.at(-1)?.workflowSatisfied === true) return null;
  const scoredEntries = entries.filter((entry): entry is ScoredCampaignEntry => typeof entry.score === 'number' && typeof entry.metric === 'string');
  const scoped = collapseEntriesForHealth(scoredEntries) as ScoredCampaignEntry[];
  if (scoped.length < 2) return null;
  const regAfter = triggers?.regressionAfter ?? 2;
  const platAfter = triggers?.plateauAfter ?? 3;
  const platThresh = triggers?.plateauThreshold ?? 5;
  const repAfter = triggers?.repeatedFailureAfter ?? 3;
  const latestMetric = scoped.at(-1)?.metric;
  const comparable = latestMetric ? scoped.filter((entry) => entry.metric === latestMetric) : scoped;

  // Consecutive declines
  let declines = 0;
  for (let i = comparable.length - 1; i > 0; i--) {
    if (comparable[i].score < comparable[i - 1].score) declines++;
    else break;
  }
  if (declines >= regAfter) return { type: 'regression', action: 'inject_researcher', message: `${declines} consecutive score declines` };

  // Plateau (±threshold% for N+ entries)
  if (comparable.length >= platAfter) {
    const recent = comparable.slice(-platAfter);
    const avg = recent.reduce((s, e) => s + e.score, 0) / recent.length;
    if (!isFinite(avg)) {
      // All non-finite (Infinity/-Infinity/NaN): treat identical non-finite values as plateau
      if (recent.every(e => e.score === recent[0].score)) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    } else if (avg === 0) {
      if (recent.every(e => Math.abs(e.score) <= platThresh / 100)) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    } else {
      const allWithin = recent.every(e => Math.abs(e.score - avg) / Math.abs(avg) * 100 <= platThresh);
      if (allWithin) return { type: 'plateau', action: 'inject_researcher', message: `${platAfter} entries within ±${platThresh}%` };
    }
  }

  // Repeated same-gate failure
  if (scoped.length >= repAfter) {
    const recent = scoped.slice(-repAfter);
    if (recent.every(e => !e.pass) && recent.every(e => e.gate === recent[0].gate)) {
      return { type: 'repeated_failure', action: 'inject_researcher', message: `${repAfter} consecutive failures on gate ${recent[0].gate}` };
    }
  }

  return null;
}

/**
 * Campaign-level gate contract. When present (in `<run_dir>/gate_contract.json`,
 * or copied from `<project>/.fc/campaigns/<campaign_storage_key>/contract.json`
 * at run start), gate verdicts are validated against this contract — preventing
 * agents from silently downgrading the metric or threshold to fake-pass a gate.
 *
 * Example:
 *   { "metric": "qa_skeptical_audience",
 *     "metricSynonyms": ["AIDialyRealAudienceQAGateScore"],
 *     "threshold": 9.5,
 *     "higherIsBetter": true,
 *     "appliesToGates": ["qa_gate", "final_gate"] }
 */
export interface GateContract {
  metric: string;
  metricSynonyms?: string[];
  threshold: number;
  higherIsBetter?: boolean;
  /** Optional whitelist of gate stage IDs the contract applies to. If absent, applies to all is_gate stages. */
  appliesToGates?: string[];
}

const GATE_METRIC_SYNONYMS: Record<string, string[]> = {
  qa_skeptical_audience: ['skeptical_audience', 'qa_audience'],
};

function metricNamesMatch(metricName: string, verdictName: string): boolean {
  const metric = metricName.toLowerCase();
  const verdict = verdictName.toLowerCase();
  if (metric === verdict) return true;
  return (GATE_METRIC_SYNONYMS[metric] ?? []).map(s => s.toLowerCase()).includes(verdict)
    || (GATE_METRIC_SYNONYMS[verdict] ?? []).map(s => s.toLowerCase()).includes(metric);
}

/**
 * Does metric.json itself report a failure? Either an explicit `pass: false`, or
 * a numeric value that misses its own threshold. Used to decide whether a
 * metric-name difference could be masking anything.
 */
function metricFileIndicatesFailure(metric: Record<string, unknown>): boolean {
  if (metric.pass === false) return true;
  const value = typeof metric.value === 'number'
    ? metric.value
    : typeof metric.score === 'number' ? metric.score : null;
  const threshold = typeof metric.threshold === 'number' ? metric.threshold : null;
  if (value === null || threshold === null) return false;
  const higherIsBetter = metric.higherIsBetter !== false && metric.higher_is_better !== false;
  return higherIsBetter ? value < threshold : value > threshold;
}

export function validateVerdictAgainstMetricFile(
  verdict: Record<string, unknown>,
  metric: Record<string, unknown>,
): string | null {
  const metricContradiction = explicitPassContradiction(metric, 'metric.json', verdict.pass === true);
  if (metricContradiction) return metricContradiction;
  if (metric.pass === false && verdict.pass === true) {
    // A closeout/ceiling-deliverable audit legitimately passes (the deliverable is valid)
    // while the beat-metric legitimately fails (no beat) — an honest negative is a valid
    // deliverable. The QA signals this with phase-completion metadata. Honor it from EITHER
    // file: the metric.json OR the verdict itself (observed thrash: the verdict carried
    // phaseComplete/nextPhase but an early metric.json attempt omitted them, so the gate was
    // re-rejected for iterations). This does not weaken the measure-round self-deception guard:
    // a measure round that falsely passes a non-beat is still caught unless it explicitly
    // declares a phase-completion, which the planner reserves for closeout phases.
    if (metric.phaseComplete === true || metric.phase_complete === true || metric.nextPhase || metric.next_phase) return null;
    if (verdict.phaseComplete === true || verdict.phase_complete === true || verdict.nextPhase || verdict.next_phase) return null;
    return 'verdict/metric.json mismatch: metric says fail, verdict says pass';
  }
  if (
    typeof metric.metric === 'string'
    && typeof verdict.metric === 'string'
    && !metricNamesMatch(metric.metric, verdict.metric)
    // A rename is evidence of self-deception only when there is a failure for it
    // to hide. When the metric file reports no failure, the two files simply name
    // different things — a gate's own health metric ("failing_checks") beside the
    // domain metric the brief asked the stage to report — and rejecting that pair
    // makes the gate unpassable no matter what the stage does.
    && metricFileIndicatesFailure(metric)
  ) {
    return `metric name redefined: metric.json="${metric.metric}" vs verdict="${verdict.metric}"`;
  }
  if (typeof metric.threshold === 'number' && typeof verdict.threshold === 'number' && verdict.threshold < metric.threshold) {
    return 'threshold downgraded';
  }
  return null;
}

export function loadGateContract(projectDir: string, runId?: string, campaignStorageKey?: string): GateContract | null {
  // 1. Per-run override (written by the planner or copied at run start)
  if (runId) {
    const p = join(runDir(projectDir, runId), 'gate_contract.json');
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      if (raw && typeof raw.metric === 'string' && typeof raw.threshold === 'number') return raw as GateContract;
    } catch { /* not found */ }
  }
  // 2. Campaign-level default
  if (campaignStorageKey) {
    const p = join(projectDir, '.fc', 'campaigns', campaignStorageKey, 'contract.json');
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      if (raw && typeof raw.metric === 'string' && typeof raw.threshold === 'number') return raw as GateContract;
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Validate a gate verdict against the campaign's contract. Returns null if
 * the verdict honors the contract; returns an error string describing the
 * violation otherwise. Common violations:
 *   - verdict.metric doesn't match contract.metric or any synonym (gate redefined)
 *   - verdict.threshold downgraded below contract.threshold
 *   - verdict.pass is true but verdict.value doesn't satisfy contract.threshold
 *
 * Cross-references `<runDir>/stages/<stageId>/metric.json` to find the
 * authoritative `value` and `metric` name when the verdict file omits them.
 */
function validateVerdictAgainstContract(
  verdict: Record<string, unknown>,
  metric: Record<string, unknown> | null,
  contract: GateContract,
  stageId: string,
): string | null {
  if (contract.appliesToGates && !contract.appliesToGates.includes(stageId)) return null;
  const candidateValues: unknown[] = [verdict.value, verdict.score, metric?.value, metric?.score];
  const value = candidateValues.find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate),
  );
  if (typeof value !== 'number') {
    return `missing required numeric gate value for metric="${contract.metric}"; only finite numeric evidence is accepted, no finite numeric value was found in the current verdict or metric.json, and contract threshold=${contract.threshold} must be checked mechanically.`;
  }
  const expectedMetric = contract.metric.toLowerCase();
  const synonyms = (contract.metricSynonyms ?? []).map(s => s.toLowerCase());
  const acceptableNames = new Set([expectedMetric, ...synonyms]);
  const verdictMetricName = typeof verdict.metric === 'string' ? verdict.metric.toLowerCase() : '';
  const metricFileName = metric && typeof metric.metric === 'string' ? metric.metric.toLowerCase() : '';
  const metricNameMatches = acceptableNames.has(verdictMetricName) || acceptableNames.has(metricFileName);
  if (!metricNameMatches) {
    return `verdict.metric="${verdict.metric ?? ''}" / metric.json.metric="${metric?.metric ?? ''}" does not match contract.metric="${contract.metric}" (synonyms=${JSON.stringify(contract.metricSynonyms ?? [])}). Gate metric was redefined — verdict invalid.`;
  }
  const higherIsBetter = contract.higherIsBetter !== false;
  const verdictThreshold = typeof verdict.threshold === 'number' ? verdict.threshold : null;
  if (verdictThreshold !== null) {
    if (higherIsBetter && verdictThreshold < contract.threshold) {
      return `verdict.threshold=${verdictThreshold} downgraded below contract.threshold=${contract.threshold}. Gate threshold was lowered — verdict invalid.`;
    }
    if (!higherIsBetter && verdictThreshold > contract.threshold) {
      return `verdict.threshold=${verdictThreshold} raised above contract.threshold=${contract.threshold} (lower-is-better). Gate threshold was relaxed — verdict invalid.`;
    }
  }
  const mechanicalPass = higherIsBetter ? value >= contract.threshold : value <= contract.threshold;
  if (verdict.pass === true && !mechanicalPass) {
    return `verdict.pass=true but value=${value} does not satisfy contract (${higherIsBetter ? '>=' : '<='} ${contract.threshold}). Pass set independently of mechanical check — verdict invalid.`;
  }
  return null;
}

function readTerminalStudyCompletionEvidence(projectDir: string, runId: string, stageId: string): Record<string, unknown> | null {
  const base = runDir(projectDir, runId);
  for (const file of [`verdict_${stageId}.json`, `pre_gate_verdict_${stageId}.json`]) {
    try {
      const parsed = JSON.parse(readFileSync(join(base, file), 'utf-8')) as Record<string, unknown>;
      if (isTerminalStudyCompletionArtifact(parsed)) return parsed;
    } catch { /* optional */ }
  }
  return null;
}

function writeTerminalStudyCompletionArtifacts(projectDir: string, runId: string, stageId: string, evidence: Record<string, unknown>): void {
  const base = runDir(projectDir, runId);
  mkdirSync(stageDir(projectDir, runId, stageId), { recursive: true });
  writeFileSync(join(base, `verdict_${stageId}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf-8');
  // Generic: the score comes from the verdict's own `value`/`metric` (no domain
  // field names or default metric baked in). higher_is_better is read from the
  // evidence when present, defaulting to true.
  const value = typeof evidence.value === 'number' ? evidence.value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    writeFileSync(join(stageDir(projectDir, runId, stageId), 'metric.json'), JSON.stringify({
      hasMetric: true,
      metric: typeof evidence.metric === 'string' ? evidence.metric : 'study_score',
      value,
      higherIsBetter: typeof evidence.higher_is_better === 'boolean' ? evidence.higher_is_better : true,
      threshold: typeof evidence.threshold === 'number' ? evidence.threshold : null,
      pass: false,
      source: {
        path: typeof evidence.final_candidate_artifact === 'string'
          ? evidence.final_candidate_artifact
          : join(base, `pre_gate_verdict_${stageId}.json`),
        evidence: `value=${value}`,
      },
      notes: 'Recovered from terminal study completion evidence.',
    }, null, 2) + '\n', 'utf-8');
  }
}

/**
 * Read a gate verdict. Legacy callers may fall back to the shared verdict.json;
 * dependency readiness disables that fallback because only the producer's own
 * declared output can satisfy its edge.
 */
const CONTRADICTORY_REJECT_OUTCOMES = new Set([
  'fail', 'failed', 'reject', 'rejected', 'repair_required', 'requires_repair',
  'reject_repair_required', 'rejected_repair_required',
]);

function structuredGateRejection(record: Record<string, unknown>): string | undefined {
  if (record.repair_required === true || record.requires_repair === true) {
    return 'repair_required=true';
  }
  const rawOutcome = typeof record.outcome === 'string'
    ? record.outcome
    : typeof record.status === 'string'
      ? record.status
      : undefined;
  if (rawOutcome) {
    const normalized = rawOutcome.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (CONTRADICTORY_REJECT_OUTCOMES.has(normalized)) return `outcome=${rawOutcome}`;
  }
  const nextPhase = typeof record.nextPhase === 'string'
    ? record.nextPhase
    : typeof record.next_phase === 'string'
      ? record.next_phase
      : undefined;
  if (nextPhase && /^(?:repair|fix|rework)(?:_|\b)/i.test(nextPhase.trim())) {
    return `nextPhase=${nextPhase}`;
  }
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const explicitlyNegated = /\b(?:no|not|without)\s+(?:further\s+)?(?:repair|repairs)\s+(?:is\s+|are\s+)?required\b/i.test(reason)
    || /\brepair\s+(?:is\s+)?not\s+required\b/i.test(reason);
  if (!explicitlyNegated && /\b(?:repair\s+(?:is\s+)?required|requires?\s+(?:a\s+)?repair|needs?\s+(?:a\s+)?repair|must\s+be\s+repaired)\b/i.test(reason)) {
    return `reason=${reason}`;
  }
  return undefined;
}

function explicitPassContradiction(
  record: Record<string, unknown>,
  source: 'verdict' | 'metric.json',
  effectivePass = record.pass === true,
): string | undefined {
  if (!effectivePass) return undefined;
  const rejection = structuredGateRejection(record);
  return rejection
    ? `Gate verdict contradiction: pass=true cannot accompany ${source} ${rejection}`
    : undefined;
}

function validateGateCriterionEvidence(
  base: string,
  stageId: string,
  verdict: Record<string, unknown>,
): string | undefined {
  let refs: string[] = [];
  try {
    const admission = JSON.parse(readFileSync(join(base, 'dispatch_admission.json'), 'utf-8')) as DispatchAdmissionReport;
    refs = admission.criterionGateRefs?.[stageId] ?? [];
  } catch { /* legacy/static run without a criteria assignment */ }
  if (refs.length === 0) return undefined;
  const criteria = verdict.criteria;
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
    return `Gate criterion contract violation: missing criteria evidence map for ${refs.join(', ')}`;
  }
  const evidenceMap = criteria as Record<string, unknown>;
  for (const ref of refs) {
    const entry = evidenceMap[ref];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `Gate criterion contract violation: missing evidence for ${ref}`;
    }
    const record = entry as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
    const evidence = typeof record.evidence === 'string' ? record.evidence.trim() : '';
    if (!['pass', 'fail', 'judgement'].includes(status) || !evidence) {
      return `Gate criterion contract violation: ${ref} needs status pass|fail|judgement and non-empty evidence`;
    }
    if (verdict.pass === true && status === 'fail') {
      return `Gate criterion contract violation: pass=true conflicts with failed criterion ${ref}`;
    }
  }
  return undefined;
}

export function readGateVerdict(
  projectDir: string,
  stageId: string,
  runId?: string,
  contract?: GateContract | null,
  allowSharedFallback = true,
): { pass: boolean; reason?: string } | null {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  let v: Record<string, unknown> | null = null;
  const perGate = join(base, `verdict_${stageId}.json`);
  try {
    const parsed = JSON.parse(readFileSync(perGate, 'utf-8'));
    if (typeof parsed.pass === 'boolean') v = parsed;
  } catch { /* not found */ }
  if (!v && allowSharedFallback) {
    const shared = join(base, 'verdict.json');
    try {
      const parsed = JSON.parse(readFileSync(shared, 'utf-8'));
      if (typeof parsed.pass === 'boolean') v = parsed;
    } catch { /* not found */ }
  }
  if (!v && runId && allowSharedFallback) {
    const terminalEvidence = readTerminalStudyCompletionEvidence(projectDir, runId, stageId);
    if (terminalEvidence) {
      writeTerminalStudyCompletionArtifacts(projectDir, runId, stageId, terminalEvidence);
      return { pass: true, reason: 'study_complete_without_model_success' };
    }
  }
  if (!v) return null;
  const contradiction = explicitPassContradiction(v, 'verdict');
  if (contradiction) {
    log.warn({ stageId, runId, contradiction }, 'Gate verdict rejected because its structured fields contradict pass=true');
    return { pass: false, reason: contradiction };
  }
  const criterionViolation = validateGateCriterionEvidence(base, stageId, v);
  if (criterionViolation) {
    log.warn({ stageId, runId, criterionViolation }, 'Gate verdict rejected by canonical criterion coverage contract');
    return { pass: false, reason: criterionViolation };
  }
  if (runId && isTerminalStudyCompletionArtifact(v)) {
    writeTerminalStudyCompletionArtifacts(projectDir, runId, stageId, v);
    return { pass: true, reason: 'study_complete_without_model_success' };
  }
  if (runId) {
    const metricPath = join(stageDir(projectDir, runId, stageId), 'metric.json');
    try {
      const metric = JSON.parse(readFileSync(metricPath, 'utf-8')) as Record<string, unknown>;
      const violation = validateVerdictAgainstMetricFile(v, metric);
      if (violation) {
        log.warn({ stageId, runId, violation }, 'Gate verdict rejected by metric.json consistency check');
        return { pass: false, reason: violation };
      }
    } catch { /* optional/back-compat */ }
  }
  // Contract enforcement: if a contract is provided, validate the verdict against it.
  if (contract && runId) {
    const metricPath = join(stageDir(projectDir, runId, stageId), 'metric.json');
    let metric: Record<string, unknown> | null = null;
    try { metric = JSON.parse(readFileSync(metricPath, 'utf-8')); } catch { /* optional */ }
    const violation = validateVerdictAgainstContract(v, metric, contract, stageId);
    if (violation) {
      log.warn({ stageId, runId, violation }, 'Gate verdict rejected by contract');
      return { pass: false, reason: `Gate contract violation: ${violation}` };
    }
  }
  return v as { pass: boolean; reason?: string };
}

interface GateRuntimeFacts {
  allPass: boolean;
  failedGateIds: string[];
  /** Completed gates with a validated pass:false fact; pending gates are excluded. */
  rejectedGateIds: string[];
  contractRefusals: Array<{ id: string; reason: string }>;
  evaluations: Array<{
    id: string;
    status?: string;
    attempts: number;
    effectiveVerdict: { pass: boolean; reason?: string } | null;
  }>;
}

export function researchAdvanceEligible(input: {
  gatesSettled: boolean;
  stageFailed: boolean;
  supervisorRejectPending: boolean;
}): boolean {
  return input.gatesSettled && !input.stageFailed && !input.supervisorRejectPending;
}

interface GateRetryDiagnosticArtifact {
  file: string;
  pass?: boolean;
  parseError?: string;
}

function gateRetryDiagnosticSnapshot(
  allStages: StageConfig[],
  state: StoreState,
  projectDir: string,
  runId: string,
  runDirPath: string,
  runtimeFacts: GateRuntimeFacts,
): {
  verdictArtifacts: GateRetryDiagnosticArtifact[];
  gates: Array<{
    id: string;
    status?: string;
    attempts: number;
    effectiveVerdict: { pass: boolean; reason?: string } | null;
    metricArtifact?: Record<string, unknown>;
    metricParseError?: string;
  }>;
  contract: GateContract | null;
} {
  const verdictArtifacts: GateRetryDiagnosticArtifact[] = [];
  let verdictFiles: string[] = [];
  try {
    verdictFiles = readdirSync(runDirPath)
      .filter((file) => /^verdict_.*\.json$/.test(file))
      .sort();
  } catch { /* run directory is expected to exist; retain an empty diagnostic on failure */ }
  for (const file of verdictFiles) {
    try {
      const parsed = JSON.parse(readFileSync(join(runDirPath, file), 'utf-8')) as Record<string, unknown>;
      verdictArtifacts.push({ file, ...(typeof parsed.pass === 'boolean' ? { pass: parsed.pass } : {}) });
    } catch (error) {
      verdictArtifacts.push({ file, parseError: error instanceof Error ? error.message : String(error) });
    }
  }

  const contract = loadGateContract(projectDir, runId, state.campaignStorageKey);
  const evaluations = new Map(runtimeFacts.evaluations.map((evaluation) => [evaluation.id, evaluation]));
  const seen = new Set<string>();
  const gates = allStages.filter((stage) => {
    if (!stage.is_gate || seen.has(stage.id)) return false;
    seen.add(stage.id);
    return true;
  }).map((stage) => {
    const status = state.stages[stage.id];
    const metricPath = join(runDirPath, 'stages', stage.id, 'metric.json');
    let metricArtifact: Record<string, unknown> | undefined;
    let metricParseError: string | undefined;
    if (existsSync(metricPath)) {
      try {
        const parsed = JSON.parse(readFileSync(metricPath, 'utf-8')) as Record<string, unknown>;
        metricArtifact = Object.fromEntries([
          'hasMetric', 'metric', 'value', 'score', 'higherIsBetter', 'threshold', 'pass',
          'phaseComplete', 'phase_complete', 'nextPhase', 'next_phase',
        ].flatMap((key) => key in parsed ? [[key, parsed[key]]] : []));
      } catch (error) {
        metricParseError = error instanceof Error ? error.message : String(error);
      }
    }
    const evaluation = evaluations.get(stage.id);
    return {
      id: stage.id,
      status: status?.status,
      attempts: status?.attempts?.length ?? 0,
      effectiveVerdict: evaluation?.effectiveVerdict ?? null,
      ...(metricArtifact ? { metricArtifact } : {}),
      ...(metricParseError ? { metricParseError } : {}),
    };
  });
  return { verdictArtifacts, gates, contract };
}

function collectGateRuntimeFacts(allStages: StageConfig[], state: StoreState, projectDir: string, runId?: string): GateRuntimeFacts {
  const seenGateIds = new Set<string>();
  const gateStages = allStages.filter((s) => {
    if (!s.is_gate || seenGateIds.has(s.id)) return false;
    seenGateIds.add(s.id);
    return true;
  });
  if (gateStages.length === 0) {
    return { allPass: true, failedGateIds: [], rejectedGateIds: [], contractRefusals: [], evaluations: [] };
  }
  // Load the campaign gate contract once per check; reused across all gates.
  const contract = loadGateContract(projectDir, runId, state.campaignStorageKey);
  const failedGateIds: string[] = [];
  const rejectedGateIds: string[] = [];
  const contractRefusals: GateRuntimeFacts['contractRefusals'] = [];
  const evaluations: GateRuntimeFacts['evaluations'] = [];
  for (const g of gateStages) {
    const gateStatus = state.stages[g.id]?.status;
    // A gate only passes after it completed and wrote an explicit pass verdict.
    // Pending/running/skipped/missing gates must block run completion.
    if (gateStatus !== STAGE_STATUS.COMPLETE) {
      failedGateIds.push(g.id);
      evaluations.push({
        id: g.id,
        status: gateStatus,
        attempts: state.stages[g.id]?.attempts?.length ?? 0,
        effectiveVerdict: null,
      });
      continue;
    }
    const verdict = readGateVerdict(projectDir, g.id, runId, contract);
    evaluations.push({
      id: g.id,
      status: gateStatus,
      attempts: state.stages[g.id]?.attempts?.length ?? 0,
      effectiveVerdict: verdict
        ? { pass: verdict.pass, ...(verdict.reason ? { reason: verdict.reason } : {}) }
        : null,
    });
    if (verdict && verdict.pass === true) continue; // explicit pass (contract-honored if any)
    // Missing verdict or explicit fail → treat as failure
    failedGateIds.push(g.id);
    if (verdict?.pass === false) {
      rejectedGateIds.push(g.id);
      if (verdict.reason?.startsWith('Gate contract violation: missing required numeric gate value')) {
        contractRefusals.push({ id: g.id, reason: verdict.reason });
      }
    }
  }
  return {
    allPass: failedGateIds.length === 0,
    failedGateIds,
    rejectedGateIds,
    contractRefusals,
    evaluations,
  };
}

function terminateForGateContractRefusal(
  state: StoreState,
  facts: GateRuntimeFacts,
  projectDir: string,
  runId: string,
  iteration: number,
): boolean {
  if (facts.contractRefusals.length === 0) return false;
  const detail = facts.contractRefusals
    .map((refusal) => `${refusal.id}: ${refusal.reason}`)
    .join('; ');
  state.status = RUN_STATUS.FAILED;
  state.failureReason = `Gate contract refusal before repair dispatch — ${detail}`;
  state.completedAt = new Date().toISOString();
  writeRunState(projectDir, runId, state);
  writeCampaignEntry(projectDir, state);
  recordRunEvent(projectDir, runId, {
    type: 'run_completed',
    runId,
    timestamp: state.completedAt,
    iteration,
    detail: state.failureReason,
  });
  log.error({ runId, iteration, contractRefusals: facts.contractRefusals }, 'Gate contract refused before product repair');
  return true;
}

/** Check all is_gate stages. Preserve the established public result shape. */
export function checkGates(allStages: StageConfig[], state: StoreState, projectDir: string, runId?: string): { allPass: boolean; failedGateIds: string[] } {
  const { allPass, failedGateIds } = collectGateRuntimeFacts(allStages, state, projectDir, runId);
  return { allPass, failedGateIds };
}

/** Find the retry_to stage that references any of the failed gate IDs */
export function findRetryToStage(allStages: StageConfig[], failedGateIds: string[]): StageConfig | null {
  const failedSet = new Set(failedGateIds);
  for (const s of allStages) {
    if (s.retry_to && s.retry_to.some(id => failedSet.has(id))) return s;
  }
  return null;
}

/** Find ALL retry_to stages that reference any of the failed gate IDs */
export function findAllRetryToStages(allStages: StageConfig[], failedGateIds: string[]): StageConfig[] {
  const failedSet = new Set(failedGateIds);
  return allStages.filter(s => s.retry_to && s.retry_to.some(id => failedSet.has(id)));
}

export function lastGatePassed(state: StoreState, dispatchedStageIds: string[], allStages: StageConfig[], projectDir?: string, runId?: string): boolean {
  // If there are is_gate stages, use verdict-based checking
  const gateStages = allStages.filter(s => s.is_gate && dispatchedStageIds.includes(s.id));
  if (gateStages.length > 0 && projectDir) {
    const { allPass } = checkGates(gateStages, state, projectDir, runId);
    return allPass;
  }

  // No is_gate stages: check verdict.json (legacy) then exit codes
  if (projectDir) {
    const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
    const verdictPath = join(base, 'verdict.json');
    try {
      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      return verdict.pass === true;
    } catch { /* no verdict.json — fall through to exit code check */ }
  }

  // Find terminal stages
  const hasDependent = new Set<string>();
  for (const s of allStages) {
    if (dispatchedStageIds.includes(s.id)) {
      for (const dep of s.depends_on ?? []) {
        if (dispatchedStageIds.includes(dep)) hasDependent.add(dep);
      }
    }
  }
  const terminalIds = dispatchedStageIds.filter(id => !hasDependent.has(id));
  if (terminalIds.length === 0) return true;

  return terminalIds.every(id => {
    const ss = state.stages[id];
    if (!ss) return false;
    if (ss.status === STAGE_STATUS.SKIPPED) return true;
    return ss.status === STAGE_STATUS.COMPLETE && (ss.exitCode === undefined || ss.exitCode === 0);
  });
}

export function shouldContinuePhaseAfterGatePass(projectDir: string, state: StoreState): boolean {
  const phase = findCampaignPhaseMetadata(projectDir, state);
  if (!phase) return false;
  if (phase.phaseComplete === false) return true;
  const nextPhase = phase.nextPhase?.trim().toLowerCase();
  return phase.phaseComplete === true && Boolean(nextPhase && nextPhase !== CAMPAIGN_PHASE_COMPLETE_SENTINEL);
}

function reconcileUnresolvedStageObligations(
  state: StoreState,
  dispatchedStages: readonly StageConfig[],
  declaredIteration: number,
  runDirPath: string,
): { changed: boolean; stageIds: string[] } {
  const before = state.unresolvedStageObligations ?? [];
  const obligations = new Map(before.map((entry) => [entry.stageId, entry]));
  const disposedScopeDigests = scopePlanningDispositionDigests(runDirPath);

  // An obligation is discharged only by an engine-observed success or explicit
  // skip of the same stage ID. A planner may also use the existing, durable
  // scope-negotiation resolve/defer contract when that exact digest is what
  // blocked the old downstream stage. Missing and failed stages otherwise stay.
  for (const [stageId, obligation] of obligations) {
    const status = state.stages[stageId]?.status;
    if (status === STAGE_STATUS.COMPLETE || status === STAGE_STATUS.SKIPPED) {
      obligations.delete(stageId);
      continue;
    }
    if (
      obligation.scopePlanningDigests?.length
      && obligation.scopePlanningDigests.every((digest) => disposedScopeDigests.has(digest))
    ) {
      obligations.delete(stageId);
    }
  }

  for (const stage of dispatchedStages) {
    // Conditional stages and retry_to repair stages are optional by contract.
    // A repair is eligible only after its gate rejects; a passing gate must not
    // turn its intentionally pending repair into required downstream work.
    if (stage.condition?.trim() || (!stage.is_gate && stage.retry_to?.length)) continue;
    const status = state.stages[stage.id]?.status;
    if (status === STAGE_STATUS.PENDING || status === STAGE_STATUS.RUNNING) {
      const scopePlanningDigests = scopePlanningDigestsBlockingStage(runDirPath, stage.id, dispatchedStages);
      const existing = obligations.get(stage.id);
      if (!existing) {
        obligations.set(stage.id, {
          stageId: stage.id,
          declaredIteration,
          ...(scopePlanningDigests.length > 0 ? { scopePlanningDigests } : {}),
        });
      } else if (scopePlanningDigests.length > 0) {
        obligations.set(stage.id, {
          ...existing,
          scopePlanningDigests: [...new Set([
            ...(existing.scopePlanningDigests ?? []),
            ...scopePlanningDigests,
          ])].sort(),
        });
      }
    }
  }

  const next = [...obligations.values()].sort((a, b) => (
    a.declaredIteration - b.declaredIteration || a.stageId.localeCompare(b.stageId)
  ));
  const changed = JSON.stringify(before) !== JSON.stringify(next);
  if (next.length > 0) state.unresolvedStageObligations = next;
  else state.unresolvedStageObligations = undefined;
  return { changed, stageIds: next.map((entry) => entry.stageId) };
}

function guardPlainCompletionWithStageObligations(
  state: StoreState,
  projectDir: string,
  runId: string,
  iteration: number,
  completionPath: string,
): string[] {
  const dispatched = Array.isArray(state.dispatchedStages)
    ? state.dispatchedStages as StageConfig[]
    : [];
  const reconciled = reconcileUnresolvedStageObligations(
    state,
    dispatched,
    state.currentIteration ?? iteration,
    runDir(projectDir, runId),
  );
  if (reconciled.changed) writeRunState(projectDir, runId, state);
  if (reconciled.stageIds.length > 0) {
    log.warn({
      runId,
      iteration,
      completionPath,
      unresolvedStageIds: reconciled.stageIds,
    }, 'Plain completion blocked by unresolved stage obligations');
  }
  return reconciled.stageIds;
}

function appendUnresolvedStageObligationContext(prompt: string, state: StoreState): string {
  const obligations = state.unresolvedStageObligations ?? [];
  if (obligations.length === 0) return prompt;
  const rows = obligations.map((entry) => {
    const disposition = entry.scopePlanningDigests?.length
      ? `; alternatively record the pending scope disposition(s): ${entry.scopePlanningDigests.join(', ')}`
      : '';
    return `- ${entry.stageId} (declared in iteration ${entry.declaredIteration}${disposition})`;
  }).join('\n');
  return `${prompt}\n\n# Engine-owned unresolved stage obligations\n${rows}\n`
    + `A replacement plan cannot supersede these obligations by omission. Re-dispatch every exact stage ID above and let it reach complete or an explicit skipped disposition, unless the row names an existing scope-negotiation digest that this plan explicitly resolves or defers. `
    + `Until then, the engine will reject plain completion and will end incomplete if the iteration budget is exhausted.`;
}

export function recoverTerminalStudyCompletion(projectDir: string, runId: string, state: StoreState): StoreState | null {
  // This is an authored gate terminal contract, not a plain-complete exit. Like
  // brief terminal_states, it intentionally outranks unresolved DAG work.
  const gateIds = orderedGateIdsForState(projectDir, state);
  for (const gateId of gateIds) {
    const evidence = readTerminalStudyCompletionEvidence(projectDir, runId, gateId);
    if (!evidence) continue;
    writeTerminalStudyCompletionArtifacts(projectDir, runId, gateId, evidence);
    const next: StoreState = {
      ...state,
      status: RUN_STATUS.COMPLETE,
      completedAt: state.completedAt ?? new Date().toISOString(),
      campaignAlert: undefined,
      researchInjection: undefined,
      stages: { ...state.stages },
    };
    next.stages[gateId] = { ...(next.stages[gateId] ?? { retries: 0 }), status: STAGE_STATUS.COMPLETE, retries: next.stages[gateId]?.retries ?? 0 };
    for (const stage of (state.dispatchedStages ?? []) as StageConfig[]) {
      if (stage.retry_to?.includes(gateId) && next.stages[stage.id]) {
        next.stages[stage.id] = { ...next.stages[stage.id], status: STAGE_STATUS.SKIPPED };
      }
    }
    return next;
  }
  return null;
}

/**
 * Main workflow orchestration loop.
 *
 * Structure:
 *   1. Initialize run (create state, load agents, start supervisor)
 *   2. Iteration loop (outer re-plan cycle):
 *      a. Execute stages via executeIteration()
 *      b. Inner retry loop (gate failure → fix → re-gate)
 *      c. Campaign health check + ratchet
 *      d. Gate evaluation → complete / re-plan / fail
 *   3. Finalize (write campaign entry, stop supervisor)
 */
export async function runWorkflow(
  workflow: WorkflowConfig,
  workflowYaml: string,
  projectDir: string,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  skills?: string,
  agentsDir?: string,
  existingRunId?: string,
  taskDescription?: string,
  autoApprove?: boolean,
  supervise?: boolean,
  campaignId?: string,
  inheritCampaignContext: boolean = true,
  briefAdmission?: BriefAdmissionRecord,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
): Promise<StoreState> {
  if (briefAdmission) {
    if (taskDescription === undefined) {
      throw new Error('A brief admission record was supplied without the exact brief text');
    }
    const verification = verifyBriefAdmission(taskDescription, briefAdmission);
    if (verification.status !== 'valid') {
      throw new Error(
        `Brief admission ${verification.status}; scheduler launch stopped before run creation `
        + `(current digest ${verification.report.digest.slice(0, 12)}).`,
      );
    }
  }
  normalizeRetryGateRelationships(workflow.stages);
  // The run-local workflow is the normalized executable contract, including
  // inferred gate/dependency facts, not the stale input text.
  workflowYaml = stringifyYaml(workflow);
  const baseStages = topoSort(workflow.stages);
  const stageIds = baseStages.map((s) => s.id);
  let maxIterations = workflow.defaults.max_iterations ?? loadDefaults(projectDir).max_iterations;

  let runId: string;
  let runDirPath: string;
  let launchIntentOwned: boolean;
  // Set when this launch is RESUMING a parked run rather than relaunching a
  // finished one: the loop then continues the park's own iteration instead of
  // restarting at 1 with a fresh budget.
  let resumingFromPark = false;
  let resumeAtIteration = 1;
  if (existingRunId) {
    runId = existingRunId;
    runDirPath = runDir(projectDir, runId);
    const hasRunState = existsSync(join(runDirPath, 'run.json'));
    const reservation = hasRunState ? undefined : readRunReservation(projectDir, runId);
    if (!hasRunState && !reservation) {
      throw new Error(`Existing run is unreadable and has no valid reservation: ${runId}`);
    }
    if (hasRunState) {
      const archived = readRunState(projectDir, runId);
      requireKnownRunStatus(archived.status, `resume run ${runId}`);
    }
    const launchClaim = claimLaunchIntent(projectDir, runId);
    if (!launchClaim.claimed) {
      if (hasRunState) return readRunState(projectDir, runId);
      initializeReservedRun(projectDir, runId, workflow.name, workflowYaml, stageIds);
      const blocked = readRunState(projectDir, runId);
      if (taskDescription) blocked.taskDescription = taskDescription;
      if (briefAdmission) blocked.briefAdmission = briefAdmission;
      if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
        writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
      }
      blocked.status = 'failed';
      blocked.failureReason = `Single-in-flight launch intent: another launch (${launchClaim.blockingOwnerRunId ?? 'unknown'}) already owns this project.`;
      blocked.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, blocked);
      return blocked;
    }
    launchIntentOwned = true;
    if (reservation) {
      initializeReservedRun(projectDir, runId, workflow.name, workflowYaml, stageIds);
      const state = readRunState(projectDir, runId);
      state.maxIterations = maxIterations;
      state.currentIteration = 1;
      state.timeoutMs = loadDefaults(projectDir).timeout_ms;
      if (taskDescription) state.taskDescription = taskDescription;
      if (briefAdmission) state.briefAdmission = briefAdmission;
      if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
        writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
      }
      writeRunState(projectDir, runId, state);
    }
    mkdirSync(join(runDirPath, 'stages'), { recursive: true });
    for (const s of baseStages) {
      mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
    }
    const state = readRunState(projectDir, runId);
    maxIterations = state.maxIterations ?? maxIterations;
    for (const s of baseStages) {
      if (!state.stages[s.id]) state.stages[s.id] = { status: 'pending', retries: 0 };
    }
    // RESUMING a park is not RELAUNCHING a finished run. A resume continues the
    // same run — same iteration budget, same lifecycle clock, same signals — so
    // it must skip the hygiene below. Applying it to a park would (a) hand back
    // a full fresh iteration budget on every park cycle, (b) reset startedAt and
    // thereby make tryAdvanceResearch discard the round measured just before the
    // park as "stale", and (c) delete signals/ mid-flight.
    resumingFromPark = isPausedRunStatus(state.status);
    if (resumingFromPark) {
      resumeAtIteration = state.parked?.atIteration ?? state.currentIteration ?? 1;
    }
    if (briefAdmission) {
      state.briefAdmission = briefAdmission;
      writeRunState(projectDir, runId, state);
    }
    if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
      writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
    }
    if (!resumingFromPark && !reservation) {
      state.status = 'running';
      state.workflowName = workflow.name;
      state.maxIterations = maxIterations;
      state.timeoutMs = loadDefaults(projectDir).timeout_ms;
      state.currentIteration = 1;
      // Relaunch hygiene: this run previously reached a terminal state. Refresh the
      // lifecycle markers and purge prior-run signals so we don't (a) compute a
      // stale/negative duration off the old completedAt, (b) honor a leftover
      // goal_met.json/replan.json and terminate the rerun prematurely, or (c) let
      // tryAdvanceResearch journal a stale result file from the previous run as a
      // phantom round (its freshness check keys off startedAt).
      state.startedAt = new Date().toISOString();
      delete state.completedAt;
      delete state.failureReason;
      delete state.terminalArtifact;
      try { rmSync(join(runDirPath, 'signals'), { recursive: true, force: true }); } catch { /* best effort */ }
      // Reset the integrity-rejection tally so a prior run's rejections don't shrink
      // this rerun's budget.
      try { unlinkSync(join(runDirPath, 'research_integrity_rejections.json')); } catch { /* best effort */ }
      writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
      writeRunState(projectDir, runId, state);
    }
  } else {
    const reserved = reserveRun(projectDir);
    runId = reserved.runId;
    runDirPath = reserved.runDirPath;
    const launchClaim = claimLaunchIntent(projectDir, runId);
    launchIntentOwned = launchClaim.claimed;
    initializeReservedRun(projectDir, runId, workflow.name, workflowYaml, stageIds);
    const state = readRunState(projectDir, runId);
    if (taskDescription) state.taskDescription = taskDescription;
    if (briefAdmission) state.briefAdmission = briefAdmission;
    if (taskDescription && !existsSync(join(runDirPath, 'task_brief.md'))) {
      writeFileSync(join(runDirPath, 'task_brief.md'), taskDescription, 'utf-8');
    }
    if (!launchClaim.claimed) {
      state.status = 'failed';
      state.failureReason = `Single-in-flight launch intent: another launch (${launchClaim.blockingOwnerRunId ?? 'unknown'}) already owns this project.`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      return state;
    }
    state.maxIterations = maxIterations;
    state.currentIteration = 1;
    state.timeoutMs = loadDefaults(projectDir).timeout_ms;
    writeRunState(projectDir, runId, state);
  }

  // Criterion transport is tied to the exact admitted brief bytes and exists
  // before a planner can emit dynamic stages.
  try {
    const briefPath = join(runDirPath, 'task_brief.md');
    const exactBrief = existsSync(briefPath)
      ? readFileSync(briefPath, 'utf-8')
      : (taskDescription ?? '');
    if (exactBrief) writeBriefCriteriaArtifact(runDirPath, exactBrief);
  } catch (error) {
    throw new Error(`Cannot materialize brief_criteria.json before dispatch: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  // Claim liveness before probing siblings. In particular, a parked run remains
  // durably parked during admission, but this pid makes its resume-start window
  // visible to another concurrent launcher.
  const schedulerPidPath = join(runDirPath, 'scheduler.pid');
  if (!claimSchedulerPid(schedulerPidPath, runId)) {
    const state = readRunState(projectDir, runId);
    if (launchIntentOwned) {
      // Another scheduler already owns the durable pid marker for this same
      // run, so the short-lived launch hand-off is no longer needed.
      releaseLaunchIntent(projectDir, runId);
      invalidateRunLockCache();
    }
    log.warn({ runId, projectDir }, 'Scheduler launch already claimed for this run');
    return state;
  }
  if (!resumingFromPark && launchIntentOwned) {
    // run.json is running and scheduler.pid is now live: the durable liveness
    // probe has taken over from the short launch-window intent.
    releaseLaunchIntent(projectDir, runId);
    launchIntentOwned = false;
    invalidateRunLockCache();
  }

  const sibling = findLiveRunOwnerForProject(projectDir, runId);
  if (sibling) {
    const siblingDescription = describeLiveRunOwner(sibling);
    const state = readRunState(projectDir, runId);
    removeSchedulerPidIfOwned(schedulerPidPath);
    if (resumingFromPark) {
      // Approval remains consumed in the append log, but the run itself must
      // stay resumable. Do not erase parked metadata or manufacture a failure.
      log.warn({ runId, sibling: siblingDescription, projectDir }, 'Resume deferred: another active run exists for this project');
      if (launchIntentOwned) {
        releaseLaunchIntent(projectDir, runId);
        invalidateRunLockCache();
      }
      return state;
    }
    state.status = 'failed';
    state.failureReason = `Single-in-flight: another active run (${siblingDescription}) exists for this project. Stop it first or wait for it to finish.`;
    state.completedAt = new Date().toISOString();
    writeRunState(projectDir, runId, state);
    log.error({ runId, sibling: siblingDescription, projectDir }, 'Refusing to start: another active run exists for this project');
    return state;
  }

  // Admission succeeded: only now consume the parked lifecycle marker.
  if (resumingFromPark) {
    const state = readRunState(projectDir, runId);
    if (!isPausedRunStatus(state.status)) {
      removeSchedulerPidIfOwned(schedulerPidPath);
      return state;
    }
    state.status = 'running';
    state.workflowName = workflow.name;
    state.maxIterations = maxIterations;
    state.timeoutMs = loadDefaults(projectDir).timeout_ms;
    state.currentIteration = resumeAtIteration;
    delete state.parked;
    writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    writeRunState(projectDir, runId, state);
    if (launchIntentOwned) {
      releaseLaunchIntent(projectDir, runId);
      launchIntentOwned = false;
      invalidateRunLockCache();
    }
  }

  // Supervisor and pid cleanup cover every return after admission, including
  // brief/frontmatter validation failures before the iteration loop.
  let supervisor: Supervisor | undefined;
  try {
  log.info({ runId, workflow: workflow.name }, 'Run started');

  if (taskDescription || autoApprove || supervise || campaignId || briefAdmission) {
    const initState = readRunState(projectDir, runId);
    if (taskDescription && !resumingFromPark) {
      initState.taskDescription = taskDescription;
      // Persist the brief into the run dir so CLI-spawned tasks (which only
      // write task_brief.md to <project>/docs/) carry their own task_brief.md.
      // Without this, POST /api/tasks/:id/rerun's existsSync(task_brief.md)
      // check fails and rerun cannot re-plan.
      try {
        const briefDest = join(runDirPath, 'task_brief.md');
        if (!existsSync(briefDest)) {
          writeFileSync(briefDest, taskDescription, 'utf-8');
        }
      } catch { /* non-critical */ }
    }
    if (autoApprove) initState.autoApprove = true;
    if (supervise) initState.supervise = true;
    if (briefAdmission) initState.briefAdmission = briefAdmission;
    if (campaignId) {
      initState.campaignId = campaignId;
      initState.campaignName = campaignId;
      initState.campaignStorageKey = resolveCampaignStorageKey({ campaignId });
    }
    if (inheritCampaignContext === false) initState.inheritCampaignContext = false;
    writeRunState(projectDir, runId, initState);
  }

  // Use full task brief as taskDescription for template substitution in dispatched stages.
  // Also parse `---` YAML frontmatter for terminal_states config (research-exploration
  // briefs declare ceiling_report.md / escalation_note.md as valid completions).
  // The frontmatter is stripped from the brief before it reaches stage prompts so the
  // planner doesn't waste tokens reading scheduler-internal config.
  const briefPath = join(runDirPath, 'task_brief.md');
  if (taskDescription !== undefined || existsSync(briefPath)) {
    const briefContent = (taskDescription !== undefined
      ? taskDescription
      : readFileSync(briefPath, 'utf-8')).trim();
    if (briefContent) {
      const { terminalStates, program, research, stripped, frontmatterError } = parseBriefFrontmatter(briefContent);
      taskDescription = stripped || briefContent;
      if (terminalStates || program || research) {
        const s = readRunState(projectDir, runId);
        if (terminalStates) s.terminalStates = terminalStates;
        if (program) s.program = program;
        if (research) s.research = research;
        writeRunState(projectDir, runId, s);
        if (terminalStates) log.info({ runId, statuses: Object.keys(terminalStates) }, 'Terminal-state config loaded from brief frontmatter');
        if (program) log.info({ runId, program: program.name, phase: program.phase }, 'Program config loaded from brief frontmatter');
        if (research) log.info({ runId, policy: research.policy, baseline: research.baseline }, 'Research config loaded from brief frontmatter');
      }
      // Consistency check: the `--workflow research` flag and the `research:`
      // frontmatter block should agree. The block is the precise expression of
      // intent, so we WARN on mismatch rather than fail.
      const isResearchWorkflow = workflow.name === 'research';
      // GAP-3: if the brief's frontmatter was MALFORMED (parse error / unclosed
      // fence / non-object), do NOT silently swallow it. When the run intends to
      // be a research loop (workflow=research) yet no `research:` block parsed
      // because of that error, fail LOUD — surfacing the YAML error — instead of
      // degrading to plain dispatch (which would run an entirely different,
      // policy-less workflow than the author asked for).
      if (frontmatterError && isResearchWorkflow && !research) {
        const s = readRunState(projectDir, runId);
        s.status = 'failed';
        s.failureReason = `Research mode degraded: brief frontmatter could not be parsed (${frontmatterError}). The research loop needs a valid \`research:\` block (baseline + policy); refusing to silently fall back to plain dispatch. Fix the YAML and relaunch.`;
        s.completedAt = new Date().toISOString();
        writeRunState(projectDir, runId, s);
        recordRunEvent(projectDir, runId, {
          type: 'research_mode_degraded',
          runId,
          timestamp: s.completedAt,
          detail: frontmatterError,
        });
        writeCampaignEntry(projectDir, s);
        log.error({ runId, frontmatterError }, 'workflow=research but brief frontmatter failed to parse — failing loud instead of falling back to plain dispatch');
        return s;
      }
      if (isResearchWorkflow && !research) {
        log.warn({ runId }, 'workflow=research but brief has no `research:` block — research loop needs baseline+policy; falling back to plain dispatch');
      } else if (research && !isResearchWorkflow) {
        log.warn({ runId, workflow: workflow.name }, 'brief has a `research:` block but workflow is not `research` — research advance gate still active, but consider --workflow research for clarity');
      } else if (frontmatterError) {
        // Frontmatter was malformed but the run isn't a research loop — still
        // surface it (it may have intended terminal_states / program config).
        log.warn({ runId, frontmatterError }, 'brief frontmatter failed to parse — any terminal_states/program/research config in it was ignored');
      }
      // Program safeguard pre-check at run start. If violated, refuse to start
      // and write a program-level abort artifact for the orchestrator's next
      // poll to detect. Run state is set to failed so dashboard reflects it.
      if (program) {
        const violation = checkProgramSafeguards(projectDir, program);
        if (violation) {
          const abortDoc = `# Program safeguard violation\n\nProgram: ${program.name}\nPhase: ${program.phase}\nViolation: ${violation}\n\nRun was refused at start. To resume, address the violation (e.g. remove STOP file, prune ledger) and relaunch.\n`;
          try {
            const dir = program.ledger ? program.ledger.substring(0, program.ledger.lastIndexOf('/')) || '.' : '.';
            mkdirSync(join(projectDir, dir), { recursive: true });
            writeFileSync(join(projectDir, dir, 'program_aborted.md'), abortDoc, 'utf-8');
          } catch { /* non-critical */ }
          const s2 = readRunState(projectDir, runId);
          s2.status = 'failed';
          s2.failureReason = `Program safeguard: ${violation}`;
          s2.completedAt = new Date().toISOString();
          writeRunState(projectDir, runId, s2);
          log.error({ runId, violation }, 'Program safeguard violated; refusing to start');
          return s2;
        }
      }
    }
  }

  const resolvedAgentsDir = agentsDir ?? join(projectDir, 'config', 'agents');
  const basePrompt = loadBasePrompt(resolvedAgentsDir);
  // Apply base prompt to all pre-loaded agents
  for (const [k, v] of agents) agents.set(k, applyBasePrompt(v, basePrompt));
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);
  const availableSkillsList = listAvailableSkills(projectDir);

  // Supervisor brain: start before the iteration loop if enabled, stop in finally.
  if (supervise) {
    try {
      const supCfg = loadSupervisorConfig(projectDir);
      // loadSupervisorConfig already inherits adapter from defaults.yaml when not
      // explicitly set under supervisor:; final fallback is codex.
      const supAdapterName = supCfg.adapter || 'codex';
      const supAdapter = await loadAdapterByName(supAdapterName);
      supervisor = new Supervisor(projectDir, runId, supAdapter, supCfg, taskDescription ?? '');
      supervisor.start();
      log.info({ runId, adapter: supAdapterName, model: supCfg.model }, 'Supervisor started');
    } catch (err) {
      log.warn({ err }, 'Failed to start supervisor — continuing without it');
      supervisor = undefined;
    }
  }

  // Policy-owned terminal for a research/loop run whose iteration budget is exhausted without
  // the policy shipping/ceilinging (e.g. the agent produced too few measured rounds). Keeps the
  // research policy as the SOLE terminal authority — a research run never resolves as 'complete'.
  //
  // FIX A — `ceiling_hit` vs `incomplete`: this path is reached ONLY when the iteration budget
  // ran out before the policy itself shipped/ceilinged (a genuine policy stop_ceiling terminates
  // earlier, via tryAdvanceResearch). So the honest label depends on whether enough rounds were
  // actually BANKED to constitute a real exhaustive ceiling. A run whose journal has fewer banked
  // rounds than the policy needs to render a stop_ceiling verdict (e.g. rounds were integrity-
  // rejected, so the search never measured enough) is `incomplete` — budget exhausted mid-search,
  // NOT a clean honest-negative ceiling. A run that DID bank enough measured rounds (the policy
  // had the data to ceiling but the outer loop hit its iteration cap first) stays `ceiling_hit`.
  //
  // FIX B — observability: surface the count of integrity-rejected rounds (noop etc., recorded in
  // research_integrity_rejections.json) in the terminal detail, so honest work the gate discarded
  // (e.g. a baseline==0 margin objective's legitimate ~0 result) is VISIBLE in the terminal report
  // rather than silently invisible. This does NOT change the noop gate's decision.
  const finishResearchCeiling = async (
    state: StoreState,
    iterationNum: number,
    detail: string,
    execution: {
      stages: StageConfig[];
      injectedDispatchStages: Set<string>;
      planStageRetries: Map<string, number>;
    },
  ): Promise<StoreState> => {
    // Banked (journaled) measured rounds — the rounds that survived the integrity gates.
    let bankedRounds = 0;
    try {
      const j = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_journal.json'), 'utf-8'));
      if (j && Array.isArray(j.rounds)) bankedRounds = j.rounds.length;
    } catch { /* no journal → 0 banked */ }
    // Integrity-gate rejections, by reason (e.g. {"noop":3}). Surfaced for observability.
    let rejections: Record<string, number> = {};
    try {
      const r = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_integrity_rejections.json'), 'utf-8'));
      if (r && typeof r === 'object') rejections = r as Record<string, number>;
    } catch { /* no rejections file → none */ }
    const totalRejected = Object.values(rejections).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0);
    // Minimum banked rounds a genuine policy stop_ceiling would require: the policy ceilings at the
    // FIRST of maxRounds reached / haltAfterNoImprovement consecutive measured rounds. Task-agnostic:
    // no domain field/threshold — derived purely from the brief-declared stop conditions.
    const stop = state.research?.stop;
    const ceilingFloors: number[] = [];
    if (typeof stop?.maxRounds === 'number') ceilingFloors.push(stop.maxRounds);
    if (typeof stop?.haltAfterNoImprovement === 'number') ceilingFloors.push(stop.haltAfterNoImprovement);
    // With no stop conditions declared the policy can't render an exhaustive ceiling at all, so a
    // single banked round suffices to call it a (degenerate) ceiling; require >=1 banked round.
    const requiredRounds = ceilingFloors.length > 0 ? Math.min(...ceilingFloors) : 1;
    const insufficientRounds = bankedRounds < requiredRounds;

    let terminalDetail = detail;
    const terminalStatus = insufficientRounds ? RUN_STATUS.INCOMPLETE : RUN_STATUS.CEILING_HIT;
    const terminalFailureReason = insufficientRounds
      ? `${detail} (banked ${bankedRounds}/${requiredRounds} required measured rounds)`
      : undefined;
    if (totalRejected > 0) {
      const summary = Object.entries(rejections).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${k}:${n}`).join(', ');
      terminalDetail = `${detail} | integrity-rejected rounds: ${totalRejected} (${summary})`;
    }
    // FIX D — a budget-exhaustion terminal is always non-ship; record any declared confirm as not-run.
    recordConfirmNotRun(runDir(projectDir, runId), state.research?.confirm, terminalStatus);
    const declaredPathBE = state.terminalStates?.[terminalStatus]?.paths?.[0];
    const admittedOwner = declaredPathBE
      ? admittedTerminalOwner(runDirPath, declaredPathBE)
      : undefined;

    if (admittedOwner && declaredPathBE) {
      // A dynamic research DAG has admitted exactly one terminal owner. Budget
      // exhaustion is still a policy decision, but it must flow through that
      // owner just like an ordinary ship/ceiling decision; otherwise the
      // framework can bypass every mandatory ancestor at the last exit door.
      writeFileSync(join(runDirPath, 'research_decision.json'), `${JSON.stringify({
        version: 1,
        decision: 'stop_ceiling',
        terminalStatus,
        terminalPath: declaredPathBE,
        terminalOwner: admittedOwner,
        reason: terminalDetail,
        budgetExhausted: true,
        bankedRounds,
        requiredRounds,
      }, null, 2)}\n`, 'utf-8');
      mkdirSync(join(runDirPath, 'signals'), { recursive: true });
      const readyPath = join(runDirPath, 'signals', 'research_terminal_ready.json');
      writeFileSync(readyPath, `${JSON.stringify({
        version: 1,
        decision: 'stop_ceiling',
        terminalStatus,
        terminalPath: declaredPathBE,
        terminalOwner: admittedOwner,
        reason: terminalDetail,
      }, null, 2)}\n`, 'utf-8');
      appendSchedulerGuidanceOnce(
        runDirPath,
        admittedOwner,
        `[research-terminal-ready:budget-${iterationNum}]`,
        `The mechanically settled research decision is stop_ceiling because the iteration budget is exhausted. Read research_decision.json and write exactly ${declaredPathBE}; do not write any other terminal path.`,
        Object.keys(state.stages),
      );
      const finalizer = execution.stages.find((stage) => stage.id === admittedOwner);
      if (finalizer) {
        state.stages[admittedOwner] = rependStageStatus(state.stages[admittedOwner], 0);
        writeStageStatus(projectDir, runId, admittedOwner, state.stages[admittedOwner]);
        writeRunState(projectDir, runId, state);
        try { unlinkSync(readyPath); } catch { /* one-shot */ }
        await executeIteration(
          execution.stages, state, projectDir, runId, runDirPath, workflow, adapter, agents,
          resolvedAgentsDir, roleRegistry, execution.injectedDispatchStages, execution.planStageRetries,
          skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory,
        );
        const finalized = readRunState(projectDir, runId);
        if (isTerminalRunStatus(finalized.status) || isPausedRunStatus(finalized.status)) return finalized;
        const finalizerStatus = finalized.stages[admittedOwner];
        finalized.status = RUN_STATUS.INCOMPLETE;
        finalized.failureReason = finalizerStatus?.status === STAGE_STATUS.FAILED
          ? `Admitted terminal finalizer ${admittedOwner} failed after the budget-exhaustion decision: ${finalizerStatus.error ?? 'no error detail'}`
          : `Admitted terminal finalizer ${admittedOwner} completed without writing ${declaredPathBE}`;
        finalized.completedAt = new Date().toISOString();
        writeRunState(projectDir, runId, finalized);
        writeCampaignEntry(projectDir, finalized);
        return finalized;
      }
      state.status = RUN_STATUS.INCOMPLETE;
      state.failureReason = `Budget exhaustion resolved terminal owner ${admittedOwner}, but that stage was absent from the active admitted DAG.`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      return state;
    }

    state.status = terminalStatus;
    if (terminalFailureReason) state.failureReason = terminalFailureReason;
    state.completedAt = new Date().toISOString();
    // Engine bug #7 (found by `flowcrew rehearse` on the event-drift brief): this third
    // terminal exit door committed ceiling_hit with none of the honesty treatment the
    // research-loop and unified-gate doors carry — leftover stages froze pending, the
    // brief-declared terminal artifact path was never written, terminalArtifact stayed
    // unset. Every door must honor the same contract.
    markLeftoverStagesSkipped(state, `research terminal '${state.status}' committed (budget exhausted) before this stage ran`);
    if (declaredPathBE) state.terminalArtifact = declaredPathBE.split('/').pop();
    let reportAbs: string | undefined;
    let declaredAbs: string | undefined;
    let wroteReportCandidate = false;
    let wroteDeclaredCandidate = false;
    try {
      const rc2 = state.research;
      const reportDir = join(projectDir, rc2?.reportDir ?? 'docs');
      mkdirSync(reportDir, { recursive: true });
      let roundsMd = '';
      try {
        const j2 = JSON.parse(readFileSync(join(runDir(projectDir, runId), 'research_journal.json'), 'utf-8')) as { rounds?: ResearchRound[] };
        roundsMd = (j2.rounds ?? []).map((r) => r.outcome === 'no_candidate'
          ? `- ${r.label}: no candidate (${r.reason ?? 'no reason recorded'})`
          : `- ${r.label}: ${r.result}${r.confirmFailed ? ' (confirm gate FAILED — unconfirmed)' : ''}`).join('\n');
      } catch { /* no journal */ }
      const body = `# Research ${state.status === RUN_STATUS.CEILING_HIT ? 'Ceiling' : 'Incomplete'} Report\n\n`
        + `Decision: budget-exhausted ${state.status}\n`
        + `Reason: ${terminalDetail}\n\n`
        + `## Rounds\n${roundsMd}\n`;
      reportAbs = join(reportDir, state.status === RUN_STATUS.CEILING_HIT ? 'program_ceiling_report.md' : 'program_incomplete_report.md');
      if (!existsSync(reportAbs)) {
        writeFileSync(reportAbs, body, 'utf-8');
        wroteReportCandidate = true;
      }
      if (declaredPathBE) {
        declaredAbs = join(projectDir, declaredPathBE);
        if (!existsSync(declaredAbs)) {
          const declaredDir = declaredPathBE.includes('/') ? join(projectDir, declaredPathBE.substring(0, declaredPathBE.lastIndexOf('/'))) : projectDir;
          mkdirSync(declaredDir, { recursive: true });
          writeFileSync(declaredAbs, `> Engine-authored terminal candidate; acceptance remains subject to the declared reality checks.\n\n${body}`, 'utf-8');
          wroteDeclaredCandidate = true;
        }
      }
    } catch { /* non-critical */ }
    // Reality checks now observe the candidate they are expected to verify.
    // A rejected candidate is retained only inside the run directory as audit
    // evidence; it is not allowed to masquerade as committed terminal output.
    const rg = await enforceRealityGateBeforeTerminal(projectDir, runId, state, state.status);
    if (!rg.allowed) {
      const quarantine = (source: string | undefined, label: string): void => {
        if (!source || !existsSync(source)) return;
        try { renameSync(source, join(runDirPath, `reality_rejected_${label}`)); } catch { /* preserve evidence in place if move fails */ }
      };
      if (wroteReportCandidate) quarantine(reportAbs, reportAbs?.split('/').pop() ?? 'budget_report');
      if (wroteDeclaredCandidate) quarantine(declaredAbs, declaredPathBE?.split('/').pop() ?? 'terminal_candidate');
      return rg.state;
    }
    writeRunState(projectDir, runId, state);
    writeCampaignEntry(projectDir, state);
    recordRunEvent(projectDir, runId, { type: 'run_completed', runId, timestamp: state.completedAt, iteration: iterationNum, detail: terminalDetail });
    log.info({ runId, iteration: iterationNum, status: state.status, bankedRounds, requiredRounds, totalRejected }, 'Research run: iteration budget exhausted — policy-owned terminal (no gate-pass complete)');
    await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
    return state;
  };
  // Iteration loop
  // A resumed park continues its own iteration; a fresh/relaunched run starts at 1.
  for (let iteration = resumeAtIteration; iteration <= maxIterations; iteration++) {
    const isResumedIteration = resumingFromPark && iteration === resumeAtIteration;
    let state = readRunState(projectDir, runId);
    requireKnownRunStatus(state.status, `execute scheduler iteration for run ${runId}`);

    // Exit if run was cancelled externally or already terminated
    if (isTerminalRunStatus(state.status)) {
      return state;
    }

    const repeatedBlockage = concludeRepeatedBlockage(
      state,
      { projectDir, runId, runDirPath, iteration },
    );
    if (repeatedBlockage) {
      await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
      return repeatedBlockage;
    }

    // [Unified terminal gate, call site 1 of 2] Catch a terminal artifact
    // written by a PRIOR iteration (or present at start). Takes precedence
    // over supervisor-DONE below. Floor-unmet writes a hint and falls through.
    // [Approval park gate, call site 1 of 2] An unresolved approval request
    // written by a previous iteration (or still unresolved at relaunch) parks
    // again instead of re-executing the consequential action.
    const parkedTop = await tryParkOnApprovalRequest(state, { projectDir, runId, runDirPath, iteration });
    if (parkedTop) return parkedTop;

    const terminalTop = await tryTerminateOnTerminalState(state, { projectDir, runId, runDirPath, iteration, adapter });
    if (terminalTop.decision === 'matched') return terminalTop.state;

    // Honor supervisor DONE: if `signals/goal_met.json` exists at the top of
    // any iteration after the first, the supervisor has judged the original
    // goal fully met by prior-iteration evidence. Mark the run complete and
    // exit the loop instead of burning more iterations on incremental gains.
    // Iteration 1 cannot reference prior evidence, so we skip the check there.
    //
    // Research mode is EXEMPT: termination is owned by the research policy
    // (ship on `beat`, ceiling on max_rounds/no-improvement) — not by the
    // supervisor's "goal met" heuristic. Otherwise the supervisor mistakes a
    // single compliant round (e.g. "Tier 1 audit passed") for the whole
    // exhaustive search being done and ends the loop prematurely.
    if (iteration > 1 && !state.research) {
      const goalMetPath = join(runDir(projectDir, runId), 'signals', 'goal_met.json');
      if (existsSync(goalMetPath)) {
        let goalReason = 'Supervisor signaled DONE (signals/goal_met.json present)';
        try {
          const sig = JSON.parse(readFileSync(goalMetPath, 'utf-8')) as { reason?: string };
          if (sig.reason) goalReason = `Supervisor DONE: ${sig.reason}`;
        } catch { /* malformed; keep generic reason */ }
        // Terminal-state already took precedence at the top-of-iteration gate
        // above (call site 1), so reaching here means no terminal artifact —
        // a plain supervisor-DONE completion.
        const unresolvedStageIds = guardPlainCompletionWithStageObligations(
          state,
          projectDir,
          runId,
          iteration,
          'supervisor_goal_met',
        );
        if (unresolvedStageIds.length === 0) {
          const terminalConclusion = await concludeDeclaredTerminalAtQuiescence(
            state,
            [
              ...baseStages,
              ...(Array.isArray(state.dispatchedStages) ? state.dispatchedStages as StageConfig[] : []),
            ],
            { projectDir, runId, runDirPath, iteration, adapter },
            'supervisor_goal_met',
          );
          if (terminalConclusion) return terminalConclusion;
          state.status = 'complete';
          state.completedAt = new Date().toISOString();
          const realityGate = await enforceRealityGateBeforeTerminal(projectDir, runId, state, state.status);
          if (!realityGate.allowed) return realityGate.state;
          writeRunState(projectDir, runId, state);
          writeCampaignEntry(projectDir, state);
          recordRunEvent(projectDir, runId, {
            type: 'run_completed',
            runId,
            timestamp: state.completedAt,
            iteration,
            detail: goalReason,
          });
          log.info({ runId, iteration, goalReason }, 'Supervisor DONE acknowledged; stopping iteration loop early');
          await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
          return state;
        }
      }
    }

    // (Terminal-state detection consolidated to the unified gate at the top of
    // this iteration loop + the eager post-batch check inside executeIteration.
    // The previous inline duplicate here was removed.)

    // Bug ② fix: archive the previous iteration's accumulated supervisor
    // guidance so this iteration starts with an empty `supervisor_guidance.md`.
    // The archived file under `guidance_history/iter_${N-1}.md` is later
    // injected into the planner's system prompt by worker.ts, so prior-iter
    // GUIDE messages still impact this iteration's plan — but they no longer
    // mix with this iteration's fresh GUIDE messages in the same file.
    if (iteration > 1 && !isResumedIteration) {
      try {
        const runDirAbs = runDir(projectDir, runId);
        const guidancePath = join(runDirAbs, 'supervisor_guidance.md');
        if (existsSync(guidancePath)) {
          const archiveDir = join(runDirAbs, 'guidance_history');
          mkdirSync(archiveDir, { recursive: true });
          renameSync(guidancePath, join(archiveDir, `iter_${iteration - 1}.md`));
        }
      } catch (err) {
        log.warn({ err, runId, iteration }, 'Failed to archive supervisor guidance');
      }
    }

    // Honor supervisor REPLAN: the supervisor judged the current approach
    // fundamentally wrong and wrote signals/replan.json (previously a DEAD signal
    // — written, never read). Consume it and inject a hard-pivot hint into this
    // iteration's fresh guidance so the re-plan avoids the rejected approach. The
    // signal is one-shot (deleted on consume) and bounded by maxIterations.
    if (iteration > 1) {
      const replanPath = join(runDir(projectDir, runId), 'signals', 'replan.json');
      if (existsSync(replanPath)) {
        let replanReason = 'supervisor judged the approach fundamentally wrong';
        try {
          const sig = JSON.parse(readFileSync(replanPath, 'utf-8')) as { reason?: string };
          if (sig.reason) replanReason = sig.reason;
        } catch { /* malformed; keep generic reason */ }
        try { unlinkSync(replanPath); } catch { /* already consumed */ }
        appendSchedulerGuidanceOnce(
          runDir(projectDir, runId),
          RUN_WIDE_GUIDANCE_TARGET,
          `[supervisor-replan:iteration-${iteration}]`,
          `⚠️ PIVOT REQUIRED (supervisor REPLAN): ${replanReason}\nThe previous approach was judged fundamentally wrong. Plan a materially DIFFERENT approach; do not repeat the rejected direction.`,
        );
        recordRunEvent(projectDir, runId, { type: 'supervisor_replan', runId, timestamp: new Date().toISOString(), iteration, detail: replanReason });
        log.info({ runId, iteration, replanReason }, 'Supervisor REPLAN consumed; pivot hint injected for this iteration plan');
      }
    }

    state.currentIteration = iteration;
    const campaignStorageKey = resolveCampaignStorageKey({
      campaignId: state.campaignId,
      campaignStorageKey: state.campaignStorageKey,
      campaignName: state.campaignName,
    });
    if (campaignStorageKey) {
      state.campaignStorageKey = campaignStorageKey;
      state.campaignIteration = iteration;
    } else {
      state.campaignIteration = undefined;
    }
    writeRunState(projectDir, runId, state);

    // Build sorted stages for this iteration: start from base stages
    const sorted: StageConfig[] = baseStages.map(s => ({ ...s }));
    const injectedDispatchStages = new Set<string>();
    // Per-plan-stage bounded retry counter for the empty/invalid-dispatch case
    // (FIX 1). Scoped to this iteration's executeIteration call so a transient
    // dispatch flake re-plans up to default_plan_stage_retries times before
    // escalating with specifics, rather than being fatal on the first miss.
    const planStageRetries = new Map<string, number>();

    // Delete dispatch.yaml before plan stage runs only on re-plan (iteration > 1)
    const dispatchPathPre = join(runDirPath, 'dispatch.yaml');
    if (iteration > 1 && !isResumedIteration && existsSync(dispatchPathPre)) unlinkSync(dispatchPathPre);

    // Reset all base stages to pending for this iteration
    state = readRunState(projectDir, runId);
    // On iteration 2+, reset base stage statuses and clear old dispatched stages
    if (iteration > 1 && !isResumedIteration) {
      // Persist required work before retiring the old dynamic DAG. The retired
      // usage ledger preserves cost/history; this separate ledger preserves the
      // fact that a pending/running required stage was never fulfilled.
      const previousDispatchedStages = Array.isArray(state.dispatchedStages)
        ? state.dispatchedStages as StageConfig[]
        : [];
      reconcileUnresolvedStageObligations(
        state,
        previousDispatchedStages,
        Math.max(1, iteration - 1),
        runDirPath,
      );
      // Materialize immutable evidence for every old dynamic stage before the
      // single run.json write that replaces the active DAG. The archive files
      // exist first; the atomic state write below then publishes their paths and
      // the deletion together, so no persisted state can point at missing proof.
      const baseIds = new Set(baseStages.map(s => s.id));
      const retiringStageIds = Object.keys(state.stages).filter((sid) => !baseIds.has(sid));
      const retiredIteration = Math.max(1, iteration - 1);
      const capturedEvidence = retiringStageIds.map((sid) => captureStageEvidence(
        projectDir,
        runId,
        retiredIteration,
        sid,
        state.stages[sid],
      ));
      state.stageEvidence ??= [];
      state.retiredStageUsage ??= [];
      for (const evidence of capturedEvidence) {
        if (!state.stageEvidence.some((entry) =>
          entry.iteration === evidence.iteration && entry.stageId === evidence.stageId)) {
          state.stageEvidence.push(evidence);
        }
        state.retiredStageUsage.push({
          stageId: evidence.stageId,
          iteration: evidence.iteration,
          status: evidence.status,
        });
      }
      for (const sid of retiringStageIds) {
        delete state.stages[sid];
      }
      for (const s of baseStages) {
        state.stages[s.id] = rependStageStatus(state.stages[s.id], 0);
        mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
      }
      state.dispatchedStages = undefined;
      state.status = 'running';
      writeRunState(projectDir, runId, state);

      // Clean stale verdict files from previous iteration so new gates start fresh
      try {
        for (const f of readdirSync(runDirPath)) {
          if (f.startsWith('verdict') && f.endsWith('.json')) {
            unlinkSync(join(runDirPath, f));
          }
        }
      } catch { /* best effort */ }

      // Re-write workflow.yaml to base stages only
      writeFileSync(join(runDirPath, 'workflow.yaml'), workflowYaml, 'utf-8');
    }

    // Track dispatched stage IDs for this iteration
    let iterationDispatchedIds: string[] = [];

    // Campaign health check: inject researcher if regression/plateau detected
    if (campaignStorageKey && iteration > 1) {
      const entries = readCampaignEntries(projectDir, campaignStorageKey);
      const triggers = state.campaignTriggers;
      const alert = checkCampaignHealth(entries, triggers);
      if (alert) {
        const triggeredAt = new Date().toISOString();
        state.campaignAlert = {
          ...alert,
          source: 'campaign_health',
          triggeredAt,
          iteration,
        };
        state.researchInjection = {
          source: 'campaign_health',
          triggeredAt,
          iteration,
          alertType: alert.type,
          message: alert.message,
        };
        writeRunState(projectDir, runId, state);
        recordRunEvent(projectDir, runId, {
          type: 'campaign_alert',
          runId,
          timestamp: triggeredAt,
          iteration,
          detail: `${alert.type}: ${alert.message}`,
        });
        recordRunEvent(projectDir, runId, {
          type: 'research_injected',
          runId,
          timestamp: triggeredAt,
          iteration,
          detail: `${alert.type}: ${alert.message}`,
        });
        log.info({ runId, alert: alert.type }, 'Campaign health alert — researcher will be injected via planner context');
        // Auto-mark current approach nodes as dead ends
        try {
          const kg = readKG(projectDir, runId);
          for (const node of kg.nodes.filter(n => n.type === 'approach')) {
            markDeadEnd(projectDir, runId, node.id, `Marked dead_end by campaign health: ${alert.message}`);
          }
        } catch { /* non-fatal */ }
      } else if (state.campaignAlert) {
        state.campaignAlert = undefined;
        writeRunState(projectDir, runId, state);
      }
    }

    // Inner execution loop for this iteration
    const iterationResult = await executeIteration(
      sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents,
      resolvedAgentsDir, roleRegistry, injectedDispatchStages, planStageRetries, skills, taskDescription,
      availableSkillsList, attemptDeadlineClockFactory,
    );

    state = readRunState(projectDir, runId);

    // If the eager post-batch gate inside executeIteration already terminated
    // the run (set a terminal status + fired the hook), exit now — do NOT fall
    // through to the gate/allDone exits below, which would re-fire the hook.
    if (isTerminalStatus(state.status)) {
      clearGateContinuationsForStages(runDirPath, sorted);
      return state;
    }
    if (isPausedRunStatus(state.status)) return state;

    const recoveredTerminal = recoverTerminalStudyCompletion(projectDir, runId, state);
    if (recoveredTerminal) {
      clearGateContinuationsForStages(runDirPath, sorted);
      writeRunState(projectDir, runId, recoveredTerminal);
      writeCampaignEntry(projectDir, recoveredTerminal);
      return recoveredTerminal;
    }

    // Collect dispatched stage IDs (only from stages in the current sorted pipeline, not orphans)
    const baseIds = new Set(baseStages.map(s => s.id));
    iterationDispatchedIds = sorted
      .filter(s => !baseIds.has(s.id))
      .map(s => s.id);

    // A supervisor rejection is part of gate settlement, not an afterthought.
    // Consume it before the bounded retry loop so a rejected gate is converted
    // into a normal pass:false fact and must traverse its admitted retry_to
    // repair route before research evidence or terminal work can advance.
    while (consumeSupervisorReject(
      state,
      sorted,
      iterationDispatchedIds,
      { projectDir, runId, runDirPath, iteration },
    )) {
      await executeIteration(
        sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents,
        resolvedAgentsDir, roleRegistry, injectedDispatchStages, planStageRetries,
        skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory,
      );
      state = readRunState(projectDir, runId);
      if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
    }
    state = readRunState(projectDir, runId);
    if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;

    // === INNER LOOP (retry_to) ===
    const maxInnerRetries = Math.max(0, Math.floor(Number(state.maxRetries ?? loadDefaults(projectDir).gate_retry_loops)));
    let innerRetriesUsed = 0;
    let revisitRuntimeFacts = true;
    while (revisitRuntimeFacts) {
    revisitRuntimeFacts = false;
    state = readRunState(projectDir, runId);
    if (iterationDispatchedIds.length > 0) {
      const outerCheck = collectGateRuntimeFacts(sorted, state, projectDir, runId);
      const { allPass, failedGateIds, rejectedGateIds } = outerCheck;
      log.info({
        event: 'gate_retry_outer_check',
        runId,
        iteration,
        source: 'fresh-runtime-collection',
        allPass,
        failedGateIds,
        rejectedGateIds,
        ...gateRetryDiagnosticSnapshot(sorted, state, projectDir, runId, runDirPath, outerCheck),
      }, 'Gate retry outer check');
      if (outerCheck.contractRefusals.length > 0) {
        archiveRejectedGateRuntimeFacts(
          runDirPath,
          gateArchiveCoordinate(iteration, 1),
          outerCheck,
        );
      }
      if (terminateForGateContractRefusal(state, outerCheck, projectDir, runId, iteration)) return state;
      if (!allPass) {
        // Terminal incompleteness is not a repair verdict. Only a completed,
        // validated pass:false fact can make its retry_to stage eligible.
        const retryStages = findAllRetryToStages(sorted, rejectedGateIds);
        if (retryStages.length > 0) {
          for (let inner = innerRetriesUsed; inner < maxInnerRetries; inner++) {

            // Check for cancellation between retries
            state = readRunState(projectDir, runId);
            if (isTerminalRunStatus(state.status)) break;

            // Determine which retry stages need to run based on current failed gates
            // Mechanism fix: the entrance owns one coherent, current policy-aware
            // fact read. Round zero must not inherit the outer snapshot because a
            // verdict/metric/status may have been reconciled after that snapshot.
            const currentCheck = collectGateRuntimeFacts(sorted, state, projectDir, runId);
            if (currentCheck.contractRefusals.length > 0) {
              archiveRejectedGateRuntimeFacts(
                runDirPath,
                gateArchiveCoordinate(iteration, inner + 1),
                currentCheck,
              );
            }
            if (terminateForGateContractRefusal(state, currentCheck, projectDir, runId, iteration)) return state;
            const currentRejectedGateIds = currentCheck.rejectedGateIds;
            const breakConditions = { allPass: currentCheck.allPass };
            const shouldBreakForPassingGates = breakConditions.allPass;
            log.info({
              event: 'gate_retry_entry_check',
              runId,
              iteration,
              inner,
              source: 'fresh-runtime-collection',
              allPass: currentCheck.allPass,
              failedGateIds: currentCheck.failedGateIds,
              rejectedGateIds: currentCheck.rejectedGateIds,
              currentRejectedGateIds,
              breakConditions,
              decision: shouldBreakForPassingGates ? 'break' : 'continue',
              unsatisfiedBreakConditions: Object.entries(breakConditions)
                .filter(([, satisfied]) => !satisfied)
                .map(([condition]) => condition),
              ...gateRetryDiagnosticSnapshot(sorted, state, projectDir, runId, runDirPath, currentCheck),
            }, 'Gate retry entry check');
            if (shouldBreakForPassingGates) break;

            const activeRetryStages = findAllRetryToStages(sorted, currentRejectedGateIds);
            if (activeRetryStages.length === 0) {
              log.info({ event: 'gate_retry_entry_break', runId, iteration, inner, reason: 'no-active-retry-stages' }, 'Gate retry entry break');
              break;
            }

            const repairRound = inner + 1;
            const activeGateIds = [...new Set(activeRetryStages.flatMap((stage) => stage.retry_to ?? []))];
            // Defense in depth (not the mechanism fix): immediately before any
            // evidence clearing, reset, or repair dispatch, re-read exactly the
            // related gates. A stale entrance can never launch repair over a set
            // that is now fully accepted.
            const dispatchState = readRunState(projectDir, runId);
            const activeGateSet = new Set(activeGateIds);
            const dispatchCheck = collectGateRuntimeFacts(
              sorted.filter((stage) => stage.is_gate && activeGateSet.has(stage.id)),
              dispatchState,
              projectDir,
              runId,
            );
            if (dispatchCheck.contractRefusals.length > 0) {
              archiveRejectedGateRuntimeFacts(
                runDirPath,
                gateArchiveCoordinate(iteration, repairRound),
                dispatchCheck,
              );
            }
            if (terminateForGateContractRefusal(dispatchState, dispatchCheck, projectDir, runId, iteration)) {
              return dispatchState;
            }
            if (dispatchCheck.allPass) {
              state = dispatchState;
              log.info({
                event: 'gate_retry_dispatch_guard',
                runId,
                iteration,
                inner,
                activeGateIds,
                allPass: dispatchCheck.allPass,
                failedGateIds: dispatchCheck.failedGateIds,
                rejectedGateIds: dispatchCheck.rejectedGateIds,
                decision: 'skip-repair-dispatch',
              }, 'Gate retry dispatch guard stopped a stale repair dispatch');
              break;
            }
            // Preserve the rejected evidence before the live verdict/output paths
            // are reused, then capture the repair preimage while it is still exact.
            archiveGateRoundEvidence(
              runDirPath,
              gateArchiveCoordinate(iteration, repairRound),
              activeGateIds,
              new Map(
                dispatchCheck.evaluations
                  .filter((e) => e.effectiveVerdict)
                  .map((e) => [e.id, e.effectiveVerdict!] as const),
              ),
            );
            const repairSnapshot = captureRepairRoundSnapshot(projectDir, activeRetryStages);

            // Clear verdict and metric files for all gates referenced by active retry stages
            for (const gid of activeGateIds) {
              const perGate = join(runDirPath, `verdict_${gid}.json`);
              if (existsSync(perGate)) unlinkSync(perGate);
              const gateMetric = join(runDirPath, 'stages', gid, 'metric.json');
              if (existsSync(gateMetric)) unlinkSync(gateMetric);
              const staleCorrection = gateVerdictCorrectionPath(runDirPath, gid);
              if (existsSync(staleCorrection)) unlinkSync(staleCorrection);
            }
            const sharedVerdict = join(runDirPath, 'verdict.json');
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Reset and run all active retry stages (possibly in parallel)
            for (const retryStage of activeRetryStages) {
              state.stages[retryStage.id] = rependStageStatus(state.stages[retryStage.id], 0);
              mkdirSync(join(runDirPath, 'stages', retryStage.id), { recursive: true });
              // Clear live.log so the SSE feed shows only the current attempt's output
              const liveLog = join(runDirPath, 'stages', retryStage.id, 'live.log');
              if (existsSync(liveLog)) unlinkSync(liveLog);
            }
            writeRunState(projectDir, runId, state);

            await runScopeSafeStageGroup(
              activeRetryStages,
              projectDir,
              runId,
              state.currentIteration ?? 1,
              (retryStage) => executeSingleStage(retryStage, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, undefined, undefined, availableSkillsList, attemptDeadlineClockFactory),
              repairSnapshot,
            );
            innerRetriesUsed = inner + 1;
            syncStageStatuses(projectDir, runId, activeRetryStages.map(s => s.id));
            state = readRunState(projectDir, runId);
            const roundDiffPath = writeRepairRoundDiffArtifact({
              snapshot: repairSnapshot,
              projectDir,
              runDirPath,
              iteration,
              round: repairRound,
              repairStages: activeRetryStages,
              statuses: state.stages,
            });

            // Check for cancellation after fix stages complete
            if (isTerminalRunStatus(state.status)) break;

            // Skip gate re-runs if any fix stage itself failed (saves wasted agent calls)
            const anyFixFailed = activeRetryStages.some(s => state.stages[s.id]?.status === STAGE_STATUS.FAILED);
            if (anyFixFailed) {
              // If the failure is a transient adapter error, continue to next retry instead of aborting
              const allAdapterErrors = activeRetryStages
                .filter(s => state.stages[s.id]?.status === STAGE_STATUS.FAILED)
                .every(s => state.stages[s.id]?.error === 'adapter connection failed');
              if (allAdapterErrors && inner < maxInnerRetries - 1) {
                log.info({ runId, iteration, inner }, 'Fix stage failed due to adapter error — retrying');
                continue;
              }
              log.info({ runId, iteration, inner }, 'Fix stage failed — skipping gate re-evaluation');
              break;
            }

            // Collect all gates referenced by all active retry stages
            const allRetryGateIds = new Set(activeGateIds);

            // Determine which gates to re-run
            const gatesToRerun = sorted.filter(s => {
              if (!s.is_gate || !allRetryGateIds.has(s.id)) return false;
              const v = readGateVerdict(projectDir, s.id, runId);
              return !v || v.pass !== true;
            });
            for (const gate of gatesToRerun) {
              const perGate = join(runDirPath, `verdict_${gate.id}.json`);
              if (existsSync(perGate)) unlinkSync(perGate);
              state.stages[gate.id] = rependStageStatus(state.stages[gate.id], 0);
              mkdirSync(join(runDirPath, 'stages', gate.id), { recursive: true });
              // Clear live.log so the SSE feed shows only the current re-evaluation's output
              const liveLog = join(runDirPath, 'stages', gate.id, 'live.log');
              if (existsSync(liveLog)) unlinkSync(liveLog);
              writeRunState(projectDir, runId, state);
            }
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Run gate stages (possibly in parallel), passing fix stage IDs for context
            if (gatesToRerun.length > 0) {
              await runScopeSafeStageGroup(
                gatesToRerun,
                projectDir,
                runId,
                state.currentIteration ?? 1,
                (gate) => executeSingleStage(gate, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, activeRetryStages.map(s => s.id), roundDiffPath, availableSkillsList, attemptDeadlineClockFactory),
              );
              syncStageStatuses(projectDir, runId, gatesToRerun.map(s => s.id));
            }
            state = readRunState(projectDir, runId);

            // Check gates again
            const recheck = collectGateRuntimeFacts(sorted, state, projectDir, runId);
            if (recheck.contractRefusals.length > 0) {
              archiveRejectedGateRuntimeFacts(
                runDirPath,
                gateArchiveCoordinate(iteration, inner + 2),
                recheck,
              );
            }
            if (terminateForGateContractRefusal(state, recheck, projectDir, runId, iteration)) return state;
            if (recheck.allPass) break;
            if (inner === maxInnerRetries - 1) {
              log.info({ runId, iteration }, 'Inner loop exhausted, falling back to outer re-plan');
            }
          }
        }
      }
    }

    // A rejected gate blocks successors. Once no explicit rejection remains,
    // resume the DAG even if later gates are still pending; then revisit runtime
    // facts so a newly-run later gate can trigger only its own repair.
    state = readRunState(projectDir, runId);
    if (
      iterationDispatchedIds.length > 0
      && collectGateRuntimeFacts(sorted, state, projectDir, runId).rejectedGateIds.length === 0
      && sorted.some((stage) => (
        isPendingStageStatus(state.stages[stage.id]?.status ?? '')
        && !(stage.retry_to?.length && !stage.is_gate)
      ))
    ) {
      const beforeContinuation = JSON.stringify(Object.fromEntries(
        sorted.map((stage) => [stage.id, [state.stages[stage.id]?.status, state.stages[stage.id]?.attempts?.length ?? 0]]),
      ));
      await executeIteration(
        sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents,
        resolvedAgentsDir, roleRegistry, injectedDispatchStages, planStageRetries,
        skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory,
      );
      state = readRunState(projectDir, runId);
      const afterContinuation = JSON.stringify(Object.fromEntries(
        sorted.map((stage) => [stage.id, [state.stages[stage.id]?.status, state.stages[stage.id]?.attempts?.length ?? 0]]),
      ));
      revisitRuntimeFacts = beforeContinuation !== afterContinuation;
    }
    const supervisorReworked = !anyFailed(state) && !isTerminalRunStatus(state.status)
      ? consumeSupervisorReject(
          state,
          sorted,
          iterationDispatchedIds,
          { projectDir, runId, runDirPath, iteration },
        )
      : false;
    if (supervisorReworked) {
      await executeIteration(
        sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents,
        resolvedAgentsDir, roleRegistry, injectedDispatchStages, planStageRetries,
        skills, taskDescription, availableSkillsList, attemptDeadlineClockFactory,
      );
      state = readRunState(projectDir, runId);
      if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
      revisitRuntimeFacts = true;
    } else {
      state = readRunState(projectDir, runId);
      if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
    }
    }

    // No gate session is useful beyond this iteration's bounded repair loop.
    // Passed, exhausted, and outer-replan paths all converge here.
    clearGateContinuationsForStages(runDirPath, sorted);

    state = readRunState(projectDir, runId);

    // Issue 12 fix: finalize any retry_to stages still marked "running" after inner loop
    for (const s of sorted) {
      if (s.retry_to && s.retry_to.length > 0 && state.stages[s.id] && isRunningStageStatus(state.stages[s.id].status)) {
        state.stages[s.id] = { ...state.stages[s.id], status: STAGE_STATUS.SKIPPED };
        writeRunState(projectDir, runId, state);
      }
    }

    // Append iteration log
    appendIterationLog(projectDir, runId, iteration, state, iterationDispatchedIds, baseStages.map(s => s.id), innerRetriesUsed, maxInnerRetries);
    writeCampaignEntry(projectDir, state);

    // Update KG metadata with campaign metric
    try {
      const metricForKG = findCampaignMetric(projectDir, state);
      if (metricForKG) updateMetadata(projectDir, runId, metricForKG.score, metricForKG.metric);
    } catch { /* non-fatal */ }

    // Ratchet check: update knowledge graph with iteration score
    try {
      const metric = findCampaignMetric(projectDir, state);
      if (metric) {
        const result = ratchetCheck(projectDir, runId, metric.score, metric.metric, metric.gate);
        log.info({ runId, iteration, improved: result.improved, score: metric.score, previousBest: result.previousBest }, 'Ratchet check completed');
      }
    } catch (err) {
      log.warn({ runId, iteration, err }, 'Ratchet check failed (non-fatal)');
    }

    recordRunEvent(projectDir, runId, {
      type: 'iteration_completed',
      runId,
      timestamp: new Date().toISOString(),
      iteration,
      detail: `iteration ${iteration} completed`,
    });

    // A research result is not durable campaign evidence until every gate has
    // settled green and every supervisor rejection/re-work has settled. This is
    // the sole research-advance call site: an eager pre-gate consumer could
    // previously bank a rejected round and move the campaign to the next one.
    state = readRunState(projectDir, runId);
    if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
    const settledResearchGates = collectGateRuntimeFacts(sorted, state, projectDir, runId);
    if (state.research && researchAdvanceEligible({
      gatesSettled: settledResearchGates.allPass,
      stageFailed: anyFailed(state),
      supervisorRejectPending: readPendingRejectSignal(runDirPath) !== null,
    })) {
      const researchResult = await tryAdvanceResearch(state, { projectDir, runId, runDirPath, iteration, adapter });
      if (researchResult) return researchResult;
      state = readRunState(projectDir, runId);
      const repeatedAfterResearch = concludeRepeatedBlockage(
        state,
        { projectDir, runId, runDirPath, iteration },
      );
      if (repeatedAfterResearch) {
        await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
        return repeatedAfterResearch;
      }
      const terminalReadyPath = join(runDirPath, 'signals', 'research_terminal_ready.json');
      if (existsSync(terminalReadyPath)) {
        let terminalOwner: string | undefined;
        try {
          const signal = JSON.parse(readFileSync(terminalReadyPath, 'utf-8')) as Record<string, unknown>;
          if (typeof signal.terminalOwner === 'string') terminalOwner = signal.terminalOwner;
        } catch { /* handled as an unresolved owner below */ }
        const finalizer = terminalOwner ? sorted.find((stage) => stage.id === terminalOwner) : undefined;
        if (!finalizer) {
          state.status = RUN_STATUS.INCOMPLETE;
          state.failureReason = 'Research policy reached a terminal decision, but its admitted terminal owner could not be resolved.';
          state.completedAt = new Date().toISOString();
          writeRunState(projectDir, runId, state);
          return state;
        }
        state.stages[finalizer.id] = rependStageStatus(state.stages[finalizer.id], 0);
        writeStageStatus(projectDir, runId, finalizer.id, state.stages[finalizer.id]);
        writeRunState(projectDir, runId, state);
        try { unlinkSync(terminalReadyPath); } catch { /* one-shot */ }
        const finalized = await executeIteration(
          sorted, state, projectDir, runId, runDirPath, workflow, adapter, agents,
          resolvedAgentsDir, roleRegistry, injectedDispatchStages, planStageRetries, skills, taskDescription,
          availableSkillsList, attemptDeadlineClockFactory,
        );
        state = readRunState(projectDir, runId);
        if (isTerminalRunStatus(state.status) || isPausedRunStatus(state.status)) return state;
        if (finalized.stages[finalizer.id]?.status === STAGE_STATUS.FAILED) {
          observeStableBlockage({
            runDirPath,
            kind: 'terminal_finalizer',
            stageId: finalizer.id,
            detail: finalized.stages[finalizer.id]?.error ?? 'terminal finalizer failed',
            evidenceDigest: (() => {
              const path = join(runDirPath, 'stages', finalizer.id, 'output.md');
              try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return undefined; }
            })(),
            threshold: state.campaignTriggers?.repeatedFailureAfter,
          });
          const repeatedFinalizer = concludeRepeatedBlockage(
            state,
            { projectDir, runId, runDirPath, iteration },
          );
          if (repeatedFinalizer) {
            await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
            return repeatedFinalizer;
          }
        }
      }
      const contSignal = join(runDirPath, 'signals', 'research_continue.json');
      if (existsSync(contSignal) && iteration < maxIterations) {
        try { unlinkSync(contSignal); } catch { /* non-critical */ }
        clearGateContinuationsForStages(runDirPath, sorted);
        log.info({ runId, iteration }, 'Settled gates accepted the research round; re-planning the next round');
        continue;
      }
    }

    // Check if last gate passed
    if (iterationDispatchedIds.length > 0 && !anyFailed(state) && lastGatePassed(state, iterationDispatchedIds, sorted, projectDir, runId)) {
      // Bug ③ fix: before marking the whole run complete, see if any gate
      // verdict in this iteration declared `phaseComplete: true` together with
      // a non-empty `nextPhase`. If yes — and we still have iteration budget —
      // the planner is signalling "this phase done, advance to the next
      // phase". Continue the outer loop so the next planner iteration can
      // dispatch nextPhase's stages instead of prematurely marking the whole
      // run complete.
      const pendingNextPhase = (() => {
        try {
          const gateStageIds = iterationDispatchedIds.filter((id) => {
            const stage = sorted.find((s) => s.id === id);
            return stage?.is_gate === true;
          });
          for (const gid of gateStageIds) {
            const vPath = join(runDir(projectDir, runId), `verdict_${gid}.json`);
            if (!existsSync(vPath)) continue;
            let v: Record<string, unknown>;
            try { v = JSON.parse(readFileSync(vPath, 'utf-8')); } catch { continue; }
            const phaseComplete = v.phaseComplete === true || v.phase_complete === true;
            const nextPhaseRaw = v.nextPhase ?? v.next_phase;
            const nextPhase = typeof nextPhaseRaw === 'string' ? nextPhaseRaw.trim() : '';
            if (phaseComplete && nextPhase) return { gateId: gid, nextPhase };
          }
        } catch { /* non-critical */ }
        return null;
      })();
      const unresolvedStageIds = guardPlainCompletionWithStageObligations(
        state,
        projectDir,
        runId,
        iteration,
        'gate_pass',
      );
      if (pendingNextPhase && iteration < maxIterations) {
        log.info({ runId, iteration, gate: pendingNextPhase.gateId, nextPhase: pendingNextPhase.nextPhase }, 'Gate passed with nextPhase set — continuing to next iteration instead of marking complete');
        continue;
      }
      // Terminal-authority invariant (P1.3): on a research/loop run the POLICY is the SOLE
      // terminal authority (ship/ceiling via tryAdvanceResearch at the iteration top). A passing
      // gate must NOT complete the run — that bypass let a run end with too few (or zero) measured
      // rounds. Keep re-planning until the policy terminates; if the iteration budget is exhausted
      // first, ceiling (insufficient measured rounds) — never a silent 'complete'.
      if (state.research) {
        if (iteration < maxIterations) {
          log.info({ runId, iteration }, 'Research run: gate passed but policy has not shipped/ceilinged — continuing (policy is sole terminal authority)');
          continue;
        }
        return await finishResearchCeiling(
          state,
          iteration,
          'research ceiling: iteration budget exhausted without a policy ship/ceiling (insufficient measured rounds)',
          { stages: sorted, injectedDispatchStages, planStageRetries },
        );
      }
      // Terminal-state already handled by the top gate + eager post-batch gate
      // (with an isTerminalStatus early-return after executeIteration), so
      // reaching here means a plain gate-passed completion.
      if (unresolvedStageIds.length > 0) {
        if (iteration < maxIterations) {
          log.info({ runId, iteration, unresolvedStageIds }, 'Gate passed, but required stages remain unresolved — re-planning');
          continue;
        }
      } else {
        const terminalConclusion = await concludeDeclaredTerminalAtQuiescence(
          state,
          sorted,
          { projectDir, runId, runDirPath, iteration, adapter },
          'gate_pass',
        );
        if (terminalConclusion) return terminalConclusion;
        state.status = 'complete';
        state.completedAt = new Date().toISOString();
        const realityGate = await enforceRealityGateBeforeTerminal(projectDir, runId, state, state.status);
        if (!realityGate.allowed) return realityGate.state;
        // A retry stage that never ran because every related gate accepted the
        // work has a truthful terminal disposition: skipped, not indefinitely
        // pending and not falsely complete.
        const terminalContract = loadGateContract(projectDir, runId, state.campaignStorageKey);
        const stageById = new Map(sorted.map((stage) => [stage.id, stage]));
        for (const repair of sorted) {
          if (repair.is_gate || !repair.retry_to?.length) continue;
          const repairStatus = state.stages[repair.id];
          if (!repairStatus || !isPendingStageStatus(repairStatus.status)) continue;
          const relatedGates = repair.retry_to
            .map((gateId) => stageById.get(gateId))
            .filter((gate): gate is StageConfig => gate?.is_gate === true);
          const allRelatedGatesPassed = relatedGates.length === repair.retry_to.length
            && relatedGates.every((gate) => (
              state.stages[gate.id]?.status === STAGE_STATUS.COMPLETE
              && readGateVerdict(projectDir, gate.id, runId, terminalContract)?.pass === true
            ));
          if (!allRelatedGatesPassed) continue;
          const skipped = { ...repairStatus, status: STAGE_STATUS.SKIPPED };
          state.stages[repair.id] = skipped;
          writeStageStatus(projectDir, runId, repair.id, skipped);
        }
        writeRunState(projectDir, runId, state);
        writeCampaignEntry(projectDir, state);
        recordRunEvent(projectDir, runId, {
          type: 'run_completed',
          runId,
          timestamp: state.completedAt,
          iteration,
          detail: state.status,
        });
        log.info({ runId, iteration }, 'All gates passed, run complete');
        await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
        return state;
      }
    }

    // If no dispatched stages, check if all base stages passed
    if (iterationDispatchedIds.length === 0 && !anyFailed(state) && allDone(state)) {
      if (state.status === RUN_STATUS.FAILED) {
        writeCampaignEntry(projectDir, state);
        return state;
      }
      // Terminal-authority invariant (P1.3): research/loop runs never complete by default — only
      // the policy ships/ceilings. Keep re-planning until budget, then ceiling.
      if (state.research) {
        if (iteration < maxIterations) {
          log.info({ runId, iteration }, 'Research run: no terminal from policy yet — continuing (policy is sole terminal authority)');
          continue;
        }
        return await finishResearchCeiling(
          state,
          iteration,
          'research ceiling: iteration budget exhausted without a policy ship/ceiling (insufficient measured rounds)',
          { stages: sorted, injectedDispatchStages, planStageRetries },
        );
      }
      // Terminal-state already handled by the top + eager gates (see above).
      const unresolvedStageIds = guardPlainCompletionWithStageObligations(
        state,
        projectDir,
        runId,
        iteration,
        'base_all_done',
      );
      if (unresolvedStageIds.length > 0) {
        if (iteration < maxIterations) {
          log.info({ runId, iteration, unresolvedStageIds }, 'Base stages passed, but required stages remain unresolved — re-planning');
          continue;
        }
      } else {
        const terminalConclusion = await concludeDeclaredTerminalAtQuiescence(
          state,
          sorted,
          { projectDir, runId, runDirPath, iteration, adapter },
          'base_all_done',
        );
        if (terminalConclusion) return terminalConclusion;
        state.status = RUN_STATUS.COMPLETE;
        state.completedAt = new Date().toISOString();
        const realityGate = await enforceRealityGateBeforeTerminal(projectDir, runId, state, state.status);
        if (!realityGate.allowed) return realityGate.state;
        writeRunState(projectDir, runId, state);
        writeCampaignEntry(projectDir, state);
        recordRunEvent(projectDir, runId, {
          type: 'run_completed',
          runId,
          timestamp: state.completedAt,
          iteration,
          detail: state.status,
        });
        await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
        return state;
      }
    }

    // Non-gate stage failure: if a stage failed and there are no gates to retry through,
    // fail immediately instead of silently re-planning
    const hasGates = sorted.some(s => s.is_gate);
    if (anyFailed(state) && !hasGates) {
      const failedStageIds = Object.entries(state.stages)
        .filter(([, s]) => s.status === STAGE_STATUS.FAILED)
        .map(([id]) => id);
      const details = failedStageIds.map(id => {
        const s = state.stages[id];
        return s?.error ? `${id} (${s.error})` : id;
      }).join(', ');
      state.status = RUN_STATUS.FAILED;
      state.failureReason = `Stage(s) failed: ${details}`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      recordRunEvent(projectDir, runId, {
        type: 'run_completed',
        runId,
        timestamp: state.completedAt,
        iteration,
        detail: state.status,
      });
      log.info({ runId, iteration, failedStageIds }, 'Stage failed with no gates — run failed');
      return state;
    }

    // Preserve a stable rejected verdict even when there is no repair stage or
    // the bounded repair loop is exhausted. Earlier retry-entry reads can be
    // transient while verdict/metric files are settling, so only the rejection
    // that survives the whole iteration earns a durable archive here.
    if (iterationDispatchedIds.length > 0) {
      const stableGateFacts = collectGateRuntimeFacts(sorted, state, projectDir, runId);
      archiveRejectedGateRuntimeFacts(
        runDirPath,
        gateArchiveCoordinate(iteration, innerRetriesUsed + 1),
        stableGateFacts,
      );
      for (const evaluation of stableGateFacts.evaluations) {
        if (evaluation.effectiveVerdict?.pass !== false) continue;
        observeStableBlockage({
          runDirPath,
          kind: 'gate_rejection',
          stageId: evaluation.id,
          detail: evaluation.effectiveVerdict.reason ?? 'gate rejected without a reason',
          evidenceDigest: createHash('sha256')
            .update(JSON.stringify(evaluation.effectiveVerdict), 'utf8')
            .digest('hex'),
          repairDigest: (() => {
            if (innerRetriesUsed < 1) return undefined;
            const path = join(
              canonicalGateRoundArtifactDir(
                runDirPath,
                gateArchiveCoordinate(iteration, innerRetriesUsed),
              ),
              'repair_diff.json',
            );
            try {
              const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
              return createHash('sha256')
                .update(JSON.stringify(parsed.files ?? []), 'utf8')
                .digest('hex');
            } catch { return undefined; }
          })(),
          threshold: state.campaignTriggers?.repeatedFailureAfter,
        });
      }
      const repeatedGate = concludeRepeatedBlockage(
        state,
        { projectDir, runId, runDirPath, iteration },
      );
      if (repeatedGate) {
        await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
        return repeatedGate;
      }
    }

    // Max iterations reached
    if (iteration === maxIterations) {
      // GAP-1 belt-and-suspenders: NEVER clobber an already-terminal status. An
      // eager reality_gate_failed / ceiling / ship set earlier in this iteration
      // (e.g. via tryAdvanceResearch or the reject-rework loop) is the truthful
      // verdict the outer loop must see — overwriting it to 'incomplete' here
      // would manufacture a false outcome.
      if (isTerminalStatus(state.status) || isPausedRunStatus(state.status)) return state;
      const terminalConclusion = await concludeDeclaredTerminalAtQuiescence(
        state,
        sorted,
        { projectDir, runId, runDirPath, iteration, adapter },
        'max_iterations',
      );
      if (terminalConclusion) return terminalConclusion;
      // A+(c): budget/iteration exhausted mid-search WITHOUT a clean exhaustive
      // ceiling is `incomplete` — distinct from `failed` (crash) and `ceiling_hit`
      // (honest negative). The search simply ran out of attempts.
      const activeDispatchedStages = Array.isArray(state.dispatchedStages)
        ? state.dispatchedStages as StageConfig[]
        : [];
      const unresolvedStageIds = reconcileUnresolvedStageObligations(
        state,
        activeDispatchedStages,
        state.currentIteration ?? iteration,
        runDirPath,
      ).stageIds;
      state.status = 'incomplete';
      state.failureReason = unresolvedStageIds.length > 0
        ? `Max iterations reached (${maxIterations}) with unresolved required stage obligation(s): ${unresolvedStageIds.join(', ')}. A replacement plan cannot satisfy declared work by omission.`
        : `Max iterations reached (${maxIterations}). Gates did not pass after ${maxIterations} attempt(s) — search budget exhausted mid-progress (incomplete, not a crash).`;
      state.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, state);
      writeCampaignEntry(projectDir, state);
      recordRunEvent(projectDir, runId, {
        type: 'run_completed',
        runId,
        timestamp: state.completedAt,
        iteration,
        detail: state.status,
      });
      log.info({ runId, iteration }, 'Max iterations reached, run incomplete (budget exhausted mid-search)');
      return state;
    }

    // Clear dispatch.yaml and verdict.json for re-plan
    const dispatchPath = join(runDirPath, 'dispatch.yaml');
    if (existsSync(dispatchPath)) {
      unlinkSync(dispatchPath);
    }
    const verdictPath = join(runDirPath, 'verdict.json');
    if (existsSync(verdictPath)) {
      unlinkSync(verdictPath);
    }

    log.info({ runId, iteration: iteration + 1 }, 'Re-planning...');
  }

  // Should not reach here, but safety net
  const finalState = readRunState(projectDir, runId);
  // GAP-1 belt-and-suspenders: if the loop already reached a terminal status,
  // do NOT overwrite it with the safety-net 'failed' — return the truthful state.
  if (isTerminalStatus(finalState.status)) return finalState;
  finalState.status = 'failed';
  finalState.failureReason = 'Workflow ended unexpectedly.';
  finalState.completedAt = new Date().toISOString();
  writeRunState(projectDir, runId, finalState);
  writeCampaignEntry(projectDir, finalState);
  recordRunEvent(projectDir, runId, {
    type: 'run_completed',
    runId,
    timestamp: finalState.completedAt,
    iteration: finalState.currentIteration,
    detail: finalState.status,
  });
  return finalState;
  } finally {
    if (supervisor) {
      try { supervisor.stop(); } catch (err) { log.warn({ err }, 'Supervisor stop failed'); }
    }
    removeSchedulerPidIfOwned(schedulerPidPath);
    if (launchIntentOwned) {
      releaseLaunchIntent(projectDir, runId);
      invalidateRunLockCache();
    }
  }
}

interface ScopeBatchContext {
  snapshot: RepairRoundSnapshot;
  declaredScopes: Map<string, string[] | null>;
  attempts: Map<string, {
    effectiveScope: string[];
    decisionPaths: Set<string>;
    mismatchPaths: Set<string>;
  }>;
}

function createScopeBatchContext(
  projectDir: string,
  stages: StageConfig[],
  snapshot?: RepairRoundSnapshot,
): ScopeBatchContext {
  const resolvedSnapshot = snapshot ?? captureRepairRoundSnapshot(projectDir, stages);
  const declaredScopes = new Map<string, string[] | null>();
  for (const stage of stages) {
    const declared = resolvedSnapshot.declaredScopes[stage.id] ?? stage.scope ?? null;
    const copy = declared === null ? null : [...declared];
    declaredScopes.set(stage.id, copy);
  }
  return {
    snapshot: resolvedSnapshot,
    declaredScopes,
    attempts: new Map(),
  };
}

function scopeAttemptKey(stageId: string, attemptIndex: number): string {
  return `${stageId}\u0000${attemptIndex}`;
}

function getScopeAttemptContext(
  context: ScopeBatchContext,
  stageId: string,
  attemptIndex: number,
): { effectiveScope: string[]; decisionPaths: Set<string>; mismatchPaths: Set<string> } {
  const key = scopeAttemptKey(stageId, attemptIndex);
  const existing = context.attempts.get(key);
  if (existing) return existing;
  const declared = context.declaredScopes.get(stageId) ?? null;
  const created = {
    // Missing scope is a closed capability, never an implicit allow-all.
    effectiveScope: declared === null ? [] : [...declared],
    decisionPaths: new Set<string>(),
    mismatchPaths: new Set<string>(),
  };
  context.attempts.set(key, created);
  return created;
}

function addScopeArtifactPath(collection: Set<string>, path: string, runDirPath: string): void {
  collection.add(path.startsWith(runDirPath) ? path.slice(runDirPath.length + 1).replace(/\\/g, '/') : path);
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
      if (!input.activeStageIds.has(stage.id)) continue;
      const stagePath = join(runDirPath, 'stages', stage.id);
      const attemptIndex = currentStageAttemptIndex(input.projectDir, input.runId, stage.id);
      const request = readScopeRevisionRequest(stagePath, input.runId);
      if (!request) continue;
      const key = negotiationRequestDigest(request);
      if (attemptIndex === undefined) continue;
      if (request.attemptIndex !== attemptIndex) {
        // A request slot is transport, not authority. Leaving attempt N's body
        // in place must never replay N's accepted decision into attempt N+1.
        processed.add(key);
        log.warn({ stage: stage.id, requestAttempt: request.attemptIndex, currentAttempt: attemptIndex }, 'Ignoring stale scope revision request from another attempt');
        continue;
      }
      if (processed.has(key)) continue;
      const attemptContext = getScopeAttemptContext(input.context, stage.id, attemptIndex);
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
      }
      log.info(
        { stage: stage.id, requestId: request.requestId, accepted: publication.decision.accepted, reason: publication.decision.rejectionReason },
        'Scope revision decided',
      );
    }
  };

  while (!input.isComplete()) {
    inspect();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  inspect();
}

function scopeContainsPath(scope: string[], rawPath: string): boolean {
  const normalized = normalizedProjectPath(rawPath);
  if (!normalized) return false;
  return scope.some((entry) => scopeMatchesProjectPath(parseDeclaredScope(entry), normalized));
}

interface ScopeWriteEnforcement {
  rawWrites: string[];
  appliedWrites: string[];
  rolledBackWrites: string[];
  rollbackFailures: string[];
  durableWrites: string[];
}

function canonicalProjectWriteUnion(...collections: string[][]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const collection of collections) {
    for (const rawPath of collection) {
      const path = normalizedProjectPath(rawPath) ?? rawPath.trim().replace(/\\/g, '/');
      if (!path || seen.has(path)) continue;
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}

function peerScopeContainsPath(
  context: ScopeBatchContext,
  currentStageId: string,
  rawPath: string,
): boolean {
  for (const [stageId, declaredScope] of context.declaredScopes) {
    if (stageId === currentStageId) continue;
    if (scopeContainsPath(declaredScope ?? [], rawPath)) return true;
    const attemptPrefix = `${stageId}\u0000`;
    for (const [key, attempt] of context.attempts) {
      if (key.startsWith(attemptPrefix) && scopeContainsPath(attempt.effectiveScope, rawPath)) return true;
    }
  }
  return false;
}

/**
 * `effectiveScope: null` means the stage declared no scope AND never negotiated, so
 * there is no policy to enforce. Auditing those writes is right; restoring their
 * preimage is not — see the three-state note at the call site.
 */
function enforceStageScopeWrites(input: {
  projectDir: string;
  snapshot: RepairRoundSnapshot;
  effectiveScope: string[] | null;
  rawWrites: string[];
  definiteWrites: ReadonlySet<string>;
  preserveUnverifiedPath: (path: string) => boolean;
}): ScopeWriteEnforcement {
  const ungoverned = input.effectiveScope === null;
  const rawWrites = [...new Set(input.rawWrites)];
  const appliedWrites: string[] = [];
  const rolledBackWrites: string[] = [];
  const rollbackFailures: string[] = [];
  const durableWrites: string[] = [];
  for (const rawPath of rawWrites) {
    const normalized = normalizedProjectPath(rawPath);
    const definitelyAttributed = input.definiteWrites.has(normalized ?? rawPath);
    if (!normalized) {
      if (definitelyAttributed) rollbackFailures.push(rawPath);
      continue;
    }
    const beforeFingerprint = input.snapshot.allFileFingerprints.get(normalized);
    const currentFingerprint = repairFileFingerprint(readRepairFileImage(input.projectDir, normalized));
    const changed = !repairFileFingerprintsEqual(beforeFingerprint, currentFingerprint);
    if (ungoverned) {
      if (changed) durableWrites.push(normalized);
      continue;
    }
    if (scopeContainsPath(input.effectiveScope ?? [], normalized)) {
      if (changed) {
        appliedWrites.push(normalized);
        durableWrites.push(normalized);
      }
      continue;
    }
    if (!changed) continue;
    // Snapshot-only attribution can include another concurrently running stage.
    // Preserve only paths covered by a peer's capability; every path outside
    // the complete batch capability is safe to restore even when ownership is unknown.
    if (!definitelyAttributed && input.preserveUnverifiedPath(normalized)) continue;
    const before = input.snapshot.allFileImages.get(normalized) ?? { exists: false };
    if (restoreProjectPath(input.projectDir, normalized, before)) {
      rolledBackWrites.push(normalized);
    } else {
      rollbackFailures.push(normalized);
      durableWrites.push(normalized);
    }
  }
  return { rawWrites, appliedWrites, rolledBackWrites, rollbackFailures, durableWrites };
}

const SCOPE_PLANNING_INPUT_PREFIX = 'scope_negotiation_input_';
const SCOPE_PLANNING_DISPOSITION_PREFIX = 'scope_negotiation_disposition_';

interface ScopePlanningInputV1 {
  version: 1;
  kind: 'scope_negotiation_planning_input';
  digest: string;
  runId: string;
  sourceIteration: number;
  stageId: string;
  stageKind: ScopeStageKind;
  requestedPaths: string[];
  pathDigest: string;
  rejectionReason: string;
  auditPath: string;
}

interface ScopePlanningDispositionV1 {
  version: 1;
  kind: 'scope_negotiation_disposition';
  digest: string;
  iteration: number;
  disposition: 'resolve' | 'defer';
  basis: string;
  stageId?: string;
  recordedAt: string;
}

function readJsonArtifacts<T>(runDirPath: string, prefix: string): T[] {
  let files: string[];
  try { files = readdirSync(runDirPath); } catch { return []; }
  return files.filter((file) => file.startsWith(prefix) && file.endsWith('.json')).sort().flatMap((file) => {
    try { return [JSON.parse(readFileSync(join(runDirPath, file), 'utf-8')) as T]; } catch { return []; }
  });
}

function pendingScopePlanningInputs(runDirPath: string): ScopePlanningInputV1[] {
  const inputs = readJsonArtifacts<ScopePlanningInputV1>(runDirPath, SCOPE_PLANNING_INPUT_PREFIX);
  const disposed = new Set(
    readJsonArtifacts<ScopePlanningDispositionV1>(runDirPath, SCOPE_PLANNING_DISPOSITION_PREFIX)
      .map((entry) => entry.digest),
  );
  return inputs.filter((entry) => !disposed.has(entry.digest));
}

function scopePlanningDispositionDigests(runDirPath: string): Set<string> {
  return new Set(
    readJsonArtifacts<ScopePlanningDispositionV1>(runDirPath, SCOPE_PLANNING_DISPOSITION_PREFIX)
      .filter((entry) => entry.disposition === 'resolve' || entry.disposition === 'defer')
      .map((entry) => entry.digest),
  );
}

function scopePlanningDigestsBlockingStage(
  runDirPath: string,
  stageId: string,
  dispatchedStages: readonly StageConfig[],
): string[] {
  const inputs = pendingScopePlanningInputs(runDirPath);
  if (inputs.length === 0) return [];
  const digestsByStage = new Map<string, string[]>();
  for (const input of inputs) {
    const current = digestsByStage.get(input.stageId) ?? [];
    if (!current.includes(input.digest)) current.push(input.digest);
    digestsByStage.set(input.stageId, current);
  }
  const stageById = new Map(dispatchedStages.map((stage) => [stage.id, stage]));
  const visited = new Set<string>();
  const digests = new Set<string>();
  const queue = [stageId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const digest of digestsByStage.get(current) ?? []) digests.add(digest);
    for (const dependency of stageById.get(current)?.depends_on ?? []) queue.push(dependency);
  }
  return [...digests].sort();
}

function appendScopePlanningInput(prompt: string, runDirPath: string): string {
  const pending = pendingScopePlanningInputs(runDirPath);
  if (pending.length === 0) return prompt;
  const rows = pending.map((entry) => ({
    digest: entry.digest,
    stageKind: entry.stageKind,
    requestedPaths: entry.requestedPaths,
    rejectionReason: entry.rejectionReason,
    auditPath: entry.auditPath,
  }));
  return `${prompt}\n\n# Pending scope-negotiation planning input\n${JSON.stringify(rows, null, 2)}\n`
    + `For every digest, either resolve it by predeclaring all requested paths in one dispatched stage's scope, `
    + `or defer it explicitly in dispatch.yaml as scope_negotiation: { defer: ["<digest>"] }. `
    + `The scheduler records one immutable resolve/defer disposition and will not duplicate the same unresolved digest.`;
}

function applyScopePlanningDispositions(
  runDirPath: string,
  iteration: number,
  rawDispatch: unknown,
  dispatched: StageConfig[],
): void {
  const pending = pendingScopePlanningInputs(runDirPath);
  if (pending.length === 0) return;
  const wrapper = rawDispatch && typeof rawDispatch === 'object' && !Array.isArray(rawDispatch)
    ? rawDispatch as Record<string, unknown>
    : {};
  const negotiation = wrapper.scope_negotiation && typeof wrapper.scope_negotiation === 'object'
    ? wrapper.scope_negotiation as Record<string, unknown>
    : {};
  const deferred = new Set(
    Array.isArray(negotiation.defer)
      ? negotiation.defer.filter((value): value is string => typeof value === 'string')
      : [],
  );
  for (const entry of pending) {
    const resolvingStage = dispatched.find((stage) => (
      stage.scope !== undefined
      && entry.requestedPaths.every((path) => scopeContainsPath(stage.scope ?? [], path))
    ));
    const disposition: ScopePlanningDispositionV1 | undefined = resolvingStage
      ? {
          version: 1, kind: 'scope_negotiation_disposition', digest: entry.digest, iteration,
          disposition: 'resolve', basis: `planner predeclared every requested path in ${resolvingStage.id}`,
          stageId: resolvingStage.id, recordedAt: new Date().toISOString(),
        }
      : deferred.has(entry.digest)
        ? {
            version: 1, kind: 'scope_negotiation_disposition', digest: entry.digest, iteration,
            disposition: 'defer', basis: 'planner explicitly deferred the digest in dispatch.yaml',
            recordedAt: new Date().toISOString(),
          }
        : undefined;
    if (!disposition) continue;
    publishJsonCreateOnly(
      join(runDirPath, `${SCOPE_PLANNING_DISPOSITION_PREFIX}${entry.digest}_iteration_${iteration}.json`),
      disposition,
    );
  }
}

function reconcileStageScope(input: {
  stage: StageConfig;
  projectDir: string;
  runId: string;
  context: ScopeBatchContext;
  attemptIndex: number;
}): { status: StageStatus; violation: boolean } {
  const status = readStageStatus(input.projectDir, input.runId, input.stage.id);
  const attempt = status.attempts?.find((candidate) => candidate.index === input.attemptIndex);
  if (!attempt) return { status, violation: false };
  const declaredScope = input.context.declaredScopes.get(input.stage.id) ?? null;
  const attemptContext = getScopeAttemptContext(input.context, input.stage.id, attempt.index);
  const effectiveScope = attemptContext.effectiveScope;
  const decisions = [...attemptContext.decisionPaths];
  const mismatches = [...attemptContext.mismatchPaths];
  const attributedWrites = attempt.writes ?? [];
  const schedulerObservedWrites = changedProjectPathsSinceSnapshot(input.context.snapshot, input.projectDir);
  const rawWrites = canonicalProjectWriteUnion(attributedWrites, schedulerObservedWrites);
  const definiteWrites = new Set(
    attempt.writeAttribution === 'structured'
      ? canonicalProjectWriteUnion(attributedWrites)
      : [],
  );
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
  const governedScope: string[] | null = declaredScope === null && !negotiated ? null : effectiveScope;
  const enforcement = enforceStageScopeWrites({
    projectDir: input.projectDir,
    snapshot: input.context.snapshot,
    effectiveScope: governedScope,
    rawWrites,
    definiteWrites,
    preserveUnverifiedPath: (path) => peerScopeContainsPath(input.context, input.stage.id, path),
  });
  const violations: Array<{ path: string; certainty: 'definite' | 'unverified'; reason: string }> = [];
  for (const rawPath of enforcement.rawWrites) {
    const normalized = normalizedProjectPath(rawPath);
    const definitelyAttributed = definiteWrites.has(normalized ?? rawPath);
    if (!definitelyAttributed && !normalized) continue;
    if (governedScope === null || scopeContainsPath(governedScope, rawPath)) continue;
    violations.push({
      path: rawPath,
      certainty: definitelyAttributed ? 'definite' : 'unverified',
      reason: definitelyAttributed
        ? enforcement.rolledBackWrites.includes(normalizedProjectPath(rawPath) ?? rawPath)
          ? 'adapter attributed an unauthorized project write; enforcement restored its preimage before durable apply'
          : 'adapter attributed a project write outside the accepted effective scope'
        : enforcement.rolledBackWrites.includes(normalizedProjectPath(rawPath) ?? rawPath)
          ? 'snapshot observed a change outside the complete batch capability; enforcement restored its preimage while ownership remains unverified'
          : 'snapshot observed a change outside effective scope but cannot prove ownership',
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
  const unverified = violations.filter((violation) => violation.certainty === 'unverified');
  const auditPath = join(stagePath, `constraint_audit_attempt_${attempt.index}.json`);
  const runDirPath = runDir(input.projectDir, input.runId);
  const auditRelativePath = auditPath.slice(runDirPath.length + 1).replace(/\\/g, '/');
  const stageKind: ScopeStageKind = input.stage.is_gate ? 'gate' : 'ordinary';
  const iteration = readRunState(input.projectDir, input.runId).currentIteration ?? 1;
  const rejectedDecisions = decisionRecords.filter((decision) => decision.accepted === false);
  const planningDigests = rejectedDecisions.flatMap((decision) => {
    const requestedPaths = Array.isArray(decision.requestedPaths)
      ? decision.requestedPaths.filter((value): value is string => typeof value === 'string')
      : [];
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
      pathDigest: typeof decision.pathDigest === 'string' ? decision.pathDigest : scopePathDigest(requestedPaths),
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
      decision: decision.accepted === true ? 'accepted' : 'rejected',
      effectiveScope: Array.isArray(decision.effectiveScope)
        ? decision.effectiveScope.filter((value): value is string => typeof value === 'string')
        : effectiveScope,
      durableWrites: enforcement.durableWrites,
    })];
  });
  const audit = {
    version: 1,
    stageId: input.stage.id,
    attemptIndex: attempt.index,
    requester: 'stage',
    scopeApprover: 'scheduler-policy',
    declaredScope,
    effectiveScope,
    decisionPaths: decisions,
    mismatchPaths: mismatches,
    decisions: decisionRecords,
    rawWrites: enforcement.rawWrites,
    appliedWrites: enforcement.appliedWrites,
    rolledBackWrites: enforcement.rolledBackWrites,
    rollbackFailures: enforcement.rollbackFailures,
    durableWrites: enforcement.durableWrites,
    planningDigests,
    stateTransitions,
    writes: attempt.writes ?? [],
    writeAttribution: attempt.writeAttribution ?? 'unknown',
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
    unverifiedCount: unverified.length,
    rawWriteCount: enforcement.rawWrites.length,
    appliedWriteCount: enforcement.appliedWrites.length,
    rolledBackWriteCount: enforcement.rolledBackWrites.length,
    rejectedDigestCount: planningDigests.length,
  };
  const error = definite.length > 0
    ? `scope_violation: ${definite.map((violation) => violation.path).join(', ')} attempted outside accepted effective scope`
    : undefined;
  return {
    status: attachStageConstraintAudit(input.projectDir, input.runId, input.stage.id, attempt.index, summary, error),
    violation: definite.length > 0,
  };
}

function reconcileCompletedStageAttempts(input: {
  stage: StageConfig;
  projectDir: string;
  runId: string;
  context: ScopeBatchContext;
}): { status: StageStatus; violation: boolean } {
  let status = readStageStatus(input.projectDir, input.runId, input.stage.id);
  let violation = false;
  for (const attempt of status.attempts ?? []) {
    if (isRunningStageStatus(attempt.status) || attempt.constraintAudit) continue;
    const reconciled = reconcileStageScope({ ...input, attemptIndex: attempt.index });
    status = reconciled.status;
    violation ||= reconciled.violation;
  }
  return { status, violation };
}

async function runScopeSafeStageGroup(
  stages: StageConfig[],
  projectDir: string,
  runId: string,
  iteration: number,
  execute: (stage: StageConfig) => Promise<void>,
  snapshot?: RepairRoundSnapshot,
): Promise<void> {
  let pending = [...stages];
  while (pending.length > 0) {
    const { selected, deferred } = selectRunnableBatch(pending);
    for (const { stage, conflict } of deferred) {
      const detail = `${stage.id} deferred behind ${conflict.leftStageId}: ${conflict.reason}`;
      log.info({ stage: stage.id, conflict }, 'Serializing retry/gate stage because declared scopes are not provably disjoint');
      recordRunEvent(projectDir, runId, {
        type: 'parallel_scope_serialized', runId, timestamp: new Date().toISOString(),
        iteration, stageId: stage.id, stageIds: [conflict.leftStageId, conflict.rightStageId],
        level: 'info', detail,
      });
    }
    const activeStageIds = new Set(selected.map((stage) => stage.id));
    const context = createScopeBatchContext(projectDir, selected, snapshot);
    let complete = false;
    const executions = Promise.all(selected.map(async (stage) => {
      try { await execute(stage); }
      finally { activeStageIds.delete(stage.id); }
    }));
    const monitor = monitorScopeRevisionRequests({
      selected,
      activeStageIds,
      projectDir,
      runId,
      context,
      isComplete: () => complete,
    });
    let executionError: unknown;
    try {
      await executions;
    } catch (error) {
      executionError = error;
    } finally {
      complete = true;
      await monitor;
    }
    if (executionError) throw executionError;
    for (const stage of selected) reconcileCompletedStageAttempts({ stage, projectDir, runId, context });
    const statuses: Record<string, StageStatus> = {};
    for (const stage of selected) {
      try { statuses[stage.id] = readStageStatus(projectDir, runId, stage.id); } catch { /* missing status */ }
    }
    for (const conflict of detectParallelWriteConflicts(selected.map((stage) => stage.id), statuses)) {
      const detail = `${conflict.stageIds[0]} and ${conflict.stageIds[1]} both wrote ${conflict.files.join(', ')} (attribution: ${conflict.attribution.join(' / ')})`;
      log.warn({ conflict }, 'Parallel retry/gate stages wrote the same file');
      recordRunEvent(projectDir, runId, {
        type: 'parallel_write_conflict', runId, timestamp: new Date().toISOString(), iteration,
        stageIds: conflict.stageIds, files: conflict.files, level: 'warning', detail,
      });
    }
    pending = deferred.map(({ stage }) => stage);
  }
}

/** Re-sync run.json stage entries from individual status.json files after parallel execution. */
function syncStageStatuses(projectDir: string, runId: string, stageIds: string[]): void {
  const state = readRunState(projectDir, runId);
  for (const sid of stageIds) {
    try { state.stages[sid] = readStageStatus(projectDir, runId, sid); } catch { /* keep existing */ }
  }
  writeRunState(projectDir, runId, state);
}

interface GateArchiveCoordinate {
  iteration: number;
  round: number;
}

function gateArchiveCoordinate(iteration: number, round: number): GateArchiveCoordinate {
  if (!Number.isSafeInteger(iteration) || iteration < 1) {
    throw new Error(`Gate archive iteration must be a positive integer, got ${iteration}`);
  }
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new Error(`Gate archive round must be a positive integer, got ${round}`);
  }
  return { iteration, round };
}

function gateReevaluationArchiveRoot(runDirPath: string): string {
  return join(runDirPath, 'gate_reevaluation');
}

function canonicalGateRoundArtifactDir(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
): string {
  return join(
    gateReevaluationArchiveRoot(runDirPath),
    `iteration_${coordinate.iteration}`,
    `round_${coordinate.round}`,
  );
}

function legacyGateRoundArtifactDir(runDirPath: string, round: number): string {
  return join(gateReevaluationArchiveRoot(runDirPath), `round_${round}`);
}

function hasIterationGateArchiveNamespace(runDirPath: string): boolean {
  const archiveRoot = gateReevaluationArchiveRoot(runDirPath);
  try {
    return readdirSync(archiveRoot, { withFileTypes: true })
      .some((entry) => /^iteration_\d+$/.test(entry.name));
  } catch {
    // Compatibility is allowed only when absence of an iteration namespace is
    // observable. An unreadable/non-directory archive root therefore fails closed.
    return existsSync(archiveRoot);
  }
}

function canonicalGateArchiveArtifactPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  artifactName: string,
): string {
  return join(canonicalGateRoundArtifactDir(runDirPath, coordinate), artifactName);
}

function compatibleGateArchiveArtifactReadPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  artifactName: string,
): string {
  const canonicalPath = canonicalGateArchiveArtifactPath(runDirPath, coordinate, artifactName);
  if (existsSync(canonicalPath) || hasIterationGateArchiveNamespace(runDirPath)) {
    return canonicalPath;
  }
  const legacyPath = join(legacyGateRoundArtifactDir(runDirPath, coordinate.round), artifactName);
  return existsSync(legacyPath) ? legacyPath : canonicalPath;
}

function archivedGateVerdictWritePath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return canonicalGateArchiveArtifactPath(runDirPath, coordinate, `rejected_verdict_${gateId}.json`);
}

function archivedGateVerdictReadPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return compatibleGateArchiveArtifactReadPath(runDirPath, coordinate, `rejected_verdict_${gateId}.json`);
}

function archivedGateEffectiveVerdictWritePath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return canonicalGateArchiveArtifactPath(runDirPath, coordinate, `engine_verdict_${gateId}.json`);
}

function archivedGateEffectiveVerdictReadPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return compatibleGateArchiveArtifactReadPath(runDirPath, coordinate, `engine_verdict_${gateId}.json`);
}

function archivedGateMetricWritePath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return canonicalGateArchiveArtifactPath(runDirPath, coordinate, `metric_${gateId}.json`);
}

function archivedGateMetricReadPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return compatibleGateArchiveArtifactReadPath(runDirPath, coordinate, `metric_${gateId}.json`);
}

function archivedGateOutputWritePath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return canonicalGateArchiveArtifactPath(runDirPath, coordinate, `previous_output_${gateId}.md`);
}

function archivedGateOutputReadPath(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateId: string,
): string {
  return compatibleGateArchiveArtifactReadPath(runDirPath, coordinate, `previous_output_${gateId}.md`);
}

function archiveGateRoundEvidence(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  gateIds: string[],
  effectiveVerdicts?: Map<string, { pass: boolean; reason?: string }>,
): void {
  const artifactDir = canonicalGateRoundArtifactDir(runDirPath, coordinate);
  mkdirSync(artifactDir, { recursive: true });
  for (const gateId of gateIds) {
    const perGateVerdict = join(runDirPath, `verdict_${gateId}.json`);
    const verdict = existsSync(perGateVerdict) ? perGateVerdict : join(runDirPath, 'verdict.json');
    const output = join(runDirPath, 'stages', gateId, 'output.md');
    const metric = join(runDirPath, 'stages', gateId, 'metric.json');
    try { if (existsSync(verdict)) copyFileSync(verdict, archivedGateVerdictWritePath(runDirPath, coordinate, gateId)); } catch { /* best effort */ }
    try { if (existsSync(output)) copyFileSync(output, archivedGateOutputWritePath(runDirPath, coordinate, gateId)); } catch { /* best effort */ }
    try { if (existsSync(metric)) copyFileSync(metric, archivedGateMetricWritePath(runDirPath, coordinate, gateId)); } catch { /* best effort */ }
    // The archived verdict is the file the gate WROTE. The engine can reject it
    // for reasons the file cannot show — a metric.json inconsistency, a contract
    // violation — and a repair handed only the written file then sees `pass:
    // true` with nothing to fix, and burns the retry budget. Archive what the
    // engine concluded, and why, beside it.
    const effective = effectiveVerdicts?.get(gateId);
    if (effective) {
      try {
        writeFileSync(
          archivedGateEffectiveVerdictWritePath(runDirPath, coordinate, gateId),
          JSON.stringify({
            gateId,
            written_verdict_pass: readWrittenVerdictPass(verdict),
            engine_effective_pass: effective.pass,
            engine_rejection_reason: effective.reason ?? null,
            note: 'The engine\'s conclusion. If engine_effective_pass is false while '
              + 'written_verdict_pass is true, the gate file is not the thing to fix — '
              + 'engine_rejection_reason is.',
          }, null, 2) + '\n',
          'utf-8',
        );
      } catch { /* best effort */ }
    }
  }
}

function archiveRejectedGateRuntimeFacts(
  runDirPath: string,
  coordinate: GateArchiveCoordinate,
  facts: GateRuntimeFacts,
): void {
  if (facts.rejectedGateIds.length === 0) return;
  const rejected = new Set(facts.rejectedGateIds);
  archiveGateRoundEvidence(
    runDirPath,
    coordinate,
    facts.rejectedGateIds,
    new Map(
      facts.evaluations
        .filter((evaluation) => rejected.has(evaluation.id) && evaluation.effectiveVerdict)
        .map((evaluation) => [evaluation.id, evaluation.effectiveVerdict!] as const),
    ),
  );
}

function readWrittenVerdictPass(verdictPath: string): boolean | null {
  try {
    const parsed = JSON.parse(readFileSync(verdictPath, 'utf-8')) as Record<string, unknown>;
    return typeof parsed.pass === 'boolean' ? parsed.pass : null;
  } catch {
    return null;
  }
}

export function buildGateReevaluationPreamble(input: {
  evaluationRound: number;
  iteration: number;
  repairRound: number;
  runDirPath: string;
  gateId: string;
  fixStageIds: string[];
  roundDiffPath: string;
}): string {
  const fixOutputs = input.fixStageIds.map((id) => `- ${join(input.runDirPath, 'stages', id, 'output.md')}`).join('\n');
  const coordinate = gateArchiveCoordinate(input.iteration, input.repairRound);
  const firstCoverageCoordinate = gateArchiveCoordinate(input.iteration, 1);
  const firstCoverageOutput = archivedGateOutputReadPath(input.runDirPath, firstCoverageCoordinate, input.gateId);
  const previousOutput = archivedGateOutputReadPath(input.runDirPath, coordinate, input.gateId);
  return [
    `RE-EVALUATION (round ${input.evaluationRound}): Continue the same gate's audit after a repair.`,
    '',
    'Evidence you must read:',
    `- Rejected verdict: ${archivedGateVerdictReadPath(input.runDirPath, coordinate, input.gateId)}`,
    `- The engine's own conclusion and rejection reason: ${archivedGateEffectiveVerdictReadPath(input.runDirPath, coordinate, input.gateId)}`,
    `- Metric artifact actually evaluated: ${archivedGateMetricReadPath(input.runDirPath, coordinate, input.gateId)}`,
    '  If that file shows engine_effective_pass=false while written_verdict_pass=true, the',
    '  verdict file is not the defect — engine_rejection_reason names what the engine',
    '  objected to, and that is what must change.',
    `- Original first-pass validator-owned Coverage Map: ${firstCoverageOutput}`,
    ...(input.repairRound > 1 ? [`- Immediately previous gate output: ${previousOutput}`] : []),
    `- Complete, untruncated repair-round diff: ${input.roundDiffPath}`,
    ...(fixOutputs ? ['- Fix stage output(s):', fixOutputs] : []),
    '',
    'This re-evaluation has exactly three responsibilities:',
    '1. Reproduce every rejected finding and verify it is actually fixed with reproducible evidence; a repair summary or claim that code changed is not proof.',
    '2. Run the full mechanical regression suites required by the task and project, not a targeted subset.',
    '3. Read the complete repair diff and re-run every check from the prior Coverage Map that any changed path or hunk touches. A prior passing conclusion may not substitute for re-execution.',
    '',
    'Do not expand into unrelated audit dimensions or invent unrelated probes during re-evaluation. The first evaluation owned exhaustive discovery; this round owns rejected-item proof, full regression, and diff-touched revalidation.',
  ].join('\n');
}

function buildGateFixCorrectionContract(
  runDirPath: string,
  gateIds: string[],
  coordinate: GateArchiveCoordinate,
): string {
  const entries = gateIds.map((gateId) => [
    `- Gate ${gateId}:`,
    `  - archived rejected verdict: ${archivedGateVerdictReadPath(runDirPath, coordinate, gateId)}`,
    `  - archived evaluated metric: ${archivedGateMetricReadPath(runDirPath, coordinate, gateId)}`,
    `  - archived QA output: ${archivedGateOutputReadPath(runDirPath, coordinate, gateId)}`,
    `  - optional correction marker: ${gateVerdictCorrectionPath(runDirPath, gateId)}`,
  ].join('\n')).join('\n');
  return [
    `Gate repair round ${coordinate.round}: read the archived rejection evidence before changing anything:`,
    entries,
    '',
    'Wrong-verdict cold-start contract: only if reproducible evidence proves the previous rejection itself was wrong (rather than an implementation defect being repaired), write that gate\'s optional correction marker with exactly this JSON shape:',
    `{"version":${GATE_VERDICT_CORRECTION_VERSION},"gateId":"<exact gate id>","previousVerdictWrong":true,"reason":"<why the prior reasoning was wrong>","evidence":"<reproducible command/probe and result>"}`,
    'Do not write a correction marker for an ordinary fix. The marker invalidates only the prior validator session; it never changes the gate verdict or acceptance criteria.',
  ].join('\n');
}

function stageInitialTimeout(projectDir: string): number {
  return loadDefaults(projectDir).timeout_ms;
}

function budgetAfterTimeouts(initialBudgetMs: number, timeoutCount: number): number {
  let budget = initialBudgetMs;
  for (let index = 0; index < timeoutCount; index++) budget = nextTechnicalRetryBudget(budget);
  return budget;
}

function createSchedulerTechnicalRetryState(
  initialBudgetMs: number,
  priorStatus?: StageStatus,
  recover = false,
): TechnicalRetryBudgetState {
  const retryRecovery = recover && (
    isPendingStageStatus(priorStatus?.status ?? '')
    || isRunningStageStatus(priorStatus?.status ?? '')
  );
  const retries = retryRecovery ? Math.max(0, priorStatus?.retries ?? 0) : 0;
  const priorTimeout = retries > 0 ? priorStatus?.attempts?.at(-1)?.timeout : undefined;
  const persistedBudget = priorTimeout?.budgetMs;
  const previousBudgetMs = Number.isSafeInteger(persistedBudget) && Number(persistedBudget) > 0
    ? Number(persistedBudget)
    : budgetAfterTimeouts(initialBudgetMs, Math.max(0, retries - 1));
  const priorTimedOut = retries > 0 && (
    priorTimeout?.terminationCause === 'attempt_timeout'
    || priorStatus?.error?.startsWith('timed out after') === true
  );
  return createTechnicalRetryBudgetState({
    initialBudgetMs,
    currentBudgetMs: retries > 0 ? previousBudgetMs : initialBudgetMs,
    previousEffectiveBudgetMs: retries > 0 ? previousBudgetMs : undefined,
    increaseAfterTimeout: priorTimedOut,
    attemptsStarted: retries,
  });
}

function prepareSchedulerTechnicalAttempt(chain: TechnicalRetryBudgetState): {
  budgetMs: number;
  retryContext?: { previousBudgetMs: number; nextBudgetMs: number };
} {
  const transition = transitionTechnicalRetryBudget(chain, { type: 'prepare_attempt' });
  if (transition.type !== 'attempt_prepared') throw new Error('technical retry state did not prepare an attempt');
  return { budgetMs: transition.budgetMs, retryContext: transition.retryContext };
}

export function recordSchedulerTechnicalAttemptResult(
  chain: TechnicalRetryBudgetState,
  result: Pick<RunResult, 'effectiveTimeoutMs' | 'timedOut' | 'timeoutTerminationCause'>,
  preparedBudgetMs: number,
): boolean {
  const effectiveBudgetMs = result.effectiveTimeoutMs ?? preparedBudgetMs;
  const retryableTimeout = result.timedOut === true
    && result.timeoutTerminationCause === 'attempt_timeout';
  transitionTechnicalRetryBudget(chain, retryableTimeout
    ? { type: 'attempt_timed_out', effectiveBudgetMs }
    : { type: 'attempt_finished', effectiveBudgetMs });
  return retryableTimeout;
}

async function executeSingleStage(
  stage: StageConfig,
  projectDir: string,
  runId: string,
  runDirPath: string,
  workflow: WorkflowConfig,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  resolvedAgentsDir: string,
  state: StoreState,
  allStages: StageConfig[],
  skills?: string,
  taskDescription?: string,
  innerRetry?: number,
  fixStageIds?: string[],
  roundDiffPath?: string,
  availableSkills?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
): Promise<void> {
  if (!agents.has(stage.role)) {
    const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
    if (!existsSync(agentPath)) throw new Error(`No agent config for role "${stage.role}"`);
    const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
    agents.set(stage.role, applyBasePrompt(parseAgent(raw, projectDir), loadBasePrompt(resolvedAgentsDir)));
  }
  const agent = agents.get(stage.role)!;
  const initialTimeout = stageInitialTimeout(projectDir);
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);
  const currentGateAttempt = stage.is_gate
    ? gateAttemptCoordinate(state.currentIteration ?? 1, innerRetry)
    : undefined;

  let resolvedPrompt = stage.prompt_template || '';
  if (!resolvedPrompt) resolvedPrompt = taskDescription ?? '';

  // Inject inner retry context so the agent knows this is a repeated attempt
  if (innerRetry !== undefined) {
    const archiveCoordinate = gateArchiveCoordinate(state.currentIteration ?? 1, innerRetry + 1);
    const activeRetryGateIds = (stage.retry_to ?? []).filter((gateId) =>
      existsSync(archivedGateOutputReadPath(runDirPath, archiveCoordinate, gateId)),
    );
    if (stage.is_gate) {
      if (!roundDiffPath) throw new Error(`Gate ${stage.id} re-evaluation is missing its complete repair diff`);
      resolvedPrompt = `${buildGateReevaluationPreamble({
        evaluationRound: innerRetry + 2,
        iteration: archiveCoordinate.iteration,
        repairRound: innerRetry + 1,
        runDirPath,
        gateId: stage.id,
        fixStageIds: fixStageIds ?? [],
        roundDiffPath,
      })}\n\n${resolvedPrompt}`;
    } else if (innerRetry > 0) {
      // Build references to the gate verdicts and outputs that triggered this retry
      const gateRefs = activeRetryGateIds.map(gid =>
        `- Verdict: ${archivedGateVerdictReadPath(runDirPath, archiveCoordinate, gid)}\n- QA output: ${archivedGateOutputReadPath(runDirPath, archiveCoordinate, gid)}`
      ).join('\n');
      const gateContext = gateRefs ? `\nRead the latest gate results first:\n${gateRefs}\n` : '';
      resolvedPrompt = `RETRY FIX (attempt ${innerRetry + 1}): Previous fix attempt did not resolve all issues.${gateContext}\nRead your previous output at ${runDirPath}/stages/${stage.id}/output_attempt_${innerRetry}.md (falling back to output.md if that file is absent, which is the case for runs recorded before attempt-scoped outputs existed) to see what you already tried. Try a DIFFERENT approach — do not repeat the same fix.\n\n${resolvedPrompt}`;
    }
    if (!stage.is_gate && activeRetryGateIds.length) {
      resolvedPrompt = `${buildGateFixCorrectionContract(runDirPath, activeRetryGateIds, archiveCoordinate)}\n\n${resolvedPrompt}`;
    }
  }

  // Knowledge Graph context: inject summary for dispatched stages
  try {
    const kgSummary = summarizeKG(readKG(projectDir, runId));
    if (kgSummary) resolvedPrompt = kgSummary + '\n\n' + resolvedPrompt;
  } catch { /* no KG yet */ }

  resolvedPrompt = appendApprovalRequestContract(resolvedPrompt, runDirPath, stage.id);
  resolvedPrompt = appendScopeRevisionContract(resolvedPrompt, runDirPath, runId, stage);
  if (stage.dynamic_dispatch) {
    resolvedPrompt = appendScopePlanningInput(resolvedPrompt, runDirPath);
    resolvedPrompt = appendUnresolvedStageObligationContext(resolvedPrompt, readRunState(projectDir, runId));
  }

  resolvedPrompt = appendGateConstraintAuditContext(resolvedPrompt, stage, allStages, readRunState(projectDir, runId), runDirPath);

  if (stage.is_gate) {
    resolvedPrompt = appendGateMetricInstruction(resolvedPrompt, runDirPath, stage.id, currentGateAttempt!);
  }

  let availableRoles: string | undefined;
  if (stage.dynamic_dispatch) {
    availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
  }

  const maxTechnicalRetries = configuredTechnicalRetryLimit(projectDir);
  let retries = 0;
  const sessionReuseEnabled = isSessionReuseEnabled(projectDir);
  const resumeSession = gateContinuationSessionForStage(stage, runDirPath, innerRetry !== undefined)
    ?? sessionResumeForStage(stage, allStages, state, runDirPath, sessionReuseEnabled);
  const technicalRetry = createSchedulerTechnicalRetryState(initialTimeout);

  while (true) {
    // A prior technical attempt is completed by runStage() directly in the
    // per-stage status file. Re-read that authoritative ledger before marking
    // the next attempt running; the scheduler's in-memory state predates the
    // call and must never overwrite a just-recorded timeout/failure.
    let latestStageStatus = state.stages[stage.id];
    try { latestStageStatus = readStageStatus(projectDir, runId, stage.id); } catch { /* first execution */ }
    state.stages[stage.id] = {
      ...latestStageStatus,
      status: STAGE_STATUS.RUNNING,
      retries,
      startedAt: latestStageStatus?.startedAt ?? new Date().toISOString(),
    };
    writeStageStatus(projectDir, runId, stage.id, state.stages[stage.id]);
    writeRunState(projectDir, runId, state);

    const prepared = prepareSchedulerTechnicalAttempt(technicalRetry);
    const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
    if (currentGateAttempt) {
      initializeGateMetricAttempt(
        runDirPath,
        stage.id,
        currentGateAttempt.iteration,
        currentGateAttempt.round,
        retries,
      );
    }
    const result = await runStage(stageAdapter, {
      stageId: stage.id,
      role: agent,
      dependsOn: stage.depends_on ?? [],
      promptTemplate: appendAttemptDeadlineContract(retries > 0
        ? `${buildRetryPreamble(retries, prepared.budgetMs, runDirPath, stage.id, prepared.retryContext)}\n\n${resolvedPrompt}`
        : resolvedPrompt, prepared.budgetMs),
      timeout_ms: prepared.budgetMs,
      ...(attemptDeadlineClockFactory ? { deadlineClock: attemptDeadlineClockFactory() } : {}),
      projectDir,
      runId,
      runDir: runDirPath,
      retries,
      skills,
      stageSkills: stage.skills,
      availableRoles,
      availableSkills,
      taskDescription: taskDescription || state.taskDescription,
      isGate: stage.is_gate,
      criterionRefs: stage.criterion_refs,
      resumeSessionId: resumeSession?.sessionId,
      sessionOwnerStageId: resumeSession?.ownerStageId,
      preserveSession: retries === 0 && shouldPreserveSession(stage, allStages, sessionReuseEnabled),
    });

    const retryableTimeout = recordSchedulerTechnicalAttemptResult(
      technicalRetry,
      result,
      prepared.budgetMs,
    );

    if (retryableTimeout) {
      if (retries < maxTechnicalRetries) {
        retries++;
        log.warn({ stage: stage.id, retry: retries }, 'Retrying timed-out stage (inner loop)');
        continue;
      }
      transitionTechnicalRetryBudget(technicalRetry, { type: 'retry_exhausted' });
    }

    break;
  }

  // Stage status is already written to individual status.json by runStage/worker.
  // Record the outcome event using the authoritative per-stage file.
  try {
    const stageStatus = readStageStatus(projectDir, runId, stage.id);
    recordStageOutcome(projectDir, runId, stage.id, state.currentIteration, stageStatus);
    // Record trace event for stage completion
    try {
      appendTraceEvent(projectDir, runId, stage.id, {
        timestamp: new Date().toISOString(),
        stageId: stage.id,
        type: 'llm_call',
        inputSummary: `Stage ${stage.id} (${stage.role})`,
        outputSummary: `Completed in ${Math.round((stageStatus.duration_ms ?? 0) / 1000)}s`,
        tokensIn: stageStatus.tokens_in,
        tokensOut: stageStatus.tokens_out,
        durationMs: stageStatus.duration_ms ?? 0,
      });
    } catch { /* non-fatal */ }
  } catch { /* status file missing — should not happen */ }

  // After stage completion, check for KG updates
  try {
    readKG(state.projectDir, state.runId);
  } catch { /* no KG yet, that's fine */ }
}

/**
 * Execute one iteration of the workflow: run ready stages, inject dispatched stages,
 * handle approval polling, and manage stage retries (technical failures).
 *
 * Returns the final state for this iteration. The caller (runWorkflow) then handles
 * gate evaluation and decides whether to re-plan.
 */
async function executeIteration(
  sorted: StageConfig[],
  initialState: StoreState,
  projectDir: string,
  runId: string,
  runDirPath: string,
  workflow: WorkflowConfig,
  adapter: Adapter,
  agents: Map<string, AgentConfig>,
  resolvedAgentsDir: string,
  roleRegistry: Map<string, { name: string; description: string }>,
  injectedDispatchStages: Set<string>,
  planStageRetries: Map<string, number>,
  skills?: string,
  taskDescription?: string,
  availableSkills?: string,
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock,
): Promise<StoreState> {
  const technicalRetries = new Map<string, TechnicalRetryBudgetState>();
  while (true) {
    let state = readRunState(projectDir, runId);

    // Exit if run was cancelled or reached any terminal state externally
    if (isTerminalRunStatus(state.status)) {
      return state;
    }

    // A park RETURNS (process exits, project frees, daemon queue advances) —
    // deliberately NOT the legacy plan-review busy-poll below, which holds the
    // process and the project lock while it waits.
    if (isPausedRunStatus(state.status)) {
      return state;
    }

    // Poll while awaiting approval
    if (isAwaitingApprovalRunStatus(state.status)) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // Inject dispatched stages
    for (const stage of sorted) {
      if (stage.dynamic_dispatch && !injectedDispatchStages.has(stage.id) &&
          state.stages[stage.id]?.status === STAGE_STATUS.COMPLETE) {
        const plannerChecksPath = join(runDirPath, 'reality_checks.md');
        let exactTaskBrief = state.taskDescription ?? taskDescription ?? '';
        try {
          const persistedBriefPath = join(runDirPath, 'task_brief.md');
          if (existsSync(persistedBriefPath)) exactTaskBrief = readFileSync(persistedBriefPath, 'utf-8');
        } catch { /* state.taskDescription remains the admitted fallback */ }

        if (exactTaskBrief.trim()) {
          const plannerChecks = existsSync(plannerChecksPath)
            ? readFileSync(plannerChecksPath, 'utf-8')
            : '';
          const validationBaseline = readShipSetupReadyValidationBaseline(projectDir, exactTaskBrief);
          const preflight = inspectRealityChecks(exactTaskBrief, plannerChecks, { validationBaseline });
          if (preflight.refusingFindings.length > 0) {
            writeRealityCheckPreflightArtifact(runDirPath, stage.id, preflight, 'refused');
            const refusalEvidence = JSON.stringify(preflight.refusingFindings.map((finding) => ({
              code: finding.code,
              checkIndex: finding.checkIndex,
              checkName: finding.checkName,
              checkType: finding.checkType,
              evidence: finding.evidence,
            })));
            const blockage = observeStableBlockage({
              runDirPath,
              kind: 'planner_reality_preflight',
              stageId: stage.id,
              detail: preflight.refusingFindings.map((finding) => finding.code).sort().join(','),
              evidenceDigest: createHash('sha256').update(refusalEvidence, 'utf8').digest('hex'),
              threshold: state.campaignTriggers?.repeatedFailureAfter,
            });
            if (blockage?.escalatedNow) {
              return concludeRepeatedBlockage(state, {
                projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1,
              }) ?? state;
            }
            const maxPlanRetries = Math.max(0, Math.floor(Number(loadDefaults(projectDir).plan_stage_retries)));
            const retriesUsed = planStageRetries.get(stage.id) ?? 0;
            const decision = decideRealityCheckPreflightAction(
              preflight.refusingFindings,
              retriesUsed,
              maxPlanRetries,
            );

            if (decision.action === 'retry') {
              // Both planner artifacts belong to one proposal. Removing both is
              // what prevents a corrected dispatch from inheriting stale checks.
              for (const artifact of [join(runDirPath, 'dispatch.yaml'), plannerChecksPath]) {
                try { if (existsSync(artifact)) unlinkSync(artifact); } catch { /* already gone */ }
              }
              planStageRetries.set(stage.id, decision.nextRetry);
              injectedDispatchStages.delete(stage.id);
              const replanStatus: StageStatus = {
                ...state.stages[stage.id],
                status: STAGE_STATUS.PENDING,
                retries: decision.nextRetry,
                error: decision.error,
              };
              writeStageStatus(projectDir, runId, stage.id, replanStatus);
              state.stages[stage.id] = replanStatus;
              writeRunState(projectDir, runId, state);
              log.warn(
                { stage: stage.id, retry: decision.nextRetry, max: maxPlanRetries, detail: decision.detail },
                'Planner Reality-Gate checks refused before dispatch — bounded re-plan retry',
              );
              recordRunEvent(projectDir, runId, {
                type: 'plan_dispatch_retry',
                runId,
                timestamp: new Date().toISOString(),
                iteration: state.currentIteration ?? 1,
                stageId: stage.id,
                detail: `Reality-check preflight retry ${decision.nextRetry}/${maxPlanRetries}: ${decision.detail}`,
              });
              break;
            }

            log.error({ stage: stage.id, findings: preflight.refusingFindings }, decision.reason);
            state.status = decision.status;
            state.failureReason = decision.reason;
            state.completedAt = new Date().toISOString();
            writeRunState(projectDir, runId, state);
            recordRunEvent(projectDir, runId, {
              type: 'run_completed',
              runId,
              timestamp: state.completedAt,
              iteration: state.currentIteration ?? 1,
              stageId: stage.id,
              detail: `failed: ${decision.reason}`,
            });
            return state;
          }

          if (preflight.advisoryFindings.length > 0) {
            const rewrite = demoteRealityCheckAdvisories(plannerChecks, preflight.advisoryFindings);
            if (rewrite.markdown !== plannerChecks) {
              writeFileSync(plannerChecksPath, rewrite.markdown, 'utf-8');
            }
            writeRealityCheckPreflightArtifact(
              runDirPath,
              stage.id,
              preflight,
              'admitted_with_advisories',
              rewrite.demotedCheckIndexes,
            );
            const detail = formatRealityCheckPreflightFindings(preflight.advisoryFindings);
            log.warn(
              { stage: stage.id, demotedCheckIndexes: rewrite.demotedCheckIndexes, detail },
              'Planner Reality-Gate intent findings admitted as runtime advisories before dispatch',
            );
            recordRunEvent(projectDir, runId, {
              type: 'reality_gate_advisory',
              runId,
              timestamp: new Date().toISOString(),
              iteration: state.currentIteration ?? 1,
              stageId: stage.id,
              level: 'warning',
              detail: `Pre-dispatch lint demoted check indexes ${rewrite.demotedCheckIndexes.join(', ') || 'none'} to advisory: ${detail}`,
            });
          } else {
            writeRealityCheckPreflightArtifact(runDirPath, stage.id, preflight, 'admitted');
          }
        }

        injectedDispatchStages.add(stage.id);
        const injected = injectDispatchedStages(stage.id, roleRegistry, sorted, state, projectDir, runId);

        if (injected.length === 0) {
          // Check if there are static fallback stages
          const hasStaticFollowUp = sorted.some(s =>
            s.id !== stage.id && state.stages[s.id] && isPendingStageStatus(state.stages[s.id].status)
          );
          if (!hasStaticFollowUp) {
            // A dynamic_dispatch (plan) stage exited 0 (worker.ts marks exit-0
            // 'complete' with no semantic check) but produced ZERO valid injected
            // stages and there is no static follow-up. This is usually a TRANSIENT
            // LLM flake (truncated/empty/unparseable dispatch.yaml) — previously
            // fatal, which punted to the human and bypassed the re-plan + retry
            // machinery. Make it a BOUNDED RETRY of the plan stage instead, and
            // only escalate (with the SPECIFIC parse/unknown-role detail) once the
            // budget is exhausted — or immediately if the failure is genuine (every
            // stage names an unknown role: re-planning the same brief just repeats it).
            const dispatchPath = join(runDir(projectDir, runId), 'dispatch.yaml');
            const dispatchExists = existsSync(dispatchPath);
            let rawDispatchText: string | null = null;
            if (dispatchExists) { try { rawDispatchText = readFileSync(dispatchPath, 'utf-8'); } catch { /* best effort */ } }
            const diagnosis = diagnoseEmptyDispatch(dispatchExists, rawDispatchText, [...roleRegistry.keys()]);
            const blockage = observeStableBlockage({
              runDirPath,
              kind: 'planner_dispatch_refusal',
              stageId: stage.id,
              detail: diagnosis.transient ? 'transient invalid dispatch' : 'unresolvable dispatch roles',
              evidenceDigest: createHash('sha256')
                .update(rawDispatchText ?? '<missing dispatch>', 'utf8')
                .digest('hex'),
              threshold: state.campaignTriggers?.repeatedFailureAfter,
            });
            if (blockage?.escalatedNow) {
              return concludeRepeatedBlockage(state, {
                projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1,
              }) ?? state;
            }
            const maxPlanRetries = Math.max(0, Math.floor(Number(loadDefaults(projectDir).plan_stage_retries)));
            const retriesUsed = planStageRetries.get(stage.id) ?? 0;
            const decision = decideEmptyDispatchAction(diagnosis, retriesUsed, maxPlanRetries);

            if (decision.action === 'retry') {
              // Bounded re-plan: delete the bad dispatch.yaml, re-pend the plan
              // stage (so it re-runs), bump its retry counter, and stamp the
              // specific error into status.json so buildRetryPreamble injects the
              // dispatch-specific re-prompt ("you failed to emit a valid
              // dispatch.yaml — here is the parse error / required schema — write
              // ONLY the file"). Then loop so the plan stage runs again.
              try { if (dispatchExists) unlinkSync(dispatchPath); } catch { /* already gone */ }
              planStageRetries.set(stage.id, decision.nextRetry);
              injectedDispatchStages.delete(stage.id); // allow re-injection after the re-run
              const replanStatus: StageStatus = {
                ...state.stages[stage.id],
                status: STAGE_STATUS.PENDING,
                retries: decision.nextRetry,
                error: decision.error,
              };
              writeStageStatus(projectDir, runId, stage.id, replanStatus);
              state.stages[stage.id] = replanStatus;
              writeRunState(projectDir, runId, state);
              log.warn({ stage: stage.id, retry: decision.nextRetry, max: maxPlanRetries, detail: decision.detail }, 'Plan stage emitted no valid dispatch — bounded re-plan retry');
              recordRunEvent(projectDir, runId, {
                type: 'plan_dispatch_retry',
                runId,
                timestamp: new Date().toISOString(),
                iteration: state.currentIteration ?? 1,
                detail: `plan retry ${decision.nextRetry}/${maxPlanRetries}: ${decision.detail}`,
              });
              break; // restart the while(true) loop → ready stages now include the re-pended plan stage
            }

            // Escalate with specifics (NOT the generic "refine the brief" punt).
            log.error({ stage: stage.id, status: decision.status, unknownRoles: decision.unknownRoles }, decision.reason);
            state.status = decision.status;
            state.failureReason = decision.reason;
            state.completedAt = new Date().toISOString();
            writeRunState(projectDir, runId, state);
            recordRunEvent(projectDir, runId, {
              type: 'run_completed',
              runId,
              timestamp: state.completedAt,
              iteration: state.currentIteration ?? 1,
              detail: `${decision.status}: ${decision.reason}`,
            });
            return state;
          }
          log.info({ stage: stage.id }, 'No dispatch.yaml — falling back to static stages');
        }

        state = readRunState(projectDir, runId);
      }
    }

    if (isAwaitingApprovalRunStatus(state.status)) {
      // Auto-approve on iteration 2+ (re-plans) when autoApproveRetries is not explicitly false.
      // First iteration always requires manual approval so the user can review the plan,
      // unless autoApprove is explicitly true (API-created autonomous tasks).
      const currentIter = state.currentIteration ?? 1;
      if ((currentIter > 1 && state.autoApproveRetries !== false) || state.autoApprove === true) {
        state.status = RUN_STATUS.RUNNING;
        writeRunState(projectDir, runId, state);
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const ready = findAllReady(sorted, state);

    if (ready.length === 0) {
      // Don't set final status here — let the outer iteration loop check gates
      writeRunState(projectDir, runId, state);
      return state;
    }

    const runnableCandidates: StageConfig[] = [];
    const stageEvents: Array<{ stageId: string; status: StageStatus }> = [];
    for (const stage of ready) {
      if (stage.condition) {
        const met = evaluateCondition(stage.condition, projectDir, runId);
        if (!met) {
          const skipped: StageStatus = { status: 'skipped', retries: 0 };
          writeStageStatus(projectDir, runId, stage.id, skipped);
          state.stages[stage.id] = skipped;
          writeRunState(projectDir, runId, state);
          recordStageOutcome(projectDir, runId, stage.id, state.currentIteration, skipped);
          log.info({ stage: stage.id }, 'Skipped (condition not met)');
          continue;
        }
      }
      // Skip retry_to stages during initial execution; the inner loop handles them
      // But don't skip is_gate stages — they need to run to evaluate the gate
      if (stage.retry_to && stage.retry_to.length > 0 && !stage.is_gate) {
        const skipped: StageStatus = { status: 'skipped', retries: 0 };
        writeStageStatus(projectDir, runId, stage.id, skipped);
        state.stages[stage.id] = skipped;
        writeRunState(projectDir, runId, state);
        recordStageOutcome(projectDir, runId, stage.id, state.currentIteration, skipped);
        continue;
      }
      runnableCandidates.push(stage);
    }

    const { selected: toRun, deferred: scopeDeferred } = selectRunnableBatch(runnableCandidates);
    for (const { stage, conflict } of scopeDeferred) {
      const detail = `${stage.id} deferred behind ${conflict.leftStageId}: ${conflict.reason}`;
      log.info({ stage: stage.id, conflict }, 'Serializing ready stage because declared scopes are not provably disjoint');
      recordRunEvent(projectDir, runId, {
        type: 'parallel_scope_serialized',
        runId,
        timestamp: new Date().toISOString(),
        iteration: state.currentIteration ?? 1,
        stageId: stage.id,
        stageIds: [conflict.leftStageId, conflict.rightStageId],
        level: 'info',
        detail,
      });
    }

    if (toRun.length === 0) continue;

    for (const stage of toRun) {
      const currentRetries = state.stages[stage.id]?.retries ?? 0;
      state.stages[stage.id] = {
        ...state.stages[stage.id],
        status: STAGE_STATUS.RUNNING,
        retries: currentRetries,
        startedAt: state.stages[stage.id]?.startedAt ?? new Date().toISOString(),
      };
    }
    writeRunState(projectDir, runId, state);

    const ordinaryScopeContext = createScopeBatchContext(projectDir, toRun);
    const activeScopeStageIds = new Set(toRun.map((stage) => stage.id));
    let ordinaryBatchComplete = false;
    const ordinaryScopeMonitor = monitorScopeRevisionRequests({
      selected: toRun,
      activeStageIds: activeScopeStageIds,
      projectDir,
      runId,
      context: ordinaryScopeContext,
      isComplete: () => ordinaryBatchComplete,
    });
    const results = await Promise.all(toRun.map(async (stage) => {
     try {
      if (!agents.has(stage.role)) {
        const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
        if (!existsSync(agentPath)) throw new Error(`No agent config for role "${stage.role}"`);
        const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
        agents.set(stage.role, applyBasePrompt(parseAgent(raw, projectDir), loadBasePrompt(resolvedAgentsDir)));
      }
      const agent = agents.get(stage.role)!;
      const initialTimeout = stageInitialTimeout(projectDir);
      const currentGateAttempt = stage.is_gate
        ? gateAttemptCoordinate(state.currentIteration ?? 1)
        : undefined;
      let technicalRetry = technicalRetries.get(stage.id);
      const currentRetries = state.stages[stage.id]?.retries ?? 0;
      log.info({ stage: stage.id, role: stage.role }, 'Running stage');

      let availableRoles: string | undefined;
      let availableChecks: string | undefined;
      let resultSchema: string | undefined;
      let contextInventory: string | undefined;
      let ledgerDigest: string | undefined;
      if (stage.dynamic_dispatch) {
        // Context primitive: inject the on-disk data/asset inventory so the planner's Propose
        // step works from the real world-model (never signposts acquiring data already present).
        contextInventory = summarizeContext(projectDir, state.research?.contextRoots ?? ['data']);
        // Ledger primitive: inject the campaign's tried directions + dead-ends so Propose does
        // not repeat prior work. Always computed (not gated by --no-inherit: it is the compact
        // dedup ledger, not the verbose narrative context that flag suppresses).
        ledgerDigest = summarizeLedger(projectDir, state.campaignId);
        availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
        // Inject the self-describing deterministic-check vocabulary so the planner
        // composes gates from real checks, not only free-text QA prose.
        availableChecks = (await listCheckTypes()).map((c) => `- ${c.type}: ${c.description} (params: ${c.params})`).join('\n');
        // Single-source the round_result output contract: the planner's checks must reference
        // THIS schema (not invent fields). The engine enforces the same schema per round (Gate #0).
        if (state.research?.resultSchema) resultSchema = JSON.stringify(state.research.resultSchema, null, 2);
      }

      let resolvedPrompt = stage.prompt_template;
      if (!resolvedPrompt) {
        resolvedPrompt = (stage.depends_on ?? []).length === 0
          ? (taskDescription ?? '') + '\nProject: ' + projectDir
          : (taskDescription ?? '');
      }

      // Entry stages consume the task text captured and parsed at admission.
      // Re-reading task_brief.md here would let a later sidecar edit replace
      // the exact bytes that the launcher already admitted.
      if ((stage.depends_on ?? []).length === 0) {
        const admittedTask = taskDescription?.trim();
        if (admittedTask) {
          resolvedPrompt = admittedTask + '\nProject: ' + projectDir;
        }
        // On re-plan, include iteration_log.md reference
        const iterLogPath = join(runDirPath, 'iteration_log.md');
        if (existsSync(iterLogPath)) {
          resolvedPrompt += `\n\nRead ${runDirPath}/iteration_log.md for previous iteration results. Fix the issues identified there.`;
        }
        // Campaign context: prepend only fresh, non-terminal, active-phase history.
        // --campaign-context=skip (and its legacy alias) suppresses this verbose block;
        // campaign ownership, telemetry and the compact dead-end ledger remain intact.
        const campaignStorageKey = resolveCampaignStorageKey({
          campaignId: state.campaignId,
          campaignStorageKey: state.campaignStorageKey,
          campaignName: state.campaignName,
        });
        if (campaignStorageKey && state.inheritCampaignContext !== false) {
          const entries = readCampaignEntries(projectDir, campaignStorageKey);
          if (entries.length > 0) {
            const selection = selectRelevantCampaignContext(entries);
            const summaryPaths: string[] = [];
            for (const previousRunId of selection.summaryRunIds) {
              const prevRunDir = runDir(projectDir, previousRunId);
              const iterLog = join(prevRunDir, 'iteration_log.md');
              if (existsSync(iterLog) && !summaryPaths.includes(iterLog)) summaryPaths.push(iterLog);
            }
            const triggers = state.campaignTriggers;
            const alert = checkCampaignHealth(selection.entries, triggers);
            const context = formatCampaignContextBlock({
              campaignLabel: state.campaignName ?? state.campaignId ?? campaignStorageKey,
              selection,
              summaryPaths,
              alert,
            });
            if (context) resolvedPrompt = context + resolvedPrompt;
          }
        }
      }

      // Pivot context: inject into planner prompt when research injection is active
      if (state.researchInjection && (stage.depends_on ?? []).length === 0) {
        resolvedPrompt = `⚠️ PIVOT REQUIRED: The previous approach failed. Campaign health detected: ${state.researchInjection.alertType}. ${state.researchInjection.message}. You MUST plan a research stage to explore new directions before attempting implementation. Check dead_end nodes in the knowledge graph to understand what has been tried and failed.\n\n` + resolvedPrompt;
      }

      // Knowledge Graph context: inject summary for ALL roles
      try {
        const kgSummary = summarizeKG(readKG(projectDir, runId));
        if (kgSummary) resolvedPrompt = kgSummary + '\n\n' + resolvedPrompt;
      } catch { /* no KG yet */ }

      // Prepend retry context if this is a retry (timeout or supervisor abort)
      resolvedPrompt = appendApprovalRequestContract(resolvedPrompt, runDirPath, stage.id);
      resolvedPrompt = appendScopeRevisionContract(resolvedPrompt, runDirPath, runId, stage);
      if (stage.dynamic_dispatch) {
        resolvedPrompt = appendScopePlanningInput(resolvedPrompt, runDirPath);
        resolvedPrompt = appendUnresolvedStageObligationContext(resolvedPrompt, readRunState(projectDir, runId));
      }
      resolvedPrompt = appendGateConstraintAuditContext(resolvedPrompt, stage, sorted, readRunState(projectDir, runId), runDirPath);

      if (stage.is_gate) {
        resolvedPrompt = appendGateMetricInstruction(resolvedPrompt, runDirPath, stage.id, currentGateAttempt!);
      }

      const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
      const sessionReuseEnabled = isSessionReuseEnabled(projectDir);
      const resumeSession = sessionResumeForStage(stage, sorted, state, runDirPath, sessionReuseEnabled);
      if (!technicalRetry) {
        technicalRetry = createSchedulerTechnicalRetryState(
          initialTimeout,
          state.stages[stage.id],
          true,
        );
        technicalRetries.set(stage.id, technicalRetry);
      }
      const prepared = prepareSchedulerTechnicalAttempt(technicalRetry);
      if (currentRetries > 0) {
        resolvedPrompt = `${buildRetryPreamble(currentRetries, prepared.budgetMs, runDirPath, stage.id, prepared.retryContext)}\n\n${resolvedPrompt}`;
      }
      resolvedPrompt = appendAttemptDeadlineContract(resolvedPrompt, prepared.budgetMs);
      if (currentGateAttempt) {
        initializeGateMetricAttempt(
          runDirPath,
          stage.id,
          currentGateAttempt.iteration,
          currentGateAttempt.round,
          currentRetries,
        );
      }
      const result = await runStage(stageAdapter, {
        stageId: stage.id,
        role: agent,
        dependsOn: stage.depends_on ?? [],
        promptTemplate: resolvedPrompt,
        timeout_ms: prepared.budgetMs,
        ...(attemptDeadlineClockFactory ? { deadlineClock: attemptDeadlineClockFactory() } : {}),
        projectDir,
        runId,
        runDir: runDirPath,
        retries: currentRetries,
        skills,
        stageSkills: stage.skills,
        availableRoles,
        availableChecks,
        availableSkills,
        resultSchema,
        contextInventory,
        ledgerDigest,
        taskDescription: taskDescription || state.taskDescription,
        isGate: stage.is_gate,
        criterionRefs: stage.criterion_refs,
        resumeSessionId: resumeSession?.sessionId,
        sessionOwnerStageId: resumeSession?.ownerStageId,
        preserveSession: currentRetries === 0 && shouldPreserveSession(stage, sorted, sessionReuseEnabled),
      });
      recordSchedulerTechnicalAttemptResult(technicalRetry, result, prepared.budgetMs);
      return { stage, result, currentRetries };
     } catch (err) {
       // A stage that THROWS (e.g. missing/invalid agent yaml at runtime) must not
       // reject Promise.all and unwind out of the loop, which would leave run.json
       // stuck 'running' forever (orphan). Degrade to a normal stage failure so the
       // downstream handling turns the run into 'failed'.
       const retriesNow = state.stages[stage.id]?.retries ?? 0;
       const msg = err instanceof Error ? err.message : String(err);
       log.error({ stage: stage.id, err: msg }, 'Stage threw before completion — degrading to failed');
       try {
         completeStageAttempt(projectDir, runId, stage.id, retriesNow, {
           exitCode: 1,
           duration_ms: 0,
           error: msg,
           writeAttribution: 'unknown',
         });
       } catch { /* non-critical */ }
       const failedResult: RunResult = { output: '', exitCode: 1, duration_ms: 0, timedOut: false, adapterError: false };
       return { stage, result: failedResult, currentRetries: retriesNow };
     } finally {
       activeScopeStageIds.delete(stage.id);
     }
    }));
    ordinaryBatchComplete = true;
    await ordinaryScopeMonitor;
    for (const item of results) {
      const reconciled = reconcileCompletedStageAttempts({ stage: item.stage, projectDir, runId, context: ordinaryScopeContext });
      if (reconciled.violation) {
        item.result.exitCode = 1;
        item.result.timedOut = false;
        item.result.timeoutTerminationCause = 'failed';
      }
      if (state.research && item.result.exitCode === 0) {
        const status = readStageStatus(projectDir, runId, item.stage.id);
        const findings = inspectTemporalResearchTests({
          projectDir,
          writes: status.attempts?.at(-1)?.writes ?? status.writes ?? [],
          resultFile: state.research.resultFile,
          terminalPaths: Object.values(state.terminalStates ?? {}).flatMap((entry) => entry.paths),
        });
        if (findings.length > 0) {
          const reason = `Temporal test contract rejected ${findings.length} generated test(s): ${findings.map((finding) => `${finding.file}: ${finding.reason}`).join('; ')}`;
          try {
            writeFileSync(join(runDirPath, 'stages', item.stage.id, 'temporal_test_guard.json'), `${JSON.stringify({
              version: 1,
              pass: false,
              findings,
            }, null, 2)}\n`, 'utf-8');
          } catch { /* non-critical */ }
          status.status = STAGE_STATUS.FAILED;
          status.exitCode = 1;
          status.error = reason;
          const attempt = status.attempts?.at(-1);
          if (attempt) {
            attempt.status = STAGE_STATUS.FAILED;
            attempt.exitCode = 1;
            attempt.error = reason;
          }
          writeStageStatus(projectDir, runId, item.stage.id, status);
          item.result.exitCode = 1;
          item.result.timedOut = false;
          item.result.timeoutTerminationCause = 'failed';
        }
      }
    }

    state = readRunState(projectDir, runId);
    let failed = false;

    for (const { stage, result, currentRetries } of results) {
      const maxFailureRetries = Math.max(0, Math.floor(Number(
        stage.max_retries ?? workflow.defaults.max_retries ?? configuredTechnicalRetryLimit(projectDir),
      )));
      const maxTechnicalRetries = configuredTechnicalRetryLimit(projectDir);
      const isAttemptTimeout = result.timedOut && result.timeoutTerminationCause === 'attempt_timeout';

      if (isAttemptTimeout && currentRetries < maxTechnicalRetries) {
        const nextRetry = currentRetries + 1;
        const retryStatus = rependStageStatus(readStageStatus(projectDir, runId, stage.id), nextRetry);
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn({ stage: stage.id, retry: nextRetry }, 'Retrying timed-out stage');
        continue;
      }

      if (isAttemptTimeout) {
        const technicalRetry = technicalRetries.get(stage.id);
        if (technicalRetry) transitionTechnicalRetryBudget(technicalRetry, { type: 'retry_exhausted' });
      }

      if (!isAttemptTimeout && result.exitCode !== 0 && currentRetries < maxFailureRetries) {
        // Preserve the failed attempt's `error`: buildRetryPreamble reads it to
        // tell the next attempt WHY the previous one died. Writing the pending
        // status without it left that branch dead, so EVERY non-timeout failure
        // was reported to the agent as "timed out" — including a diagnosed
        // parameter rejection, which now explains itself.
        const failedStatus = readStageStatus(projectDir, runId, stage.id);
        const retryStatus = rependStageStatus(failedStatus, currentRetries + 1, failedStatus.error);
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn({ stage: stage.id, retry: currentRetries + 1, cause: retryStatus.error }, 'Retrying stage');
        continue;
      }

      if (result.exitCode !== 0) {
        technicalRetries.delete(stage.id);
        log.error({ stage: stage.id }, 'Stage failed');
        failed = true;
        state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
        stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
        continue;
      }

      state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
      technicalRetries.delete(stage.id);
      stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
      log.info({ stage: stage.id }, 'Stage complete');
    }

    for (const conflict of detectParallelWriteConflicts(toRun.map((stage) => stage.id), state.stages)) {
      const detail = `${conflict.stageIds[0]} and ${conflict.stageIds[1]} both wrote ${conflict.files.join(', ')} (attribution: ${conflict.attribution.join(' / ')})`;
      log.warn({ conflict }, 'Parallel stages wrote the same file');
      recordRunEvent(projectDir, runId, {
        type: 'parallel_write_conflict',
        runId,
        timestamp: new Date().toISOString(),
        iteration: state.currentIteration ?? 1,
        stageIds: conflict.stageIds,
        files: conflict.files,
        level: 'warning',
        detail,
      });
    }

    writeRunState(projectDir, runId, state);
    for (const event of stageEvents) {
      recordStageOutcome(projectDir, runId, event.stageId, state.currentIteration, event.status);
    }

    // Scope admission may split one logical ready set into several physical
    // waves. Do not park, terminate, or return a failure between those waves:
    // the pre-E6 Promise.all batch let every ready peer finish, and its approval
    // requests/artifacts remained observable even when another peer failed.
    if (scopeDeferred.length > 0) {
      log.info({ deferred: scopeDeferred.map(({ stage }) => stage.id) }, 'Continuing serialized waves before batch-level terminal handling');
      continue;
    }

    // Bug #8 fix: EAGER terminal-state detection after each completed batch.
    // A stage may write the terminal artifact (e.g. phase_X_verdict.md) and a
    // LATER stage in the same iteration (a QA/fix gate doing git hygiene) may
    // then delete it before the iteration-boundary check runs — exactly what
    // happened in Phase I, where the verdict file was written then wiped by a
    // bytecode-cleanup `git clean`, so the hook never fired. Checking right
    // after each batch catches the artifact while it still exists, snapshots
    // it to the run dir, fires the hook, and short-circuits the remaining
    // stages (terminal state means "we're done" — no need to keep churning).
    // [Approval park gate, call site 2 of 2] Ingest every request the batch
    // wrote even when a peer stage failed; a failure must not erase another
    // stage's consequential-action request.
    const parkedEager = await tryParkOnApprovalRequest(state, { projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1 });
    if (parkedEager) return parkedEager;

    const terminalEager = await tryTerminateOnTerminalState(state, { projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1, adapter });
    if (terminalEager.decision === 'matched') return terminalEager.state;

    if (failed) {
      // Don't set run status to failed here — let the iteration loop handle it
      return state;
    }
  }
}
