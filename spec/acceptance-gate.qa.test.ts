import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatCampaignContextBlock,
  selectRelevantCampaignContext,
} from '../src/campaign-context.js';
import { summarizeLedger } from '../src/campaign-ledger.js';
import type { CampaignHistoryEntry } from '../src/campaigns.js';
import { startDashboard } from '../src/dashboard.js';
import {
  fcGlobalDir,
  RUN_STATUS,
  runsRoot,
  setFcGlobalDir,
  STAGE_STATUS,
} from '../src/store.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const FIXED_NOW = Date.parse('2026-07-31T12:00:00.000Z');

function campaignEntry(overrides: Partial<CampaignHistoryEntry>): CampaignHistoryEntry {
  return {
    seq: 1,
    runId: 'campaign-run',
    pass: true,
    status: RUN_STATUS.RUNNING,
    timestamp: new Date(FIXED_NOW).toISOString(),
    ...overrides,
  };
}

describe('acceptance gate: campaign relevance boundaries', () => {
  it('does not resurrect an earlier handoff after the latest phase completes without a next phase', () => {
    const selection = selectRelevantCampaignContext([
      campaignEntry({
        seq: 1,
        phase: 'phase-one',
        phaseComplete: true,
        nextPhase: 'phase-two',
      }),
      campaignEntry({
        seq: 2,
        phase: 'phase-two',
        phaseComplete: true,
        nextPhase: undefined,
      }),
    ], FIXED_NOW);

    expect(selection.recommendedPhase).toBeUndefined();
    expect(formatCampaignContextBlock({ campaignLabel: 'finished-chain', selection })).toBe('');
  });

  it('keeps every deduplicated dead end even when tried directions are capped to one', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'flowcrew-acceptance-ledger-'));
    const previousFcDir = fcGlobalDir();
    const projectDir = join(sandbox, 'project');
    const campaignId = 'uncapped-dead-ends';
    const runId = 'terminal-ledger-run';
    try {
      setFcGlobalDir(join(sandbox, 'fc-home'));
      mkdirSync(join(projectDir, '.fc', 'campaigns'), { recursive: true });
      writeFileSync(
        join(projectDir, '.fc', 'campaigns', `${campaignId}.jsonl`),
        `${JSON.stringify(campaignEntry({ runId, kind: 'task_ended', status: RUN_STATUS.COMPLETE }))}\n`,
        'utf-8',
      );
      const runPath = join(runsRoot(), runId);
      mkdirSync(runPath, { recursive: true });
      writeFileSync(join(runPath, 'research_journal.json'), JSON.stringify({
        rounds: [
          { label: 'first tried direction', result: 1 },
          { label: 'second tried direction', result: 2 },
        ],
      }), 'utf-8');
      const deadEnds = Array.from({ length: 25 }, (_, index) => `durable dead end ${index + 1}`);
      writeFileSync(join(runPath, 'knowledge_graph.json'), JSON.stringify({
        nodes: [
          ...deadEnds.map((text) => ({ type: 'dead_end', text })),
          { type: 'dead_end', text: deadEnds[0] },
        ],
      }), 'utf-8');

      const digest = summarizeLedger(projectDir, campaignId, { cap: 1 });

      expect(digest).toContain('first tried direction');
      expect(digest).not.toContain('second tried direction');
      for (const deadEnd of deadEnds) expect(digest).toContain(`- ${deadEnd}`);
      expect(digest).toContain(`Dead ends (${deadEnds.length} — avoid)`);
    } finally {
      setFcGlobalDir(previousFcDir);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('acceptance gate: dashboard mutation peers', () => {
  let app: FastifyInstance | undefined;
  let sandbox: string;
  let projectDir: string;
  let previousFcDir: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'flowcrew-acceptance-dashboard-'));
    projectDir = join(sandbox, 'project');
    previousFcDir = fcGlobalDir();
    previousHome = process.env.HOME;
    process.env.HOME = join(sandbox, 'home');
    setFcGlobalDir(join(sandbox, 'fc-home'));
    mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
    mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
    writeFileSync(
      join(projectDir, 'config', 'workflows', 'default.yaml'),
      'name: default\nstages: []\n',
      'utf-8',
    );
    app = await startDashboard(projectDir, 0);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    setFcGlobalDir(previousFcDir);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function writeBlockedRun(runId: string, status: string): string {
    const path = join(runsRoot(), runId, 'run.json');
    mkdirSync(join(runsRoot(), runId), { recursive: true });
    writeFileSync(path, JSON.stringify({
      runId,
      projectDir,
      workflowName: 'default',
      taskDescription: 'Mutation guard fixture',
      status,
      stages: {
        gate: { status: STAGE_STATUS.COMPLETE, retries: 0 },
      },
      startedAt: '2026-07-31T00:00:00.000Z',
    }, null, 2), 'utf-8');
    return path;
  }

  it.each([
    ['whole-run rerun', (runId: string) => `/api/tasks/${runId}/rerun`],
    ['stage rerun', (runId: string) => `/api/tasks/${runId}/stages/gate/rerun`],
    ['gate re-evaluation', (runId: string) => `/api/tasks/${runId}/stages/gate/reeval`],
  ])('blocks %s without mutating all three busy run states', async (_name, route) => {
    for (const status of [
      RUN_STATUS.RUNNING,
      RUN_STATUS.PARKED,
      RUN_STATUS.AWAITING_APPROVAL,
    ]) {
      const runId = `blocked-${status}`;
      const runJson = writeBlockedRun(runId, status);
      const before = readFileSync(runJson, 'utf-8');

      const response = await app!.inject({ method: 'POST', url: route(runId) });

      expect(response.statusCode, `${_name} should block ${status}`).toBe(409);
      expect(readFileSync(runJson, 'utf-8')).toBe(before);
    }
  });

  it('preserves a non-complete/non-failed terminal result when cancel is retried', async () => {
    const runId = 'cancel-ceiling-hit';
    const runJson = writeBlockedRun(runId, RUN_STATUS.CEILING_HIT);
    const before = readFileSync(runJson, 'utf-8');

    const response = await app!.inject({ method: 'POST', url: `/api/tasks/${runId}/cancel` });

    expect(response.statusCode).toBe(200);
    expect(readFileSync(runJson, 'utf-8')).toBe(before);
  });
});

describe('acceptance gate: campaign context CLI validation', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'flowcrew-acceptance-cli-'));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('rejects the space-separated campaign-context spelling before creating a run', () => {
    const homeDir = join(sandbox, 'home');
    const fcHome = join(sandbox, 'fc-home');
    mkdirSync(homeDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      join(REPO_ROOT, 'src', 'cli.ts'),
      'quick',
      '--task',
      'invalid campaign context syntax',
      '--campaign-context',
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, HOME: homeDir, FC_HOME: fcHome },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Invalid --campaign-context syntax; use --campaign-context=inherit or --campaign-context=skip.',
    );
    expect(existsSync(join(fcHome, 'runs'))).toBe(false);
  });
});
