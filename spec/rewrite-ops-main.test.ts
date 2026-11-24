import * as host from '../dist-rewrite/host/process.js';
import { access,mkdir,readFile,symlink,writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { admitInputs, admitPreparation, preparationPaths } from '../dist-rewrite/ops/preparation.js';
import { pinRuntime } from '../dist-rewrite/records/pin.js';
import { runAttempt } from '../dist-rewrite/exec/attempt.js';
import { createClaudeAdapter } from '../dist-rewrite/exec/claude.js';
import { createCodexAdapter } from '../dist-rewrite/exec/codex.js';
import { runDeclaredCommand } from '../dist-rewrite/exec/command.js';
import { land } from '../dist-rewrite/ops/land.js';
import { execute as main, main as humanMain, preparationFailure, exitOf, decodePinnedResult, reportFailure, type MainContext } from '../dist-rewrite/ops/main.js';
import { admitRun,operateRun,runUnitEntry } from '../dist-rewrite/ops/run.js';
import { setup } from '../dist-rewrite/ops/setup.js';
import { publishRunStatus,refreshRunStatus,readRunStatus } from '../dist-rewrite/ops/status.js';
import { verifyRuntime } from '../dist-rewrite/records/content.js';
import { readEvidence } from '../dist-rewrite/records/evidence.js';
import { claim,release,openWriter,listRuns,createPreparation,readPreparation,endPreparation,appendEvents,openJournal,putEvidence,readEvents,readProjection } from '../dist-rewrite/records/state.js';
import { fixture,hash,no,ok,ref,type Fixture } from './rewrite-ops-fixture.js';
vi.mock('../dist-rewrite/records/pin.js', () => ({ pinRuntime: vi.fn() }));
vi.mock('../dist-rewrite/ops/run.js', async original => ({ ...await original<typeof import('../dist-rewrite/ops/run.js')>(),
 admitRun: vi.fn(), operateRun: vi.fn(), runUnitEntry: vi.fn() }));
vi.mock('../dist-rewrite/ops/setup.js', () => ({ setup: vi.fn() }));
vi.mock('../dist-rewrite/ops/land.js', () => ({ land: vi.fn(), controlPreparation: vi.fn() }));
vi.mock('../dist-rewrite/ops/status.js', () => ({ publishRunStatus: vi.fn(), refreshRunStatus: vi.fn(), readRunStatus: vi.fn() }));
vi.mock('../dist-rewrite/records/content.js', async () => ({ ...await vi.importActual('../dist-rewrite/records/content.js'),
 verifyRuntime: vi.fn() }));
vi.mock('../dist-rewrite/records/state.js', async (original) => ({ ...await original<typeof import('../dist-rewrite/records/state.js')>(),
 claim: vi.fn(), release: vi.fn(), openWriter: vi.fn(), listRuns: vi.fn(), createPreparation: vi.fn(), readPreparation: vi.fn(), endPreparation: vi.fn(), openJournal: vi.fn(), appendEvents: vi.fn(), readEvents: vi.fn(), readProjection: vi.fn(), putEvidence: vi.fn() }));
vi.mock('../dist-rewrite/exec/attempt.js', () => ({ runAttempt: vi.fn() }));
vi.mock('../dist-rewrite/exec/command.js', () => ({ runDeclaredCommand: vi.fn() }));
vi.mock('../dist-rewrite/exec/codex.js', () => ({ createCodexAdapter: vi.fn() }));
vi.mock('../dist-rewrite/exec/claude.js', () => ({ createClaudeAdapter: vi.fn() }));
let f: Fixture;
let ctx: MainContext;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function addressed(kind: 'start' | 'cancel' | 'resume' | 'status' | 'guide') {
  return { kind, id: 'intent_a', run: f.location.run, unit: f.unit, ...(kind === 'start' ? {} : { expectedCursor: 0 }),
    ...(kind === 'guide' ? { intervention: { kind: 'guide', address: { run: f.location.run, stage: 'work', attempt: 'attempt_a',
     invocation: 1 } } } : {}) };
}
function argv(kind: 'start' | 'cancel' | 'resume' | 'status' | 'guide') { if (kind === 'status')
  return ['status', '--run', f.location.run]; return [kind, '--run', f.location.run, '--intent', JSON.stringify(addressed(kind)),
   ...(kind === 'guide' ? ['--guidance', '-'] : [])]; }
/** Pinned setup receives the request, config-derived graph and original bytes. Admission waits for the copy. */
const setupInput = (request: object = f.request) => encode({ ...request, plan: f.plan,
  bytes: Buffer.from(f.briefBytes).toString('base64') });
/** Setup now admits the run, so a selected config must name the roles the fixed graph binds. */
const graphRoles = () => ['plan', 'work', 'gate'].map(id => ({ ...f.configuration.roles[0], id }));
beforeEach(async () => {
  f = await fixture();
  await mkdir(f.configRoot, { recursive: true });
  await writeFile(join(f.configRoot, 'runtime.json'), JSON.stringify(f.configuration));
  await writeFile(join(f.root, 'brief.md'), f.briefBytes);
  const { requester: _requester, ...launch } = f.launch;
  ctx = { home: f.root, cwd: f.root, storeRoot: f.root, runtimeRoot: join(f.root, 'pins', 'run_a'), environment: {
   ONLY_DECLARED: 'opaque' }, stdin: encode(launch), abort: new AbortController().signal,
    stdout: vi.fn(async () => undefined), stderr: vi.fn(async () => undefined) };
  vi.mocked(verifyRuntime).mockResolvedValue(ok(f.runtime));
  vi.mocked(pinRuntime).mockResolvedValue({ ok: false, kind: 'unavailable', detail: 'synthetic runtime pin boundary' });
  vi.mocked(operateRun).mockImplementation(async (request) => ok({ intent: request.intent, state: 'acknowledged', cursor: 1,
   observation: null, evidence: [], detail: 'committed control only' }));
  vi.mocked(admitRun).mockResolvedValue(ok(f.projection));
  vi.mocked(runUnitEntry).mockResolvedValue(ok({ status: 'complete', reason: 'completed', detail: 'from core' }));
  vi.mocked(setup).mockResolvedValue(ok(f.setup));
  vi.mocked(land).mockResolvedValue(ok({ location: f.location, state: 'reclaimed', unconfinedCommands: [], outputs: { preserved: true, artifacts: [],
   detail: '' }, evidence: [] }));
  vi.mocked(listRuns).mockReturnValue(ok([]));
  vi.mocked(createPreparation).mockResolvedValue({...ok(f.journal),creation:{state:'confirmed',location:f.location}});
  vi.mocked(readPreparation).mockReturnValue(ok(null));
  vi.mocked(endPreparation).mockResolvedValue(ok(0));
  vi.mocked(claim).mockImplementation(async (_path,unit)=>ok({...f.claim,unit}));
  vi.mocked(openWriter).mockResolvedValue(ok(f.writer));
  vi.mocked(release).mockResolvedValue(ok('dead'));
  vi.mocked(publishRunStatus).mockReturnValue(ok({} as never));
  vi.mocked(openJournal).mockResolvedValue(ok(f.journal));
  vi.mocked(readRunStatus).mockResolvedValue(ok({ status: 'pending' } as never));
  vi.mocked(readEvidence).mockResolvedValue(no('invalid'));
  vi.mocked(readEvents).mockImplementation(async (_journal, after) => ok(f.events.filter(event => event.seq > after)));
  vi.mocked(appendEvents).mockImplementation(async (_writer, cursor,
   payloads) => cursor === f.events.length ? ok(f.append(payloads)) : no('conflict'));
  vi.mocked(readProjection).mockResolvedValue(no('unavailable'));
  vi.mocked(putEvidence).mockResolvedValue(ok(ref()));
  vi.mocked(refreshRunStatus).mockResolvedValue(ok({} as never));
  vi.mocked(createCodexAdapter).mockReturnValue({ invoke: async () => no() });
  vi.mocked(createClaudeAdapter).mockReturnValue({ invoke: async () => no() });
  vi.mocked(runAttempt).mockResolvedValue(no('unavailable'));
  vi.mocked(runDeclaredCommand).mockResolvedValue(no('unavailable'));
});
afterEach(async () => { await f.clean(); });
it('help has no config, store, journal, service or dispatch side effects', async () => {
  expect(await humanMain(['--help'], { ...ctx, runtimeRoot: join(f.root, 'absent') })).toBe(0);
  const help = Buffer.from(vi.mocked(ctx.stdout).mock.calls.at(-1)![0]).toString();
  expect(help).toContain('monitor [--port N] [--host H] [--store-root DIR ...]');
  expect(help).toContain('127.0.0.1:8795');
  for (const retired of ['unit-entry', 'release', '--intent', 'doctor', '--reclaim']) expect(help).not.toContain(retired);
  expect(verifyRuntime).not.toHaveBeenCalled();
  expect(operateRun).not.toHaveBeenCalled();
  expect(readEvents).not.toHaveBeenCalled();
});
it.each(['daemon', 'campaign', 'watch', 'deploy', 'prune', 'notify', 'unknown'])('refuses removed/unknown command %s', async (command) => {
  expect(await main([command], ctx)).toBe(2);
  expect(verifyRuntime).not.toHaveBeenCalled();
});
it.each([[], ['status'], ['setup'], ['start'], ['cancel'], ['resume'], ['guide'], ['unit-entry'], ['land'], ['release'], ['release',
 'unknown'], ['status', '--bogus', 'x'], ['--help', '--run', 'x']].map(args => ({
 args })))('refuses missing/unknown grammar $args before I/O', async ({ args }) => {
  expect(await main(args, ctx)).toBe(2);
  expect(verifyRuntime).not.toHaveBeenCalled();
  expect(operateRun).not.toHaveBeenCalled();
});
it.each(['start', 'cancel', 'resume',
 'guide'] as const)('dispatches explicit %s exactly once without interpreting acknowledgement as completion', async (command) => {
  expect(await main(argv(command), ctx)).toBe(0);
  expect(operateRun).toHaveBeenCalledTimes(1);
  expect(operateRun).toHaveBeenCalledWith(expect.objectContaining({ location: f.location, intent: { ...addressed(command),
   expectedCursor: 0, ...(command === 'guide' ? { intervention: { ...addressed('guide').intervention, content: ref() } } : {}) } }),
   expect.objectContaining({ privateEnvironment: ctx.environment, configRoot: f.configRoot, process: expect.any(Function) }));
  expect(runUnitEntry).not.toHaveBeenCalled();
});
it('setup admits what it prepared: backend and requester flow verbatim into the launch record, start has no requester option', async () => {
  const setupArgs = (requester: string) => ({ command: 'setup', options: { backend: 'codex', run: f.location.run, unit: JSON.stringify(f.unit), requester } });
  expect(await main(setupArgs('frontend:session_123'), { ...ctx, stdin: setupInput() })).toBe(0);
  expect(admitRun).toHaveBeenCalledExactlyOnceWith(f.location, expect.objectContaining({ backend: 'codex', run: f.location.run, unit: f.unit,
   requester: 'frontend:session_123', roles: f.configuration.roles, setup: f.setup }), f.plan, expect.any(Object));
  expect(await main(['start', '--run', f.location.run, '--intent', JSON.stringify(addressed('start')), '--requester', 'frontend:x'], ctx)).toBe(2);
});
it('setup carries original bytes/environment without a workload recorder; unit-entry and land use their sole ports', async () => {
  expect(await main({ command: 'setup', options: { backend: 'codex', run: f.location.run, unit: JSON.stringify(f.unit) } }, {
   ...ctx, stdin: setupInput() })).toBe(0);
  // Pinned setup receives the original bytes and explicit config/environment to decide admission on its copy.
  expect(setup).toHaveBeenCalledWith(f.request, expect.objectContaining({ briefBytes: Buffer.from(f.briefBytes),
   configuration: expect.any(Object), environment: ctx.environment, configRoot: f.configRoot }));
  expect(admitRun).toHaveBeenCalledTimes(1);
  expect(appendEvents).not.toHaveBeenCalled();
  expect(await main(['unit-entry', '--run', f.location.run, '--unit', JSON.stringify(f.unit)], ctx)).toBe(0);
  expect(runUnitEntry).toHaveBeenCalledTimes(1);
  expect(await main(['land', '--run', f.location.run], ctx)).toBe(0);
  expect(land).toHaveBeenCalledWith(f.location, expect.any(Function), expect.objectContaining({ database: join(f.root,
   'state.sqlite'), storeRoot: f.root, environment: ctx.environment }));
});
it.each([['invalid', 2], ['conflict', 1], ['unknown', 3], ['unavailable', 3]] as const)('maps Result %s to exit %s', async (kind, exit) => {
  vi.mocked(operateRun).mockResolvedValue(no(kind));
  expect(await main(argv('cancel'), ctx)).toBe(exit);
});
it('preserves the capture conflict exit code for the output_changed fact', async () => {
  vi.mocked(operateRun).mockResolvedValue({ ok: false, kind: 'output_changed', detail: 'Declared output changed during capture' });
  expect(await main(argv('cancel'), ctx)).toBe(1);
});
it.each([['acknowledged', 0], ['refused', 1], ['unknown', 3], ['not_confirmed_closed', 3]] as const)('maps control %s to exit %s', async (state, exit) => {
  vi.mocked(operateRun).mockImplementation(async (request) => ok({ intent: request.intent, state, cursor: 1, observation: null,
   evidence: [], detail: 'opaque' }));
  expect(await main(argv('cancel'), ctx)).toBe(exit);
});
it('rejects malformed JSON/schema, repeated options, mismatched addresses and runtime root', async () => {
  const setupArgs = { command: 'setup', options: { backend: 'codex', run: f.location.run, unit: JSON.stringify(f.unit) } };
  expect(await main(setupArgs, { ...ctx, stdin: encode({ invalid: true }) })).toBe(2);
  expect(await main(setupArgs, { ...ctx, stdin: new TextEncoder().encode('{') })).toBe(2);
  expect(await main([...argv('status'), '--run', f.location.run], ctx)).toBe(2);
  expect(await main([...argv('status'), '--bogus', 'x'], ctx)).toBe(2);
  expect(await main(['cancel', '--run', f.location.run, '--intent', JSON.stringify(addressed('status'))], ctx)).toBe(2);
  expect(await main(argv('cancel'), { ...ctx, runtimeRoot: f.source })).toBe(2);
  expect(operateRun).not.toHaveBeenCalled();
});
it('an untyped output callback exception is an unknown outcome (exit 3); a refusal keeps its class when the report cannot be written', async () => {
  const broken = vi.fn(async () => { throw new TypeError('broken output'); });
  expect(await main(argv('status'), { ...ctx, stdout: broken })).toBe(3);
  // The exit class belongs to the failure, not to whether anyone could be told: an unknown command is invalid input.
  expect(await main(['unknown'], { ...ctx, stderr: broken })).toBe(2);
});
it('workflow closures pass the owner-bound recorder, exact adapter environment, scope and abort without fallback', async () => {
  await main(argv('cancel'), ctx);
  const services = vi.mocked(operateRun).mock.calls[0][1];
  const process = services.process(f.writer);
  const scope = { journal: f.journal, layout: { location: f.location, project: f.target, protectedRoots: [], sharedCaches: [] },
   brief: f.brief, inputBaseline: [], outputBaseline: [], projectClaim: f.claim };
  const ports = services.workflowPorts(scope, f.writer, process, ctx.abort);
  const request = { role: f.configuration.roles[0] } as never;
  await ports.attempt(request);
  expect(createCodexAdapter).toHaveBeenCalledWith({ journal: f.journal, process, privateEnvironment: ctx.environment });
  expect(runAttempt).toHaveBeenCalledWith(request, expect.objectContaining({ scope, process, configRoot: f.configRoot, abort: ctx.abort }));
  await ports.command({ command: f.brief.declaration.commands[0], key: f.command.key, reservation: {} } as never);
  expect(runDeclaredCommand).toHaveBeenCalledWith(expect.any(Object), { scope, writer: f.writer, process, abort: ctx.abort });
  await ports.publishStatus({ at: '2026-01-01T00:00:00.000Z', monotonicMs: 0 }, null);
  expect(publishRunStatus).toHaveBeenCalledWith(f.location, '2026-01-01T00:00:00.000Z', null);
});
it('resolves explicitly supplied relative store/runtime/setup locators against MainContext.cwd', async () => {
  const relative = { ...ctx, storeRoot: '.', runtimeRoot: 'pins/run_a' };
  expect(await main(argv('cancel'), relative)).toBe(0);
  expect(operateRun).toHaveBeenCalledWith(expect.objectContaining({ location: f.location }), expect.any(Object));
  expect(await main({ command: 'setup', options: { backend: 'codex', run: f.location.run, unit: JSON.stringify(f.unit) } }, {
   ...relative, stdin: setupInput({ ...f.request, project: 'source', target: 'project' }) })).toBe(0);
  expect(setup).toHaveBeenCalledWith(f.request, expect.any(Object));
});
it('start builds its pre-admission cursor from journal facts and refuses an operator cursor', async () => {
  f.append([{ type: 'ownership', owner: f.owner, state: 'dead' }]);
  expect(await main(argv('start'), ctx)).toBe(0);
  expect(openJournal).toHaveBeenCalledWith(f.location, 'read');
  expect(readEvents).toHaveBeenCalledWith(f.journal, 0);
  expect(operateRun).toHaveBeenCalledWith(expect.objectContaining({ intent: { ...addressed('start'), expectedCursor: 1 } }), expect.any(Object));
  expect(vi.mocked(readEvents).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(operateRun).mock.invocationCallOrder[0]);
  vi.mocked(operateRun).mockClear();
  expect(await main(['start', '--run', f.location.run, '--intent', JSON.stringify({ ...addressed('start'), expectedCursor: 99 }),
   ], ctx)).toBe(2);
  expect(operateRun).not.toHaveBeenCalled();
});
it('start retry retains the committed intent boundary after a lost response', async () => {
  f.append([{ type: 'control_intent', intent: { ...addressed('start'), kind: 'start', expectedCursor: 0 } }]);
  expect(await main(argv('start'), ctx)).toBe(0);
  expect(vi.mocked(operateRun).mock.calls[0][0].intent.expectedCursor).toBe(0);
});
it.each(['unknown', 'unavailable'] as const)('start journal %s refuses without fabricating a zero cursor', async (kind) => {
  vi.mocked(openJournal).mockResolvedValue(no(kind));
  expect(await main(argv('start'), ctx)).toBe(3);
  expect(operateRun).not.toHaveBeenCalled();
});
it('status CLI regenerates the disposable snapshot without runtime or control effects', async () => {
  expect(await main(argv('status'), { ...ctx, runtimeRoot: 'absent', stdin: new Uint8Array([255]) })).toBe(0);
  expect(refreshRunStatus).toHaveBeenCalledWith(f.location,expect.any(String),undefined);
  expect(openJournal).not.toHaveBeenCalled();
  expect(readEvents).not.toHaveBeenCalled();
  expect(appendEvents).not.toHaveBeenCalled();
  expect(operateRun).not.toHaveBeenCalled();
  expect(verifyRuntime).not.toHaveBeenCalled();
  expect(await main([...argv('status'), '--intent', '{}'], ctx)).toBe(2);
});
it('status list on a fresh store is an empty JSON array without run or pin effects', async () => {
  const context = { ...ctx, storeRoot: join(f.root, 'empty-store'), boot: 'fixture-boot' };
  expect(await humanMain(['status'], context)).toBe(0);
  expect(JSON.parse(Buffer.from(vi.mocked(ctx.stdout).mock.calls.at(-1)![0]).toString())).toEqual([]);
  expect(refreshRunStatus).not.toHaveBeenCalled();
  expect(openJournal).not.toHaveBeenCalled();
  expect(pinRuntime).not.toHaveBeenCalled();
  expect(operateRun).not.toHaveBeenCalled();
});

it.each(['file', 'stdin'] as const)('guide CLI stores exact %s bytes through the run journal before dispatch', async (source) => {
  const bytes = new Uint8Array([0, 255, 10, 13, 42]);
  await writeFile(join(f.root, 'guidance.bin'), bytes);
  const args = argv('guide');
  args[args.length - 1] = source === 'file' ? 'guidance.bin' : '-';
  vi.mocked(putEvidence).mockResolvedValue(ok(ref('operator-guide')));
  expect(await main(args, { ...ctx, stdin: bytes })).toBe(0);
  expect(putEvidence).toHaveBeenCalledWith(f.journal, source === 'file' ? Buffer.from(bytes) : bytes);
  expect(operateRun).toHaveBeenCalledWith(expect.objectContaining({ intent: expect.objectContaining({ intervention: {
   ...addressed('guide').intervention, content: ref('operator-guide') } }) }), expect.any(Object));
  expect(vi.mocked(putEvidence).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(operateRun).mock.invocationCallOrder[0]);
});
it('guide evidence failure refuses dispatch and pre-stored content is not a second CLI source', async () => {
  vi.mocked(putEvidence).mockResolvedValue(no('invalid'));
  expect(await main(argv('guide'), ctx)).toBe(2);
  expect(operateRun).not.toHaveBeenCalled();
  const args = argv('guide');
  args[4] = JSON.stringify({ ...addressed('guide'), intervention: { ...addressed('guide').intervention, content: ref() } });
  expect(await main(args, ctx)).toBe(2);
});
it('host context comes from explicit roots/environment and is shared with run and land', async () => {
  await main(argv('cancel'), ctx);
  const services = vi.mocked(operateRun).mock.calls[0][1];
  expect(services.unitContext).toMatchObject({ database: join(f.root, 'state.sqlite'), storeRoot: f.root, environment: ctx.environment,
   pending: expect.any(Function), observation: expect.any(Function) });
  expect(services.unitContext.environment).toBe(ctx.environment);
  await main(['land', '--run', f.location.run], ctx);
  expect(land).toHaveBeenCalledWith(f.location, expect.any(Function), expect.objectContaining({
   database: services.unitContext.database, storeRoot: f.root, environment: ctx.environment }));

});
it('bound recorder reads authenticated evidence through its writer journal and preserves read/hash refusals', async () => {
  await main(argv('cancel'), ctx);
  const ports = vi.mocked(operateRun).mock.calls[0][1].process(f.writer);
  const bytes = new Uint8Array([0, 255, 10]);
  const evidence = { path: 'stdin.bin', sha256: hash(bytes) };
  await writeFile(join(f.journal.root, evidence.path), bytes);
  vi.mocked(readEvidence).mockImplementation(async (journal, reference) => {
    try {
      const stored = await readFile(join(journal.root, reference.path));
      return hash(stored) === reference.sha256 ? ok(stored) : no('invalid');
    }
    catch {
      return no('unavailable');
    }
  });
  expect(await ports.readEvidence(evidence)).toEqual(ok(Buffer.from(bytes)));
  expect(readEvidence).toHaveBeenCalledWith(f.journal, evidence);
  expect(await ports.readEvidence({ ...evidence, sha256: hash('wrong') })).toEqual(no('invalid'));
  expect(await ports.readEvidence({ ...evidence, path: 'missing' })).toEqual(no('unavailable'));
  expect(appendEvents).not.toHaveBeenCalled();
});
it('publication refusal cannot retract an already committed process recording', async () => {
  expect(await main(['unit-entry', '--run', f.location.run, '--unit', JSON.stringify(f.unit)], ctx)).toBe(0);
  const services = vi.mocked(runUnitEntry).mock.calls[0][2];
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  vi.mocked(refreshRunStatus).mockResolvedValue(no('conflict'));
  expect(await services.process(f.writer).recordProcess({ type: 'ownership', owner: f.owner, state: 'live' })).toEqual(ok(1));
  expect(f.events[0].payload).toEqual({ type: 'ownership', owner: f.owner, state: 'live' });
});
vi.mock('../dist-rewrite/records/evidence.js', async () => ({ ...await vi.importActual('../dist-rewrite/records/evidence.js'),
 putEvidence: vi.fn(), readEvidence: vi.fn(), initializeEvidence: vi.fn(async () => undefined) }));


/** The pinned runtime is the test's boundary: the public adapter's own effects (store, state, pin call) are real, the operation it
 * dispatches is captured. */
function dispatched(code: 0 | 1 | 2 | 3 = 0, emit?: (context: MainContext) => Promise<void>) {
  vi.mocked(pinRuntime).mockResolvedValue(ok(f.runtime));
  return vi.spyOn(host, 'performOperation').mockImplementation(async request => {
    const context = request.args[1] as MainContext;
    if ((request.args[0] as { command?: string }).command === 'setup') {
      vi.mocked(readPreparation).mockReturnValue(ok({ admitted: code === 0, status: code === 0 ? 'pending' : 'preparing' } as never));
      vi.mocked(readProjection).mockResolvedValue(ok({ ...f.projection, brief: JSON.parse(Buffer.from(context.stdin).toString()).brief, launch: { ...f.launch,
        setup: { ...f.setup, interpretation: ['Role r: backend=codex'] } } }));
    }
    await emit?.(context);
    if (Array.isArray(request.args[0])) return ok(code) as never;
    return (code === 0 ? ok({state:'acknowledged'}) : no(code === 1 ? 'conflict' : code === 2 ? 'invalid' : 'unknown')) as never;
  });
}
const stderrText = () => vi.mocked(ctx.stderr).mock.calls.map(([bytes]) => Buffer.from(bytes).toString()).join('');
const published = () => JSON.parse(Buffer.from(vi.mocked(ctx.stdout).mock.calls.at(-1)![0]).toString());
it('public setup accepts retired keys, emits an advisory, records the original digest and starts nothing', async () => {
  const config = join(f.root, 'selected.json');
  const metadata = { criteria: [{ id: 'correct', text: 'Synthetic admission' }], inputs: [], outputs: [], results: [], allowBlocked: false,
    commands: [{ id: 'npm_ci', argv: ['/synthetic/npm', 'ci'], env: { TMPDIR: join(f.root, 'arbitrary-tmp') }, inputs: [], required: false, unconfined: false }] };
  const brief = join(f.root, 'admission.md'), bytes = '---\n' + JSON.stringify(metadata) + '\n---\nSynthetic.';
  await writeFile(brief, bytes);
  await writeFile(config, JSON.stringify({ ...f.configuration, roles: graphRoles(), sharedCaches: ['missing'], devices: ['missing'], providerHomes: { ignored: true } }));
  const context = { ...ctx, storeRoot: join(f.root, 'admission-store'), home: join(f.root, 'admission-state') };
  const call = dispatched(0, async inner => { await inner.stdout(Buffer.from(JSON.stringify({ interpretation: ['Role r: backend=codex'] }))); });
  try {
    expect(await humanMain(['setup', brief, '--project', f.source, '--config', config], context)).toBe(0);
    const prepared = published();
    expect(prepared).toMatchObject({ run: expect.stringMatching(/^run_/), briefDigest: hash(bytes), commands: ['npm_ci'], interpretation: ['Role r: backend=codex'] });
    expect(prepared.executionBoundary).toContain('All authors/providers/commands run with host-account rights.');
    expect(prepared.detail).toContain('flowcrew start ' + prepared.run);
    expect(stderrText()).toContain('these keys constrain nothing');
    // Setup is the one dispatch; it records the run, a second dispatch (a start) never happens here.
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].args[0]).toMatchObject({ command: 'setup', options: { run: prepared.run } });
    expect(pinRuntime).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pinRuntime).mock.calls[0][0], 'setup pins the installation that decoded its options').toBe(resolve(import.meta.dirname, '..'));
    expect(await readFile(brief, 'utf8')).toBe(bytes);
  } finally { call.mockRestore(); }
});
it('setup records the options that shape the run; start takes none and reads no brief or config file', async () => {
  const config = join(f.root, 'recorded.json');
  const metadata = { criteria: [{ id: 'correct', text: 'Synthetic admission' }], inputs: [], outputs: [], results: [], allowBlocked: false, commands: [] };
  const brief = join(f.root, 'recorded.md');
  await writeFile(brief, '---\n' + JSON.stringify(metadata) + '\n---\nSynthetic.');
  await writeFile(config, JSON.stringify({ ...f.configuration, roles: graphRoles() }));
  const context = { ...ctx, storeRoot: join(f.root, 'recorded-store'), home: join(f.root, 'recorded-state') };
  const call = dispatched();
  try {
    const configured = graphRoles()[0].backend, other = configured === 'claude' ? 'codex' : 'claude';
    for (const [extra, backend] of [[[], configured], [['--backend', other], other]] as const) {
      vi.mocked(pinRuntime).mockClear(); call.mockClear();
      expect(await humanMain(['setup', brief, '--project', f.source, '--config', config, '--requester', 's', ...extra], context)).toBe(0);
      // The pin is where the selected config lives: its roles carry the chosen backend.
      expect(vi.mocked(pinRuntime).mock.calls[0][3]).toMatchObject({ roles: graphRoles().map(() => ({ backend })) });
      expect(call.mock.calls[0][0].args[0]).toMatchObject({ command: 'setup', options: { backend, requester: 's' } });
    }
    for (const option of [['--config', config], ['--project', f.source], ['--backend', 'codex'], ['--requester', 's']])
      expect(await humanMain(['start', 'run_a', ...option], context)).toBe(2);
  } finally { call.mockRestore(); }
});
it.each([
  ['missing operand file', (root: string) => ['setup', join(root, 'missing.md')]],
  ['malformed config', (root: string) => ['setup', join(root, 'brief.md'), '--config', join(root, 'brief.md')]],
  ['unknown option', (root: string) => ['setup', join(root, 'brief.md'), '--nonsense', 'x']],
])('public %s is exit 2 with no store created', async (_what, build) => {
  await writeFile(join(f.root, 'brief.md'), f.briefBytes);
  const context = { ...ctx, storeRoot: join(f.root, 'absent-store'), home: join(f.root, 'absent-state') };
  expect(await humanMain(build(f.root), context), stderrText()).toBe(2);
  expect(JSON.parse(stderrText().trim().split('\n').at(-1)!)).toMatchObject({ ok: false, kind: 'invalid' });
  await expect(access(context.storeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(context.home)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(pinRuntime).not.toHaveBeenCalled();
});
it('public start launches the journal record only: one dispatch, no operator cursor, digest from the record, a second start is refused', async () => {
  vi.mocked(openJournal).mockResolvedValue(ok(f.journal));
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  const call = dispatched(0, async inner => { await inner.stdout(Buffer.from(JSON.stringify({ state: 'acknowledged' }))); });
  try {
    expect(await humanMain(['start', f.location.run], ctx), stderrText()).toBe(0);
    const [args] = call.mock.calls[0][0].args as [string[], MainContext];
    expect(args.slice(0, 3)).toEqual(['start', '--run', f.location.run]);
    expect(args).not.toContain('--brief'); expect(args).not.toContain('--config'); expect(args).not.toContain('--planner-role');
    expect(JSON.parse(args[args.indexOf('--intent') + 1])).toEqual({ id: expect.stringMatching(/^start_/), kind: 'start', run: f.location.run, unit: f.unit });
    expect(published()).toMatchObject({ run: f.location.run, briefDigest: f.brief.digest, operation: { state: 'acknowledged' } });
  } finally { call.mockRestore(); }
});
it('the public adapter forwards byte-identical repeated stderr chunks without output deduplication',async()=>{
  await writeFile(join(f.root, 'brief.md'), f.briefBytes); await writeFile(join(f.root, 'chunks.json'), JSON.stringify({ ...f.configuration, roles: graphRoles() }));
  const call=dispatched(3, async inner => { await inner.stderr(Buffer.from('same chunk\n'));await inner.stderr(Buffer.from('same chunk\n')); });
  try {
    expect(await humanMain(['setup',join(f.root,'brief.md'),'--project',f.source,'--config',join(f.root,'chunks.json')],ctx)).toBe(3);
    expect(stderrText().split('same chunk\n').length - 1).toBe(2);
  } finally {call.mockRestore();}
});
it('status --brief prints the stored brief bytes verbatim, and says so once land has removed them', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 45, 45, 45, 13, 10, 255]);
  vi.mocked(readEvidence).mockResolvedValue(ok(bytes));
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  expect(await humanMain(['status', f.location.run, '--brief'], ctx)).toBe(0);
  expect(readEvidence).toHaveBeenCalledWith(f.journal, f.projection.brief.bytes);
  expect(Buffer.from(vi.mocked(ctx.stdout).mock.calls.at(-1)![0])).toEqual(Buffer.from(bytes));
  // "Reclaimed" is the projection's fact, read there: the journal's events are not consulted for it.
  vi.mocked(readEvents).mockClear();
  vi.mocked(readProjection).mockResolvedValue(ok({ ...f.projection, reclaimed: { at: '2026-01-01T00:00:00.000Z', delivery: f.root } }));
  expect(await humanMain(['status', f.location.run, '--brief'], ctx)).toBe(1);
  expect(JSON.parse(stderrText().trim().split('\n').at(-1)!)).toMatchObject({ kind: 'conflict', detail: expect.stringContaining('removed by land') });
  expect(readEvents).not.toHaveBeenCalled();
  expect(await humanMain(['status', '--brief'], ctx)).toBe(2);
});
it('land refuses the retired --reclaim option and an internal --mode before any I/O', async () => {
  expect(await humanMain(['land', f.location.run, '--reclaim'], ctx)).toBe(2);
  expect(await main(['land', '--run', f.location.run, '--mode', 'preserve'], ctx)).toBe(2);
  expect(land).not.toHaveBeenCalled();
  expect(openJournal).not.toHaveBeenCalled();
});

