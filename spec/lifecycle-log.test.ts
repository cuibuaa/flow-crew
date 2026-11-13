import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LIFECYCLE_AUTHORITY, hasLifecycleAuthority } from '../src/run-lifecycle-authority.js';
import { foldRunLifecycle } from '../src/run-lifecycle-fold.js';
import { projectRunLifecycle, recordRunLifecycle } from '../src/run-lifecycle.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { appendDurableTextRecord, appendTextRecord } from '../src/append-boundary.js';
import { recordRunEvent, readRunEvents } from '../src/run-events.js';
import { runRecordPath } from '../src/run-layout.js';
import { RUN_STATUS, fcGlobalDir, initializeReservedRun, reserveRun, readRunState, readArchivedRunState, readOperationalRunState, setFcGlobalDir, updateRunState, updateOperationalRunState, updateStageStatusUnderRunLock, withRunStateLock, writeRunState, importRunLifecycleForResume } from '../src/store.js';
import { assertContinuationCompatible, recordContinuationRefusal } from '../src/engine-continuation.js';
import { RunCancellationCoordinator } from '../src/run-control.js';
import { TaskRegistry } from '../src/task-registry.js';
import { cancelRunStateAtPath } from '../src/scheduler/sched_policy/run-completion.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { WorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { stringify } from 'yaml';

vi.hoisted(() => vi.resetModules());
const io = vi.hoisted(() => ({ target: '', fail: '' as 'append' | 'file-sync' | 'directory-sync' | '', short: false,
  calls: [] as string[], descriptors: new Map<number, string>() }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args); io.descriptors.set(fd, String(args[0])); return fd;
    }) as typeof actual.openSync,
    closeSync: (fd: number) => { io.descriptors.delete(fd); return actual.closeSync(fd); },
    writeSync: ((fd: number, bytes: Uint8Array, offset: number, length: number) => {
      if (io.descriptors.get(fd) === io.target) {
        io.calls.push('append');
        if (io.fail === 'append') throw new Error('injected append failure');
        if (io.short) length = Math.min(length, 7);
      }
      return actual.writeSync(fd, bytes, offset, length);
    }) as typeof actual.writeSync,
    fsyncSync: (fd: number) => {
      const path = io.descriptors.get(fd);
      const kind = path === io.target ? 'file-sync' : path === dirname(io.target) ? 'directory-sync' : undefined;
      if (kind) {
        io.calls.push(kind);
        if (io.fail === kind) throw new Error(`injected ${kind} failure`);
      }
      return actual.fsyncSync(fd);
    },
  };
});

