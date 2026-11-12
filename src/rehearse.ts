import { runRecordPath } from './run-layout.js';


import { CliUsageError, commandUsage, parseCommandArgs } from './cli-args.js';
import { EXIT_CODE } from './exit-code.js';
/** Dispatch rehearsal of the declaration-owned producer and property reviewer.
 * Uses ordinary stage execution with labelled scripted results. No model or
 * declared instrument runs; scientific calibration remains a real-run check. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { inspectBrief } from './brief-preflight.js';
import { extractBriefCriteria } from './brief-criteria.js';
import { log } from './scheduler/sched_admission/shared.js';
import { routeLogsToFile } from './logging.js';
import { inspectBriefOutputs } from './ship-inputs.js';


export interface Finding {
  code?: string;
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

export interface IsolatedRehearsalOptions {
  /** Used only for project-aware static inspection; the simulated run uses its own temp project. */
  projectDir?: string;
  /** Known launch project; source-only discovery leaves this unset. */
  targetDir?: string;
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

const mark = { ok: '✓', warn: '⚠', fail: '✗' } as const;

export function rehearsalExitCode(findings: ReadonlyArray<Finding>): 0 | 1 {
  return findings.some((finding) => finding.level === 'fail') ? EXIT_CODE.failed : EXIT_CODE.completed;
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
  try {
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
  } catch (error) {
    const exit = (error as { status?: number }).status;
    throw new Error(`Git could not create the isolated temporary repository${exit === undefined ? '' : ` (git exit ${exit})`}.`, { cause: error });
  }
}

export async function cmdRehearse(argv: string[]): Promise<void> {
  try {
    const result = await rehearseBrief(argv);
    process.exitCode = result.exitCode;
  } catch (error) {
    const briefPath = argv.find((arg) => !arg.startsWith('--')) ?? '<brief.md>';
    console.error(`Rehearsal could not complete safely: ${error instanceof CliUsageError ? error.message : conciseError(error)}`);
    console.error(`Next: flowcrew rehearse ${shellQuote(briefPath)} --static-only`);
    process.exitCode = 1;
  }
}

