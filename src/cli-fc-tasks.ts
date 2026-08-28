import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FcTasksRefusal,
  createEngineTaskRunResolver,
  createTaskEntry,
  defaultFcEngineRoot,
  defaultFcTasksRoot,
  publicTaskEntries,
  readTaskLedger,
  renderFcTasks,
  resolveFcTaskRuns,
  resolveFcTasksSession,
  updateTaskEntry,
  type FcTaskRunResolver,
} from './fc-tasks.js';

type Writer = { write(chunk: string): unknown };

export interface FcTasksCliDependencies {
  stdin?: string;
  stdout?: Writer;
  stderr?: Writer;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  taskRunResolver?: FcTaskRunResolver;
}

interface ParsedArguments {
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

const COMMON_VALUE_OPTIONS = new Set([
  '--session',
  '--session-key',
  '--payload-arg',
  '--store-root',
  '--engine-root',
  '--max-entries',
]);

const RENDER_VALUE_OPTIONS = new Set([
  ...COMMON_VALUE_OPTIONS,
  '--columns',
  '--lines',
]);

const WRITE_VALUE_OPTIONS = new Set([
  ...COMMON_VALUE_OPTIONS,
  '--entry',
  '--flowcrew-task-id',
]);

export function fcTasksUsage(): string {
  return [
    'Usage:',
    '  flowcrew fc_tasks render [--session <id>] [--session-key <key>] [--payload-arg <json>] [--store-root <dir>] [--engine-root <dir>]',
    '  flowcrew fc_tasks list --json [--session <id>] [--store-root <dir>] [--engine-root <dir>]',
    '  flowcrew fc_tasks create --session <id> [--entry <json>] [--flowcrew-task-id <number>] [--store-root <dir>] [--engine-root <dir>]',
    '  flowcrew fc_tasks update <id> --session <id> [--entry <json>] [--flowcrew-task-id <number> | --clear-flowcrew-task-link] [--store-root <dir>] [--engine-root <dir>]',
    '',
    'Render reads a front-end JSON payload from stdin when no explicit selector or --payload-arg is present.',
    'Create and update read the entry JSON from stdin unless --entry is present.',
  ].join('\n');
}

function parseArguments(
  tokens: string[],
  valueOptions: ReadonlySet<string>,
  flagOptions: ReadonlySet<string>,
): ParsedArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    if (flagOptions.has(name)) {
      if (equals !== -1) throw new FcTasksRefusal(`${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!valueOptions.has(name)) throw new FcTasksRefusal(`unknown option ${name}`);
    const value = equals === -1 ? tokens[++index] : token.slice(equals + 1);
    if (value === undefined || value === '') throw new FcTasksRefusal(`${name} requires a value`);
    if (values.has(name)) throw new FcTasksRefusal(`${name} may be supplied only once`);
    values.set(name, value);
  }
  return { values, flags, positionals };
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new FcTasksRefusal(`${name} must be a positive integer`);
  return parsed;
}

function inputText(dependencies: FcTasksCliDependencies): string {
  if (dependencies.stdin !== undefined) return dependencies.stdin;
  if (process.stdin.isTTY) return '';
  return readFileSync(0, 'utf-8');
}

function storeRoot(
  parsed: ParsedArguments,
  dependencies: FcTasksCliDependencies,
): string {
  const env = dependencies.env ?? process.env;
  const selected = parsed.values.get('--store-root') ?? env.FC_TASKS_ROOT;
  return selected ? resolve(dependencies.cwd ?? process.cwd(), selected) : defaultFcTasksRoot();
}

function engineRoot(
  parsed: ParsedArguments,
  dependencies: FcTasksCliDependencies,
): string {
  const env = dependencies.env ?? process.env;
  const selected = parsed.values.get('--engine-root') ?? env.FC_HOME;
  return selected ? resolve(dependencies.cwd ?? process.cwd(), selected) : defaultFcEngineRoot();
}

function taskRunResolver(
  parsed: ParsedArguments,
  dependencies: FcTasksCliDependencies,
): FcTaskRunResolver {
  return dependencies.taskRunResolver
    ?? createEngineTaskRunResolver({ engineRoot: engineRoot(parsed, dependencies) });
}

function maxEntries(parsed: ParsedArguments): number | undefined {
  return positiveInteger(parsed.values.get('--max-entries'), '--max-entries');
}

function sessionPayload(
  parsed: ParsedArguments,
  dependencies: FcTasksCliDependencies,
  stdinMayContainPayload: boolean,
): { provided: boolean; text: string } | undefined {
  const argument = parsed.values.get('--payload-arg');
  if (argument !== undefined) return { provided: true, text: argument };
  if (!stdinMayContainPayload || parsed.values.has('--session')) return undefined;
  const stdin = inputText(dependencies);
  return stdin.trim() ? { provided: true, text: stdin } : undefined;
}

function resolveSessionForCommand(
  parsed: ParsedArguments,
  dependencies: FcTasksCliDependencies,
  stdinMayContainPayload: boolean,
) {
  const env = dependencies.env ?? process.env;
  return resolveFcTasksSession({
    explicitSession: parsed.values.get('--session'),
    payload: sessionPayload(parsed, dependencies, stdinMayContainPayload),
    sessionKey: parsed.values.get('--session-key'),
    environmentSession: env.CODEX_THREAD_ID,
  });
}

function parseEntry(
  parsed: ParsedArguments,
  dependencies: FcTasksCliDependencies,
): unknown {
  const text = parsed.values.get('--entry') ?? inputText(dependencies);
  if (!text.trim()) throw new FcTasksRefusal('entry JSON is required');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FcTasksRefusal(`entry is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeUsageError(stdout: Writer, message: string): number {
  stdout.write(`fc_tasks: usage error · ${message}\n`);
  return 2;
}

function writeRefusal(stderr: Writer, operation: string, error: unknown): number {
  stderr.write(`fc_tasks: refused ${operation} · ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

export function cmdFcTasks(
  args: string[],
  dependencies: FcTasksCliDependencies = {},
): number {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const requested = args[1];
  if (requested === '--help' || requested === '-h' || requested === 'help') {
    stdout.write(`${fcTasksUsage()}\n`);
    return 0;
  }
  const subcommand = requested ?? 'render';
  const tokens = requested === undefined ? [] : args.slice(2);

  if (subcommand === 'render') {
    try {
      const parsed = parseArguments(tokens, RENDER_VALUE_OPTIONS, new Set(['--help']));
      if (parsed.flags.has('--help')) {
        stdout.write(`${fcTasksUsage()}\n`);
        return 0;
      }
      if (parsed.positionals.length > 0) throw new FcTasksRefusal('render takes no positional arguments');
      const env = dependencies.env ?? process.env;
      const rendered = renderFcTasks({
        storeRoot: storeRoot(parsed, dependencies),
        explicitSession: parsed.values.get('--session'),
        payload: sessionPayload(parsed, dependencies, true),
        sessionKey: parsed.values.get('--session-key'),
        environmentSession: env.CODEX_THREAD_ID,
        columns: parsed.values.get('--columns') ?? env.COLUMNS,
        lines: parsed.values.get('--lines') ?? env.LINES,
        maxEntries: maxEntries(parsed),
        taskRunResolver: taskRunResolver(parsed, dependencies),
      });
      stdout.write(rendered.text);
      return 0;
    } catch (error) {
      return writeUsageError(stdout, error instanceof Error ? error.message : String(error));
    }
  }

  if (subcommand === 'list') {
    try {
      const parsed = parseArguments(tokens, COMMON_VALUE_OPTIONS, new Set(['--json', '--help']));
      if (parsed.flags.has('--help')) {
        stdout.write(`${fcTasksUsage()}\n`);
        return 0;
      }
      if (!parsed.flags.has('--json')) throw new FcTasksRefusal('list requires --json');
      if (parsed.positionals.length > 0) throw new FcTasksRefusal('list takes no positional arguments');
      const session = resolveSessionForCommand(parsed, dependencies, true);
      if (!session.ok) return writeRefusal(stderr, 'list', `${session.code}: ${session.detail}`);
      const ledger = readTaskLedger(storeRoot(parsed, dependencies), session.session, maxEntries(parsed));
      const entries = publicTaskEntries(ledger);
      const resolver = taskRunResolver(parsed, dependencies);
      const runLinks = resolveFcTaskRuns(entries, resolver);
      stdout.write(`${JSON.stringify({
        state: ledger.state,
        session: session.session,
        entries,
        runLinks: entries.map((entry, index) => ({ entryId: entry.id, ...runLinks[index] })),
        issues: ledger.issues,
      }, null, 2)}\n`);
      return ledger.state === 'unavailable'
        || ledger.issues.length > 0
        || runLinks.some(({ state }) => state === 'unavailable')
        ? 1
        : 0;
    } catch (error) {
      return writeUsageError(stdout, error instanceof Error ? error.message : String(error));
    }
  }

  if (subcommand === 'create') {
    try {
      const parsed = parseArguments(tokens, WRITE_VALUE_OPTIONS, new Set(['--help']));
      if (parsed.flags.has('--help')) {
        stdout.write(`${fcTasksUsage()}\n`);
        return 0;
      }
      if (parsed.positionals.length > 0) throw new FcTasksRefusal('create takes no positional arguments');
      const session = resolveSessionForCommand(parsed, dependencies, false);
      if (!session.ok) return writeRefusal(stderr, 'create', `${session.code}: ${session.detail}`);
      const entry = parseEntry(parsed, dependencies);
      createTaskEntry({
        storeRoot: storeRoot(parsed, dependencies),
        session: session.session,
        entry,
        maxEntries: maxEntries(parsed),
        flowcrewTaskId: positiveInteger(parsed.values.get('--flowcrew-task-id'), '--flowcrew-task-id'),
        taskRunResolver: taskRunResolver(parsed, dependencies),
      });
      stdout.write(`fc_tasks: created ${session.session}/${(entry as { id?: unknown }).id}\n`);
      return 0;
    } catch (error) {
      return writeRefusal(stderr, 'create', error);
    }
  }

  if (subcommand === 'update') {
    try {
      const parsed = parseArguments(tokens, WRITE_VALUE_OPTIONS, new Set(['--help', '--clear-flowcrew-task-link']));
      if (parsed.flags.has('--help')) {
        stdout.write(`${fcTasksUsage()}\n`);
        return 0;
      }
      if (parsed.positionals.length !== 1) throw new FcTasksRefusal('update requires exactly one id');
      const session = resolveSessionForCommand(parsed, dependencies, false);
      if (!session.ok) return writeRefusal(stderr, 'update', `${session.code}: ${session.detail}`);
      const entry = parseEntry(parsed, dependencies);
      updateTaskEntry({
        storeRoot: storeRoot(parsed, dependencies),
        session: session.session,
        id: parsed.positionals[0],
        entry,
        maxEntries: maxEntries(parsed),
        flowcrewTaskId: positiveInteger(parsed.values.get('--flowcrew-task-id'), '--flowcrew-task-id'),
        clearFlowcrewTaskLink: parsed.flags.has('--clear-flowcrew-task-link'),
        taskRunResolver: taskRunResolver(parsed, dependencies),
      });
      stdout.write(`fc_tasks: updated ${session.session}/${parsed.positionals[0]}\n`);
      return 0;
    } catch (error) {
      return writeRefusal(stderr, 'update', error);
    }
  }

  return writeUsageError(stdout, `unknown subcommand ${subcommand}`);
}