let root: string, project: string, directory: string, runId: string, previous: string;
function bytes(name: string): string { try { return readFileSync(runRecordPath(directory, name), 'utf8'); } catch { return ''; } }
function cached() { return JSON.parse(bytes('run.json')); }
function corruptCaches(status: unknown = 'future-cache-value') {
  const state = cached(); state.status = status; state.lifecycleCursor = { status: 'cancelled', sequence: 998 };
  writeFileSync(join(directory, 'run.json'), JSON.stringify(state));
  writeFileSync(runRecordPath(directory, 'run_event_status.json'), JSON.stringify({ status: 'complete', sequence: 999 }));
}
function assertCaches() {
  const fold = foldRunLifecycle(bytes('events.jsonl'))!;
  expect(cached()).toMatchObject({ status: fold.status, lifecycleCursor: fold });
  expect(JSON.parse(bytes('run_event_status.json'))).toEqual(fold);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lifecycle-log-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  const reserved = reserveRun(project);
  ({ runId, runDirPath: directory } = initializeReservedRun(project, reserved.runId, 'fixture', 'name: fixture\nstages: []\n', ['work'], createBriefAdmission(inspectBrief(''), { kind: 'not_required' })));
  io.target = join(directory, 'events.jsonl'); io.calls = []; io.fail = ''; io.short = false;
});
afterEach(() => { io.fail = ''; io.target = ''; setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

function event(status: string, extra: object = {}) {
  return JSON.stringify({ type: 'run_status_changed', lifecycleVersion: 1, timestamp: '2030-01-01T00:00:00.000Z', runStatus: status, ...extra });
}
describe('bytes-only lifecycle fold and recorded authority', () => {
  it('uses append order and closed version/status values; ignores prose, notices, malformed rows and torn final bytes', () => {
    const bytes = [event('running'), event('failed', { timestamp: '2000-01-01T00:00:00.000Z' }),
      event('complete', { type: 'run_completed' }), event('cancelled', { lifecycleVersion: 2 }),
      event('future-state'), '{broken', event('parked', { lifecycleVersion: undefined }),
      event('shipped', { detail: 'incomplete', timestamp: '1999-01-01T00:00:00.000Z' })].join('\n') + '\n' + event('complete').slice(0, -4);
    expect(foldRunLifecycle(Buffer.from(bytes))).toEqual({ version: 2, sequence: 3, status: 'shipped', observedAt: '1999-01-01T00:00:00.000Z' });
    expect(foldRunLifecycle('')).toBeUndefined();
    expect(foldRunLifecycle(event('running'))?.status).toBe('running');
    const prefixed = '\ufeff' + event('running') + '\n';
    expect(foldRunLifecycle(Buffer.from(prefixed))).toEqual(foldRunLifecycle(prefixed));
  });
  it('records the exact declaration at admission and selects authority only from that value', () => {
    expect(cached().lifecycleAuthority).toBe(LIFECYCLE_AUTHORITY);
    expect(hasLifecycleAuthority({})).toBe(false);
    expect(hasLifecycleAuthority(Object.create({ lifecycleAuthority: LIFECYCLE_AUTHORITY }))).toBe(false);
    expect(() => hasLifecycleAuthority({ lifecycleAuthority: 'events exist' })).toThrow('Unsupported');
    expect(() => projectRunLifecycle(directory, { lifecycleAuthority: LIFECYCLE_AUTHORITY, status: 'complete' }, () => '')).toThrow('no complete lifecycle');
    const read = vi.fn(() => { throw new Error('legacy reader must not read the log'); });
    expect(projectRunLifecycle(directory, { status: 'stopped' }, read).status).toBe('cancelled');
    expect(read).not.toHaveBeenCalled();
  });
  it('reads fold despite corrupt snapshot/cursor, without changing bytes or timestamps', () => {
    corruptCaches();
    const paths = ['run.json', 'events.jsonl', 'run_event_status.json'].map(name => runRecordPath(directory, name));
    const before = paths.map(path => [readFileSync(path), statSync(path).mtimeMs]);
    expect(readRunState(project, runId).status).toBe('running');
    expect(readArchivedRunState(project, runId).state.status).toBe('running');
    expect(readOperationalRunState(project, runId).status).toBe('running');
    expect(paths.map(path => [readFileSync(path), statSync(path).mtimeMs])).toEqual(before);
  });
  it.each(['lock', 'snapshot', 'mutation', 'operational', 'stage-early-return', 'recovery-early-return', 'resume-early-return'])('reconciles on the next %s writer without an event from any cache', writer => {
    if (writer === 'resume-early-return') {
      const brief = `---\nresearch: ${JSON.stringify({ protocol: 'research-instrument/v1', candidate: ['src'], frozen: ['instrument'], argv: [process.execPath], environment: {}, author: { role: 'coder', instruction: 'Fixture.' }, budget: { max_rounds: 1 } })}\n---\n`;
      const reservation = reserveRun(project);
      ({ runId, runDirPath: directory } = initializeReservedRun(project, reservation.runId, 'fixture', 'name: fixture\nstages: []\n', ['work'], createBriefAdmission(inspectBrief(brief), { kind: 'not_required' })));
      io.target = join(directory, 'events.jsonl');
    }
    if (writer.endsWith('early-return') && writer !== 'stage-early-return') updateRunState(project, runId, state => { state.status = 'complete'; });
    const snapshot = readRunState(project, runId);
    corruptCaches(); const log = bytes('events.jsonl');
    if (writer === 'lock') withRunStateLock(directory, () => {});
    if (writer === 'snapshot') writeRunState(project, runId, snapshot);
    if (writer === 'mutation') updateRunState(project, runId, () => {});
    if (writer === 'operational') updateOperationalRunState(directory, () => {});
    if (writer === 'stage-early-return') {
      mkdirSync(runRecordPath(directory, 'stages', 'work'), { recursive: true });
      writeFileSync(runRecordPath(directory, 'stages', 'work', 'status.json'), JSON.stringify({ status: 'pending', retries: 0 }));
      updateStageStatusUnderRunLock(project, runId, 'work', () => undefined);
    }
    if (writer === 'recovery-early-return') reconcileHostInterruptedRun(project, runId);
    if (writer === 'resume-early-return') {
      const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'worker' }] });
      // The research terminal route returns before dispatch or scheduler claims.
      prepareWorkflowLaunch(workflow, stringify(workflow), project, runId);
    }
    assertCaches(); expect(bytes('events.jsonl')).toBe(log);
  });
  it('does not let an older whole snapshot reverse a newer lifecycle decision', () => {
    const stale = readRunState(project, runId);
    updateRunState(project, runId, state => { state.status = 'parked'; });
    stale.taskDescription = 'metadata from a stale caller';
    writeRunState(project, runId, stale);
    expect(readRunState(project, runId).status).toBe('parked');
    expect(readRunEvents(project, runId).filter(row => row.type === 'run_status_changed').map(row => row.runStatus)).toEqual(['running', 'parked']);
  });
  it('rejects lifecycle events through the unflushed general event API', () => {
    expect(() => recordRunEvent(project, runId, { type: 'run_status_changed', runId, timestamp: '', runStatus: 'complete' })).toThrow('durable publication boundary');
  });
});

