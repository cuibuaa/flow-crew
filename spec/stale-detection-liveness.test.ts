import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard, schedulerIsAliveForRun } from '../src/dashboard.js';
import { processIsAlive, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { createRun } from './test-support/create-run.js';
import { updateRunState, fcGlobalDir, runsRoot, setFcGlobalDir } from '../src/store.js';

/**
 * Stale detection previously demoted a run to `stale` purely because nothing
 * had been written for 30 minutes. A single long stage — a fetch, a test suite,
 * a research backtest — is silent for far longer than that while its scheduler
 * works normally, so live runs were reported lost.
 *
 * Both directions are asserted. A guard that only suppresses false alarms is
 * indistinguishable from deleting stale detection outright, so every
 * suppression case is paired with cases that must still fire.
 *
 * The must-still-fire cases use an absent, malformed, or wrongly-bound pid
 * rather than an exited one: obtaining a genuinely dead pid means spawning a
 * process, and tracked tests may not shell out to the host. The
 * wrongly-bound case is the stronger assertion anyway — the pid there is
 * provably alive, so bare liveness would wrongly suppress the warning.
 */

const PROJECT_DIR = '/does/not/need/to/exist';
let RUN_ID: string;

let fixtureRoot: string;
let originalFcHome: string;
let runPath: string;

beforeEach(() => {
  originalFcHome = fcGlobalDir();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-stale-liveness-'));
  setFcGlobalDir(join(fixtureRoot, '.fc'));
  RUN_ID = createRun(PROJECT_DIR, 'fixture', 'name: fixture\nstages: []', []).runId;
  updateRunState(PROJECT_DIR, RUN_ID, state => {
    state.status = 'running';
    state.campaignId = 'quiet-campaign';
    state.campaignStorageKey = 'quiet-campaign';
  });
  runPath = join(runsRoot(PROJECT_DIR), RUN_ID);
  mkdirSync(runPath, { recursive: true });
});

afterEach(() => {
  setFcGlobalDir(originalFcHome);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('schedulerIsAliveForRun', () => {
  it('reports alive for a live process bound to this run — the silent-but-working case', () => {
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(runPath, RUN_ID, process.pid);

    expect(schedulerIsAliveForRun(PROJECT_DIR, RUN_ID)).toBe(true);
  });

  it('reports not-alive when scheduler.pid is absent', () => {
    expect(schedulerIsAliveForRun(PROJECT_DIR, RUN_ID)).toBe(false);
  });

  it('reports not-alive when scheduler.pid is malformed rather than treating it as liveness', () => {
    writeFileSync(join(runPath, 'scheduler.pid'), '12345abc\n', 'utf-8');

    expect(schedulerIsAliveForRun(PROJECT_DIR, RUN_ID)).toBe(false);
  });

  it('rejects a live process whose identity binds it to a different run — pid reuse', () => {
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    expect(() => writeSchedulerProcessIdentity(runPath, 'some-other-run', process.pid)).toThrow('RUN_IDENTITY_BINDING');
    writeSchedulerProcessIdentity(runPath, RUN_ID, process.pid);
    const identityPath = join(runPath, 'scheduler.identity.json');
    const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
    writeFileSync(identityPath, JSON.stringify({ ...identity, runId: 'some-other-run' }));

    expect(processIsAlive(process.pid)).toBe(true);
    expect(schedulerIsAliveForRun(PROJECT_DIR, RUN_ID)).toBe(false);
  });

  it('does not treat an empty run id or project dir as a live scheduler', () => {
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(runPath, RUN_ID, process.pid);

    expect(schedulerIsAliveForRun(PROJECT_DIR, '')).toBe(false);
    expect(schedulerIsAliveForRun('', RUN_ID)).toBe(false);
  });
});

/**
 * The cases above prove the helper answers correctly; they do NOT prove the
 * stale decision consults it. Neutering both call sites while leaving the
 * helper intact left all of them green, so the decision itself is asserted
 * here — this is the block that goes red if the guard is disconnected.
 */
describe('campaign stale status consults process liveness', () => {
  const CAMPAIGN_ID = 'quiet-campaign';
  function writeQuietCampaign(): void {
    const campaigns = join(fcGlobalDir(), 'campaigns');
    mkdirSync(campaigns, { recursive: true });
    writeFileSync(join(campaigns, `${CAMPAIGN_ID}.jsonl`), JSON.stringify({
      kind: 'task_started', seq: 1, campaignId: CAMPAIGN_ID, runId: RUN_ID, status: 'running', pass: false,
      timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    }) + '\n');
  }

  async function staleItems() {
    const app = await startDashboard(PROJECT_DIR, 0, {
      listTasks: async () => [], inboxSources: { listApprovals: () => [] },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/inbox/overview' });
      expect(response.statusCode).toBe(200);
      return response.json().stale.items;
    } finally { await app.close(); }
  }

  it('stays running when a live scheduler is bound to the quiet run', async () => {
    writeQuietCampaign();
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(runPath, RUN_ID, process.pid);

    expect(await staleItems()).toEqual([]);
  });

  it('still goes stale when a live pid is bound to some other run', async () => {
    writeQuietCampaign();
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    expect(() => writeSchedulerProcessIdentity(runPath, 'some-other-run', process.pid)).toThrow('RUN_IDENTITY_BINDING');
    writeSchedulerProcessIdentity(runPath, RUN_ID, process.pid);
    const identityPath = join(runPath, 'scheduler.identity.json');
    const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
    writeFileSync(identityPath, JSON.stringify({ ...identity, runId: 'some-other-run' }));

    expect(await staleItems()).toMatchObject([{ id: CAMPAIGN_ID, staleRunId: RUN_ID }]);
  });

  it('still goes stale when the quiet run has no scheduler.pid at all', async () => {
    writeQuietCampaign();

    expect(await staleItems()).toMatchObject([{ id: CAMPAIGN_ID, staleRunId: RUN_ID }]);
  });
});
