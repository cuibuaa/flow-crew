import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import * as ownership from '../src/run-lock.js';
import * as liveness from '../src/process-liveness.js';
import * as recovery from '../src/restart-recovery.js';
import { cmdPrune, pruneRunWorkAreas, RETENTION_SMALL_FILE_BYTES, RETENTION_FILE_BYTES, RETENTION_STAGE_BYTES } from '../src/run-retention.js';
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
  vi.spyOn(ownership, 'inspectRunScheduler').mockReturnValue({ kind: 'missing' });
  vi.spyOn(ownership, 'processIsAlive').mockReturnValue(false);
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
    vi.mocked(ownership.processIsAlive).mockReturnValue(true);
    vi.spyOn(ownership, 'processStartToken').mockReturnValue(state.engineCheckpoint!.processStart);
    rejectWithoutWrites(/controller may still be alive/);
  });
  it('R04 refuses unverifiable live controller identity', () => {
    vi.mocked(ownership.processIsAlive).mockReturnValue(true);
    vi.spyOn(ownership, 'processStartToken').mockReturnValue(undefined);
    rejectWithoutWrites(/controller may still be alive/);
  });
  it.each([true, false])('R05 refuses an alive command group with known identity=%s without sending signals', known => {
    state.engineCheckpoint!.processes = [{ pid: 48101, processStart: known ? { kind: 'linux', value: '101' } : undefined }];
    vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    vi.spyOn(ownership, 'processStartToken').mockReturnValue(known ? { kind: 'linux', value: '101' } : undefined);
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('retention must never signal'); });
    rejectWithoutWrites(/commands may still be alive/);
    expect(signal).not.toHaveBeenCalled();
  });
  it.each(['missing checkpoint', 'missing groups', 'bad controller', 'bad version', 'wrong run', 'wrong project', 'legacy consumers']) (
    'R06 refuses unknown ownership: %s', kind => {
      const checkpoint = state.engineCheckpoint!;
      if (kind === 'missing checkpoint') delete state.engineCheckpoint;
      if (kind === 'missing groups') delete checkpoint.processes;
      if (kind === 'bad controller') checkpoint.pid = 0;
      if (kind === 'bad version') (checkpoint as unknown as { version: number }).version = 3;
      if (kind === 'wrong run') checkpoint.runId = 'another';
      if (kind === 'wrong project') checkpoint.projectDir = '/workspace/another';
      if (kind === 'legacy consumers') {
        checkpoint.version = 1;
        state.planControl = { version: 1, stages: [{ id: 'legacy', race: {} }] } as unknown as StoreState['planControl'];
      }
      rejectWithoutWrites(/RETENTION_PROCESS/);
    });
  it.each(['running', 'closed'] as const)('R07 refuses unsettled %s attempt ledgers for a joined live owner', status => {
    state.engineCheckpoint!.pid = process.pid;
    state.stages.done.attempts = [{ index: 1, startedAt: state.startedAt, status }];
    persist();
    expect(() => pruneRunWorkAreas(run, { dryRun: true, ownerSettled: true })).toThrow(/RETENTION_UNSETTLED/);
  });
  it('R08 permits only the joined self owner while the run is running', () => {
    state.status = 'running'; state.engineCheckpoint!.pid = process.pid; persist();
    vi.mocked(ownership.inspectRunScheduler).mockReturnValue({ kind: 'live', pid: process.pid });
    vi.mocked(ownership.processIsAlive).mockReturnValue(true);
    expect(() => plan()).toThrow(/RETENTION_NOT_TERMINAL/);
    expect(pruneRunWorkAreas(run, { dryRun: true, ownerSettled: true }).removeBytes).toBe(3072);
    vi.mocked(ownership.inspectRunScheduler).mockReturnValue({ kind: 'live', pid: 48101 });
    expect(() => pruneRunWorkAreas(run, { dryRun: true, ownerSettled: true })).toThrow(/RETENTION_PROCESS/);
    vi.mocked(ownership.inspectRunScheduler).mockReturnValue({ kind: 'live', pid: process.pid });
    state.engineCheckpoint!.processes = [{ pid: 48101 }]; persist();
    vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    expect(() => pruneRunWorkAreas(run, { dryRun: true, ownerSettled: true })).toThrow(/RETENTION_PROCESS/);
  });
  it('R25 refuses mismatched run-directory identity', () => {
    state.runId = 'another'; rejectWithoutWrites(/RETENTION_PATH/);
  });
  it.skipIf(!recovery.readHostBootId())('R26 accepts proven prior-boot death without requiring current-host process observations', () => {
    state.engineCheckpoint!.bootId = '00000000-0000-0000-0000-000000000001';
    delete state.engineCheckpoint!.processes; persist();
    vi.mocked(ownership.processIsAlive).mockReturnValue(true);
    vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    expect(plan().removeBytes).toBe(3072);
    expect(ownership.processIsAlive).not.toHaveBeenCalled();
    expect(liveness.processGroupIsAlive).not.toHaveBeenCalled();
  });
  it('R27 accepts reused controller and command identities only with different verified start tokens', () => {
    // Both probes observe the same reused identity through the shared owner.
    const token = { kind: 'linux' as const, value: '100' };
    state.engineCheckpoint!.processes = [{ pid: process.pid, processStart: { kind: token!.kind, value: `${token!.value}9` } }]; persist();
    vi.mocked(ownership.processIsAlive).mockReturnValue(true);
    vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    vi.spyOn(ownership, 'processStartToken').mockReturnValue({ kind: 'linux', value: '999' });
    expect(plan().removeBytes).toBe(3072);
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
    vi.spyOn(ownership, 'processStartToken').mockReturnValue({ kind: 'linux', value: '100' });
    if (owner === 'controller') {
      state.engineCheckpoint!.processStart = token;
      vi.mocked(ownership.processIsAlive).mockReturnValue(true);
    } else {
      state.engineCheckpoint!.processes = [{ pid: process.pid, processStart: token }];
      vi.mocked(liveness.processGroupIsAlive).mockReturnValue(true);
    }
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('retention must never signal'); });
    rejectWithoutWrites(/RETENTION_PROCESS/);
    expect(signal).not.toHaveBeenCalled();
  });
});

