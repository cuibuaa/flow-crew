import { evidenceBytes } from './fixtures/rewrite-bytes.js';
import { providerSettings } from '../dist-rewrite/exec/policy.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Ajv from 'ajv';
import { parse as parseToml } from 'smol-toml';
import type { Ref, Result } from '../dist-rewrite/contract/brief.js';
import type { BackendRequest, ProcessReceipt, OwnedProgram } from '../dist-rewrite/contract/runtime.js';
import { answerSchema } from '../dist-rewrite/contract/answers.js';
import { launchInvocation, type ProcessPorts } from '../dist-rewrite/host/process.js';
import { readEvidence, putEvidence } from '../dist-rewrite/records/evidence.js';
import { createCodexAdapter } from '../dist-rewrite/exec/codex.js';
import { createClaudeAdapter } from '../dist-rewrite/exec/claude.js';
import { invokeBackend, protocolDecoder, type TransportContext } from '../dist-rewrite/exec/transport.js';
import { readUsage } from '../dist-rewrite/exec/usage.js';
vi.mock('../dist-rewrite/host/process.js', async (original) => ({ ...await original<typeof import('../dist-rewrite/host/process.js')>(),
 launchInvocation: vi.fn() }));
vi.mock('../dist-rewrite/records/state.js', async (original) => ({
  ...await original<typeof import('../dist-rewrite/records/state.js')>(),
  putEvidence: async (journal: unknown, value: Uint8Array) =>
    (await import('../dist-rewrite/records/evidence.js')).putEvidence(journal as never, value),
}));
const bytes = new TextEncoder();
const blobs = evidenceBytes();
let root: string, processReceipt: ProcessReceipt;
let request: BackendRequest, context: TransportContext;
async function put(text: string): Promise<Ref> {
  const value = await putEvidence(context.journal, bytes.encode(text));
  if (!value.ok)
    throw new Error(value.detail);
  return value.value;
}
async function stream(events: readonly unknown[], change: Partial<ProcessReceipt> = {}) {
  processReceipt = { state: 'closed', exit: 0, signal: null, durationMs: 2,
    stdout: await put(events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + '\n'),
    stderr: await put('native stderr retained'), ...change };
}
function adapter(backend: 'codex' | 'claude') {
  request = { ...request, role: { ...request.role, backend } };
  return backend === 'codex' ? createCodexAdapter(context) : createClaudeAdapter(context);
}
async function text(ref: Ref) { const result = await readEvidence(context.journal, ref); if (!result.ok)
  throw new Error(result.detail); return new TextDecoder().decode(result.value); }