it('land parses repeated acceptance declarations, keeps equals in reasons and prints the record', async () => {
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  const acceptedUnmet = [{ criterionId: 'C3', status: 'fail' as const, evidence: 'Score 0.842 < 0.87',
    reason: 'score=0.842; accept plateau', at: '2026-11-23T12:00:00.000Z' }];
  vi.mocked(land).mockResolvedValue(ok({ location: f.location, state: 'reclaimed', executionBoundary: '',
    outputs: { preserved: true, artifacts: [], detail: '' }, evidence: [], acceptedUnmet }));
  expect(await humanMain(['land', f.location.run, '--accept-unmet', 'C3=score=0.842; accept plateau',
    '--accept-unmet', 'C4=Accept unmeasured criterion'], ctx)).toBe(0);
  expect(land).toHaveBeenCalledWith(f.location, expect.any(Function), expect.any(Object), [
    { criterionId: 'C3', reason: 'score=0.842; accept plateau' },
    { criterionId: 'C4', reason: 'Accept unmeasured criterion' }
  ]);
  expect(JSON.parse(Buffer.from(vi.mocked(ctx.stdout).mock.calls.at(-1)![0]).toString()).acceptedUnmet).toEqual(acceptedUnmet);
});

it.each(['C3', '=reason'])('land refuses malformed acceptance %s before I/O', async value => {
  expect(await humanMain(['land', f.location.run, '--accept-unmet', value], ctx)).toBe(2);
  expect(openJournal).not.toHaveBeenCalled();
  expect(land).not.toHaveBeenCalled();
});

