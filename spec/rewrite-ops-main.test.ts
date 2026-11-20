import * as host from '../dist-rewrite/host/process.js';
import { access,mkdir,readFile,symlink,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { admitPreparation, preparationPaths } from '../dist-rewrite/ops/preparation.js';
import { pinRuntime } from '../dist-rewrite/records/pin.js';
import { runAttempt } from '../dist-rewrite/exec/attempt.js';
import { createClaudeAdapter } from '../dist-rewrite/exec/claude.js';
import { createCodexAdapter } from '../dist-rewrite/exec/codex.js';
import { runDeclaredCommand } from '../dist-rewrite/exec/command.js';
import { land } from '../dist-rewrite/ops/land.js';
import { execute as main, main as humanMain,type MainContext } from '../dist-rewrite/ops/main.js';
import { operateRun,runUnitEntry } from '../dist-rewrite/ops/run.js';
import { inspectSetup,setup } from '../dist-rewrite/ops/setup.js';
import { refreshRunStatus,readRunStatus } from '../dist-rewrite/ops/status.js';
import { verifyRuntime } from '../dist-rewrite/records/content.js';
import { readEvidence } from '../dist-rewrite/records/evidence.js';
import { appendEvents,openJournal,putEvidence,readEvents,readProjection } from '../dist-rewrite/records/state.js';
import { fixture,hash,no,ok,ref,type Fixture } from './rewrite-ops-fixture.js';
vi.mock('../dist-rewrite/records/pin.js', () => ({ pinRuntime: vi.fn() }));
vi.mock('../dist-rewrite/ops/run.js', () => ({ operateRun: vi.fn(), runUnitEntry: vi.fn() }));
vi.mock('../dist-rewrite/ops/setup.js', () => ({ inspectSetup: vi.fn(), setup: vi.fn() }));
vi.mock('../dist-rewrite/ops/land.js', () => ({ land: vi.fn() }));
vi.mock('../dist-rewrite/ops/status.js', () => ({ refreshRunStatus: vi.fn(), readRunStatus: vi.fn() }));
vi.mock('../dist-rewrite/records/content.js', async () => ({ ...await vi.importActual('../dist-rewrite/records/content.js'),
 verifyRuntime: vi.fn() }));
vi.mock('../dist-rewrite/records/state.js', async (original) => ({ ...await original<typeof import('../dist-rewrite/records/state.js')>(),
 openJournal: vi.fn(), appendEvents: vi.fn(), readEvents: vi.fn(), readProjection: vi.fn(), putEvidence: vi.fn() }));
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
   ...(kind === 'start' ? ['--planner-role', 'role_a'] : kind === 'guide' ? ['--guidance', '-'] : [])]; }
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
  vi.mocked(runUnitEntry).mockResolvedValue(ok({ status: 'complete', reason: 'completed', detail: 'from core' }));
  vi.mocked(inspectSetup).mockImplementation(async (request) => ok({ request, occupancy: 'free', inputs: [], evidence: [] }));
  vi.mocked(setup).mockResolvedValue(ok(f.setup));
  vi.mocked(land).mockResolvedValue(ok({ location: f.location, state: 'reclaimed', unconfinedCommands: [], outputs: { preserved: true, artifacts: [],
   detail: '' }, evidence: [] }));
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
it('explicit --requester flows verbatim into Launch and malformed values are rejected before dispatch', async () => {
  expect(await main([...argv('start'), '--requester', 'frontend:session_123'], ctx)).toBe(0);
  expect(vi.mocked(operateRun).mock.calls[0][0]).toMatchObject({ launch: { requester: 'frontend:session_123' } });
  vi.mocked(operateRun).mockClear();
  expect(await main([...argv('start'), '--requester', 'invalid space'], ctx)).toBe(2);
  expect(operateRun).not.toHaveBeenCalled();
});
it('setup carries original bytes/environment without a workload recorder; unit-entry and land use their sole ports', async () => {
  expect(await main(['setup', '--backend', 'codex', '--run', f.location.run, '--unit', JSON.stringify(f.unit), '--brief', 'brief.md'], {
   ...ctx, stdin: encode(f.request) })).toBe(0);
  expect(setup).toHaveBeenCalledWith(f.request, expect.objectContaining({ briefBytes: Buffer.from(f.briefBytes),
   privateEnvironment: ctx.environment, configRoot: f.configRoot }));
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
it.each([['acknowledged', 0], ['refused', 1], ['in_progress', 3], ['unknown', 3], ['not_confirmed_closed', 3]] as const)('maps control %s to exit %s', async (state, exit) => {
  vi.mocked(operateRun).mockImplementation(async (request) => ok({ intent: request.intent, state, cursor: 1, observation: null,
   evidence: [], detail: 'opaque' }));
  expect(await main(argv('cancel'), ctx)).toBe(exit);
});
it('rejects malformed JSON/schema, repeated options, mismatched addresses and runtime root', async () => {
  expect(await main(argv('start'), { ...ctx, stdin: encode({ invalid: true }) })).toBe(2);
  expect(await main(argv('start'), { ...ctx, stdin: new TextEncoder().encode('{') })).toBe(2);
  expect(await main([...argv('status'), '--run', f.location.run], ctx)).toBe(2);
  expect(await main([...argv('status'), '--bogus', 'x'], ctx)).toBe(2);
  expect(await main(['cancel', '--run', f.location.run, '--intent', JSON.stringify(addressed('status'))], ctx)).toBe(2);
  expect(await main(argv('cancel'), { ...ctx, runtimeRoot: f.source })).toBe(2);
  expect(operateRun).not.toHaveBeenCalled();
});
it('output callback failures report unknown exit, including TypeError from a broken stream', async () => {
  const broken = vi.fn(async () => { throw new TypeError('broken output'); });
  expect(await main(argv('status'), { ...ctx, stdout: broken })).toBe(3);
  expect(await main(['unknown'], { ...ctx, stderr: broken })).toBe(3);
});
it('bound process recorder serializes callbacks and refreshes its private CAS cursor after independent appends', async () => {
  await main(argv('cancel'), ctx);
  const services = vi.mocked(operateRun).mock.calls[0][1];
  expect(readEvents).not.toHaveBeenCalled();
  const process = services.process(f.writer);
  expect(readEvents).not.toHaveBeenCalled();
  await process.recordProcess({ type: 'ownership', owner: f.owner, state: 'live' });
  f.append([{ type: 'invocation_reserved', invocation: { charge: 'command', address: { kind: 'setup', run: f.location.run } } }]);
  await Promise.all([process.recordProcess({ type: 'ownership', owner: f.owner, state: 'dead' }), process.recordProcess({
   type: 'run_observed', observation: f.observation })]);
  expect(vi.mocked(appendEvents).mock.calls.map(call => call[1])).toEqual([0, 2, 3]);
});
it('recorder reconciles unknown append and forbids further writes when it remains unknown', async () => {
  await main(argv('cancel'), ctx);
  const services = vi.mocked(operateRun).mock.calls[0][1];
  const process = services.process(f.writer);
  vi.mocked(appendEvents).mockResolvedValue(no());
  expect(await process.recordProcess({ type: 'ownership', owner: f.owner, state: 'live' })).toMatchObject({ ok: false, kind: 'unknown' });
  expect(await process.recordProcess({ type: 'ownership', owner: f.owner, state: 'dead' })).toMatchObject({ ok: false, kind: 'unknown' });
  expect(appendEvents).toHaveBeenCalledTimes(1);
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
  expect(refreshRunStatus).toHaveBeenCalledWith(f.location, '2026-01-01T00:00:00.000Z', undefined, null, []);
});
it('resolves explicitly supplied relative store/runtime/setup locators against MainContext.cwd', async () => {
  const relative = { ...ctx, storeRoot: '.', runtimeRoot: 'pins/run_a' };
  expect(await main(argv('cancel'), relative)).toBe(0);
  expect(operateRun).toHaveBeenCalledWith(expect.objectContaining({ location: f.location }), expect.any(Object));
  expect(await main(['setup', '--backend', 'codex', '--run', f.location.run, '--unit', JSON.stringify(f.unit), '--brief', 'brief.md'], {
   ...relative, stdin: encode({ ...f.request, project: 'source', target: 'project' }) })).toBe(0);
  expect(setup).toHaveBeenCalledWith(f.request, expect.any(Object));
});
it('recorder recognizes an unknown append that actually committed, then continues from refreshed facts', async () => {
  await main(argv('cancel'), ctx);
  const process = vi.mocked(operateRun).mock.calls[0][1].process(f.writer);
  vi.mocked(appendEvents).mockImplementationOnce(async (_writer, _cursor, payloads) => { f.append(payloads); return no(); });
  expect(await process.recordProcess({ type: 'ownership', owner: f.owner, state: 'live' })).toEqual(ok(1));
  expect(await process.recordProcess({ type: 'ownership', owner: f.owner, state: 'dead' })).toEqual(ok(2));
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
   '--planner-role', 'role_a'], ctx)).toBe(2);
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
it.each([false, true])('stdin requester is refused even when the option is supplied=%s', async (option) => {
  expect(await main([...argv('start'), ...(option ? ['--requester', 'from:option'] : [])], { ...ctx, stdin: encode({ ...f.launch,
   requester: 'from:stdin' }) })).toBe(2);
  expect(operateRun).not.toHaveBeenCalled();
  expect(openJournal).not.toHaveBeenCalled();
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
 putEvidence: vi.fn(), readEvidence: vi.fn() }));