function get<T>(result: Result<T>): T { if (!result.ok)
  throw new Error(result.detail); return result.value; }
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'rewrite-exec-protocol-'));
  await mkdir(join(root, 'project'));
  await mkdir(join(root, 'scratch'));
  await mkdir(join(root, 'store'));
  const journal = { database: join(root, 'unused.sqlite'), root: join(root, 'store') };
  const ports: ProcessPorts = { readEvidence: ref => readEvidence(journal, ref), putEvidence: value => putEvidence(journal, value),
    recordProcess: async () => ({ ok: true, value: 1 }) };
  context = { journal, process: ports, privateEnvironment: { PATH: '/explicit/tools', PRIVATE_MARKER: 'synthetic-only' } };
  const schema = answerSchema({ purpose: 'work', criterionIds: ['criterion'], resultIds: [], commandIds: [], checkpointIds: [],
   roleIds: ['role'], allowBlocked: false, final: false, revision: 'revision' });
  request = { attempt: { run: 'run', stage: 'stage', attempt: 'attempt', invocation: 1 },
    role: { id: 'role', backend: 'codex', model: 'operator-model', effort: 'operator-effort', prompt: 'exact role', description: '' },
    preferences: { model: 'operator-model', effort: 'operator-effort', source: { model: 'role', effort: 'role' } },
    input: await put('exact stdin'), instruction: 'exact instruction', schema: schema.json, project: join(root, 'project'), scratch: join(root, 'scratch'),
durationMs: 10000, abort: new AbortController().signal };
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io?.onReady?.({ write: async () => true, end() {} });
    const stdout = blobs.get(processReceipt.stdout.path);
    if (stdout) for (let offset = 0; offset < stdout.length; offset += 7) io?.onStdout?.(stdout.subarray(offset, offset + 7));
    return { ok: true, value: processReceipt };
  });
  await stream([]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const workAnswer = { kind: 'work', answer: { status: 'delivered', summary: 'synthetic', caveats: [], remainingWork: [], blocks: null } };
const success = (backend: 'codex' | 'claude', answer: unknown = workAnswer) => backend === 'codex'
  ? [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } }, { type: 'turn.completed', usage: {
   input_tokens: 3, output_tokens: 2, cached_input_tokens: 0 } }]
  : [{ type: 'result', subtype: 'success', is_error: false, structured_output: answer,
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0 }];
describe.each(['codex', 'claude'] as const)('%s native adapter', backend => {
  it('makes exactly one call with immutable settings and binds answer/input/schema/raw streams', async () => {
    await stream(success(backend));
    const result = get(await adapter(backend).invoke(request));
    expect(result).toMatchObject({ ending: 'delivered', exit: 0, closure: 'dead' });
    expect(JSON.parse(await text(result.answerBytes!))).toEqual(workAnswer);
    expect(launchInvocation).toHaveBeenCalledTimes(1);
    const program = vi.mocked(launchInvocation).mock.calls[0][1];
    expect(program).toMatchObject({ cwd: request.project, env: { ...context.privateEnvironment, TMPDIR: request.scratch },
     stdin: request.input, durationMs: request.durationMs });
    expect(program.env).toEqual({ ...context.privateEnvironment, TMPDIR: request.scratch });
    expect(program.argv).toEqual(expect.arrayContaining(backend === 'codex'
      ? ['--sandbox', 'danger-full-access', '--model', 'operator-model']
      : ['--permission-mode', 'bypassPermissions', '--model', 'operator-model', '--effort', 'operator-effort']));
    expect(program.argv).toContain('operator-model');
    expect(program.argv.join(' ')).toContain('operator-effort');
    expect(program.argv).not.toContain('--resume');
    expect(program.argv).toContain(backend === 'codex' ? '--ephemeral' : '--no-session-persistence');
    const raw = JSON.parse(await text(result.raw));
    expect(raw).toMatchObject({ input: request.input, attempt: request.attempt, role: request.role, answerBytes: result.answerBytes });
    expect(JSON.parse(await text(raw.schema))).toEqual(request.schema);
    expect(raw.process).not.toHaveProperty('grant');
    expect(raw.process.stdout).toEqual(processReceipt.stdout);
    expect(raw.process.stderr).toEqual(processReceipt.stderr);
    expect(await text(raw.process.stderr)).toBe('native stderr retained');
  });
  it('sends the role text through the provider instruction option, never in the user message, and records it', async () => {
    const instruction = 'Role text.\n\n- "quoted", {braces}, \\backslash, 中文\n';
    request = { ...request, instruction };
    await stream(success(backend));
    const result = get(await adapter(backend).invoke(request));
    const program = vi.mocked(launchInvocation).mock.calls[0][1];
    if (backend === 'claude') {
      expect(program.argv[program.argv.indexOf('--append-system-prompt') + 1]).toBe(instruction);
      expect(program.argv).not.toContain('--system-prompt');
    } else {
      const option = program.argv.find(value => value.startsWith('developer_instructions='))!;
      expect(program.argv[program.argv.indexOf(option) - 1]).toBe('-c');
      expect(parseToml(option)).toEqual({ developer_instructions: instruction });   // codex parses -c values as TOML
    }
    expect(program.stdin).toEqual(request.input);
    expect(await text(program.stdin as Ref)).toBe('exact stdin');
    expect(JSON.parse(await text(result.raw)).instruction).toBe(instruction);
  });
  it('keeps every declared environment value literal, including an explicit TMPDIR', async () => {
    context = { ...context, privateEnvironment: { PATH: '/explicit/tools', HOME: root, EXACT: 'literal $ ; space',
      SSL_CERT_FILE: 'explicit.pem', HTTPS_PROXY: 'explicit-proxy', CLAUDE_CODE_TMPDIR: 'explicit-temp', TMPDIR: root } };
    await stream(success(backend));
    get(await adapter(backend).invoke(request));
    expect(vi.mocked(launchInvocation).mock.calls[0][1].env).toEqual(context.privateEnvironment);
  });
  it('isolates settings and uses builtin defaults when fixture settings are absent', async () => {
    request = { ...request, role: { ...request.role, backend, model: 'default', effort: 'default' } };
    context = { ...context, privateEnvironment: { ...context.privateEnvironment, HOME: root } };
    request = { ...request, preferences: get(await providerSettings(request.role, context.privateEnvironment)) };
    await stream(success(backend));
    get(await adapter(backend).invoke(request));
    const argv = vi.mocked(launchInvocation).mock.calls[0][1].argv;
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--effort');
    expect(argv.join(' ')).not.toContain('model_reasoning_effort=');
    if (backend === 'codex')
      expect(argv).toContain('--ignore-user-config');
    else
      expect(argv).toEqual(expect.arrayContaining(['--setting-sources', '']));
    if (backend === 'codex') {
      expect(argv).toContain('--no-daemon');
      expect(argv.join(' ')).not.toContain('sqlite_home=');
      expect(argv.join(' ')).not.toContain('log_dir=');
    }
  });
  it('passes only fixture model and effort explicitly while isolating every other user setting', async () => {
    request = { ...request, role: { ...request.role, backend, model: 'default', effort: 'default' } };
    context = { ...context, privateEnvironment: { ...context.privateEnvironment, HOME: root } };
    await mkdir(join(root, '.' + backend), { recursive: true });
    await writeFile(join(root, '.' + backend, backend === 'codex' ? 'config.toml' : 'settings.json'), backend === 'codex'
      ? 'model = "fixture-model"\nmodel_reasoning_effort = "high"\n[hooks]\ncommand = "never inherit"\n'
      : JSON.stringify({ model: 'fixture-model', effort: 'high', hooks: { command: 'never inherit' } }));
    request = { ...request, preferences: get(await providerSettings(request.role, context.privateEnvironment)) };
    await stream(success(backend));
    const result = get(await adapter(backend).invoke(request));
    const argv = vi.mocked(launchInvocation).mock.calls[0][1].argv;
    expect(argv).toContain('fixture-model');
    expect(argv.join(' ')).toContain(backend === 'codex' ? 'model_reasoning_effort="high"' : '--effort high');
    expect(argv.join(' ')).not.toContain('never inherit');
    expect(JSON.parse(await text(result.raw)).settings).toEqual({ model: 'fixture-model', effort: 'high', source: { model: 'settings',
     effort: 'settings' } });
  });
  it.each([[401, 'numeric'], ['authentication_error', 'misleading-string'], ['unknown-native-code', 'unknown']])('parks unverified native code %s (former speculative alias %s)', async (code, ending) => {
    await stream([{ type: backend === 'codex' ? 'turn.failed' : 'result', is_error: true, subtype: 'error_during_execution',
        error: { code, message: 'Authentication failed quota timeout refusal words are irrelevant' } }], { exit: 1 });
    const result = get(await adapter(backend).invoke(request));
    expect(result.ending).toBe('provider_unknown');
    expect(launchInvocation).toHaveBeenCalledTimes(1);
  });
  it('does not parse diagnostic prose, nested JSON strings or tool failures into provider codes', async () => {
    await stream([{ type: 'error', message: '{"error":{"code":"authentication_error"}} input_too_large unauthorized' }], { exit: 1 });
    expect(get(await adapter(backend).invoke(request)).ending).toBe('provider_unknown');
  });
  it('does not infer quota or reset instants from unverified error fields', async () => {
    await stream([{ type: 'error', error: { type: 'quota_exceeded', data: { reset_at: 1800000000 } } }], { exit: 1 });
    const result = get(await adapter(backend).invoke(request));
    expect(result.ending).toBe('provider_unknown');
    expect(result.resetAt).toBeUndefined();
    await stream([{ type: 'error', code: 'quota_exceeded', reset_at: 'not-a-time', message: 'retry tomorrow' }], { exit: 1 });
    expect(get(await adapter(backend).invoke(request)).resetAt).toBeUndefined();
  });
  it.each([
    [{ state: 'closure_unknown' }, 'closure_unknown'],
    [{ signal: 'SIGTERM', exit: null, durationMs: 10000 }, 'provider_unknown'],
    [{ exit: null, state: 'not_started' }, 'provider_unknown'],
    [{ exit: 7 }, 'provider_unknown'],
  ] as const)('retains process ending %j', async (change, expected) => {
    await stream(success(backend), change);
    const result = get(await adapter(backend).invoke(request));
    expect(result.ending).toBe(expected);
    expect(result.raw).toBeDefined();
    expect(result.usage.input).toBe(3);
  });
  it('retains answer and partial native usage through cancellation', async () => {
    await stream(success(backend));
    const controller = new AbortController();
    controller.abort();
    request = { ...request, abort: controller.signal };
    const result = get(await adapter(backend).invoke(request));
    expect(result.ending).toBe('cancelled');
    expect(result.answerBytes).toBeDefined();
    expect(result.usage.input).toBe(3);
  });
  it('refuses missing evidence without a second invocation or fabricated ref', async () => {
    await stream(success(backend));
    blobs.delete(processReceipt.stdout.path);
    expect(await adapter(backend).invoke(request)).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(launchInvocation).toHaveBeenCalledTimes(1);
  });
  it('retains a malformed native answer and marks missing answers invalid', async () => {
    await stream(backend === 'codex'
      ? [{ type: 'item.completed', item: { type: 'agent_message', text: '{broken' } }, { type: 'turn.completed' }]
      : [{ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(workAnswer) }]);
    const result = get(await adapter(backend).invoke(request));
    expect(backend === 'codex' ? await text(result.answerBytes!) : result.answerBytes).toBe(backend === 'codex' ? '{broken' : undefined);
    if (backend === 'claude')
      expect(result.ending).toBe('invalid_answer');
    await stream(backend === 'codex' ? [{ type: 'turn.completed' }] : [{ type: 'result', subtype: 'success', is_error: false }]);
    expect(get(await adapter(backend).invoke(request)).ending).toBe('invalid_answer');
  });
});
it.each(['error_during_execution'])('Claude typed result subtype %s', async (subtype) => {
  await stream([{ type: 'result', subtype, is_error: true }], { exit: 1 });
  expect(get(await adapter('claude').invoke(request)).ending).toBe('provider_unknown');
});
it('preserves native command envelopes without interpreting command strings or outputs', async () => {
  const command = { type: 'item.completed', item: { type: 'command_execution', id: 'cmd', exit_code: 9, command: 'synthetic',
   aggregated_output: 'auth quota words' } };
  await stream([command, ...success('codex')]);
  const codex = get(await adapter('codex').invoke(request));
  expect(JSON.parse(await text(codex.nativeCommands[0]))).toEqual(command);
  const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'cmd', name: 'Bash', input: { command: 'synthetic' } }] } };
  const completion = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cmd', content: 'opaque', is_error: true }] } };
  await stream([tool, completion, ...success('claude')]);
  const claude = get(await adapter('claude').invoke(request));
  expect(claude.nativeCommands).toHaveLength(2);
  expect(claude.ending).toBe('delivered');
});
describe('recorded Codex JSON-document failure envelopes (synthetic)', () => {
  it.each([['invalid_api_key', 401, 'provider_unknown']])('retains unverified inner code %s / HTTP %s without the former %s guess', async (code, status, ending) => {
    const message = JSON.stringify({ type: 'error', error: { message: 'Synthetic diagnostic; no authority',
        type: 'invalid_request_error', param: 'text.format.schema', ...(code ? { code } : {}) }, status });
    for (const envelope of [{ type: 'error', message }, { type: 'turn.failed', error: { message } }]) {
      await stream([{ type: 'thread.started', thread_id: 'synthetic' }, { type: 'turn.started' }, envelope], { exit: 1 });
      const reply = get(await adapter('codex').invoke(request));
      expect(reply.ending).toBe('provider_unknown');
      const raw = JSON.parse(await text(reply.raw));
      expect(await text(raw.process.stdout)).toContain(message.replaceAll('"', '\\"'));
    }
  });
  it.each(['{not json}'])('does not classify prose or unrelated JSON %s', async (message) => {
    await stream([{ type: 'turn.failed', error: { message } }], { exit: 1 });
    expect(get(await adapter('codex').invoke(request)).ending).toBe('provider_unknown');
  });
});
describe('usage facts', () => {
  it.each([
    [{ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }, 'known', 0, 0],
    [{ input_tokens: 5 }, 'partial', 5, undefined],
    [{ output_tokens: 2 }, 'partial', undefined, 2],
    [{ input_tokens: '5', output_tokens: -1 }, 'unknown', undefined, undefined],
    [{}, 'unknown', undefined, undefined],
  ])('Codex counters %j remain %s', async (usage, state, input, output) => {
    const ref = await put(JSON.stringify({ type: 'turn.completed', usage }));
    const observed = await readUsage(context.journal, 'codex', [ref]);
    expect(observed).toMatchObject({ state, raw: [ref] });
    expect(observed.input).toBe(input);
    expect(observed.output).toBe(output);
  });
  it('sums Codex turn totals once, ignoring rollout cumulative counters and duplicate raw refs', async () => {
    const ref = await put([
      { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1, cached_input_tokens: 1 } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500 } } } },
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2, cached_input_tokens: 0 } },
    ].map(value => JSON.stringify(value)).join('\n'));
    expect(await readUsage(context.journal, 'codex', [ref, ref])).toMatchObject({ input: 5, output: 3, cached: 1, state: 'known' });
  });
  it('uses Claude cumulative totals over message/model breakdown, includes cache exactly once and explicit zero cost', async () => {
    const ref = await put([
      { type: 'assistant', message: { id: 'same', usage: { input_tokens: 999, output_tokens: 999 } } },
      { type: 'result', usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 5 },
        modelUsage: { model: { inputTokens: 10000 } }, total_cost_usd: 0 },
    ].map(value => JSON.stringify(value)).join('\n'));
    expect(await readUsage(context.journal, 'claude', [ref])).toMatchObject({ state: 'known', input: 10, output: 4, cached: 3, costUsd: 0 });
  });
  it('replaces updated Claude message counters and preserves partial interruption facts', async () => {
    const ref = await put([1, 2].map(output_tokens => ({ type: 'assistant', message: { id: 'same', usage: { input_tokens: 1, output_tokens,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })).map(value => JSON.stringify(value)).join('\n'));
    expect(await readUsage(context.journal, 'claude', [ref])).toMatchObject({ state: 'partial', input: 1, output: 2 });
  });
  it('does not estimate absent Claude cache/cost as zero', async () => {
    const ref = await put(JSON.stringify({ type: 'result', usage: { input_tokens: 5, output_tokens: 2 } }));
    const usage = await readUsage(context.journal, 'claude', [ref]);
    expect(usage).toMatchObject({ state: 'partial', output: 2 });
    expect(usage.input).toBe(5);
    expect(usage.costUsd).toBeUndefined();
  });
  it('retains known lower facts when one raw ref is missing or corrupt', async () => {
    const ref = await put('{broken\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }));
    expect(await readUsage(context.journal, 'codex', [ref, { path: 'missing', sha256: 'a'.repeat(64) }])).toMatchObject({
     state: 'partial', input: 1, output: 2 });
    expect(await readUsage(context.journal, 'claude', [])).toEqual({ state: 'unknown', raw: [] });
  });
});

it('both wire translators enforce literal progress/final result boundaries', async () => {
  const rows = [
    [true, ['label'], 'accepted', 'label', true],
    [true, ['label'], 'accepted', undefined, false],
    [true, ['label'], 'accepted_blocked', 'label', true],
    [true, ['label'], 'accepted_blocked', undefined, false],
    [true, ['label'], 'rejected_repairable', undefined, true],
    [true, ['label'], 'rejected_repairable', 'label', true],
    [true, ['label'], 'rejected_irreparable', undefined, true],
    [true, ['label'], 'rejected_irreparable', 'label', true],
    [false, ['label'], 'accepted', undefined, true],
    [false, ['label'], 'accepted', 'label', false],
    [true, [], 'accepted', undefined, true],
    [true, [], 'accepted', 'label', false],
    [true, ['label'], 'accepted', 'unknown', false],
    [true, ['label'], 'accepted', ['label'], false],
  ] as const;
  for (const [final, resultIds, outcome, result, expected] of rows) {
    const live = answerSchema({ purpose: 'gate', criterionIds: ['criterion'], resultIds: [...resultIds], commandIds: [],
      checkpointIds: [], roleIds: ['role'], allowBlocked: true, final, revision: 'revision' });
    request = { ...request, schema: live.json };
    const value = { kind: 'gate', answer: { outcome, reason: 'observed', criteria: {
      criterion: { status: 'pass', evidence: 'observed' } }, findings: [], remainingWork: [],
      ...(result === undefined ? {} : { result }) } };
    expect(live.parse(value).ok).toBe(expected);
    for (const backend of ['codex', 'claude'] as const) {
      await stream(success(backend));
      get(await adapter(backend).invoke(request));
      const program = vi.mocked(launchInvocation).mock.calls.at(-1)![1];
      const wire = backend === 'codex' ? JSON.parse(await readFile(program.argv[program.argv.indexOf('--output-schema') + 1], 'utf8'))
        : JSON.parse(program.argv[program.argv.indexOf('--json-schema') + 1]);
      expect(Boolean(new Ajv().compile(wire)(value))).toBe(expected);
    }
  }
});
it('preserves observed partial Codex counters on a typed failed turn', async () => {
  const ref = await put(JSON.stringify({ type: 'turn.failed', usage: { input_tokens: 7, cached_input_tokens: 0 } }));
  expect(await readUsage(context.journal, 'codex', [ref])).toMatchObject({ state: 'partial', input: 7, cached: 0 });
});
it('retains partial lower counts when a later native usage record is missing one counter', async () => {
  const ref = await put([{ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } },
    { type: 'turn.completed', usage: { input_tokens: 2 } }].map(value => JSON.stringify(value)).join('\n'));
  expect(await readUsage(context.journal, 'codex', [ref])).toMatchObject({ state: 'partial', input: 7, output: 3 });
});
it('native schema translations preserve optional checkpoint, repair and commandEvidence fields', async () => {
  const ajv = new Ajv();
  for (const purpose of ['plan', 'work', 'gate'] as const) {
    const live = answerSchema({ purpose, criterionIds: ['criterion'], resultIds: ['label'], commandIds: ['command'],
     checkpointIds: ['checkpoint'], roleIds: ['role'], allowBlocked: true, final: true, revision: 'revision' });
    request = { ...request, schema: live.json };
    const work = { id: 'work', purpose: 'work', role: 'role', after: [], instruction: 'goal', baseCheckpoint: 'checkpoint' };
    const gate = { id: 'gate', purpose: 'gate', role: 'role', after: ['work'], commands: ['command'],
     repair: { stage: 'work', returnsTo: 'gate' } };
    const plan = { kind: 'plan', answer: { baseRevision: 'revision', plan: { stages: [work, gate] } } };
    const finding = { id: 'finding', paths: ['literal.txt'], reason: 'observed', criterionIds: ['criterion'], class: 'criterion_unmet',
     commandEvidence: request.input };
    const gateAnswer = { kind: 'gate', answer: { outcome: 'rejected_repairable', reason: 'observed', criteria: { criterion: {
     status: 'fail', evidence: 'observed' } }, findings: [finding], remainingWork: [], result: 'label' } };
    for (const backend of ['codex', 'claude'] as const) {
      await stream(success(backend));
      get(await adapter(backend).invoke(request));
      const program = vi.mocked(launchInvocation).mock.calls.at(-1)![1];
      const wire = backend === 'codex' ? JSON.parse(await readFile(program.argv[program.argv.indexOf('--output-schema') + 1], 'utf8'))
        : JSON.parse(program.argv[program.argv.indexOf('--json-schema') + 1]);
      const validate = ajv.compile(wire);
      const candidate = purpose === 'plan' ? plan : purpose === 'work' ? workAnswer : gateAnswer;
      expect(live.parse(candidate).ok).toBe(true);
      expect(Boolean(validate(candidate))).toBe(true);
      const invalid = purpose === 'plan' ? { ...plan, answer: { ...plan.answer, baseRevision: 'stale' } }
        : purpose === 'work' ? { ...workAnswer, answer: { ...workAnswer.answer, status: 'invented' } }
        : { ...gateAnswer, answer: { ...gateAnswer.answer, result: 'unknown' } };
      expect(live.parse(invalid).ok).toBe(false);
      expect(Boolean(validate(invalid))).toBe(false);
    }
  }
});
it('Codex wire schema obeys strict native object syntax without weakening optional-field grammar', async () => {
  request = { ...request, schema: answerSchema({ purpose: 'plan', criterionIds: ['criterion'], commandIds: ['check'], checkpointIds: ['base'],
      resultIds: ['result'], roleIds: ['role'], allowBlocked: true, final: false, revision: 'revision' }).json };
  await stream(success('codex'));
  await adapter('codex').invoke(request);
  const argv = vi.mocked(launchInvocation).mock.calls[0][1].argv;
  const wire = JSON.parse(await readFile(argv[argv.indexOf('--output-schema') + 1], 'utf8'));
  function inspect(value: unknown): void {
    if (!value || typeof value !== 'object')
      return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    const node = value as Record<string, unknown>;
    expect(node).not.toHaveProperty('oneOf');
    expect(node).not.toHaveProperty('$schema');
    if (node.type === 'object')
      expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as object).sort());
    Object.values(node).forEach(inspect);
  }
  inspect(wire);
});
it('does not count nested Claude tool-session counters as root invocation usage', async () => {
  const ref = await put([
    { type: 'result', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
     total_cost_usd: 0 },
    { type: 'result', parent_tool_use_id: 'child', usage: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0,
     cache_creation_input_tokens: 0 }, total_cost_usd: 100 },
  ].map(value => JSON.stringify(value)).join('\n'));
  expect(await readUsage(context.journal, 'claude', [ref])).toMatchObject({ state: 'known', input: 2, output: 3, costUsd: 0 });
});
it('retains Claude message usage when a terminal error omits its counters', async () => {
  const ref = await put([
    { type: 'assistant', message: { id: 'observed', usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0,
     cache_creation_input_tokens: 0 } } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0 },
  ].map(value => JSON.stringify(value)).join('\n'));
  expect(await readUsage(context.journal, 'claude', [ref])).toMatchObject({ state: 'partial', input: 4, output: 2, costUsd: 0 });
});