it.each(['', '   '])('land delegates blank reason %j to the operation validator', async reason => {
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  vi.mocked(land).mockResolvedValue({ ok: false, kind: 'invalid', detail: 'Acceptance needs a reason' });
  expect(await humanMain(['land', f.location.run, '--accept-unmet', 'C3=' + reason], ctx)).toBe(2);
  expect(land).toHaveBeenCalledWith(f.location, expect.any(Function), expect.any(Object), [{ criterionId: 'C3', reason }]);
});

it.each(['Unknown frozen criterion: C9', 'Latest gate passed criterion: C3'])('land preserves invalid acceptance exit 2: %s', async detail => {
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  vi.mocked(land).mockResolvedValue({ ok: false, kind: 'invalid', detail });
  expect(await humanMain(['land', f.location.run, '--accept-unmet', 'C3=Human decision'], ctx)).toBe(2);
});
it('doctor is no longer a public command', async () => { expect(await humanMain(['doctor'], ctx)).toBe(2); });

it('preparation refuses dependencies through symlinks and allows future project paths', async () => {
  await symlink(f.root,join(f.source,'alias'));
  const runtime = {source:f.source,project:join(f.root,'work','Dependencies','project'),
    workRoot:join(f.root,'work','Dependencies'),protectedRoots:[f.source],backend:'codex' as const,environment:{}};
  const command = {id:'Check',argv:['/synthetic/check'],env:{},inputs:[],required:true};
  const declaration = {...f.brief.declaration,commands:[{...command,dependsOn:['alias/target']}]};
  expect(await admitPreparation(declaration,f.configuration,runtime)).toMatchObject({ok:false,kind:'invalid',detail:expect.stringContaining('checkpoint trees record symlinks')});
  expect((await admitPreparation({...declaration,commands:[{...command,dependsOn:['future/file']}]},f.configuration,runtime)).ok).toBe(true);
});

