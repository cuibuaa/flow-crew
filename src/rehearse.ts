/**
 * `flowcrew rehearse <brief.md>` — pre-flight wind tunnel for a research brief.
 *
 * Runs the brief through the REAL scheduler against a ScriptedAdapter (a
 * deterministic fake agent) in an isolated temp project + temp FC home:
 * zero tokens, seconds of wall time, nothing written to the user's project
 * or real ~/.fc. It validates the ENGINE × BRIEF contract — frontmatter,
 * terminal paths, confirm wiring, stop rules vs ceiling floor — not the
 * research itself (a fake agent has no opinion on whether a direction is
 * good; it only proves the gates are plumbed correctly).
 *
 * The default synthesized trajectory deliberately walks the honesty-critical
 * paths: a mild first round (kept), a DECOY round that beats the ship target
 * (forcing ship → confirm; in the sandbox the confirm command is expected to
 * fail, exercising candidate exclusion), then declining rounds until the
 * stop rules propose a ceiling — deferred by the floor if declared, then
 * committed honestly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { inspectBrief, type BriefPreflightContext } from './brief-preflight.js';
import { extractBriefCriteria } from './brief-criteria.js';
import { routeLogsToFile } from './logging.js';
import { extractBriefPathMentions, inspectBriefOutputs } from './ship-inputs.js';
import { resolveRunStatus, RUN_STATUS, type RunStatus } from './store.js';

export { lintInstrumentCriteria } from './brief-preflight.js';
export type { CriterionLintWarning } from './brief-preflight.js';

export interface Finding {
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

export interface IsolatedRehearsalOptions {
  /** Used only for project-aware static inspection; the simulated run uses its own temp project. */
  projectDir?: string;
  staticOnly?: boolean;
  keep?: boolean;
  label?: string;
}

export interface IsolatedRehearsalResult {
  exitCode: 0 | 1;
  findings: Finding[];
  simulated: boolean;
  preflight: {
    digest: string;
    contractReady: boolean;
    requiresAcknowledgement: boolean;
  };
  outputInventory: {
    entries: number;
    blocking: number;
  };
  diagnosticsLogPath: string;
  retainedArtifacts?: {
    projectDir: string;
    runDir: string;
  };
  /** Separate isolated runs are required when declared outcomes are mutually
   * exclusive under the brief's own stopping rule. */
  retainedOutcomeArtifacts?: Record<string, {
    projectDir: string;
    runDir: string;
  }>;
}

interface RunRehearsalOptions extends IsolatedRehearsalOptions {
  briefText?: string;
  render?: boolean;
}

export type GitIgnoreProbe = (
  projectDir: string,
  candidatePaths: readonly string[],
) => readonly string[];

type RehearsalRunConsequence = 'ship_warning' | 'ceiling_ok' | 'fail';

/** A rehearsal's verdict is an operator consequence distinct from process success. */
const REHEARSAL_RUN_CONSEQUENCES = {
  [RUN_STATUS.PENDING]: 'fail',
  [RUN_STATUS.RUNNING]: 'fail',
  [RUN_STATUS.PARKED]: 'fail',
  [RUN_STATUS.COMPLETE]: 'fail',
  [RUN_STATUS.FAILED]: 'fail',
  [RUN_STATUS.AWAITING_APPROVAL]: 'fail',
  [RUN_STATUS.SHIPPED]: 'ship_warning',
  [RUN_STATUS.CEILING_HIT]: 'ceiling_ok',
  [RUN_STATUS.ESCALATED]: 'fail',
  [RUN_STATUS.REALITY_GATE_FAILED]: 'fail',
  [RUN_STATUS.PHASE_COMPLETE]: 'fail',
  [RUN_STATUS.STOPPED]: 'fail',
  [RUN_STATUS.INCOMPLETE]: 'fail',
} as const satisfies Record<RunStatus, RehearsalRunConsequence>;

function probeGitignoredPaths(projectDir: string, candidatePaths: readonly string[]): string[] {
  if (candidatePaths.length === 0) return [];
  try {
    const output = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: projectDir,
      input: `${candidatePaths.join('\0')}\0`,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return output.split('\0').filter(Boolean);
  } catch {
    // Exit 1 means none are ignored. A missing Git repository/tool likewise
    // contributes no exact ignore facts; the normal launch/rehearsal checks
    // retain ownership of reporting those environment failures.
    return [];
  }
}

/** Build the repository-dependent part of brief inspection from exact Git facts. */
export function projectBriefPreflightContext(
  projectDir: string,
  brief: string,
  probe: GitIgnoreProbe = probeGitignoredPaths,
): BriefPreflightContext {
  const candidates = [...new Set(extractBriefPathMentions(brief).map((mention) => mention.path))];
  if (candidates.length === 0) return {};
  const candidateSet = new Set(candidates);
  const ignored = [...new Set(probe(projectDir, candidates))]
    .filter((path) => candidateSet.has(path));
  return ignored.length > 0 ? { gitignoredPathPrefixes: ignored } : {};
}

