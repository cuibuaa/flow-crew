import { readFileSync, mkdirSync, readdirSync, writeFileSync, existsSync, unlinkSync, appendFileSync, statSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { evaluateCondition } from './condition.js';
import { createRun, enforceRealityGateBeforeTerminal, readRunState, writeRunState, writeStageStatus, readStageStatus, runDir, stageDir, runsRoot, isTerminalRunStatus } from './store.js';
import type { StoreState, StageStatus, TerminalStatesConfig, TerminalStateEntry, PostTerminateHook, ProgramConfig, ResearchConfig } from './store.js';
import { evaluateResearch, type ResearchRound } from './research-policy.js';
import { runStage } from './worker.js';
import {
  canonicalCampaignId,
  collapseEntriesForHealth,
  readCampaignEntries,
  resolveCampaignStorageKey,
  summarizeCampaignPhaseProgress,
} from './campaigns.js';
import { recordRunEvent, recordStageOutcome } from './run-events.js';
import { readKG, summarizeKG, ratchetCheck, markDeadEnd, updateMetadata } from './knowledge-graph.js';
import { appendTraceEvent } from './trace.js';
import { generateRunSummary } from './run-summary.js';
import { Supervisor } from './supervisor.js';
import { loadProjectDefaults, loadSupervisorConfig } from './config.js';
import pino from 'pino';

const log = pino({ name: 'scheduler' });

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
 * Returns the stripped brief (with frontmatter removed so the planner doesn't
 * see internal config) plus the parsed config. Briefs without frontmatter,
 * with malformed YAML, or with unknown shapes are passed through unchanged.
 */
export function parseBriefFrontmatter(brief: string): { terminalStates?: TerminalStatesConfig; program?: ProgramConfig; research?: ResearchConfig; stripped: string } {
  if (!brief.startsWith('---\n') && !brief.startsWith('---\r\n')) return { stripped: brief };
  const open = brief.indexOf('\n', 3) + 1;
  const closeIdx = brief.indexOf('\n---', open);
  if (closeIdx < 0) return { stripped: brief };
  const fm = brief.slice(open, closeIdx);
  // Find the newline that ends the closing fence so we can slice past it
  const afterFence = brief.indexOf('\n', closeIdx + 4);
  const stripped = afterFence < 0 ? '' : brief.slice(afterFence + 1);
  let parsed: unknown;
  try { parsed = parseYaml(fm); } catch { return { stripped: brief }; }
  if (!parsed || typeof parsed !== 'object') return { stripped };
  const out: { terminalStates?: TerminalStatesConfig; program?: ProgramConfig; research?: ResearchConfig; stripped: string } = { stripped };

  // Parse the optional `research:` block — drives the native research loop
  // (researcher → implement → measure → decide). Requires baseline + policy.
  const resRaw = (parsed as Record<string, unknown>).research;
  if (resRaw && typeof resRaw === 'object') {
    const r = resRaw as Record<string, unknown>;
    if (typeof r.baseline === 'number') {
      const policy = (typeof r.policy === 'string' && ['greedy_stack', 'best_of_n', 'replace_if_better'].includes(r.policy))
        ? r.policy as ResearchConfig['policy'] : 'greedy_stack';
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
      if (r.stop && typeof r.stop === 'object') {
        const s = r.stop as Record<string, unknown>;
        research.stop = {};
        if (typeof s.beat === 'number') research.stop.beat = s.beat;
        if (typeof s.max_rounds === 'number') research.stop.maxRounds = s.max_rounds;
        if (typeof s.max_wall_hours === 'number') research.stop.maxWallHours = s.max_wall_hours;
        if (typeof s.halt_after_no_improvement === 'number') research.stop.haltAfterNoImprovement = s.halt_after_no_improvement;
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
  const elapsedMin = ((Date.now() - (state.startedAt ? new Date(state.startedAt).getTime() : Date.now())) / 60000);

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
    const matches = glob ? countGlobMatches(projectDir, glob) : 0;
    if (matches < floor.minAttemptedStages) {
      return { passed: false, reason: `only ${matches} stage verdict file(s) match '${glob}'; need ${floor.minAttemptedStages}` };
    }
    // Stages satisfied → floor passes. Wall time is informational only.
    if (floor.minWallMinutes !== undefined && elapsedMin < floor.minWallMinutes) {
      log.info(
        { minAttemptedStages: floor.minAttemptedStages, matches, elapsedMin: Number(elapsedMin.toFixed(1)), minWallMinutes: floor.minWallMinutes },
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
 * post_terminate_hook. Returns the updated state if it terminated; null
 * otherwise.
 *
 * This is the SINGLE unified terminal-state gate. It is called at exactly two
 * places (consolidated from the prior 5 scattered call sites):
 *   1. Iteration TOP — catches verdicts written by a PRIOR iteration.
 *   2. EAGER post-batch (inside executeIteration) — catches verdicts written
 *      DURING this iteration's stages, BEFORE a later stage's git hygiene can
 *      delete them (bug #8).
 * All other completion paths (gate-passed, allDone, supervisor-DONE) no longer
 * need their own terminal check: the top check + eager check cover every case,
 * and an isTerminalStatus() guard after executeIteration prevents double-fire.
 *
 * Detection accepts the project-dir artifact OR a run-dir snapshot (if the
 * project copy was clobbered). Floor-unmet writes a one-time supervisor hint.
 */
/** Terminal program statuses set by the unified terminal-state gate. Once any
 * of these is set, the run is done and the iteration loop must exit without
 * re-processing (prevents double-firing the post_terminate_hook / ledger). */
function isTerminalStatus(status: string | undefined): boolean {
  return status === 'shipped' || status === 'ceiling_hit' || status === 'escalated' || status === 'phase_complete' || status === 'stopped';
}

/**
 * Single-in-flight enforcement: find another run for the same projectDir that
 * is genuinely active (status='running' AND a live scheduler.pid). Returns its
 * runId, or null. Orphans (status running but dead pid) are ignored so a
 * crashed prior run doesn't block new launches.
 *
 * This prevents the Phase A failure mode: an agent spawned a second run for
 * the same project while the first was still active, causing two concurrent
 * runs to race on shared artifacts. The "single in-flight" invariant was prose
 * in the brief (which the agent's sandbox couldn't verify) — now framework-
 * enforced at run start.
 */
function findActiveSiblingRun(projectDir: string, selfRunId: string): string | null {
  let dirs: string[];
  try { dirs = readdirSync(runsRoot()); } catch { return null; }
  for (const dir of dirs) {
    if (dir === selfRunId) continue;
    try {
      const rs = JSON.parse(readFileSync(join(runsRoot(), dir, 'run.json'), 'utf-8'));
      if (rs.projectDir !== projectDir) continue;
      if (rs.status !== 'running') continue;
      // Check the pid is alive.
      const pidRaw = readFileSync(join(runsRoot(), dir, 'scheduler.pid'), 'utf-8').trim();
      const pid = parseInt(pidRaw, 10);
      if (!Number.isFinite(pid)) continue;
      try {
        process.kill(pid, 0); // process exists
        // Guard against PID reuse: after a crash the OS may recycle the dead
        // scheduler's PID for an unrelated process, which would falsely read as a
        // live sibling and block this project from launching. Confirm it's actually
        // a node/flowcrew process via /proc/<pid>/cmdline (best-effort on Linux).
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
          if (cmdline && !/cli\.js|flowcrew|node/.test(cmdline)) continue; // recycled PID, not us
        } catch { /* /proc unavailable (non-Linux) — trust kill(0) */ }
        return dir;
      } catch { /* dead pid → orphan, ignore */ }
    } catch { /* missing run.json / pid → skip */ }
  }
  return null;
}

async function tryTerminateOnTerminalState(
  state: StoreState,
  ctx: {
    projectDir: string;
    runId: string;
    runDirPath: string;
    iteration: number;
    adapter: Adapter;
  },
): Promise<StoreState | null> {
  if (!state.terminalStates) return null;
  for (const [terminalStatus, entry] of Object.entries(state.terminalStates)) {
    for (const path of entry.paths) {
      // Detect the artifact at its project path, OR — if a prior detection
      // already snapshotted it to the run dir but the project copy was later
      // clobbered (bug #8: agent git hygiene) — fall back to the snapshot so
      // the run-dir copy is the authoritative control-plane source.
      const projPath = join(ctx.projectDir, path);
      const snapPath = join(ctx.runDirPath, `terminal_${path.split('/').pop()}`);
      const sourcePath = existsSync(projPath) ? projPath : (existsSync(snapPath) ? snapPath : null);
      if (!sourcePath) continue;
      const floorCheck = evaluateTerminalFloor(state, entry, ctx.projectDir);
      if (!floorCheck.passed) {
        // Floor unmet — don't terminate. Write a one-time hint to
        // supervisor_guidance.md so the NEXT iteration sees a clear directive,
        // and log loudly so this isn't a silent "run completed without firing
        // hook" mystery (cf. Phase D bug #5, misplaced stage_glob).
        const hintMarker = `[scheduler-hint:${terminalStatus}:${path}]`;
        try {
          const guidancePath = join(ctx.runDirPath, 'supervisor_guidance.md');
          const prior = existsSync(guidancePath) ? readFileSync(guidancePath, 'utf-8') : '';
          if (!prior.includes(hintMarker)) {
            writeFileSync(guidancePath, prior + `\n\n${hintMarker}\n${path} exists but does not meet the floor for terminal status '${terminalStatus}': ${floorCheck.reason}. Continue planned work OR write escalation_note with a clear blocker plus 2-3 candidate options.\n`, 'utf-8');
          }
        } catch { /* non-critical */ }
        log.warn(
          { runId: ctx.runId, terminalStatus, path, reason: floorCheck.reason, stageGlob: entry.stageGlob },
          'Terminal-state file exists but floor unmet — NOT terminating (check stage_glob / floor config)',
        );
        continue;
      }
      state.status = terminalStatus as StoreState['status'];
      state.terminalArtifact = path.split('/').pop();
      state.completedAt = new Date().toISOString();
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
      if (!gate.allowed) return gate.state;
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
      if (state.program && terminalStatus === 'phase_complete') {
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
      return state;
    }
  }
  return null;
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

async function tryAdvanceResearch(
  state: StoreState,
  ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number; adapter: Adapter },
): Promise<StoreState | null> {
  const rc = state.research;
  if (!rc) return null;
  const resultRel = rc.resultFile ?? 'docs/research_round_result.json';
  const resultAbs = join(ctx.projectDir, resultRel);
  if (!existsSync(resultAbs)) return null;
  // Only count a result file freshly written during this run. A result_file
  // left over from a previous run (e.g. on relaunch) would otherwise be
  // journaled as round 1 with ~0 wall time, burning a no-improvement slot
  // before the agent does any new work and forcing a premature ceiling.
  const startedMs = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
  try {
    if (statSync(resultAbs).mtimeMs < startedMs) return null;
  } catch { return null; }
  let round: { label?: string; result?: number };
  try { round = JSON.parse(readFileSync(resultAbs, 'utf-8')); } catch { return null; }
  if (typeof round.result !== 'number') return null;

  // Journal lives in the run dir (framework-owned, agent-unreachable).
  const journalPath = join(ctx.runDirPath, 'research_journal.json');
  let journal: { rounds: ResearchRound[] } = { rounds: [] };
  if (existsSync(journalPath)) {
    try {
      const parsed = JSON.parse(readFileSync(journalPath, 'utf-8'));
      if (parsed && Array.isArray(parsed.rounds)) journal.rounds = parsed.rounds;
    } catch { /* reset on corruption */ }
  }
  const label = (typeof round.label === 'string' && round.label) ? round.label : `round_${journal.rounds.length + 1}`;
  // Dedupe: skip if this exact (label,result) was already journaled.
  if (journal.rounds.some((r) => r.label === label && r.result === round.result)) return null;

  // Integrity gates — reject rounds that look like cheats / noise / overflow
  // before they pollute the journal. Each gate can reject; on rejection we
  // write a guidance note and a continue signal so the agent gets another try
  // (up to maxRounds total rejections → ceiling).
  //
  // Gates evaluated in order:
  //   #1 no-op (result == baseline)            — original gate
  //   #2 robustness (result_std/mean too high) — exposes lucky-seed overfit
  //   #3 stress crashed (stress_min_nv < 50%)  — would be liquidated on CEX
  //   #4 liquidation reported (liq_total > 0)
  //   #5 outlier (result > baseline × 5)        — too-good-to-be-true cap
  //
  // Each gate is "soft": if the relevant field is absent on round_result.json
  // the gate doesn't fire (backwards compatible with legacy briefs).
  const rejectGate = async (reason: string, message: string): Promise<StoreState | null> => {
    const rejPath = join(ctx.runDirPath, 'research_integrity_rejections.json');
    let rejData: Record<string, number> = {};
    if (existsSync(rejPath)) { try { rejData = JSON.parse(readFileSync(rejPath, 'utf-8')); } catch { /* reset */ } }
    rejData[reason] = (rejData[reason] || 0) + 1;
    const totalRej = Object.values(rejData).reduce((s, n) => s + (n || 0), 0);
    try { writeFileSync(rejPath, JSON.stringify(rejData, null, 2), 'utf-8'); } catch { /* non-critical */ }
    try { unlinkSync(resultAbs); } catch { /* non-critical */ }
    try {
      const guidancePath = join(ctx.runDirPath, 'supervisor_guidance.md');
      const marker = `[research-integrity:${reason}:${label}=${round.result}]`;
      const prior = existsSync(guidancePath) ? readFileSync(guidancePath, 'utf-8') : '';
      if (!prior.includes(marker)) {
        writeFileSync(guidancePath, prior + `\n\n${marker}\n${message}\n`, 'utf-8');
      }
    } catch { /* non-critical */ }
    log.warn({ runId: ctx.runId, reason, label, result: round.result, total_rejections: totalRej }, 'Research round rejected by integrity gate');
    // Integrity-rejection budget is SEPARATE from the research round budget
    // (rc.stop.maxRounds): a run shouldn't hit "ceiling" at the same count as
    // legitimate journaled rounds just because some results tripped a gate — that
    // would let a run terminate "by being right". Use a dedicated, independent cap.
    const maxRej = Math.max(rc.stop?.maxRounds ?? 24, INTEGRITY_REJECTION_CEILING);
    if (totalRej >= maxRej) {
      state.status = 'ceiling_hit';
      state.completedAt = new Date().toISOString();
      const gate = await enforceRealityGateBeforeTerminal(ctx.projectDir, ctx.runId, state, state.status);
      if (!gate.allowed) return gate.state;
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

  // Gate #1: no-op (result == baseline)
  const noopEps = Math.max(1e-4, Math.abs(rc.baseline) * 1e-5);
  if (Math.abs(round.result - rc.baseline) <= noopEps) {
    return rejectGate('noop',
      `Rejected '${label}' = ${round.result}: equals baseline (${rc.baseline}) within tolerance — strategy changed NO positions (no-op/proxy). Implement a direction that genuinely alters positions and re-measure.`);
  }

  // Gate #2: robustness (multi-seed std / mean too high → lucky-seed overfit)
  const stdField = (round as { result_std?: number }).result_std;
  const meanReference = round.result;  // round.result IS the mean by convention
  if (typeof stdField === 'number' && Math.abs(meanReference) > 1e-6) {
    const stdRatio = Math.abs(stdField) / Math.abs(meanReference);
    if (stdRatio > 0.30) {
      const r = await rejectGate('unstable_seeds',
        `Rejected '${label}' = ${round.result}: result_std/mean = ${stdRatio.toFixed(2)} > 0.30 — extreme cross-seed variance indicates lucky-seed overfit, not robust alpha. Train deeper or report variance reduction techniques; do not pretend a high-variance result is the true mean.`);
      if (r) return r; else return null;
    }
  }

  // Gate #3: any stress window NV crashed below initial × 0.5 → would be liquidated
  const stressMinNV = (round as { stress_min_nv?: number }).stress_min_nv;
  if (typeof stressMinNV === 'number' && stressMinNV < 50.0) {
    const r = await rejectGate('stress_crashed',
      `Rejected '${label}' = ${round.result}: stress_min_nv = ${stressMinNV} < 50 — at least one stress window crashes NV below 50% of initial, which would trigger CEX maintenance-margin liquidation in production. The reward layer's per-tick liquidation check is not enough; cumulative NV crash must also be < 50% loss.`);
    if (r) return r; else return null;
  }

  // Gate #4: explicit liquidation_total > 0
  const liqTotal = (round as { liquidation_total?: number }).liquidation_total;
  if (typeof liqTotal === 'number' && liqTotal > 0) {
    const r = await rejectGate('liquidation_event',
      `Rejected '${label}' = ${round.result}: liquidation_total = ${liqTotal} > 0 — at least one stress/OOS window had a liquidation event. Brief mandates 0 liquidations across all windows.`);
    if (r) return r; else return null;
  }

  // Gate #5: outlier ("too-good-to-be-true" cap). Two correctness guards over the
  // old `Math.abs(result) > Math.abs(baseline) * 5`:
  //   (a) baseline ≈ 0 → a relative ceiling is undefined and the old form rejected
  //       EVERY non-zero result (→ instant ceiling). Skip the gate.
  //   (b) DIRECTIONAL — only an implausible improvement is suspicious. A big LOSS
  //       (huge magnitude in the worse direction) is a VALID, informative result,
  //       not an outlier to suppress. Respect higher_is_better.
  const baseAbs = Math.abs(rc.baseline);
  const higherIsBetter = rc.higherIsBetter !== false;
  const tooGood = higherIsBetter ? round.result > baseAbs * 5 : round.result < -(baseAbs * 5);
  if (baseAbs > 1e-9 && tooGood) {
    const r = await rejectGate('outlier_too_high',
      `Rejected '${label}' = ${round.result}: implausibly far beyond 5× baseline (${rc.baseline}) in the improving direction — likely numerical explosion, oracle leakage, lucky-seed overfit, or a units/compounding bug. Verify the calculation and reproduce before trusting.`);
    if (r) return r; else return null;
  }

  journal.rounds.push({ label, result: round.result, wallHoursCumulative: (Date.now() - startedMs) / 3600000 });
  try { writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }

  const evalResult = evaluateResearch(rc, journal.rounds);
  try { writeFileSync(join(ctx.runDirPath, 'research_decision.json'), JSON.stringify(evalResult, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }

  // Consume the round result so the next iteration doesn't re-process it.
  try { renameSync(resultAbs, join(ctx.runDirPath, `research_round_${journal.rounds.length}_consumed.json`)); } catch { /* non-critical */ }

  log.info({ runId: ctx.runId, iteration: ctx.iteration, label, result: round.result, runningBest: evalResult.runningBest, decision: evalResult.decision }, 'Research round evaluated');

  if (evalResult.decision === 'continue') {
    // Steer the next iteration: tell the agent the running-best + kept set and
    // ask for the next direction. Idempotent marker per round.
    const marker = `[research-advance:round-${journal.rounds.length}]`;
    try {
      const guidancePath = join(ctx.runDirPath, 'supervisor_guidance.md');
      const prior = existsSync(guidancePath) ? readFileSync(guidancePath, 'utf-8') : '';
      if (!prior.includes(marker)) {
        writeFileSync(guidancePath, prior + `\n\n${marker}\nResearch round '${label}' = ${round.result} (running-best ${evalResult.runningBest}, kept: ${evalResult.keptLabels.join(', ') || 'none'}). Decision: CONTINUE. Propose and test the NEXT distinct direction on top of the kept stack, then write its result to ${resultRel}.\n`, 'utf-8');
      }
    } catch { /* non-critical */ }
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
  state.status = evalResult.decision === 'ship' ? 'shipped' : 'ceiling_hit';
  state.completedAt = new Date().toISOString();
  const gate = await enforceRealityGateBeforeTerminal(ctx.projectDir, ctx.runId, state, state.status);
  if (!gate.allowed) return gate.state;
  writeRunState(ctx.projectDir, ctx.runId, state);
  writeCampaignEntry(ctx.projectDir, state);
  recordRunEvent(ctx.projectDir, ctx.runId, {
    type: 'run_completed',
    runId: ctx.runId,
    timestamp: state.completedAt,
    iteration: ctx.iteration,
    detail: `Research ${evalResult.decision}: ${evalResult.reason}`,
  });
  // Write a program report (framework-owned location, in project for visibility).
  try {
    const reportDir = join(ctx.projectDir, rc.reportDir ?? 'docs');
    mkdirSync(reportDir, { recursive: true });
    const reportName = evalResult.decision === 'ship' ? 'program_ship_report.md' : 'program_ceiling_report.md';
    const body = `# Research ${evalResult.decision === 'ship' ? 'Ship' : 'Ceiling'} Report\n\n`
      + `Decision: ${evalResult.decision}\n`
      + `Running-best: ${evalResult.runningBest}\n`
      + `Baseline: ${rc.baseline}\n`
      + `Kept directions: ${evalResult.keptLabels.join(', ') || 'none'}\n`
      + `Reason: ${evalResult.reason}\n\n`
      + `## Rounds\n` + journal.rounds.map((r) => `- ${r.label}: ${r.result}`).join('\n') + '\n';
    writeFileSync(join(reportDir, reportName), body, 'utf-8');
  } catch { /* non-critical */ }
  log.info({ runId: ctx.runId, decision: evalResult.decision, runningBest: evalResult.runningBest }, 'Research loop terminated');
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

function countGlobMatches(projectDir: string, glob: string): number {
  const slash = glob.lastIndexOf('/');
  const dir = slash >= 0 ? glob.substring(0, slash) : '.';
  const pattern = slash >= 0 ? glob.substring(slash + 1) : glob;
  // Convert simple `*` glob to anchored regex (escape dots, expand stars)
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  try {
    const fullDir = join(projectDir, dir);
    if (!existsSync(fullDir)) return 0;
    return readdirSync(fullDir).filter((f) => {
      if (!re.test(f)) return false;
      // Realness filter: ignore empty/stub files so the floor reflects
      // substantive stage work, not placeholder touches.
      try { return statSync(join(fullDir, f)).size >= MIN_STAGE_VERDICT_BYTES; } catch { return false; }
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Build the retry preamble injected before the resolved prompt on attempt >= 2.
 * Distinguishes supervisor-abort failures from true wall-clock timeouts by
 * reading the previous attempt's status.error string written by worker.ts.
 */
function buildRetryPreamble(retries: number, timeoutMs: number, runDirPath: string, stageId: string): string {
  const partialPath = `${runDirPath}/stages/${stageId}/output.md`;
  let prevError: string | undefined;
  try {
    const statusRaw = readFileSync(join(runDirPath, 'stages', stageId, 'status.json'), 'utf-8');
    const status = JSON.parse(statusRaw) as { error?: string };
    prevError = status.error;
  } catch { /* status not readable; fall through to generic message */ }
  let cause: string;
  if (prevError && prevError.startsWith('aborted by supervisor')) {
    cause = `Previous attempt was ${prevError}. The supervisor judged that the previous attempt was stuck or off-direction. Use this signal: re-read the goal, identify what concrete progress you should produce in this attempt, and START making file edits within a few minutes; do NOT spend the whole attempt only inspecting code.`;
  } else if (prevError && prevError.startsWith('adapter connection failed')) {
    cause = `Previous attempt failed with an adapter connection error (transient). Retry the same plan.`;
  } else {
    cause = `Previous attempt timed out after ${Math.ceil(timeoutMs / 1000)}s.`;
  }
  return `RETRY (attempt ${retries + 1}): ${cause} Read partial output at ${partialPath} and continue from where you left off. Do not start over.`;
}

/** Load project defaults, creating config/defaults.yaml from FlowCrew's template if absent. */
function loadDefaults(projectDir?: string) {
  return loadProjectDefaults(projectDir);
}

const AgentConfigSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  model: z.string().default('default'),
  reasoning_effort: z.string().default('default'),
  tools: z.array(z.string()).default([]),
  prompt: z.string(),
  adapter: z.string().optional(),
});

const ADAPTER_MODULE_MAP: Record<string, string> = {
  codex: './adapters/codex.js',
  claude: './adapters/claude.js',
};

const _adapterCache = new Map<string, Adapter>();
export async function loadAdapterByName(name: string): Promise<Adapter> {
  const cached = _adapterCache.get(name);
  if (cached) return cached;
  const modPath = ADAPTER_MODULE_MAP[name];
  if (!modPath) throw new Error(`Unknown adapter "${name}". Known: ${Object.keys(ADAPTER_MODULE_MAP).join(', ')}`);
  const mod = await import(modPath);
  const a = mod.createAdapter() as Adapter;
  _adapterCache.set(name, a);
  return a;
}

function parseAgent(raw: unknown, projectDir?: string): AgentConfig {
  const agent = AgentConfigSchema.parse(raw);
  if (agent.model === 'default') agent.model = loadDefaults(projectDir).model;
  if (agent.reasoning_effort === 'default') agent.reasoning_effort = loadDefaults(projectDir).reasoning_effort;
  return agent;
}

export const StageConfigSchema = z.object({
  id: z.string(),
  role: z.string(),
  depends_on: z.array(z.string()).optional().default([]),
  condition: z.string().optional(),
  prompt_template: z.string().optional().default(''),
  timeout_ms: z.number().optional(),
  max_retries: z.number().optional(),
  skills: z.array(z.string()).optional().default([]),
  dynamic_dispatch: z.boolean().optional().default(false),
  is_gate: z.boolean().optional().default(false),
  retry_to: z.array(z.string()).optional(),
});

export const WorkflowConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional().default(''),
  defaults: z.object({
    timeout_ms: z.number().optional(),
    max_retries: z.number().optional(),
    max_iterations: z.number().optional(),
  }).optional().default({}),
  stages: z.array(StageConfigSchema).min(1),
});

export type StageConfig = z.infer<typeof StageConfigSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

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

function isTerminalStudyCompletionArtifact(record: Record<string, unknown>, gateId?: string): boolean {
  if (gateId && gateId !== 'btc_transfer_multiphase_gate') return false;
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
  for (const s of stages) {
    const ss = state.stages[s.id];
    if (!ss || ss.status !== 'pending') continue;
    const depsReady = (s.depends_on ?? []).every((d) => {
      const ds = state.stages[d];
      return ds && (ds.status === 'complete' || ds.status === 'skipped');
    });
    if (depsReady) ready.push(s);
  }
  return ready;
}

function allDone(state: StoreState): boolean {
  return Object.values(state.stages).every(
    (s) => s.status === 'complete' || s.status === 'skipped',
  );
}

function appendGateMetricInstruction(prompt: string, runDirPath: string, stageId: string): string {
  const metricPath = join(runDirPath, 'stages', stageId, 'metric.json');
  return `${prompt}

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
  return Object.values(state.stages).some((s) => s.status === 'failed');
}

export function loadWorkflow(yamlPath: string): { config: WorkflowConfig; raw: string } {
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw);
  const config = WorkflowConfigSchema.parse(parsed);
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

/** List available skill names from config/skills/ directory */
function listAvailableSkills(projectDir: string): string {
  const skillsDir = join(projectDir, 'config', 'skills');
  try {
    const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return 'none';
    return files.map(f => f.replace('.md', '')).join(', ');
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
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;
    if (!item.id) item.id = `dispatch_${i}`;
    if (seenIds.has(item.id)) {
      log.warn({ id: item.id }, 'Duplicate stage ID in DISPATCH block, skipping');
      continue;
    }
    if (!roleRegistry.has(item.role)) {
      log.warn({ role: item.role, id: item.id }, 'Unknown role in DISPATCH block, skipping');
      continue;
    }
    try {
      // Bug 2: map task: to prompt_template: if planner used that format
      if (item.task && !item.prompt_template) {
        item.prompt_template = item.task;
        delete item.task;
      }
      stages.push(StageConfigSchema.parse(item));
      seenIds.add(item.id);
    } catch { /* non-critical */
      log.warn({ id: item.id }, 'Invalid stage in DISPATCH block, skipping');
    }
  }
  return stages;
}

export function resolveDispatchDependencies(dispatched: StageConfig[], dispatchStageId: string): void {
  const plannedDependents = new Set(
    dispatched.filter((s) => s.depends_on.includes('__planned__')).map((s) => s.id),
  );
  const nonPlannedIds = dispatched.filter((s) => !plannedDependents.has(s.id)).map((s) => s.id);

  for (const s of dispatched) {
    if (s.depends_on.length === 0) {
      s.depends_on = [dispatchStageId];
    }
    if (s.depends_on.includes('__planned__')) {
      s.depends_on = [...new Set(s.depends_on.filter((d) => d !== '__planned__').concat(nonPlannedIds))];
      if (s.depends_on.length === 0) s.depends_on = [dispatchStageId];
    }
  }
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
    if (!item || typeof item !== 'object') continue;
    if (!item.id) item.id = `dispatch_${i}`;
    if (seenIds.has(item.id as string)) {
      skippedReasons.push(`${item.id}: duplicate stage ID`);
      log.warn({ id: item.id }, 'Duplicate stage ID in dispatch.yaml, skipping');
      continue;
    }
    if (!roleRegistry.has(item.role as string)) {
      skippedReasons.push(`${item.id}: unknown role "${item.role}"`);
      log.warn({ role: item.role, id: item.id }, 'Unknown role in dispatch.yaml, skipping');
      continue;
    }
    // Map task: to prompt_template:
    if (item.task && !item.prompt_template) {
      item.prompt_template = item.task;
      delete item.task;
    }
    try {
      dispatched.push(StageConfigSchema.parse(item));
      seenIds.add(item.id as string);
    } catch (e) {
      skippedReasons.push(`${item.id}: invalid schema`);
      log.warn({ id: item.id }, 'Invalid stage in dispatch.yaml, skipping');
    }
  }
  if (dispatched.length === 0) {
    if (skippedReasons.length > 0) {
      log.warn({ skippedReasons }, 'All stages in dispatch.yaml were invalid');
    }
    return [];
  }

  resolveDispatchDependencies(dispatched, dispatchStageId);

  // Validate dependencies: remove references to non-existent stages and self-references to prevent hangs
  const allKnownIds = new Set([...sorted.map(s => s.id), ...dispatched.map(s => s.id)]);
  for (const s of dispatched) {
    const invalid = s.depends_on.filter(d => !allKnownIds.has(d) || d === s.id);
    if (invalid.length > 0) {
      log.warn({ stage: s.id, invalidDeps: invalid }, 'Removing invalid depends_on references');
      s.depends_on = s.depends_on.filter(d => allKnownIds.has(d) && d !== s.id);
      if (s.depends_on.length === 0) s.depends_on = [dispatchStageId];
    }
    // Validate retry_to references
    if (s.retry_to && s.retry_to.length > 0) {
      // Gate stages must not also be retry targets — strip retry_to to prevent confusing behavior
      if (s.is_gate) {
        log.warn({ stage: s.id }, 'Gate stage has retry_to — stripping retry_to (gates evaluate, fix stages retry)');
        s.retry_to = undefined;
      } else {
        const invalidRetry = s.retry_to.filter(r => !allKnownIds.has(r));
        if (invalidRetry.length > 0) {
          log.warn({ stage: s.id, invalidRetryTo: invalidRetry }, 'Removing invalid retry_to references');
          s.retry_to = s.retry_to.filter(r => allKnownIds.has(r));
          if (s.retry_to.length === 0) s.retry_to = undefined;
        }
        // Auto-add gate IDs to depends_on so retry_to stages wait for the gate
        if (s.retry_to) {
          const missing = s.retry_to.filter(g => !s.depends_on.includes(g));
          if (missing.length > 0) {
            log.info({ stage: s.id, addedDeps: missing }, 'Auto-adding gate IDs to depends_on for retry_to stage');
            s.depends_on = [...new Set([...s.depends_on, ...missing])];
          }
        }
      }
    }
  }

  // Cycle detection among dispatched stages to prevent hangs
  {
    const dispatchedIds = new Set(dispatched.map(s => s.id));
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const stage = dispatched.find(s => s.id === id);
      if (stage) {
        for (const dep of stage.depends_on) {
          if (dispatchedIds.has(dep) && hasCycle(dep)) return true;
        }
      }
      inStack.delete(id);
      return false;
    };
    for (const s of dispatched) {
      if (hasCycle(s.id)) {
        log.warn({ stage: s.id }, 'Cycle detected in dispatched stages — breaking cycle by resetting depends_on to dispatch stage');
        s.depends_on = [dispatchStageId];
      }
    }
  }

  // Create stage directories and add to state (preserve existing status for reruns)
  let isReinjection = false;
  for (const s of dispatched) {
    mkdirSync(stageDir(projectDir, runId, s.id), { recursive: true });
    if (state.stages[s.id]) {
      isReinjection = true;
    } else {
      state.stages[s.id] = { status: 'pending', retries: 0 };
    }
  }

  // Mark static stages that transitively depend on dispatch stage as skipped
  const transitive = collectTransitiveDependents(dispatchStageId, sorted);
  for (const id of transitive) {
    if (state.stages[id]?.status === 'pending') {
      state.stages[id] = { status: 'skipped', retries: 0 };
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
    for (const s of dispatched) wfParsed.stages.push({ id: s.id, role: s.role, depends_on: s.depends_on, prompt_template: s.prompt_template, is_gate: s.is_gate || undefined, retry_to: s.retry_to?.length ? s.retry_to : undefined });
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
    || reason !== undefined
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

function validateVerdictAgainstMetricFile(
  verdict: Record<string, unknown>,
  metric: Record<string, unknown>,
): string | null {
  if (metric.pass === false && verdict.pass === true) {
    if (metric.phaseComplete === true || metric.phase_complete === true || metric.nextPhase || metric.next_phase) return null;
    return 'verdict/metric.json mismatch: metric says fail, verdict says pass';
  }
  if (typeof metric.metric === 'string' && typeof verdict.metric === 'string' && !metricNamesMatch(metric.metric, verdict.metric)) {
    return 'metric name redefined';
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
  const candidateValues: unknown[] = [verdict.value, verdict.score, metric?.value, metric?.score];
  const value = candidateValues.find(v => typeof v === 'number') as number | undefined;
  if (typeof value !== 'number') {
    return `no numeric value found in verdict or metric.json. Cannot mechanically verify gate. Contract requires value compared against threshold=${contract.threshold}.`;
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
      if (isTerminalStudyCompletionArtifact(parsed, stageId)) return parsed;
    } catch { /* optional */ }
  }
  return null;
}

function writeTerminalStudyCompletionArtifacts(projectDir: string, runId: string, stageId: string, evidence: Record<string, unknown>): void {
  const base = runDir(projectDir, runId);
  mkdirSync(stageDir(projectDir, runId, stageId), { recursive: true });
  writeFileSync(join(base, `verdict_${stageId}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf-8');
  const value = typeof evidence.value === 'number'
    ? evidence.value
    : typeof evidence.net_2024_evaluation === 'number'
      ? evidence.net_2024_evaluation
      : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    writeFileSync(join(stageDir(projectDir, runId, stageId), 'metric.json'), JSON.stringify({
      hasMetric: true,
      metric: typeof evidence.metric === 'string' ? evidence.metric : 'BTCTransferRobustScore',
      value,
      higherIsBetter: true,
      threshold: typeof evidence.threshold === 'number' ? evidence.threshold : null,
      pass: false,
      source: {
        path: typeof evidence.final_candidate_artifact === 'string'
          ? evidence.final_candidate_artifact
          : join(base, `pre_gate_verdict_${stageId}.json`),
        evidence: [
          typeof evidence.net_2024_evaluation === 'number' ? `net_2024_evaluation=${evidence.net_2024_evaluation}` : null,
          typeof evidence.net_2025_evaluation === 'number' ? `net_2025_evaluation=${evidence.net_2025_evaluation}` : null,
        ].filter(Boolean).join(', ') || `value=${value}`,
      },
      notes: 'Recovered from terminal study completion evidence.',
    }, null, 2) + '\n', 'utf-8');
  }
}

/** Read verdict for a specific gate stage from run dir verdict_<stageId>.json, falling back to verdict.json */
export function readGateVerdict(
  projectDir: string,
  stageId: string,
  runId?: string,
  contract?: GateContract | null,
): { pass: boolean; reason?: string } | null {
  const base = runId ? runDir(projectDir, runId) : join(projectDir, 'docs');
  let v: Record<string, unknown> | null = null;
  const perGate = join(base, `verdict_${stageId}.json`);
  try {
    const parsed = JSON.parse(readFileSync(perGate, 'utf-8'));
    if (typeof parsed.pass === 'boolean') v = parsed;
  } catch { /* not found */ }
  if (!v) {
    const shared = join(base, 'verdict.json');
    try {
      const parsed = JSON.parse(readFileSync(shared, 'utf-8'));
      if (typeof parsed.pass === 'boolean') v = parsed;
    } catch { /* not found */ }
  }
  if (!v && runId) {
    const terminalEvidence = readTerminalStudyCompletionEvidence(projectDir, runId, stageId);
    if (terminalEvidence) {
      writeTerminalStudyCompletionArtifacts(projectDir, runId, stageId, terminalEvidence);
      return { pass: true, reason: 'study_complete_without_model_success' };
    }
  }
  if (!v) return null;
  if (runId && isTerminalStudyCompletionArtifact(v, stageId)) {
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

/** Check all is_gate stages. Returns { allPass, failedGateIds } */
export function checkGates(allStages: StageConfig[], state: StoreState, projectDir: string, runId?: string): { allPass: boolean; failedGateIds: string[] } {
  const seenGateIds = new Set<string>();
  const gateStages = allStages.filter((s) => {
    if (!s.is_gate || seenGateIds.has(s.id)) return false;
    seenGateIds.add(s.id);
    return true;
  });
  if (gateStages.length === 0) return { allPass: true, failedGateIds: [] };
  // Load the campaign gate contract once per check; reused across all gates.
  const contract = loadGateContract(projectDir, runId, state.campaignStorageKey);
  const failedGateIds: string[] = [];
  for (const g of gateStages) {
    const gateStatus = state.stages[g.id]?.status;
    // A gate only passes after it completed and wrote an explicit pass verdict.
    // Pending/running/skipped/missing gates must block run completion.
    if (gateStatus !== 'complete') {
      failedGateIds.push(g.id);
      continue;
    }
    const verdict = readGateVerdict(projectDir, g.id, runId, contract);
    if (verdict && verdict.pass === true) continue; // explicit pass (contract-honored if any)
    // Missing verdict or explicit fail → treat as failure
    failedGateIds.push(g.id);
  }
  return { allPass: failedGateIds.length === 0, failedGateIds };
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
    if (ss.status === 'skipped') return true;
    return ss.status === 'complete' && (ss.exitCode === undefined || ss.exitCode === 0);
  });
}

export function shouldContinuePhaseAfterGatePass(projectDir: string, state: StoreState): boolean {
  const phase = findCampaignPhaseMetadata(projectDir, state);
  if (!phase) return false;
  if (phase.phaseComplete === false) return true;
  const nextPhase = phase.nextPhase?.trim().toLowerCase();
  return phase.phaseComplete === true && Boolean(nextPhase && nextPhase !== 'complete');
}

export function recoverTerminalStudyCompletion(projectDir: string, runId: string, state: StoreState): StoreState | null {
  const gateIds = orderedGateIdsForState(projectDir, state);
  for (const gateId of gateIds) {
    const evidence = readTerminalStudyCompletionEvidence(projectDir, runId, gateId);
    if (!evidence) continue;
    writeTerminalStudyCompletionArtifacts(projectDir, runId, gateId, evidence);
    const next: StoreState = {
      ...state,
      status: 'complete',
      completedAt: state.completedAt ?? new Date().toISOString(),
      campaignAlert: undefined,
      researchInjection: undefined,
      stages: { ...state.stages },
    };
    next.stages[gateId] = { ...(next.stages[gateId] ?? { retries: 0 }), status: 'complete', retries: next.stages[gateId]?.retries ?? 0 };
    for (const stage of (state.dispatchedStages ?? []) as StageConfig[]) {
      if (stage.retry_to?.includes(gateId) && next.stages[stage.id]) {
        next.stages[stage.id] = { ...next.stages[stage.id], status: 'skipped' };
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
): Promise<StoreState> {
  const baseStages = topoSort(workflow.stages);
  const stageIds = baseStages.map((s) => s.id);
  let maxIterations = workflow.defaults.max_iterations ?? loadDefaults(projectDir).max_iterations;

  let runId: string;
  let runDirPath: string;
  if (existingRunId) {
    runId = existingRunId;
    runDirPath = runDir(projectDir, runId);
    mkdirSync(join(runDirPath, 'stages'), { recursive: true });
    for (const s of baseStages) {
      mkdirSync(join(runDirPath, 'stages', s.id), { recursive: true });
    }
    const state = readRunState(projectDir, runId);
    maxIterations = state.maxIterations ?? maxIterations;
    for (const s of baseStages) {
      if (!state.stages[s.id]) state.stages[s.id] = { status: 'pending', retries: 0 };
    }
    state.status = 'running';
    state.workflowName = workflow.name;
    state.maxIterations = maxIterations;
    state.timeoutMs = workflow.defaults.timeout_ms ?? loadDefaults(projectDir).timeout_ms;
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
  } else {
    const created = createRun(projectDir, workflow.name, workflowYaml, stageIds);
    runId = created.runId;
    runDirPath = created.runDirPath;
    const state = readRunState(projectDir, runId);
    state.maxIterations = maxIterations;
    state.currentIteration = 1;
    state.timeoutMs = workflow.defaults.timeout_ms ?? loadDefaults(projectDir).timeout_ms;
    writeRunState(projectDir, runId, state);
  }

  log.info({ runId, workflow: workflow.name }, 'Run started');

  if (taskDescription || autoApprove || supervise || campaignId) {
    const initState = readRunState(projectDir, runId);
    if (taskDescription) {
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
  if (existsSync(briefPath)) {
    const briefContent = readFileSync(briefPath, 'utf-8').trim();
    if (briefContent) {
      const { terminalStates, program, research, stripped } = parseBriefFrontmatter(briefContent);
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
      if (isResearchWorkflow && !research) {
        log.warn({ runId }, 'workflow=research but brief has no `research:` block — research loop needs baseline+policy; falling back to plain dispatch');
      } else if (research && !isResearchWorkflow) {
        log.warn({ runId, workflow: workflow.name }, 'brief has a `research:` block but workflow is not `research` — research advance gate still active, but consider --workflow research for clarity');
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

  // Single-in-flight enforcement: refuse to start if another run for this same
  // project is genuinely active (prevents the Phase A concurrent-run race).
  {
    const sibling = findActiveSiblingRun(projectDir, runId);
    if (sibling) {
      const s = readRunState(projectDir, runId);
      s.status = 'failed';
      s.failureReason = `Single-in-flight: another active run (${sibling}) exists for this project. Stop it first or wait for it to finish.`;
      s.completedAt = new Date().toISOString();
      writeRunState(projectDir, runId, s);
      log.error({ runId, sibling, projectDir }, 'Refusing to start: another active run exists for this project');
      return s;
    }
  }

  // Write scheduler.pid so the dashboard's startup-recovery sweep can tell whether
  // this run is genuinely alive (vs orphaned in run.json after a dashboard restart).
  // Removed in the finally block so re-spawned schedulers don't see stale pids.
  const schedulerPidPath = join(runDirPath, 'scheduler.pid');
  try { writeFileSync(schedulerPidPath, String(process.pid), 'utf-8'); } catch { /* non-critical */ }

  // Supervisor brain: start before the iteration loop if enabled, stop in finally.
  let supervisor: Supervisor | undefined;
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

  try {
  // Iteration loop
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let state = readRunState(projectDir, runId);

    // Exit if run was cancelled externally or already terminated
    if (isTerminalRunStatus(state.status)) {
      return state;
    }

    // [Unified terminal gate, call site 1 of 2] Catch a terminal artifact
    // written by a PRIOR iteration (or present at start). Takes precedence
    // over supervisor-DONE below. Floor-unmet writes a hint and falls through.
    const terminatedTop = await tryTerminateOnTerminalState(state, { projectDir, runId, runDirPath, iteration, adapter });
    if (terminatedTop) return terminatedTop;

    // [Research advance gate, call site 1 of 2] If research mode, consume any
    // round result written by a prior iteration, journal+evaluate, and either
    // terminate (ship/ceiling) or steer the next round.
    const researchTop = await tryAdvanceResearch(state, { projectDir, runId, runDirPath, iteration, adapter });
    if (researchTop) return researchTop;

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

    // (Terminal-state detection consolidated to the unified gate at the top of
    // this iteration loop + the eager post-batch check inside executeIteration.
    // The previous inline duplicate here was removed.)

    // Bug ② fix: archive the previous iteration's accumulated supervisor
    // guidance so this iteration starts with an empty `supervisor_guidance.md`.
    // The archived file under `guidance_history/iter_${N-1}.md` is later
    // injected into the planner's system prompt by worker.ts, so prior-iter
    // GUIDE messages still impact this iteration's plan — but they no longer
    // mix with this iteration's fresh GUIDE messages in the same file.
    if (iteration > 1) {
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
        try {
          appendFileSync(
            join(runDir(projectDir, runId), 'supervisor_guidance.md'),
            `⚠️ PIVOT REQUIRED (supervisor REPLAN): ${replanReason}\nThe previous approach was judged fundamentally wrong. Plan a materially DIFFERENT approach; do not repeat the rejected direction.\n`,
            'utf-8',
          );
        } catch { /* non-critical */ }
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

    // Delete dispatch.yaml before plan stage runs only on re-plan (iteration > 1)
    const dispatchPathPre = join(runDirPath, 'dispatch.yaml');
    if (iteration > 1 && existsSync(dispatchPathPre)) unlinkSync(dispatchPathPre);

    // Reset all base stages to pending for this iteration
    state = readRunState(projectDir, runId);
    // On iteration 2+, reset base stage statuses and clear old dispatched stages
    if (iteration > 1) {
      // Remove old dispatched stage entries from state
      const baseIds = new Set(baseStages.map(s => s.id));
      for (const sid of Object.keys(state.stages)) {
        if (!baseIds.has(sid)) delete state.stages[sid];
      }
      for (const s of baseStages) {
        state.stages[s.id] = { status: 'pending', retries: 0 };
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
      resolvedAgentsDir, roleRegistry, injectedDispatchStages, skills, taskDescription, availableSkillsList,
    );

    state = readRunState(projectDir, runId);

    // If the eager post-batch gate inside executeIteration already terminated
    // the run (set a terminal status + fired the hook), exit now — do NOT fall
    // through to the gate/allDone exits below, which would re-fire the hook.
    if (isTerminalStatus(state.status)) return state;

    const recoveredTerminal = recoverTerminalStudyCompletion(projectDir, runId, state);
    if (recoveredTerminal) {
      writeRunState(projectDir, runId, recoveredTerminal);
      writeCampaignEntry(projectDir, recoveredTerminal);
      return recoveredTerminal;
    }

    // Research mode: if the advance gate processed a round and decided
    // CONTINUE (signal present), loop to the next round. Iteration 2+ resets
    // the dynamic-dispatch plan stage, so the planner re-runs and the agent
    // proposes/tests the next direction. Consume the signal so a stuck round
    // that produces no new result can't loop forever (it'll fall through to
    // completion next time).
    if (state.research && iteration < maxIterations) {
      const contSignal = join(runDir(projectDir, runId), 'signals', 'research_continue.json');
      if (existsSync(contSignal)) {
        try { unlinkSync(contSignal); } catch { /* non-critical */ }
        log.info({ runId, iteration }, 'Research advance decided CONTINUE — re-planning next round');
        continue;
      }
    }

    // Collect dispatched stage IDs (only from stages in the current sorted pipeline, not orphans)
    const baseIds = new Set(baseStages.map(s => s.id));
    iterationDispatchedIds = sorted
      .filter(s => !baseIds.has(s.id))
      .map(s => s.id);

    // === INNER LOOP (retry_to) ===
    const maxInnerRetries = Math.max(0, Math.floor(Number(state.maxRetries ?? loadDefaults(projectDir).gate_retry_loops)));
    let innerRetriesUsed = 0;
    if (iterationDispatchedIds.length > 0) {
      const { allPass, failedGateIds } = checkGates(sorted, state, projectDir, runId);
      if (!allPass) {
        const retryStages = findAllRetryToStages(sorted, failedGateIds);
        if (retryStages.length > 0) {
          for (let inner = 0; inner < maxInnerRetries; inner++) {

            // Check for cancellation between retries
            state = readRunState(projectDir, runId);
            if (isTerminalRunStatus(state.status)) break;

            // Determine which retry stages need to run based on current failed gates
            const currentCheck = inner === 0
              ? { allPass: failedGateIds.length === 0, failedGateIds }
              : checkGates(sorted, state, projectDir, runId);
            const currentFailedGateIds = inner === 0 ? failedGateIds : currentCheck.failedGateIds;
            if (inner > 0 && currentCheck.allPass) break;

            const activeRetryStages = findAllRetryToStages(sorted, currentFailedGateIds);
            if (activeRetryStages.length === 0) break;

            // Clear verdict and metric files for all gates referenced by active retry stages
            for (const retryStage of activeRetryStages) {
              for (const gid of retryStage.retry_to!) {
                const perGate = join(runDirPath, `verdict_${gid}.json`);
                if (existsSync(perGate)) unlinkSync(perGate);
                const gateMetric = join(runDirPath, 'stages', gid, 'metric.json');
                if (existsSync(gateMetric)) unlinkSync(gateMetric);
              }
            }
            const sharedVerdict = join(runDirPath, 'verdict.json');
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Reset and run all active retry stages (possibly in parallel)
            for (const retryStage of activeRetryStages) {
              state.stages[retryStage.id] = { status: 'pending', retries: 0 };
              mkdirSync(join(runDirPath, 'stages', retryStage.id), { recursive: true });
              // Clear live.log so the SSE feed shows only the current attempt's output
              const liveLog = join(runDirPath, 'stages', retryStage.id, 'live.log');
              if (existsSync(liveLog)) unlinkSync(liveLog);
              // Clear any stale supervisor abort signal: the worker only auto-cleans
              // it on retries>0, but the inner loop re-runs with retries=0, so a
              // leftover abort_<stage>.json would instantly self-kill this fresh attempt.
              const staleAbort = join(runDirPath, 'signals', `abort_${retryStage.id}.json`);
              if (existsSync(staleAbort)) unlinkSync(staleAbort);
            }
            writeRunState(projectDir, runId, state);

            await Promise.all(activeRetryStages.map(retryStage =>
              executeSingleStage(retryStage, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, undefined, availableSkillsList)
            ));
            innerRetriesUsed = inner + 1;
            syncStageStatuses(projectDir, runId, activeRetryStages.map(s => s.id));
            state = readRunState(projectDir, runId);

            // Check for cancellation after fix stages complete
            if (isTerminalRunStatus(state.status)) break;

            // Skip gate re-runs if any fix stage itself failed (saves wasted agent calls)
            const anyFixFailed = activeRetryStages.some(s => state.stages[s.id]?.status === 'failed');
            if (anyFixFailed) {
              // If the failure is a transient adapter error, continue to next retry instead of aborting
              const allAdapterErrors = activeRetryStages
                .filter(s => state.stages[s.id]?.status === 'failed')
                .every(s => state.stages[s.id]?.error === 'adapter connection failed');
              if (allAdapterErrors && inner < maxInnerRetries - 1) {
                log.info({ runId, iteration, inner }, 'Fix stage failed due to adapter error — retrying');
                continue;
              }
              log.info({ runId, iteration, inner }, 'Fix stage failed — skipping gate re-evaluation');
              break;
            }

            // Collect all gates referenced by all active retry stages
            const allRetryGateIds = new Set<string>();
            for (const retryStage of activeRetryStages) {
              for (const gid of retryStage.retry_to!) allRetryGateIds.add(gid);
            }

            // Determine which gates to re-run
            const gatesToRerun = sorted.filter(s => {
              if (!s.is_gate || !allRetryGateIds.has(s.id)) return false;
              const v = readGateVerdict(projectDir, s.id, runId);
              return !v || v.pass !== true;
            });
            for (const gate of gatesToRerun) {
              const perGate = join(runDirPath, `verdict_${gate.id}.json`);
              if (existsSync(perGate)) unlinkSync(perGate);
              state.stages[gate.id] = { status: 'pending', retries: 0 };
              mkdirSync(join(runDirPath, 'stages', gate.id), { recursive: true });
              // Clear live.log so the SSE feed shows only the current re-evaluation's output
              const liveLog = join(runDirPath, 'stages', gate.id, 'live.log');
              if (existsSync(liveLog)) unlinkSync(liveLog);
              writeRunState(projectDir, runId, state);
            }
            if (existsSync(sharedVerdict)) unlinkSync(sharedVerdict);

            // Run gate stages (possibly in parallel), passing fix stage IDs for context
            if (gatesToRerun.length > 0) {
              await Promise.all(gatesToRerun.map(gate =>
                executeSingleStage(gate, projectDir, runId, runDirPath, workflow, adapter, agents, resolvedAgentsDir, state, sorted, skills, taskDescription, inner, activeRetryStages.map(s => s.id), availableSkillsList)
              ));
              syncStageStatuses(projectDir, runId, gatesToRerun.map(s => s.id));
            }
            state = readRunState(projectDir, runId);

            // Check gates again
            const recheck = checkGates(sorted, state, projectDir, runId);
            if (recheck.allPass) break;
            if (inner === maxInnerRetries - 1) {
              log.info({ runId, iteration }, 'Inner loop exhausted, falling back to outer re-plan');
            }
          }
        }
      }
    }

    state = readRunState(projectDir, runId);

    // Issue 12 fix: finalize any retry_to stages still marked "running" after inner loop
    for (const s of sorted) {
      if (s.retry_to && s.retry_to.length > 0 && state.stages[s.id]?.status === 'running') {
        state.stages[s.id] = { ...state.stages[s.id], status: 'skipped' };
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
      if (pendingNextPhase && iteration < maxIterations) {
        log.info({ runId, iteration, gate: pendingNextPhase.gateId, nextPhase: pendingNextPhase.nextPhase }, 'Gate passed with nextPhase set — continuing to next iteration instead of marking complete');
        continue;
      }
      // Terminal-state already handled by the top gate + eager post-batch gate
      // (with an isTerminalStatus early-return after executeIteration), so
      // reaching here means a plain gate-passed completion.
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
        detail: state.status,
      });
      log.info({ runId, iteration }, 'All gates passed, run complete');
      await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
      return state;
    }

    // If no dispatched stages, check if all base stages passed
    if (iterationDispatchedIds.length === 0 && !anyFailed(state) && allDone(state)) {
      if (state.status === 'failed') {
        writeCampaignEntry(projectDir, state);
        return state;
      }
      // Terminal-state already handled by the top + eager gates (see above).
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
        detail: state.status,
      });
      await generateRunSummary(projectDir, runId, adapter).catch(() => { /* non-critical */ });
      return state;
    }

    // Non-gate stage failure: if a stage failed and there are no gates to retry through,
    // fail immediately instead of silently re-planning
    const hasGates = sorted.some(s => s.is_gate);
    if (anyFailed(state) && !hasGates) {
      const failedStageIds = Object.entries(state.stages)
        .filter(([, s]) => s.status === 'failed')
        .map(([id]) => id);
      const details = failedStageIds.map(id => {
        const s = state.stages[id];
        return s?.error ? `${id} (${s.error})` : id;
      }).join(', ');
      state.status = 'failed';
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

    // Max iterations reached
    if (iteration === maxIterations) {
      state.status = 'failed';
      state.failureReason = `Max iterations reached (${maxIterations}). Gates did not pass after ${maxIterations} attempt(s).`;
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
      log.info({ runId, iteration }, 'Max iterations reached, run failed');
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
    try { if (existsSync(schedulerPidPath)) unlinkSync(schedulerPidPath); } catch { /* non-critical */ }
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
  availableSkills?: string,
): Promise<void> {
  if (!agents.has(stage.role)) {
    const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
    if (!existsSync(agentPath)) throw new Error(`No agent config for role "${stage.role}"`);
    const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
    agents.set(stage.role, applyBasePrompt(parseAgent(raw, projectDir), loadBasePrompt(resolvedAgentsDir)));
  }
  const agent = agents.get(stage.role)!;
  const timeout = stage.timeout_ms ?? state.timeoutMs ?? workflow.defaults.timeout_ms ?? loadDefaults(projectDir).timeout_ms;
  const roleRegistry = buildRoleRegistry(resolvedAgentsDir);

  let resolvedPrompt = stage.prompt_template || '';
  if (!resolvedPrompt) resolvedPrompt = taskDescription ?? '';

  // Inject inner retry context so the agent knows this is a repeated attempt
  if (innerRetry !== undefined) {
    if (stage.is_gate) {
      const fixOutputRefs = (fixStageIds ?? []).map(id => `- ${runDirPath}/stages/${id}/output.md`).join('\n');
      const fixContext = fixOutputRefs ? `\nFix stage output(s) to review:\n${fixOutputRefs}\n` : '';
      const prevGateRef = `\nYour previous evaluation output: ${runDirPath}/stages/${stage.id}/output.md — read it to see what you already tested and avoid duplicating those tests.\n`;
      resolvedPrompt = `RE-EVALUATION (round ${innerRetry + 1}): A fix was applied since the last evaluation. Write NEW and DIFFERENT tests targeting the fix — do not simply re-run the original tests.${fixContext}${prevGateRef}\n${resolvedPrompt}`;
    } else if (innerRetry > 0) {
      // Build references to the gate verdicts and outputs that triggered this retry
      const gateRefs = (stage.retry_to ?? []).map(gid =>
        `- Verdict: ${runDirPath}/verdict_${gid}.json\n- QA output: ${runDirPath}/stages/${gid}/output.md`
      ).join('\n');
      const gateContext = gateRefs ? `\nRead the latest gate results first:\n${gateRefs}\n` : '';
      resolvedPrompt = `RETRY FIX (attempt ${innerRetry + 1}): Previous fix attempt did not resolve all issues.${gateContext}\nRead your previous output at ${runDirPath}/stages/${stage.id}/output.md to see what you already tried. Try a DIFFERENT approach — do not repeat the same fix.\n\n${resolvedPrompt}`;
    }
  }

  // Knowledge Graph context: inject summary for dispatched stages
  try {
    const kgSummary = summarizeKG(readKG(projectDir, runId));
    if (kgSummary) resolvedPrompt = kgSummary + '\n\n' + resolvedPrompt;
  } catch { /* no KG yet */ }

  if (stage.is_gate) resolvedPrompt = appendGateMetricInstruction(resolvedPrompt, runDirPath, stage.id);

  let availableRoles: string | undefined;
  if (stage.dynamic_dispatch) {
    availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
  }

  const maxTechnicalRetries = Math.max(0, Math.floor(Number(stage.max_retries ?? workflow.defaults.max_retries ?? loadDefaults(projectDir).stage_technical_retries)));
  let retries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    state.stages[stage.id] = { status: 'running', retries, startedAt: new Date().toISOString() };
    writeStageStatus(projectDir, runId, stage.id, state.stages[stage.id]);
    writeRunState(projectDir, runId, state);

    const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
    const result = await runStage(stageAdapter, {
      stageId: stage.id,
      role: agent,
      dependsOn: stage.depends_on ?? [],
      promptTemplate: retries > 0
        ? `${buildRetryPreamble(retries, timeout, runDirPath, stage.id)}\n\n${resolvedPrompt}`
        : resolvedPrompt,
      timeout_ms: timeout,
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
    });

    if (result.timedOut && retries < maxTechnicalRetries) {
      retries++;
      log.warn({ stage: stage.id, retry: retries }, 'Retrying timed-out stage (inner loop)');
      continue;
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
  skills?: string,
  taskDescription?: string,
  availableSkills?: string,
): Promise<StoreState> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let state = readRunState(projectDir, runId);

    // Exit if run was cancelled or reached any terminal state externally
    if (isTerminalRunStatus(state.status)) {
      return state;
    }

    // Poll while awaiting approval
    if (state.status === 'awaiting_approval') {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // Inject dispatched stages
    for (const stage of sorted) {
      if (stage.dynamic_dispatch && !injectedDispatchStages.has(stage.id) &&
          state.stages[stage.id]?.status === 'complete') {
        injectedDispatchStages.add(stage.id);
        const injected = injectDispatchedStages(stage.id, roleRegistry, sorted, state, projectDir, runId);

        if (injected.length === 0) {
          // Check if there are static fallback stages
          const hasStaticFollowUp = sorted.some(s =>
            s.id !== stage.id && state.stages[s.id]?.status === 'pending'
          );
          if (!hasStaticFollowUp) {
            const dispatchPath = join(runDir(projectDir, runId), 'dispatch.yaml');
            const dispatchExists = existsSync(dispatchPath);
            let reason: string;
            if (dispatchExists) {
              // Diagnose why all stages were rejected
              let detail = '';
              try {
                const raw = parseYaml(readFileSync(dispatchPath, 'utf-8'));
                const items = Array.isArray(raw) ? raw : (raw?.stages ?? []);
                const unknownRoles = (items as Record<string, unknown>[])
                  .filter(i => i?.role && !roleRegistry.has(i.role as string))
                  .map(i => `"${i.role}"`)
                  .filter((v, idx, arr) => arr.indexOf(v) === idx);
                if (unknownRoles.length > 0) {
                  detail = ` Unknown role(s): ${unknownRoles.join(', ')}. Available: ${[...roleRegistry.keys()].join(', ')}.`;
                }
              } catch { /* best effort */ }
              reason = `Planner wrote dispatch.yaml but it contained no valid stages.${detail} Refine the task brief and try again.`;
            } else {
              reason = 'Planner did not produce an execution plan (dispatch.yaml). Refine the task brief and try again.';
            }
            log.error({ stage: stage.id }, reason);
            state.status = 'failed';
            state.failureReason = reason;
            state.completedAt = new Date().toISOString();
            writeRunState(projectDir, runId, state);
            return state;
          }
          log.info({ stage: stage.id }, 'No dispatch.yaml — falling back to static stages');
        }

        state = readRunState(projectDir, runId);
      }
    }

    if (state.status === 'awaiting_approval') {
      // Auto-approve on iteration 2+ (re-plans) when autoApproveRetries is not explicitly false.
      // First iteration always requires manual approval so the user can review the plan,
      // unless autoApprove is explicitly true (API-created autonomous tasks).
      const currentIter = state.currentIteration ?? 1;
      if ((currentIter > 1 && state.autoApproveRetries !== false) || state.autoApprove === true) {
        state.status = 'running';
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

    const toRun: StageConfig[] = [];
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
      toRun.push(stage);
    }

    if (toRun.length === 0) continue;

    for (const stage of toRun) {
      const currentRetries = state.stages[stage.id]?.retries ?? 0;
      state.stages[stage.id] = { status: 'running', retries: currentRetries, startedAt: new Date().toISOString() };
    }
    writeRunState(projectDir, runId, state);

    const results = await Promise.all(toRun.map(async (stage) => {
     try {
      if (!agents.has(stage.role)) {
        const agentPath = join(resolvedAgentsDir, `${stage.role}.yaml`);
        if (!existsSync(agentPath)) throw new Error(`No agent config for role "${stage.role}"`);
        const raw = parseYaml(readFileSync(agentPath, 'utf-8'));
        agents.set(stage.role, applyBasePrompt(parseAgent(raw, projectDir), loadBasePrompt(resolvedAgentsDir)));
      }
      const agent = agents.get(stage.role)!;
      const timeout = stage.timeout_ms ?? state.timeoutMs ?? workflow.defaults.timeout_ms ?? loadDefaults(projectDir).timeout_ms;
      const currentRetries = state.stages[stage.id]?.retries ?? 0;
      log.info({ stage: stage.id, role: stage.role }, 'Running stage');

      let availableRoles: string | undefined;
      if (stage.dynamic_dispatch) {
        availableRoles = [...roleRegistry.entries()].map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
      }

      let resolvedPrompt = stage.prompt_template;
      if (!resolvedPrompt) {
        resolvedPrompt = (stage.depends_on ?? []).length === 0
          ? (taskDescription ?? '') + '\nProject: ' + projectDir
          : (taskDescription ?? '');
      }

      // Plan stage: prefer task_brief.md over taskDescription
      if ((stage.depends_on ?? []).length === 0) {
        const briefPath = join(runDirPath, 'task_brief.md');
        if (existsSync(briefPath)) {
          const briefContent = readFileSync(briefPath, 'utf-8').trim();
          if (briefContent) {
            resolvedPrompt = briefContent + '\nProject: ' + projectDir;
          }
        }
        // On re-plan, include iteration_log.md reference
        const iterLogPath = join(runDirPath, 'iteration_log.md');
        if (existsSync(iterLogPath)) {
          resolvedPrompt += `\n\nRead ${runDirPath}/iteration_log.md for previous iteration results. Fix the issues identified there.`;
        }
        // Campaign context: prepend history of previous runs.
        // Skipped when state.inheritCampaignContext === false (set via --no-inherit-campaign)
        // — the run stays attached to the campaign for telemetry, but the planner gets a
        // clean prompt so it can't be misled by terminal phases from a different task arc.
        const campaignStorageKey = resolveCampaignStorageKey({
          campaignId: state.campaignId,
          campaignStorageKey: state.campaignStorageKey,
          campaignName: state.campaignName,
        });
        if (campaignStorageKey && state.inheritCampaignContext !== false) {
          const entries = readCampaignEntries(projectDir, campaignStorageKey);
          if (entries.length > 0) {
            const scoredEntries = collapseEntriesForHealth(entries);
            const rows = scoredEntries
              .map(e => `| ${e.seq} | ${e.iteration ?? 1} | ${e.score ?? '-'} | ${e.metric ?? '-'} | ${e.gate ?? '-'} | ${e.pass ? 'pass' : 'fail'} |`)
              .join('\n');
            const best = scoredEntries.reduce((max, e) => typeof e.score === 'number' && e.score > max ? e.score : max, -Infinity);
            const phaseProgress = summarizeCampaignPhaseProgress(entries);
            let ctx = `=== CAMPAIGN: ${state.campaignName ?? state.campaignId} ===\n`;
            if (rows) {
              ctx += `| # | Iteration | Score | Metric | Gate | Status |\n|---|-----------|-------|--------|------|--------|\n${rows}\n\nBest ever: ${best}\n`;
            }
            if (phaseProgress.entries.length > 0) {
              ctx += `\nPhase progress:\n`;
              ctx += `- Completed phases: ${phaseProgress.completedPhases.length > 0 ? phaseProgress.completedPhases.join(', ') : 'none'}\n`;
              ctx += `- Current recommended phase: ${phaseProgress.currentPhase ?? 'not specified'}\n`;
              if (phaseProgress.latest) {
                ctx += `- Latest phase event: seq ${phaseProgress.latest.seq}, iteration ${phaseProgress.latest.iteration ?? 1}, phase ${phaseProgress.latest.phase ?? '-'}, phaseComplete ${phaseProgress.latest.phaseComplete === true ? 'true' : 'false'}, nextPhase ${phaseProgress.latest.nextPhase ?? '-'}, outcome ${phaseProgress.latest.outcome ?? '-'}\n`;
                if (phaseProgress.latest.artifactSummary) ctx += `- Latest artifact summary: ${phaseProgress.latest.artifactSummary}\n`;
                if (phaseProgress.latest.reason) ctx += `- Latest reason: ${phaseProgress.latest.reason}\n`;
              }
              ctx += `Planner rule: for multi-phase tasks, dispatch only the current recommended phase unless the task explicitly asks to restart from phase 0. Do not pack all future phases into one dispatch.\n`;
            }
            const summaryPaths: string[] = [];
            for (const e of entries) {
              const prevRunDir = runDir(projectDir, e.runId);
              const iterLog = join(prevRunDir, 'iteration_log.md');
              if (existsSync(iterLog) && !summaryPaths.includes(iterLog)) summaryPaths.push(iterLog);
            }
            if (summaryPaths.length > 0) {
              ctx += `\nPrevious run summaries:\n${summaryPaths.map(p => `- ${p}`).join('\n')}\n`;
            }
            const triggers = state.campaignTriggers;
            const alert = checkCampaignHealth(entries, triggers);
            if (alert) {
              ctx += `\n⚠️ CAMPAIGN ALERT: ${alert.type} — ${alert.message}\nDO NOT retry approaches from failed runs. Propose a fundamentally different approach.\n`;
            }
            ctx += `=== END CAMPAIGN ===\n\n`;
            resolvedPrompt = ctx + resolvedPrompt;
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
      if (currentRetries > 0) {
        resolvedPrompt = `${buildRetryPreamble(currentRetries, timeout, runDirPath, stage.id)}\n\n${resolvedPrompt}`;
      }

      if (stage.is_gate) resolvedPrompt = appendGateMetricInstruction(resolvedPrompt, runDirPath, stage.id);

      const stageAdapter = agent.adapter ? await loadAdapterByName(agent.adapter) : adapter;
      const result = await runStage(stageAdapter, {
        stageId: stage.id,
        role: agent,
        dependsOn: stage.depends_on ?? [],
        promptTemplate: resolvedPrompt,
        timeout_ms: timeout,
        projectDir,
        runId,
        runDir: runDirPath,
        retries: currentRetries,
        skills,
        stageSkills: stage.skills,
        availableRoles,
        availableSkills,
        taskDescription: taskDescription || state.taskDescription,
        isGate: stage.is_gate,
      });
      return { stage, result, currentRetries };
     } catch (err) {
       // A stage that THROWS (e.g. missing/invalid agent yaml at runtime) must not
       // reject Promise.all and unwind out of the loop, which would leave run.json
       // stuck 'running' forever (orphan). Degrade to a normal stage failure so the
       // downstream handling turns the run into 'failed'.
       const retriesNow = state.stages[stage.id]?.retries ?? 0;
       const msg = err instanceof Error ? err.message : String(err);
       log.error({ stage: stage.id, err: msg }, 'Stage threw before completion — degrading to failed');
       try { writeStageStatus(projectDir, runId, stage.id, { status: 'failed', exitCode: 1, error: msg, retries: retriesNow }); } catch { /* non-critical */ }
       const failedResult: RunResult = { output: '', exitCode: 1, duration_ms: 0, timedOut: false, adapterError: false };
       return { stage, result: failedResult, currentRetries: retriesNow };
     }
    }));

    state = readRunState(projectDir, runId);
    let failed = false;

    for (const { stage, result, currentRetries } of results) {
      const maxRetries = Math.max(0, Math.floor(Number(stage.max_retries ?? workflow.defaults.max_retries ?? loadDefaults(projectDir).stage_technical_retries)));

      if (result.timedOut && currentRetries < maxRetries) {
        const nextRetry = currentRetries + 1;
        const retryStatus: StageStatus = { status: 'pending', retries: nextRetry };
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn({ stage: stage.id, retry: nextRetry }, 'Retrying timed-out stage');
        continue;
      }

      if (result.exitCode !== 0 && currentRetries < maxRetries) {
        const retryStatus: StageStatus = { status: 'pending', retries: currentRetries + 1 };
        writeStageStatus(projectDir, runId, stage.id, retryStatus);
        state.stages[stage.id] = retryStatus;
        log.warn({ stage: stage.id, retry: currentRetries + 1 }, 'Retrying stage');
        continue;
      }

      if (result.exitCode !== 0) {
        log.error({ stage: stage.id }, 'Stage failed');
        failed = true;
        state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
        stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
        continue;
      }

      state.stages[stage.id] = readStageStatus(projectDir, runId, stage.id);
      stageEvents.push({ stageId: stage.id, status: state.stages[stage.id] });
      log.info({ stage: stage.id }, 'Stage complete');
    }

    writeRunState(projectDir, runId, state);
    for (const event of stageEvents) {
      recordStageOutcome(projectDir, runId, event.stageId, state.currentIteration, event.status);
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
    if (!failed) {
      const terminatedEager = await tryTerminateOnTerminalState(state, { projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1, adapter });
      if (terminatedEager) return terminatedEager;
      // [Research advance gate, call site 2 of 2] Same eager timing for research
      // mode: consume the round result a stage just wrote, evaluate, terminate
      // or steer — before any later stage can clobber it.
      const researchEager = await tryAdvanceResearch(state, { projectDir, runId, runDirPath, iteration: state.currentIteration ?? 1, adapter });
      if (researchEager) return researchEager;
    }

    if (failed) {
      // Don't set run status to failed here — let the iteration loop handle it
      return state;
    }
  }
}
