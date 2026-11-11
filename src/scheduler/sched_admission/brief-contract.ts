import { ArtifactPathSchema } from '../../artifact-location.js';
import { ResearchMeasurementSchema } from '../../research-measurement.js';
import { type BriefFrontmatterDocument, parseBriefFrontmatterDocument } from '../../brief-frontmatter.js';
/** Brief frontmatter, duration/floor contracts; no dispatch admission or execution. */
import { type TerminalStatesConfig, type ResearchConfig, isTerminalRunStatus, TERMINAL_STATUSES, type TerminalStateEntry, type PostTerminateHook, type StoreState } from '../../store.js';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { type BriefOutputDeclaration, extractBriefOutputDeclarations } from '../../ship-inputs.js';
import { log } from './shared.js';
import { parsePlannerPolicySelection, type PlannerPolicyName } from '../../planner-policies.js';

export interface ParsedBriefFrontmatter {
  maxContinuations?: number;
  /** Task authoring requirements; independent of engine admission. */
  plannerPolicies?: PlannerPolicyName[];
  workflowError?: string;
  terminalStates?: TerminalStatesConfig;
  /** The only active research contract is an engine-owned measurement declaration. */
  research?: ResearchConfig;
  researchPolicyError?: string;
  outputs?: BriefOutputDeclaration[];
  stripped: string;
  frontmatterError?: string;
  frontmatterErrorKind?: BriefFrontmatterDocument['errorKind'];
}

/** A measurement declaration owns research shape; engineering enters the chooser. */
export function entryWorkflow(parsed: ParsedBriefFrontmatter): { workflow: string; reason: string; error?: string } {
  const error = (parsed.frontmatterErrorKind === 'yaml' ? parsed.frontmatterError : undefined) ?? parsed.workflowError ?? parsed.researchPolicyError;
  return { workflow: parsed.research ? 'research' : 'entry', reason: parsed.research ? 'The measurement declaration fixes the research loop.' : 'The model chooser selects the engineering shape.', ...(error ? { error } : {}) };
}

