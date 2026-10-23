// Pure command grammar: parsing and help share these tables; no engine imports or IO.
interface Option {
  flag?: boolean;
  optional?: boolean;
  alias?: string;
  integer?: number;
  max?: number;
  default?: string;
  required?: boolean;
  equalsOnly?: boolean;
  choices?: string[];
  refusal?: string;
  validate?: (value: string) => boolean;
  expected?: string;
}
interface Command {
  options: Record<string, Option>;
  positional?: string;
  maxPositionals?: number;
}
const values = (names: string): Record<string, Option> => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, {}]));
const flags = (names: string): Record<string, Option> => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, { flag: true }]));
const command = (options: Record<string, Option> = {}, positional?: string, maxPositionals = positional ? Infinity : 0): Command => ({ options, positional, maxPositionals });
const socket = values('socket');
const session = values('session session-key payload-arg store-root engine-root');
const ledger = { ...session, 'max-entries': { integer: 1 } };
const count = (defaultValue: string): Option => ({ integer: 0, default: defaultValue });
const timeout: Option = { integer: 0, max: 86_400_000, default: '60000' };
export const CLI_COMMANDS: Record<string, Command> = {
  init: command(),
  adapter: command({}, '[auto|codex|claude]', 1),
  doctor: command(flags('repair-registry compact-registry apply')),
  'ship-preflight': command({ ...flags('json'), ...values('project target campaign brief') }),
  rehearse: command({ ...flags('static-only keep'), ...values('project target') }, '<brief>', 1),
  'plan-check': command(values('brief run project'), '<dispatch-file>', 1),
  'ship-setup': command({ ...flags('json'), ...values('project'), ...Object.fromEntries(['brief', 'target', 'base', 'branch'].map(name => [name, { required: true }])) }),
  quick: command({
    ...values('project adapter workflow campaign task existing-run-id session brief-input-base64 brief-admission-record'),
    ...flags('no-campaign no-inherit-campaign background'),
    'max-iterations': { integer: 1 },
    'campaign-context': { equalsOnly: true, choices: ['inherit', 'skip'] },
    'acknowledge-brief-warnings': { optional: true },
    timeout: { refusal: 'The --timeout run override was removed; edit the engine config/defaults.yaml::default_timeout_ms instead.' },
  }, '<brief-path|task-text|->'),
  status: command({ ...flags('all details'), ...values('project') }),
  list: command({ limit: count('10') }),
  state: command({ ...values('project run'), ...flags('summary prompts') }),
  events: command({ ...values('run project stage type'), ...flags('json'), follow: { flag: true, alias: '-f' }, limit: { integer: 1, max: 10000, default: '100' } }),
  watch: command({ ...flags('once all'), poll: { default: '45', validate: value => /^(?:\d+|\d+\.\d+)$/.test(value) && Number(value) > 0 && Number(value) * 1000 <= 2_147_483_647, expected: 'must be a positive number of seconds within the Node timer range (at most 2147483.647 seconds)' } }),
  guide: command(values('run stage'), '"message"'),
  interrupt: command(values('run stage'), '["reason"]'),
  start: command(),
  'dashboard status': command({ port: { integer: 1, max: 65535 } }),
  'daemon start': command({ ...socket, ...flags('force') }),
  'daemon serve': command(socket),
  'daemon stop': command(socket),
  'daemon restart': command({ ...socket, ...flags('force') }),
  'daemon status': command(socket),
  'daemon logs': command({ ...socket, tail: count('100'), ...flags('follow') }),
  'daemon deploy': command({ ...socket, ...flags('force'), 'timeout-ms': timeout }),
  'daemon hold': command({ ...socket, 'timeout-ms': timeout }),
  'daemon hold-status': command({ ...socket, 'timeout-ms': timeout }),
  'daemon continue': command({ ...socket, 'timeout-ms': timeout }),
  'task list': command({ ...socket, ...values('status'), limit: { integer: 0 }, ...flags('with-summary') }),
  'task show': command({ ...socket, ...flags('summary-only raw') }, '<numeric-id>', 1),
  'task cancel': command(socket, '<numeric-id>', 1),
  'task resume': command(socket, '<numeric-id>', 1),
  'task retry': command(socket, '<numeric-id>', 1),
  'task tail': command({ ...socket, tail: count('100'), follow: { flag: true, alias: '-f' } }, '<numeric-id>', 1),
  'inbox list': command(values('state run')),
  'inbox show': command(values('run'), '<request-id>', 1),
  'inbox approve': command({ ...values('run reason'), ...flags('no-resume always') }, '<request-id>', 1),
  'inbox deny': command({ ...values('run reason'), ...flags('no-resume always') }, '<request-id>', 1),
  'audit-reality': command(values('task range output')),
  land: command({ ...values('complete-fc-task fc-task-session fc-tasks-root'), run: { required: true }, ...flags('json remove'), archive: { optional: true }, 'acknowledge-regenerable': { integer: 0 } }),
  export: command({}, '[run-id]', 1),
  prune: command({ ...values('run'), ...flags('dry-run apply json') }),
  clean: command({ keep: count('5') }),
  'fc_tasks render': command({ ...ledger, ...values('columns lines') }),
  'fc_tasks list': command({ ...ledger, ...flags('json') }),
  'fc_tasks reconcile': command({ ...ledger, ...flags('json') }),
  'fc_tasks create': command({ ...ledger, ...values('entry'), 'flowcrew-task-id': { integer: 1 } }),
  'fc_tasks update': command({ ...ledger, ...values('entry expected-run-id'), 'flowcrew-task-id': { integer: 1 }, ...flags('clear-flowcrew-task-link') }, '<id>', 1),
  'session-push wake-check': command(),
  'session-push wake': command(),
  'session-push ack': command(values('event session')),
  'session-push list': command(values('session')),
  'session-push bind-display': command(values('task thread session')),
  'session-push hook': command(values('frontend event')),
  'session-push statusline': command({ ...values('session'), ...flags('json') }),
  version: command(),
};