it('public setup/start accept retired keys, emit an advisory and preserve the original digest', async () => {
  const config = join(f.root, 'selected.json');
  const metadata = { criteria: [{ id: 'correct', text: 'Synthetic admission' }], inputs: [], outputs: [], results: [], allowBlocked: false,
    commands: [{ id: 'npm_ci', argv: ['/synthetic/npm', 'ci'], env: { TMPDIR: join(f.root, 'arbitrary-tmp') }, inputs: [], required: false, unconfined: false }] };
  const brief = join(f.root, 'admission.md'), bytes = '---\n' + JSON.stringify(metadata) + '\n---\nSynthetic.';
  await writeFile(brief, bytes);
  await writeFile(config, JSON.stringify({ ...f.configuration, sharedCaches: ['missing'], devices: ['missing'], providerHomes: { ignored: true } }));
  const context = { ...ctx, storeRoot: join(f.root, 'admission-store'), home: join(f.root, 'admission-state') };
  const args = [brief, '--project', f.source, '--config', config];
  expect(await humanMain(['setup', ...args], context)).toBe(0);
  const prepared = JSON.parse(Buffer.from(vi.mocked(ctx.stdout).mock.calls.at(-1)![0]).toString());
  expect(prepared.briefDigest).toBe(hash(bytes));
  expect(prepared.executionBoundary).toContain('All authors/providers/commands run with host-account rights.');
  expect(prepared).not.toHaveProperty('readiness');
  expect(prepared).not.toHaveProperty('unconfinedCommands');
  await expect(access(context.storeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(context.home)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(pinRuntime).not.toHaveBeenCalled();
  expect(vi.mocked(ctx.stderr).mock.calls.map(([bytes]) => Buffer.from(bytes).toString()).join('')).toContain('these keys constrain nothing');
  vi.mocked(ctx.stderr).mockClear();
  expect(await humanMain(['start', ...args], context)).toBe(3); // test-owned pin boundary, no execution
  expect(vi.mocked(ctx.stderr).mock.calls.map(([bytes]) => Buffer.from(bytes).toString()).join('')).toContain('these keys constrain nothing');
  expect(pinRuntime).toHaveBeenCalledTimes(1);
  expect(await readFile(brief, 'utf8')).toBe(bytes);
});
it('setup takes the options that shape preparation, so its preview shows the backend start would run', async () => {
  const config = join(f.root, 'preview.json');
  const metadata = { criteria: [{ id: 'correct', text: 'Synthetic admission' }], inputs: [], outputs: [], results: [], allowBlocked: false, commands: [] };
  const brief = join(f.root, 'preview.md');
  await writeFile(brief, '---\n' + JSON.stringify(metadata) + '\n---\nSynthetic.');
  await writeFile(config, JSON.stringify(f.configuration));
  const context = { ...ctx, storeRoot: join(f.root, 'preview-store'), home: join(f.root, 'preview-state') };
  const roles = async (...extra: string[]) => {
    expect(await humanMain(['setup', brief, '--project', f.source, '--config', config, ...extra], context)).toBe(0);
    return (JSON.parse(Buffer.from(vi.mocked(ctx.stdout).mock.calls.at(-1)![0]).toString()).interpretation as string[])
      .filter(line => line.startsWith('Role ')).map(line => /backend=(\w+)/.exec(line)![1]);
  };
  const configured = f.configuration.roles[0].backend, other = configured === 'claude' ? 'codex' : 'claude';
  expect(new Set(await roles())).toEqual(new Set([configured]));
  expect(new Set(await roles('--backend', other))).toEqual(new Set([other]));
  // `--requester` only names the frontend that launches a run; setup launches nothing.
  expect(await humanMain(['setup', brief, '--requester', 's'], context)).toBe(2);
});
it('land takes only a run id: the retired --reclaim option and an internal --mode are refused before any I/O', async () => {
  expect(await humanMain(['land', f.location.run, '--reclaim'], ctx)).toBe(2);
  expect(await main(['land', '--run', f.location.run, '--mode', 'preserve'], ctx)).toBe(2);
  expect(land).not.toHaveBeenCalled();
  expect(openJournal).not.toHaveBeenCalled();
});
it('doctor is no longer a public command', async () => { expect(await humanMain(['doctor'], ctx)).toBe(2); });

it.each(['output', 'parent'] as const)(
  'setup applies the shared %s admission before any run action', async kind => {
    const cache = join(f.root, 'cache'); await mkdir(cache);
    await writeFile(join(f.source, 'exists'), 'source');
    const outside = join(f.root, 'outside'); await mkdir(outside);
    await symlink(outside, join(cache, 'escape'));
    const configuration = { ...f.configuration, providerHomes: { codex: [], claude: [] },
      sharedCaches: kind === 'grant' ? [f.source] : kind === 'cache' ? [join(f.root, 'missing-cache')] : [cache],
      devices: kind === 'device' ? [join(f.root, 'missing-device')] : [] };
    const metadata = { criteria: [{ id: 'correct', text: 'Synthetic admission' }], inputs: [], results: [], allowBlocked: false,
      outputs: kind === 'output' ? [{ path: 'exists', kind: 'file', existing: 'create' }]
        : kind === 'parent' ? [{ path: 'exists/child', kind: 'file', existing: 'replace' }] : [],
      commands: kind === 'physical-tmp' ? [{ id: 'npm_ci', argv: ['/synthetic/npm'],
        env: { TMPDIR: join(cache, 'escape', 'tmp') }, inputs: [], required: false }] : [] };
    const brief = join(f.root, 'admission.md'), config = join(f.root, 'selected.json');
    await writeFile(brief, '---\n' + JSON.stringify(metadata) + '\n---\nSynthetic admission.');
    await writeFile(config, JSON.stringify(configuration));
    const context = { ...ctx, storeRoot: join(f.root, 'admission-store'), home: join(f.root, 'admission-state') };
    const args = [brief, '--project', f.source, '--config', config];
    const setupExit = await humanMain(['setup', ...args], context);
    const setupError = JSON.parse(Buffer.from(vi.mocked(ctx.stderr).mock.calls.at(-1)![0]).toString());
    expect(setupExit).not.toBe(0);
    expect(setupError.ok).toBe(false);
    expect(pinRuntime).not.toHaveBeenCalled();
    await expect(access(context.storeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(context.home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

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
    home: join(storeAlias, 'future-state') })).toEqual(canonical);
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

it('public start forwards byte-identical repeated stderr chunks without output deduplication',async()=>{
  vi.mocked(pinRuntime).mockResolvedValue(ok(f.runtime));
  const call=vi.spyOn(host,'performOperation').mockImplementation(async request=>{
    const context=request.args[1] as MainContext;
    await context.stderr(Buffer.from('same chunk\n'));await context.stderr(Buffer.from('same chunk\n'));
    return {ok:true,value:3} as never;
  });
  try {
    expect(await humanMain(['start','brief.md','--project',f.source],ctx)).toBe(3);
    expect(vi.mocked(ctx.stderr).mock.calls.map(([b])=>Buffer.from(b).toString()).filter(b=>b==='same chunk\n')).toHaveLength(2);
  } finally {call.mockRestore();}
});
