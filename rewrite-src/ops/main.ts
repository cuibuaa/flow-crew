import { outputAdmission } from '../exec/policy.js';
import { activityRecorder, commandActivityObserver } from './activity.js';
import { ownIdentity, performOperation } from '../host/process.js';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { parseBrief, executionBoundary } from '../contract/brief.js';
import { identifyEvidence, initializeEvidence } from '../records/evidence.js';
import { pinRuntime } from '../records/pin.js';
import { preparationPaths } from './preparation.js';
import { initialPlan } from '../core/admission.js';
import type { AdmittedPlan } from '../contract/plan.js';
import { putEvidence, storeEvidence, recordOperation } from '../records/state.js';
import { createPreparation, readPreparation, endPreparation, listRuns } from '../records/state.js';
import type { Creation } from '../records/state.js';
import * as fs from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { z } from 'zod';
import { idSchema, parseValue, type Ref, type Result } from '../contract/brief.js';
import { readEvidence } from '../records/evidence.js';
import { openJournal, appendEvents, readEvents, readHostState } from '../records/state.js';
import { readProjection } from '../records/state.js';
import { verifyRuntime } from '../records/content.js';
import type { ProcessPortsFactory, RunContext } from '../host/process.js';
import { runAttempt } from '../exec/attempt.js';
import { runDeclaredCommand } from '../exec/command.js';
import { createCodexAdapter } from '../exec/codex.js';
import { createClaudeAdapter } from '../exec/claude.js';
import { admitRun, operateRun, runUnitEntry, underControl, type RunServices } from './run.js';
import { setup } from './setup.js';
import { land, controlPreparation } from './land.js';
import { publishRunStatus, refreshRunStatus } from './status.js';
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

  setup <brief> [--project <dir>] [--backend codex|claude] [--config <file>] [--requester <session>]
                                            Record the brief and options as a prepared run; prints its run id
  start <run-id>                             Launch exactly what setup recorded
  monitor [--port N] [--host H] [--store-root DIR ...]
                                            Watch the read-only dashboard (127.0.0.1:8795)
  status [<run-id> [--brief]]                Read one run (--brief prints its stored brief) or list; never rewrite status.json
  guide <run-id> <text> [--plan <file>]       Queue author guidance; never interrupt
  cancel <run-id>                            Request exit and reconcile; 30,758-ms wait, retained-work refusal; repeat safely
  resume <run-id>                            Continue using the original runtime pin
  land <run-id> [--accept-unmet C3=reason ...]
                                            Record human acceptance of unmet criteria, preserve outputs and manifest.json, then reclaim
  --help                                    Show this help