it.each(['codex', 'claude'] as const)('%s emits bounded protocol activity from fragments before process completion', async backend => {
  const codexTools = [
    ['command_execution', ['started', 'completed']], ['mcp_tool_call', ['started', 'completed']],
    ['collab_tool_call', ['started', 'completed']], ['web_search', ['started', 'completed']],
    ['file_change', ['completed']],
  ] as const;
  const activities: import('../dist-rewrite/contract/live.js').ActivityEvent[] = [];
  let returned = false;
  request = { ...request, live: { onLive() { expect(backend).toBe('claude'); }, onActivity(event) {
    expect(returned).toBe(false); activities.push(event);
  } } };
  await stream(backend === 'codex' ? [
    ...codexTools.flatMap(([type, phases]) => phases.map(phase => ({ type: 'item.' + phase,
      item: { id: type, type, command: 'secret synthetic value', aggregated_output: 'secret synthetic value' } }))),
    ...success(backend)
  ] : [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'secret synthetic value' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'secret synthetic value' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'secret synthetic value' }] } },
    ...success(backend)
  ]);
  expect(get(await adapter(backend).invoke(request)).ending).toBe('delivered'); returned = true;
  const toolKinds = backend === 'codex'
    ? codexTools.flatMap(([, phases]) => phases.map(phase => phase === 'started' ? 'tool-start' : 'tool-end'))
    : ['tool-start', 'tool-end'];
  expect(activities.map(event => event.kind)).toEqual([...toolKinds, 'message', 'turn-end']);
  if (backend === 'codex') expect(activities.filter(event => event.tool).map(event => event.tool))
    .toEqual(codexTools.flatMap(([type, phases]) => phases.map(() => type)));
  expect(JSON.stringify(activities)).not.toContain('secret synthetic value');
  expect(activities.every(event => (event.summary?.length ?? 0) <= 200)).toBe(true);
});
const echo = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, isReplay: true }) + '\n';
const result = (answer: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { answer } }) + '\n';
it('Claude: a written guide is delivered at its echo; a result with a guide still unechoed is not terminal; the last result answers', async () => {
  const end = vi.fn(); let live: import('../dist-rewrite/contract/live.js').LiveInvocation | undefined;
  request = { ...request, live: { onLive(value) { live = value; } } };
  await stream([]);
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io!.onReady!({ write: async () => true, end });
    const steering = live!.steer('late guide');
    io!.onStdout!(bytes.encode(result('first')));
    expect(end).not.toHaveBeenCalled();
    io!.onStdout!(bytes.encode(echo('late guide')));
    expect(await steering).toBe('delivered');
    expect(end).not.toHaveBeenCalled();
    io!.onStdout!(bytes.encode(result('second')));
    expect(end).toHaveBeenCalledOnce();
    return { ok: true, value: { ...processReceipt, stdout: await put(result('first') + echo('late guide') + result('second')) } };
  });
  const reply = get(await adapter('claude').invoke(request));
  expect(reply.ending).toBe('delivered');
  expect(JSON.parse(await text(reply.answerBytes!))).toEqual({ answer: 'second' });
});
it('Claude: a written guide with no echo when the invocation ends is not delivered, and the first result still answers', async () => {
  const end = vi.fn(); let live: import('../dist-rewrite/contract/live.js').LiveInvocation | undefined;
  request = { ...request, live: { onLive(value) { live = value; } } };
  await stream([]);
  let steering: Promise<string> | undefined;
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io!.onReady!({ write: async () => true, end });
    steering = live!.steer('unconsumed guide');
    io!.onStdout!(bytes.encode(result('first')));
    expect(end).not.toHaveBeenCalled();
    return { ok: true, value: { ...processReceipt, stdout: await put(result('first')) } };
  });
  const reply = get(await adapter('claude').invoke(request));
  expect(await steering).toBe('ended');
  expect(reply.ending).toBe('delivered');
  expect(JSON.parse(await text(reply.answerBytes!))).toEqual({ answer: 'first' });
});
it('Claude: at most one guide message is outstanding; guides steered meanwhile are held, then sent as one message whose echo delivers all of them', async () => {
  const writes: string[] = [], end = vi.fn(); let live: import('../dist-rewrite/contract/live.js').LiveInvocation | undefined;
  request = { ...request, live: { onLive(value) { live = value; } } };
  await stream([]);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const sent = () => writes.map(line => JSON.parse(line).message.content);
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io!.onReady!({ write: async value => { writes.push(new TextDecoder().decode(value)); return true; }, end });
    const settled: string[] = [], fed: string[] = [];
    const feed = (line: string) => { fed.push(line); io!.onStdout!(bytes.encode(line)); };
    const steer = (text: string) => live!.steer(text).then(outcome => { settled.push(text + ':' + outcome); });
    const all = [steer('A'), steer('B'), steer('C')]; await tick();
    expect(sent()).toEqual(['A']);
    feed(result('mid'));          // a result with a guide outstanding or held is not terminal
    expect(end).not.toHaveBeenCalled();
    feed(echo('A')); await tick();
    expect(settled).toEqual(['A:delivered']);
    expect(sent()).toEqual(['A', 'B\n\nC']);             // the held guides go out as one message, after the echo
    feed(echo('B'));              // an echo of anything but the outstanding message delivers nothing
    await tick(); expect(settled).toEqual(['A:delivered']);
    feed(result('still outstanding'));
    expect(end).not.toHaveBeenCalled();
    feed(echo('B\n\nC')); await Promise.all(all);
    expect(settled).toEqual(['A:delivered', 'B:delivered', 'C:delivered']);
    expect(end).not.toHaveBeenCalled();
    feed(result('done'));
    expect(end).toHaveBeenCalledOnce();
    expect(sent()).toHaveLength(2);
    return { ok: true, value: { ...processReceipt, stdout: await put(fed.join('')) } };
  });
  const reply = get(await adapter('claude').invoke(request));
  expect(reply.ending).toBe('delivered');
  expect(JSON.parse(await text(reply.answerBytes!))).toEqual({ answer: 'done' });
}, 5000);
it('Claude: held guides are not delivered when the invocation ends before their message is echoed', async () => {
  const end = vi.fn(); let live: import('../dist-rewrite/contract/live.js').LiveInvocation | undefined;
  request = { ...request, live: { onLive(value) { live = value; } } };
  await stream([]);
  let steering: Promise<string>[] = [];
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io!.onReady!({ write: async () => true, end });
    steering = [live!.steer('A'), live!.steer('B')];
    io!.onStdout!(bytes.encode(result('first')));
    return { ok: true, value: { ...processReceipt, stdout: await put(result('first')) } };
  });
  get(await adapter('claude').invoke(request));
  expect(await Promise.all(steering)).toEqual(['ended', 'ended']);
}, 5000);
it('Claude wraps the authenticated prompt, writes steering into the open session and ends stdin only on root result', async () => {
  const writes: Uint8Array[] = [], end = vi.fn();
  let live: import('../dist-rewrite/contract/live.js').LiveInvocation | undefined;
  request = { ...request, live: { onLive(value) { live = value; } } };
  await stream(success('claude'));
  vi.mocked(launchInvocation).mockImplementation(async (_context, program, _ports, _abort, io) => {
    expect(program.argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
    expect(JSON.parse(new TextDecoder().decode(io!.input!(bytes.encode('exact stdin'))))).toEqual({
      type: 'user', message: { role: 'user', content: 'exact stdin' }
    });
    io!.onReady!({ write: async value => { writes.push(value); return true; }, end });
    const steering = live!.steer('operator guidance');
    expect(end).not.toHaveBeenCalled();
    io!.onStdout!(bytes.encode(echo('operator guidance')));
    expect(await steering).toBe('delivered');
    expect(end).not.toHaveBeenCalled();
    io!.onStdout!(bytes.encode(JSON.stringify({ type: 'result', parent_tool_use_id: 'nested' }) + '\n'));
    expect(end).not.toHaveBeenCalled();
    io!.onStdout!(blobs.get(processReceipt.stdout.path)!);
    expect(end).toHaveBeenCalledOnce();
    expect(await live!.steer('too late')).toBe('ended');
    return { ok: true, value: { ...processReceipt, stdout: await put(echo('operator guidance') + JSON.stringify({ type: 'result', parent_tool_use_id: 'nested' }) + '\n' + await text(processReceipt.stdout)) } };
  });
  expect(get(await adapter('claude').invoke(request)).ending).toBe('delivered');
  expect(JSON.parse(new TextDecoder().decode(writes[0])).message.content).toBe('operator guidance');
});
it('the one incremental decoder preserves split UTF-8 and rejects malformed bytes/lines', () => {
  const events: unknown[] = [], decoder = protocolDecoder(event => events.push(event));
  const input = bytes.encode('  \n' + JSON.stringify({ text: '你好' }) + '\n{broken\n' + JSON.stringify({ type: 'tail' }));
  for (const byte of input) decoder.write(Uint8Array.of(byte));
  const final = decoder.finish();
  expect(events).toEqual([{ text: '你好' }, { type: 'tail' }]);
  expect(final).toEqual({ malformed: true, sha256: createHash('sha256').update(input).digest('hex') });
  const corrupt = protocolDecoder(() => {}); corrupt.write(Uint8Array.of(255));
  expect(corrupt.finish().malformed).toBe(true);
});
it('live decoding cannot authenticate different retained stdout', async () => {
  await stream(success('codex'));
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io!.onStdout!(bytes.encode('different provisional bytes'));
    return { ok: true, value: processReceipt };
  });
  expect(await adapter('codex').invoke(request)).toMatchObject({ ok: false, kind: 'conflict' });
});