it('preparation owns raw root identities and refuses engine destination overlap', async () => {
  const storeAlias = join(f.root, 'store-alias'), sourceAlias = join(f.root, 'source-alias');
  await symlink(f.root, storeAlias); await symlink(f.source, sourceAlias);
  const canonical = { project: f.source, storeRoot: f.root, home: join(f.root, 'future-state') };
  expect(await preparationPaths({ project: sourceAlias, storeRoot: storeAlias,
    home: join(storeAlias, 'future-state') }, 'Parity')).toEqual(ok({ ...canonical, target: join(f.root, 'work', 'Parity', 'project') }));
  const runtime = { source: f.source, project: join(f.root, 'work', 'Parity', 'project'),
    workRoot: join(f.root, 'work', 'Parity'), protectedRoots: [f.source], backend: 'codex' as const, environment: {} };
  const configuration = { ...f.configuration, devices: [] };
  const physical = await admitPreparation(f.brief.declaration, configuration, runtime);
  expect(physical.ok).toBe(true);
  const aliased = await admitPreparation(f.brief.declaration, configuration, { ...runtime,
    source: sourceAlias, project: join(storeAlias, 'work', 'Parity', 'project'),
    workRoot: join(storeAlias, 'work', 'Parity'), protectedRoots: [sourceAlias] });
  expect(aliased).toEqual(physical);
  // Canonicalization must expose this overlap, never turn it into writable authority.
  expect(await admitPreparation(f.brief.declaration, configuration, { ...runtime,
    project: sourceAlias, protectedRoots: [f.source] })).toMatchObject({ ok: false, kind: 'conflict' });
});

