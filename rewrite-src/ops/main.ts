import { activityRecorder, commandActivityObserver } from './activity.js';
import { ownIdentity, performOperation } from '../host/process.js';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { parseBrief, executionBoundary } from '../contract/brief.js';
import { identifyEvidence } from '../records/evidence.js';
import { pinRuntime } from '../records/pin.js';
import { admitPreparation, preparationPaths } from './preparation.js';
import { putEvidence, storeEvidence, recordOperation } from '../records/state.js';
import { initializeState, protectedStatePaths } from '../records/state.js';
import * as fs from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { idSchema, parseValue, type Result } from '../contract/brief.js';
import { readEvidence } from '../records/evidence.js';
import { openJournal, appendEvents, readEvents, readHostState } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { verifyRuntime } from '../records/content.js';
import type { ProcessPortsFactory, RunContext } from '../host/process.js';
import { runAttempt } from '../exec/attempt.js';
import { runDeclaredCommand } from '../exec/command.js';
import { createCodexAdapter } from '../exec/codex.js';
import { createClaudeAdapter } from '../exec/claude.js';
import { operateRun, runUnitEntry, type RunServices } from './run.js';
import { inspectSetup, setup } from './setup.js';
import { land } from './land.js';
import { refreshRunStatus } from './status.js';
import { parseControlIntent, parseLaunch, parseRuntime, parseSetupRequest, parseRunRef, type Writer, type RunLocation, type ControlIntent, type RuntimeConfig }
  from '../contract/runtime.js';

/**  Explicit CLI environment and byte streams. */
export interface MainContext {
  readonly cwd: string;
  readonly storeRoot: string;
  readonly runtimeRoot: string;
  readonly home: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: Uint8Array;
  readonly boot?: string;
  readonly abort: AbortSignal;
  stdout(bytes: Uint8Array): Promise<void>;
  stderr(bytes: Uint8Array): Promise<void>;
}

export const HELP = `Usage: flowcrew <command>

  setup <brief> [--project <dir>] [--backend codex|claude] [--config <file>]
                                            Check declarations and preparation
  start <brief> [--project <dir>] [--backend codex|claude] [--config <file>]
                [--requester <session>]     Prepare isolated work and print its run id
  monitor [--port N] [--host H] [--store-root DIR ...]
                                            Watch the read-only dashboard (127.0.0.1:8795)
  status [<run-id>]                          Inspect one run or list runs
  guide <run-id> <text> [--plan <file>]       Queue author guidance; never interrupt
  cancel <run-id>                            Interrupt work; safe to repeat
  resume <run-id>                            Continue using the original runtime pin
  land <run-id>                              Keep the deliveries, then free the run's bytes
  --help                                    Show this help

Project defaults to the current directory. Backend defaults to the configured first role.
Storage defaults to $XDG_STATE_HOME/flowcrew (or $HOME/.local/state/flowcrew).
FC_HOME overrides the database directory; FLOWCREW_STORE_ROOT overrides its store directory.
FLOWCREW_RUNTIME_ROOT overrides the installed package used for new runs.
Setup and start share preparation admission. Setup never creates a run or executes brief commands.
`;

