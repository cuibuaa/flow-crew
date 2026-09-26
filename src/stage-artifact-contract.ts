import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  compareLiveConstraintContentIdentities,
  readLiveConstraintContentIdentity,
  type LiveConstraintContentIdentity,
} from './live-constraint-guard.js';

export type StageArtifactObligationKind = 'prompt_artifact' | 'replay_command_target';

export interface StageArtifactObligation {
  kind: StageArtifactObligationKind;
  mention: string;
  path: string;
  source: 'prompt' | 'published_report';
  sourcePath?: string;
}

export interface StageArtifactContractViolation extends StageArtifactObligation {
  reason: string;
}

export interface StageArtifactContractAudit {
  version: 1;
  stageId: string;
  checkedAt: string;
  obligations: StageArtifactObligation[];
  producedPromptArtifacts: string[];
  replayExecutions: StageArtifactReplayExecution[];
  violations: StageArtifactContractViolation[];
}

export interface StageArtifactReplayExecution {
  command: string;
  sourcePath: string;
  runner: 'node_test' | 'vitest' | 'unsupported';
  targetPaths: string[];
  status: 'passed' | 'failed' | 'not_run';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  collectedTests: number;
  executedTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  stdout: string;
  stderr: string;
  reason: string;
}

export interface StageArtifactContractPreimage {
  path: string;
  identity: LiveConstraintContentIdentity;
}

export interface StageArtifactContractInput {
  stageId: string;
  template: string;
  projectDir: string;
  runDir: string;
  writes?: readonly string[];
  preimages?: readonly StageArtifactContractPreimage[];
  priorProducedPromptArtifacts?: readonly string[];
}

const PATH_TOKEN = /`([^`\s]+)`|((?:\/|\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)|(?:^|[\s("'])(([A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+))(?=$|[\s"',.;:)])/g;
const FILE_SUFFIX = /\.(?:md|json|ya?ml|toml|txt|csv|ts|tsx|js|jsx|mjs|cjs|py|sh|html|xml)$/i;
const NON_OBLIGATING = /\b(?:optional|illustrative|example|for example|if needed|if applicable|may write|might write)\b/i;
const COMMAND_START = /^(?:node\s+(?:--test\b|(?:\.\/)?node_modules\/vitest\/vitest\.mjs\b)|vitest\b|npx\s+vitest\b|npm\s+(?:(?:exec\s+)?vitest|test)\b|pnpm\s+(?:(?:exec\s+)?vitest|test)\b|yarn\s+(?:vitest|test)\b|(?:python(?:3)?\s+-m\s+)?pytest\b)/i;
const REPLAY_TIMEOUT_MS = 15_000;
const REPLAY_OUTPUT_LIMIT = 16_384;
const REPLAY_COMMAND_LIMIT = 4;
const REPLAY_TARGET_LIMIT = 8;
const requireFromHere = createRequire(import.meta.url);

interface ReplayTarget {
  mention: string;
  path: string;
}

interface ReplayCommandCandidate {
  command: string;
  source: StageArtifactObligation['source'];
  sourcePath?: string;
  runner: StageArtifactReplayExecution['runner'];
  targets: ReplayTarget[];
  testNamePattern?: string;
  parseError?: string;
}

function substitute(template: string, projectDir: string, runDir: string): string {
  return template
    .replace(/\{project\}/g, projectDir)
    .replace(/\{run_dir\}/g, runDir);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function cleanedMention(value: string): string {
  return value.trim().replace(/^["']|["',.;:)]$/g, '');
}

function resolveMention(
  mention: string,
  projectDir: string,
  runDir: string,
): string | undefined {
  const cleaned = cleanedMention(mention);
  if (!cleaned || /[*?{}[\]]/.test(cleaned) || !FILE_SUFFIX.test(cleaned)) return undefined;
  const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(projectDir, cleaned.replace(/^\.\//, ''));
  if (!within(projectDir, absolute) && !within(runDir, absolute)) return undefined;
  return absolute;
}

function pathMentions(text: string): string[] {
  const mentions: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const value = cleanedMention(match[1] ?? match[2] ?? match[3] ?? '');
    if (value && !mentions.includes(value)) mentions.push(value);
  }
  return mentions;
}

function commandText(value: string): string {
  let text = value.trim();
  if (text.startsWith('`') && text.endsWith('`') && text.length > 1) {
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('$ ')) text = text.slice(2).trim();
  return text;
}

function replayCommandTexts(text: string): string[] {
  const commands: string[] = [];
  const add = (value: string, commandContext: boolean): void => {
    const candidate = commandText(value);
    const ambiguousBareVitest = /^vitest\b/i.test(candidate) && !/^vitest\s+(?:run|--run)\b/i.test(candidate);
    if (candidate
      && COMMAND_START.test(candidate)
      && (commandContext || !ambiguousBareVitest)
      && !commands.includes(candidate)) {
      commands.push(candidate);
    }
  };
  let inCodeFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (NON_OBLIGATING.test(line)) continue;
    const explicit = line.match(/replay command\s*:\s*(.+)$/i)?.[1];
    if (explicit) add(explicit, true);
    for (const inline of line.matchAll(/`([^`\r\n]+)`/g)) add(inline[1] ?? '', true);
    const plain = line.trim().replace(/^[-*]\s+/, '');
    add(plain, inCodeFence);
  }
  return commands;
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  const push = (): void => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    word += character;
    started = true;
  }
  if (escaped || quote) return undefined;
  push();
  return words;
}