const mark = { ok: '✓', warn: '⚠', fail: '✗' } as const;

const NO_CANDIDATE_OUTCOME = /(?:\boutcome\s*:\s*no_candidate\b|\bno[-_ ]candidate\b)/i;

/**
 * A rehearsal should follow an outcome the brief permits, not every outcome it
 * happens to discuss. Keep this deliberately lexical and conservative: a
 * positive literal declaration is enough, while common prohibition and
 * explicit-absence forms suppress only the clause that contains them.
 */
export function briefDeclaresNoCandidateOutcome(brief: string): boolean {
  const clauses = brief.split(/\r?\n|[!?;](?:\s+|$)|\.(?:\s+|$)/);
  return clauses.some((clause) => {
    if (!NO_CANDIDATE_OUTCOME.test(clause)) return false;
    const token = '(?:outcome\\s*:\\s*no_candidate|no[-_ ]candidate)';
    const negations = [
      new RegExp(`\\bno\\s+(?:${token})\\b`, 'i'),
      new RegExp(`\\b(?:do|does|did|must|should|shall|may|can)\\s+not\\b[^.!?;]{0,120}\\b${token}\\b`, 'i'),
      new RegExp(`\\b(?:never|without)\\b[^.!?;]{0,120}\\b${token}\\b`, 'i'),
      new RegExp(`\\b${token}\\b[^.!?;]{0,80}\\b(?:is|are)\\s+not\\b`, 'i'),
      new RegExp(`\\b${token}\\b[^.!?;]{0,80}\\b(?:undeclared|forbidden|unsupported|disallowed)\\b`, 'i'),
    ];
    return !negations.some((pattern) => pattern.test(clause));
  });
}

export function rehearsalExitCode(findings: ReadonlyArray<Finding>): 0 | 1 {
  return findings.some((finding) => finding.level === 'fail') ? 1 : 0;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function conciseError(error: unknown): string {
  if (!(error instanceof Error)) return 'an unexpected internal error occurred';
  const firstLine = error.message.split(/\r?\n/).find((line) => line.trim())?.trim();
  return (firstLine || error.name || 'an unexpected internal error occurred')
    .replace(/Buffer\s*</g, 'binary output <')
    .slice(0, 300);
}

function gitSetupFailure(error: unknown): string {
  const detail = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown }
    : undefined;
  if (detail?.code === 'ENOENT') {
    return 'Git is not installed or is not available on PATH, so the isolated temporary repository could not be created.';
  }
  const status = typeof detail?.status === 'number' ? ` (git exit ${detail.status})` : '';
  return `Git could not create the isolated temporary repository${status}.`;
}