export function parseBriefFrontmatter(brief: string): ParsedBriefFrontmatter {
  const frontmatter = parseBriefFrontmatterDocument(brief);
  // Retain the public parser's legacy diagnostic; entry-point admission uses
  // the shared document boundary, where an unclosed opener is body prose.
  if (!frontmatter) return /^(?:\uFEFF)?---\r?\n/.test(brief)
    ? { stripped: brief, frontmatterError: 'frontmatter fence opened with `---` but never closed (no closing `---` line)' }
    : { stripped: brief };
  if (frontmatter.error) return { stripped: brief, frontmatterError: frontmatter.error, frontmatterErrorKind: frontmatter.errorKind };
  const parsed = frontmatter.value;
  const stripped = frontmatter.body;
  if (!parsed || typeof parsed !== 'object') return { stripped, frontmatterError: 'frontmatter parsed but is not a YAML mapping/object' };
  const out: ParsedBriefFrontmatter = { stripped };
  const continuations = (parsed as Record<string, unknown>).max_continuations;
  if (continuations !== undefined) {
    if (!Number.isSafeInteger(continuations) || Number(continuations) < 0) return { stripped,
      frontmatterError: 'max_continuations must be a finite nonnegative integer', workflowError: 'max_continuations must be a finite nonnegative integer' };
    out.maxContinuations = Number(continuations);
  }
  try { out.plannerPolicies = parsePlannerPolicySelection((parsed as Record<string, unknown>).planner_policies); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { stripped, frontmatterError: reason, workflowError: reason };
  }
  // Only explicit products belong to output archival.
  const outputs = extractBriefOutputDeclarations(brief).filter((entry) => (
    /^(?:outputs?|deliverables?|artifacts?)(?:\.|$)/.test(entry.source)
  ));
  if (outputs.length > 0) out.outputs = outputs;

  // Active inputs have one strict contract. Historical run JSON is read separately.
  const resRaw = Object.hasOwn(parsed, 'research') ? (parsed as Record<string, unknown>).research : (parsed as Record<string, unknown>).objective;
  const duplicate = Object.hasOwn(parsed, 'research') && Object.hasOwn(parsed, 'objective');
  if (resRaw !== undefined || duplicate) {
    const migration = 'Legacy research is retired; declare research.measurement with frozen/candidate roots and structured guards.';
    const fail = (detail: string) => { out.researchPolicyError = `${migration} ${detail}`; out.workflowError = out.researchPolicyError; };
    if (duplicate) fail('Declare the measurement contract once; research and its objective alias cannot both be present.');
    else if (!resRaw || typeof resRaw !== 'object' || Array.isArray(resRaw)) fail('Research must be a mapping.');
    else {
      const r = resRaw as Record<string, unknown>;
      const unknown = Object.keys(r).filter(key => !['measurement', 'stop'].includes(key));
      const stop = r.stop as Record<string, unknown> | undefined;
      const stopKeys = stop && typeof stop === 'object' ? Object.keys(stop) : [];
      const retired = stopKeys.filter(key => !['beat', 'max_rounds', 'max_wall_hours', 'halt_after_no_improvement'].includes(key));
      if (r.measurement === undefined || unknown.length || retired.length) fail(`Remove retired fields: ${[...unknown, ...retired.map(k => 'stop.' + k)].join(', ') || 'research without measurement'}.`);
      else {
        const measurement = ResearchMeasurementSchema.safeParse(r.measurement);
        if (!measurement.success) fail(`research.measurement: ${measurement.error.message}`);
        else if (!Number.isSafeInteger(stop?.max_rounds) || Number(stop?.max_rounds) < 1) fail('stop.max_rounds must be a positive integer.');
        else if (stop?.max_wall_hours !== undefined && (typeof stop.max_wall_hours !== 'number' || !Number.isFinite(stop.max_wall_hours) || stop.max_wall_hours <= 0)) fail('stop.max_wall_hours must be finite and positive.');
        else if (stop?.halt_after_no_improvement !== undefined && (!Number.isSafeInteger(stop.halt_after_no_improvement) || Number(stop.halt_after_no_improvement) < 1)) fail('stop.halt_after_no_improvement must be a positive integer.');
        else if (stop?.beat !== undefined && (typeof stop.beat !== 'number' || !Number.isFinite(stop.beat))) fail('stop.beat must be finite.');
        else out.research = { measurement: measurement.data, stop: {
          maxRounds: Number(stop!.max_rounds),
          ...(stop!.max_wall_hours === undefined ? {} : { maxWallHours: Number(stop!.max_wall_hours) }),
          ...(stop!.halt_after_no_improvement === undefined ? {} : { haltAfterNoImprovement: Number(stop!.halt_after_no_improvement) }),
          ...(stop!.beat === undefined ? {} : { beat: Number(stop!.beat) }),
        } };
      }
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
  if (out.research) {
    const roots = [...out.research.measurement.frozen, ...out.research.measurement.candidate];
    const reports = Object.values(ts).flatMap(entry => entry.paths);
    const invalid = reports.find(path => !ArtifactPathSchema.safeParse(path).success
      || roots.some(root => path === root || path.startsWith(root + '/') || root.startsWith(path + '/')));
    if (invalid !== undefined) {
      out.workflowError = out.researchPolicyError = `Research terminal report ${JSON.stringify(invalid)} must be a confined file outside frozen and candidate roots.`;
      delete out.research;
    }
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

  // Count fresh nonempty receipts matching the declared evidence pattern.
  // Result checks own whether the evidence proves the outcome; a count or
  // duration cannot establish its substance.
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
      try {
        const stat = statSync(join(fullDir, f));
        if (!stat.isFile() || stat.size === 0) continue;
        if (stat.mtimeMs >= startedAtMs) fresh += 1;
        else stale += 1;
      } catch { /* a disappearing/unreadable file does not count */ }
    }
    return { fresh, stale };
  } catch {
    return { fresh: 0, stale: 0 };
  }
}