describe('lifecycle durability and failure retry', () => {
  it('flushes the file and its parent on first creation, loops short writes, and keeps high-volume appends unflushed', () => {
    const path = join(root, 'fresh.jsonl'); io.target = path; io.short = true;
    appendDurableTextRecord(path, event('running'));
    expect(readFileSync(path, 'utf8')).toBe(event('running') + '\n');
    expect(io.calls.slice(-2)).toEqual(['file-sync', 'directory-sync']);
    expect(io.calls.filter(call => call === 'append').length).toBeGreaterThan(1);
    io.calls = []; appendTextRecord(path, 'ordinary');
    expect(io.calls).not.toContain('file-sync'); expect(io.calls).not.toContain('directory-sync');
  });
  it.each(['append', 'file-sync', 'directory-sync'] as const)('does not publish either cache when %s fails, then retries from the log', failure => {
    const before = [bytes('run.json'), bytes('run_event_status.json')];
    io.fail = failure;
    expect(() => updateRunState(project, runId, state => { state.status = 'failed'; })).toThrow(`injected ${failure} failure`);
    expect([bytes('run.json'), bytes('run_event_status.json')]).toEqual(before);
    const expected = failure === 'append' ? 'running' : 'failed';
    expect(readRunState(project, runId).status).toBe(expected);
    io.fail = ''; updateRunState(project, runId, state => { state.status = 'failed'; });
    assertCaches();
    expect(readRunEvents(project, runId).filter(row => row.type === 'run_status_changed' && row.runStatus === 'failed')).toHaveLength(1);
  });
  it.each(['append', 'file-sync', 'directory-sync'] as const)('keeps first admission readable and repairable after %s failure', failure => {
    const reserved = reserveRun(project);
    io.target = join(reserved.runDirPath, 'events.jsonl'); io.fail = failure;
    expect(() => initializeReservedRun(project, reserved.runId, 'fixture', 'name: fixture', [], createBriefAdmission(inspectBrief(''), { kind: 'not_required' }))).toThrow('injected');
    expect(existsSync(join(reserved.runDirPath, 'run.json'))).toBe(false);
    io.fail = '';
    if (failure === 'append') {
      expect(() => readRunState(project, reserved.runId)).toThrow('no complete lifecycle');
      initializeReservedRun(project, reserved.runId, 'fixture', 'name: fixture', [], createBriefAdmission(inspectBrief(''), { kind: 'not_required' }));
    } else {
      expect(readRunState(project, reserved.runId).status).toBe('running');
      withRunStateLock(reserved.runDirPath, () => {});
    }
    const record = JSON.parse(readFileSync(join(reserved.runDirPath, 'run.json'), 'utf8'));
    const folded = foldRunLifecycle(readFileSync(io.target));
    expect(record).toMatchObject({ lifecycleAuthority: LIFECYCLE_AUTHORITY, status: folded?.status, lifecycleCursor: folded });
    expect(JSON.parse(readFileSync(runRecordPath(reserved.runDirPath, 'run_event_status.json'), 'utf8'))).toEqual(folded);
  });
  it('opens cancellation under the run lock when the initial log exists before the first snapshot', () => {
    const reserved = reserveRun(project);
    io.target = join(reserved.runDirPath, 'events.jsonl'); io.fail = 'file-sync';
    expect(() => initializeReservedRun(project, reserved.runId, 'fixture', 'name: fixture', [], createBriefAdmission(inspectBrief(''), { kind: 'not_required' }))).toThrow('injected');
    expect(existsSync(join(reserved.runDirPath, 'run.json'))).toBe(false);
    io.fail = '';
    expect(cancelRunStateAtPath(reserved.runDirPath, '2030-01-01T00:00:00.000Z').state.status).toBe('cancelled');
    const folded = foldRunLifecycle(readFileSync(io.target));
    const record = JSON.parse(readFileSync(join(reserved.runDirPath, 'run.json'), 'utf8'));
    expect(record).toMatchObject({ status: folded?.status, lifecycleCursor: folded });
    expect(JSON.parse(readFileSync(runRecordPath(reserved.runDirPath, 'run_event_status.json'), 'utf8'))).toEqual(folded);
  });
  it('cancels through the public coordinator after the first event but before the first snapshot', async () => {
    const reserved = reserveRun(project);
    io.target = join(reserved.runDirPath, 'events.jsonl'); io.fail = 'file-sync';
    expect(() => initializeReservedRun(project, reserved.runId, 'fixture', 'name: fixture', [], createBriefAdmission(inspectBrief(''), { kind: 'not_required' }))).toThrow('injected');
    expect(existsSync(join(reserved.runDirPath, 'run.json'))).toBe(false);
    io.fail = '';
    const control = new RunCancellationCoordinator({
      registry: new TaskRegistry({ baseDir: join(root, 'registry') }),
      units: { isActive: async () => ({ kind: 'absent' }), stopUnit: async () => {} } as never,
      runsDir: join(root, 'fc', 'runs'), timeoutMs: 0, signalGraceMs: 0,
      now: () => new Date('2030-01-01T00:00:00.000Z'), clockMs: () => 0,
    });
    await expect(Promise.resolve().then(() => control.cancelRun(reserved.runId))).resolves.toMatchObject({
      ok: true, status: 'cancelled', observation: { runReadable: true },
    });
    expect(readRunState(project, reserved.runId).status).toBe('cancelled');
    expect(JSON.parse(readFileSync(join(reserved.runDirPath, 'run.json'), 'utf8')).lifecycleCursor)
      .toEqual(foldRunLifecycle(readFileSync(io.target)));
  });
  it('retains a torn append as evidence and records the next complete decision on a separate line', () => {
    appendFileSync(join(directory, 'events.jsonl'), '{"type":"run_status_changed","lifecycleVersion":1');
    updateRunState(project, runId, state => { state.status = 'parked'; });
    expect(readRunState(project, runId).status).toBe('parked'); assertCaches();
    expect(bytes('events.jsonl')).toContain('"lifecycleVersion":1\n');
  });
});