it('Codex explicitly refuses a requested steering capability and never advertises onLive', async () => {
  const onLive = vi.fn(); request = { ...request, live: { onLive } };
  const codex = createCodexAdapter(context);
  expect(await codex.steer('guidance')).toBe('refused');
  await stream(success('codex')); get(await codex.invoke(request));
  expect(onLive).not.toHaveBeenCalled();
  expect(await codex.steer('later guidance')).toBe('refused');
});

it.each([
  [{ exit: null, signal: null, state: 'closed', closedAtTerminal: true }, 'delivered'],
  [{ exit: null, signal: null, state: 'closed' }, 'provider_unknown'],
  [{ exit: null, signal: null, state: 'not_started' }, 'provider_unknown'],
  [{ exit: null, signal: 'SIGKILL', state: 'closed' }, 'provider_unknown'],
  [{ exit: 1, signal: null, state: 'closed' }, 'provider_unknown'],
] as const)('Claude root result stays delivered only when the host marked the owner closed after the terminal event: %j', async (change, expected) => {
  await stream(success('claude'), change);
  expect(get(await adapter('claude').invoke(request)).ending).toBe(expected);
});

it('Claude closes the session when a root result arrives before the ready callback', async () => {
  const end = vi.fn(), onLive = vi.fn(); request = { ...request, live: { onLive } };
  await stream(success('claude'));
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io!.onStdout!(blobs.get(processReceipt.stdout.path)!);
    io!.onReady!({ write: async () => true, end });
    return { ok: true, value: processReceipt };
  });
  expect(get(await adapter('claude').invoke(request)).ending).toBe('delivered');
  expect(end).toHaveBeenCalledOnce(); expect(onLive).not.toHaveBeenCalled();
});

