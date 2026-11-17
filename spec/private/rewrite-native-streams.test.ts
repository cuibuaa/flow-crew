import { evidenceBytes } from '../fixtures/rewrite-bytes.js';
import { providerSettings } from '../../dist-rewrite/exec/policy.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Ajv from 'ajv';
import type { Ref, Result } from '../../dist-rewrite/contract/brief.js';
import type { BackendRequest, ProcessReceipt, OwnedProgram } from '../../dist-rewrite/contract/runtime.js';
import { answerSchema } from '../../dist-rewrite/contract/answers.js';
import { launchInvocation, type ProcessPorts } from '../../dist-rewrite/host/process.js';
import { readEvidence, putEvidence } from '../../dist-rewrite/records/evidence.js';
import { createCodexAdapter } from '../../dist-rewrite/exec/codex.js';
import { createClaudeAdapter } from '../../dist-rewrite/exec/claude.js';
import { invokeBackend, type TransportContext } from '../../dist-rewrite/exec/transport.js';
import { readUsage } from '../../dist-rewrite/exec/usage.js';
vi.mock('../../dist-rewrite/host/process.js', async (original) => ({ ...await original<typeof import('../../dist-rewrite/host/process.js')>(),
 launchInvocation: vi.fn() }));
vi.mock('../../dist-rewrite/records/state.js', async (original) => ({
  ...await original<typeof import('../../dist-rewrite/records/state.js')>(),
  putEvidence: async (journal: unknown, value: Uint8Array) =>
    (await import('../../dist-rewrite/records/evidence.js')).putEvidence(journal as never, value),
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
  processReceipt = { state: 'closed', exit: 0, signal: null, grant: 'applied', durationMs: 2,
    stdout: await put(events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n')),
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
    input: await put('exact stdin'), schema: schema.json, project: join(root, 'project'), scratch: join(root, 'scratch'),
     writableRoots: [join(root, 'scratch')],
    protectedRoots: [join(root, 'protected')], durationMs: 10000, abort: new AbortController().signal };
  vi.mocked(launchInvocation).mockImplementation(async () => ({ ok: true, value: processReceipt }));
  await stream([]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it.each((['codex', 'claude'] as const).flatMap(backend => (['plan', 'work', 'gate'] as const).map(purpose => [backend,
 purpose] as const)))('P10 saved native %s/%s stream passes the actual adapter and receiving grammar', async (backend, purpose) => {
  const privateRoot = process.env.FLOWCREW_PRIVATE_FIXTURES;
  if (!privateRoot)
    throw new Error('FLOWCREW_PRIVATE_FIXTURES is required for the saved native gate');
  const file = `${backend}-${purpose}.stdout.jsonl`, raw = await readFile(join(privateRoot, file));
  const manifest = JSON.parse(await readFile(join(privateRoot, 'manifest.json'), 'utf8'));
  expect(createHash('sha256').update(raw).digest('hex')).toBe(manifest.find((item: any) => item.file === file).sha256);
  const schema = answerSchema({ purpose, criterionIds: ['message'], resultIds: [], commandIds: [], checkpointIds: [], roleIds: ['worker',
   'reviewer'], allowBlocked: false, final: purpose === 'gate', revision: 'revisionA' });
  request = { ...request, schema: schema.json };
  await stream(raw.toString('utf8').split('\n').filter(Boolean));
  const result = get(await adapter(backend).invoke(request));
  expect(result.ending).toBe('delivered');
  const decoded = JSON.parse(await text(result.answerBytes!));
  expect(decoded.kind).toBe(purpose);
  expect(schema.parse(decoded).ok).toBe(true);
  expect(result.usage.state).toBe('known');
  expect(launchInvocation).toHaveBeenCalledTimes(1);
});