describe('integrity restoration keeps lifecycle caches subordinate to the log', () => {
  it('restores metadata from its preimage but folds a leading durable decision before writing status', async () => {
    const previous = readRunState(project, runId);
    withRunStateLock(directory, () => recordRunLifecycle(directory, { ...previous, status: 'failed' }, previous));
    expect(cached().status).toBe('running');
    const log = bytes('events.jsonl');
    await expect(withEngineIntegrity({ projectDir: project, runDir: directory, stageId: 'work' }, async () => {
      writeFileSync(join(directory, 'run.json'), JSON.stringify({ ...cached(), status: 'complete' }));
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(bytes('events.jsonl')).toBe(log);
    expect(cached().status).toBe('failed'); assertCaches();
  });
  it('restores and flushes a damaged log before restoring either lifecycle cache', async () => {
    const log = bytes('events.jsonl');
    await expect(withEngineIntegrity({ projectDir: project, runDir: directory, stageId: 'work' }, async () => {
      appendFileSync(join(directory, 'events.jsonl'), event('complete') + '\n');
      writeFileSync(join(directory, 'run.json'), JSON.stringify({ ...cached(), status: 'complete' }));
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(bytes('events.jsonl')).toBe(log);
    expect(cached().status).toBe('running'); assertCaches();
  });
});

describe('explicit legacy exception and one-time import', () => {
  function legacy(status: unknown) {
    const state = cached(); delete state.lifecycleAuthority; delete state.lifecycleCursor;
    state.status = status; writeFileSync(join(directory, 'run.json'), JSON.stringify(state));
  }
  it('characterizes identical event bytes with different stored lifecycle displays, including unknown and stopped', () => {
    const log = bytes('events.jsonl');
    for (const [stored, displayed] of [['parked', 'parked'], ['failed', 'failed'], ['stopped', 'cancelled'], ['unknown-future', 'unknown-future']]) {
      legacy(stored); const before = bytes('run.json'), cursor = bytes('run_event_status.json');
      expect(readArchivedRunState(project, runId).state.status).toBe(displayed);
      expect(readRunState(project, runId).status).toBe(displayed);
      expect(bytes('run.json')).toBe(before); expect(bytes('run_event_status.json')).toBe(cursor); expect(bytes('events.jsonl')).toBe(log);
    }
  });
  it.each(['file-sync', 'directory-sync'] as const)('imports once after interrupted %s, with snapshot provenance and declaration after durability', failure => {
    legacy('parked'); const snapshot = bytes('run.json'); io.fail = failure;
    expect(() => importRunLifecycleForResume(project, runId)).toThrow('injected');
    expect(bytes('run.json')).toBe(snapshot);
    io.fail = ''; importRunLifecycleForResume(project, runId); importRunLifecycleForResume(project, runId);
    expect(readRunEvents(project, runId).filter(row => row.type === 'run_status_imported')).toEqual([
      expect.objectContaining({ runStatus: 'parked', snapshotSource: 'run.json', lifecycleVersion: 1 }),
    ]);
    expect(cached().lifecycleAuthority).toBe(LIFECYCLE_AUTHORITY); assertCaches();
    corruptCaches('complete'); expect(readRunState(project, runId).status).toBe('parked');
  });
  it('refuses authority adoption by an operational mutation without the resume import', () => {
    legacy('parked'); const snapshot = bytes('run.json'), log = bytes('events.jsonl');
    expect(() => updateOperationalRunState(directory, state => {
      state.lifecycleAuthority = LIFECYCLE_AUTHORITY;
    })).toThrow('resume import');
    expect(bytes('run.json')).toBe(snapshot); expect(bytes('events.jsonl')).toBe(log);
  });
  it('imports on accepted resume and never imports again on repeated resume', () => {
    legacy('parked');
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 2 },
      stages: [{ id: 'work', role: 'worker', artifact_contract: { version: 1, produces: [], reads: [] } }] });
    writeFileSync(runRecordPath(directory, 'workflow.yaml'), stringify(workflow));
    expect(prepareWorkflowLaunch(workflow, stringify(workflow), project, runId).kind).toBe('ready');
    prepareWorkflowLaunch(workflow, stringify(workflow), project, runId);
    expect(readRunEvents(project, runId).filter(row => row.type === 'run_status_imported')).toEqual([
      expect.objectContaining({ runStatus: 'parked', snapshotSource: 'run.json' }),
    ]);
    expect(readRunState(project, runId).status).toBe('running'); assertCaches();
  });
  it('imports a legacy running snapshot before resume performs host-recovery transitions', () => {
    legacy('running');
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 2 },
      stages: [{ id: 'work', role: 'worker', artifact_contract: { version: 1, produces: [], reads: [] } }] });
    writeFileSync(runRecordPath(directory, 'workflow.yaml'), stringify(workflow));
    updateRunState(project, runId, state => { state.engineCheckpoint = {
      version: 2, runId, projectDir: project, pid: 1, bootId: 'previous-boot', at: '2030-01-01T00:00:00.000Z', processes: [],
    }; });
    writeFileSync(join(directory, 'events.jsonl'), JSON.stringify({ type: 'run_completed', runId, runStatus: 'failed' }) + '\n');
    expect(prepareWorkflowLaunch(workflow, stringify(workflow), project, runId).kind).toBe('ready');
    const events = readRunEvents(project, runId);
    expect(events.slice(1).map(row => row.type)).toEqual(['run_status_imported', 'run_status_changed', 'recovery_reconciled', 'run_status_changed']);
    expect(events[1]).toMatchObject({ runStatus: 'running', snapshotSource: 'run.json', snapshotStatus: 'running' });
    expect(events.slice(2).filter(row => row.type === 'run_status_changed').map(row => row.runStatus)).toEqual(['parked', 'running']);
    assertCaches();
  });
  it('recognizes a complete import JSON row before its final newline, rather than importing twice', () => {
    legacy('failed');
    appendFileSync(join(directory, 'events.jsonl'), event('parked', { type: 'run_status_imported', runId, snapshotSource: 'run.json' }));
    importRunLifecycleForResume(project, runId);
    expect(readRunState(project, runId).status).toBe('parked');
    expect(readRunEvents(project, runId).filter(row => row.type === 'run_status_imported')).toHaveLength(1);
    assertCaches();
  });
  it.each([true, false])('refuses cancelled continuation without opening it for writing (declared: %s)', declared => {
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'worker' }] });
    writeFileSync(runRecordPath(directory, 'workflow.yaml'), stringify(workflow));
    updateRunState(project, runId, state => { state.status = 'cancelled'; });
    const snapshot = cached(); snapshot.status = 'stopped';
    snapshot.stages.work = { status: 'running', retries: 0, attempts: [] };
    if (!declared) { delete snapshot.lifecycleAuthority; delete snapshot.lifecycleCursor; }
    writeFileSync(join(directory, 'run.json'), JSON.stringify(snapshot));
    const paths = ['run.json', 'events.jsonl', 'run_event_status.json'];
    const before = paths.map(name => bytes(name));
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(() => assertContinuationCompatible(project, runId)).toThrow('unsettled attempt');
      expect(paths.map(name => bytes(name))).toEqual(before);
    }
  });
  it('preserves unknown-status and unsupported-layout resume refusals without importing', () => {
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{ id: 'work', role: 'worker' }] });
    legacy('unknown-future');
    const unknownBefore = bytes('run.json');
    expect(() => prepareWorkflowLaunch(workflow, stringify(workflow), project, runId)).toThrow('Unrecognized archived run status');
    recordContinuationRefusal(project, runId, 'unsupported status');
    expect(bytes('run.json')).toBe(unknownBefore);
    legacy('parked');
    const state = cached(); delete state.storageLayout;
    writeFileSync(join(directory, 'run.json'), JSON.stringify(state));
    // An already-loaded layout is cached; use a fresh alias to exercise routing.
    const freshDirectory = join(root, 'fc', 'runs', 'legacy-flat'); mkdirSync(freshDirectory);
    writeFileSync(join(freshDirectory, 'run.json'), JSON.stringify({ ...state, runId: 'legacy-flat' }));
    const flatBefore = readFileSync(join(freshDirectory, 'run.json'), 'utf8');
    expect(() => prepareWorkflowLaunch(workflow, stringify(workflow), project, 'legacy-flat')).toThrow('RUN_LAYOUT_INCOMPATIBLE');
    recordContinuationRefusal(project, 'legacy-flat', 'unsupported layout');
    expect(readFileSync(join(freshDirectory, 'run.json'), 'utf8')).toBe(flatBefore);
    expect(readRunEvents(project, runId).some(row => row.type === 'run_status_imported')).toBe(false);
  });
});