it.each([0, 1, 2, 3] as const)('public controls retain the pinned numeric-exit contract %s', async code => {
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  const call = dispatched(code);
  try {
    expect(await humanMain(['start', f.location.run], ctx)).toBe(code);
    expect(ctx.stdout).not.toHaveBeenCalled();
  } finally { call.mockRestore(); }
});

it('public controls preserve invalid stored bytes and runtime failures as exit 2', async () => {
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  vi.mocked(readEvidence).mockResolvedValue(no('invalid'));
  expect(await humanMain(['status', f.location.run, '--brief'], ctx)).toBe(2);
  vi.mocked(verifyRuntime).mockResolvedValue(no('invalid'));
  expect(await humanMain(['resume', f.location.run], ctx)).toBe(2);
});

it('the failure contract maps typed causes, creation receipts, exceptions and historical numeric results', async () => {
  const rows = [
    ['missing operand file', 'invalid', 'not_attempted', 2, 'none'],
    ['malformed config', 'invalid', 'not_attempted', 2, 'none'],
    ['unknown option', 'invalid', 'not_attempted', 2, 'none'],
    ['Run already exists', 'conflict', 'rejected_or_aborted', 1, 'none'],
    ['lost COMMIT ack', 'unknown', 'indeterminate', 3, 'maybe'],
    ['readback failure', 'unknown', 'indeterminate', 3, 'maybe'],
    ['failure after confirmed creation', 'invalid', 'confirmed', 2, 'setup'],
    ['late conflict', 'conflict', 'confirmed', 1, 'setup'],
    ['late access failure', 'unavailable', 'confirmed', 3, 'setup'],
    ['late unknown', 'unknown', 'confirmed', 3, 'setup'],
    ['prerequisite conflict', 'conflict', 'not_attempted', 1, 'none'],
    ['prerequisite unavailable', 'unavailable', 'not_attempted', 3, 'none'],
    ['prerequisite unknown', 'unknown', 'not_attempted', 3, 'none'],
    ['aborted invalid', 'invalid', 'rejected_or_aborted', 2, 'none'],
    ['aborted unavailable', 'unavailable', 'rejected_or_aborted', 3, 'none'],
    ['aborted unknown', 'unknown', 'rejected_or_aborted', 3, 'none'],
  ] as const;
  for (const [label, kind, state, exit, effects] of rows) {
    const creation = state === 'confirmed' || state === 'indeterminate' ? { state, location: f.location } : { state };
    const failure = preparationFailure(no(kind), creation);
    expect(failure, label).toMatchObject({ kind, effects });
    expect(exitOf(failure.kind), label).toBe(exit);
    const addressed = effects !== 'none';
    expect('run' in failure ? failure.run : undefined, label).toBe(addressed ? f.location.run : undefined);
    for (const command of ['status', 'cancel', 'land']) expect(failure.detail.includes('flowcrew ' + command), label).toBe(addressed);
    if (effects === 'maybe') expect(failure, label).toMatchObject({ confirmed: false, storeRoot: f.location.storeRoot,
      detail: expect.stringContaining('run directory retained') });
  }
  expect(await reportFailure(new TypeError('untyped exception'), ctx), 'untyped exception').toBe(3);
  expect(JSON.parse(stderrText())).toMatchObject({ kind: 'unknown', effects: 'none' });
  for (const code of [0, 1, 2, 3] as const) {
    const decoded = decodePinnedResult(ok(code));
    expect(decoded, 'numeric pinned result').toMatchObject({ legacyExit: code, ok: code === 0 });
    if (!decoded.ok) expect(exitOf(decoded.kind)).toBe(code);
  }
  for (const kind of ['invalid', 'conflict', 'unavailable', 'unknown'] as const)
    expect(decodePinnedResult(no(kind)), 'typed pinned result').toEqual(no(kind));
  expect(decodePinnedResult(ok({ state: 'acknowledged' }))).toEqual(ok({ state: 'acknowledged' }));
  expect(decodePinnedResult(ok(4))).toMatchObject({ ok: false, kind: 'unknown' });
});

