import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  compareLiveConstraintContentIdentities,
  readLiveConstraintContentIdentity,
  type LiveConstraintContentIdentity,
} from './live-constraint-guard.js';
import { isGenericPathLexeme } from './path-lexeme.js';
import { discoverProjectValidation } from './project-validation.js';

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
  completionDeferred?: boolean;
  obligations: StageArtifactObligation[];
  producedPromptArtifacts: string[];
  replayExecutions: StageArtifactReplayExecution[];
  violations: StageArtifactContractViolation[];
}

export interface StageArtifactReplayExecution {
  command: string;
  sourcePath: string;
  runner: 'node_test' | 'vitest' | 'pytest' | 'unsupported';
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
const COMMAND_START = /^(?:node\s+(?:--test\b|(?:\.\/)?node_modules\/vitest\/vitest\.mjs\b)|vitest(?=\s|$)|npx\s+vitest(?=\s|$)|npm\s+(?:(?:exec\s+)?vitest|test)\b|pnpm\s+(?:(?:exec\s+)?vitest|test)\b|yarn\s+(?:vitest|test)\b|(?:python(?:3)?\s+-m\s+)?pytest\b)/i;
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
  pythonExecutable?: string;
  pytestEnvironment?: Record<string, string>;
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
  if (!cleaned || !isGenericPathLexeme(cleaned) || /[*?{}[\]]/.test(cleaned) || !FILE_SUFFIX.test(cleaned)) return undefined;
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

function externalHistoricalCommand(value: string, projectDir: string): boolean {
  const command = commandText(value);
  const words = shellWords(command);
  if (!words || !COMMAND_START.test(command) || /[;&|<>$]/.test(command)) return false;
  const executable = words[0]?.toLowerCase();
  let offset: number;
  if (executable === 'pytest' || executable === 'vitest') offset = 1;
  else if ((executable === 'python' || executable === 'python3')
    && words[1] === '-m' && words[2] === 'pytest') offset = 3;
  else if (executable === 'node' && words[1] === '--test') offset = 2;
  else if (executable === 'npx' && words[1]?.toLowerCase() === 'vitest') offset = 2;
  else return false;
  const mentions: string[] = [];
  for (let index = offset; index < words.length; index += 1) {
    const argument = words[index];
    if (['-q', '-qq', '-v', '--quiet', '--verbose'].includes(argument)) continue;
    if ((executable === 'vitest' || executable === 'npx')
      && index === offset && ['run', '--run'].includes(argument)) continue;
    if (argument === '-p' && words[index + 1] === 'no:cacheprovider') { index += 1; continue; }
    if (argument.startsWith('-')) return false;
    mentions.push(argument);
  }
  return mentions.length > 0 && mentions.every((mention) => {
    if (!isAbsolute(mention) || within(projectDir, mention)) return false;
    try {
      return existsSync(mention) && !within(projectDir, realpathSync(mention));
    } catch {
      return false;
    }
  });
}

function proseClauses(line: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  let inCode = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '`') inCode = !inCode;
    else if (line[index] === ';' && !inCode) {
      clauses.push(line.slice(start, index));
      start = index + 1;
    }
  }
  clauses.push(line.slice(start));
  return clauses;
}