it('Claude observes child-session tools/messages without accepting a child answer or closing root stdin', async () => {
  const activities: import('../dist-rewrite/contract/live.js').ActivityEvent[] = [], end = vi.fn();
  request = { ...request, live: { onActivity: event => activities.push(event) } };
  const parent_tool_use_id = 'child';
  const childEvents = [
    { parent_tool_use_id, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash' }, { type: 'text', text: 'child message' }] } },
    { parent_tool_use_id, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] } },
    { parent_tool_use_id, type: 'result', subtype: 'success', is_error: false, structured_output: { child: 'not root answer' } }
  ];
  await stream([...childEvents, ...success('claude')]);
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io!.onReady!({ write: async () => true, end });
    io!.onStdout!(bytes.encode(childEvents.map(event => JSON.stringify(event)).join('\n') + '\n'));
    expect(end).not.toHaveBeenCalled();
    io!.onStdout!(bytes.encode(success('claude').map(event => JSON.stringify(event)).join('\n') + '\n'));
    return { ok: true, value: processReceipt };
  });
  const reply = get(await adapter('claude').invoke(request));
  expect(reply.nativeCommands).toHaveLength(0);
  expect(JSON.parse(await text(reply.answerBytes!))).toEqual(workAnswer);
  expect(activities.map(event => event.kind)).toEqual(['tool-start', 'message', 'tool-end', 'turn-end']);
  expect(end).toHaveBeenCalledOnce();
});