function isolatedGitEnvironment(home: string, configPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: configPath,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function initializeTemporaryGitRepository(projectDir: string, stateDir: string): void {
  const gitHome = join(stateDir, 'git-home');
  const gitConfig = join(stateDir, 'empty.gitconfig');
  const templateDir = join(stateDir, 'empty-git-template');
  const hooksDir = join(stateDir, 'empty-git-hooks');
  for (const directory of [gitHome, join(gitHome, 'xdg'), templateDir, hooksDir]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(gitConfig, '', 'utf-8');
  const env = isolatedGitEnvironment(gitHome, gitConfig);
  execFileSync('git', ['init', '-q', `--template=${templateDir}`], {
    cwd: projectDir,
    env,
    stdio: 'pipe',
  });
  execFileSync('git', [
    '-c', 'user.email=r@r.r',
    '-c', 'user.name=rehearse',
    '-c', 'commit.gpgSign=false',
    '-c', `core.hooksPath=${hooksDir}`,
    'commit', '-q', '--allow-empty', '-m', 'init',
  ], {
    cwd: projectDir,
    env,
    stdio: 'pipe',
  });
}

async function settleDeferredRunWrites(runDirectory: string): Promise<void> {
  const refreshPath = join(runDirectory, 'attempt_summary_refresh.json');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const refresh = JSON.parse(readFileSync(refreshPath, 'utf-8')) as { pending?: unknown };
      if (refresh.pending !== true) return;
    } catch {
      // No refresh request means this run has no debounced write to drain.
      return;
    }
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  throw new Error('rehearsal run-event summary refresh did not settle within 5000 ms');
}

export async function cmdRehearse(argv: string[]): Promise<void> {
  try {
    const result = await runRehearsal(argv);
    process.exitCode = result.exitCode;
  } catch (error) {
    const briefPath = argv.find((arg) => !arg.startsWith('--')) ?? '<brief.md>';
    console.error(`Rehearsal could not complete safely: ${conciseError(error)}`);
    console.error(`Next: flowcrew rehearse ${shellQuote(briefPath)} --static-only`);
    process.exitCode = 1;
  }
}

async function runRehearsal(argv: string[], options: RunRehearsalOptions = {}): Promise<IsolatedRehearsalResult> {
  const briefPath = argv.find((a) => !a.startsWith('--'));
  if (!briefPath || (options.briefText === undefined && !existsSync(briefPath))) {
    throw new Error('Usage: flowcrew rehearse <brief.md> [--keep] [--static-only]');
  }
  const keep = options.keep ?? argv.includes('--keep');
  const staticOnly = options.staticOnly ?? argv.includes('--static-only');
  const brief = options.briefText ?? readFileSync(briefPath, 'utf-8');
  const briefLabel = options.label ?? briefPath;
  const diagnosticsDir = mkdtempSync(join(tmpdir(), 'flowcrew-rehearse-diagnostics-'));
  const diagnosticLogPath = join(diagnosticsDir, 'engine.log');
  const closeDiagnostics = routeLogsToFile(diagnosticLogPath);
  process.once('exit', closeDiagnostics);

  const scheduler = await import('./scheduler.js');
  const store = await import('./store.js');
  const { ScriptedAdapter } = await import('./adapters/scripted.js');

  const findings: Finding[] = [];
  const add = (level: Finding['level'], text: string) => findings.push({ level, text });

  // ---------- static contract checks ----------
  const projectDir = options.projectDir ?? process.env.PROJECT_DIR ?? process.cwd();
  const preflightContext = projectBriefPreflightContext(projectDir, brief);
  const preflight = inspectBrief(brief, preflightContext);
  for (const finding of preflight.findings) {
    add(finding.code === 'brief_criteria_missing' ? 'fail' : finding.level, finding.message
      + (finding.risk ? `\n  Risk: ${finding.risk}` : '')
      + (finding.suggestion ? `\n  Suggestion: ${finding.suggestion}` : ''));
  }
  const outputInventory = inspectBriefOutputs(brief, projectDir);
  for (const entry of outputInventory.blocking) {
    add('fail', `Declared output ${entry.path} is already occupied (${entry.entryType}${entry.size === undefined ? '' : `, ${entry.size} bytes`}): ${entry.reason}`
      + '\n  Declare an explicit on_existing disposition only when the existing artifact is intentionally consumed; otherwise choose a fresh path.');
  }
  if (outputInventory.entries.length > 0 && outputInventory.blocking.length === 0) {
    add('ok', `Declared output inventory: ${outputInventory.entries.length} path(s), no implicit overwrite`);
  }
  add('ok', `Exact brief digest: ${preflight.digest}`);
  const fm = scheduler.parseBriefFrontmatter(brief);
  const rc = fm.research;
  const ts = fm.terminalStates;

  const hasFail = () => findings.some((f) => f.level === 'fail');

  // ---------- simulated run ----------
  let simulated = false;
  let tempFcHome = '';
  let tempProject = '';
  let noCandidateProject = '';
  let rehearsalRunDir = '';
  let noCandidateRunDir = '';
  let retainedArtifacts: IsolatedRehearsalResult['retainedArtifacts'];
  let retainedOutcomeArtifacts: IsolatedRehearsalResult['retainedOutcomeArtifacts'];
  if (!staticOnly && rc && !hasFail()) {
    simulated = true;
    tempFcHome = mkdtempSync(join(tmpdir(), 'fc-rehearse-home-'));
    tempProject = mkdtempSync(join(tmpdir(), 'fc-rehearse-proj-'));
    const realFcHome = store.fcGlobalDir();
    store.setFcGlobalDir(tempFcHome);
    let simulationPhase: 'git' | 'scheduler' = 'git';
    try {
      initializeTemporaryGitRepository(tempProject, tempFcHome);
      simulationPhase = 'scheduler';

      const resultRel = rc.resultFile ?? 'docs/research_round_result.json';
      const criterionIds = extractBriefCriteria(brief).criteria.map((criterion) => criterion.id);
      mkdirSync(join(tempProject, dirname(resultRel)), { recursive: true });

      const hib = rc.higherIsBetter !== false;
      const sign = hib ? 1 : -1;
      const base = rc.baseline;
      const beat = rc.stop?.beat;
      const schemaProperties = rc.resultSchema && typeof rc.resultSchema === 'object'
        && rc.resultSchema.properties && typeof rc.resultSchema.properties === 'object'
        ? rc.resultSchema.properties as Record<string, unknown>
        : {};
      const resultProperty = schemaProperties.result;
      const numericResultSchema = resultProperty && typeof resultProperty === 'object'
        ? resultProperty as Record<string, unknown>
        : {};
      const requiredFields = rc.resultSchema && typeof rc.resultSchema === 'object'
        && Array.isArray(rc.resultSchema.required)
        ? rc.resultSchema.required.filter((field): field is string => typeof field === 'string')
        : [];
      const resultStdRequired = requiredFields.includes('result_std');
      const resultStdProperty = schemaProperties.result_std;
      const resultStdSchema = resultStdProperty && typeof resultStdProperty === 'object'
        ? resultStdProperty as Record<string, unknown>
        : {};
      const resultStdType = resultStdSchema.type;
      const resultStdAllowsNumber = resultStdType === undefined
        || resultStdType === 'number'
        || resultStdType === 'integer'
        || (Array.isArray(resultStdType) && (
          resultStdType.includes('number') || resultStdType.includes('integer')
        ));
      const fieldFloors = rc.integrity?.fieldFloors ?? {};
      const stdFloor = Math.max(
        0,
        typeof resultStdSchema.minimum === 'number' ? resultStdSchema.minimum : 0,
        fieldFloors.result_std ?? 0,
      );
      const stdCeiling = typeof resultStdSchema.maximum === 'number'
        ? resultStdSchema.maximum
        : Infinity;
      const integerStd = resultStdType === 'integer'
        || (Array.isArray(resultStdType) && resultStdType.includes('integer') && !resultStdType.includes('number'));
      const enumStdCandidates = Array.isArray(resultStdSchema.enum)
        ? resultStdSchema.enum.filter((value): value is number => (
          typeof value === 'number' && Number.isFinite(value) && value >= stdFloor && value <= stdCeiling
        )).sort((left, right) => left - right)
        : undefined;
      const minimumStdCandidate = integerStd ? Math.ceil(stdFloor) : stdFloor;
      const resultStd = !resultStdRequired
        ? undefined
        : !resultStdAllowsNumber
          ? undefined
          : enumStdCandidates
            ? enumStdCandidates[0]
            : minimumStdCandidate <= stdCeiling
              ? minimumStdCandidate
              : undefined;
      const seMultiple = rc.stop?.improvementSEMultiple ?? 1;
      const margin = Math.max(
        rc.stop?.minImprovement ?? 0,
        resultStd === undefined ? 0 : Math.abs(resultStd) * seMultiple,
      );
      const epsilon = Number.EPSILON * Math.max(1, Math.abs(base), Math.abs(beat ?? base)) * 8;
      const crossing = beat === undefined
        ? undefined
        : hib
          ? Math.max(beat, base + margin + epsilon)
          : Math.min(beat, base - margin - epsilon);
      const minimum = typeof numericResultSchema.minimum === 'number' ? numericResultSchema.minimum : -Infinity;
      const maximum = typeof numericResultSchema.maximum === 'number' ? numericResultSchema.maximum : Infinity;
      const outlierFactor = rc.integrity?.outlierFactor ?? 5;
      const outlierSafe = crossing === undefined || Math.abs(base) <= 1e-9
        || (hib ? crossing <= Math.abs(base) * outlierFactor : crossing >= -(Math.abs(base) * outlierFactor));
      const maxStdRatio = rc.integrity?.maxStdRatio ?? 0.30;
      const varianceSafe = crossing === undefined || resultStd === undefined || Math.abs(crossing) <= 1e-6
        || Math.abs(resultStd) / Math.abs(crossing) <= maxStdRatio;
      const rejectStd = (rc.integrity?.rejectIfPositive ?? []).includes('result_std')
        && (resultStd ?? 0) > 0;
      const uncertaintySafe = !resultStdRequired || (resultStd !== undefined && varianceSafe && !rejectStd);
      const shipProbe = crossing !== undefined && crossing >= minimum && crossing <= maximum && outlierSafe && uncertaintySafe
        ? crossing
        : undefined;
      // Trajectory sized FROM the brief's own stop rules and ceiling floor so a
      // policy-owned ceiling is actually reachable: one mild keeper strictly
      // below the ship target, one decoy AT the target (forcing ship→confirm),
      // then a declining tail long enough for halt_after_no_improvement, with
      // total rounds covering the declared floor (capped by max_rounds).
      const halt = rc.stop?.haltAfterNoImprovement;
      const maxR = rc.stop?.maxRounds;
      const floorN = ts?.['ceiling_hit']?.floor?.minAttemptedStages ?? 0;
      const head = 1 + (shipProbe !== undefined ? 1 : 0);
      let totalRounds = Math.max(floorN, head + (halt ?? 3), head + 1);
      if (maxR !== undefined) totalRounds = Math.min(totalRounds, Math.max(maxR, head + 1));
      const r1 = beat !== undefined ? base + (beat - base) * 0.5 : base + sign * (Math.abs(base) * 0.1 + 1);
      const seq: Array<{ label: string; result: number }> = [
        { label: 'rehearse_r1_mild', result: r1 },
        // Use the closest policy- and schema-valid crossing. A fixed unit jump
        // made bounded metrics invalid before ship/confirm could run.
        ...(shipProbe !== undefined ? [{ label: 'rehearse_r2_decoy', result: shipProbe }] : []),
      ];
      for (let i = seq.length; i < totalRounds; i++) {
        seq.push({ label: `rehearse_r${i + 1}_flat`, result: base + (r1 - base) * Math.max(0.1, 0.8 - 0.1 * i) });
      }
      // Honor the brief-declared result_schema (gate #0 validates every round
      // against it): fill required fields by declared type — label/result carry
      // the trajectory, everything else gets a type-correct placeholder.
      const roundPayload = (label: string, result: number): string => {
        const payload: Record<string, unknown> = { label, result };
        const schema = rc.resultSchema as { required?: string[]; properties?: Record<string, { type?: string }> } | undefined;
        for (const field of schema?.required ?? []) {
          if (field in payload) continue;
          const t = schema?.properties?.[field]?.type;
          // Numeric placeholders must clear any brief-declared field floor
          // (gate #3) — the rehearsal probes the gates, it shouldn't trip them.
          payload[field] = field === 'result_std' && resultStd !== undefined
            ? resultStd
            : t === 'number' ? (fieldFloors[field] ?? result)
            : t === 'boolean' ? true : `rehearsal_${field}`;
        }
        for (const [field, min] of Object.entries(fieldFloors)) {
          if (typeof payload[field] !== 'number' || (payload[field] as number) < min) payload[field] = min;
        }
        return JSON.stringify(payload);
      };
      const script: Record<string, import('./adapters/scripted.js').StageScript> = {
        plan: seq.map((r, i) => {
          const measureId = `measure_${i + 1}`;
          const finalDependency = criterionIds.length > 0 ? 'rehearsal_gate' : measureId;
          const stages: Array<Record<string, unknown>> = [
            {
              id: measureId,
              role: 'researcher',
              depends_on: [],
              dependency_reasons: {},
              scope: [resultRel, `${resultRel}.no_candidate.json`],
              criterion_refs: criterionIds,
              prompt_template: `rehearsal round ${r.label}`,
            },
          ];
          if (criterionIds.length > 0) {
            stages.push({
              id: 'rehearsal_gate',
              role: 'qa',
              depends_on: [measureId],
              dependency_reasons: { [measureId]: 'verify the synthetic round against every canonical criterion' },
              scope: [],
              is_gate: true,
              criterion_refs: criterionIds,
              prompt_template: 'verify the rehearsal round and report canonical criterion evidence',
            });
          }
          stages.push({
            id: 'research_finalize',
            role: 'researcher',
            depends_on: [finalDependency],
            dependency_reasons: { [finalDependency]: 'commit only the settled policy outcome' },
            scope: [...new Set(Object.values(ts ?? {}).flatMap((entry) => entry.paths ?? []))],
            condition: 'research.decision != continue',
            prompt_template: 'write only the terminal path selected by research_decision.json',
          });
          return { runFiles: { 'dispatch.yaml': JSON.stringify(stages, null, 2) } };
        }),
      };
      if (criterionIds.length > 0) {
        script.rehearsal_gate = {
          runFiles: {
            'verdict_rehearsal_gate.json': JSON.stringify({
              pass: true,
              reason: 'synthetic rehearsal evidence is structurally complete',
              criteria: Object.fromEntries(criterionIds.map((id) => [id, {
                status: 'judgement',
                evidence: 'The scripted rehearsal proves transport and settlement; semantic satisfaction remains a real gate responsibility.',
              }])),
            }),
          },
          output: 'rehearsal criterion transport verified',
        };
      }
      seq.forEach((r, i) => {
        script[`measure_${i + 1}`] = {
          projectFiles: { [resultRel]: roundPayload(r.label, r.result) },
          output: `rehearsal measured ${r.label} = ${r.result}`,
        };
      });

      const agentsDir = join(import.meta.dirname ?? '.', '..', 'config', 'agents');
      const { config, raw } = scheduler.loadWorkflow(join(import.meta.dirname ?? '.', '..', 'config', 'workflows', 'research.yaml'));
      config.defaults.max_iterations = seq.length + 3;

      const scriptedAdapter = new ScriptedAdapter(script);
      const declaredTerminalPaths = new Set(
        Object.values(ts ?? {}).flatMap((entry) => entry.paths ?? []),
      );
      const terminalizingAdapter = (
        scripted: InstanceType<typeof ScriptedAdapter>,
      ): import('./adapters/base.js').Adapter => ({
        async run(prompt, role, opts) {
          if (opts.stageId !== 'research_finalize') {
            return scripted.run(prompt, role, opts);
          }
          let terminalPath = '';
          let terminalStatus = '';
          try {
            const decision = JSON.parse(readFileSync(join(opts.runDir, 'research_decision.json'), 'utf-8')) as {
              terminalPath?: unknown;
              terminalStatus?: unknown;
            };
            terminalPath = typeof decision.terminalPath === 'string' ? decision.terminalPath : '';
            terminalStatus = typeof decision.terminalStatus === 'string' ? decision.terminalStatus : '';
          } catch {
            return { output: 'research decision is missing', exitCode: 1, duration_ms: 1 };
          }
          const target = resolve(opts.workDir, terminalPath);
          const rel = relative(resolve(opts.workDir), target);
          if (!declaredTerminalPaths.has(terminalPath) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            return { output: `invalid rehearsal terminal path: ${terminalPath}`, exitCode: 1, duration_ms: 1 };
          }
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, `# Rehearsal ${terminalStatus}\n\nSelected mechanically by the simulated research policy.\n`, 'utf-8');
          return {
            output: `wrote ${terminalPath}`,
            exitCode: 0,
            duration_ms: 1,
            writes: [terminalPath],
            writeAttribution: 'structured',
          };
        },
      });
      const adapter = terminalizingAdapter(scriptedAdapter);
      const t0 = Date.now();
      const state = await scheduler.runWorkflow(
        config, raw, tempProject, adapter, new Map(), undefined, agentsDir,
        undefined, brief, true, false, undefined, false,
      );
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const runDirPath = join(tempFcHome, 'runs', state.runId!);
      rehearsalRunDir = runDirPath;

      // ---------- verdicts on the simulated run ----------
      const statusResolution = resolveRunStatus(state.status);
      const rehearsalConsequence = statusResolution.kind === 'known'
        ? REHEARSAL_RUN_CONSEQUENCES[statusResolution.status]
        : 'fail';
      if (rehearsalConsequence === 'ship_warning') {
        add('warn', 'Rehearsal terminal status = shipped — the confirm command passed in the sandbox; verify that it actually evaluates data rather than always exiting 0');
      } else if (rehearsalConsequence === 'ceiling_ok') {
        add('ok', `Rehearsal terminal status = ceiling_hit (${secs}s · 0 tokens)`);
      } else {
        const displayedStatus = statusResolution.kind === 'known'
          ? statusResolution.status
          : `unrecognized ${statusResolution.display}`;
        add('fail', `Rehearsal terminal status = ${displayedStatus}${state.failureReason ? ` — ${state.failureReason}` : ''}`);
      }

      let journalRounds = 0;
      try {
        const journal = JSON.parse(readFileSync(join(runDirPath, 'research_journal.json'), 'utf-8')) as { rounds: Array<{ label: string; result: number; confirmFailed?: boolean }> };
        journalRounds = journal.rounds.length;
        const decoy = journal.rounds.find((r) => r.label.includes('decoy'));
        const summary = journal.rounds.map((r) => `${r.label}=${r.result}${r.confirmFailed ? '(confirm rejected; excluded)' : ''}`).join(' · ');
        add('ok', `Round journal: ${summary}`);
        if (beat !== undefined && shipProbe === undefined) {
          add('warn', `No schema- and integrity-valid value can cross the declared ship target ${beat}; the ship outcome is not exercisable by this brief`);
        } else if (beat !== undefined) {
          if (!decoy) add('warn', 'The decoy round is missing from the journal — the ship path was not exercised');
          else if (decoy.confirmFailed) add('ok', 'The decoy proposed ship, confirm rejected it, the candidate was excluded, and the loop continued');
          else if (state.status !== store.RUN_STATUS.SHIPPED) add('warn', 'The decoy passed confirm but the terminal status is not shipped — inspect the confirm semantics');
        }
      } catch {
        add('fail', '`research_journal.json` is missing — the engine never consumed round results (check the `result_file` path)');
      }

      const floor = ts?.['ceiling_hit']?.floor;
      if (floor?.minAttemptedStages !== undefined && state.status === store.RUN_STATUS.CEILING_HIT) {
        if (journalRounds >= floor.minAttemptedStages) add('ok', `Ceiling floor satisfied: ${journalRounds} rounds ≥ required ${floor.minAttemptedStages}`);
        else add('warn', `Ceiling was submitted after only ${journalRounds} rounds, below floor ${floor.minAttemptedStages}, because the hard budget was exhausted`);
      }

      const declared = ts?.[state.status]?.paths?.[0];
      if (declared) {
        if (existsSync(join(tempProject, declared))) add('ok', `Terminal artifact exists at the declared path: ${declared}`);
        else add('fail', `Declared path ${declared} is missing after the terminal state — the terminal contract failed`);
      }

      if (rc.confirm && beat !== undefined && shipProbe !== undefined) {
        if (existsSync(join(runDirPath, 'research_confirm.json'))) add('ok', 'The confirm command was executed and recorded in `research_confirm.json`');
        else add('warn', 'Confirm was never executed — a ship decision may never have been proposed');
      }

      const pendingStages = Object.entries(state.stages ?? {}).filter(([, s]) => store.isPendingStageStatus(s.status));
      if (pendingStages.length > 0) add('fail', `run.json still contains pending stages: ${pendingStages.map(([k]) => k).join(', ')}`);

      // A no-candidate round can itself trigger a stopping rule, so it cannot
      // always coexist with the ship/confirm probe in one run. Exercise it in
      // a second isolated run using the same parsed brief and normal scheduler
      // ingestion path.
      const declaresNoCandidate = briefDeclaresNoCandidateOutcome(brief);
      if (declaresNoCandidate) {
        noCandidateProject = mkdtempSync(join(tmpdir(), 'fc-rehearse-no-candidate-'));
        initializeTemporaryGitRepository(noCandidateProject, tempFcHome);
        mkdirSync(join(noCandidateProject, dirname(resultRel)), { recursive: true });
        const noCandidateTurns = [
          { label: 'rehearse_no_candidate', noCandidate: true as const },
          ...seq.map((round) => ({ ...round, noCandidate: false as const })),
        ];
        const noCandidateScript: Record<string, import('./adapters/scripted.js').StageScript> = {
          plan: noCandidateTurns.map((round, index) => {
            const measureId = `probe_${index + 1}`;
            const finalDependency = criterionIds.length > 0 ? 'rehearsal_gate' : measureId;
            const stages: Array<Record<string, unknown>> = [{
              id: measureId,
              role: 'researcher',
              depends_on: [],
              dependency_reasons: {},
              scope: [resultRel, `${resultRel}.no_candidate.json`],
              criterion_refs: criterionIds,
              prompt_template: round.noCandidate
                ? 'write the declared no-candidate sidecar with outcome, label, and reason'
                : `rehearsal round ${round.label}`,
            }];
            if (criterionIds.length > 0) {
              stages.push({
                id: 'rehearsal_gate',
                role: 'qa',
                depends_on: [measureId],
                dependency_reasons: { [measureId]: 'verify the synthetic round against every canonical criterion' },
                scope: [],
                is_gate: true,
                criterion_refs: criterionIds,
                prompt_template: 'verify the rehearsal round and report canonical criterion evidence',
              });
            }
            stages.push({
              id: 'research_finalize',
              role: 'researcher',
              depends_on: [finalDependency],
              dependency_reasons: { [finalDependency]: 'commit only the settled policy outcome' },
              scope: [...declaredTerminalPaths],
              condition: 'research.decision != continue',
              prompt_template: 'write only the terminal path selected by research_decision.json',
            });
            return { runFiles: { 'dispatch.yaml': JSON.stringify(stages, null, 2) } };
          }),
        };
        if (criterionIds.length > 0 && script.rehearsal_gate) {
          noCandidateScript.rehearsal_gate = script.rehearsal_gate;
        }
        noCandidateTurns.forEach((round, index) => {
          noCandidateScript[`probe_${index + 1}`] = round.noCandidate
            ? {
                projectFiles: {
                  [`${resultRel}.no_candidate.json`]: JSON.stringify({
                    label: round.label,
                    outcome: 'no_candidate',
                    reason: 'the isolated rehearsal intentionally found no safe acting candidate',
                  }),
                },
                output: 'rehearsal wrote the canonical no-candidate sidecar',
              }
            : {
                projectFiles: { [resultRel]: roundPayload(round.label, round.result) },
                output: `rehearsal measured ${round.label} = ${round.result}`,
              };
        });
        const noCandidateWorkflow = scheduler.loadWorkflow(
          join(import.meta.dirname ?? '.', '..', 'config', 'workflows', 'research.yaml'),
        );
        noCandidateWorkflow.config.defaults.max_iterations = noCandidateTurns.length + 3;
        const noCandidateState = await scheduler.runWorkflow(
          noCandidateWorkflow.config,
          noCandidateWorkflow.raw,
          noCandidateProject,
          terminalizingAdapter(new ScriptedAdapter(noCandidateScript)),
          new Map(),
          undefined,
          agentsDir,
          undefined,
          brief,
          true,
          false,
          undefined,
          false,
        );
        noCandidateRunDir = join(tempFcHome, 'runs', noCandidateState.runId!);
        const noCandidateJournal = JSON.parse(
          readFileSync(join(noCandidateRunDir, 'research_journal.json'), 'utf-8'),
        ) as { rounds?: Array<{ label?: string; outcome?: string }> };
        const noCandidateRound = noCandidateJournal.rounds?.find((round) => round.outcome === 'no_candidate');
        const noCandidateMarker = readdirSync(noCandidateRunDir)
          .find((name) => /research_round_\d+_no_candidate_consumed\.json$/.test(name));
        if (noCandidateRound && noCandidateMarker) {
          add('ok', `Declared outcome no_candidate exercised: journal label=${noCandidateRound.label}; terminal status=${noCandidateState.status}; consumed artifact=${noCandidateMarker}`);
        } else {
          add('fail', 'Declared outcome no_candidate was not journaled and consumed by the isolated scheduler rehearsal');
        }
      }
      if (keep) {
        retainedArtifacts = { projectDir: tempProject, runDir: runDirPath };
        retainedOutcomeArtifacts = {
          ship_confirm_and_ceiling: { projectDir: tempProject, runDir: runDirPath },
          ...(noCandidateRunDir
            ? { no_candidate: { projectDir: noCandidateProject, runDir: noCandidateRunDir } }
            : {}),
        };
        add('ok', `Artifacts retained: project=${tempProject} run=${runDirPath}`);
      }
    } catch (error) {
      const retry = `flowcrew rehearse ${shellQuote(briefPath)} --static-only`;
      if (simulationPhase === 'git') {
        add('fail', `${gitSetupFailure(error)}\n  Next: git --version\n  Static fallback: ${retry}`);
      } else {
        add('fail', `The isolated scheduler rehearsal could not complete: ${conciseError(error)}\n  Next: ${retry}`);
      }
    } finally {
      for (const deferredRunDir of [rehearsalRunDir, noCandidateRunDir].filter(Boolean)) {
        // Keep the rehearsal home active until framework-owned debounced writes
        // settle. Restoring the caller's FC home first redirects their mutable
        // global path lookup into the caller after rehearsal returns.
        try {
          await settleDeferredRunWrites(deferredRunDir);
        } catch (error) {
          add('fail', `The isolated scheduler rehearsal left deferred writes pending: ${conciseError(error)}`);
        }
      }
      store.setFcGlobalDir(realFcHome);
      if (!keep) {
        rmSync(tempFcHome, { recursive: true, force: true });
        rmSync(tempProject, { recursive: true, force: true });
        if (noCandidateProject) rmSync(noCandidateProject, { recursive: true, force: true });
      }
    }
  }

  // ---------- report ----------
  closeDiagnostics();
  process.off('exit', closeDiagnostics);
  const fails = findings.filter((f) => f.level === 'fail').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  if (options.render !== false) {
    console.log(`\nRehearsal report — ${briefLabel}${simulated ? '' : ' (static checks only)'}\n`);
    for (const f of findings) console.log(`${mark[f.level]} ${f.text}`);
    console.log(`\nBrief admission: ${preflight.requiresAcknowledgement
      ? `explicit acknowledgement required for exact digest ${preflight.digest}`
      : `no explicit acknowledgement required for exact digest ${preflight.digest}`}`);
    console.log(`\n${fails === 0 ? '✅ Contract ready' : `❌ ${fails} contract problem${fails === 1 ? '' : 's'}`}${warns ? ` · ${warns} warning${warns === 1 ? '' : 's'}` : ''}`);
    console.log(`Engine diagnostics (not part of the verdict): ${diagnosticLogPath}`);
  }
  return {
    exitCode: rehearsalExitCode(findings),
    findings,
    simulated,
    preflight: {
      digest: preflight.digest,
      contractReady: preflight.contractReady,
      requiresAcknowledgement: preflight.requiresAcknowledgement,
    },
    outputInventory: {
      entries: outputInventory.entries.length,
      blocking: outputInventory.blocking.length,
    },
    diagnosticsLogPath: diagnosticLogPath,
    ...(retainedArtifacts ? { retainedArtifacts } : {}),
    ...(retainedOutcomeArtifacts ? { retainedOutcomeArtifacts } : {}),
  };
}

/**
 * Programmatic rehearsal for generated briefs. It has no CLI exit side effect and the
 * scheduler simulation remains confined to OS-temporary FC/project directories.
 */
export async function rehearseBriefIsolated(
  brief: string,
  options: IsolatedRehearsalOptions = {},
): Promise<IsolatedRehearsalResult> {
  return runRehearsal([options.label ?? 'generated-successor.md'], {
    ...options,
    briefText: brief,
    render: false,
  });
}

/** Short alias for callers which already establish that generated rehearsal is isolated. */
export const rehearseBrief = rehearseBriefIsolated;