export interface ParsedCliArguments {
  help: boolean;
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
  order: string[];
}

export function commandUsage(name = ''): string {
  const entries = Object.entries(CLI_COMMANDS).filter(([key]) => !name || key === name || key.startsWith(`${name} `));
  if (!entries.length && name.includes(' ')) return commandUsage(name.split(' ').slice(0, -1).join(' '));
  return entries.map(([key, spec]) => `Usage: flowcrew ${key}${spec.positional ? ` ${spec.positional}` : ''}${Object.entries(spec.options).filter(([, option]) => !option.refusal).map(([flag, option]) => {
    const value = option.flag ? '' : option.optional ? '[=<value>]' : option.equalsOnly ? '=<value>' : ' <value>';
    return option.required ? ` --${flag}${value}` : ` [--${flag}${value}]`;
  }).join('')} [--help|-h]`).join('\n');
}

export function commandName(args: string[]): string {
  const first = args[0] ?? '';
  if (first === '--help' || first === '-h') return '';
  if (first === '--version' || first === '-v') return 'version';
  const paired = `${first} ${args[1] ?? ''}`;
  if (CLI_COMMANDS[paired]) return paired;
  if (first === 'fc_tasks' && args[1] === undefined) return 'fc_tasks render';
  return first;
}

// A usage failure carries its help through every command's existing error transport.
export class CliUsageError extends Error {
  constructor(name: string, message: string) {
    super(`${message}\n${commandUsage(name) || commandUsage()}`);
  }
}

export function parseCommandArgs(name: string, args: string[]): ParsedCliArguments {
  const spec = CLI_COMMANDS[name];
  const parsed: ParsedCliArguments = { help: false, values: new Map(), flags: new Set(), positionals: [], order: [] };
  const prefix = name.split(' ');
  const tokens = args[0] === prefix[0] ? args.slice(prefix.length)
    : name === 'version' && ['--version', '-v'].includes(args[0]) ? args.slice(1) : args;
  if (tokens.includes('--help') || tokens.includes('-h')) {
    parsed.help = true;
    return parsed;
  }
  if (!name && !tokens.length) { parsed.help = true; return parsed; }
  if (!spec) throw new CliUsageError(name, `Unknown command: ${name}`);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('-') || token === '-') { parsed.positionals.push(token); parsed.order.push(token); continue; }
    const equals = token.indexOf('=');
    const spelling = equals < 0 ? token : token.slice(0, equals);
    const key = spelling.startsWith('--') ? spelling.slice(2) : Object.keys(spec.options).find(key => spec.options[key].alias === spelling);
    const option = key === undefined ? undefined : spec.options[key];
    if (!option) throw new CliUsageError(name, `unknown ${name} option: ${token}`);
    const flag = `--${key}`;
    parsed.order.push(flag);
    if (option.refusal) throw new CliUsageError(name, option.refusal);
    if (option.flag) {
      if (equals >= 0) throw new CliUsageError(name, `${flag} does not take a value`);
      parsed.flags.add(flag);
      continue;
    }
    if (parsed.values.has(flag) || parsed.flags.has(flag)) throw new CliUsageError(name, `${flag} may be specified only once`);
    if (option.equalsOnly && equals < 0) throw new CliUsageError(name, `Invalid ${flag} syntax; use ${flag}=${option.choices?.join(` or ${flag}=`) ?? '<value>'}.`);
    if (option.optional && equals < 0) { parsed.flags.add(flag); continue; }
    const value = equals < 0 ? tokens[++index] : token.slice(equals + 1);
    if (!value || (equals < 0 && Object.entries(spec.options).some(([key, option]) => value === `--${key}` || value === option.alias))) throw new CliUsageError(name, `${flag} requires a value`);
    if (option.integer !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < option.integer || Number(value) > (option.max ?? Infinity))) {
      throw new CliUsageError(name, `${flag} requires a ${option.integer === 0 ? 'non-negative' : 'positive'} integer${option.max ? ` (at most ${option.max})` : ''}`);
    }
    if (option.validate && !option.validate(value)) throw new CliUsageError(name, `${flag} ${option.expected}`);
    if (option.choices && !option.choices.includes(value)) throw new CliUsageError(name, `Invalid ${flag} value "${value}"; expected ${option.choices.join(' or ')}.`);
    parsed.values.set(flag, value);
  }
  if (parsed.positionals.length > (spec.maxPositionals ?? 0)) throw new CliUsageError(name, `${name} takes ${spec.maxPositionals ?? 0} positional arguments`);
  for (const [key, option] of Object.entries(spec.options)) {
    const flag = `--${key}`;
    if (option.required && !parsed.values.has(flag)) throw new CliUsageError(name, `${flag} is required`);
    if (option.default !== undefined && !parsed.values.has(flag)) parsed.values.set(flag, option.default);
  }
  return parsed;
}