it('pinned setup records one refusal through a held writer', async () => {
  vi.mocked(setup).mockResolvedValue({ ok: false, kind: 'conflict', detail: 'Recorded refusal' });
  expect(await main({ command: 'setup', options: { backend: 'codex', run: f.location.run, unit: JSON.stringify(f.unit) } },
    { ...ctx, stdin: setupInput() })).toBe(1);
  expect(endPreparation).toHaveBeenCalledExactlyOnceWith(f.writer, 'refused', 'Recorded refusal');
  expect(openWriter).toHaveBeenCalledExactlyOnceWith(f.journal, {...f.claim,unit:null}, 'control');
  expect(release).toHaveBeenCalledExactlyOnceWith({...f.claim,unit:null});
});

it.each((['pin','pinned','projection'] as const).flatMap(stage=>(['invalid','conflict','unavailable','unknown'] as const).map(kind=>({stage,kind}))))('public setup keeps its confirmed receipt after $stage / $kind',async({stage,kind})=>{
  const config=join(f.root,'recorded-roles.json');
  await writeFile(config,JSON.stringify({...f.configuration,roles:graphRoles()}));
  const call=dispatched();
  if(stage==='pin')vi.mocked(pinRuntime).mockResolvedValue(no(kind));
  else call.mockImplementation(async()=>{
    vi.mocked(readProjection).mockResolvedValue(stage==='projection'?no(kind):ok(f.projection));
    return stage==='pinned'?no(kind):ok({});
  });
  try {
    expect(await humanMain(['setup',join(f.root,'brief.md'),'--project',f.source,'--config',config],ctx)).toBe(kind==='invalid'?2:kind==='conflict'?1:3);
    expect(published()).toMatchObject({kind,effects:'setup',run:f.location.run});
  } finally {call.mockRestore();}
});

