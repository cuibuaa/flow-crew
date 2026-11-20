import { providerSettings, commandContext as policyContext } from '../dist-rewrite/exec/policy.js';
import { baseConclusion } from '../dist-rewrite/core/decisions.js';
import { fixtureAuthority } from './fixtures/rewrite-authority.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { AdmittedBrief, Ref, Result } from '../dist-rewrite/contract/brief.js';
import { answerSchema } from '../dist-rewrite/contract/answers.js';
import { gateReview, commandBasis, type AttemptRequest, type BackendReply, type JournalEvent, type Reservation, type Writer, type ProcessReceipt, type CommandReceipt } from '../dist-rewrite/contract/runtime.js';
import { captureGeneration, contentDelta, captureTree, hashInputs, readCheckpoint, changeSince, materializeProject,
 type ContentScope } from '../dist-rewrite/records/content.js';
import { readProjection, readEvents } from '../dist-rewrite/records/state.js';
import { putEvidence, readEvidence } from '../dist-rewrite/records/evidence.js';
import { readCommand, commitCommand } from '../dist-rewrite/records/state.js';
import { validateRecordRef } from '../dist-rewrite/records/evidence.js';
import { launchInvocation, type ProcessPorts } from '../dist-rewrite/host/process.js';
import { composeInput } from '../dist-rewrite/exec/input.js';
import { runAttempt, type ExecutionContext } from '../dist-rewrite/exec/attempt.js';
import { identifyCommand, runDeclaredCommand, type CommandRequest, type CommandContext } from '../dist-rewrite/exec/command.js';
vi.mock('../dist-rewrite/records/content.js', async () => ({ ...await vi.importActual('../dist-rewrite/records/content.js'),
 captureGeneration: vi.fn(), contentDelta: vi.fn(), captureTree: vi.fn(), hashInputs: vi.fn(), readCheckpoint: vi.fn(), changeSince: vi.fn(), materializeProject: vi.fn() }));
vi.mock('../dist-rewrite/records/state.js', async (original) => ({ ...await original<typeof import('../dist-rewrite/records/state.js')>(),
 putEvidence: async (journal: any, bytes: Uint8Array) => (await import('../dist-rewrite/records/evidence.js')).putEvidence(journal, bytes),
 readProjection: vi.fn(), readEvents: vi.fn(), readCommand: vi.fn(), commitCommand: vi.fn() }));
// The base run's copy is removed through this rm; a test sets `removal.fail` to make that removal fail.
const removal = vi.hoisted(() => ({ fail: undefined as Error | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) =>
    removal.fail && String(path).endsWith('.tree') ? Promise.reject(removal.fail) : actual.rm(path, options) };
});
vi.mock('../dist-rewrite/host/process.js', async (original) => ({
  ...await original<typeof import('../dist-rewrite/host/process.js')>(), launchInvocation: vi.fn(),
}));
const encoder = new TextEncoder(), decoder = new TextDecoder();
const h = (v: string) => createHash('sha256').update(v).digest('hex');
const get = <T>(result: Result<T>): T => { if (!result.ok)
  throw new Error(result.detail); return result.value; };
