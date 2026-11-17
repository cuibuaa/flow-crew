import { authorityGrant, providerSettings } from '../dist-rewrite/exec/policy.js';
import { fixtureAuthority } from './fixtures/rewrite-authority.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { AdmittedBrief, Ref, Result } from '../dist-rewrite/contract/brief.js';
import { answerSchema } from '../dist-rewrite/contract/answers.js';
import type { AttemptRequest, BackendReply, JournalEvent, Reservation, Writer, ProcessReceipt } from '../dist-rewrite/contract/runtime.js';
import { captureGeneration, observePaths, contentDelta, captureTree, hashInputs, readCheckpoint,
 type ContentScope } from '../dist-rewrite/records/content.js';
import { readProjection, readEvents } from '../dist-rewrite/records/state.js';
import { putEvidence, readEvidence } from '../dist-rewrite/records/evidence.js';
import { readCommand, commitCommand } from '../dist-rewrite/records/state.js';
import { validateRecordRef } from '../dist-rewrite/records/evidence.js';
import { launchInvocation, checkReadiness, type ProcessPorts } from '../dist-rewrite/host/process.js';
import { composeInput } from '../dist-rewrite/exec/input.js';
import { runAttempt, probeExecution, type ExecutionContext } from '../dist-rewrite/exec/attempt.js';
import { identifyCommand, runDeclaredCommand, type CommandRequest, type CommandContext } from '../dist-rewrite/exec/command.js';
vi.mock('../dist-rewrite/records/content.js', async () => ({ ...await vi.importActual('../dist-rewrite/records/content.js'),
 captureGeneration: vi.fn(), observePaths: vi.fn(), contentDelta: vi.fn(), captureTree: vi.fn(), hashInputs: vi.fn(), readCheckpoint: vi.fn() }));
vi.mock('../dist-rewrite/records/state.js', async (original) => ({ ...await original<typeof import('../dist-rewrite/records/state.js')>(),
 putEvidence: async (journal: any, bytes: Uint8Array) => (await import('../dist-rewrite/records/evidence.js')).putEvidence(journal, bytes),
 readProjection: vi.fn(), readEvents: vi.fn(), readCommand: vi.fn(), commitCommand: vi.fn() }));
vi.mock('../dist-rewrite/host/process.js', async (original) => ({
  ...await original<typeof import('../dist-rewrite/host/process.js')>(), launchInvocation: vi.fn(), checkReadiness: vi.fn(),
}));
const encoder = new TextEncoder(), decoder = new TextDecoder();
const h = (v: string) => createHash('sha256').update(v).digest('hex');
const get = <T>(result: Result<T>): T => { if (!result.ok)
  throw new Error(result.detail); return result.value; };