function resolveReplayTarget(token: string, projectDir: string): ReplayTarget | undefined {
  const mention = cleanedMention(token);
  if (!mention || mention.startsWith('-') || /[*?{}[\]]/.test(mention) || !FILE_SUFFIX.test(mention)) {
    return undefined;
  }
  const path = isAbsolute(mention)
    ? resolve(mention)
    : resolve(projectDir, mention.replace(/^\.\//, ''));
  return within(projectDir, path) ? { mention, path } : undefined;
}

function parseRunnerArguments(
  runner: 'node_test' | 'vitest',
  args: readonly string[],
  projectDir: string,
): Pick<ReplayCommandCandidate, 'targets' | 'testNamePattern' | 'parseError'> {
  const targets: ReplayTarget[] = [];
  let testNamePattern: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--' || argument === 'run' || argument === '--run' || (runner === 'node_test' && argument === '--test')) {
      continue;
    }
    const patternName = runner === 'node_test' ? '--test-name-pattern' : '--testNamePattern';
    if (argument === patternName || (runner === 'vitest' && argument === '-t')) {
      const value = args[index + 1];
      if (!value || value.length > 256) {
        return { targets, parseError: `${argument} requires a bounded pattern value` };
      }
      testNamePattern = value;
      index += 1;
      continue;
    }
    if (argument.startsWith(`${patternName}=`)) {
      const value = argument.slice(patternName.length + 1);
      if (!value || value.length > 256) {
        return { targets, parseError: `${patternName} requires a bounded pattern value` };
      }
      testNamePattern = value;
      continue;
    }
    const target = resolveReplayTarget(argument, projectDir);
    if (target) {
      if (!targets.some((entry) => entry.path === target.path)) targets.push(target);
      continue;
    }
    return { targets, parseError: `argument ${JSON.stringify(argument)} is outside the bounded replay grammar` };
  }
  if (targets.length === 0) return { targets, parseError: 'no exact project-contained test file was named' };
  if (targets.length > REPLAY_TARGET_LIMIT) {
    return { targets, testNamePattern, parseError: `more than ${REPLAY_TARGET_LIMIT} test files were named` };
  }
  return { targets, ...(testNamePattern ? { testNamePattern } : {}) };
}

function packageTestCommand(projectDir: string): string[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8')) as {
      scripts?: { test?: unknown };
    };
    const script = parsed.scripts?.test;
    return typeof script === 'string' ? shellWords(script) : undefined;
  } catch {
    return undefined;
  }
}

