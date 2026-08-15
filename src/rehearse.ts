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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectBrief, type BriefPreflightContext } from './brief-preflight.js';
import { routeLogsToFile } from './logging.js';
import { extractBriefPathMentions } from './ship-inputs.js';
import { resolveRunStatus, RUN_STATUS, type RunStatus } from './store.js';

export { lintInstrumentCriteria } from './brief-preflight.js';
export type { CriterionLintWarning } from './brief-preflight.js';

export interface Finding {
  level: 'ok' | 'warn' | 'fail';
  text: string;
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

export async function cmdRehearse(argv: string[]): Promise<void> {
  try {
    await runRehearsal(argv);
  } catch (error) {
    const briefPath = argv.find((arg) => !arg.startsWith('--')) ?? '<brief.md>';
    console.error(`Rehearsal could not complete safely: ${conciseError(error)}`);
    console.error(`Next: flowcrew rehearse ${shellQuote(briefPath)} --static-only`);
    process.exitCode = 1;
  }
}

async function runRehearsal(argv: string[]): Promise<void> {
  const briefPath = argv.find((a) => !a.startsWith('--'));
  if (!briefPath || !existsSync(briefPath)) {
    console.error('Usage: flowcrew rehearse <brief.md> [--keep] [--static-only]');
    process.exit(1);
  }
  const keep = argv.includes('--keep');
  const staticOnly = argv.includes('--static-only');
  const brief = readFileSync(briefPath, 'utf-8');
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
  const projectDir = process.env.PROJECT_DIR || process.cwd();
  const preflightContext = projectBriefPreflightContext(projectDir, brief);
  const preflight = inspectBrief(brief, preflightContext);
  for (const finding of preflight.findings) {
    add(finding.level, finding.message
      + (finding.risk ? `\n  Risk: ${finding.risk}` : '')
      + (finding.suggestion ? `\n  Suggestion: ${finding.suggestion}` : ''));
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
      mkdirSync(join(tempProject, dirname(resultRel)), { recursive: true });

      const hib = rc.higherIsBetter !== false;
      const sign = hib ? 1 : -1;
      const base = rc.baseline;
      const beat = rc.stop?.beat;
      // Trajectory sized FROM the brief's own stop rules and ceiling floor so a
      // policy-owned ceiling is actually reachable: one mild keeper strictly
      // below the ship target, one decoy AT the target (forcing ship→confirm),
      // then a declining tail long enough for halt_after_no_improvement, with
      // total rounds covering the declared floor (capped by max_rounds).
      const halt = rc.stop?.haltAfterNoImprovement;
      const maxR = rc.stop?.maxRounds;
      const floorN = ts?.['ceiling_hit']?.floor?.minAttemptedStages ?? 0;
      const head = 1 + (beat !== undefined ? 1 : 0);
      let totalRounds = Math.max(floorN, head + (halt ?? 3), head + 1);
      if (maxR !== undefined) totalRounds = Math.min(totalRounds, Math.max(maxR, head + 1));
      const r1 = beat !== undefined ? base + (beat - base) * 0.5 : base + sign * (Math.abs(base) * 0.1 + 1);
      const seq: Array<{ label: string; result: number }> = [
        { label: 'rehearse_r1_mild', result: r1 },
        ...(beat !== undefined ? [{ label: 'rehearse_r2_decoy', result: beat + sign }] : []),
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
        const fieldFloors = (rc.integrity as { fieldFloors?: Record<string, number> } | undefined)?.fieldFloors ?? {};
        for (const field of schema?.required ?? []) {
          if (field in payload) continue;
          const t = schema?.properties?.[field]?.type;
          // Numeric placeholders must clear any brief-declared field floor
          // (gate #3) — the rehearsal probes the gates, it shouldn't trip them.
          payload[field] = t === 'number' ? (fieldFloors[field] ?? result)
            : t === 'boolean' ? true : `rehearsal_${field}`;
        }
        for (const [field, min] of Object.entries(fieldFloors)) {
          if (typeof payload[field] !== 'number' || (payload[field] as number) < min) payload[field] = min;
        }
        return JSON.stringify(payload);
      };
      const script: Record<string, import('./adapters/scripted.js').StageScript> = {
        plan: seq.map((r, i) => ({
          runFiles: { 'dispatch.yaml': `- id: measure_${i + 1}\n  role: researcher\n  prompt_template: |\n    rehearsal round ${r.label}\n` },
        })),
      };
      seq.forEach((r, i) => {
        script[`measure_${i + 1}`] = {
          projectFiles: { [resultRel]: roundPayload(r.label, r.result) },
          output: `rehearsal measured ${r.label} = ${r.result}`,
        };
      });

      const agentsDir = join(import.meta.dirname ?? '.', '..', 'config', 'agents');
      const { config, raw } = scheduler.loadWorkflow(join(import.meta.dirname ?? '.', '..', 'config', 'workflows', 'research.yaml'));
      config.defaults.max_iterations = seq.length + 3;

      const adapter = new ScriptedAdapter(script);
      const t0 = Date.now();
      const state = await scheduler.runWorkflow(
        config, raw, tempProject, adapter, new Map(), undefined, agentsDir,
        undefined, brief, true, false, undefined, false,
      );
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const runDirPath = join(tempFcHome, 'runs', state.runId!);

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
        if (beat !== undefined) {
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

      if (rc.confirm && beat !== undefined) {
        if (existsSync(join(runDirPath, 'research_confirm.json'))) add('ok', 'The confirm command was executed and recorded in `research_confirm.json`');
        else add('warn', 'Confirm was never executed — a ship decision may never have been proposed');
      }

      const pendingStages = Object.entries(state.stages ?? {}).filter(([, s]) => store.isPendingStageStatus(s.status));
      if (pendingStages.length > 0) add('fail', `run.json still contains pending stages: ${pendingStages.map(([k]) => k).join(', ')}`);
      if (keep) add('ok', `Artifacts retained: project=${tempProject} run=${runDirPath}`);
    } catch (error) {
      const retry = `flowcrew rehearse ${shellQuote(briefPath)} --static-only`;
      if (simulationPhase === 'git') {
        add('fail', `${gitSetupFailure(error)}\n  Next: git --version\n  Static fallback: ${retry}`);
      } else {
        add('fail', `The isolated scheduler rehearsal could not complete: ${conciseError(error)}\n  Next: ${retry}`);
      }
    } finally {
      store.setFcGlobalDir(realFcHome);
      if (!keep) {
        rmSync(tempFcHome, { recursive: true, force: true });
        rmSync(tempProject, { recursive: true, force: true });
      }
    }
  }

  // ---------- report ----------
  closeDiagnostics();
  process.off('exit', closeDiagnostics);
  console.log(`\nRehearsal report — ${briefPath}${simulated ? '' : ' (static checks only)'}\n`);
  for (const f of findings) console.log(`${mark[f.level]} ${f.text}`);
  console.log(`\nBrief admission: ${preflight.requiresAcknowledgement
    ? `explicit acknowledgement required for exact digest ${preflight.digest}`
    : `no explicit acknowledgement required for exact digest ${preflight.digest}`}`);
  const fails = findings.filter((f) => f.level === 'fail').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  console.log(`\n${fails === 0 ? '✅ Contract ready' : `❌ ${fails} contract problem${fails === 1 ? '' : 's'}`}${warns ? ` · ${warns} warning${warns === 1 ? '' : 's'}` : ''}`);
  console.log(`Engine diagnostics (not part of the verdict): ${diagnosticLogPath}`);
  process.exit(rehearsalExitCode(findings));
}