Project defaults to the current directory. Backend defaults to the configured first role.
Storage defaults to $XDG_STATE_HOME/flowcrew (or $HOME/.local/state/flowcrew).
FC_HOME overrides the database directory; FLOWCREW_STORE_ROOT overrides its store directory.
FLOWCREW_RUNTIME_ROOT overrides the installed package used for new runs.
Setup prepares and admits a run but starts nothing; start reads no brief file or option. Unmeasured ended runs report heldSpacePending; the held total is incomplete.
`;

/** The public shell interface owns generated addresses and translates to the existing operation primitive. */
export async function main(argv: readonly string[], context: MainContext): Promise<0 | 1 | 2 | 3> {
  if (argv[0] === 'unit-entry') return execute(argv, context); // Only host supervisor consumes this internal protocol.
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  let preparationJournal: import('../contract/runtime.js').Journal | undefined;
  let creation: Creation = { state: 'not_attempted' };
  try {
    if (!argv.length || argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
      await context.stdout(Buffer.from(HELP)); return 0;
    }
    const command = argv[0];
    // Setup records every option that shapes the run; start takes none.
    const grammar: Record<string, Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>> = {
      setup: { project: { type: 'string' }, backend: { type: 'string' }, config: { type: 'string' }, requester: { type: 'string' } }, start: {},
      monitor: { port: { type: 'string' }, host: { type: 'string' }, 'store-root': { type: 'string', multiple: true } },
      status: { brief: { type: 'boolean' } }, guide: { plan: { type: 'string' } }, cancel: {}, resume: {},
      land: { 'accept-unmet': { type: 'string', multiple: true } }
    };
    if (!Object.hasOwn(grammar, command)) throw new InputError('Unknown command; use flowcrew --help');
    const { values, positionals } = decodeOptions(argv.slice(1), grammar[command], true);
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
    if (command === 'setup') {
      const run = 'run_' + randomUUID(), briefPath = resolve(context.cwd, positionals[0]);
      const paths = get(await preparationPaths({ project: resolve(context.cwd, String(values.project ?? '.')), storeRoot, home }, run));
      const { project, target } = paths;
      ({ storeRoot, home } = paths);
      const bytes = await operand(() => fs.readFile(briefPath));
      const advisory = (line: string) => { void context.stderr(Buffer.from(line + '\n')); };
      const declaration = get(parseBrief(bytes, advisory));
      const source = resolve(import.meta.dirname, '../..');
      const configuration = get(parseRuntime(parseJSON(await operand(() => fs.readFile(values.config ? resolve(context.cwd, String(values.config))
        : join(source, 'config', 'runtime.json'), 'utf8'))), advisory));
      const backend = values.backend ?? configuration.roles[0].backend;
      if (backend !== 'codex' && backend !== 'claude') throw new InputError('Backend must be codex or claude');
      const selected: RuntimeConfig = { ...configuration, roles: values.backend ? configuration.roles.map(role => ({ ...role, backend })) : configuration.roles };
      // Operand validity precedes the record; content admission still belongs to the completed copy.
      const plan = get(initialPlan(declaration, selected.roles, selected.roles[0].id));
      if (!(await operand(() => fs.stat(project))).isDirectory()) throw new InputError('Project is not a directory');
      for (const item of [...declaration.inputs, ...declaration.outputs.filter(output =>
        outputAdmission(output.existing) === 'present')]) await operand(() => fs.lstat(resolve(project, item.path)));
      const brief = { bytes: identifyEvidence(bytes), digest: createHash('sha256').update(bytes).digest('hex'), declaration };
      const authority = randomUUID(), owner = await ownIdentity();
      const location = { storeRoot, database: join(home, 'state.sqlite'), run };
      const created = await createPreparation(location, {
        project, brief, authority, owner,
        ...(values.requester === undefined ? {} : { requester: String(values.requester) })
      });
      creation = created.creation;
      preparationJournal = get(created);
      await initializeEvidence(preparationJournal);
      const runtime = get(await pinRuntime(source, storeRoot, run, selected));
      const unit = { run, runtime, authority }, pinnedRoot = dirname(join(storeRoot, runtime.path));
      // The pinned entry receives values, never operator syntax. It owns its recorded outcome.
      preparationJournal = undefined;
      get(await enterPinned(runtime, { command: 'setup', options: {
        run, unit: JSON.stringify(unit), backend,
        ...(values.requester === undefined ? {} : { requester: String(values.requester) })
      } }, { ...context, storeRoot, home, runtimeRoot: pinnedRoot,
        stdin: json({ project, target, brief, runtime, plan, bytes: bytes.toString('base64') }),
        stdout: async () => undefined }));
      const projection = get(await readProjection(get(created))), prepared = projection.launch.setup;
      await context.stdout(json({ run, brief: briefPath, project: prepared.project, briefDigest: projection.brief.digest, executionBoundary, interpretation: prepared.interpretation ?? [],
        commands: projection.brief.declaration.commands.map(item => item.id),
        detail: `Run prepared and admitted; nothing has started. Launch it with: flowcrew start ${run}` }));
      return 0;
    }
    if (command === 'status' && positionals.length === 0) {
      if (values.brief) throw new InputError('--brief needs a run id');
      const runs = get(listRuns(storeRoot, join(home, 'state.sqlite')));
      const snapshots = [], boot = context.boot ?? await ownIdentity().then(owner => owner.boot, () => undefined);
      // A run that has no readable record (a setup that failed after its first effect) is listed by id with the reason.
      for (const run of runs) {
        const snapshot = await refreshRunStatus({ database: join(home, 'state.sqlite'), storeRoot, run }, new Date().toISOString(), boot);
        snapshots.push(snapshot.ok ? snapshot : { ...snapshot, run });
      }
      await context.stdout(json(snapshots)); return 0;
    }
    const run = get(parseValue(idSchema, positionals[0]));
    const acceptUnmet = (values['accept-unmet'] as string[] | undefined)?.map(value => {
      const separator = value.indexOf('=');
      if (separator < 1) throw new InputError('Expected --accept-unmet C3=reason');
      return { criterionId: value.slice(0, separator), reason: value.slice(separator + 1) };
    });
    const journal = get(await openJournal({ database: join(home, 'state.sqlite'), storeRoot, run }, 'read'));
    if (command === 'status' && !values.brief) return execute(['status', '--run', run], { ...context, boot: context.boot ?? await ownIdentity().then(owner => owner.boot, () => undefined) });
    const preparation = get(readPreparation(journal));
    if (preparation && !preparation.admitted) {
      if (command === 'status') {
        if (preparation.reclaimed) get({ ok: false, kind: 'conflict', detail: 'The brief bytes were removed by land with the run' });
        await context.stdout(get(await readEvidence(journal, preparation.preparation.brief.bytes))); return 0;
      }
      if (acceptUnmet?.length) throw new InputError('Acceptance records require an admitted run');
      const result = await controlPreparation({ database: journal.database, storeRoot, run }, command);
      return reportResult(result, context);
    }
    const projection = get(await readProjection(journal)), unit = projection.launch.unit;
    if (command === 'status') {
      if (projection.reclaimed) get({ ok: false, kind: 'conflict', detail: 'The brief bytes were removed by land with the run; briefDigest in status identifies them' });
      await context.stdout(get(await readEvidence(journal, projection.brief.bytes))); return 0;
    }
    if (projection.reclaimed && command !== 'cancel' && command !== 'land')
      get({ ok: false, kind: 'conflict', detail: 'Evidence was reclaimed at ' + projection.reclaimed.at + '; resume is unavailable. Deliveries: ' + projection.reclaimed.delivery });
    if (command === 'land') return execute({ command, options: { run,
      ...(acceptUnmet ? { 'accept-unmet': JSON.stringify(acceptUnmet) } : {}) } }, context);
    const entry = command === 'cancel' ? execute : async (args: readonly string[], ctx: MainContext) => {
      const result = await enterPinned(unit.runtime, args, ctx);
      return result.legacyExit ?? reportResult(result, ctx);
    };
    // Start reads its cursor from the journal inside the operation, so it carries none.
    const intent = { id: command + '_' + randomUUID(), kind: command, run, unit, ...(command === 'start' ? {} : { expectedCursor: projection.cursor }),
      ...(command === 'guide' ? { intervention: { kind: 'guide', address: projection.invocations.flatMap(item => item.address.kind === 'stage'
        ? [{ run: item.address.run, stage: item.address.stage, attempt: item.address.attempt, invocation: item.address.invocation }] : []).at(-1) ?? null,
      ...(values.plan ? { replacement: { baseRevision: projection.plan.revision,
        plan: parseJSON(await operand(() => fs.readFile(resolve(context.cwd, String(values.plan)), 'utf8'))) } } : {}) } } : {}) };
    return await entry([command, '--run', run, '--intent', JSON.stringify(intent), ...(command === 'guide' ? ['--guidance', '-'] : [])],
      { ...context, runtimeRoot: dirname(join(storeRoot, unit.runtime.path)), stdin: Buffer.from(positionals[1] ?? ''),
        stdout: command !== 'start' ? context.stdout : async result => context.stdout(json({ run, briefDigest: projection.brief.digest, executionBoundary,
          operation: JSON.parse(Buffer.from(result).toString()) })) });
  } catch (error) {
    await refusePreparation(preparationJournal, error instanceof Error ? error.message : String(error), context);
    return reportFailure(error, context, creation);
  }
}

/** Commit refusal through the existing writer; the transition owns admission conflicts. */
async function refusePreparation(journal: import('../contract/runtime.js').Journal | undefined, detail: string, context: MainContext): Promise<void> {
  if (!journal) return;
  const ended = await underControl({ database: journal.database, storeRoot: dirname(dirname(journal.root)),
    run: journal.root.split('/').at(-1)! }, null, ({writer}) => endPreparation(writer, 'refused', detail));
  if (!ended.ok) await context.stderr(Buffer.from(JSON.stringify(ended) + '\n')).catch(() => undefined);
}

/** Decoded setup protocol: the receiving runtime does not reinterpret operator syntax. */
export interface DecodedEntry { readonly command: string; readonly options: Readonly<Record<string, string>> }

/** Historical control entries retain their argv protocol; setup only accepts decoded values. */
function decodeControl(argv: readonly string[]): DecodedEntry {
  const grammar: Record<string, readonly string[]> = {
    start: ['run', 'intent'], cancel: ['run', 'intent'], resume: ['run', 'intent'],
    guide: ['run', 'intent', 'guidance'], status: ['run'], 'unit-entry': ['run', 'unit'], land: ['run', 'accept-unmet']
  };
  const command = argv[0];
  if (!Object.hasOwn(grammar, command ?? '')) throw new InputError('Unknown command');
  return { command, options: decodeOptions(argv.slice(1),
    Object.fromEntries(grammar[command].map(key => [key, { type: 'string' as const }])), false).values as Record<string, string> };
}

/** Compose explicit CLI input, runtime and record ports; preserve typed refusal and unknown outcomes. */
export async function execute(argv: readonly string[] | DecodedEntry, context: MainContext, verifiedRuntime?: Ref): Promise<0 | 1 | 2 | 3> {
  try {
    const result = await executeOperation(argv, context, verifiedRuntime);
    return await reportResult(result, context, (Array.isArray(argv) ? argv[0] : (argv as DecodedEntry).command) === 'status');
  } catch (error) { return reportFailure(error, context); }
}
export async function executeOperation(argv: readonly string[] | DecodedEntry, context: MainContext, verifiedRuntime?: Ref): Promise<Result<unknown>> {
  let setupJournal: import('../contract/runtime.js').Journal | undefined;
  let refusal = 'Setup did not complete';
  try {
    const { command, options: values } = Array.isArray(argv) ? decodeControl(argv) : argv as DecodedEntry;
    const options = new Map(Object.entries(values));
    const required = (key: string) => { const value = options.get(key); if (value === undefined) throw new InputError(`Missing --${key}`);
      return value; };
    for (const key of (command === 'setup' ? ['run', 'unit', 'backend'] : command === 'unit-entry' ? ['run', 'unit'] : command === 'land' || command === 'status' ? ['run'] : command === 'guide' ? ['run', 'intent', 'guidance'] : ['run', 'intent'])) required(key);
    const stdin = () => { try { return parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(context.stdin)); } catch {
      throw new InputError('Invalid UTF-8 JSON input'); } };
    const storeRoot = resolve(context.cwd, context.storeRoot);
    const database = join(resolve(context.cwd, context.home), 'state.sqlite');
    if (command === 'setup') setupJournal = get(await openJournal({ database, storeRoot, run: required('run') }, 'read'));
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
    const location: RunLocation = { database, storeRoot, run: get(parseValue(idSchema, required('run'))) };
    if (command === 'status') result = await refreshRunStatus(location, new Date().toISOString(), context.boot);
    else if (command === 'land') result = await land(location, processFactory, unitContext,
      ...(options.has('accept-unmet') ? [parseJSON(required('accept-unmet')) as import('./land.js').UnmetAcceptance[]] : []));
    else {
      const { plan, bytes, ...setupInput } = command === 'setup' ? objectValue(stdin()) : {} as Record<string, unknown>;
      const setupRequest = command === 'setup' ? get(parseSetupRequest({
        ...setupInput,
        project: typeof setupInput.project === 'string' ? resolve(context.cwd, setupInput.project) : setupInput.project,
        target: typeof setupInput.target === 'string' ? resolve(context.cwd, setupInput.target) : setupInput.target
      })) : undefined;
      let intent: ControlIntent | undefined;
      if (['start', 'cancel', 'resume', 'guide'].includes(command)) {
        const input = objectValue(parseJSON(required('intent')));
        if (input.kind !== command) throw new InputError('Intent kind does not match command');
        if (command === 'start' && Object.hasOwn(input, 'expectedCursor')) throw new InputError('Start cursor is read from the journal');
        const intervention = command === 'guide' ? objectValue(input.intervention) : undefined;
        if (intervention && Object.hasOwn(intervention, 'content')) throw new InputError('Guide content comes from --guidance');
        const addressedRun = get(parseValue(idSchema, input.run));
        const addressedUnit = get(parseRunRef(input.unit));
        if (addressedRun !== location.run || addressedUnit.run !== location.run) throw new InputError('Intent run mismatch');
        if (command === 'start' || command === 'guide') {
          const opened = get(await openJournal(location, 'read'));
          if (command === 'start') {
            const events = get(await readEvents(opened, 0));
            // Preserve a committed intent's original boundary on a lost-response retry.
            const prior = events.find(event => event.payload.type === 'control_intent' && event.payload.intent.id === input.id);
            intent = get(parseControlIntent({
              ...input, expectedCursor: prior?.payload.type === 'control_intent'
                ? prior.payload.intent.expectedCursor : events.at(-1)?.seq ?? 0
            }));
          } else {
            const source = required('guidance');
            const stored = get(await putEvidence(opened, source === '-' ? context.stdin : await operand(() => fs.readFile(resolve(context.cwd, source)))));
            intent = get(parseControlIntent({ ...input, intervention: { ...intervention, content: stored } }));
          }
        } else intent = get(parseControlIntent(input));
      }
      const unit = command === 'setup' || command === 'unit-entry' ? get(parseRunRef(parseJSON(required('unit')))) : intent!.unit;
      const runtime = verifiedRuntime || command === 'cancel' ? verifiedRuntime ?? unit.runtime
        : get(await verifyRuntime(storeRoot, unit.runtime));
      const pinnedRoot = dirname(join(storeRoot, runtime.path));
      if (resolve(context.cwd, context.runtimeRoot) !== pinnedRoot) throw new InputError('Explicit runtimeRoot differs from pin');
      const configuration = command === 'cancel' ? { roles: [] }
        : get(parseRuntime(parseJSON(await operand(() => fs.readFile(join(pinnedRoot, 'config', 'runtime.json'), 'utf8'))), advisory));
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
            const published = publishRunStatus(scope.layout.location, clock.at, elapsed);
            return published.ok ? { ok: true, value: { ...published.value, commandActivity: activity } } : published;
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
        const backend = get(parseValue(z.enum(['codex', 'claude']), required('backend')));
        const prepared = await setup(setupRequest!, {
          briefBytes: Buffer.from(String(bytes), 'base64'), backend, location, unit, configRoot,
          configuration, environment: context.environment
        });
        // Preparation ends in recording the admission: what start launches is this record, not a second reading of anything.
        // Config roles decided the graph before the record; project admission decided only on the completed copy.
        const admitted = !prepared.ok ? prepared : await admitRun(location, get(parseLaunch({
          backend, run: location.run, project: setupRequest!.target, brief: setupRequest!.brief, roles: configuration.roles,
          runtime: setupRequest!.runtime, setup: prepared.value, unit, ...(options.has('requester') ? { requester: required('requester') } : {})
        })), plan as AdmittedPlan, services);
        result = admitted.ok ? prepared : admitted;
      } else if (command === 'unit-entry') result = await runUnitEntry(location, unit, services, context.abort);
      else if (command === 'start') {
        result = await operateRun({ location, intent: intent as ControlIntent & { kind: 'start' } }, services);
      } else result = await operateRun({ location, intent: intent as ControlIntent & { kind: 'cancel' | 'resume' | 'guide' | 'status' } },
        services);
    }
    if (!result.ok) refusal = result.detail;
    else setupJournal = undefined;
    for (const line of advisories) await context.stderr(new TextEncoder().encode(line + '\n'));
    return result;
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
    if (!(error instanceof FailureError)) throw error;
    return error.failure;
  } finally {
    await refusePreparation(setupJournal, refusal, context);
  }
}

type Failure = Extract<Result<never>, { ok: false }>;
class FailureError extends Error {
  constructor(readonly failure: Failure) { super(failure.detail); }
}
class InputError extends FailureError {
  constructor(detail: string) { super({ ok: false, kind: 'invalid', detail }); }
}
function get<T>(result: Result<T>): T { if (!result.ok) throw new FailureError(result); return result.value; }
async function operand<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) { throw new InputError(String(error)); }
}
function parseJSON(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new InputError('Invalid JSON'); }
}
/** Preparation alone derives effects and advice from this invocation's creation receipt. */
export function preparationFailure(failure: Omit<Failure, 'ok'>, creation: Creation) {
  if (creation.state === 'not_attempted' || creation.state === 'rejected_or_aborted')
    return { ...failure, effects: 'none' as const };
  const { run, storeRoot } = creation.location;
  return creation.state === 'confirmed'
    ? { ...failure, effects: 'setup' as const, run,
      detail: `${failure.detail}; run record exists and setup did not finish; inspect flowcrew status ${run}, then use flowcrew cancel ${run} and flowcrew land ${run} as appropriate.` }
    : { ...failure, effects: 'maybe' as const, run, confirmed: false, storeRoot,
      detail: `${failure.detail}; creation of ${run} is unconfirmed and may have committed; run directory retained at ${storeRoot}. Inspect flowcrew status ${run} when readable; if confirmed, use flowcrew cancel ${run} and flowcrew land ${run}. Do not retry creation into this address or delete it as an empty attempt.` };
}
/** Exit encoding has exactly one input: the failure kind chosen by its producer. */
export function exitOf(kind: Failure['kind']): 1 | 2 | 3 {
  return kind === 'conflict' || kind === 'output_changed' ? 1 : kind === 'invalid' ? 2 : 3;
}
function successExit(result: unknown, reads = false): 0 | 1 | 2 | 3 {
  const value = result as { state?: string; status?: string };
  if (reads) return 0;
  if (value.state === 'refused' || value.state === 'partial' || ['failed', 'incomplete', 'cancelled', 'escalated'].includes(value.status ?? '')) return 1;
  return value.state === 'unknown' || value.state === 'not_confirmed_closed' || value.status === 'parked' ? 3 : 0;
}
/** An untyped exception inside main is an unknown outcome (exit 3); only an exception escaping main exits 2 (cli.ts). */
export async function reportFailure(error: unknown, context: MainContext, creation: Creation = { state: 'not_attempted' }): Promise<1 | 2 | 3> {
  const cause = error instanceof FailureError ? error.failure : { kind: 'unknown' as const, detail: String(error) };
  const failure = { ok: false, ...preparationFailure({ kind: cause.kind, detail: cause.detail }, creation) };
  const line = Buffer.from(JSON.stringify(failure) + '\n');
  if ('run' in failure) await context.stdout(line).catch(() => undefined);
  await context.stderr(line).catch(() => undefined);
  return exitOf(cause.kind);
}
function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected JSON object');
  return value as Record<string, unknown>;
}
function decodeOptions(argv: readonly string[], options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>, allowPositionals: boolean) {
  let decoded: ReturnType<typeof parseArgs>;
  try { decoded = parseArgs({ args: [...argv], options, allowPositionals, strict: true, tokens: true }); }
  catch (error) { throw new InputError(String(error)); }
  const { tokens = [], ...parsed } = decoded;
  // parseArgs supplies syntax; tokens retain repeated options so the decoder can reject them once.
  const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
  for (const name of names) if (!options?.[name]?.multiple && names.indexOf(name) !== names.lastIndexOf(name))
    throw new InputError('Unknown, repeated or missing option');
  return parsed;
}
export function recorderFactory(): ProcessPortsFactory {
  return (writer: Writer) => {
    let serial: Promise<unknown> = Promise.resolve();
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
          const events = await readEvents(writer.journal, 0);
          if (!events.ok) return events;
          const cursor = events.value.at(-1)?.seq ?? 0;
          const appended = await appendEvents(writer, cursor, [payload]);
          if (appended.ok) {
            const projection = await readProjection(writer.journal);
            if (projection.ok) {
              const location = { database: writer.journal.database, storeRoot: dirname(dirname(writer.journal.root)), run: projection.value.run };
              // Publication is an observation; its failure cannot retract the committed process fact.
              publishRunStatus(location, new Date().toISOString(), null);
            } else if (projection.kind !== 'unavailable') return projection;
          }
          return appended;
        }).catch((error): Result<number> => { return { ok: false, kind: 'unknown',
          detail: error instanceof Error ? error.message : String(error) }; });
        serial = work;
        return work;
      },
    };
  };
}

/** Trusted local composition through the existing host operation loader; only the verified run pin supplies code. */
async function enterPinned(runtime: Ref, argv: readonly string[] | DecodedEntry, context: MainContext): Promise<PinnedResult> {
  const verified = await verifyRuntime(resolve(context.cwd, context.storeRoot), runtime);
  if (!verified.ok) return verified;
  const root = dirname(join(resolve(context.cwd, context.storeRoot), verified.value.path));
  return decodePinnedResult(await performOperation({ module: join(root, 'ops', 'main.js'), method: 'executeOperation', args: [argv, context, verified.value] }));
}
type PinnedResult = Result<unknown> & { readonly legacyExit?: 0 | 1 | 2 | 3 };
/** Decode older runtimes' already-reported numeric exits once, at the operation boundary. */
export function decodePinnedResult(result: Result<unknown>): PinnedResult {
  if (!result.ok || typeof result.value !== 'number') return result;
  const code = result.value;
  switch (code) {
    case 0: return { ok: true, value: {}, legacyExit: code };
    case 1: case 2: case 3: return { ok: false, kind: code === 1 ? 'conflict' : code === 2 ? 'invalid' : 'unknown',
      detail: `Pinned operation exited ${code}`, legacyExit: code };
    default: return { ok: false, kind: 'unknown', detail: 'Invalid pinned operation exit' };
  }
}
async function reportResult(result: Result<unknown>, context: MainContext, reads = false): Promise<0 | 1 | 2 | 3> {
  if (!result.ok) return reportFailure(new FailureError(result), context);
  await context.stdout(Buffer.from(JSON.stringify(result.value) + '\n'));
  return successExit(result.value, reads);
}
