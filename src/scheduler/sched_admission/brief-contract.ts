import { splitBriefFrontmatter } from '../../brief-frontmatter.js';
/** Brief frontmatter, duration/floor contracts and program lifecycle evidence; no dispatch admission or execution. */
import { type ResearchConfirmConfig, type TerminalStatesConfig, type ProgramConfig, type ResearchConfig, type ResearchIntegrityConfig, isTerminalRunStatus, TERMINAL_STATUSES, type TerminalStateEntry, type PostTerminateHook, type StoreState, isPendingStageStatus, STAGE_STATUS } from '../../store.js';
import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { type ResearchFeasibilityConfig, parseResearchFeasibility } from '../../research-feasibility.js';
import { type BriefOutputDeclaration, extractBriefOutputDeclarations } from '../../ship-inputs.js';
import { nextTechnicalRetryBudget } from '../../attempt-deadline.js';
import { parse as parseYaml } from 'yaml';
import { ResearchPolicySchema, RESEARCH_POLICY_IDS } from '../../research-policy.js';
import { ArtifactReadSchema } from '../../artifact-declarations.js';
import { log } from './shared.js';

export function recordConfirmNotRun(runDirPath: string, confirm: ResearchConfirmConfig | undefined, terminalStatus: string): void {
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
  outputs?: BriefOutputDeclaration[];
  stripped: string;
  frontmatterError?: string;
}

export interface ResearchIterationBudgetAssessment {
  pass: boolean;
  maxRounds?: number;
  maxIterations: number;
  maxWallHours?: number;
  maxWallMs?: number;
  iterationWallCeilingMs?: number;
  iterationWallCeilingHours?: number;
  attemptDeadlines?: Array<{
    attempt: number;
    kind: 'base' | 'technical_retry';
    budgetMs: number;
    budgetHours: number;
  }>;
  reason?: string;
}

export interface ResearchIterationBudgetBindings {
  attemptTimeoutMs: number;
  technicalRetries: number;
}

/** Compare every configured binding on research duration in one unit-explicit
 * assessment. A terminal owner can run in the settling iteration, so authored
 * rounds fit exactly at the engine iteration ceiling. Technical retries retain
 * their ordinary per-attempt deadlines; the list makes each derived deadline
 * visible beside the aggregate wall binding. */
export function assessResearchIterationBudget(
  research: ResearchConfig | undefined,
  maxIterations: number,
  bindings?: ResearchIterationBudgetBindings,
): ResearchIterationBudgetAssessment {
  const maxRounds = research?.stop?.maxRounds;
  const maxWallHours = research?.stop?.maxWallHours;
  const assessment: ResearchIterationBudgetAssessment = {
    pass: true,
    ...(typeof maxRounds === 'number' ? { maxRounds } : {}),
    maxIterations,
    ...(typeof maxWallHours === 'number'
      ? { maxWallHours, maxWallMs: maxWallHours * 3_600_000 }
      : {}),
  };

  if (bindings) {
    const attemptTimeoutMs = bindings.attemptTimeoutMs;
    const technicalRetries = Math.max(0, Math.floor(bindings.technicalRetries));
    const iterationWallCeilingMs = attemptTimeoutMs * maxIterations;
    assessment.iterationWallCeilingMs = iterationWallCeilingMs;
    assessment.iterationWallCeilingHours = iterationWallCeilingMs / 3_600_000;
    const attemptDeadlines: NonNullable<ResearchIterationBudgetAssessment['attemptDeadlines']> = [];
    let budgetMs = attemptTimeoutMs;
    for (let retry = 0; retry <= technicalRetries; retry++) {
      attemptDeadlines.push({
        attempt: retry + 1,
        kind: retry === 0 ? 'base' : 'technical_retry',
        budgetMs,
        budgetHours: budgetMs / 3_600_000,
      });
      if (retry < technicalRetries) budgetMs = nextTechnicalRetryBudget(budgetMs);
    }
    assessment.attemptDeadlines = attemptDeadlines;
  }

  if (typeof maxRounds === 'number' && maxRounds > maxIterations) {
    assessment.pass = false;
    assessment.reason = `research.stop.max_rounds (${maxRounds}) exceeds the engine iteration limit (${maxIterations}); units: rounds versus iterations`;
    return assessment;
  }
  if (typeof assessment.maxWallMs === 'number'
      && typeof assessment.iterationWallCeilingMs === 'number'
      && assessment.maxWallMs > assessment.iterationWallCeilingMs) {
    assessment.pass = false;
    assessment.reason = `research.stop.max_wall_hours (${maxWallHours} hours / ${assessment.maxWallMs} ms) exceeds the engine wall capacity from default_timeout_ms × max_iterations (${assessment.iterationWallCeilingHours} hours / ${assessment.iterationWallCeilingMs} ms)`;
  }
  return assessment;
}