function parseReplayCommand(
  command: string,
  source: StageArtifactObligation['source'],
  projectDir: string,
  sourcePath?: string,
): ReplayCommandCandidate {
  const words = shellWords(command);
  const fallbackTargets = pathMentions(command)
    .map((mention) => resolveReplayTarget(mention, projectDir))
    .filter((target): target is ReplayTarget => target !== undefined);
  const unsupported = (reason: string): ReplayCommandCandidate => ({
    command,
    source,
    ...(sourcePath ? { sourcePath } : {}),
    runner: 'unsupported',
    targets: fallbackTargets,
    parseError: reason,
  });
  if (!words || words.length === 0) return unsupported('the command has unbalanced quoting or escaping');
  if (words.some((word) => ['&&', '||', ';', '|', '>', '>>', '<'].includes(word))) {
    return unsupported('shell operators are not accepted');
  }

  let runner: 'node_test' | 'vitest';
  let args: string[];
  const executable = words[0]?.toLowerCase();
  if (executable === 'node' && words[1] === '--test') {
    runner = 'node_test';
    args = words.slice(1);
  } else if (executable === 'node' && /^(?:\.\/)?node_modules\/vitest\/vitest\.mjs$/i.test(words[1] ?? '')) {
    runner = 'vitest';
    args = words.slice(2);
  } else if (executable === 'vitest') {
    runner = 'vitest';
    args = words.slice(1);
  } else if (executable === 'npx' && words[1]?.toLowerCase() === 'vitest') {
    runner = 'vitest';
    args = words.slice(2);
  } else if (executable === 'npm' && words[1]?.toLowerCase() === 'exec') {
    const tail = words.slice(2);
    if (tail[0] === '--') tail.shift();
    if (tail[0]?.toLowerCase() !== 'vitest') return unsupported('npm exec may invoke only vitest');
    tail.shift();
    runner = 'vitest';
    args = tail;
  } else if (executable === 'pnpm' && ['exec', 'vitest'].includes(words[1]?.toLowerCase() ?? '')) {
    const offset = words[1]?.toLowerCase() === 'exec' ? 2 : 1;
    if (words[offset]?.toLowerCase() !== 'vitest') return unsupported('pnpm exec may invoke only vitest');
    runner = 'vitest';
    args = words.slice(offset + 1);
  } else if (executable === 'yarn' && words[1]?.toLowerCase() === 'vitest') {
    runner = 'vitest';
    args = words.slice(2);
  } else if ((executable === 'npm' || executable === 'pnpm' || executable === 'yarn')
    && words[1]?.toLowerCase() === 'test') {
    const script = packageTestCommand(projectDir);
    if (!script || script.length === 0) return unsupported('the project test script is absent or not statically parseable');
    const forwarded = words.slice(2).filter((word) => word !== '--');
    const parsed = parseReplayCommand(
      [...script, ...forwarded].join(' '),
      source,
      projectDir,
      sourcePath,
    );
    return {
      ...parsed,
      command,
      source,
      ...(sourcePath ? { sourcePath } : {}),
    };
  } else {
    return unsupported('only node --test and project-local vitest commands are executable');
  }

  const parsed = parseRunnerArguments(runner, args, projectDir);
  return {
    command,
    source,
    ...(sourcePath ? { sourcePath } : {}),
    runner,
    targets: parsed.targets,
    ...(parsed.testNamePattern ? { testNamePattern: parsed.testNamePattern } : {}),
    ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
  };
}

function replayCommands(
  text: string,
  source: StageArtifactObligation['source'],
  projectDir: string,
  sourcePath?: string,
): ReplayCommandCandidate[] {
  return replayCommandTexts(text).map((command) => (
    parseReplayCommand(command, source, projectDir, sourcePath)
  ));
}

function promptArtifactObligations(
  template: string,
  projectDir: string,
  runDir: string,
): StageArtifactObligation[] {
  const obligations: StageArtifactObligation[] = [];
  for (const line of substitute(template, projectDir, runDir).split(/\r?\n/)) {
    const imperative = line.match(/^\s*(?:[-*]\s*)?(?:write|create|produce|publish|save|emit)\b\s+(.+)$/i);
    if (!imperative || NON_OBLIGATING.test(line)) continue;
    const artifactClause = imperative[1]
      .split(/\b(?:with\s+)?replay command\s*:/i)[0]
      .split(/\b(?:selected by|described by|provided by|read from|based on|according to|using)\b/i)[0];
    for (const mention of pathMentions(artifactClause)) {
      const path = resolveMention(mention, projectDir, runDir);
      if (path) obligations.push({ kind: 'prompt_artifact', mention, path, source: 'prompt' });
    }
  }
  return obligations;
}