it.each(['codex', 'claude'] as const)('%s activity callback failures do not interrupt answer or usage decoding', async backend => {
  const onActivity = vi.fn(() => { throw Error('observer unavailable'); });
  request = { ...request, live: { onActivity } };
  await stream(success(backend));
  const reply = get(await adapter(backend).invoke(request));
  expect(reply.ending).toBe('delivered');
  expect(JSON.parse(await text(reply.answerBytes!))).toEqual(workAnswer);
  expect(reply.usage).toMatchObject({ state: 'known', input: 3, output: 2 });
  expect(onActivity).toHaveBeenCalled();
});

it('Claude closes stdin when final decoding flushes an unterminated result line', async () => {
  const end = vi.fn();
  await stream(success('claude'));
  processReceipt = { ...processReceipt, stdout: await put((await text(processReceipt.stdout)).trimEnd()) };
  vi.mocked(launchInvocation).mockImplementation(async (_context, _program, _ports, _abort, io) => {
    io!.onReady!({ write: async () => true, end });
    io!.onStdout!(blobs.get(processReceipt.stdout.path)!);
    expect(end).not.toHaveBeenCalled();
    return { ok: true, value: processReceipt };
  });
  expect(get(await adapter('claude').invoke(request)).ending).toBe('delivered');
  expect(end).toHaveBeenCalledOnce();
});
