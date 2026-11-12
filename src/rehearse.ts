import { CliUsageError, commandUsage, parseCommandArgs } from './cli-args.js';
import { EXIT_CODE } from './exit-code.js';
/** Static declaration and capability inspection; never fabricates instrument results. */
import { mkdtempSync } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { inspectBrief } from './brief-preflight.js';
import { routeLogsToFile } from './logging.js';
import { inspectBriefOutputs } from './ship-inputs.js';


export interface Finding {
  code?: string;
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

export interface IsolatedRehearsalOptions {
  /** Project-aware static inspection; no scheduler stages are launched. */
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
  const staticOnly = options.staticOnly ?? parsed.flags.has('--static-only');
  const brief = options.briefText ?? readFileSync(briefPath, 'utf-8');
  const briefLabel = options.label ?? briefPath;
  const diagnosticsDir = mkdtempSync(join(tmpdir(), 'flowcrew-rehearse-diagnostics-'));
  const diagnosticLogPath = join(diagnosticsDir, 'engine.log');
  const closeDiagnostics = routeLogsToFile(diagnosticLogPath);
  process.once('exit', closeDiagnostics);

  const scheduler = await import('./scheduler.js');

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

  const simulated = false;
  const retainedArtifacts: IsolatedRehearsalResult['retainedArtifacts'] = undefined;
  if (!staticOnly && rc && !findings.some(f => f.level === 'fail')) {
    add('ok', `Validated ${rc.protocol} declaration and capability syntax. Rehearsal does not execute the frozen project instrument or fabricate verdicts.`);
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