it('raw argv cannot dispatch pinned setup', async () => {
  expect(await main(['setup', '--run', f.location.run, '--unit', JSON.stringify(f.unit), '--backend', 'codex'],
    { ...ctx, stdin: setupInput() })).toBe(2);
  expect(setup).not.toHaveBeenCalled();
});

it.each(['missing', 'kind', 'symlink', 'digest', 'valid'] as const)('input admission owns the %s observation without a full setup', async mode => {
  const path = join(f.source, 'operand');
  if (mode === 'kind') await mkdir(path);
  else if (mode === 'symlink') await symlink(join(f.source, 'ordinary'), path);
  else if (mode !== 'missing') await writeFile(path, 'copied bytes');
  const brief = { ...f.brief.declaration, inputs: [{ id: 'input', path: 'operand', kind: 'file' as const, frozen: false,
    sha256: hash(mode === 'digest' ? 'different bytes' : 'copied bytes') }] };
  const result = admitInputs(brief, f.source);
  if (mode === 'missing') await expect(result).rejects.toMatchObject({ code: 'ENOENT' });
  else if (mode === 'kind' || mode === 'symlink') await expect(result).rejects.toThrow('Declared path kind mismatch or symlink');
  else expect(await result).toMatchObject(mode === 'valid' ? { ok: true } : { ok: false, kind: 'invalid' });
});

