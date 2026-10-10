import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonReconciler } from '../src/daemon-reconciliation.js';
import { Orchestrator, type SupervisorBackend } from '../src/orchestrator.js';
import { TaskRegistry } from '../src/task-registry.js';
import * as recovery from '../src/restart-recovery.js';
import * as runLock from '../src/run-lock.js';
import { beginStageAttempt, createRun, fcGlobalDir, readRunState, runsRoot, setFcGlobalDir, updateRunState, writeStageStatus } from '../src/store.js';
import { listRunningRunIdsFromIndex, removeRunIndexFiles } from '../src/run-index.js';

let root: string, project: string, previousStore: string, registry: TaskRegistry;
const noUnits: SupervisorBackend = {
  async runUnit() { throw new Error('unexpected launch'); }, async isActive() { throw new Error('unexpected probe'); },
  async stopUnit() { throw new Error('unexpected stop'); }, async journalTail() { return ''; },
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-reconciliation-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  registry = new TaskRegistry({ baseDir: join(root, 'registry') });
  vi.spyOn(recovery, 'readHostBootId').mockReturnValue('current-boot');
  vi.spyOn(recovery, 'engineGeneration').mockReturnValue('fixture-generation');
  vi.spyOn(runLock, 'inspectRunScheduler').mockReturnValue({ kind: 'missing' });
});
afterEach(() => { removeRunIndexFiles(project); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });
function orphan() {
  const id = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']).runId;
  writeStageStatus(project, id, 'work', { status: 'pending', retries: 0 });
  beginStageAttempt(project, id, 'work', 0, '2026-01-01T00:00:00.000Z');
  updateRunState(project, id, state => {
    state.engineCheckpoint = { version: 1, runId: id, projectDir: project, bootId: 'previous-boot', generation: 'fixture-generation', pid: 2147483647, at: '2026-01-01T00:00:00.000Z' };
    state.currentIteration = 2; state.maxIterations = 3; state.maxRetries = 4;
  });
  return id;
}

