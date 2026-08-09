import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignSummary, schedulerIsAliveForRun } from '../src/dashboard.js';
import { processIsAlive, writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { fcGlobalDir, runsRoot, setFcGlobalDir } from '../src/store.js';

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
const RUN_ID = 'run-under-test';

let fixtureRoot: string;
let originalFcHome: string;
let runPath: string;

beforeEach(() => {
  originalFcHome = fcGlobalDir();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-stale-liveness-'));
  setFcGlobalDir(join(fixtureRoot, '.fc'));
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
    writeSchedulerProcessIdentity(runPath, 'some-other-run', process.pid);

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
  let campaignDir: string;

  function writeQuietCampaign(): void {
    campaignDir = join(fixtureRoot, 'campaigns', CAMPAIGN_ID);
    mkdirSync(campaignDir, { recursive: true });
    writeFileSync(
      join(campaignDir, 'state.json'),
      JSON.stringify({ status: 'running', projectDir: PROJECT_DIR, runId: RUN_ID }),
      'utf-8',
    );
    // Backdate well past the 30-minute silence threshold.
    const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(join(campaignDir, 'state.json'), hoursAgo, hoursAgo);
  }

  it('stays running when a live scheduler is bound to the quiet run', () => {
    writeQuietCampaign();
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(runPath, RUN_ID, process.pid);

    expect(campaignSummary(CAMPAIGN_ID, campaignDir).status).toBe('running');
  });

  it('still goes stale when a live pid is bound to some other run', () => {
    writeQuietCampaign();
    writeFileSync(join(runPath, 'scheduler.pid'), String(process.pid), 'utf-8');
    writeSchedulerProcessIdentity(runPath, 'some-other-run', process.pid);

    expect(campaignSummary(CAMPAIGN_ID, campaignDir).status).toBe('stale');
  });

  it('still goes stale when the quiet run has no scheduler.pid at all', () => {
    writeQuietCampaign();

    expect(campaignSummary(CAMPAIGN_ID, campaignDir).status).toBe('stale');
  });
});