let root: string, scope: ContentScope, request: AttemptRequest, context: ExecutionContext, events: JournalEvent[];
let blobs: Map<string, Uint8Array>, writer: Writer, ports: ProcessPorts, tree: string, inputRefs: Ref[];
let reservation: Reservation | null, processReceipt: ProcessReceipt;
/** An attempt that began from `h('first-tree')`, which is not the run's base: the gate's base is what setup recorded, `h('base-tree')`. */
const startAttempt = () => ({ address: { run: 'run', stage: 'start', attempt: 'start-attempt', invocation: 1 }, before: h('first-tree'), ending: 'delivered', evidence: [] });
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
  vi.mocked(readProjection).mockResolvedValue({ ok: true, value: { launch: { setup: { project: join(root, 'source'), tree: h('base-tree') }, roles: [] },
    commands: [], lineage: [], attempts: [startAttempt()], transitions: [] } } as any);
  vi.mocked(changeSince).mockImplementation(async (_journal, _base, _current, patch, baseDirectory) => {
    await writeFile(patch, 'diff --git a/file.txt b/file.txt\n');
    return { ok: true, value: { patch, stat: ' file.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)', otherRoots: [], unpatched: 0,
      baseCommand: `git archive BASE | tar -x -C ${baseDirectory}` } };
  });
  vi.mocked(readEvents).mockImplementation(async (_, after) => ({ ok: true, value: events.filter(event => event.seq > after) }));
  vi.mocked(captureTree).mockImplementation(async () => ({ ok: true, value: tree }));
  vi.mocked(captureGeneration).mockImplementation(async () => ({ ok: true, value: { path: 'evidence/' + tree, sha256: tree } }));
  vi.mocked(contentDelta).mockImplementation(async () => ({ ok: true, value: scope.brief.bytes }));
  vi.mocked(hashInputs).mockImplementation(async () => ({ ok: true, value: inputRefs }));
  vi.mocked(materializeProject).mockResolvedValue({ ok: true, value: true });
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
      project: join(root, 'project'), protectedRoots: [join(root, 'records')] },
    brief, inputBaseline: [], outputBaseline: [], projectClaim: { resource: join(root, 'project'), owner, epoch: 'epoch', unit: null } };
  scope.authority = { ...fixtureAuthority(scope), backend: 'codex', preferences: [{ role: 'role', backend: 'codex', settings: {
   model: 'declared-model', effort: 'declared-effort', source: { model: 'role', effort: 'role' } } }] };
  const { body, ...metadata } = brief.declaration;
  const briefRef = await put('---\n' + JSON.stringify(metadata) + '\n---\n' + body);
  scope = { ...scope, brief: { ...brief, bytes: briefRef } };
  const stage = { id: 'stage', purpose: 'work' as const, role: 'role', instruction: 'current stage goal', after: [], };
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
       commands: [] },
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
  processReceipt = { state: 'closed', exit: 0, signal: null, stdout: await put('exact stdout'),
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
  const sourceCopy = () => join(root, 'source');
  const baseDirectory = () => join(scope.layout.location.storeRoot, 'work', 'run', 'stages', request.address.stage, request.address.attempt,
    String(request.address.invocation));
  function project(change: Record<string, unknown> = {}) {
    vi.mocked(readProjection).mockResolvedValue({ ok: true, value: { launch: { setup: { project: sourceCopy(), tree: h('base-tree') }, roles: [request.role] },
      commands: [], lineage: [], attempts: [startAttempt()], transitions: [], ...change } } as any);
  }
  const compose = async () => get(await composeInput(request, answerSchema(request.context), scope, context.configRoot, tree));
  const receipt = async (command: string, execution: CommandReceipt['execution'], out = 'stdout text', err = 'stderr text'): Promise<CommandReceipt> => ({
    command, key: { tree, declaration: h(command), inputHashes: [], context: h('context'), execution: { id: 'execution-' + command,
      scratch: 'scratch/' + command, env: { SYNTHETIC_CONFIG: 'x'.repeat(200) } } }, execution, stdout: await put(out), stderr: await put(err),
    before: tree, after: tree, delta: await put('delta'), spent: { durationMs: 1 } });
  it.each(['work', 'gate', 'plan'] as const)('gives the %s role text as the instruction and the task as Markdown, not JSON', async (kind) => {
    purpose(kind);
    project();
    const schema = answerSchema(request.context);
    const result = get(await composeInput(request, schema, scope, context.configRoot, tree));
    const text = await read(result.input);
    expect(result.instruction).toBe(`Exact ${kind} purpose prompt\n\nExact role prompt {unchanged}`);
    expect(() => JSON.parse(text)).toThrow();
    expect(text).toContain(scope.brief.declaration.body);                       // verbatim: braces, newline and Unicode survive
    expect(text).not.toContain('\\n');
    expect(text).toContain('- criterion: goal');
    expect(text).toContain('current stage goal');
    expect(text).not.toContain('purpose prompt');                                      // the role text is not repeated in the message
    expect(result.chars).toBe(result.instruction.length + text.length);
    expect(result.workspace).toBe(baseDirectory());
    expect(result.schema).toBe(schema);
  });
  it.each(['work', 'gate', 'plan'] as const)('does not copy the answer schema or machine records into the %s message', async (kind) => {
    purpose(kind);
    project();
    const text = await read((await compose()).input);
    for (const copied of ['"properties"', '"additionalProperties"', '"oneOf"', '"anyOf"', 'remainingWork', 'baseRevision', 'sha256', 'evidenceRoot',
      'checkpoint', tree, scope.journal.root]) expect(text).not.toContain(copied);
  });
  it('names the working copy and the read-only source, and maps source paths onto the copy', async () => {
    project();
    const text = await read((await compose()).input);
    expect(text).toContain(`You work in \`${scope.layout.project}\`, a copy of the read-only source \`${sourceCopy()}\`; a path under the source in the task`
      + ' means the same relative path under the copy.');
    expect(text).toContain(`\`${baseDirectory()}\``);
  });
  it('gives the gate the change as a file with its diffstat inline, and a command that extracts the base', async () => {
    purpose('gate');
    project({ attempts: [{ address: request.address, before: h('first-tree'), ending: 'delivered', evidence: [] }] });
    const result = await compose(), text = await read(result.input);
    const patch = join(baseDirectory(), 'change.patch');
    expect(vi.mocked(changeSince).mock.calls.at(-1)!.slice(1)).toEqual([h('base-tree'), tree, patch, join(baseDirectory(), 'base')]);
    expect(await readFile(patch, 'utf8')).toContain('diff --git');
    expect(text).toContain(`\`${patch}\``);
    expect(text).toContain('1 file changed, 1 insertion(+), 1 deletion(-)');
    expect(text).toContain('git archive BASE | tar -x -C');
  });
  it.each(['work', 'plan'] as const)('does not build a change file for %s', async (kind) => {
    purpose(kind);
    project();
    const text = await read((await compose()).input);
    expect(changeSince).not.toHaveBeenCalled();
    expect(text).not.toContain('change.patch');
  });
  it('measures the gate\'s change from the base setup recorded, whatever attempts began from', async () => {
    purpose('gate');
    const later = { ...startAttempt(), address: { ...startAttempt().address, attempt: 'later' }, before: h('later-tree') };
    for (const attempts of [[], [startAttempt()], [startAttempt(), later]]) {
      project({ attempts });
      await compose();
      expect(vi.mocked(changeSince).mock.calls.at(-1)![1]).toBe(h('base-tree'));
      nextInvocation();
    }
  });
  it('refuses a gate when the run recorded no base tree', async () => {
    purpose('gate');
    project({ launch: { setup: { project: sourceCopy() }, roles: [request.role] } });
    const refused = await composeInput(request, answerSchema(request.context), scope, context.configRoot, tree);
    expect(refused).toMatchObject({ ok: false, kind: 'conflict' });
    // The detail is what the operator reads when the run parks: the cause, then the remedy.
    expect((refused as { detail: string }).detail).toMatch(/recorded no base tree at setup.*Resume the run with the runtime copy it was started with/);
    expect(changeSince).not.toHaveBeenCalled();
  });
  it('tells the gate what its patch and base copy leave out, and which other roots changed', async () => {
    purpose('gate');
    project();
    const baseline = vi.mocked(changeSince).getMockImplementation()!;
    vi.mocked(changeSince).mockImplementation(async (...args) => {
      const view = get(await baseline(...args));
      return { ok: true, value: { ...view, otherRoots: ['/out/report.txt', '/out/data'], unpatched: 3 } };
    });
    const text = await read((await compose()).input);
    expect(text).toContain('The end of that file also lists 3 differences a patch cannot carry');
    expect(text).toContain('Declared outputs outside the working copy also changed: /out/report.txt, /out/data');
    expect(text).toMatch(/other modes, empty directories and special files are missing.*\.fcrw-/);
  });
  it('says nothing about unpatched differences or other roots when there are none', async () => {
    purpose('gate');
    project();
    const text = await read((await compose()).input);
    expect(text).not.toContain('also lists');
    expect(text).not.toContain('outside the working copy');
  });
  it('shows a planner the current plan and the roles once other stages exist, and a bootstrap planner neither', async () => {
    purpose('plan');
    const roles = [{ ...request.role, description: 'writes the code' }];
    project({ launch: { setup: { project: sourceCopy(), tree: h('base-tree') }, roles } });
    const bootstrap = await read((await compose()).input);
    expect(bootstrap).not.toContain('## Current plan');
    expect(bootstrap).not.toContain('## Roles');
    nextInvocation();
    const review = { id: 'review', purpose: 'gate', role: 'role', instruction: '', after: ['stage'], repair: { stage: 'fix', returnsTo: 'review' } };
    const work = { id: 'fix', purpose: 'work', role: 'role', instruction: 'x', after: [] };
    request = { ...request, plan: { ...request.plan, plan: { stages: [request.stage, review, work] as any } },
      context: { ...request.context, settledStageIds: ['review'] } as any };
    const text = await read((await compose()).input);
    expect(text).toContain('## Current plan\n\n- stage: plan by role\n- review: gate by role, after stage, settled, a repairable rejection runs fix\n- fix: work by role\n');
    expect(text).toContain('## Roles\n\n- role: writes the code');
  });
  it('lists the results, declared inputs, outputs and commands the task names', async () => {
    const { body, ...metadata } = scope.brief.declaration;
    const declaration = { ...scope.brief.declaration, results: [{ id: 'fixed', text: 'the bug is fixed' }],
      inputs: [{ id: 'spec', path: 'spec.md', kind: 'file', frozen: true }, { id: 'data', path: 'data', kind: 'directory', frozen: false }],
      outputs: [{ path: 'report.txt', kind: 'file', existing: 'replace' }] };
    const bytes = await put('---\n' + JSON.stringify({ ...metadata, ...declaration, body: undefined }) + '\n---\n' + body);
    scope = { ...scope, brief: { ...scope.brief, declaration, bytes } };
    request = { ...request, brief: scope.brief };
    project();
    const text = await read((await compose()).input);
    expect(text).toContain('## Results\n\n- fixed: the bug is fixed');
    expect(text).toContain('## Declared inputs\n\n- spec.md (file, frozen)\n- data (directory)');
    expect(text).toContain('## Declared outputs\n\n- report.txt (file, replace)');
    expect(text).toContain('## Declared commands\n\n- check (required): B=2 A=1 explicit-program "literal arg"');
  });
  it('sends the role text alone when the role has no prompt of its own', async () => {
    request = { ...request, role: { ...request.role, prompt: '' } };
    project({ launch: { setup: { project: sourceCopy(), tree: h('base-tree') }, roles: [request.role] } });
    expect((await compose()).instruction).toBe('Exact work purpose prompt');
  });
  it('lists one line per command with its exit and a log file holding both streams', async () => {
    const check = await receipt('check', { state: 'complete', exit: 1 }, 'the stdout', 'the stderr');
    const lost = await receipt('lost', { state: 'unfinished', reason: 'closure_unknown' });
    request = { ...request, stage: { ...request.stage, commands: ['check', 'lost'] } };
    request = { ...request, plan: { ...request.plan, plan: { stages: [request.stage] } } };
    project({ commands: [check, lost] });
    const text = await read((await compose()).input);
    const logs = join(baseDirectory(), 'commands');
    expect(text).toContain(`- check: exit 1, log ${join(logs, 'check.log')}\n`);
    expect(text).toContain(`- lost: unfinished (closure_unknown), log ${join(logs, 'lost.log')}`);
    expect(await readFile(join(logs, 'check.log'), 'utf8')).toBe('exit: exit 1\n--- stdout ---\nthe stdout\n--- stderr ---\nthe stderr\n');
    expect(text).not.toContain(check.stdout.sha256);
  });
  it('marks a command result that an earlier stage produced', async () => {
    const check = await receipt('check', { state: 'complete', exit: 0 });
    request = { ...request, commandReview: { commands: [check], reusedCommands: [{ receipt: check, sourceTree: tree, source: { stage: 'earlier',
      attempt: 'other', invocation: 1 } }] } };
    project();
    expect(await read((await compose()).input)).toContain(', log ' + join(baseDirectory(), 'commands', 'check.log') + ' (result of an earlier stage, earlier)');
  });
  it('keeps command history out of the message: six stages with twelve receipts cost the same as one', async () => {
    const commands: CommandReceipt[] = [], sizes: number[] = [];
    for (let stage = 1; stage <= 6; stage++) {
      for (const command of ['historical', 'check']) commands.push(await receipt(command, { state: 'complete', exit: 0 }, `out ${commands.length}`));
      const node = { ...request.stage, id: `stage-${stage}`, after: stage > 1 ? [`stage-${stage - 1}`] : [], commands: ['check'] };
      const address = { ...request.address, stage: node.id };
      request = { ...request, address, stage: node, plan: { ...request.plan, plan: { stages: [node] } },
        invocation: { ...request.invocation, address: { kind: 'stage', ...address } } };
      project({ commands: [...commands] });
      sizes.push((await compose()).chars);
    }
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeLessThan(1500);
  });
  it('gives a repair author the findings of the rejecting gate and nothing else about it', async () => {
    const gateAnswer = { kind: 'gate', answer: { outcome: 'rejected_repairable', reason: 'The parser accepts trailing text.',
      criteria: { criterion: { status: 'fail', evidence: 'Ran parse("1 MB x"): returned 1048576' } },
      findings: [{ id: 'f1', paths: ['src/parse.py'], reason: 'Trailing input is dropped.', criterionIds: ['criterion'], class: 'regression' }],
      remainingWork: [] } };
    const gateAddress = { run: 'run', stage: 'review', attempt: 'gate-attempt', invocation: 1 };
    project({ attempts: [startAttempt(), { address: gateAddress, before: tree, ending: 'delivered', evidence: [], answer: gateAnswer }],
      transitions: [{ type: 'gate_transition', stage: 'review', attempt: 'gate-attempt', outcome: 'rejected_repairable', next: request.stage.id,
        evidence: [] }] });
    const text = await read((await compose()).input);
    expect(text).toContain('The independent review rejected the work: The parser accepts trailing text.');
    expect(text).toContain('- regression in src/parse.py: Trailing input is dropped. (criteria: criterion)');
    expect(text).toContain('- criterion: Ran parse("1 MB x"): returned 1048576');
  });
  it('quotes the exact refusal of the stage\'s own earlier answer so it can be corrected', async () => {
    const rejected = await put('{"kind":"work"}');
    const refusal = await put(JSON.stringify({ refusal: { ok: false, kind: 'invalid', detail: 'Unknown dependency ghost in stage review' } }));
    const earlier = { address: { ...request.address, attempt: 'earlier' }, ending: 'invalid_answer', answerRef: rejected, evidence: [refusal] };
    request = { ...request, evidence: [refusal] };
    project({ attempts: [earlier] });
    const text = await read((await compose()).input);
    expect(text).toContain('Unknown dependency ghost in stage review');
    expect(text).toContain('{"kind":"work"}');
    expect(text).toContain('Return a corrected answer.');
  });
  it('gives guidance verbatim, never to a gate', async () => {
    const content = await put('Exact guidance {unchanged}');
    const originalAddress = request.address;
    nextInvocation();
    request = { ...request, invocation: { ...request.invocation, charge: 'continuation', address: { kind: 'stage',
     ...request.address } }, guidance: [{ intent: 'intent', cursor: 0, intervention: { kind: 'guide', address: originalAddress, content } }] };
    project();
    expect(await read((await compose()).input)).toContain('## Operator guidance\n\nExact guidance {unchanged}');
    purpose('gate');
    expect(await composeInput(request, answerSchema(request.context), scope, context.configRoot, tree)).toMatchObject({ ok: false, kind: 'conflict' });
  });
  it.each(['work', 'gate'] as const)('records what a %s was supplied for settlement to bind, in the audit and never in the message', async (kind) => {
    purpose(kind);
    const check = await receipt('check', { state: 'complete', exit: 0 });
    request = { ...request, commandReview: { commands: [check], reusedCommands: [] } };
    const result = get(await runAttempt(request, context));
    const audit = JSON.parse(await read(result.audit));
    if (kind === 'work') { expect(audit.review).toBeUndefined(); return; }
    const projection = get(await readProjection(scope.journal));
    expect(JSON.parse(await read(audit.review))).toEqual(JSON.parse(JSON.stringify(gateReview(projection, [check], []))));
    expect(await read(audit.input)).not.toContain('"lineage"');
    expect(result.evidence).not.toContainEqual(audit.review);
  });
  it('refuses a missing brief without truncation', async () => {
    project();
    blobs.delete(request.brief.bytes.path);
    expect(await composeInput(request, answerSchema(request.context), scope, context.configRoot, tree)).toMatchObject({ ok: false });
  });
});
describe('one attempt', () => {
  it.each(['before','after','cancel-before'] as const)('binds an attempt fence to its reservation: %s', async boundary => {
    const fact: JournalEvent['payload'] = boundary === 'cancel-before'
      ? {type:'control_intent',intent:{kind:'cancel',id:'cancel',run:'run',expectedCursor:0,unit:{run:'run',authority:'synthetic-run',runtime:scope.brief.bytes}}}
      : {type:'lifecycle',conclusion:{status:'parked',reason:'recovery_unknown',detail:'Prior interrupted activation'}};
    if(boundary==='after') event(fact);
    else {
      events.splice(2,0,{run:'run',seq:0,at:'2026-01-01T00:00:00Z',payload:fact});
      events = events.map((event, index) => ({...event,seq:index+1}));
    }
    const result = await runAttempt(request,context);
    expect(result).toMatchObject(boundary==='before'?{ok:true,value:{ending:'delivered'}}:{ok:false,kind:'conflict'});
    expect(context.adapter.invoke).toHaveBeenCalledTimes(boundary==='before'?1:0);
  });
  it.each(['work', 'plan', 'gate'] as const)('runs one identified %s call for both backends with exact invocation context', async (kind) => {
    for (const backend of ['codex', 'claude'] as const) {
      if (backend === 'claude')
        nextInvocation();
      purpose(kind, backend);
      request = { ...request, live: { onLive: vi.fn(), onActivity: vi.fn() } };
      const result = get(await runAttempt(request, context));
      expect(result.before).toBe(tree);
      expect(result.after).toBe(tree);
      expect(result.inputChars).toBeGreaterThan(0);
      expect(result.audit).toBeDefined();
      const supplied = vi.mocked(context.adapter.invoke).mock.calls.at(-1)![0];
      expect(supplied.role).toEqual(request.role);
      expect(supplied.live).toBe(request.live);
      expect(supplied.durationMs).toBeUndefined();
      expect(supplied.scratch).toBe(join(scope.layout.location.storeRoot, 'work', 'run', 'stages', request.stage.id, request.address.attempt,
        String(request.address.invocation)));
      expect(supplied.instruction).toContain(`Exact ${kind} purpose prompt`);
      expect(supplied.preferences).toEqual(get(await providerSettings(request.role, context.privateEnvironment)));
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
  it('admits a fresh reservation after resumed parks while retaining all history', async () => {
    const paid = events.pop()!;
    for (const status of ['parked', 'parked'] as const) {
      event({ type: 'lifecycle', conclusion: { status, reason: 'backstop', detail: 'Retained park' } });
      event({ type: 'control_intent', intent: { kind: 'resume', id: `resume_${events.length}`, run: 'run', expectedCursor: events.length,
        unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
    }
    event(paid.payload);
    expect(get(await runAttempt(request, context)).ending).toBe('delivered');
    expect(context.adapter.invoke).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.payload.type === 'lifecycle')).toHaveLength(2);
  });
  it.each(['cancel', 'lifecycle'] as const)('a current %s still fences at dispatch even with a later resume', async (kind) => {
    // The second read is after input construction: a reservation's fence cannot be
    // undone by a later resume, which must pay for a new invocation.
    vi.mocked(captureTree).mockImplementationOnce(async () => {
      if (kind === 'cancel') event({ type: 'control_intent', intent: { kind, id: 'cancel', run: 'run', expectedCursor: events.length,
        unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
      else {
        event({ type: 'lifecycle', conclusion: { status: 'parked', reason: 'backstop', detail: 'Current park' } });
        event({ type: 'control_intent', intent: { kind: 'resume', id: 'resume', run: 'run', expectedCursor: events.length,
          unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
      }
      return { ok: true, value: tree };
    });
    expect(await runAttempt(request, context)).toEqual({ ok: false, kind: 'conflict', detail: 'Attempt fenced before dispatch' });
    expect(context.adapter.invoke).not.toHaveBeenCalled();
    expect(vi.mocked(readEvents).mock.calls.at(-1)?.[1]).toBe(0);
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
  it('records changed gate trees for settlement and preserves unknown descendant closure', async () => {
    purpose('gate');
    await backendReply({}, { kind: 'gate', answer: { outcome: 'accepted', reason: 'Review', criteria: { criterion: { status: 'pass', evidence: 'Measured' } }, findings: [], remainingWork: [] } });
    vi.mocked(captureTree).mockResolvedValueOnce({ ok: true, value: tree }).mockResolvedValueOnce({ ok: true, value: h('mutated') });
    const measured = get(await runAttempt(request, context));
    expect(measured.before).not.toBe(measured.after);
    expect(measured.ending).toBe('delivered'); // Settlement alone owns non-author tree admission.
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
  it.each(['before','after','cancel-before'] as const)('binds a command fence to its exact reservation: %s', async boundary => {
    const fact: JournalEvent['payload'] = boundary === 'cancel-before'
      ? {type:'control_intent',intent:{kind:'cancel',id:'cancel',run:'run',expectedCursor:0,unit:{run:'run',authority:'synthetic-run',runtime:scope.brief.bytes}}}
      : {type:'lifecycle',conclusion:{status:'parked',reason:'recovery_unknown',detail:'Prior interrupted activation'}};
    if(boundary!=='after') event(fact);
    const req = await reserve();
    if(boundary==='after') event(fact);
    const result=await runDeclaredCommand(req,commandContext());
    expect(result).toMatchObject(boundary==='before'?{ok:true,value:{execution:{state:'complete',exit:0}}}:{ok:false,kind:'conflict'});
    expect(launchInvocation).toHaveBeenCalledTimes(boundary==='before'?1:0);
  });
  it('executes a fresh command reservation after a historical park and resume', async () => {
    event({ type: 'lifecycle', conclusion: { status: 'parked', reason: 'backstop', detail: 'Retained park' } });
    event({ type: 'control_intent', intent: { kind: 'resume', id: 'resume', run: 'run', expectedCursor: events.length,
      unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
    const result = get(await runDeclaredCommand(await reserve(), commandContext()));
    expect(result.execution).toEqual({ state: 'complete', exit: 0 });
    expect(launchInvocation).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'lifecycle'] as const)('a %s after payment fences the command even if resumed', async (kind) => {
    const paid = await reserve();
    if (kind === 'cancel') event({ type: 'control_intent', intent: { kind, id: 'cancel', run: 'run', expectedCursor: events.length,
      unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
    else {
      event({ type: 'lifecycle', conclusion: { status: 'parked', reason: 'backstop', detail: 'Current park' } });
      event({ type: 'control_intent', intent: { kind: 'resume', id: 'resume', run: 'run', expectedCursor: events.length,
        unit: { run: 'run', authority: 'synthetic-run', runtime: scope.brief.bytes } } });
    }
    expect(await runDeclaredCommand(paid, commandContext())).toEqual({ ok: false, kind: 'conflict', detail: 'Command execution fenced' });
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
    expect(result.stdout).toEqual(processReceipt.stdout);
    expect(result.stderr).toEqual(processReceipt.stderr);
    expect(result.spent).toEqual({ durationMs: 7 });
    expect(vi.mocked(launchInvocation).mock.calls[0][1]).toMatchObject({ argv: req.command.argv, env: req.command.env, durationMs: 500 });
    expect(vi.mocked(commitCommand).mock.calls[0][1]).toBe(events.length);
  });
  // A failing required command is measured once more on the base, only when the caller asks (the final gate command phase);
  // reusing its committed receipt launches nothing, base included.
  it.each([[0, 1, true], [7, 2, true], [7, 1, false]])('reuses committed exit %s without charging/rerunning: %s launches in all (againstBase %s)', async (exit, launches, againstBase) => {
    processReceipt = { ...processReceipt, exit };
    const req = { ...(await reserve()), ...(againstBase ? { againstBase } : {}) };
    const original = get(await runDeclaredCommand(req, commandContext()));
    const reused = get(await runDeclaredCommand(req, commandContext()));
    expect(reused).toEqual(original);
    expect(launchInvocation).toHaveBeenCalledTimes(launches);
    expect(original.base !== undefined).toBe(exit !== 0 && againstBase);
  });
  // What the base run did is stored as it happened, in one of three shapes, and never re-classified: (a) the receipt measure produced,
  // (b) measure's failure verbatim (kind and detail), (c) the executor's own failure before measure was called (`not_placed`). Only a
  // complete non-zero exit is pre-existing; whatever else, the main receipt is committed with it, introduced.
  const unconfirmed = { ok: false, kind: 'unknown', detail: 'Not confirmed closed: group 1', closure: { state: 'not_confirmed_closed',
    owner: undefined, observation: 'live', members: [] } } as const;
  const afterMain = (second: Result<ProcessReceipt>) => vi.mocked(launchInvocation).mockResolvedValueOnce({ ok: true, value: { ...processReceipt, exit: 7 } })
    .mockResolvedValueOnce(second);
  const notStarted = { state: 'not_started', reason: 'preparation_failed' };
  const failed = (kind: string, detail: string) => ({ tree: expect.any(String), ok: false, kind, detail });
  const conclusion = (kind: string, detail: string) => `base run did not complete: ${kind}: ${detail}`;
  it.each([
    ['(a) its program exits 0', () => afterMain({ ok: true, value: { ...processReceipt, exit: 0 } }),
      { ok: true, execution: { state: 'complete', exit: 0 } }, 'passes on the base tree', 'introduced'],
    ['(a) its launch is refused', () => afterMain({ ok: false, kind: 'unavailable', detail: 'unsupported' }),
      { ok: true, execution: notStarted, refusal: { kind: 'unavailable', detail: 'unsupported' } },
      'base run did not complete: not_started: preparation_failed: unavailable: unsupported', 'introduced'],
    ['(b) its launch left a closure not confirmed', () => afterMain(unconfirmed as any),
      failed('unknown', 'Not confirmed closed: group 1'), conclusion('unknown', 'Not confirmed closed: group 1'), 'introduced'],
    ['(b) its launch conflicts', () => afterMain({ ok: false, kind: 'conflict', detail: 'claimed' }),
      failed('conflict', 'claimed'), conclusion('conflict', 'claimed'), 'introduced'],
    ['(b) the evidence of its refused launch cannot be written', () => { afterMain({ ok: false, kind: 'unavailable', detail: 'unsupported' });
      ports = { ...ports, putEvidence: async () => ({ ok: false, kind: 'unavailable', detail: 'evidence store full' }) }; },
      failed('unavailable', 'evidence store full; launch refused: unavailable: unsupported'),
      conclusion('unavailable', 'evidence store full; launch refused: unavailable: unsupported'), 'introduced'],
    ['(c) its copy cannot be placed', () => vi.mocked(materializeProject).mockResolvedValue({ ok: false, kind: 'unknown', detail: 'copy uncertain' }),
      failed('not_placed', 'unknown: copy uncertain'), conclusion('not_placed', 'unknown: copy uncertain'), 'introduced'],
    ['(c) placing its copy throws', () => vi.mocked(materializeProject).mockRejectedValue(new TypeError('no path')),
      failed('threw', 'TypeError: no path'), conclusion('threw', 'TypeError: no path'), 'introduced'],
    ['(c) its launch throws', () => vi.mocked(launchInvocation).mockResolvedValueOnce({ ok: true, value: { ...processReceipt, exit: 7 } })
      .mockRejectedValueOnce(new Error('EMFILE: evidence file')),
      failed('threw', 'Error: EMFILE: evidence file'), conclusion('threw', 'Error: EMFILE: evidence file'), 'introduced'],
  ])('a base run whose %s is stored as it happened; the main receipt is committed with it', async (_title, arrange, stored, text, basis) => {
    processReceipt = { ...processReceipt, exit: 7 };
    arrange();
    const req = { ...(await reserve()), againstBase: true };
    const result = await runDeclaredCommand(req, commandContext());
    const receipt = get(result);
    expect(commitCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitCommand).mock.calls[0][3]).toEqual(receipt);
    expect(receipt.execution).toEqual({ state: 'complete', exit: 7 });
    expect(receipt.base).toMatchObject(stored);
    if (stored.ok === false) expect(receipt.base).toEqual(stored);
    expect(baseConclusion(receipt.base!)).toBe(text);
    expect(commandBasis(receipt)).toBe(basis);
  });
  // The base run is launched with the main run's argv, duration and declared environment; what differs is only what the launcher is
  // asked for as the run's own scratch, from the same owner (the command context) that built the main run's.
  it('launches the base run with the main run\'s program and the environment its own command context declares', async () => {
    processReceipt = { ...processReceipt, exit: 7 };
    const req = { ...(await reserve()), againstBase: true };
    get(await runDeclaredCommand(req, commandContext()));
    const [main, base] = vi.mocked(launchInvocation).mock.calls.map(call => call[1]);
    const baseContext = policyContext(scope.authority, req.command, `${req.key.execution!.id}_base`);
    expect(main).toMatchObject({ argv: req.command.argv, durationMs: req.command.durationMs, cwd: scope.layout.project });
    expect(main.env).toEqual(req.key.execution!.env);
    expect(base).toMatchObject({ argv: main.argv, durationMs: main.durationMs, cwd: `${baseContext.scratch}.tree` });
    expect(base.env).toEqual(baseContext.env);
  });
  // A copy that cannot be removed does not cost the receipt, and is not silent: the base run records it.
  it.each([[true, 'EACCES: copy is locked'], [false, undefined]])('a base copy whose removal fails (%s) is recorded on the base run', async (fails, text) => {
    processReceipt = { ...processReceipt, exit: 7 };
    removal.fail = fails ? new Error(text) : undefined;
    try {
      const req = { ...(await reserve()), againstBase: true };
      const receipt = get(await runDeclaredCommand(req, commandContext()));
      expect(receipt.base).toMatchObject({ execution: { state: 'complete', exit: 7 } });
      if (fails) expect(receipt.base!.detail).toBe(`copy not removed: Error: ${text}`);
      else expect(receipt.base).not.toHaveProperty('detail');
      expect(commandBasis(receipt)).toBe('pre-existing');
    } finally { removal.fail = undefined; }
  });
  // A launch that throws leaves a record too, and the copy is still removed: a failed removal is appended to what the base run says.
  it('a base launch that throws is recorded with a failed copy removal appended, and the main receipt is committed', async () => {
    processReceipt = { ...processReceipt, exit: 7 };
    vi.mocked(launchInvocation).mockResolvedValueOnce({ ok: true, value: processReceipt }).mockRejectedValueOnce(new Error('EMFILE: evidence file'));
    removal.fail = new Error('EACCES: copy is locked');
    try {
      const req = { ...(await reserve()), againstBase: true };
      const receipt = get(await runDeclaredCommand(req, commandContext()));
      expect(commitCommand).toHaveBeenCalledTimes(1);
      expect(receipt.base).toEqual({ tree: expect.any(String), ok: false, kind: 'threw',
        detail: 'Error: EMFILE: evidence file; copy not removed: Error: EACCES: copy is locked' });
      expect(commandBasis(receipt)).toBe('introduced');
    } finally { removal.fail = undefined; }
  });
  // The main command's tree and receipt facts are captured before the base run starts; what the base run writes is not its.
  it('a base run that changes the working tree does not change what the main receipt records', async () => {
    processReceipt = { ...processReceipt, exit: 7 };
    const req = { ...(await reserve()), againstBase: true };
    const settled = tree;
    vi.mocked(launchInvocation).mockResolvedValueOnce({ ok: true, value: processReceipt })
      .mockImplementationOnce(async () => { tree = h('written by the base run'); return { ok: true, value: { ...processReceipt, exit: 7 } }; });
    const receipt = get(await runDeclaredCommand(req, commandContext()));
    expect(tree).not.toBe(settled);
    expect(receipt.after).toBe(settled);
    expect(receipt.base).toMatchObject({ execution: { state: 'complete', exit: 7 } });
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
  it('records preparation failure without spawning', async () => {
    const req = await reserve();
    vi.mocked(launchInvocation).mockResolvedValue({ ok: false, kind: 'unavailable', detail: 'unsupported' });
    const refusal = { ok: false, kind: 'unavailable', detail: 'unsupported' };
    expect(await runDeclaredCommand(req, commandContext())).toEqual(refusal);
    const result = vi.mocked(commitCommand).mock.calls.at(-1)![3];
    expect(result.execution).toEqual({ state: 'not_started', reason: 'preparation_failed' });
    expect(await read(result.stdout)).toBe('');
    expect(JSON.parse(await read(result.stderr))).toEqual({ refusal });
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
    let audit: Record<string, unknown> = {};
    try { audit = JSON.parse(decoder.decode(bytes)); } catch { /* the Markdown user message is not JSON */ }
    if (['address','invocation','before','after','input','raw','closure'].every(key => Object.hasOwn(audit,key)))
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
  expect(await read(supplied.input)).toContain(`\`${supplied.scratch}\``);
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
  expect(await composeInput(request, answerSchema(request.context), scope, context.configRoot, tree)).toMatchObject({ ok: false, kind: 'invalid' });
});
it('refuses a noncanonical reservation identity before claiming its workspace', async () => {
  const command = scope.brief.declaration.commands[0], key = get(await identifyCommand(command, scope));
  reservation = { state: 'reserved', identity: '../escape', key, invocation: { charge: 'command', address: { kind: 'final', run: 'run' } } };
  expect(await runDeclaredCommand({ command, key, reservation }, { scope, writer, process: ports, abort: context.abort })).toMatchObject({
   ok: false, kind: 'invalid' });
  expect(launchInvocation).not.toHaveBeenCalled();
});
it.each(['work', 'plan', 'gate'] as const)('retains %s private Git and scratch invocation context', async kind => {
  purpose(kind);
  scope = {...scope,git:{worktree:scope.layout.project,commonDir:join(root,'protected-git'),privateDir:join(root,'unused'),baseCommit:null}};
  context = {...context,scope};
  const scratch = join(scope.layout.location.storeRoot,'work',request.address.run,'stages',request.address.stage,
    request.address.attempt,String(request.address.invocation));
  scope.authority = {...fixtureAuthority(scope,[],context.configRoot),backend:request.role.backend,preferences:[{
    role:request.role.id,backend:request.role.backend,settings:get(await providerSettings(request.role,{}))}]};
  get(await runAttempt(request,context));
  const backend = vi.mocked(context.adapter.invoke).mock.calls[0][0];
  expect(backend.scratch).toBe(scratch);
  expect(backend.git).toEqual({...scope.git,privateDir:join(scratch,'git')});
});
it('gives each declared command private TMPDIR without ambient environment', async () => {
  scope = { ...scope, git: { worktree: scope.layout.project, commonDir: join(root, 'protected-git'),
   privateDir: join(root, 'unused'), baseCommit: null } };
  const command = scope.brief.declaration.commands[0], key = get(await identifyCommand(command, scope));
  reservation = { state: 'reserved', identity: 'scratch-command', key, invocation: { charge: 'command', address: { kind: 'final', run: 'run' } } };
  event({ type: 'command_reserved', reservation });
  get(await runDeclaredCommand({ command, key, reservation }, { scope, writer, process: ports, abort: context.abort }));
  const invocation = vi.mocked(launchInvocation).mock.calls[0][0];
  const program = vi.mocked(launchInvocation).mock.calls[0][1];
  const scratch = program.env.TMPDIR;
  expect(dirname(scratch)).toBe(join(scope.layout.location.storeRoot, 'work', 'run', 'commands', 'check'));
  expect(program.env).toEqual({ ...command.env, TMPDIR: scratch });
  expect(invocation).toEqual({});
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
