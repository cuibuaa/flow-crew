import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import * as ownership from '../src/run-lock.js';
import * as liveness from '../src/process-liveness.js';
import * as recovery from '../src/restart-recovery.js';
import { createInvocationScratch } from '../src/invocation-scratch.js';
import { cmdPrune, pruneRunWorkAreas } from '../src/run-retention.js';
import { fcGlobalDir, setFcGlobalDir, type StoreState } from '../src/store.js';

let root: string, run: string, state: StoreState, previousStore: string;
const contracts = () => ['done', 'later'].map(id => ({ id, depends_on: [],
  artifact_contract: { version: 1, produces: [], reads: [] } }));

function persist(): void {
  writeFileSync(join(run, 'run.json'), JSON.stringify(state));
  for (const [id, status] of Object.entries(state.stages)) put(`stages/${id}/status.json`, JSON.stringify(status));
}
function put(path: string, content: string | Buffer = 'fixture'): void {
  mkdirSync(dirname(join(run, path)), { recursive: true });
  writeFileSync(join(run, path), content);
}
function tree(path = run): unknown[] {
  return readdirSync(path).sort().map(name => {
    const child = join(path, name), stat = lstatSync(child);
    return [name, stat.mode, stat.mtimeMs, stat.isSymbolicLink() ? readlinkSync(child)
      : stat.isDirectory() ? tree(child) : createHash('sha256').update(readFileSync(child)).digest('hex')];
  });
}
function plan() { return pruneRunWorkAreas(run, { dryRun: true }); }
function removed() { return plan().remove.map(member => member.path); }
function rejectWithoutWrites(pattern: RegExp): void {
  persist();
  const before = tree();
  expect(() => plan()).toThrow(pattern);
  expect(tree()).toEqual(before);
  expect(() => pruneRunWorkAreas(run)).toThrow(pattern);
  expect(tree()).toEqual(before);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-retention-'));
  run = join(root, 'runs', 'fixture'); mkdirSync(run, { recursive: true });
  previousStore = fcGlobalDir(); setFcGlobalDir(root);
  state = { runId: 'fixture', projectDir: '/workspace/fixture', workflowName: 'retention', status: 'complete',
    startedAt: '2026-01-01T00:00:00.000Z', stages: { done: { status: 'complete', retries: 0 }, later: { status: 'complete', retries: 0 } },
    engineCheckpoint: { version: 2, runId: 'fixture', projectDir: '/workspace/fixture', pid: 48100, bootId: recovery.readHostBootId(),
      processStart: { kind: 'linux', value: '100' }, processes: [], at: '2026-01-01T00:00:00.000Z' } };
  persist(); put('workflow.yaml', stringify({ name: 'retention', stages: contracts() }));
  put('stages/done/build/attempt_1/corpus.bin', Buffer.alloc(2048, 1));
  put('stages/done/scratch/attempt_2/work.bin', Buffer.alloc(1024, 2));
  put('stages/later/output.md', 'Completed.');
  put('scratch/vite/dist/bundle.js', Buffer.alloc(2048, 3));
  put('scratch/pytest/.pytest_cache/result.json', Buffer.alloc(1024, 4));
  vi.spyOn(ownership, 'inspectRunScheduler').mockReturnValue({ kind: 'missing' });
  vi.spyOn(liveness, 'processLiveness').mockReturnValue('dead');
  vi.spyOn(liveness, 'processGroupIsAlive').mockReturnValue(false);
});
afterEach(() => { vi.restoreAllMocks(); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

describe('run retention authority guards', () => {
  it.each(['pending', 'running', 'parked', 'awaiting_approval', 'future_terminal', '', null])(
    'R01 refuses nonterminal or unknown status %j without writes', status => {
      (state as unknown as { status: unknown }).status = status;
      rejectWithoutWrites(/RETENTION_NOT_TERMINAL|Unrecognized archived run status/);
    });
  it.each(['live', 'corrupt', 'unverifiable'] as const)('R02 refuses %s scheduler identity without writes', kind => {
    vi.mocked(ownership.inspectRunScheduler).mockReturnValue({ kind, pid: 48101, detail: 'fixture uncertainty' });
    rejectWithoutWrites(/RETENTION_PROCESS/);
  });
  it('R03 refuses a live checkpoint controller even when its scheduler marker is absent', () => {
    vi.mocked(liveness.processLiveness).mockReturnValue('alive');
    vi.spyOn(liveness, 'processStartToken').mockReturnValue(state.engineCheckpoint!.processStart);
    rejectWithoutWrites(/controller may still be alive/);
  });
  it('R04 refuses unverifiable live controller identity', () => {
    vi.mocked(liveness.processLiveness).mockReturnValue('unknown');
    vi.spyOn(liveness, 'processStartToken').mockReturnValue(undefined);
    rejectWithoutWrites(/controller may still be alive/);
  });
  it.each([true, false])('R05 refuses an alive command group with known identity=%s without sending signals', known => {
    state.engineCheckpoint!.processes = [{ pid: 48101, processStart: known ? { kind: 'linux', value: '101' } : undefined }];
    vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    vi.spyOn(liveness, 'processStartToken').mockReturnValue(known ? { kind: 'linux', value: '101' } : undefined);
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('retention must never signal'); });
    rejectWithoutWrites(/commands may still be alive/);
    expect(signal).not.toHaveBeenCalled();
  });
  it.each(['missing checkpoint', 'missing groups', 'bad controller', 'bad version', 'wrong run', 'wrong project']) (
    'R06 refuses unknown ownership: %s', kind => {
      const checkpoint = state.engineCheckpoint!;
      if (kind === 'missing checkpoint') delete state.engineCheckpoint;
      if (kind === 'missing groups') delete checkpoint.processes;
      if (kind === 'bad controller') checkpoint.pid = 0;
      if (kind === 'bad version') (checkpoint as unknown as { version: number }).version = 3;
      if (kind === 'wrong run') checkpoint.runId = 'another';
      if (kind === 'wrong project') checkpoint.projectDir = '/workspace/another';
      rejectWithoutWrites(/RETENTION_PROCESS/);
    });
  it.each([false, true])('refuses legacy command ownership with race=%s before planning or deleting', race => {
    // The removed v1 fate probe guarded omitted nested consumers. The supported
    // checkpoint binding now rejects v1 regardless of race or prior-boot death.
    (state.engineCheckpoint as unknown as { version: number }).version = 1;
    state.engineCheckpoint!.bootId = '00000000-0000-0000-0000-000000000001';
    state.planControl = { version: 1, stages: [{ ...contracts()[0], ...(race ? { race: {} } : {}) }] } as StoreState['planControl'];
    rejectWithoutWrites(/RETENTION_PROCESS: checkpoint binding is unknown/);
  });
  it('R25 refuses mismatched run-directory identity', () => {
    state.runId = 'another'; rejectWithoutWrites(/RETENTION_PATH/);
  });
  it.skipIf(!recovery.readHostBootId())('R26 accepts proven prior-boot death without requiring current-host process observations', () => {
    state.engineCheckpoint!.bootId = '00000000-0000-0000-0000-000000000001';
    delete state.engineCheckpoint!.processes; persist();
    vi.mocked(liveness.processLiveness).mockReturnValue('alive');
    vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    expect(plan().removeBytes).toBe(3072);
    expect(liveness.processLiveness).not.toHaveBeenCalled();
    expect(liveness.processGroupIsAlive).not.toHaveBeenCalled();
  });
  it('R27 accepts reused controller and command identities only with different verified start tokens', () => {
    // Keep the signal probe alive: only a verified token mismatch permits retirement.
    const current = liveness.processStartToken(process.pid)!;
    const previous = { kind: current.kind, value: current.kind === 'linux'
      ? String(BigInt(current.value) + 1n) : `${current.value} stale` };
    state.engineCheckpoint!.pid = process.pid;
    state.engineCheckpoint!.processStart = previous;
    state.engineCheckpoint!.processes = [{ pid: process.pid, processStart: previous }]; persist();
    vi.mocked(liveness.processLiveness).mockRestore();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    vi.spyOn(liveness, 'processStartToken').mockReturnValue(current);
    expect(plan().removeBytes).toBe(3072);
    state.engineCheckpoint!.processStart = current;
    rejectWithoutWrites(/controller may still be alive/);
  });
  it('R28 refuses invalid command-group ownership without sending any signal', () => {
    state.engineCheckpoint!.processes = [{ pid: 0 }];
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('retention must never signal'); });
    rejectWithoutWrites(/invalid owned command group/);
    expect(signal).not.toHaveBeenCalled();
  });
  it.each([
    { owner: 'controller', token: { kind: 'linux', value: 'malformed' } },
    { owner: 'controller', token: { kind: 'posix-lstart', value: 'different token kind' } },
    { owner: 'group', token: { kind: 'linux', value: 'malformed' } },
    { owner: 'group', token: { kind: 'posix-lstart', value: '' } },
    { owner: 'group', token: { kind: 'posix-lstart', value: 'different token kind' } },
  ] as const)('R41 refuses malformed or incompatible $owner identity $token without writes', ({ owner, token }) => {
    vi.spyOn(liveness, 'processStartToken').mockReturnValue({ kind: 'linux', value: '100' });
    if (owner === 'controller') {
      state.engineCheckpoint!.processStart = token;
      vi.mocked(liveness.processLiveness).mockReturnValue('alive');
    } else {
      state.engineCheckpoint!.processes = [{ pid: process.pid, processStart: token }];
      vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    }
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('retention must never signal'); });
    rejectWithoutWrites(/RETENTION_PROCESS/);
    expect(signal).not.toHaveBeenCalled();
  });
});

