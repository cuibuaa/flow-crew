import { afterEach, expect, it, vi } from 'vitest';
import { launchInvocation } from '../../dist-rewrite/host/process.js';
import { fixture, known } from '../fixtures/rewrite-host.js';
import { stateFixture } from '../fixtures/rewrite-state.js';
import { captureCheckpoint, settleFrozenInputs } from '../../dist-rewrite/records/content.js';
import { putEvidence } from '../../dist-rewrite/records/evidence.js';

const observation = vi.hoisted(() => ({ mode: '', injected: false, nativeExit: false,
  reads: [] as { buffer: Buffer; offset: number }[], children: [] as any[] }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (args[1] === 'wx+' && String(args[0]).endsWith('-stdout')) {
      const read = file.read.bind(file);
      file.read = vi.fn(async (buffer: Buffer, start: number, length: number, offset: number) => {
        observation.reads.push({ buffer, offset });
        if (observation.mode === 'final' && observation.nativeExit ||
            observation.mode === 'transient' && offset > 0 && !observation.injected) {
          observation.injected = true; throw Error('Injected stdout read failure');
        }
        return read(buffer, start, length, offset);
      }) as typeof file.read;
    }
    return file;
  }) };
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    if (child.stdin) vi.spyOn(child.stdin, 'end');
    child.on('message', (value: any) => { if (value.nativeExit) observation.nativeExit = true; });
    observation.children.push(child); return child;
  }) };
});
afterEach(() => { vi.restoreAllMocks(); observation.mode = ''; observation.injected = false;
  observation.nativeExit = false; observation.reads = []; observation.children = []; });

it('a transient live stdout read failure is logged and retried at the unadvanced offset with all bytes recovered', async () => {
  const f = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  observation.mode = 'transient';
  const chunks: Buffer[] = [];
  try {
    const result = known(await launchInvocation({}, { argv: [process.execPath, '-e',
      "process.stdout.write('first\\n');setTimeout(()=>process.stdout.write('second\\n'),500);setTimeout(()=>{},800)"],
      cwd: f.work, env: {} }, f.ports, new AbortController().signal, { onStdout: bytes => chunks.push(Buffer.from(bytes)) }));
    expect(observation.injected).toBe(true);
    expect(warning).toHaveBeenCalledWith('Live stdout observation failed; will retry:', expect.any(Error));
    expect(result).toMatchObject({ state: 'closed', exit: 0, guarantee: 'marker' });
    expect(Buffer.concat(chunks).toString()).toBe('first\nsecond\n');
    expect(await f.text(result.stdout)).toBe('first\nsecond\n');
    const offsets = observation.reads.map(read => read.offset);
    expect(offsets.filter(offset => offset === 6).length).toBeGreaterThanOrEqual(2);
    expect(new Set(observation.reads.map(read => read.buffer)).size).toBe(1);
  } finally { await f.close(); }
});

it('a final authoritative stdout read failure still fails the invocation', async () => {
  const f = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  observation.mode = 'final';
  try {
    expect(await launchInvocation({}, { argv: [process.execPath, '-e', "process.stdout.write('tail')"],
      cwd: f.work, env: {} }, f.ports, new AbortController().signal, { onStdout: () => {} }))
      .toMatchObject({ ok: false, kind: 'unknown', detail: expect.stringContaining('Injected stdout read failure') });
    expect(observation.injected).toBe(true);
  } finally { warning.mockRestore(); await f.close(); }
});

it('native exit closes stdin directly before retaining streams even when no result event was emitted', async () => {
  const f = await fixture(), onReady = vi.fn();
  f.ports.contain = async owner => ({ ...owner, containment: { kind: 'marker', marker: owner.authority } });
  const retain = f.ports.storeEvidence;
  f.ports.storeEvidence = async source => {
    const child = observation.children.find(child => child.pid === ownerPid);
    expect(observation.nativeExit).toBe(true);
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.stdin.writableEnded).toBe(true);
    return retain(source);
  };
  let ownerPid: number;
  const record = f.ports.recordProcess;
  f.ports.recordProcess = async payload => { if (payload.type === 'ownership') ownerPid = payload.owner.pid; return record(payload); };
  try {
    expect(known(await launchInvocation({}, { argv: [process.execPath, '-e', 'process.exitCode=7'],
      cwd: f.work, env: {} }, f.ports, new AbortController().signal, { onReady })))
      .toMatchObject({ state: 'closed', exit: 7 });
    expect(onReady).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.skipIf(process.platform !== 'linux')('production containment falls back to a recorded marker when its systemd bus dependency is unavailable', async () => {
  const f = await fixture();
  // Exercise real contain(), including nativeTool and execFile, without replacing the containment port.
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=' + f.base + '/missing-user-bus');
  try {
    const receipt = await f.launch("process.stdout.write(process.env.FLOWCREW_INVOCATION)");
    expect(receipt).toMatchObject({ state: 'closed', guarantee: 'marker', owner: { containment: { kind: 'marker' } } });
    const owner = receipt.owner!;
    if (owner.containment?.kind !== 'marker') throw Error('Expected marker owner');
    expect(owner.containment.marker).toMatch(/^[a-f0-9-]{36}$/);
    expect(await f.text(receipt.stdout)).toBe(owner.containment.marker);
    expect(f.ports.contain).toBeUndefined();
  } finally { vi.unstubAllEnvs(); await f.close(); }
});

it.skipIf(process.platform !== 'linux')('a real cgroup owner carries no unrecorded or inherited invocation marker', async () => {
  const f = await fixture();
  try {
    const receipt = await f.launch("process.stdout.write(String(process.env.FLOWCREW_INVOCATION))",
      { env: { FLOWCREW_INVOCATION: 'inherited-marker' } });
    expect(receipt).toMatchObject({ state: 'closed', guarantee: 'cgroup',
      detail: 'cgroup: proven recursive descendant closure.', owner: { containment: { kind: 'cgroup' } } });
    expect(await f.text(receipt.stdout)).toBe('undefined');
  } finally { await f.close(); }
});

it('content retention requires owner retirement under its recorded guarantee, including an unavailable marker scan', async () => {
  const f = await stateFixture();
  await f.admit();
  try {
    const scope = f.scope;
    const record = async (payload: any) => f.append(f.execution, [payload]);
    // An impossible live group; no native process or environment scan at this boundary.
    const owner = { pid: 2147483647, group: 2147483647, start: 'retired', boot: 'retired', authority: 'marker-owner',
      containment: { kind: 'marker' as const, marker: '11111111-1111-4111-8111-111111111111' } };
    await record({ type: 'ownership', owner, state: 'live' });
    const audit = known(await settleFrozenInputs(scope)).inputs;
    const capture = () => captureCheckpoint(scope, { run: 'Run', stage: 'work', attempt: 'Retention', invocation: 1 }, null, 'safe', [], audit);
    expect(await capture()).toMatchObject({ ok: false, kind: 'conflict',
      detail: 'Invocation owner has not retired under its recorded closure guarantee' });
    const ref = known(await putEvidence(scope.journal, Buffer.from('')));
    await record({ type: 'process', receipt: { owner, state: 'closed', exit: 0, signal: null,
      stdout: ref, stderr: ref, durationMs: 1, scope: 'group', guarantee: 'marker',
      detail: 'marker: best effort; current-user environment scan unavailable, descendant fate unknown; no unverified process signalled. Owner retired.' } });
    await record({ type: 'owner_closed', owner });
    expect((await capture()).ok).toBe(true);
  } finally { await f.close(); }
});