it('copy preparation refuses an output beneath a non-directory parent', async () => {
  const brief = { ...f.brief.declaration, outputs: [{ path: 'ignored.txt/child', kind: 'file' as const, existing: 'replace' as const }] };
  expect(await admitPreparation(brief, f.configuration, { source: f.source, project: f.source,
    protectedRoots: [], workRoot: join(f.root, 'work'), backend: 'codex', environment: {} }))
    .toMatchObject({ ok: false, kind: 'invalid' });
});

it.each(['unavailable', 'conflict', 'unknown', 'invalid'] as const)('public addressed database failure keeps %s', async kind => {
  vi.mocked(openJournal).mockResolvedValue(no(kind));
  expect(await humanMain(['status', f.location.run], ctx)).toBe(exitOf(kind));
  expect(JSON.parse(stderrText())).toMatchObject({ kind, effects: 'none' });
});
it('guide reads its plan through the invalid operand owner before pinned dispatch', async () => {
  vi.mocked(readProjection).mockResolvedValue(ok(f.projection));
  const call = dispatched();
  try {
    expect(await humanMain(['guide', f.location.run, 'adjust', '--plan', 'missing-plan.json'], ctx)).toBe(2);
    expect(JSON.parse(stderrText())).toMatchObject({ kind: 'invalid', effects: 'none' });
    expect(call).not.toHaveBeenCalled();
  } finally { call.mockRestore(); }
});

it('a rejected public creation reports only this attempt and never adopts the existing run', async () => {
  const config = join(f.root, 'conflict-config.json');
  await writeFile(config, JSON.stringify({ ...f.configuration, roles: graphRoles() }));
  vi.mocked(createPreparation).mockResolvedValue({ ok: false, kind: 'conflict', detail: 'Run already exists',
    creation: { state: 'rejected_or_aborted' } });
  expect(await humanMain(['setup', join(f.root, 'brief.md'), '--project', f.source, '--config', config], ctx)).toBe(1);
  expect(JSON.parse(stderrText())).toEqual({ ok: false, kind: 'conflict', detail: 'Run already exists', effects: 'none' });
  expect(ctx.stdout).not.toHaveBeenCalled();
  expect(pinRuntime).not.toHaveBeenCalled();
  expect(endPreparation).not.toHaveBeenCalled();
});