describe('operator retention command', () => {
  function capture() {
    let stdout = '', stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true; });
    return { stdout: () => stdout, stderr: () => stderr, json: () => JSON.parse(stdout) };
  }
  it.each([{ flags: [] }, { flags: ['--dry-run'] }])('R21 CLI defaults to read-only and prints per-run bytes plus kept paths ($flags)', ({ flags }) => {
    const before = tree(root), output = capture();
    expect(cmdPrune(['prune', ...flags])).toBe(0);
    expect(output.stdout()).toContain('fixture: 3072 bytes would be removed');
    expect(output.stdout()).toContain('keep ');
    expect(output.stdout()).toContain('Total: 3072 bytes');
    expect(tree(root)).toEqual(before);
  });
  it('R22 CLI requires explicit apply and limits mutation to the selected run', () => {
    const other = join(root, 'runs', 'other'); mkdirSync(other);
    writeFileSync(join(other, 'run.json'), JSON.stringify({ ...state, runId: 'other', status: 'running' }));
    const otherBefore = tree(other), output = capture();
    expect(cmdPrune(['prune', '--run', 'fixture', '--apply', '--json'])).toBe(0);
    expect(output.json()).toMatchObject({ dryRun: false, totalBytes: 3072, refused: [], runs: [{ runId: 'fixture', removeBytes: 3072 }] });
    expect(existsSync(join(run, 'scratch'))).toBe(false);
    expect(existsSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toBe(true);
    expect(tree(other)).toEqual(otherBefore);
  });
  it('R23 CLI reports unsafe bulk runs without changing them and refuses targeted pruning', () => {
    const waiting = join(root, 'runs', 'waiting'); mkdirSync(waiting);
    writeFileSync(join(waiting, 'run.json'), JSON.stringify({ ...state, runId: 'waiting', status: 'running' }));
    const before = tree(root), waitingBefore = tree(waiting), fixtureBefore = tree(run), output = capture();
    expect(cmdPrune(['prune', '--json'])).toBe(0);
    expect(output.json()).toMatchObject({ dryRun: true, totalBytes: 3072, refused: [{ runId: 'waiting' }] });
    expect(tree(root)).toEqual(before);
    expect(cmdPrune(['prune', '--run', 'waiting', '--apply'])).toBe(1);
    expect(tree(waiting)).toEqual(waitingBefore);
    expect(tree(run)).toEqual(fixtureBefore);
  });
  it.each([['--apply', '--dry-run'], ['--run'], ['--run', '--apply'], ['--run', '../fixture'], ['--unknown']].map(flags => ({ flags })))(
    'R24 CLI rejects ambiguous or unsafe flags $flags without store writes', ({ flags }) => {
      const before = tree(root), output = capture();
      expect(cmdPrune(['prune', ...flags])).toBe(1);
      expect(output.stderr()).not.toBe(''); expect(tree(root)).toEqual(before);
    });
});