function commandTargetObligations(
  text: string,
  source: StageArtifactObligation['source'],
  projectDir: string,
  sourcePath?: string,
): StageArtifactObligation[] {
  const obligations: StageArtifactObligation[] = [];
  for (const command of replayCommands(text, source, projectDir, sourcePath)) {
    for (const target of command.targets) {
      obligations.push({
        kind: 'replay_command_target',
        mention: target.mention,
        path: target.path,
        source,
        ...(sourcePath ? { sourcePath } : {}),
      });
    }
  }
  return obligations;
}

function readableMarkdown(path: string): string | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > 1_000_000) return undefined;
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function boundedOutput(value: string | Buffer | null | undefined): string {
  const text = typeof value === 'string' ? value : value?.toString('utf-8') ?? '';
  if (text.length <= REPLAY_OUTPUT_LIMIT) return text;
  return `${text.slice(0, REPLAY_OUTPUT_LIMIT)}\n[output truncated by artifact replay audit]`;
}

function summaryCount(output: string, label: string): number {
  const match = output.match(new RegExp(`^# ${label}\\s+(\\d+)\\s*$`, 'mi'));
  return match ? Number.parseInt(match[1], 10) : 0;
}

interface ReplayProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function runNodeProcess(args: readonly string[], projectDir: string): ReplayProcessResult {
  const result = spawnSync(process.execPath, [...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CI: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    timeout: REPLAY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 1_048_576,
    windowsHide: true,
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function resolveVitestCli(projectDir: string): string | undefined {
  for (const base of [projectDir, import.meta.dirname]) {
    try {
      const packagePath = requireFromHere.resolve('vitest/package.json', { paths: [base] });
      const cli = join(dirname(packagePath), 'vitest.mjs');
      if (existsSync(cli) && statSync(cli).isFile()) return cli;
    } catch { /* try the engine's development dependency after the project dependency */ }
  }
  return undefined;
}

function failedReplay(
  candidate: ReplayCommandCandidate,
  reason: string,
  processResult?: Partial<ReplayProcessResult>,
): StageArtifactReplayExecution {
  return {
    command: candidate.command,
    sourcePath: candidate.sourcePath ?? '',
    runner: candidate.runner,
    targetPaths: candidate.targets.map((target) => target.path),
    status: processResult ? 'failed' : 'not_run',
    exitCode: processResult?.exitCode ?? null,
    signal: processResult?.signal ?? null,
    timedOut: processResult?.timedOut ?? false,
    collectedTests: 0,
    executedTests: 0,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    stdout: boundedOutput(processResult?.stdout),
    stderr: boundedOutput(processResult?.stderr),
    reason,
  };
}

function executeNodeReplay(candidate: ReplayCommandCandidate, projectDir: string): StageArtifactReplayExecution {
  let exitCode: number | null = 0;
  let signal: NodeJS.Signals | null = null;
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let collectedTests = 0;
  let executedTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;
  for (const target of candidate.targets) {
    const args = ['--test', '--test-reporter=tap'];
    if (candidate.testNamePattern) args.push(`--test-name-pattern=${candidate.testNamePattern}`);
    args.push(target.path);
    const result = runNodeProcess(args, projectDir);
    exitCode = exitCode === 0 ? result.exitCode : exitCode;
    signal ??= result.signal;
    timedOut ||= result.timedOut;
    stdout += `${stdout ? '\n' : ''}${result.stdout}`;
    stderr += `${stderr ? '\n' : ''}${result.stderr}`;

    const reportedTests = summaryCount(result.stdout, 'tests');
    const reportedPasses = summaryCount(result.stdout, 'pass');
    const reportedFailures = summaryCount(result.stdout, 'fail');
    const reportedSkipped = summaryCount(result.stdout, 'skipped');
    // Node wraps a file that registered no tests as one passing file-level
    // subtest. Its child TAP plan is still the authoritative zero population.
    const emptyFilePlan = /^1\.\.0\s*$/m.test(result.stdout);
    collectedTests += emptyFilePlan ? 0 : reportedTests;
    executedTests += emptyFilePlan ? 0 : reportedPasses + reportedFailures;
    passedTests += emptyFilePlan ? 0 : reportedPasses;
    failedTests += emptyFilePlan ? 0 : reportedFailures;
    skippedTests += emptyFilePlan ? 0 : reportedSkipped;
  }
  const processResult = { exitCode, signal, timedOut, stdout: boundedOutput(stdout), stderr: boundedOutput(stderr) };
  let reason = 'the replay exited zero and exercised at least one collected test in every named file';
  if (timedOut) reason = `the replay exceeded the ${REPLAY_TIMEOUT_MS}ms audit timeout`;
  else if (exitCode !== 0) reason = `the replay returned direct exit ${exitCode ?? 'null'}`;
  else if (collectedTests === 0) reason = 'the replay returned direct exit 0 but collected zero tests';
  else if (executedTests === 0) reason = `the replay returned direct exit 0 but executed zero of ${collectedTests} collected tests`;
  const passed = !timedOut && exitCode === 0 && collectedTests > 0 && executedTests > 0;
  return {
    command: candidate.command,
    sourcePath: candidate.sourcePath ?? '',
    runner: candidate.runner,
    targetPaths: candidate.targets.map((target) => target.path),
    status: passed ? 'passed' : 'failed',
    ...processResult,
    collectedTests,
    executedTests,
    passedTests,
    failedTests,
    skippedTests,
    reason,
  };
}

interface VitestJsonResult {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: Array<{
    name?: string;
    assertionResults?: Array<{ status?: string }>;
  }>;
}

function parseVitestJson(output: string): VitestJsonResult | undefined {
  const candidates = [output.trim(), ...output.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(candidate) as VitestJsonResult;
      if (typeof parsed.numTotalTests === 'number' && Array.isArray(parsed.testResults)) return parsed;
    } catch { /* try the next JSON-looking line */ }
  }
  return undefined;
}

function executeVitestReplay(candidate: ReplayCommandCandidate, projectDir: string): StageArtifactReplayExecution {
  const cli = resolveVitestCli(projectDir);
  if (!cli) return failedReplay(candidate, 'no project-local Vitest CLI could be resolved');
  const args = [cli, 'run', '--reporter=json', '--root', projectDir];
  if (candidate.testNamePattern) args.push('--testNamePattern', candidate.testNamePattern);
  args.push(...candidate.targets.map((target) => target.path));
  const processResult = runNodeProcess(args, projectDir);
  const parsed = parseVitestJson(processResult.stdout);
  if (!parsed) {
    return failedReplay(candidate, 'the Vitest replay did not emit a parseable JSON collection record', processResult);
  }
  const collectedTests = parsed.numTotalTests ?? 0;
  const passedTests = parsed.numPassedTests ?? 0;
  const failedTests = parsed.numFailedTests ?? 0;
  const skippedTests = parsed.numPendingTests ?? 0;
  const executedTests = passedTests + failedTests;
  const resultsByPath = new Map((parsed.testResults ?? []).map((result) => [resolve(result.name ?? ''), result]));
  const unexercisedTargets = candidate.targets.filter((target) => {
    const result = resultsByPath.get(resolve(target.path));
    return !result?.assertionResults?.some((assertion) => {
      const { status: outcome } = assertion;
      return outcome === 'passed' || outcome === 'failed';
    });
  });
  let reason = 'the replay exited zero and exercised at least one collected test in every named file';
  if (processResult.timedOut) reason = `the replay exceeded the ${REPLAY_TIMEOUT_MS}ms audit timeout`;
  else if (processResult.exitCode !== 0) reason = `the replay returned direct exit ${processResult.exitCode ?? 'null'}`;
  else if (collectedTests === 0) reason = 'the replay returned direct exit 0 but collected zero tests';
  else if (executedTests === 0) reason = `the replay returned direct exit 0 but executed zero of ${collectedTests} collected tests`;
  else if (unexercisedTargets.length > 0) {
    reason = `the replay did not exercise a collected test from ${unexercisedTargets.map((target) => target.mention).join(', ')}`;
  }
  const passed = !processResult.timedOut
    && processResult.exitCode === 0
    && collectedTests > 0
    && executedTests > 0
    && unexercisedTargets.length === 0;
  return {
    command: candidate.command,
    sourcePath: candidate.sourcePath ?? '',
    runner: candidate.runner,
    targetPaths: candidate.targets.map((target) => target.path),
    status: passed ? 'passed' : 'failed',
    ...processResult,
    stdout: boundedOutput(processResult.stdout),
    stderr: boundedOutput(processResult.stderr),
    collectedTests,
    executedTests,
    passedTests,
    failedTests,
    skippedTests,
    reason,
  };
}

function executeReplayCommand(candidate: ReplayCommandCandidate, projectDir: string): StageArtifactReplayExecution {
  if (candidate.parseError) return failedReplay(candidate, candidate.parseError);
  const missing = candidate.targets.filter((target) => {
    try {
      return !existsSync(target.path)
        || !statSync(target.path).isFile()
        || !within(projectDir, realpathSync(target.path));
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    return failedReplay(candidate, `replay input is missing, unreadable, or resolves outside the project: ${missing.map((target) => target.mention).join(', ')}`);
  }
  return candidate.runner === 'node_test'
    ? executeNodeReplay(candidate, projectDir)
    : candidate.runner === 'vitest'
      ? executeVitestReplay(candidate, projectDir)
      : failedReplay(candidate, 'the command is outside the bounded replay grammar');
}

function dedupe(obligations: readonly StageArtifactObligation[]): StageArtifactObligation[] {
  const seen = new Set<string>();
  return obligations.filter((obligation) => {
    // A replay target can be named in both the stage prompt and the report it
    // asks the stage to publish. It is one existence contract, not two errors.
    const key = `${obligation.kind}\0${obligation.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function absoluteWritePath(
  write: string,
  projectDir: string,
  runDir: string,
): string | undefined {
  if (write.startsWith('run:')) {
    const path = resolve(runDir, write.slice('run:'.length));
    return within(runDir, path) ? path : undefined;
  }
  if (isAbsolute(write)) {
    const path = resolve(write);
    return within(projectDir, path) || within(runDir, path) ? path : undefined;
  }
  const path = resolve(projectDir, write.replace(/^\.\//, ''));
  return within(projectDir, path) ? path : undefined;
}

/** Capture prompt-owned artifact identities before an attempt starts. */
export function captureStageArtifactContractPreimages(
  input: Pick<StageArtifactContractInput, 'template' | 'projectDir' | 'runDir'>,
): StageArtifactContractPreimage[] {
  return dedupe(promptArtifactObligations(input.template, input.projectDir, input.runDir))
    .map((obligation) => ({
      path: obligation.path,
      identity: readLiveConstraintContentIdentity(obligation.path),
    }));
}

/**
 * Check only attributable, unambiguous promises: imperative file paths in the
 * stage's own template and exact test-file arguments in a requested replay
 * command. Examples, optional mentions and globs are not promoted into
 * obligations; command-shaped shell text is recorded but never handed to a
 * shell.
 */
export function inspectStageArtifactContract(input: StageArtifactContractInput): StageArtifactContractAudit {
  const promptObligations = promptArtifactObligations(
    input.template,
    input.projectDir,
    input.runDir,
  );
  const commandObligations = commandTargetObligations(
    substitute(input.template, input.projectDir, input.runDir),
    'prompt',
    input.projectDir,
  );
  const reportCandidates = new Set<string>();
  for (const obligation of promptObligations) {
    if (/\.md$/i.test(obligation.path)) reportCandidates.add(obligation.path);
  }
  for (const write of input.writes ?? []) {
    if (write.startsWith('run:')) continue;
    const path = resolveMention(write, input.projectDir, input.runDir);
    if (path && /\.md$/i.test(path)) reportCandidates.add(path);
  }
  const publishedObligations: StageArtifactObligation[] = [];
  const publishedCommands: ReplayCommandCandidate[] = [];
  for (const reportPath of reportCandidates) {
    const markdown = readableMarkdown(reportPath);
    if (markdown === undefined) continue;
    publishedObligations.push(...commandTargetObligations(
      markdown,
      'published_report',
      input.projectDir,
      reportPath,
    ));
    publishedCommands.push(...replayCommands(
      markdown,
      'published_report',
      input.projectDir,
      reportPath,
    ));
  }
  const obligations = dedupe([...promptObligations, ...commandObligations, ...publishedObligations]);
  const preimages = new Map((input.preimages ?? []).map((entry) => [resolve(entry.path), entry.identity]));
  const reportedWrites = new Set((input.writes ?? [])
    .map((write) => absoluteWritePath(write, input.projectDir, input.runDir))
    .filter((path): path is string => path !== undefined)
    .map((path) => resolve(path)));
  const producedPromptArtifacts = new Set((input.priorProducedPromptArtifacts ?? []).map((path) => resolve(path)));
  for (const obligation of promptObligations) {
    const path = resolve(obligation.path);
    if (reportedWrites.has(path)) {
      producedPromptArtifacts.add(path);
      continue;
    }
    const before = preimages.get(path);
    if (before && compareLiveConstraintContentIdentities(
      before,
      readLiveConstraintContentIdentity(path),
    ) === 'different') {
      producedPromptArtifacts.add(path);
    }
  }
  const existenceViolations = obligations.flatMap((obligation): StageArtifactContractViolation[] => {
    try {
      if (existsSync(obligation.path) && statSync(obligation.path).isFile()) {
        if (obligation.kind !== 'prompt_artifact' || producedPromptArtifacts.has(resolve(obligation.path))) {
          return [];
        }
        return [{
          ...obligation,
          reason: `stage prompt required ${obligation.mention}, but that exact file predated the stage and no attributable stage write produced or updated it`,
        }];
      }
    } catch { /* report as missing/unreadable below */ }
    return [{
      ...obligation,
      reason: obligation.kind === 'prompt_artifact'
        ? `stage prompt required ${obligation.mention}, but no readable file exists at that exact path`
        : !/[\\/]/.test(cleanedMention(obligation.mention))
          ? `published replay command cites bare filename ${obligation.mention}; bare replay targets resolve at the project root, and no readable input file exists there. Cite a full project-relative path to a project-contained artifact, or remove the replay citation if no executable input is intended`
          : `published replay command names ${obligation.mention}, but no readable input file exists at that exact project-relative path`,
    }];
  });
  const attributableReports = new Set([
    ...producedPromptArtifacts,
    ...reportedWrites,
  ].map((path) => resolve(path)));
  const uniquePublishedCommands = publishedCommands.filter((candidate, index, all) => (
    all.findIndex((entry) => (
      entry.command === candidate.command && entry.sourcePath === candidate.sourcePath
    )) === index
  ));
  const replayExecutions = uniquePublishedCommands
    .filter((candidate) => (
      candidate.targets.length > 0
      && candidate.sourcePath
      && attributableReports.has(resolve(candidate.sourcePath))
    ))
    .map((candidate, index) => executeReplayCommand(
      index < REPLAY_COMMAND_LIMIT
        ? candidate
        : { ...candidate, parseError: `more than ${REPLAY_COMMAND_LIMIT} replay commands were published` },
      input.projectDir,
  ));
  const executionViolations = replayExecutions.flatMap((execution): StageArtifactContractViolation[] => {
    if (execution.status === 'passed') return [];
    const command = uniquePublishedCommands.find((candidate) => (
      candidate.command === execution.command && candidate.sourcePath === execution.sourcePath
    ));
    if (!command) return [];
    return command.targets.filter((target) => !existenceViolations.some((violation) => (
      violation.kind === 'replay_command_target' && resolve(violation.path) === resolve(target.path)
    ))).map((target) => ({
      kind: 'replay_command_target',
      mention: target.mention,
      path: target.path,
      source: 'published_report',
      sourcePath: execution.sourcePath,
      reason: `published replay command ${JSON.stringify(execution.command)} was not verified: ${execution.reason}`,
    }));
  });
  return {
    version: 1,
    stageId: input.stageId,
    checkedAt: new Date().toISOString(),
    obligations,
    producedPromptArtifacts: [...producedPromptArtifacts].sort(),
    replayExecutions,
    violations: [...existenceViolations, ...executionViolations],
  };
}

export function writeStageArtifactContractAudit(runDir: string, audit: StageArtifactContractAudit): string {
  const path = join(runDir, 'stages', audit.stageId, 'artifact_contract.json');
  writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`, 'utf-8');
  return path;
}