describe('retention preserves consumers and evidence', () => {
  it.each(['pending', 'failed', 'skipped', 'unknown', 'continuation'])(
    'R09 keeps stage work needed by %s stage or continuation', status => {
      if (status === 'continuation') state.stages.done.continuation = { kind: 'budget', remainingWork: ['remaining'] } as unknown as NonNullable<typeof state.stages.done.continuation>;
      else (state.stages.done as unknown as { status: string }).status = status;
      persist(); expect(removed()).toEqual([]);
      pruneRunWorkAreas(run);
      expect(existsSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toBe(true);
    });
  it.each(['incomplete', 'stopped', 'failed'] as const)('R10 deletes invocation scratch at terminal %s even with unfinished work', status => {
    state.status = status; persist(); put('scratch/work.bin');
    expect(removed()).toContain('scratch/work.bin');
    expect(removed()).toContain('stages/done/build/attempt_1/corpus.bin');
    pruneRunWorkAreas(run);
    expect(existsSync(join(run, 'scratch'))).toBe(false);
  });
  it.each(['parked', 'deploymentHold'] as const)('R11 keeps all work for retained %s control records', field => {
    (state as unknown as Record<string, unknown>)[field] = { reason: 'pending continuation' };
    persist(); put('scratch/work.bin'); expect(plan().removeBytes).toBe(0);
  });
  it('R12 preserves declared readers, produced descendants and empty declared directories', () => {
    const stages = contracts();
    const reads = [{ id: 'input', root: 'run', path: 'stages/done/build/input', kind: 'directory', source: { kind: 'input' } }];
    const produces = [{ id: 'result', root: 'run', path: 'stages/done/build/result', kind: 'directory' },
      { id: 'empty', root: 'run', path: 'stages/done/build/empty', kind: 'directory' }];
    put('workflow.yaml', stringify({ stages: [stages[0], { ...stages[1], artifact_contract: { version: 1, reads, produces } }] }));
    put('stages/done/build/input/large.bin', Buffer.alloc(4096));
    put('stages/done/build/result/final.bin', Buffer.alloc(4096));
    mkdirSync(join(run, 'stages/done/build/empty'));
    expect(removed()).toHaveLength(2);
    pruneRunWorkAreas(run);
    for (const path of ['input/large.bin', 'result/final.bin', 'empty']) expect(existsSync(join(run, 'stages/done/build', path))).toBe(true);
  });
  it('R13 preserves admitted dynamic-plan readers as well as base workflow declarations', () => {
    state.planControl = { version: 1, stages: [{ id: 'consumer', depends_on: [], artifact_contract: { version: 1, produces: [],
      reads: [{ id: 'input', root: 'run', path: 'stages/done/build/attempt_1/corpus.bin', kind: 'file', source: { kind: 'input' } }] } }] } as StoreState['planControl'];
    persist(); expect(removed()).toEqual(['stages/done/scratch/attempt_2/work.bin']);
  });
  it('R14 keeps bounded exact cited paths and removes ambiguous basename mentions', () => {
    expect(RETENTION_SMALL_FILE_BYTES).toBe(1024 * 1024);
    put('stages/done/build/experiment/exact.bin', Buffer.alloc(RETENTION_SMALL_FILE_BYTES + 1));
    put('stages/done/build/experiment/driver.py', Buffer.alloc(RETENTION_SMALL_FILE_BYTES));
    put('stages/done/build/experiment/big.csv', Buffer.alloc(RETENTION_SMALL_FILE_BYTES + 1));
    put('stages/done/build/experiment/unmentioned.cfg', 'unused');
    put('stages/done/build/config.yaml', 'seed: 1');
    put('stages/done/output.md', 'Evidence: `build/experiment/exact.bin:12`; reproduction driver.py; rejected corpus big.csv.');
    const removal = removed();
    expect(removal).toContain('stages/done/build/experiment/big.csv');
    expect(removal).toContain('stages/done/build/experiment/unmentioned.cfg');
    expect(removal).not.toContain('stages/done/build/experiment/exact.bin');
    expect(removal).toContain('stages/done/build/experiment/driver.py');
    expect(removal).toContain('stages/done/build/config.yaml');
    pruneRunWorkAreas(run);
    expect(existsSync(join(run, 'stages/done/build/experiment/driver.py'))).toBe(false);
    expect(existsSync(join(run, 'stages/done/build/experiment/exact.bin'))).toBe(true);
  });
  it('R15 preserves nested portable handoffs, patches, logs, evidence, outputs and root records', () => {
    const durable = ['stages/done/build/old/handoff/portable/source.tar.gz', 'stages/done/build/old/patches/change.bin',
      'stages/done/build/old/logs/native.bin', 'stages/done/build/old/evidence/raw.bin', 'stages/done/build/old/outputs/result.bin',
      'stages/done/build/old/replay.patch', 'stages/done/build/old/session.log', 'stages/done/handoff/source.tgz',
      'patches/change.patch', 'outputs/report.md', 'events.jsonl', 'stages/done/status.json', 'stages/done/verdict.json', 'stages/done/output_attempt_1.md'];
    for (const path of durable) put(path, path === 'stages/done/status.json' ? JSON.stringify(state.stages.done) : 'durable bytes');
    put('stages/done/output.md', durable.map(path => `\`${path}\``).join(' '));
    const before = new Map(durable.map(path => [path, readFileSync(join(run, path))]));
    pruneRunWorkAreas(run);
    for (const [path, bytes] of before) expect(readFileSync(join(run, path)), path).toEqual(bytes);
  });
  it('R16 refuses absent or malformed workflow artifact declarations without mutation', () => {
    put('workflow.yaml', 'stages: malformed');
    rejectWithoutWrites(/RETENTION_CONTRACT/);
  });
  it.each(['outputs/findings.md', 'stages/done/analysis.md', 'stages/done/build/old/outputs/findings.md'])(
    'R29 preserves evidence cited by a durable report named %s', report => {
      if (report.includes('/build/')) put('stages/done/output.md', `Recorded report: \`${report}\`.`);
      put(report, 'Raw evidence: `stages/done/build/attempt_1/corpus.bin`.');
      expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
    });
  it.each(['running', 'continuation', 'missing', 'malformed', 'linked'] as const)(
    'R33 preserves stage and invocation work when the execution ledger is %s', kind => {
      put('stages/later/build/unused.bin', 'reclaim later');
      put('scratch/continuation.bin', 'retain invocation');
      const ledgerPath = join(run, 'stages/done/status.json');
      if (kind === 'running') put('stages/done/status.json', JSON.stringify({ ...state.stages.done, status: 'running' }));
      if (kind === 'continuation') put('stages/done/status.json', JSON.stringify({ ...state.stages.done, continuation: { kind: 'budget', remainingWork: ['unfinished'] } }));
      if (kind === 'missing') rmSync(ledgerPath);
      if (kind === 'malformed') put('stages/done/status.json', '{"status":');
      if (kind === 'linked') {
        const outside = join(root, 'ledger.json'); writeFileSync(outside, JSON.stringify(state.stages.done));
        rmSync(ledgerPath); symlinkSync(outside, ledgerPath);
      }
      expect(removed()).toEqual(['scratch/continuation.bin', 'stages/later/build/unused.bin']);
      pruneRunWorkAreas(run);
      expect(existsSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toBe(true);
      expect(existsSync(join(run, 'stages/done/scratch/attempt_2/work.bin'))).toBe(true);
      expect(existsSync(join(run, 'scratch/continuation.bin'))).toBe(false);
    });
  it.each([
    { path: 'attempt_1/corpus.bin', citation: '`../build/attempt_1/corpus.bin`' },
    { path: 'experiment/final result.bin', citation: '`../build/experiment/final result.bin`' },
    { path: 'experiment/final result.bin', citation: '[measurements](../build/experiment/final%20result.bin)' },
  ])('R34 preserves large evidence resolved relative to its report: $citation', ({ path, citation }) => {
    put(`stages/done/build/${path}`, Buffer.alloc(RETENTION_SMALL_FILE_BYTES + 1));
    put('stages/done/evidence/measurements.md', `Raw measurements: ${citation}.`);
    expect(removed()).not.toContain(`stages/done/build/${path}`);
    pruneRunWorkAreas(run);
    expect(readFileSync(join(run, 'stages/done/build', path)).length).toBe(RETENTION_SMALL_FILE_BYTES + 1);
  });
  it('R36 preserves evidence cited by a declared report inside its own workspace', () => {
    const stages = contracts();
    put('workflow.yaml', stringify({ stages: [{ ...stages[0], artifact_contract: { version: 1, reads: [],
      produces: [{ id: 'report', root: 'run', path: 'stages/done/build/report.md', kind: 'file' }] } }, stages[1]] }));
    put('stages/done/build/report.md', 'Measurements: `experiment/raw.bin`.');
    put('stages/done/build/experiment/raw.bin', Buffer.alloc(RETENTION_SMALL_FILE_BYTES + 1));
    expect(removed()).not.toContain('stages/done/build/experiment/raw.bin');
    pruneRunWorkAreas(run);
    expect(existsSync(join(run, 'stages/done/build/experiment/raw.bin'))).toBe(true);
  });
  it('R37 refuses absent artifact contracts instead of guessing that no continuation reads exist', () => {
    put('workflow.yaml', stringify({ stages: [{ id: 'done', depends_on: [] }, contracts()[1]] }));
    rejectWithoutWrites(/RETENTION_CONTRACT/);
  });
  it('R38 plain prose words build and scratch do not retain whole workspace roots', () => {
    put('stages/done/output.md', 'The build completed successfully. Disposable scratch is no longer required.');
    expect(plan().removeBytes).toBe(3072);
    expect(removed()).toEqual(['stages/done/build/attempt_1/corpus.bin', 'stages/done/scratch/attempt_2/work.bin']);
  });
  it('R39 preserves evidence cited by an explicit project report before terminal archiving', () => {
    const project = join(root, 'project'); mkdirSync(join(project, 'reports'), { recursive: true });
    state.projectDir = project; state.engineCheckpoint!.projectDir = project; persist();
    const stages = contracts();
    put('workflow.yaml', stringify({ stages: [{ ...stages[0], artifact_contract: { version: 1, reads: [],
      produces: [{ id: 'report', root: 'project', path: 'reports/final.md', kind: 'file' }] } }, stages[1]] }));
    writeFileSync(join(project, 'reports/final.md'), `Raw evidence: \`${join(run, 'stages/done/build/attempt_1/corpus.bin')}\`.`);
    expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
    pruneRunWorkAreas(run);
    expect(existsSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toBe(true);
  });
  it('R40 preserves a scratch target exposed through a declared project output alias', () => {
    const project = join(root, 'project'); mkdirSync(project);
    state.projectDir = project; state.engineCheckpoint!.projectDir = project; persist();
    const stages = contracts();
    put('workflow.yaml', stringify({ stages: [{ ...stages[0], artifact_contract: { version: 1, reads: [],
      produces: [{ id: 'published', root: 'project', path: 'published.bin', kind: 'file' }] } }, stages[1]] }));
    symlinkSync(join(run, 'stages/done/build/attempt_1/corpus.bin'), join(project, 'published.bin'));
    expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
    pruneRunWorkAreas(run);
    expect(existsSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toBe(true);
    expect(lstatSync(join(project, 'published.bin')).isSymbolicLink()).toBe(true);
  });
});

describe('retention filesystem guards and measurable result', () => {
  it('R17 retains symlinks and their internal targets without traversing external targets', () => {
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel.bin'), 'untouched');
    symlinkSync(outside, join(run, 'stages/done/build/external'));
    symlinkSync('attempt_1/corpus.bin', join(run, 'stages/done/build/internal'));
    const externalBefore = tree(outside);
    expect(removed()).toEqual(['stages/done/scratch/attempt_2/work.bin']);
    pruneRunWorkAreas(run);
    expect(lstatSync(join(run, 'stages/done/build/external')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toBe(true);
    expect(tree(outside)).toEqual(externalBefore);
  });
  it.each(['handoff file', 'output directory', 'handoff chain'] as const)(
    'R35 preserves scratch targets referenced by a durable %s symlink', kind => {
      mkdirSync(join(run, 'stages/done/handoff'));
      mkdirSync(join(run, 'stages/done/outputs'));
      if (kind === 'handoff file') symlinkSync('../build/attempt_1/corpus.bin', join(run, 'stages/done/handoff/source'));
      if (kind === 'output directory') symlinkSync('../build/attempt_1', join(run, 'stages/done/outputs/results'));
      if (kind === 'handoff chain') {
        symlinkSync('relay', join(run, 'stages/done/handoff/source'));
        symlinkSync('../build/attempt_1/corpus.bin', join(run, 'stages/done/handoff/relay'));
      }
      expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
      pruneRunWorkAreas(run);
      expect(readFileSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toEqual(Buffer.alloc(2048, 1));
      const link = kind === 'output directory' ? 'outputs/results' : 'handoff/source';
      expect(lstatSync(join(run, 'stages/done', link)).isSymbolicLink()).toBe(true);
    });
  it.each(['run', 'stages', 'stage', 'build'] as const)('R18 never traverses a linked %s ancestor', kind => {
    const source = kind === 'run' ? run : join(run, 'stages', ...(kind === 'stages' ? [] : ['done']), ...(kind === 'build' ? ['build'] : []));
    const destination = join(root, 'linked-content');
    // Move only our own fixture, preserving a sentinel outside the run tree.
    const move = (from: string, to: string): void => {
      mkdirSync(to); for (const name of readdirSync(from)) {
        const child = join(from, name);
        if (lstatSync(child).isDirectory()) move(child, join(to, name)); else writeFileSync(join(to, name), readFileSync(child));
      }
      rmSync(from, { recursive: true });
    };
    move(source, destination); symlinkSync(destination, source);
    const before = tree(destination);
    if (kind === 'run' || kind === 'stages') expect(() => plan()).toThrow(/RETENTION_PATH/);
    else { expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin'); pruneRunWorkAreas(run); }
    expect(tree(destination)).toEqual(before);
  });
  it('R19 dry-run preserves every file, directory, timestamp and byte while reporting the exact benefit', () => {
    const before = tree();
    const first = plan(), second = plan();
    expect(first).toEqual(second);
    expect(first.removeBytes).toBe(3072);
    expect(first.remove.reduce((sum, member) => sum + member.bytes, 0)).toBe(first.removeBytes);
    expect(first.kept.length).toBeGreaterThan(0);
    expect(tree()).toEqual(before);
    expect(existsSync(join(run, '.run-state.lock'))).toBe(false);
  });
  it('R20 apply reclaims the same measured bytes, preserves durable state and is idempotent', () => {
    const beforeState = readFileSync(join(run, 'run.json'));
    const beforeWorkflow = readFileSync(join(run, 'workflow.yaml'));
    const expected = plan();
    const applied = pruneRunWorkAreas(run);
    expect(applied.remove).toEqual(expected.remove);
    expect(applied.removeBytes).toBe(3072);
    for (const member of expected.remove) expect(existsSync(join(run, member.path))).toBe(false);
    expect(existsSync(join(run, 'stages/done/build'))).toBe(true);
    expect(readFileSync(join(run, 'run.json'))).toEqual(beforeState);
    expect(readFileSync(join(run, 'workflow.yaml'))).toEqual(beforeWorkflow);
    const after = tree();
    expect(pruneRunWorkAreas(run).removeBytes).toBe(0);
    expect(tree()).toEqual(after);
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
    expect(existsSync(join(run, 'stages/done/build/attempt_1/corpus.bin'))).toBe(false);
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

describe('retention evidence and malformed ownership regressions', () => {
  it('R42 preserves large sibling evidence cited by an explicit relative Markdown link', () => {
    const stages = contracts();
    stages[0].artifact_contract.produces = [{ id: 'report', root: 'run', path: 'stages/done/build/report.md', kind: 'file' }] as never;
    put('workflow.yaml', stringify({ stages }));
    put('stages/done/build/raw.bin', Buffer.alloc(RETENTION_SMALL_FILE_BYTES + 1));
    put('stages/done/build/report.md', '[raw measurements](raw.bin)');
    expect(removed()).not.toContain('stages/done/build/raw.bin');
  });
  it('R43 preserves evidence cited through a declared project report symlink', () => {
    const stages = contracts();
    stages[0].artifact_contract.produces = [{ id: 'report', root: 'project', path: 'report.md', kind: 'file' }] as never;
    put('workflow.yaml', stringify({ stages }));
    state.projectDir = join(root, 'report-project'); mkdirSync(state.projectDir);
    state.engineCheckpoint!.projectDir = state.projectDir; persist();
    const report = join(state.projectDir, 'actual.md');
    writeFileSync(report, `Evidence: ${join(run, 'stages/done/build/attempt_1/corpus.bin')}`);
    symlinkSync(report, join(state.projectDir, 'report.md'));
    expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
  });
  it('R44 protects a durable link target reached through an external alias without deleting outside the run', () => {
    const alias = join(root, 'alias.bin');
    symlinkSync(join(run, 'stages/done/build/attempt_1/corpus.bin'), alias);
    mkdirSync(join(run, 'handoff'));
    symlinkSync(alias, join(run, 'handoff/result.bin'));
    expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
    pruneRunWorkAreas(run);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(run, 'handoff/result.bin')).length).toBe(2048);
  });
  it.each(['invalid-boot', {}, 17, ''])('R45 refuses malformed boot identity %j instead of inferring owner death', bootId => {
    (state.engineCheckpoint as unknown as { bootId: unknown }).bootId = bootId;
    vi.mocked(ownership.processIsAlive).mockReturnValue(true);
    vi.spyOn(ownership, 'processStartToken').mockReturnValue(state.engineCheckpoint!.processStart);
    rejectWithoutWrites(/RETENTION_PROCESS/);
  });
  it.each(['root', 'path', 'version', 'source'])('R46 refuses malformed declared %s before disposing work', field => {
    const stages = contracts();
    const read = { id: 'raw', root: 'run', path: 'stages/done/build/attempt_1/corpus.bin', kind: 'file', source: { kind: 'input' } };
    const contract = { version: 1, produces: [], reads: [read] };
    if (field === 'root') read.root = 'rnu';
    if (field === 'path') read.path = '../escape';
    if (field === 'version') contract.version = 77;
    if (field === 'source') read.source.kind = 'unknown';
    stages[0].artifact_contract = contract as never;
    put('workflow.yaml', stringify({ stages }));
    rejectWithoutWrites(/RETENTION_CONTRACT/);
  });
});

it('R47 refuses an explicit report with an unknown linked target format without mutation', () => {
  const stages = contracts();
  stages[0].artifact_contract.produces = [{ id: 'report', root: 'project', path: 'report.txt', kind: 'file' }] as never;
  put('workflow.yaml', stringify({ stages }));
  state.projectDir = join(root, 'report-project'); mkdirSync(state.projectDir);
  state.engineCheckpoint!.projectDir = state.projectDir; persist();
  writeFileSync(join(state.projectDir, 'opaque.bin'), 'Unclassified report contents.');
  symlinkSync('opaque.bin', join(state.projectDir, 'report.txt'));
  rejectWithoutWrites(/RETENTION_REPORT/);
});

it.each([
  { path: 'raw data.bin', citation: '[raw](<raw data.bin>)' },
  { path: 'results/raw.bin', citation: '[complete measurements](results)' },
  { path: 'raw', citation: '[raw](raw)' },
  { path: 'raw.bin', citation: '[raw](raw.bin "measurements")' },
  { path: 'raw!', citation: '`raw!`' },
])('R48 preserves explicit local Markdown evidence $citation', ({ path, citation }) => {
  const stages = contracts();
  stages[0].artifact_contract.produces = [{ id: 'report', root: 'run', path: 'stages/done/build/report.md', kind: 'file' }] as never;
  put('workflow.yaml', stringify({ stages }));
  put(`stages/done/build/${path}`, Buffer.alloc(RETENTION_SMALL_FILE_BYTES + 1));
  put('stages/done/build/report.md', citation);
  expect(removed()).not.toContain(`stages/done/build/${path}`);
});
it('R49 resolves report-relative citations at a declared report symlink location as well as its target', () => {
  const stages = contracts();
  stages[0].artifact_contract.produces = [{ id: 'report', root: 'run', path: 'stages/done/handoff/report.md', kind: 'file' }] as never;
  put('workflow.yaml', stringify({ stages }));
  const actual = join(root, 'actual-report.md');
  writeFileSync(actual, '[raw](../build/attempt_1/corpus.bin)');
  mkdirSync(join(run, 'stages/done/handoff'));
  symlinkSync(actual, join(run, 'stages/done/handoff/report.md'));
  expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
});


it.each(['running', 'closed'] as const)('R50 proven-dead stale %s attempt preserves its own work without blocking settled stages', status => {
  state.status = 'stopped';
  state.stages.later = { status: 'running', retries: 0, attempts: [{ index: 1, startedAt: state.startedAt, status }] };
  persist(); put('stages/later/build/unfinished.bin');
  expect(plan().removeBytes).toBe(3072);
  expect(removed()).not.toContain('stages/later/build/unfinished.bin');
  vi.mocked(ownership.processIsAlive).mockReturnValue(true);
  vi.spyOn(ownership, 'processStartToken').mockReturnValue(state.engineCheckpoint!.processStart);
  expect(() => plan()).toThrow(/controller may still be alive/);
});

it('R51 bounds all discretionary citations and durable categories per file and per stage across build and scratch', () => {
  const paths = ['evidence/large.bin', 'logs/large.log', 'outputs/large.md', 'archive.tar.gz', 'cited.bin'];
  for (const path of paths) put(`stages/done/build/${path}`, Buffer.alloc(RETENTION_FILE_BYTES + 1));
  put('stages/done/output.md', 'Evidence: `build/cited.bin`; `build/many`; `scratch/many`.');
  for (let index = 0; index < 6; index++) {
    put(`stages/done/${index % 2 ? 'scratch' : 'build'}/many/${index}.log`, Buffer.alloc(RETENTION_FILE_BYTES));
  }
  const result = plan();
  for (const path of paths) expect(result.remove.map(item => item.path)).toContain(`stages/done/build/${path}`);
  const keptLogs = result.kept.filter(item => /many\/\d.log$/.test(item.path));
  expect(keptLogs.length * RETENTION_FILE_BYTES).toBe(RETENTION_STAGE_BYTES);
  const before = result.removeBytes;
  pruneRunWorkAreas(run);
  expect(before).toBeGreaterThan(RETENTION_STAGE_BYTES);
  expect(plan().removeBytes).toBe(0);
});

it('R52 workspace Markdown becomes a citation source only through recorded evidence, including transitive reports', () => {
  put('stages/done/build/corpus/README.md', '`../attempt_1/corpus.bin`');
  expect(removed()).toContain('stages/done/build/attempt_1/corpus.bin');
  put('stages/done/output.md', '[analysis](build/corpus/README.md)');
  expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
});

it('R53 oversized reports are not scanned as citation sources', () => {
  put('stages/done/output.md', 'x'.repeat(RETENTION_SMALL_FILE_BYTES) + ' `build/attempt_1/corpus.bin`');
  expect(removed()).toContain('stages/done/build/attempt_1/corpus.bin');
});


it('R54 bounds citation-source bytes per stage without reading arbitrary workspace Markdown', () => {
  for (let index = 0; index < RETENTION_STAGE_BYTES / RETENTION_SMALL_FILE_BYTES; index++) {
    put(`stages/done/evidence/${String(index).padStart(2, '0')}.md`, Buffer.alloc(RETENTION_SMALL_FILE_BYTES, 32));
  }
  put('stages/done/evidence/last.md', '`../build/attempt_1/corpus.bin`');
  expect(removed()).toContain('stages/done/build/attempt_1/corpus.bin');
  rmSync(join(run, 'stages/done/evidence/00.md'));
  expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
});


it.each(['running', 'closed'] as const)('R55 protects complete stage with stale %s attempt while cleaning other stages', status => {
  state.stages.done.attempts = [{ index: 1, startedAt: state.startedAt, status }];
  persist(); put('stages/later/build/disposable.bin');
  expect(removed()).toEqual(['stages/later/build/disposable.bin']);
});

it('R56 invocation scratch Markdown cannot pin settled stage work', () => {
  put('scratch/report.md', '`stages/done/build/attempt_1/corpus.bin`');
  expect(removed()).toContain('stages/done/build/attempt_1/corpus.bin');
  expect(removed()).toContain('scratch/report.md');
});

it('R57 unfinished work area Markdown also needs a recorded incoming citation', () => {
  state.stages.later.status = 'failed'; persist();
  put('stages/later/build/README.md', '`stages/done/build/attempt_1/corpus.bin`');
  expect(removed()).toContain('stages/done/build/attempt_1/corpus.bin');
});

it('R58 incidental links and private filenames cannot bypass workspace size bounds', () => {
  put('stages/done/build/big.bin', Buffer.alloc(RETENTION_FILE_BYTES + 1));
  put('stages/done/build/tokens.fixture', Buffer.alloc(RETENTION_FILE_BYTES + 1));
  symlinkSync('big.bin', join(run, 'stages/done/build/link'));
  expect(removed()).toContain('stages/done/build/big.bin');
  expect(removed()).toContain('stages/done/build/tokens.fixture');
  expect(removed()).not.toContain('stages/done/build/link');
});


it('R59 workspace-root citations, incidental archives/logs/Markdown and root scripts do not pin work', () => {
  put('stages/done/build/report.md', 'incidental');
  put('stages/done/build/replay.log', 'incidental');
  put('stages/done/build/source.tar.gz', 'incidental');
  put('stages/done/build/driver.py', 'incidental');
  put('stages/done/output.md', '`build/`; driver.py helped produce the results.');
  const removal = removed();
  for (const path of ['report.md', 'replay.log', 'source.tar.gz', 'driver.py', 'attempt_1/corpus.bin']) {
    expect(removal).toContain(`stages/done/build/${path}`);
  }
});


it('R60 incidental workspace symlinks preserve targets without admitting Markdown as citation sources', () => {
  put('stages/done/build/corpus/README.md', '`../attempt_1/corpus.bin`');
  symlinkSync('corpus/README.md', join(run, 'stages/done/build/readme'));
  expect(removed()).toContain('stages/done/build/attempt_1/corpus.bin');
  expect(removed()).not.toContain('stages/done/build/corpus/README.md');
  put('stages/done/output.md', '[recorded evidence](build/corpus/README.md)');
  expect(removed()).not.toContain('stages/done/build/attempt_1/corpus.bin');
});


it('R61 retains admitted citation sources before their payloads so bounded apply is idempotent', () => {
  for (let index = 0; index < 4; index++) {
    put(`stages/done/build/evidence/${index}.bin`, Buffer.alloc(index === 3 ? RETENTION_FILE_BYTES - 512 * 1024 : RETENTION_FILE_BYTES));
  }
  put('stages/done/build/z.md', '`zz.bin`' + ' '.repeat(RETENTION_SMALL_FILE_BYTES - 8));
  put('stages/done/build/zz.bin', Buffer.alloc(1024));
  put('stages/done/output.md', '[source](build/z.md)');
  const result = pruneRunWorkAreas(run);
  expect(result.remove.map(item => item.path)).not.toContain('stages/done/build/z.md');
  expect(existsSync(join(run, 'stages/done/build/zz.bin'))).toBe(true);
  expect(plan().removeBytes).toBe(0);
});


it('R62 retains link references before bounded targets so later apply does not lose their reason', () => {
  for (let index = 0; index < 4; index++) {
    put(`stages/done/build/evidence/${index}.bin`, Buffer.alloc(index === 3 ? RETENTION_FILE_BYTES - 2 : RETENTION_FILE_BYTES));
  }
  put('stages/done/build/a.bin', 'x');
  symlinkSync('a.bin', join(run, 'stages/done/build/z-link'));
  pruneRunWorkAreas(run);
  expect(existsSync(join(run, 'stages/done/build/z-link'))).toBe(true);
  expect(readFileSync(join(run, 'stages/done/build/a.bin'), 'utf8')).toBe('x');
  expect(plan().removeBytes).toBe(0);
});


it('R63 durable outside-work links preserve targets without making workspace Markdown a citation source', () => {
  put('stages/done/build/corpus/README.md', '`../attempt_1/corpus.bin`');
  mkdirSync(join(run, 'handoff'));
  symlinkSync('../stages/done/build/corpus/README.md', join(run, 'handoff/readme'));
  expect(removed()).not.toContain('stages/done/build/corpus/README.md');
  expect(removed()).toContain('stages/done/build/attempt_1/corpus.bin');
});