function replayCommandTexts(text: string, projectDir: string): string[] {
  const commands: string[] = [];
  const add = (value: string, commandContext: boolean, explicitlyPublished = false): void => {
    const candidate = commandText(value);
    const ambiguousBareVitest = /^vitest(?=\s|$)/i.test(candidate) && !/^vitest\s+(?:run|--run)\b/i.test(candidate);
    if (candidate
      && (explicitlyPublished || COMMAND_START.test(candidate))
      && (explicitlyPublished || commandContext || !ambiguousBareVitest)
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
    const explicit = line.match(/replay command\s*:\s*(.+)$/i)?.[1];
    if (explicit) add(explicit, true, true);
    const plain = line.trim().replace(/^[-*]\s+/, '');
    const standalone = plain.match(/^`([^`\r\n]+)`\s*[.!]?$/);
    if (standalone) add(standalone[1] ?? '', true);
    // A historical citation exempts only its command. Prose about another
    // project cannot exempt a command with a project-relative test path.
    for (const clause of proseClauses(line)) {
      const inlines = [...clause.matchAll(/`([^`\r\n]+)`/g)];
      for (const inline of inlines) {
        if (!externalHistoricalCommand(inline[1] ?? '', projectDir)) {
          add(inline[1] ?? '', true);
        }
      }
    }
    for (const directive of plain.matchAll(/\b(?:run|execute|verify with|replay with)\s+`([^`\r\n]+)`/gi)) {
      add(directive[1] ?? '', true);
    }
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
  return { mention, path };
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

interface ConfiguredPytest {
  pythonExecutable: string;
  environment: Record<string, string>;
  /** True when the interpreter was proven from a Makefile recipe rather than a bare discovered default. */
  fromMakefile: boolean;
}

/** Resolve only a single, statically inspectable Makefile pytest recipe. */
function configuredPytest(projectDir: string): ConfiguredPytest | undefined {
  const test = discoverProjectValidation(projectDir).commands.find((command) => command.role === 'test');
  if (!test) return undefined;
  if ((test.command === 'python' || test.command === 'python3')
    && test.args[0] === '-m' && test.args[1] === 'pytest') {
    return { pythonExecutable: test.command, environment: {}, fromMakefile: false };
  }
  if (test.command !== 'make' || test.args[0] !== 'test') return undefined;
  try {
    // GNU Make chooses these names before Makefile when present.
    if (existsSync(join(projectDir, 'GNUmakefile')) || existsSync(join(projectDir, 'makefile'))) return undefined;
    // These can inject makefiles, command-line variables, or make -e without
    // changing the Makefile inspected below.
    if (['MAKEFLAGS', 'MFLAGS', 'GNUMAKEFLAGS', 'MAKEFILES', 'MAKEOVERRIDES']
      .some((name) => process.env[name])) return undefined;
    const lines = readFileSync(join(projectDir, 'Makefile'), 'utf-8').split(/\r?\n/);
    const variables = new Map<string, string>();
    const recipes: string[] = [];
    let testTargets = 0;
    let inTestRecipe = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || (!line.startsWith('\t') && trimmed.startsWith('#'))) continue;
      if (line.startsWith('\t')) {
        if (!inTestRecipe) return undefined;
        if (!/^\t\s*#/.test(line)) recipes.push(line.slice(1).trim());
        continue;
      }
      inTestRecipe = false;
      const variable = line.match(/^(PY|PYTHON)\s*(\?=|:=|=)\s*(\S+)\s*$/);
      if (variable) {
        if (variables.has(variable[1])
          || (variable[2] === '?=' && Object.hasOwn(process.env, variable[1]))) return undefined;
        variables.set(variable[1], variable[3]);
      } else if (/^\.PHONY\s*:\s*test\s*(?:#.*)?$/.test(line)) {
        continue;
      } else if (/^test\s*:\s*(?:#.*)?$/.test(line)) {
        testTargets += 1;
        inTestRecipe = true;
      } else {
        // Includes, conditionals, target-specific variables, alternate recipes,
        // and other make directives can change what `make test` executes.
        return undefined;
      }
    }
    if (testTargets !== 1 || recipes.length !== 1) return undefined;
    const words = shellWords(recipes[0]);
    if (!words) return undefined;
    const environment: Record<string, string> = {};
    while (words.length > 0 && /^[A-Z][A-Z0-9_]*=/.test(words[0])) {
      const assignment = words.shift()!;
      const separator = assignment.indexOf('=');
      const name = assignment.slice(0, separator);
      const value = assignment.slice(separator + 1);
      if (name === 'PYTHONPATH' && value === '.') environment.PYTHONPATH = '.';
      else if (name === 'PYTEST_ADDOPTS' && value === '-p no:cacheprovider') {
        environment.PYTEST_ADDOPTS = value;
      } else return undefined;
    }
    // Targeted replay clears inherited addopts; a make recipe without its own
    // assignment would otherwise run a different pytest selection.
    if (process.env.PYTEST_ADDOPTS && environment.PYTEST_ADDOPTS === undefined) return undefined;
    const configuredWord = words.shift();
    const variable = configuredWord?.match(/^\$\((PY|PYTHON)\)$/)?.[1];
    const pythonExecutable = variable ? variables.get(variable) : configuredWord;
    if (!pythonExecutable) return undefined;
    if (isAbsolute(pythonExecutable)) {
      if (!/^python(?:3(?:\.\d+)?)?$/.test(pythonExecutable.split(/[\\/]/).at(-1) ?? '')
        || !existsSync(pythonExecutable) || !statSync(pythonExecutable).isFile()) return undefined;
    } else if (!/^python(?:3(?:\.\d+)?)?$/.test(pythonExecutable)) return undefined;
    if (words.shift() !== '-m' || words.shift() !== 'pytest') return undefined;
    let collectionRoot = false;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (['-q', '-qq', '-v', '--quiet', '--verbose'].includes(word)) continue;
      if (word === '-p' && words[index + 1] === 'no:cacheprovider') { index += 1; continue; }
      const path = resolve(projectDir, word);
      if (within(projectDir, path) && existsSync(path)
        && within(projectDir, realpathSync(path))
        && ((word.endsWith('/') && statSync(path).isDirectory())
          || (/(?:^test_.+|.+_test)\.py$/i.test(word.split(/[\\/]/).at(-1) ?? '')
            && statSync(path).isFile()))) {
        collectionRoot = true;
        continue;
      }
      return undefined;
    }
    return collectionRoot ? { pythonExecutable, environment, fromMakefile: true } : undefined;
  } catch { /* unreadable configuration is not authorization */ }
  return undefined;
}

function parsePytestArguments(args: readonly string[], projectDir: string): Pick<ReplayCommandCandidate, 'targets' | 'parseError'> {
  const targets: ReplayTarget[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (['-q', '-qq', '--quiet', '-v', '--verbose'].includes(argument)) continue;
    if (argument === '-p' && args[index + 1] === 'no:cacheprovider') { index += 1; continue; }
    const target = resolveReplayTarget(argument, projectDir);
    if (!target || !/(?:^test_.+|.+_test)\.py$/i.test(target.path.split(/[\\/]/).at(-1) ?? '')) {
      return { targets, parseError: `argument ${JSON.stringify(argument)} is outside the bounded pytest replay grammar` };
    }
    if (!targets.some((entry) => entry.path === target.path)) targets.push(target);
  }
  if (targets.length === 0) return { targets, parseError: 'no exact project-contained Python test file was named' };
  if (targets.length > REPLAY_TARGET_LIMIT) return { targets, parseError: `more than ${REPLAY_TARGET_LIMIT} test files were named` };
  return { targets };
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

  const executable = words[0]?.toLowerCase();
  if (((executable === 'python' || executable === 'python3') && words[1] === '-m' && words[2] === 'pytest')
    || executable === 'pytest') {
    const configured = configuredPytest(projectDir);
    if (!configured) return unsupported('pytest is not the configured project test runner');
    const parsed = parsePytestArguments(words.slice(executable === 'pytest' ? 1 : 3), projectDir);
    return {
      command, source, ...(sourcePath ? { sourcePath } : {}),
      // A bare discovered default ("python") must not replace the interpreter the published
      // command names; only a proven Makefile recipe decides the interpreter.
      runner: 'pytest',
      pythonExecutable: configured.fromMakefile || executable === 'pytest' ? configured.pythonExecutable : executable,
      pytestEnvironment: configured.environment,
      targets: parsed.targets, ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    };
  }

  let runner: 'node_test' | 'vitest';
  let args: string[];
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
    return unsupported('only node --test, project-local vitest, and configured python -m pytest commands are executable');
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
  return replayCommandTexts(text, projectDir).map((command) => (
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
      const mentionIndex = artifactClause.indexOf(mention);
      const runLocal = mentionIndex >= 0
        && /\bthis run['’]s\s*[`"']?$/i.test(artifactClause.slice(0, mentionIndex));
      const path = resolveMention(mention, runLocal ? runDir : projectDir, runDir);
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
  pytestCounts?: { passed: number; failed: number; skipped: number };
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

function pytestJunitCounts(xml: string): ReplayProcessResult['pytestCounts'] {
  const suites = [...xml.matchAll(/<testsuite\s+([^>]+)>/g)];
  if (suites.length !== 1) return undefined;
  const count = (name: string): number | undefined => {
    const raw = suites[0][1].match(new RegExp(`(?:^|\\s)${name}="(\\d+)"`))?.[1];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const tests = count('tests');
  const failures = count('failures');
  const errors = count('errors');
  const skipped = count('skipped');
  if (tests === undefined || failures === undefined || errors === undefined || skipped === undefined
      || tests < failures + errors + skipped) return undefined;
  return { passed: tests - failures - errors - skipped, failed: failures + errors, skipped };
}

function runPytestProcess(candidate: ReplayCommandCandidate, target: ReplayTarget, projectDir: string): ReplayProcessResult {
  const auditDir = mkdtempSync(join(tmpdir(), 'flowcrew-pytest-replay-'));
  const junitPath = join(auditDir, 'results.xml');
  try {
    const result = spawnSync(candidate.pythonExecutable ?? 'python', [
      '-m', 'pytest', target.path, '-q', '-p', 'no:cacheprovider', `--junitxml=${junitPath}`,
    ], {
      cwd: projectDir,
      encoding: 'utf-8',
      env: { ...process.env, PYTEST_ADDOPTS: '', ...candidate.pytestEnvironment,
        CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1' },
      timeout: REPLAY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1_048_576,
      windowsHide: true,
    });
    let pytestCounts: ReplayProcessResult['pytestCounts'];
    try { pytestCounts = pytestJunitCounts(readFileSync(junitPath, 'utf8')); } catch { /* no trustworthy execution record */ }
    return {
      exitCode: result.status,
      signal: result.signal,
      timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error?.message ?? '',
      ...(pytestCounts ? { pytestCounts } : {}),
    };
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
  }
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

function executePytestReplay(candidate: ReplayCommandCandidate, projectDir: string): StageArtifactReplayExecution {
  let exitCode: number | null = 0;
  let signal: NodeJS.Signals | null = null;
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;
  let unexercisedTarget: string | undefined;
  let unverifiedTarget: string | undefined;
  for (const target of candidate.targets) {
    const result = runPytestProcess(candidate, target, projectDir);
    exitCode = exitCode === 0 ? result.exitCode : exitCode;
    signal ??= result.signal;
    timedOut ||= result.timedOut;
    stdout += `${stdout ? '\n' : ''}${result.stdout}`;
    stderr += `${stderr ? '\n' : ''}${result.stderr}`;
    const { passed = 0, failed = 0, skipped = 0 } = result.pytestCounts ?? {};
    if (!result.pytestCounts) unverifiedTarget ??= target.mention;
    passedTests += passed;
    failedTests += failed;
    skippedTests += skipped;
    if (passed + failed === 0) unexercisedTarget ??= target.mention;
    if (result.exitCode !== 0 || result.timedOut) break;
  }
  const executedTests = passedTests + failedTests;
  const collectedTests = executedTests + skippedTests;
  let reason = 'the configured pytest replay exited zero and exercised a collected test in every named file';
  if (timedOut) reason = `the replay exceeded the ${REPLAY_TIMEOUT_MS}ms audit timeout`;
  else if (exitCode !== 0) reason = `the replay returned direct exit ${exitCode ?? 'null'}`;
  else if (unverifiedTarget) reason = `pytest did not produce a valid JUnit execution record for ${unverifiedTarget}`;
  else if (unexercisedTarget) reason = `the replay did not exercise a collected test from ${unexercisedTarget}`;
  const passed = !timedOut && exitCode === 0 && !unverifiedTarget && !unexercisedTarget && executedTests > 0;
  return {
    command: candidate.command,
    sourcePath: candidate.sourcePath ?? '',
    runner: candidate.runner,
    targetPaths: candidate.targets.map((target) => target.path),
    status: passed ? 'passed' : 'failed',
    exitCode, signal, timedOut,
    collectedTests, executedTests, passedTests, failedTests, skippedTests,
    stdout: boundedOutput(stdout), stderr: boundedOutput(stderr), reason,
  };
}

function executeReplayCommand(candidate: ReplayCommandCandidate, projectDir: string): StageArtifactReplayExecution {
  if (candidate.parseError) return failedReplay(candidate, candidate.parseError);
  const missing = candidate.targets.filter((target) => {
    try {
      return !within(projectDir, target.path)
        || !existsSync(target.path)
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
      : candidate.runner === 'pytest'
        ? executePytestReplay(candidate, projectDir)
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

function producedPromptArtifactPaths(
  input: StageArtifactContractInput,
  obligations: readonly StageArtifactObligation[],
): Set<string> {
  const preimages = new Map((input.preimages ?? []).map((entry) => [resolve(entry.path), entry.identity]));
  const reportedWrites = new Set((input.writes ?? [])
    .map((write) => absoluteWritePath(write, input.projectDir, input.runDir))
    .filter((path): path is string => path !== undefined)
    .map((path) => resolve(path)));
  const produced = new Set((input.priorProducedPromptArtifacts ?? []).map((path) => resolve(path)));
  for (const obligation of obligations) {
    const path = resolve(obligation.path);
    if (reportedWrites.has(path)) {
      produced.add(path);
      continue;
    }
    const before = preimages.get(path);
    if (before && compareLiveConstraintContentIdentities(
      before,
      readLiveConstraintContentIdentity(path),
    ) === 'different') produced.add(path);
  }
  return produced;
}

/** Record durable production at a scope boundary without judging unfinished work. */
export function captureDeferredStageArtifactContract(input: StageArtifactContractInput): StageArtifactContractAudit {
  const obligations = dedupe(promptArtifactObligations(input.template, input.projectDir, input.runDir));
  return {
    version: 1,
    stageId: input.stageId,
    checkedAt: new Date().toISOString(),
    completionDeferred: true,
    obligations,
    producedPromptArtifacts: [...producedPromptArtifactPaths(input, obligations)]
      .filter((path) => {
        try { return statSync(path).isFile(); } catch { return false; }
      }).sort(),
    replayExecutions: [],
    violations: [],
  };
}

/**
 * Check only attributable, unambiguous promises: imperative file paths in the
 * stage's own template and exact test-file arguments in a requested replay
 * command. Optional file mentions and globs are not promoted into artifact
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
  const reportedWrites = new Set((input.writes ?? [])
    .map((write) => absoluteWritePath(write, input.projectDir, input.runDir))
    .filter((path): path is string => path !== undefined)
    .map((path) => resolve(path)));
  const producedPromptArtifacts = producedPromptArtifactPaths(input, promptObligations);
  const existenceViolations = obligations.flatMap((obligation): StageArtifactContractViolation[] => {
    if (obligation.kind === 'replay_command_target'
      && !within(input.projectDir, obligation.path)) {
      return [{
        ...obligation,
        reason: `published replay command names ${obligation.mention}, but the target is outside this project`,
      }];
    }
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