export async function rehearseBrief(argv: string[], options: RunRehearsalOptions = {}): Promise<IsolatedRehearsalResult> {
  const parsed = parseCommandArgs('rehearse', ['rehearse', ...argv]);
  const briefPath = parsed.positionals[0];
  const explicitProject = parsed.values.get('--project');
  const targetDir = parsed.values.get('--target') ?? options.targetDir;
  if (!briefPath || (options.briefText === undefined && !existsSync(briefPath))) {
    throw new Error(commandUsage('rehearse'));
  }
  const keep = options.keep ?? parsed.flags.has('--keep');
  const staticOnly = options.staticOnly ?? parsed.flags.has('--static-only');
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
  const projectDir = explicitProject ?? options.projectDir ?? process.env.PROJECT_DIR ?? process.cwd();
  const preflight = inspectBrief(brief);
  for (const finding of preflight.findings) {
    findings.push({ code: finding.code, level: finding.level, text: finding.message
      + (finding.risk ? `\n  Risk: ${finding.risk}` : '')
      + (finding.suggestion ? `\n  Suggestion: ${finding.suggestion}` : '') });
  }
  const outputInventory = preflight.findings.some(f => f.code === 'frontmatter_invalid')
    ? { declarations: [], entries: [], blocking: [] } : inspectBriefOutputs(brief, projectDir, undefined,
    { launchProject: targetDir ?? explicitProject ?? null });
  for (const entry of outputInventory.blocking) {
    add('fail', `Declared output ${entry.path} is already occupied (${entry.entryType}${entry.size === undefined ? '' : `, ${entry.size} bytes`}): ${entry.reason}`
      + '\n  Declare an explicit on_existing disposition only when the existing artifact is intentionally consumed; otherwise choose a fresh path.');
  }
  if (outputInventory.entries.length > 0 && outputInventory.blocking.length === 0) {
    add('ok', `Declared output inventory: ${outputInventory.entries.length} path(s), no implicit overwrite`);
  }
  const externalOutputs = outputInventory.entries.filter(entry => isAbsolute(entry.path));
  for (const entry of externalOutputs.filter(entry => !entry.blocking)) {
    if (entry.warning) add('warn', entry.warning);
    add('ok', `${entry.path}: ${entry.reason}; rehearsal uses a temporary substitute`);
  }
  add('ok', `Exact brief digest: ${preflight.digest}`);
  const fm = scheduler.parseBriefFrontmatter(brief);
  const rc = fm.research;

  let simulated = false;
  let retainedArtifacts: IsolatedRehearsalResult['retainedArtifacts'];
  if (!staticOnly && rc && !findings.some(f => f.level === 'fail')) {
    const tempFcHome = mkdtempSync(join(tmpdir(), 'fc-rehearse-home-'));
    const tempProject = mkdtempSync(join(tmpdir(), 'fc-rehearse-proj-'));
    const realFcHome = store.fcGlobalDir();
    store.setFcGlobalDir(tempFcHome);
    try {
      initializeTemporaryGitRepository(tempProject, tempFcHome);
      const { researchStages, admitResearchStages, researchStopReason, RESEARCH_REVIEW_CONTRACT } = await import('./scheduler/sched_policy/research.js');
      const { executeSingleStage } = await import('./scheduler/sched_settlement/stage-execution.js');
      const { runScopeSafeStageGroup, findAllReady } = await import('./scheduler/sched_loop/services.js');
      const { readGateEvaluation } = await import('./scheduler/sched_settlement/gate-verdict.js');
      const { recordAdmittedPlan } = await import('./plan-revisions.js');
      const stages = researchStages(rc);
      const { config, raw } = scheduler.loadWorkflow(join(import.meta.dirname, '..', 'config/workflows/research.yaml'));
      const reserved = store.reserveRun(tempProject);
      const created = store.initializeReservedRun(tempProject, reserved.runId, 'research', raw, stages.map(stage => stage.id));
      const admission = admitResearchStages(rc, stages, tempProject, created.runDirPath);
      if (!admission.pass) throw new Error(admission.errors.map(error => error.message).join('; '));
      const criteria = extractBriefCriteria(RESEARCH_REVIEW_CONTRACT);
      writeFileSync(runRecordPath(created.runDirPath, 'brief_criteria.json'), JSON.stringify(criteria));
      writeFileSync(runRecordPath(created.runDirPath, 'dispatch_admission.json'), JSON.stringify(admission));
      let state = store.readRunState(tempProject, created.runId);
      state.research = rc; state.currentIteration = 1;
      const precluded = researchStopReason(rc, [], state.startedAt, 0);
      if (precluded) throw new Error(`Research cannot dispatch a producer: ${precluded}`);
      recordAdmittedPlan(state, stages, created.runDirPath, 'Rehearsal of declared research shape', true, admission);
      store.writeRunState(tempProject, created.runId, state);
      const adapter = new ScriptedAdapter(Object.fromEntries(stages.map(stage => [stage.id, { output: JSON.stringify(stage.is_gate
        ? { pass: true, reason: 'Synthetic candidate-property verdict for dispatch rehearsal only.', remaining_work: [],
            criteria: Object.fromEntries(criteria.criteria.map(c => [c.id, { status: 'pass', evidence: 'Synthetic dispatch rehearsal; no scientific claim.' }])),
            audit_findings: { version: 1, findings: [] } }
        : { status: 'delivered', summary: 'Synthetic producer dispatch.', caveats: [], remaining_work: [], blocks: null,
            notes: { hypothesis: 'Rehearse dispatchability.', files_changed: [], property_evidence: 'No edits in rehearsal.' } }) }])));
      log.info({ stages: stages.map(stage => stage.id) }, 'Rehearsing the declaration-owned research shape');
      for (const stage of stages) {
        state = store.readRunState(tempProject, created.runId);
        if (!findAllReady(stages, state).some(ready => ready.id === stage.id)) throw new Error(`Research stage ${stage.id} cannot dispatch`);
        await runScopeSafeStageGroup([stage], tempProject, created.runId, 1, (item, boundary) => executeSingleStage(item,
          tempProject, created.runId, created.runDirPath, config, adapter, new Map(), join(import.meta.dirname, '..', 'config/agents'),
          state, stages, undefined, brief, undefined, undefined, undefined, undefined, undefined, boundary));
        state = store.readRunState(tempProject, created.runId);
        if (state.stages[stage.id]?.status !== store.STAGE_STATUS.COMPLETE) throw new Error(`Research stage ${stage.id} did not complete`);
        if (stage.is_gate && readGateEvaluation(tempProject, stage.id, created.runId)?.pass !== true) throw new Error('Research review did not accept the rehearsal submission');
      }
      if (!stages.some(stage => !stage.is_gate && adapter.calls.some(call => call.stageId === stage.id))) throw new Error('Research shape dispatched no producer');
      simulated = true;
      add('ok', `Real research shape dispatched: ${adapter.calls.map(call => call.stageId).join(' → ')}. No model chooser or terminal writer. Instrument commands were not executed; scientific measurements remain untested.`);
      if (keep) retainedArtifacts = { projectDir: tempProject, runDir: created.runDirPath };
    } catch (error) {
      add('fail', `The isolated scheduler rehearsal could not dispatch the real research shape: ${conciseError(error)}`);
      add('ok', `Next: git --version and inspect the diagnostic log. Static fallback: flowcrew rehearse ${shellQuote(briefPath)} --static-only`);
    } finally {
      store.setFcGlobalDir(realFcHome);
      if (!keep) { rmSync(tempFcHome, { recursive: true, force: true }); rmSync(tempProject, { recursive: true, force: true }); }
    }
  }

  // ---------- report ----------
  closeDiagnostics();
  process.off('exit', closeDiagnostics);
  const fails = findings.filter((f) => f.level === 'fail').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  if (options.render !== false) {
    console.log(`\nRehearsal report — ${briefLabel}${simulated ? '' : ' (static checks only)'}\n`);
    for (const f of findings) console.log(`${mark[f.level]} ${f.code ? `[${f.code}] ` : ''}${f.text}`);
    console.log(`\nBrief admission: launch binds exact digest ${preflight.digest}; preflight findings are advisory.`);
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
    },
    outputInventory: {
      entries: outputInventory.entries.length,
      blocking: outputInventory.blocking.length,
    },
    diagnosticsLogPath: diagnosticLogPath,
    ...(retainedArtifacts ? { retainedArtifacts } : {}),
  };
}