describe('daemon-owned previous-boot orphan recovery', () => {
  it('leaves default constructors/ticks read-only, then retains interrupted work under daemon ownership', async () => {
    const id = orphan();
    await new Orchestrator({ registry, systemd: noUnits, git: {} as never }).tickOnce();
    expect(readRunState(project, id).status).toBe('running');
    const warn = vi.fn();
    await new Orchestrator({ registry, systemd: noUnits, git: {} as never, reconcileOrphanRuns: createDaemonReconciler(registry, warn) }).tickOnce();
    expect(readRunState(project, id)).toMatchObject({ status: 'parked', currentIteration: 2, maxIterations: 3, maxRetries: 4,
      recovery: { kind: 'resumable' }, recoveryIntent: { phase: 'committed' }, stages: { work: { status: 'pending', retries: 0 } } });
    expect(readRunState(project, id).stages.work.attempts!.at(-1)).toMatchObject({ status: 'failed', exitCode: 143, tokenUsage: 'unknown' });
    expect(readFileSync(join(runsRoot(), id, 'events.jsonl'), 'utf8')).toContain('recovery_reconciled');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['live', 'corrupt', 'unverifiable', 'same-boot', 'unknown-boot', 'legacy', 'bound', 'unknown-task-status', 'unreadable-binding', 'damaged-registry'])('retains %s records without inferring interruption', kind => {
    const id = orphan();
    if (kind === 'live') vi.mocked(runLock.inspectRunScheduler).mockReturnValue({ kind: 'live', pid: 10 });
    if (kind === 'corrupt') vi.mocked(runLock.inspectRunScheduler).mockReturnValue({ kind: 'corrupt', detail: 'invalid' });
    if (kind === 'unverifiable') vi.mocked(runLock.inspectRunScheduler).mockReturnValue({ kind: 'unverifiable', detail: 'unknown', pid: 10 });
    if (kind === 'same-boot') updateRunState(project, id, state => { state.engineCheckpoint!.bootId = 'current-boot'; });
    if (kind === 'unknown-boot') vi.mocked(recovery.readHostBootId).mockReturnValue(undefined);
    if (kind === 'legacy') updateRunState(project, id, state => { delete state.engineCheckpoint; });
    if (kind === 'bound') registry.create({ projectDir: project, brief_text: 'task', status: 'running', run_id: id });
    if (kind === 'unknown-task-status') writeFileSync(registry.registryPath, JSON.stringify({ id: 1, status: 'future-state', run_id: id }) + '\n');
    if (kind === 'unreadable-binding') registry.create({ projectDir: project, brief_text: 'task', status: 'running', run_id: 'unreadable' });
    if (kind === 'damaged-registry') appendFileSync(registry.registryPath, '{bad}\n');
    const bytes = readFileSync(join(runsRoot(), id, 'run.json'), 'utf8');
    const ledger = readFileSync(join(runsRoot(), id, 'stages/work/status.json'), 'utf8');
    createDaemonReconciler(registry, vi.fn())();
    if (['same-boot', 'unknown-boot', 'legacy'].includes(kind)) {
      expect(readRunState(project, id)).toMatchObject({ status: 'failed', recovery: { kind: 'blocked' } });
      expect(readRunState(project, id).failureReason).toMatch(/RECOVERY_FATE_UNKNOWN|RECOVERY_CHECKPOINT_MISSING/);
      expect(readFileSync(join(runsRoot(), id, 'stages/work/status.json'), 'utf8')).toBe(ledger);
    } else expect(readFileSync(join(runsRoot(), id, 'run.json'), 'utf8')).toBe(bytes);
  });

  it.each(['generation', 'plan', 'attempt'])('keeps %s refusal in the authoritative recovery mechanism', kind => {
    const id = orphan();
    if (kind === 'generation') vi.mocked(recovery.engineGeneration).mockReturnValue('different-generation');
    if (kind === 'plan') updateRunState(project, id, state => { state.planControl = { version: 1, stages: [], capabilities: [] }; });
    if (kind === 'attempt') writeFileSync(join(runsRoot(), id, 'stages/work/status.json'), JSON.stringify({ status: 'pending', retries: 0 }));
    const ledger = readFileSync(join(runsRoot(), id, 'stages/work/status.json'), 'utf8');
    createDaemonReconciler(registry, vi.fn())();
    expect(readRunState(project, id).recovery?.kind).toBe('blocked');
    expect(readFileSync(join(runsRoot(), id, 'stages/work/status.json'), 'utf8')).toBe(ledger);
  });

  it('discovers an externally restored carrier inside the index seed TTL', () => {
    expect(listRunningRunIdsFromIndex(project)).toEqual([]);
    const id = 'restored-run';
    const directory = join(runsRoot(), id); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'run.json'), JSON.stringify({
      runId: id, projectDir: project, status: 'running', workflowName: 'fixture', startedAt: '2026-01-01T00:00:00.000Z', stages: {},
      engineCheckpoint: { version: 1, runId: id, projectDir: project, bootId: 'previous-boot',
        generation: 'fixture-generation', pid: 2147483647, at: '2026-01-01T00:00:00.000Z' },
    }));
    createDaemonReconciler(registry, vi.fn())();
    expect(readRunState(project, id).status).toBe('parked');
  });

  it('bounds carrier hydration per tick and reaches every remaining orphan', () => {
    for (let i = 0; i < 35; i++) {
      const id = `orphan-${String(i).padStart(2, '0')}`;
      const directory = join(runsRoot(), id); mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'run.json'), JSON.stringify({
        runId: id, projectDir: project, status: 'running', workflowName: 'fixture', startedAt: '2026-01-01T00:00:00.000Z', stages: {},
        engineCheckpoint: { version: 1, runId: id, projectDir: project, bootId: 'previous-boot',
          generation: 'fixture-generation', pid: 2147483647, at: '2026-01-01T00:00:00.000Z' },
      }));
    }
    const sweep = createDaemonReconciler(registry, vi.fn());
    sweep(); expect(listRunningRunIdsFromIndex(project)).toHaveLength(3);
    sweep(); expect(listRunningRunIdsFromIndex(project)).toHaveLength(0);
  });

  it('reobserves scheduler ownership under the publication lock', () => {
    const id = orphan();
    const bytes = readFileSync(join(runsRoot(), id, 'run.json'), 'utf8');
    const ledger = readFileSync(join(runsRoot(), id, 'stages/work/status.json'), 'utf8');
    vi.mocked(runLock.inspectRunScheduler).mockReturnValueOnce({ kind: 'missing' }).mockReturnValue({ kind: 'live', pid: 10 });
    const warn = vi.fn(); createDaemonReconciler(registry, warn)();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RECOVERY_FATE_CHANGED'));
    expect(readFileSync(join(runsRoot(), id, 'run.json'), 'utf8')).toBe(bytes);
    expect(readFileSync(join(runsRoot(), id, 'stages/work/status.json'), 'utf8')).toBe(ledger);
  });

  it('fences a checkpoint that changed between observation and recovery', () => {
    const id = orphan(), old = readRunState(project, id).engineCheckpoint!;
    updateRunState(project, id, state => { state.engineCheckpoint!.bootId = 'current-boot'; });
    const bytes = readFileSync(join(runsRoot(), id, 'run.json'), 'utf8');
    expect(() => recovery.reconcileHostInterruptedRun(project, id, { currentBootId: 'current-boot', currentGeneration: 'fixture-generation', expectedCheckpoint: old })).toThrow('RECOVERY_STATE_CHANGED');
    expect(readFileSync(join(runsRoot(), id, 'run.json'), 'utf8')).toBe(bytes);
  });

  it.each(['binding', 'corruption'])('vetoes external %s after the discovery snapshot', kind => {
    const id = orphan();
    const before = readFileSync(join(runsRoot(), id, 'run.json'), 'utf8');
    const list = registry.list.bind(registry);
    vi.spyOn(registry, 'list').mockImplementationOnce(filter => {
      const snapshot = list(filter);
      if (kind === 'binding') new TaskRegistry({ baseDir: registry.baseDir }).create({
        projectDir: project, brief_text: 'task', status: 'running', run_id: id,
      });
      else appendFileSync(registry.registryPath, '{bad}\n');
      return snapshot;
    });
    const warn = vi.fn(); createDaemonReconciler(registry, warn)();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RECOVERY_REGISTRY_'));
    expect(readFileSync(join(runsRoot(), id, 'run.json'), 'utf8')).toBe(before);
  });

  for (const publication of [1, 2, 3, 4]) {
    it.each(['binding', 'corruption', 'unknown-status', 'unreadable-binding', 'lock-replaced'])(
      `vetoes %s at recovery publication ${publication}`, kind => {
        const id = orphan();
        const events = JSON.stringify({ type: 'stage_started', runId: id, stageId: 'work' }) + '\n';
        writeFileSync(join(runsRoot(), id, 'events.jsonl'), events);
        const task = registry.create({ projectDir: project, brief_text: 'task', status: 'done' });
        const guarded = registry.withUnboundRun.bind(registry);
        let checks = 0, runBefore = '', ledgerBefore = '';
        vi.spyOn(registry, 'withUnboundRun').mockImplementation((runId, resolveBinding, recover) => {
          guarded(runId, resolveBinding, assertUnbound => {
            expect(JSON.parse(readFileSync(registry.lockPath, 'utf8')).pid).toBe(process.pid);
            recover(() => {
              if (++checks === publication) {
                runBefore = readFileSync(join(runsRoot(), id, 'run.json'), 'utf8');
                ledgerBefore = readFileSync(join(runsRoot(), id, 'stages/work/status.json'), 'utf8');
                // An uncooperative append is observable even inside the lock;
                // ordinary TaskRegistry writers are serialized by tasks.lock.
                if (kind === 'lock-replaced') writeFileSync(registry.lockPath, JSON.stringify({ pid: process.pid, token: 'replacement' }));
                else appendFileSync(registry.registryPath, kind === 'corruption' ? '{bad}\n'
                  : JSON.stringify({ ...task, status: kind === 'unknown-status' ? 'future-state' : 'running',
                    run_id: kind === 'unreadable-binding' ? 'unreadable' : join(runsRoot(), id) }) + '\n');
              }
              assertUnbound();
            });
          });
        });
        const warn = vi.fn(); createDaemonReconciler(registry, warn)();
        expect(checks).toBe(publication);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('RECOVERY_REGISTRY_'));
        expect(readFileSync(join(runsRoot(), id, 'run.json'), 'utf8')).toBe(runBefore);
        expect(readFileSync(join(runsRoot(), id, 'stages/work/status.json'), 'utf8')).toBe(ledgerBefore);
        expect(readRunState(project, id).status).toBe('running');
        expect(readFileSync(join(runsRoot(), id, 'events.jsonl'), 'utf8')).toBe(events);
      },
    );
  }
});