/**
 * The workflow a brief runs on when no --workflow is given, and why: `research` for a research block; the fixed
 * author -> gate -> repair plan (`direct`) for one declared output or none with nothing for a planner to arrange;
 * otherwise the planner (`default`). On the pilot ruler the fixed plan matched planned runs' quality in 25-55% less time.
 */
export function autoSelectedWorkflow(
  parsed: ParsedBriefFrontmatter,
  declaredInputs: readonly string[],
): { workflow: 'research' | 'direct' | 'default'; reason: string } {
  if (parsed.research) return { workflow: 'research', reason: 'the brief has a `research:` block' };
  const toArrange = [
    parsed.frontmatterError ? 'a frontmatter that did not parse' : '',
    declaredInputs.length > 0 ? `${declaredInputs.length} declared input(s)` : '',
    parsed.program ? 'a program' : '',
    parsed.terminalStates ? 'terminal states' : '',
    (parsed.outputs?.length ?? 0) > 1 ? `${parsed.outputs?.length} declared outputs` : '',
  ].filter(Boolean);
  return toArrange.length === 0
    ? { workflow: 'direct', reason: 'one deliverable and nothing for a planner to arrange' }
    : { workflow: 'default', reason: `the planner arranges ${toArrange.join(', ')}` };
}

export function parseBriefFrontmatter(brief: string): ParsedBriefFrontmatter {
  const frontmatter = splitBriefFrontmatter(brief);
  if (!frontmatter) return /^(?:\uFEFF)?---\r?\n/.test(brief)
    ? { stripped: brief, frontmatterError: 'frontmatter fence opened with `---` but never closed (no closing `---` line)' }
    : { stripped: brief };
  const fm = frontmatter.yaml;
  const stripped = frontmatter.body;
  let parsed: unknown;
  // GAP-3: RETURN the YAML parse error instead of swallowing it — the caller can
  // then fail loud / record an event rather than silently falling back to plain dispatch.
  try { parsed = parseYaml(fm); } catch (err) { return { stripped: brief, frontmatterError: `frontmatter YAML parse error: ${err instanceof Error ? err.message : String(err)}` }; }
  if (!parsed || typeof parsed !== 'object') return { stripped, frontmatterError: 'frontmatter parsed but is not a YAML mapping/object' };
  const out: ParsedBriefFrontmatter = { stripped };
  // Terminal-state, research-result, and report-directory paths have their own
  // lifecycle contracts. Only the brief's explicit output collection belongs
  // to the terminal archive added for `outputs:`; otherwise a consumed mutable
  // research slot would make an unrelated terminal artifact impossible to
  // commit merely because it is absent at closeout.
  const outputs = extractBriefOutputDeclarations(brief).filter((entry) => (
    /^(?:outputs?|deliverables?|artifacts?)(?:\.|$)/.test(entry.source)
  ));
  if (outputs.length > 0) out.outputs = outputs;

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
          if (c.reads !== undefined) confirm.reads = ArtifactReadSchema.array().parse(c.reads);
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

export function evaluateTerminalFloor(
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
export function markLeftoverStagesSkipped(state: StoreState, note: string): void {
  for (const st of Object.values(state.stages ?? {})) {
    if (isPendingStageStatus(st.status)) {
      st.status = STAGE_STATUS.SKIPPED;
      st.error = note;
    }
  }
}

export function checkProgramSafeguards(projectDir: string, program: ProgramConfig): string | null {
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

export function appendProgramLedger(
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