describe('invocation scratch retirement preserves durable products', () => {
  it.each(['complete', 'incomplete', 'cancelled', 'failed'] as const)('retires scratch at terminal %s while preserving declared stage evidence and historical build directories', status => {
    state.status = status; persist();
    const stages = contracts();
    stages[0].artifact_contract.produces = [{ id: 'evidence', root: 'run', path: 'stages/done/evidence', kind: 'directory' }] as never;
    put('workflow.yaml', stringify({ stages }));
    put('stages/done/evidence/result.json', '{"passed":true}');
    const stageBefore = tree(join(run, 'stages'));
    expect(removed()).toEqual(['scratch/pytest/.pytest_cache/result.json', 'scratch/vite/dist/bundle.js']);
    expect(pruneRunWorkAreas(run).removeBytes).toBe(3072);
    expect(existsSync(join(run, 'scratch'))).toBe(false);
    expect(tree(join(run, 'stages'))).toEqual(stageBefore);
    expect(readFileSync(join(run, 'stages/done/evidence/result.json'), 'utf8')).toBe('{"passed":true}');
  });
  it('explicit pruning retires terminal scratch with a lost alias while preserving stage evidence', () => {
    state.status = 'running'; persist();
    const scratch = createInvocationScratch(run);
    const alias = dirname(scratch.path);
    put('stages/done/evidence/result.json', '{"passed":true}');
    writeFileSync(join(scratch.path, 'cache.bin'), 'disposable');
    // A crash left the terminal record and physical scratch; reboot removed /tmp links.
    state.status = 'complete'; persist();
    rmSync(alias);
    const stageBefore = tree(join(run, 'stages'));
    expect(pruneRunWorkAreas(run).removeBytes).toBeGreaterThan(3072);
    expect(existsSync(join(run, 'scratch'))).toBe(false);
    expect(tree(join(run, 'stages'))).toEqual(stageBefore);
    expect(readFileSync(join(run, 'stages/done/evidence/result.json'), 'utf8')).toBe('{"passed":true}');
    expect(readFileSync(join(run, 'run.json'), 'utf8')).toContain('complete');
  });
  it.each(['parked', 'deploymentHold'] as const)('retains scratch for a %s continuation record', field => {
    (state as unknown as Record<string, unknown>)[field] = { reason: 'pending continuation' };
    persist();
    const before = tree();
    expect(plan().removeBytes).toBe(0);
    expect(pruneRunWorkAreas(run).removeBytes).toBe(0);
    expect(tree()).toEqual(before);
  });
  it('dry-run reports exact scratch bytes without changing timestamps, files or directories', () => {
    const before = tree();
    const first = plan();
    expect(plan()).toEqual(first);
    expect(first.removeBytes).toBe(3072);
    expect(first.remove.reduce((sum, member) => sum + member.bytes, 0)).toBe(first.removeBytes);
    expect(first.kept.length).toBeGreaterThan(0);
    expect(tree()).toEqual(before);
    expect(existsSync(join(run, '.run-state.lock'))).toBe(false);
  });
  it('apply preserves run records and is idempotent', () => {
    const records = ['run.json', 'workflow.yaml'].map(path => [path, readFileSync(join(run, path))] as const);
    const expected = plan();
    expect(pruneRunWorkAreas(run)).toEqual(expected);
    for (const [path, bytes] of records) expect(readFileSync(join(run, path))).toEqual(bytes);
    const after = tree();
    expect(pruneRunWorkAreas(run).removeBytes).toBe(0);
    expect(tree()).toEqual(after);
  });
  it('does not traverse scratch symlinks to external files', () => {
    const outside = join(root, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel.bin'), 'untouched');
    symlinkSync(outside, join(run, 'scratch/external'));
    const before = tree(outside);
    pruneRunWorkAreas(run);
    expect(existsSync(join(run, 'scratch'))).toBe(false);
    expect(tree(outside)).toEqual(before);
  });
  it('rejects a linked run root without traversing its target', () => {
    const alias = join(root, 'linked-run'); symlinkSync(run, alias);
    const before = tree();
    expect(() => pruneRunWorkAreas(alias, { dryRun: true })).toThrow(/RETENTION_PATH/);
    expect(() => pruneRunWorkAreas(alias)).toThrow(/RETENTION_PATH/);
    expect(tree()).toEqual(before);
  });
  it.each(['invalid-boot', {}, 17, ''])('refuses malformed boot identity %j instead of inferring owner death', bootId => {
    (state.engineCheckpoint as unknown as { bootId: unknown }).bootId = bootId;
    vi.mocked(liveness.processLiveness).mockReturnValue('alive');
    vi.spyOn(liveness, 'processStartToken').mockReturnValue(state.engineCheckpoint!.processStart);
    rejectWithoutWrites(/RETENTION_PROCESS/);
  });
});

describe('clean shares prune deletion authority', () => {
  it.each(['parked', 'running', 'deploymentHold', 'parked metadata', 'live scheduler', 'unverifiable scheduler'])('preserves %s history', kind => {
    if (['parked', 'running'].includes(kind)) state.status = kind as StoreState['status'];
    if (kind === 'deploymentHold') state.deploymentHold = { version: 1, id: 'fixture-hold', requestedAt: new Date().toISOString(), heldAt: new Date().toISOString() };
    if (kind === 'parked metadata') state.parked = { requestId: 'fixture', pausedAt: new Date().toISOString() } as StoreState['parked'];
    if (kind === 'live scheduler' || kind === 'unverifiable scheduler') vi.mocked(ownership.inspectRunScheduler).mockReturnValue({ kind: kind === 'live scheduler' ? 'live' : 'unverifiable', pid: 48101, detail: 'Fixture ownership' });
    persist();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(cmdPrune(['clean', '--keep', '0'])).toBe(0);
    expect(existsSync(join(run, 'run.json'))).toBe(true);
    expect(existsSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toBe(true);
  });

  it.each(['complete', 'failed', 'cancelled'] as const)('deletes settled %s work and history after its deployment hold was released', status => {
    state.status = status;
    const at = new Date().toISOString();
    state.deploymentHold = { version: 1, id: 'fixture-hold', requestedAt: at, heldAt: at, releasedAt: at };
    persist(); put('scratch/work.bin');
    expect(pruneRunWorkAreas(run).removeBytes).toBeGreaterThan(0);
    expect(existsSync(join(run, 'scratch'))).toBe(false);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(cmdPrune(['clean', '--keep', '0'])).toBe(0);
    expect(existsSync(run)).toBe(false);
  });

  it('deletes settled terminal history only after the keep count permits it', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(cmdPrune(['clean', '--keep', '1'])).toBe(0);
    expect(existsSync(run)).toBe(true);
    expect(cmdPrune(['clean', '--keep', '0'])).toBe(0);
    expect(existsSync(run)).toBe(false);
  });

  it.each(['abc', '-1', '1x', '1.5', '9007199254740992'])('rejects an invalid keep count %s without writes', value => {
    const before = tree();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(cmdPrune(['clean', '--keep', value])).toBe(1);
    expect(tree()).toEqual(before);
  });
});