/** The public shell interface owns generated addresses and translates to the existing operation primitive. */
export async function main(argv: readonly string[], context: MainContext): Promise<0 | 1 | 2 | 3> {
  if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    await context.stdout(Buffer.from(HELP)); return 0;
  }
  if (argv[0] === 'unit-entry') return execute(argv, context); // Only host supervisor consumes this internal protocol.
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  const get = <T>(result: Result<T>): T => { if (!result.ok) throw new InputError(result.detail, result.kind); return result.value; };
  try {
    const command = argv[0];
    // Every option that shapes preparation is shared, so `setup` previews exactly what `start` will run.
    const preparing = { project: { type: 'string' }, backend: { type: 'string' }, config: { type: 'string' } } as const;
    const grammar: Record<string, Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>> = {
      setup: preparing, start: { ...preparing, requester: { type: 'string' } },
      monitor: { port: { type: 'string' }, host: { type: 'string' }, 'store-root': { type: 'string', multiple: true } },
      status: {}, guide: { plan: { type: 'string' } }, cancel: {}, resume: {}, land: {}
    };
    if (!Object.hasOwn(grammar, command)) throw new InputError('Unknown command; use flowcrew --help');
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({ args: [...argv.slice(1)], options: grammar[command], allowPositionals: true, strict: true }); }
    catch (error) { throw new InputError(String(error)); }
    const { values, positionals } = parsed;
    const count = command === 'monitor' ? [0] : command === 'status' ? [0, 1] : command === 'guide' ? [2] : [1];
    if (!count.includes(positionals.length)) throw new InputError('Wrong arguments; use flowcrew --help');
    let storeRoot = resolve(context.cwd, context.storeRoot), home = resolve(context.cwd, context.home);
    if (command === 'monitor') {
      const port = String(values.port ?? '8795');
      if (!/^[0-9]+$/.test(port) || Number(port) > 65535) throw new InputError('Port must be 0..65535');
      const { startMonitor } = await import(new URL('../../dist-monitor/rewrite-monitor/server.js', import.meta.url).href);
      const server: import('node:http').Server = await startMonitor({
        storeRoots: values['store-root'] as string[] | undefined ?? [storeRoot],
        host: String(values.host ?? '127.0.0.1'), port: Number(port) });
      const close = () => { server.close(); };
      context.abort.addEventListener('abort', close, { once: true });
      try {
        const address = server.address();
        if (address && typeof address !== 'string') {
          const host = address.address.includes(':') ? `[${address.address}]` : address.address;
          await context.stdout(Buffer.from(`FlowCrew monitor: http://${host}:${address.port}\n`));
        }
        if (context.abort.aborted) close();
        else await new Promise<void>(done => server.once('close', done));
      } finally {
        context.abort.removeEventListener('abort', close);
        server.close();
      }
      return 0;
    }
    if (command === 'start' || command === 'setup') {
      const run = 'run_' + randomUUID();
      const paths = await preparationPaths({ project: resolve(context.cwd, String(values.project ?? '.')), storeRoot, home });
      const { project } = paths;
      ({ storeRoot, home } = paths);
      const bytes = await fs.readFile(resolve(context.cwd, positionals[0]));
      const declaration = get(parseBrief(bytes, line => { void context.stderr(Buffer.from(line + '\n')); }));
      const source = resolve(context.cwd, context.runtimeRoot);
      const configuration = get(parseRuntime(JSON.parse(await fs.readFile(values.config ? resolve(context.cwd, String(values.config))
        : join(source, 'config', 'runtime.json'), 'utf8')), line => { void context.stderr(Buffer.from(line + '\n')); }));
      const backend = values.backend ?? configuration.roles[0].backend;
      if (backend !== 'codex' && backend !== 'claude') throw new InputError('Backend must be codex or claude');
      const selected: RuntimeConfig = { ...configuration, roles: values.backend ? configuration.roles.map(role => ({ ...role, backend })) : configuration.roles };
      if (command === 'setup') {
        const workRoot = join(storeRoot, 'work', run);
        const prepared = get(await admitPreparation(declaration, selected, {
          source: project, project: join(workRoot, 'project'), workRoot, backend,
          protectedRoots: [join(storeRoot, 'pins', run), project, join(storeRoot, 'runs', run),
            ...protectedStatePaths(join(home, 'state.sqlite'))], environment: context.environment
        }));
        await context.stdout(json({ brief: resolve(context.cwd, positionals[0]), project,
          briefDigest: createHash('sha256').update(bytes).digest('hex'), executionBoundary, interpretation: prepared.interpretation,
          commands: declaration.commands.map(item => item.id),
          detail: 'Preparation admitted. Commands are deferred; runtime execution establishes command feasibility.' }));
        return 0;
      }
      await fs.mkdir(storeRoot, { recursive: true }); await fs.mkdir(home, { recursive: true });
      const ready = initializeState(join(home, 'state.sqlite')); if (!ready.ok) { await context.stderr(json(ready)); return 3; }
      const runtime = get(await pinRuntime(source, storeRoot, run, selected));
      const unit = { run, runtime, authority: randomUUID() }, pinnedRoot = dirname(join(storeRoot, runtime.path));
      const target = join(storeRoot, 'work', run, 'project');
      const brief = { bytes: identifyEvidence(bytes), digest: createHash('sha256').update(bytes).digest('hex'), declaration };
      const internal = { ...context, storeRoot, home, runtimeRoot: pinnedRoot, stdin: json({ project, target, brief, runtime }) };
      const pinnedExecute = (args: readonly string[], ctx: MainContext) => enterPinned(pinnedRoot, args, ctx);
      const prepared = await pinnedExecute(['setup', '--run', run, '--unit', JSON.stringify(unit), '--brief',
        resolve(context.cwd, positionals[0]), '--backend', backend], { ...internal, stdout: async () => {} });
      if (prepared !== 0) { await context.stdout(json({ run, briefDigest: brief.digest, executionBoundary, detail: 'Preparation refused; inspect this run before retrying with a new run.' })); return prepared; }
      const location = { database: join(home, 'state.sqlite'), storeRoot, run };
      const journal = get(await openJournal(location, 'read')), events = get(await readEvents(journal, 0));
      const fact = events.filter(event => event.payload.type === 'setup_prepared').at(-1)!.payload;
      if (fact.type !== 'setup_prepared' || !fact.measured) throw Error('Preparation not committed');
      const launch = { backend, run, project: target, brief: fact.request.brief, runtime, unit, roles: selected.roles, setup: fact.measured };
      return pinnedExecute(['start', '--run', run, '--intent', JSON.stringify({ id: 'start_' + randomUUID(), kind: 'start', run, unit }),
        '--planner-role', selected.roles[0].id, ...(values.requester ? ['--requester', String(values.requester)] : [])],
        { ...internal, stdin: json(launch), stdout: async result => context.stdout(json({ run, briefDigest: brief.digest, executionBoundary,
          operation: JSON.parse(Buffer.from(result).toString()) })) });
    }
    if (command === 'status' && positionals.length === 0) {
      let runs: string[] = [];
      try { runs = (await fs.readdir(join(storeRoot, 'runs'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const snapshots = [], boot = context.boot ?? await ownIdentity().then(owner => owner.boot, () => undefined);
      for (const run of runs) snapshots.push(await refreshRunStatus({ database: join(home, 'state.sqlite'), storeRoot, run }, new Date().toISOString(), boot));
      await context.stdout(json(snapshots)); return 0;
    }
    const run = get(parseValue(idSchema, positionals[0]));
    if (command === 'status') return execute(['status', '--run', run], { ...context, boot: context.boot ?? await ownIdentity().then(owner => owner.boot, () => undefined) });
    const journal = get(await openJournal({ database: join(home, 'state.sqlite'), storeRoot, run }, 'read'));
    const projection = get(await readProjection(journal)), unit = projection.launch.unit;
    if (projection.reclaimed && command !== 'cancel' && command !== 'land') {
      await context.stderr(json({ ok: false, kind: 'conflict', detail: 'Evidence was reclaimed at ' + projection.reclaimed.at
        + '; resume is unavailable. Deliveries: ' + projection.reclaimed.delivery })); return 1;
    }
    const runtimeRoot = dirname(join(storeRoot, unit.runtime.path));
    if (command === 'land') return execute(['land', '--run', run], context);
    const verified = command === 'cancel' ? undefined : get(await verifyRuntime(storeRoot, unit.runtime));
    void verified;
    const entry = command === 'cancel' ? execute : (args: readonly string[], ctx: MainContext) => enterPinned(runtimeRoot, args, ctx);
    const intent = { id: command + '_' + randomUUID(), kind: command, run, unit, expectedCursor: projection.cursor,
      ...(command === 'guide' ? { intervention: { kind: 'guide', address: projection.invocations.flatMap(item => item.address.kind === 'stage'
        ? [{ run: item.address.run, stage: item.address.stage, attempt: item.address.attempt, invocation: item.address.invocation }] : []).at(-1) ?? null,
      ...(values.plan ? { replacement: { baseRevision: projection.plan.revision,
        plan: JSON.parse(await fs.readFile(resolve(context.cwd, String(values.plan)), 'utf8')) } } : {}) } } : {}) };
    return entry([command, '--run', run, '--intent', JSON.stringify(intent), ...(command === 'guide' ? ['--guidance', '-'] : [])],
      { ...context, runtimeRoot: dirname(join(storeRoot, unit.runtime.path)), stdin: Buffer.from(positionals[1] ?? '') });
  } catch (error) {
    const kind = error instanceof InputError ? error.kind : 'unknown';
    await context.stderr(json({ ok: false, kind, detail: error instanceof Error ? error.message : String(error) }));
    return kind === 'invalid' ? 2 : kind === 'conflict' ? 1 : 3;
  }
}

/** Compose explicit CLI input, runtime and record ports; preserve typed refusal and unknown outcomes. */
export async function execute(argv: readonly string[], context: MainContext): Promise<0 | 1 | 2 | 3> {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');
  try {
    const command = argv[0];
    const grammar: Record<string, readonly string[]> = {
      setup: ['run', 'unit', 'brief', 'backend'], start: ['run', 'intent', 'planner-role', 'requester'],
      cancel: ['run', 'intent'], resume: ['run', 'intent'], guide: ['run', 'intent', 'guidance'], status: ['run'],
      'unit-entry': ['run', 'unit'], land: ['run'],
    };
    if (!Object.hasOwn(grammar, command ?? '')) throw new InputError('Unknown command');
    const options = decodeOptions(argv.slice(1), grammar[command]);
    const required = (key: string) => { const value = options.get(key); if (value === undefined) throw new InputError(`Missing --${key}`);
      return value; };
    for (const key of (command === 'start' ? ['run', 'intent', 'planner-role'] : command === 'setup' ? ['run', 'unit', 'brief',
      'backend'] : command === 'unit-entry' ? ['run', 'unit'] : command === 'land' || command === 'status' ? ['run'] : command === 'guide' ? ['run', 'intent', 'guidance'] : ['run', 'intent'])) required(key);
    const json = (text: string): unknown => { try { return JSON.parse(text); } catch { throw new InputError('Invalid JSON'); } };
    const checked = <T>(result: Result<T>): T => { if (!result.ok) throw new InputError(result.detail, result.kind); return result.value; };
    const stdin = () => { try { return json(new TextDecoder('utf-8', { fatal: true }).decode(context.stdin)); } catch {
      throw new InputError('Invalid UTF-8 JSON input'); } };
    const storeRoot = resolve(context.cwd, context.storeRoot);
    const database = join(resolve(context.cwd, context.home), 'state.sqlite');
    if (command === 'setup') { const ready = initializeState(database); if (!ready.ok) {
      await context.stderr(encode(ready)); return 3; } }
    const unitContext: RunContext = {
      database, storeRoot, environment: context.environment, pending: async run => {
        const opened = await openJournal({ database, storeRoot, run: run.run }, 'read'); if (!opened.ok) return opened;
        const state = readHostState(opened.value); return state.ok ? { ok: true, value: state.value.pending } : state;
      }, observation: async run => {
        const opened = await openJournal({ database, storeRoot, run: run.run }, 'read'); if (!opened.ok) return opened;
        const state = readHostState(opened.value); return state.ok ? { ok: true, value: state.value.observation } : state;
      }
    };
    const processFactory = recorderFactory();
    if (command !== 'status') await fs.mkdir(join(storeRoot, 'work', options.get('run') ?? 'control', 'tmp'), { recursive: true });
    const advisories: string[] = [];
    const advisory = (line: string) => { if (command === 'setup') advisories.push(line); };
    let result: Result<unknown>;
    {
      const location: RunLocation = { database, storeRoot, run: checked(parseValue(idSchema, required('run'))) };
      if (command === 'status') result = await refreshRunStatus(location, new Date().toISOString(), context.boot);
      else if (command === 'land') result = await land(location, processFactory, unitContext);
      else {
        const launchInput = command === 'start' ? objectValue(stdin()) : undefined;
        if (launchInput && Object.hasOwn(launchInput, 'requester')) throw new InputError('Requester is accepted only through --requester');
        const launch = command === 'start' ? checked(parseLaunch({
          ...objectValue(launchInput),
          ...(options.has('requester') ? { requester: required('requester') } : {})
        })) : undefined;
        const setupInput = command === 'setup' ? objectValue(stdin()) : undefined;
        const setupRequest = setupInput ? checked(parseSetupRequest({
          ...setupInput,
          project: typeof setupInput.project === 'string' ? resolve(context.cwd, setupInput.project) : setupInput.project,
          target: typeof setupInput.target === 'string' ? resolve(context.cwd, setupInput.target) : setupInput.target
        })) : undefined;
        let intent: ControlIntent | undefined;
        if (['start', 'cancel', 'resume', 'guide'].includes(command)) {
          const input = objectValue(json(required('intent')));
          if (input.kind !== command) throw new InputError('Intent kind does not match command');
          if (command === 'start' && Object.hasOwn(input, 'expectedCursor')) throw new InputError('Start cursor is read from the journal');
          const intervention = command === 'guide' ? objectValue(input.intervention) : undefined;
          if (intervention && Object.hasOwn(intervention, 'content')) throw new InputError('Guide content comes from --guidance');
          const addressedRun = checked(parseValue(idSchema, input.run));
          const addressedUnit = checked(parseRunRef(input.unit));
          if (addressedRun !== location.run || addressedUnit.run !== location.run) throw new InputError('Intent run mismatch');
          if (command === 'start' || command === 'guide') {
            const opened = await openJournal(location, 'read');
            if (!opened.ok) { await context.stderr(encode(opened)); return opened.kind === 'invalid' ? 2 : opened.kind === 'conflict' ? 1 : 3; }
            if (command === 'start') {
              const events = await readEvents(opened.value, 0);
              if (!events.ok) { await context.stderr(encode(events)); return events.kind === 'invalid' ? 2 : events.kind === 'conflict' ? 1 : 3; }
              // Preserve a committed intent's original boundary on a lost-response retry.
              const prior = events.value.find(event => event.payload.type === 'control_intent' && event.payload.intent.id === input.id);
              intent = checked(parseControlIntent({
                ...input, expectedCursor: prior?.payload.type === 'control_intent'
                  ? prior.payload.intent.expectedCursor : events.value.at(-1)?.seq ?? 0
              }));
            } else {
              const source = required('guidance');
              const stored = await putEvidence(opened.value, source === '-' ? context.stdin : await fs.readFile(resolve(context.cwd, source)));
              if (!stored.ok) { await context.stderr(encode(stored)); return stored.kind === 'invalid' ? 2 : stored.kind === 'conflict' ? 1 : 3; }
              intent = checked(parseControlIntent({ ...input, intervention: { ...intervention, content: stored.value } }));
            }
          } else intent = checked(parseControlIntent(input));
        }
        if (intent && intent.kind !== command) throw new InputError('Intent kind does not match command');
        const unit = command === 'setup' || command === 'unit-entry' ? checked(parseRunRef(json(required('unit')))) : intent!.unit;
        if (unit.run !== location.run) throw new InputError('Unit run mismatch');
        const runtime = command === 'cancel' ? { ok: true as const, value: unit.runtime } : await verifyRuntime(storeRoot, unit.runtime);
        if (!runtime.ok) result = runtime;
        else {
          const pinnedRoot = dirname(join(storeRoot, runtime.value.path));
          if (resolve(context.cwd, context.runtimeRoot) !== pinnedRoot) throw new InputError('Explicit runtimeRoot differs from pin');
          const configuration = command === 'cancel' ? { roles: [] }
            : checked(parseRuntime(json(await fs.readFile(join(pinnedRoot, 'config', 'runtime.json'), 'utf8')), advisory));
          const configRoot = join(pinnedRoot, 'config');
          const services: RunServices = {
            configuration, unitContext, configRoot, privateEnvironment: context.environment, process: processFactory,
            workflowPorts: (scope, writer, process, abort) => {
              const observeActivity = commandActivityObserver(writer);
              return ({
              recordActivity: activityRecorder(writer.journal),
              now: () => ({ at: new Date().toISOString(), monotonicMs: performance.now() }),
              publishStatus: async (clock, elapsed) => {
                const activity = await observeActivity(Date.parse(clock.at));
                return refreshRunStatus(scope.layout.location, clock.at, undefined, elapsed, activity);
              },
              command: request => runDeclaredCommand(request, { scope, writer, process, abort }),
              attempt: request => {
                const transport = { journal: writer.journal, process, privateEnvironment: context.environment };
                const adapter = request.role.backend === 'codex' ? createCodexAdapter(transport) : createClaudeAdapter(transport);
                return runAttempt(request, { scope, adapter, process, configRoot, privateEnvironment: context.environment, abort });
              },
            }); }
          };
          if (command === 'setup') {
            const inspection = await inspectSetup(setupRequest!, location);
            result = inspection.ok ? await setup(setupRequest!, {
              briefBytes: await fs.readFile(resolve(context.cwd, required('brief'))),
              backend: checked(parseValue(z.enum(['codex', 'claude']), required('backend'))), location, unit, configuration, configRoot,
                privateEnvironment: context.environment
            }) : inspection;
          } else if (command === 'unit-entry') result = await runUnitEntry(location, unit, services, context.abort);
          else if (command === 'start') {
            const plannerRole = checked(parseValue(idSchema, required('planner-role')));
            result = await operateRun({ location, intent: intent as ControlIntent & { kind: 'start' }, launch: launch!, plannerRole }, services);
          } else result = await operateRun({ location, intent: intent as ControlIntent & { kind: 'cancel' | 'resume' | 'guide' | 'status' } },
            services);
        }
      }
    }
    for (const line of advisories) await context.stderr(new TextEncoder().encode(line + '\n'));
    if (!result.ok) {
      await context.stderr(encode(result));
      return result.kind === 'invalid' ? 2 : result.kind === 'conflict' ? 1 : 3;
    }
    if (command === 'setup') for (const line of (result.value as { interpretation?: readonly string[] }).interpretation ?? [])
      await context.stderr(new TextEncoder().encode(line + '\n'));
    await context.stdout(encode(result.value));
    if (command === 'status') return 0;
    const value = result.value as { state?: string; status?: string; occupancy?: string };
    if (value.state === 'refused' || value.state === 'partial'
      || ['failed', 'incomplete', 'cancelled', 'escalated'].includes(value.status ?? '')) return 1;
    if (value.state === 'unknown' || value.state === 'not_confirmed_closed' || value.state === 'in_progress' || value.status === 'parked') return 3;
    return 0;
  } catch (error) {
    const exit = error instanceof InputError ? 2 : 3;
    try { await context.stderr(encode({ ok: false, kind: exit === 2 ? 'invalid' : 'unknown',
      detail: error instanceof Error ? error.message : String(error) })); }
    catch { return 3; }
    return exit;
  }
}

class InputError extends Error {
  constructor(detail: string, readonly kind: 'invalid' | 'conflict' | 'unavailable' | 'unknown' = 'invalid') { super(detail); }
}
function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected JSON object');
  return value as Record<string, unknown>;
}
function decodeOptions(argv: readonly string[], allowed: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].startsWith('--') ? argv[index].slice(2) : '';
    const value = argv[index + 1];
    if (!allowed.includes(key) || options.has(key) || value === undefined ||
      value.startsWith('--')) throw new InputError('Unknown, repeated or missing option');
    options.set(key, value);
  }
  return options;
}
export function recorderFactory(): ProcessPortsFactory {
  return (writer: Writer) => {
    let serial: Promise<unknown> = Promise.resolve();
    let unresolved = false;
    return {
      recordController: async owner => {
        const projection = await readProjection(writer.journal); if (!projection.ok) return projection;
        const events = await readEvents(writer.journal, 0); if (!events.ok) return events;
        return appendEvents(writer, events.value.at(-1)?.seq ?? 0, [{ type: 'run_observed', observation: { unit: projection.value.launch.unit,
          state: 'active', owner, evidence: [], detail: 'Controller group and package helpers recorded' } }]);
      },
      operation: request => recordOperation(writer.journal, 'construct', request),
      streamRoot: writer.journal.root,
      scratch: join(dirname(dirname(writer.journal.root)), 'work', writer.journal.root.split('/').at(-1)!, 'tmp'),
      storeEvidence: source => storeEvidence(writer.journal, source),
      putEvidence: bytes => putEvidence(writer.journal, bytes),
      readEvidence: ref => readEvidence(writer.journal, ref),
      recordProcess: payload => {
        const work = serial.then(async (): Promise<Result<number>> => {
          if (unresolved) return { ok: false, kind: 'unknown', detail: 'Earlier process append remains uncertain' };
          const events = await readEvents(writer.journal, 0);
          if (!events.ok) return events;
          const cursor = events.value.at(-1)?.seq ?? 0;
          let appended = await appendEvents(writer, cursor, [payload]);
          if (!appended.ok && appended.kind === 'unknown') {
            const reread = await readEvents(writer.journal, cursor);
            const found = reread.ok ? reread.value.find(event => isDeepStrictEqual(event.payload, payload)) : undefined;
            if (found) appended = { ok: true, value: found.seq }; else unresolved = true;
          }
          if (appended.ok) {
            const projection = await readProjection(writer.journal);
            if (projection.ok) {
              const location = { database: writer.journal.database, storeRoot: dirname(dirname(writer.journal.root)), run: projection.value.run };
              // Publication is an observation; its failure cannot retract the committed process fact.
              await refreshRunStatus(location, new Date().toISOString());
            } else if (projection.kind !== 'unavailable') return projection;
          }
          return appended;
        }).catch((error): Result<number> => { unresolved = true; return { ok: false, kind: 'unknown',
          detail: error instanceof Error ? error.message : String(error) }; });
        serial = work.catch(() => { unresolved = true; });
        return work;
      },
    };
  };
}

/** Trusted local composition through the existing host operation loader; only the verified run pin supplies code. */
async function enterPinned(root: string, argv: readonly string[], context: MainContext): Promise<0 | 1 | 2 | 3> {
  const result = await performOperation<0 | 1 | 2 | 3>({ module: join(root, 'ops', 'main.js'), method: 'executeOperation', args: [argv, context] });
  if (result.ok) return result.value;
  await context.stderr(Buffer.from(JSON.stringify(result) + '\n')); return 3;
}
export async function executeOperation(argv: readonly string[], context: MainContext): Promise<Result<0 | 1 | 2 | 3>> {
  return { ok: true, value: await execute(argv, context) };
}