let root: string, scope: ContentScope, request: AttemptRequest, context: ExecutionContext, events: JournalEvent[];
let blobs: Map<string, Uint8Array>, writer: Writer, ports: ProcessPorts, tree: string, inputRefs: Ref[];
let reservation: Reservation | null, processReceipt: ProcessReceipt;
async function put(text: string) { return get(await putEvidence(scope.journal, encoder.encode(text))); }
async function read(ref: Ref) { return decoder.decode(get(await readEvidence(scope.journal, ref))); }
function event(payload: JournalEvent['payload']): void { events.push({ run: 'run', at: '2026-01-01T00:00:00Z', seq: events.length + 1, payload }); }
const workAnswer = (status = 'delivered') => ({ kind: 'work', answer: { status, summary: 'complete synthetic result', caveats: [],
 remainingWork: [], blocks: null } });
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'rewrite-exec-flow-'));
  blobs = new Map();
  events = [];
  tree = h('tree');
  inputRefs = [];
  reservation = null;
  vi.mocked(putEvidence).mockImplementation(async (_, bytes) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex'), ref = { path: `evidence/${sha256}`, sha256 };
    blobs.set(ref.path, bytes.slice());
    return { ok: true, value: ref };
  });
  vi.mocked(readEvidence).mockImplementation(async (_, ref) => {
    const bytes = blobs.get(ref.path);
    return bytes && createHash('sha256').update(bytes).digest('hex') === ref.sha256
      ? { ok: true, value: bytes.slice() } : { ok: false, kind: 'unavailable', detail: 'Missing/corrupt fixture evidence' };
  });
  vi.mocked(validateRecordRef).mockImplementation(async (journal, ref) => {
    const result = await readEvidence(journal, ref);
    return result.ok ? { ok: true, value: ref } : result;
  });
  vi.mocked(readProjection).mockResolvedValue({ ok: true, value: { commands: [], lineage: [] } } as any);
  vi.mocked(readEvents).mockImplementation(async () => ({ ok: true, value: [...events] }));
  vi.mocked(captureTree).mockImplementation(async () => ({ ok: true, value: tree }));
  vi.mocked(captureGeneration).mockImplementation(async () => ({ ok: true, value: { path: 'evidence/' + tree, sha256: tree } }));
  vi.mocked(observePaths).mockResolvedValue({ ok: true, value: [] });
  vi.mocked(contentDelta).mockImplementation(async () => ({ ok: true, value: scope.brief.bytes }));
  vi.mocked(hashInputs).mockImplementation(async () => ({ ok: true, value: inputRefs }));
  vi.mocked(readCommand).mockImplementation(async () => ({ ok: true, value: reservation }));
  vi.mocked(commitCommand).mockImplementation(async (_writer, _cursor, reserved, receipt) => {
    reservation = { ...reserved, state: 'committed', receipt };
    return { ok: true, value: events.length + 1 };
  });
  const brief: AdmittedBrief = { bytes: { path: 'placeholder', sha256: h('brief') }, digest: h('brief'),
    declaration: { body: 'Exact body with {placeholders}, Unicode: 中文\n', criteria: [{ id: 'criterion', text: 'goal' }], inputs: [], outputs: [], commands: [
        { id: 'check', argv: ['explicit-program', 'literal arg'], env: { B: '2', A: '1' }, inputs: [], required: true, durationMs: 500 },
      ], results: [], allowBlocked: false } };
  const owner = { pid: 42, start: 'birth', boot: 'boot' };
  scope = { journal: { root: join(root, 'store', 'runs', 'run') }, layout: { location: { storeRoot: join(root, 'store'), run: 'run' },
      project: join(root, 'project'), protectedRoots: [join(root, 'records')], sharedCaches: [join(root, 'cache')] },
    brief, inputBaseline: [], outputBaseline: [], projectClaim: { resource: join(root, 'project'), owner, epoch: 'epoch', unit: null } };
  scope.authority = { ...fixtureAuthority(scope), backend: 'codex', preferences: [{ role: 'role', backend: 'codex', settings: {
   model: 'declared-model', effort: 'declared-effort', source: { model: 'role', effort: 'role' } } }] };
  const { body, ...metadata } = brief.declaration;
  const briefRef = await put('---\n' + JSON.stringify(metadata) + '\n---\n' + body);
  scope = { ...scope, brief: { ...brief, bytes: briefRef } };
  const stage = { id: 'stage', purpose: 'work' as const, role: 'role', instruction: 'current stage goal', after: [], skills: [] };
  const address = { run: 'run', stage: 'stage', attempt: 'attempt', invocation: 1 };
  request = { address, brief: scope.brief, stage, plan: { revision: 'revision', digest: h('plan'), executed: [], plan: { stages: [stage] } },
    role: { id: 'role', backend: 'codex', model: 'declared-model', effort: 'declared-effort', prompt: 'Exact role prompt {unchanged}',
     description: '' },
    invocation: { charge: 'work', address: { kind: 'stage', ...address } }, evidence: [],
    context: { purpose: 'work', criterionIds: ['criterion'], resultIds: [], roleIds: ['role'], commandIds: ['check'], checkpointIds: [],
     allowBlocked: false, final: false, revision: 'revision' } };
  ports = { putEvidence: value => putEvidence(scope.journal, value), readEvidence: ref => readEvidence(scope.journal, ref),
   recordProcess: async () => ({ ok: true, value: 1 }) };
  writer = { journal: scope.journal, owner, epoch: 'epoch', kind: 'execution', cursor: 0 };
  context = { scope, process: ports, adapter: { invoke: vi.fn() }, configRoot: join(root, 'runtime', 'config'), privateEnvironment: {
   PATH: '/explicit/tools', PRIVATE_MARKER: 'synthetic' }, abort: new AbortController().signal };
  await mkdir(join(context.configRoot, 'roles'), { recursive: true });
  for (const purpose of ['plan', 'work', 'gate'])
    await writeFile(join(context.configRoot, 'roles', `${purpose}.md`), `Exact ${purpose} purpose prompt\n`);
  await mkdir(scope.layout.project);
  event({ type: 'admitted', launch: { plan: undefined, run: 'run', project: scope.layout.project, brief: scope.brief, roles: [request.role],
      runtime: briefRef, setup: { project: 'source', target: scope.layout.project, brief: scope.brief.digest, inputs: [], outputs: [],
       nativeGrant: 'applied', commands: [] },
      unit: { run: 'run', authority: 'synthetic-run', runtime: briefRef } } });
  event({ type: 'plan_committed', plan: request.plan });
  event({ type: 'invocation_reserved', invocation: request.invocation });
  vi.mocked(context.adapter.invoke).mockImplementation(async (backend) => {
    const answerBytes = await put(JSON.stringify(workAnswer()));
    const schema = await put(JSON.stringify(backend.schema));
    return { ok: true, value: { raw: await put(JSON.stringify({ attempt: backend.attempt, role: backend.role, input: backend.input,
     schema, answerBytes })),
        answerBytes, exit: 0, signal: null, ending: 'delivered', closure: 'dead', usage: { state: 'unknown', raw: [] },
         nativeCommands: [] } };
  });
  vi.mocked(checkReadiness).mockResolvedValue({ state: 'applied', evidence: [], detail: '' });
  processReceipt = { state: 'closed', exit: 0, signal: null, grant: 'applied', stdout: await put('exact stdout'),
   stderr: await put('exact stderr'), durationMs: 7, owner };
  vi.mocked(launchInvocation).mockImplementation(async () => ({ ok: true, value: processReceipt }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function purpose(kind: 'work' | 'plan' | 'gate', backend: 'codex' | 'claude' = 'codex') {
  const stage = kind === 'gate' ? { ...request.stage, purpose: kind, commands: [] } : { ...request.stage, purpose: kind };
  request = { ...request, stage, role: { ...request.role, backend }, plan: { ...request.plan, plan: { stages: [stage] } },
    context: { ...request.context, purpose: kind, final: kind === 'gate' } };
  scope.authority = { ...scope.authority, backend, preferences: [{ role: request.role.id, backend, settings: { model: request.role.model,
   effort: request.role.effort, source: { model: 'role', effort: 'role' } } }] };
  const admitted = events[0].payload;
  if (admitted.type !== 'admitted')
    throw new Error('Fixture admission');
  events[0] = { ...events[0], payload: { type: 'admitted', launch: { ...admitted.launch, roles: [request.role] } } };
  events[1] = { ...events[1], payload: { type: 'plan_committed', plan: request.plan } };
}
function nextInvocation() {
  const address = { ...request.address, invocation: request.address.invocation + 1 };
  const invocation = { ...request.invocation, address: { kind: 'stage' as const, ...address } };
  request = { ...request, address, invocation };
  event({ type: 'invocation_reserved', invocation });
}
async function backendReply(change: Partial<BackendReply>, answer: unknown = workAnswer()) {
  vi.mocked(context.adapter.invoke).mockImplementation(async (backend) => {
    const answerBytes = await put(typeof answer === 'string' ? answer : JSON.stringify(answer));
    const schema = await put(JSON.stringify(backend.schema));
    return { ok: true, value: { raw: await put(JSON.stringify({ attempt: backend.attempt, role: backend.role, input: backend.input,
     schema, answerBytes })),
        answerBytes, exit: 0, signal: null, ending: 'delivered', closure: 'dead', usage: { state: 'partial', input: 4, raw: [] },
         nativeCommands: [], ...change } };
  });
}
describe('input composition', () => {
  it.each(['work', 'gate', 'plan'] as const)('preserves exact %s prompt, Role.prompt, full brief and single schema', async (kind) => {
    purpose(kind);
    const schema = answerSchema(request.context);
    const result = get(await composeInput(request, schema, scope, context.configRoot));
    const recorded = JSON.parse(await read(result.input));
    expect(recorded.purpose).toBe(`Exact ${kind} purpose prompt\n`);
    expect(recorded.role.prompt).toBe(request.role.prompt);
    expect(recorded.evidenceRoot).toBe(scope.journal.root);
    expect(recorded.project).toBe(scope.layout.project);
    expect(recorded.workspace).toBe(join(scope.layout.location.storeRoot, 'work', request.address.run, 'stages', request.address.stage,
     request.address.attempt, String(request.address.invocation)));
    expect(recorded.brief).toEqual(request.brief.declaration);
    expect(recorded.schema).toEqual(schema.json);
    expect(result.chars).toBe((await read(result.input)).length);
    expect(result.schema).toBe(schema);
  });
  it('reads complete pinned skills and locates authenticated evidence and a safe checkpoint', async () => {
    const path = join(dirname(context.configRoot), 'skills', 'skill', 'SKILL.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '---\nname: skill\n---\nExact skill {text}\n');
    const manifest = await put('manifest');
    const evidence = await put('binary is allowed as locator');
    request = { ...request, stage: { ...request.stage, skills: ['skill'], baseCheckpoint: 'checkpoint' }, evidence: [evidence],
      context: { ...request.context, checkpointIds: ['checkpoint'] } };
    request = { ...request, plan: { ...request.plan, plan: { stages: [request.stage] } } };
    vi.mocked(readCheckpoint).mockResolvedValue({ ok: true, value: { id: 'checkpoint', address: request.address, parent: null,
     state: 'safe', manifest,
        tree, brief: scope.brief.digest, inputHashes: [], evidence: [] } });
    const result = get(await composeInput(request, answerSchema(request.context), scope, context.configRoot));
    const recorded = JSON.parse(await read(result.input));
    expect(recorded.skills).toEqual([{ id: 'skill', text: '---\nname: skill\n---\nExact skill {text}\n' }]);
    expect(recorded.evidence).toEqual([evidence]);
    expect(recorded.checkpoints[0].manifest).toEqual(manifest);
  });
  it.each(['skill', 'evidence', 'checkpoint', 'brief'] as const)('refuses missing %s without truncation or invented locators', async (missing) => {
    if (missing === 'skill')
      request = { ...request, stage: { ...request.stage, skills: ['missing'] } };
    if (missing === 'evidence')
      request = { ...request, evidence: [{ path: 'missing', sha256: h('missing') }] };
    if (missing === 'checkpoint') {
      request = { ...request, context: { ...request.context, checkpointIds: ['missing'] } };
      vi.mocked(readCheckpoint).mockResolvedValue({ ok: false, kind: 'unavailable', detail: 'missing' });
    }
    if (missing === 'brief')
      blobs.delete(request.brief.bytes.path);
    request = { ...request, plan: { ...request.plan, plan: { stages: [request.stage] } } };
    expect(await composeInput(request, answerSchema(request.context), scope, context.configRoot)).toMatchObject({ ok: false });
  });
  it('preserves guidance original bytes/address across later stages and excludes gates', async () => {
    const content = await put('Exact guidance {unchanged}');
    const originalAddress = request.address;
    nextInvocation();
    request = { ...request, invocation: { ...request.invocation, charge: 'continuation', address: { kind: 'stage',
     ...request.address } }, guidance: [{ intent: 'intent', cursor: 0, intervention: { kind: 'guide', address: originalAddress, content } }] };
    const result = get(await composeInput(request, answerSchema(request.context), scope, context.configRoot));
    expect(JSON.parse(await read(result.input)).guidance[0].text).toBe('Exact guidance {unchanged}');
    expect(JSON.parse(await read(result.input)).guidance[0].cursor).toBe(0);
    purpose('gate');
    expect(await composeInput(request, answerSchema(request.context), scope, context.configRoot)).toMatchObject({ ok: false, kind: 'conflict' });
  });
});
describe('one attempt', () => {
  it.each(['work', 'plan', 'gate'] as const)('runs one identified %s call for both backends with independent grants', async (kind) => {
    for (const backend of ['codex', 'claude'] as const) {
      if (backend === 'claude')
        nextInvocation();
      purpose(kind, backend);
      const result = get(await runAttempt(request, context));
      expect(result.before).toBe(tree);
      expect(result.after).toBe(tree);
      expect(result.inputChars).toBeGreaterThan(0);
      expect(result.audit).toBeDefined();
      const supplied = vi.mocked(context.adapter.invoke).mock.calls.at(-1)![0];
      expect(supplied.role).toEqual(request.role);
      expect(supplied.durationMs).toBeUndefined();
      expect(supplied.writableRoots.includes(scope.layout.project)).toBe(kind === 'work');
      expect(supplied.protectedRoots.includes(scope.layout.project)).toBe(kind !== 'work');
    }
    expect(context.adapter.invoke).toHaveBeenCalledTimes(2);
  });
  it.each(['delivered', 'blocked', 'environment_gap'])('valid work status %s stays typed rather than prose-classified', async (status) => {
    await backendReply({}, workAnswer(status));
    if (request.guidance) { const guide = events.pop()!; events.splice(events.length - 1, 0, guide); }
    const receipt = get(await runAttempt(request, context));
    expect(receipt.ending).toBe('delivered');
    expect(receipt.answer).toEqual(workAnswer(status));
  });
  it.each(['auth', 'quota', 'duration', 'cancelled', 'provider_unknown',
   'closure_unknown'] as const)('preserves %s, raw evidence and partial usage without retry', async (ending) => {
    await backendReply({ ending, ...(ending === 'closure_unknown' ? { closure: 'unknown' } : {}), resetAt: '2030-01-01T00:00:00Z' });
    const result = get(await runAttempt(request, context));
    expect(result.ending).toBe(ending);
    expect(result.usage).toMatchObject({ state: 'partial', input: 4 });
    expect(result.evidence).toHaveLength(2);
    expect(context.adapter.invoke).toHaveBeenCalledTimes(1);
  });
  it.each(['unpaid', 'wrong-address', 'stale-plan', 'wrong-role', 'settled', 'cancelled', 'terminal',
   'stale-context'] as const)('refuses %s before invocation', async (problem) => {
    if (problem === 'unpaid')
      events.pop();
    if (problem === 'wrong-address')
      request = { ...request, address: { ...request.address, invocation: 2 } };
    if (problem === 'stale-plan')
      request = { ...request, plan: { ...request.plan, revision: 'stale' } };
    if (problem === 'wrong-role')
      request = { ...request, role: { ...request.role, model: 'substitute' } };
    if (problem === 'settled')
      event({ type: 'attempt_settled', receipt: { address: request.address, ending: 'technical_failure', before: tree, after: tree,
          audit: scope.brief.bytes, closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: null } });
    if (problem === 'cancelled')
      event({ type: 'control_intent', intent: { kind: 'cancel', id: 'cancel', run: 'run', expectedCursor: 3,
          unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
    if (problem === 'terminal')
      event({ type: 'lifecycle', conclusion: { status: 'complete', reason: 'completed', detail: '' } });
    if (problem === 'stale-context')
      request = { ...request, context: { ...request.context, criterionIds: ['other'] } };
    expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
    expect(context.adapter.invoke).not.toHaveBeenCalled();
  });
  it('rejects invalid engine-owned schema context before spending a call', async () => {
    request = { ...request, context: { ...request.context, criterionIds: [] } };
    await expect(runAttempt(request, context)).rejects.toThrow('Missing criterion');
    expect(context.adapter.invoke).not.toHaveBeenCalled();
  });
  it('returns invalid-plan or invalid-answer for malformed answers with no inner correction', async () => {
    await backendReply({}, '{broken');
    expect(get(await runAttempt(request, context)).ending).toBe('invalid_answer');
    purpose('plan');
    nextInvocation();
    expect(get(await runAttempt(request, context)).ending).toBe('invalid_plan');
    expect(context.adapter.invoke).toHaveBeenCalledTimes(2);
  });
  it('authenticates answer reference and request/schema binding', async () => {
    await backendReply({ answerBytes: { path: 'missing', sha256: h('missing') } });
    expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
    nextInvocation();
    await backendReply({ raw: await put(JSON.stringify({ attempt: { ...request.address, invocation: 9 } })) });
    expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
    nextInvocation();
    await backendReply({});
    vi.mocked(validateRecordRef).mockResolvedValueOnce({ ok: false, kind: 'invalid', detail: 'Unauthenticated native carrier' });
    expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'invalid' });
  });
  it('cannot bless a gate mutation or unknown descendant closure', async () => {
    purpose('gate');
    vi.mocked(captureTree).mockResolvedValueOnce({ ok: true, value: tree }).mockResolvedValueOnce({ ok: true, value: h('mutated') });
    expect(get(await runAttempt(request, context)).ending).toBe('isolation_failure');
    nextInvocation();
    await backendReply({ closure: 'unknown' });
    expect(get(await runAttempt(request, context)).ending).toBe('closure_unknown');
  });
  it('requires committed unconsumed guidance and records its intent id', async () => {
    const intervention = { kind: 'guide' as const, address: request.address, content: await put('guidance') };
    event({ type: 'attempt_settled', receipt: { address: request.address, ending: 'duration', before: tree, after: tree,
        audit: scope.brief.bytes, closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: null } });
    nextInvocation();
    request = { ...request, invocation: { ...request.invocation, charge: 'continuation', address: { kind: 'stage',
     ...request.address } }, guidance: [{ intent: 'intent', cursor: 3, intervention }] };
    events[events.length - 1] = { ...events[events.length - 1], payload: { type: 'invocation_reserved', invocation: request.invocation } };
    expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
    event({ type: 'control_intent', intent: { kind: 'guide', id: 'intent', run: 'run', expectedCursor: 3, intervention,
        unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
    if (request.guidance) { const guide = events.pop()!; events.splice(events.length - 1, 0, guide); }
    const receipt = get(await runAttempt(request, context));
    expect(receipt.guidance).toEqual(['intent']);
    event({ type: 'attempt_settled', receipt });
    expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
    expect(context.adapter.invoke).toHaveBeenCalledTimes(1);
  });
});
describe('commands', () => {
  const commandContext = (): CommandContext => ({ scope, writer, process: ports, abort: context.abort });
  async function reserve(kind: 'setup' | 'stage' | 'final' = 'stage'): Promise<CommandRequest> {
    const command = scope.brief.declaration.commands[0], key = get(await identifyCommand(command, scope));
    reservation = { state: 'reserved', identity: 'reservation', key, invocation: { charge: 'command',
        address: kind === 'stage' ? { kind, ...request.address } : { kind, run: 'run' } } };
    event({ type: 'command_reserved', reservation });
    return { command, key, reservation };
  }
  it.each(['tree', 'argv', 'env', 'inputs', 'context'] as const)('changes identity when %s changes independently', async (dimension) => {
    const originalCommand = scope.brief.declaration.commands[0];
    const original = get(await identifyCommand(originalCommand, scope));
    let command = originalCommand;
    if (dimension === 'tree')
      tree = h('changed');
    if (dimension === 'context')
      scope = { ...scope, layout: { ...scope.layout, project: join(root, 'other-project') } };
    if (dimension === 'argv')
      command = { ...command, argv: ['different-program'] };
    if (dimension === 'env')
      command = { ...command, env: { A: 'changed' } };
    if (dimension === 'inputs') {
      inputRefs = [await put('changed-input')];
      command = { ...command, inputs: ['input'] };
      scope = { ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration, inputs: [{ id: 'input', path: 'input',
       kind: 'file', frozen: false }] } } };
    }
    scope = { ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration, commands: [command] } } };
    expect(get(await identifyCommand(command, scope))).not.toEqual(original);
    expect(launchInvocation).not.toHaveBeenCalled();
  });
  it('runs declared commands with exactly the authority environment', async () => {
    get(await runDeclaredCommand(await reserve(), commandContext()));
    expect(vi.mocked(launchInvocation).mock.calls[0][1].env).toEqual({ ...request.brief.declaration.commands[0].env,
     TMPDIR: expect.stringMatching(/commands\/check\/exec_[^/]+$/) });
  });
  it('canonicalizes declaration environment key ordering', async () => {
    const original = get(await identifyCommand(scope.brief.declaration.commands[0], scope));
    const reordered = { ...scope.brief.declaration.commands[0], env: { A: '1', B: '2' } };
    expect(get(await identifyCommand(reordered, scope, original.execution))).toEqual(original);
  });
  it.each(['stage'] as const)('uses the same exact runner at %s site and refreshed commit cursor', async (kind) => {
    const req = await reserve(kind);
    vi.mocked(launchInvocation).mockImplementationOnce(async () => { event({ type: 'ownership', owner: writer.owner, state: 'dead' });
     return { ok: true, value: processReceipt }; });
    const result = get(await runDeclaredCommand(req, commandContext()));
    expect(result.execution).toEqual({ state: 'complete', exit: 0 });
    expect(result.observed).toEqual({ before: [], after: [] });
    expect(result.stdout).toEqual(processReceipt.stdout);
    expect(result.stderr).toEqual(processReceipt.stderr);
    expect(result.spent).toEqual({ durationMs: 7 });
    expect(vi.mocked(launchInvocation).mock.calls[0][1]).toMatchObject({ argv: req.command.argv, env: req.command.env, durationMs: 500 });
    expect(vi.mocked(commitCommand).mock.calls[0][1]).toBe(events.length);
  });
  it.each([0, 7])('reuses committed exit %s without charging/rerunning', async (exit) => {
    processReceipt = { ...processReceipt, exit };
    const req = await reserve();
    const original = get(await runDeclaredCommand(req, commandContext()));
    const reused = get(await runDeclaredCommand(req, commandContext()));
    expect(reused).toEqual(original);
    expect(launchInvocation).toHaveBeenCalledTimes(1);
  });
  it('reuses a committed unfinished receipt and refuses uncertain/mismatched reservations', async () => {
    processReceipt = { ...processReceipt, state: 'closure_unknown', exit: null };
    const req = await reserve();
    const receipt = get(await runDeclaredCommand(req, commandContext()));
    expect(receipt.execution.state).toBe('unfinished');
    expect(get(await runDeclaredCommand({ ...req, reservation: reservation! }, commandContext()))).toEqual(receipt);
    reservation = { ...req.reservation, state: 'uncertain' };
    expect(await runDeclaredCommand({ ...req, reservation }, commandContext())).toMatchObject({ ok: false, kind: 'unknown' });
    expect(await runDeclaredCommand({ ...req, reservation: { ...req.reservation, identity: 'forged' } },
     commandContext())).toMatchObject({ ok: false, kind: 'conflict' });
    expect(launchInvocation).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ state: 'closure_unknown', exit: null }, 'closure_unknown'],
    [{ signal: 'SIGTERM', exit: null, durationMs: 500 }, 'duration'],
    [{ state: 'not_started', exit: null }, 'preparation_failed'],
  ] as const)('records direct unfinished/not-started facts %j', async (change, reason) => {
    processReceipt = { ...processReceipt, ...change };
    const req = await reserve();
    expect(get(await runDeclaredCommand(req, commandContext())).execution).toMatchObject({ reason });
  });
  it('retains cancellation instead of a fabricated command exit', async () => {
    const controller = new AbortController();
    controller.abort();
    context = { ...context, abort: controller.signal };
    const req = await reserve();
    expect(get(await runDeclaredCommand(req, commandContext())).execution).toEqual({ state: 'unfinished', reason: 'cancelled' });
  });
  it('records preparation failure without unconfined spawn', async () => {
    const req = await reserve();
    vi.mocked(launchInvocation).mockResolvedValue({ ok: false, kind: 'unavailable', detail: 'unsupported' });
    const result = get(await runDeclaredCommand(req, commandContext()));
    expect(result.execution).toEqual({ state: 'not_started', reason: 'preparation_failed' });
    expect(await read(result.stdout)).toBe('');
    expect(launchInvocation).toHaveBeenCalledTimes(1);
  });
  it('retains command effects without a whole-tree purity predicate', async () => {
    const req = await reserve();
    vi.mocked(launchInvocation).mockImplementationOnce(async () => { tree = h('command-generated-output'); return { ok: true,
     value: processReceipt }; });
    const result = get(await runDeclaredCommand(req, commandContext()));
    expect(result.before).not.toBe(result.after);
    expect(result).not.toHaveProperty("sourceBound");
  });
  it('preserves uncertain commit/evidence outcomes without retry', async () => {
    const req = await reserve();
    vi.mocked(commitCommand).mockResolvedValue({ ok: false, kind: 'unknown', detail: 'uncertain commit' });
    expect(await runDeclaredCommand(req, commandContext())).toEqual({ ok: false, kind: 'unknown', detail: 'uncertain commit' });
    expect(launchInvocation).toHaveBeenCalledTimes(1);
  });
});
it('probes the applied native grant without invoking a provider executable', async () => {
  const result = get(await probeExecution({ writableRoots: [scope.layout.project], protectedRoots: scope.layout.protectedRoots }, context));
  expect(result.state).toBe('applied');
  expect(vi.mocked(checkReadiness).mock.calls[0][1].argv).toEqual(['/usr/bin/true']);
  expect(context.adapter.invoke).not.toHaveBeenCalled();
});
it('does not replay an invocation with unresolved process evidence or a later invocation', async () => {
  event({ type: 'ownership', owner: writer.owner, state: 'dead' });
  expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
  events.pop();
  event({ type: 'invocation_reserved', invocation: { ...request.invocation, address: { kind: 'stage', ...request.address, invocation: 2 } } });
  expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
  expect(context.adapter.invoke).not.toHaveBeenCalled();
});
it('rechecks cancellation arriving during prompt preparation before model dispatch', async () => {
  vi.mocked(captureTree).mockImplementation(async () => {
    event({ type: 'control_intent', intent: { id: 'cancel', kind: 'cancel', run: 'run', expectedCursor: events.length,
        unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
    return { ok: true, value: tree };
  });
  expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
  expect(context.adapter.invoke).not.toHaveBeenCalled();
});
it('does not execute a reservation with unresolved process evidence', async () => {
  const command = scope.brief.declaration.commands[0], key = get(await identifyCommand(command, scope));
  reservation = { state: 'reserved', identity: 'reservation', key,
    invocation: { charge: 'command', address: { kind: 'setup', run: 'run' } } };
  event({ type: 'command_reserved', reservation });
  event({ type: 'process', receipt: processReceipt });
  expect(await runDeclaredCommand({ command, key, reservation }, { scope, writer, process: ports, abort: context.abort })).toMatchObject({
   ok: false, kind: 'unknown' });
  expect(launchInvocation).not.toHaveBeenCalled();
});
it('does not treat unknown evidence persistence as an attempt receipt', async () => {
  const savedPut = vi.mocked(putEvidence).getMockImplementation()!;
  vi.mocked(putEvidence).mockImplementation(async (journal, bytes) => {
    if (decoder.decode(bytes).includes('"writableRoots"'))
      return { ok: false, kind: 'unknown', detail: 'audit persistence unknown' };
    return savedPut(journal, bytes);
  });
  expect(await runAttempt(request, context)).toEqual({ ok: false, kind: 'unknown', detail: 'audit persistence unknown' });
  expect(context.adapter.invoke).toHaveBeenCalledTimes(1);
});
it('retains changed external input context without a purity verdict', async () => {
  const original = scope.brief.declaration.commands[0];
  const command = { ...original, inputs: ['external'] };
  scope = { ...scope, brief: { ...scope.brief, declaration: { ...scope.brief.declaration,
        inputs: [{ id: 'external', path: join(root, 'external'), kind: 'file', frozen: false }], commands: [command] } } };
  inputRefs = [await put('original input')];
  const key = get(await identifyCommand(command, scope));
  reservation = { state: 'reserved', identity: 'reservation', key, invocation: { charge: 'command', address: { kind: 'final', run: 'run' } } };
  event({ type: 'command_reserved', reservation });
  vi.mocked(launchInvocation).mockImplementationOnce(async () => { inputRefs = [await put('changed input')]; return { ok: true,
   value: processReceipt }; });
  const result = get(await runDeclaredCommand({ command, key, reservation }, { scope, writer, process: ports, abort: context.abort }));
  expect(result.before).toBe(result.after);
  expect(result).not.toHaveProperty("sourceBound");
});
it.each(['schema', 'answer'] as const)('refuses substituted %s carrier provenance', async (carrier) => {
  vi.mocked(context.adapter.invoke).mockImplementation(async (backend) => {
    const answerBytes = await put(JSON.stringify(workAnswer())), schema = await put(carrier === 'schema' ? '{}' : JSON.stringify(backend.schema));
    const raw = await put(JSON.stringify({ attempt: backend.attempt, role: backend.role, input: backend.input, schema, answerBytes }));
    if (carrier === 'answer')
      blobs.delete(answerBytes.path);
    return { ok: true, value: { raw, answerBytes, ending: 'delivered', closure: 'dead', usage: { state: 'unknown', raw: [] }, exit: 0,
     signal: null, nativeCommands: [] } };
  });
  expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: carrier === 'schema' ? 'conflict' : 'unavailable' });
});
it('refuses changed command identity before starting an already reserved command', async () => {
  const command = scope.brief.declaration.commands[0], key = get(await identifyCommand(command, scope));
  reservation = { state: 'reserved', identity: 'reservation', key, invocation: { charge: 'command', address: { kind: 'final', run: 'run' } } };
  event({ type: 'command_reserved', reservation });
  tree = h('changed-before-start');
  expect(await runDeclaredCommand({ command, key, reservation }, { scope, writer, process: ports, abort: context.abort })).toMatchObject({
   ok: false, kind: 'conflict' });
  expect(launchInvocation).not.toHaveBeenCalled();
});
it('claims each paid invocation workspace exclusively across concurrent calls and replay', async () => {
  const replies = await Promise.all([runAttempt(request, context), runAttempt(request, context)]);
  expect(replies.filter(reply => reply.ok)).toHaveLength(1);
  expect(context.adapter.invoke).toHaveBeenCalledTimes(1);
  expect(await runAttempt(request, context)).toMatchObject({ ok: false, kind: 'conflict' });
  expect(context.adapter.invoke).toHaveBeenCalledTimes(1);
  const supplied = vi.mocked(context.adapter.invoke).mock.calls[0][0];
  const prompt = JSON.parse(await read(supplied.input));
  expect(supplied.writableRoots).toContain(prompt.workspace);
});
it('claims a command reservation workspace exclusively across concurrent execution requests', async () => {
  const command = scope.brief.declaration.commands[0], key = get(await identifyCommand(command, scope));
  reservation = { state: 'reserved', identity: 'reservation', key, invocation: { charge: 'command', address: { kind: 'final', run: 'run' } } };
  event({ type: 'command_reserved', reservation });
  const commandRequest = { command, key, reservation }, commandContext = { scope, writer, process: ports, abort: context.abort };
  const replies = await Promise.all([runDeclaredCommand(commandRequest, commandContext), runDeclaredCommand(commandRequest, commandContext)]);
  expect(replies.some(reply => reply.ok)).toBe(true);
  expect(launchInvocation).toHaveBeenCalledTimes(1);
});
it.each([
  { run: 'run', stage: 'stage', attempt: '../escape', invocation: 1 },
  { run: 'run', stage: 'stage', attempt: 'attempt', invocation: 0 },
])('refuses malformed invocation identity before resolving its workspace %j', async (address) => {
  request = { ...request, address };
  expect(await composeInput(request, answerSchema(request.context), scope, context.configRoot)).toMatchObject({ ok: false, kind: 'invalid' });
});
it('refuses a noncanonical reservation identity before claiming its workspace', async () => {
  const command = scope.brief.declaration.commands[0], key = get(await identifyCommand(command, scope));
  reservation = { state: 'reserved', identity: '../escape', key, invocation: { charge: 'command', address: { kind: 'final', run: 'run' } } };
  expect(await runDeclaredCommand({ command, key, reservation }, { scope, writer, process: ports, abort: context.abort })).toMatchObject({
   ok: false, kind: 'invalid' });
  expect(launchInvocation).not.toHaveBeenCalled();
});
it.each(['work', 'plan',
 'gate'] as const)('uses the same %s grant policy for probe and invocation including private Git and configured devices', async (kind) => {
  purpose(kind);
  scope = { ...scope, devices: ['/dev/null'], git: { worktree: scope.layout.project, commonDir: join(root, 'protected-git'),
   privateDir: join(root, 'unused'), baseCommit: null } };
  context = { ...context, scope };
  const scratch = join(scope.layout.location.storeRoot, 'work', request.address.run, 'stages', request.address.stage,
   request.address.attempt, String(request.address.invocation));
  scope.authority = { ...fixtureAuthority(scope, ['/dev/null'], context.configRoot), backend: request.role.backend, preferences: [{
   role: request.role.id, backend: request.role.backend, settings: get(await providerSettings(request.role, {})) }] };
  const grant = authorityGrant(scope.authority, kind, scratch, request.role.backend, scope.git);
  get(await probeExecution(grant, context));
  expect(vi.mocked(checkReadiness).mock.calls.at(-1)![0]).toEqual(grant);
  get(await runAttempt(request, context));
  const backend = vi.mocked(context.adapter.invoke).mock.calls[0][0];
  expect({ writableRoots: backend.writableRoots, protectedRoots: backend.protectedRoots, git: backend.git }).toEqual(grant);
  expect(backend.git?.privateDir).toBe(join(scratch, 'git'));
  expect(backend.writableRoots).toContain('/dev/null');
  expect(backend.writableRoots.includes(scope.layout.project)).toBe(kind === 'work');
});
it('grants each declared command private TMPDIR and configured devices without ambient environment', async () => {
  scope = { ...scope, devices: ['/dev/null'], git: { worktree: scope.layout.project, commonDir: join(root, 'protected-git'),
   privateDir: join(root, 'unused'), baseCommit: null } };
  const command = scope.brief.declaration.commands[0], key = get(await identifyCommand(command, scope));
  reservation = { state: 'reserved', identity: 'scratch-command', key, invocation: { charge: 'command', address: { kind: 'final', run: 'run' } } };
  event({ type: 'command_reserved', reservation });
  get(await runDeclaredCommand({ command, key, reservation }, { scope, writer, process: ports, abort: context.abort }));
  const grant = vi.mocked(launchInvocation).mock.calls[0][0];
  const program = vi.mocked(launchInvocation).mock.calls[0][1];
  const scratch = program.env.TMPDIR;
  expect(dirname(scratch)).toBe(join(scope.layout.location.storeRoot, 'work', 'run', 'commands', 'check'));
  expect(program.env).toEqual({ ...command.env, TMPDIR: scratch });
  expect(grant.writableRoots).toContain(scratch);
  expect(grant.writableRoots).toContain('/dev/null');
  expect(grant.git).toBeUndefined();
});
it('runs distinct tree keys with independent default TMPDIR and separate invocation claims', async () => {
  const command = scope.brief.declaration.commands[0];
  const run = async () => {
    const key = get(await identifyCommand(command, scope));
    reservation = { state: 'reserved', identity: command.id, key, invocation: { charge: 'command', address: { kind: 'final', run: 'run' } } };
    event({ type: 'command_reserved', reservation });
    return get(await runDeclaredCommand({ command, key, reservation }, { scope, writer, process: ports, abort: context.abort }));
  };
  expect((await run()).execution).toEqual({ state: 'complete', exit: 0 });
  tree = h('new tree after author work');
  expect((await run()).execution).toEqual({ state: 'complete', exit: 0 });
  const calls = vi.mocked(launchInvocation).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][1].env.TMPDIR).not.toBe(calls[1][1].env.TMPDIR);
});
vi.mock('../dist-rewrite/records/evidence.js', async () => ({ ...await vi.importActual('../dist-rewrite/records/evidence.js'),
 putEvidence: vi.fn(), readEvidence: vi.fn(), validateRecordRef: vi.fn() }));
