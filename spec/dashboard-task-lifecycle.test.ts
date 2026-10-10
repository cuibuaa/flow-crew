import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { get } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { startDashboard } from '../src/dashboard.js';
import { recordRequest } from '../src/inbox.js';
import { RpcOutcomeUnknownError } from '../src/orchestrator-rpc.js';
import { writeSchedulerProcessIdentity } from '../src/run-lock.js';
import { removeRunIndexFiles } from '../src/run-index.js';
import {
  fcGlobalDir,
  RUN_STATUS,
  runsRoot,
  setFcGlobalDir,
  STAGE_STATUS,
} from '../src/store.js';
import { TASK_STATUS, TaskRegistry } from '../src/task-registry.js';

let app: FastifyInstance | undefined;
let fixtureRoot: string;
let projectDir: string;
let registry: TaskRegistry;
let originalFcHome: string;
let originalHome: string | undefined;
let blockingRunId: string | null;
let busyProbe: ReturnType<typeof vi.fn>;
let detachedSpawner: ReturnType<typeof vi.fn>;
let workflowLauncher: ReturnType<typeof vi.fn>;
let registerTask: ReturnType<typeof vi.fn>;
let listTasks: ReturnType<typeof vi.fn>;
let cancelRun: ReturnType<typeof vi.fn>;
let inboxApprovals: ReturnType<typeof vi.fn>;
let inboxCampaigns: ReturnType<typeof vi.fn>;
let inboxReviews: ReturnType<typeof vi.fn>;
let inboxStale: ReturnType<typeof vi.fn>;

function confirmedCancellation(runId: string) {
  return {
    ok: true,
    status: 'cancelled' as const,
    runId,
    observation: {
      unit: null,
      unitState: 'inactive',
      runReadable: true,
      schedulerPid: null,
      schedulerAlive: false,
      launchInFlight: false,
    },
    message: 'cancellation confirmed by test coordinator',
  };
}

beforeAll(() => {
  originalFcHome = fcGlobalDir();
  originalHome = process.env.HOME;
});

beforeEach(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-dashboard-task-lifecycle-'));
  projectDir = join(fixtureRoot, 'project');
  process.env.HOME = fixtureRoot;
  setFcGlobalDir(join(fixtureRoot, '.fc'));
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
  writeFileSync(join(projectDir, 'config', 'workflows', 'default.yaml'), [
    'name: default',
    'stages:',
    '  - id: gate',
    '    role: reviewer',
    '    is_gate: true',
    '',
  ].join('\n'), 'utf-8');

  registry = new TaskRegistry({ baseDir: join(fixtureRoot, 'registry') });
  blockingRunId = 'occupied-run';
  busyProbe = vi.fn(() => blockingRunId);
  detachedSpawner = vi.fn();
  workflowLauncher = vi.fn();
  registerTask = vi.fn(async (input) => {
    const task = registry.create(input);
    return {
      id: task.id,
      unit: task.systemd_unit,
      pid: 4242,
      build: 'dashboard-test-build',
    };
  });
  listTasks = vi.fn(async (filter) => registry.list(filter));
  cancelRun = vi.fn(async (runId: string) => confirmedCancellation(runId));
  inboxApprovals = vi.fn(() => []);
  inboxCampaigns = vi.fn(() => []);
  inboxReviews = vi.fn(() => []);
  inboxStale = vi.fn((campaigns: { id: string; name: string; status: string; staleRunId?: string }[]) => campaigns
    .filter((campaign) => campaign.status === 'stale')
    .map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: 'stale',
      ...(campaign.staleRunId ? { staleRunId: campaign.staleRunId } : {}),
    })));

  mkdirSync(join(projectDir, '.omx'));
  writeFileSync(join(projectDir, '.omx', 'user.txt'), 'User state');

  app = await startDashboard(projectDir, 0, {
    isProjectBusy: busyProbe,
    registerTask,
    listTasks,
    cancelRun,
    inboxSources: {
      listApprovals: () => inboxApprovals(),
      listCampaigns: () => inboxCampaigns(),
      readPendingReviews: (campaignId) => inboxReviews(campaignId),
      listStale: (campaigns) => inboxStale(campaigns),
    },
  });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  removeRunIndexFiles(projectDir);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(originalFcHome);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function writeRun(runId: string, status: string, campaignId?: string): string {
  const runPath = join(runsRoot(), runId);
  mkdirSync(join(runPath, 'stages', 'gate'), { recursive: true });
  writeFileSync(join(runPath, 'workflow.yaml'), [
    'name: default',
    'stages:',
    '  - id: gate',
    '    role: reviewer',
    '    is_gate: true',
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(runPath, 'run.json'), JSON.stringify({
    runId,
    projectDir,
    workflowName: 'default',
    taskDescription: 'Dashboard mutation fixture',
    status,
    stages: {
      gate: { status: STAGE_STATUS.COMPLETE, retries: 2, artifacts: ['kept.txt'] },
    },
    startedAt: '2026-07-30T00:00:00.000Z',
    completedAt: '2026-07-30T00:10:00.000Z',
    currentIteration: 3,
    ...(status === RUN_STATUS.PARKED ? {
      parked: {
        requestId: 'approval-one',
        action: 'deploy',
        reason: 'approval needed',
        atIteration: 3,
        requestedAt: '2026-07-30T00:05:00.000Z',
        pausedAt: '2026-07-30T00:05:00.000Z',
      },
    } : {}),
    ...(campaignId ? {
      campaignId,
      campaignStorageKey: campaignId,
      campaignName: campaignId,
    } : {}),
  }, null, 2), 'utf-8');
  writeFileSync(join(runPath, 'task_brief.md'), '# Dashboard mutation fixture\n', 'utf-8');
  writeFileSync(join(runPath, 'events.jsonl'), '{"event":"must-survive"}\n', 'utf-8');
  writeFileSync(join(runPath, 'verdict_gate.json'), '{"pass":true}\n', 'utf-8');
  writeFileSync(join(runPath, 'stages', 'gate', 'status.json'), '{"status":"complete"}\n', 'utf-8');
  writeFileSync(join(runPath, 'stages', 'gate', 'live.log'), 'must survive\n', 'utf-8');
  return runPath;
}

async function admittedTaskPayload(brief: string, fields: Record<string, unknown>) {
  const checked = await app!.inject({
    method: 'POST',
    url: '/api/brief-preflight',
    payload: { brief },
  });
  expect(checked.statusCode).toBe(200);
  const { report, receipt } = checked.json();
  return {
    brief,
    ...fields,
    briefPreflightDigest: report.digest,
    briefPreflightReceipt: receipt,
    ...(report.requiresAcknowledgement ? { acknowledgeBriefWarnings: true } : {}),
  };
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else snapshot[relative(root, path)] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return snapshot;
}

describe('dashboard project admission is pre-mutation', () => {
  it('starts without migrating project-local engine state', () => {
    expect(readFileSync(join(projectDir, '.omx', 'user.txt'), 'utf8')).toBe('User state');
    expect(existsSync(join(projectDir, '.fc'))).toBe(false);
  });

  const cases = [
    {
      name: 'durable approval resume',
      status: RUN_STATUS.PARKED,
      url: (runId: string) => `/api/inbox/${runId}/approval-one/resolve`,
      payload: { decision: 'approve', by: 'operator' },
      prepare: (runId: string) => recordRequest({
        runId,
        projectDir,
        requestId: 'approval-one',
        action: 'deploy',
        target: 'production',
        risk: 'external',
        title: 'Deploy production',
        createdAt: '2026-07-30T00:05:00.000Z',
      }),
    },

  ];

  it.each(cases)('$name returns 409 with zero launch and byte-for-byte zero side effects', async (testCase) => {
    const runId = `busy-${testCase.name.replace(/[^a-z]+/g, '-')}`;
    const runPath = writeRun(runId, testCase.status);
    testCase.prepare(runId);
    const before = snapshotTree(runPath);

    const response = await app!.inject({
      method: 'POST',
      url: testCase.url(runId),
      payload: testCase.payload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('project busy (run occupied-run)');
    expect(snapshotTree(runPath)).toEqual(before);
    expect(detachedSpawner).not.toHaveBeenCalled();
    expect(workflowLauncher).not.toHaveBeenCalled();
    expect(busyProbe).toHaveBeenCalledWith(projectDir, runId);
  });
});

describe('dashboard stage-timeout ingress', () => {
  it('rejects task timeout overrides with the defaults.yaml migration', async () => {
    const runId = 'removed-timeout-ingress';
    const runPath = writeRun(runId, RUN_STATUS.PENDING);
    const before = snapshotTree(runPath);
    const requests = [
      { method: 'POST' as const, url: '/api/tasks', payload: { name: 'legacy task', timeoutMs: 1 } },
    ];

    for (const request of requests) {
      const response = await app!.inject(request);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('config/defaults.yaml::default_timeout_ms');
    }
    expect(snapshotTree(runPath)).toEqual(before);
    expect(detachedSpawner).not.toHaveBeenCalled();
    expect(workflowLauncher).not.toHaveBeenCalled();
  });
});

describe('dashboard terminal-state truth', () => {
  it('does not rewrite a non-complete/non-failed terminal run on cancel', async () => {
    const runId = 'terminal-ceiling-hit';
    const runPath = writeRun(runId, RUN_STATUS.CEILING_HIT);
    const before = snapshotTree(runPath);

    const response = await app!.inject({ method: 'POST', url: `/api/tasks/${runId}/cancel` });

    expect(response.statusCode).toBe(200);
    expect(snapshotTree(runPath)).toEqual(before);
  });
});

describe('dashboard E13 cancellation delegation', () => {

  it('delegates a live run by id without locally rewriting run.json', async () => {
    const runId = 'dashboard-shared-cancel';
    const runPath = writeRun(runId, RUN_STATUS.RUNNING);
    const before = snapshotTree(runPath);

    const response = await app!.inject({ method: 'POST', url: `/api/tasks/${runId}/cancel` });

    expect(response.statusCode).toBe(200);
    expect(cancelRun).toHaveBeenCalledOnce();
    expect(cancelRun).toHaveBeenCalledWith(runId);
    expect(snapshotTree(runPath)).toEqual(before);
  });

  it('returns a non-success response while cancel is still observable as pending', async () => {
    const runId = 'dashboard-cancel-pending';
    const runPath = writeRun(runId, RUN_STATUS.RUNNING);
    const before = snapshotTree(runPath);
    cancelRun.mockResolvedValueOnce({
      ...confirmedCancellation(runId),
      ok: false,
      status: 'cancelling',
      message: 'scheduler is still exiting',
    });

    const response = await app!.inject({ method: 'POST', url: `/api/tasks/${runId}/cancel` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'scheduler is still exiting',
      cancellation: { ok: false, status: 'cancelling', runId },
    });
    expect(snapshotTree(runPath)).toEqual(before);
  });
});

describe('dashboard daemon-backed task creation', () => {
  it('registers a real daemon task without creating a dashboard-owned run', async () => {
    const brief = '# Registered task\n\nDo the work.';
    const response = await app!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: await admittedTaskPayload(brief, {
        projectDir,
        workflow: 'research',
        maxIterations: 4,
        supervise: false,
        campaignId: 'operator-campaign',
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: 1, unit: 'flowcrew-task-1.service' });
    const task = registry.get(1);
    expect(task).toMatchObject({
      id: 1,
      kind: 'quick',
      name: 'Registered task',
      projectDir,
      status: TASK_STATUS.PENDING,
      launch_args: [
        '--workflow', 'research',
        '--max-iterations', '4',
        '--no-supervise',
        '--campaign', 'operator-campaign',
      ],
    });
    expect(readFileSync(task!.brief_path!, 'utf-8')).toBe('# Registered task\n\nDo the work.');
    expect(existsSync(runsRoot())).toBe(false);
  });

  it('derives task titles through the shared extractor for complete, absent, and incomplete frontmatter', async () => {
    const cases = [
      {
        expected: 'Complete frontmatter title',
        brief: '---\nterminal_states:\n  shipped:\n    paths: [docs/report.md]\n---\nIntro before heading.\n# Complete frontmatter title\n',
      },
      {
        expected: 'No frontmatter title',
        brief: 'Intro before heading.\n## No frontmatter title\n',
      },
      {
        expected: 'Incomplete frontmatter title',
        brief: '---\nterminal_states:\n  shipped:\n    paths: [docs/report.md]\nIntro before heading.\n# Incomplete frontmatter title\n',
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const response = await app!.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: await admittedTaskPayload(fixture.brief, { projectDir }),
      });
      expect(response.statusCode).toBe(201);
      expect(registry.get(index + 1)?.name).toBe(fixture.expected);
    }
  });

  it('returns a truthful non-2xx response when daemon registration fails', async () => {
    registerTask.mockImplementationOnce(async () => { throw new Error('daemon exploded'); });

    const brief = 'This must not be silently accepted.';
    const response = await app!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: await admittedTaskPayload(brief, { workflow: 'default' }),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('daemon exploded');
    expect(registry.list({ status: 'all' })).toEqual([]);
    expect(existsSync(runsRoot())).toBe(false);
  });

  it('does not claim failure when the daemon may already have accepted registration', async () => {
    registerTask.mockImplementationOnce(async () => {
      throw new RpcOutcomeUnknownError('daemon response was lost.');
    });

    const brief = 'Registration delivery may have succeeded.';
    const response = await app!.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: await admittedTaskPayload(brief, { workflow: 'default' }),
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain('outcome is unknown');
    expect(response.json().error).toContain('may already have been delivered');
  });
});

describe('dashboard waiting-work data', () => {

  it('does not turn a daemon list failure into an empty inbox', async () => {
    listTasks.mockImplementationOnce(async () => { throw new Error('daemon socket offline'); });

    const response = await app!.inject({ method: 'GET', url: '/api/inbox/overview' });

    expect(response.statusCode).toBe(200);
    expect(response.json().deferred.status).toBe('unavailable');
    expect(response.json().deferred.error).toContain('daemon socket offline');
  });

  it('surfaces a synthesized stale campaign with the run that can be inspected or marked failed', async () => {
    const runId = 'stale-campaign-run';
    writeRun(runId, RUN_STATUS.RUNNING, 'stale-campaign');
    const campaignDir = join(fixtureRoot, '.fc', 'campaigns', 'stale-campaign');
    mkdirSync(campaignDir, { recursive: true });
    const statePath = join(campaignDir, 'state.json');
    const iterationsPath = join(campaignDir, 'iteration_log.jsonl');
    writeFileSync(statePath, JSON.stringify({ status: 'running', projectDir }, null, 2), 'utf-8');
    writeFileSync(iterationsPath, `${JSON.stringify({
      iter: 1,
      run_id: runId,
      outcome: 'running',
    })}\n`, 'utf-8');
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(statePath, old, old);
    utimesSync(iterationsPath, old, old);

    await app!.close();
    app = await startDashboard(projectDir, 0, { isProjectBusy: busyProbe, listTasks, cancelRun });
    const response = await app.inject({ method: 'GET', url: '/api/inbox/overview' });

    expect(response.statusCode).toBe(200);
    expect(response.json().stale.items).toContainEqual(expect.objectContaining({
      id: 'stale-campaign',
      status: 'stale',
      staleRunId: runId,
    }));

    cancelRun.mockImplementationOnce(async (requestedRunId: string) => {
      const runJson = join(runsRoot(), requestedRunId, 'run.json');
      const current = JSON.parse(readFileSync(runJson, 'utf-8'));
      current.status = RUN_STATUS.STOPPED;
      current.failureReason = 'Cancelled by user';
      current.completedAt = new Date().toISOString();
      writeFileSync(runJson, JSON.stringify(current, null, 2), 'utf-8');
      return confirmedCancellation(requestedRunId);
    });
    const marked = await app!.inject({ method: 'POST', url: `/api/tasks/${runId}/cancel` });
    expect(marked.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(runsRoot(), runId, 'run.json'), 'utf-8')).status).toBe(RUN_STATUS.STOPPED);

    const refreshed = await app!.inject({ method: 'GET', url: '/api/inbox/overview' });
    expect(refreshed.json().stale.items).not.toContainEqual(expect.objectContaining({ id: 'stale-campaign' }));
  });
});

describe('aggregate inbox overview', () => {
  const approvalItem = () => ({
    runId: 'parked-run',
    projectDir: '/tmp/project',
    requestId: 'approval-one',
    action: 'deploy',
    target: 'production',
    risk: 'external' as const,
    title: 'Deploy production',
    createdAt: '2026-07-30T00:05:00.000Z',
  });
  const reviewEntry = (campaignId: string) => ({
    ts: '2026-07-30T00:06:00.000Z',
    campaignId,
    reason: 'Review the proposed brief change',
    severity: 'medium' as const,
    patch: { type: 'brief_patch' as const, section: '## Risk', op: 'append' as const, value: 'Require rollback evidence.' },
    briefVersion: 'v1',
    runId: 'patch-run',
  });
  const campaign = (id: string, status = 'idle', staleRunId?: string) => ({
    id,
    name: id,
    status,
    staleRunId,
    brief_revisions: [{ version: 'v2', reason: 'fixture' }],
  });

  it('returns all four sources and removes only an exact deferred approval mirror', async () => {
    inboxApprovals.mockReturnValue([approvalItem()]);
    inboxCampaigns.mockReturnValue([
      campaign('stale-campaign', 'stale', 'stale-run'),
      campaign('patch-campaign'),
    ]);
    inboxReviews.mockImplementation((id) => id === 'patch-campaign' ? [reviewEntry(id)] : []);
    const mirror = registry.create({ name: 'Approval mirror', brief_text: 'wait', projectDir });
    registry.update(mirror.id, {
      status: TASK_STATUS.DEFERRED,
      run_id: 'parked-run',
      defer_reason: 'awaiting human approval (run parked-run, request approval-one); resolve with: flowcrew inbox approve approval-one',
      defer_kind: 'wait',
    });
    const counterexample = registry.create({ name: 'Same run, ordinary wait', brief_text: 'wait', projectDir });
    registry.update(counterexample.id, {
      status: TASK_STATUS.DEFERRED,
      run_id: 'parked-run',
      defer_reason: 'project busy (run another-run)',
      defer_kind: 'wait',
    });

    const response = await app!.inject({ method: 'GET', url: '/api/inbox/overview' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      approvals: { status: 'complete', items: [{ runId: 'parked-run', requestId: 'approval-one' }] },
      deferred: { status: 'complete', items: [{ id: counterexample.id }] },
      stale: { status: 'complete', items: [{ id: 'stale-campaign', status: 'stale', staleRunId: 'stale-run' }] },
      patches: {
        status: 'complete',
        items: [{ campaignId: 'patch-campaign', campaignName: 'patch-campaign', index: 0, latestVersion: 'v2' }],
        coverage: { succeeded: 2, failed: 0 },
      },
      campaignCount: 2,
    });
    expect(inboxCampaigns).toHaveBeenCalledTimes(1);

    inboxApprovals.mockImplementationOnce(() => { throw new Error('approval store offline'); });
    const uncertain = await app!.inject({ method: 'GET', url: '/api/inbox/overview' });
    expect(uncertain.statusCode).toBe(200);
    expect(uncertain.json().approvals.status).toBe('unavailable');
    expect(uncertain.json().approvals.error).toContain('approval store offline');
    expect(uncertain.json().deferred.items.map((item: { id: number }) => item.id).sort())
      .toEqual([mirror.id, counterexample.id].sort());
  });

  it.each(['approvals', 'deferred', 'stale', 'patches'] as const)(
    'localizes a %s failure while the other three sources remain available',
    async (failedSource) => {
      inboxApprovals.mockReturnValue([approvalItem()]);
      inboxCampaigns.mockReturnValue([
        campaign('stale-campaign', 'stale', 'stale-run'),
        campaign('patch-campaign'),
      ]);
      inboxReviews.mockImplementation((id) => id === 'patch-campaign' ? [reviewEntry(id)] : []);
      const waiting = registry.create({ name: 'Ordinary deferred', brief_text: 'wait', projectDir });
      registry.update(waiting.id, {
        status: TASK_STATUS.DEFERRED,
        run_id: 'waiting-run',
        defer_reason: 'project busy (run active-run)',
        defer_kind: 'wait',
      });

      if (failedSource === 'approvals') inboxApprovals.mockImplementationOnce(() => { throw new Error('approval source failed'); });
      if (failedSource === 'deferred') listTasks.mockImplementationOnce(async () => { throw new Error('deferred source failed'); });
      if (failedSource === 'stale') inboxStale.mockImplementationOnce(() => { throw new Error('stale source failed'); });
      if (failedSource === 'patches') inboxReviews.mockImplementation((id) => {
        if (id === 'patch-campaign') throw new Error('patch source failed');
        return [];
      });

      const response = await app!.inject({ method: 'GET', url: '/api/inbox/overview' });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body[failedSource].items).toEqual([]);
      expect(body[failedSource].error).toContain('failed');
      expect(body[failedSource].status).toBe(failedSource === 'patches' ? 'partial' : 'unavailable');
      for (const source of ['approvals', 'deferred', 'stale', 'patches'] as const) {
        if (source !== failedSource) expect(body[source].items).toHaveLength(1);
      }
    },
  );

  it('keeps successfully read patches when one campaign store fails', async () => {
    inboxCampaigns.mockReturnValue([campaign('patch-good'), campaign('patch-bad')]);
    inboxReviews.mockImplementation((id) => {
      if (id === 'patch-bad') throw new Error('permission denied');
      return [reviewEntry(id)];
    });

    const response = await app!.inject({ method: 'GET', url: '/api/inbox/overview' });
    const patches = response.json().patches;

    expect(response.statusCode).toBe(200);
    expect(patches.status).toBe('partial');
    expect(patches.items).toMatchObject([{ campaignId: 'patch-good' }]);
    expect(patches.error).toContain('patch-bad');
    expect(patches.coverage).toEqual({ succeeded: 1, failed: 1 });
    expect(response.json().stale).toEqual({ status: 'complete', items: [] });
  });

  it('keeps an empty partial patch source distinct from complete-empty and unavailable', async () => {
    inboxCampaigns.mockReturnValue(Array.from({ length: 120 }, (_, index) => campaign(`campaign-${index}`)));
    inboxReviews.mockImplementation((id) => {
      if (id === 'campaign-119') throw new Error('permission denied');
      return [];
    });

    const response = await app!.inject({ method: 'GET', url: '/api/inbox/overview' });
    const patches = response.json().patches;

    expect(response.statusCode).toBe(200);
    expect(patches).toEqual({
      status: 'partial',
      items: [],
      error: expect.stringContaining('campaign-119'),
      coverage: { succeeded: 119, failed: 1 },
    });
  });

  it('marks patches unavailable only when no campaign store read succeeds', async () => {
    inboxCampaigns.mockReturnValue([campaign('patch-bad-a'), campaign('patch-bad-b')]);
    inboxReviews.mockImplementation(() => { throw new Error('storage offline'); });

    const response = await app!.inject({ method: 'GET', url: '/api/inbox/overview' });
    const patches = response.json().patches;

    expect(response.statusCode).toBe(200);
    expect(patches).toMatchObject({
      status: 'unavailable',
      items: [],
      error: expect.stringContaining('storage offline'),
      coverage: { succeeded: 0, failed: 2 },
    });
  });

  it('serves a 120-campaign fixture through one aggregate HTTP request', async () => {
    inboxCampaigns.mockReturnValue(Array.from({ length: 120 }, (_, index) => campaign(`campaign-${index}`)));

    const responses = await Promise.all([
      app!.inject({ method: 'GET', url: '/api/inbox/overview' }),
    ]);

    expect(responses).toHaveLength(1);
    expect(responses[0].statusCode).toBe(200);
    expect(responses[0].json()).toMatchObject({
      campaignCount: 120,
      patches: { status: 'complete', items: [], coverage: { succeeded: 120, failed: 0 } },
    });
    expect(inboxCampaigns).toHaveBeenCalledTimes(1);
    expect(inboxReviews).toHaveBeenCalledTimes(120);
  });
});

// The mounted run page consumes this read-only stream through EventSource.
it('serves positive live stage output through the mounted run-page stream', async () => {
  const directory = join(runsRoot(), 'live-reader', 'stages', 'writer');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'live.log.txt'), 'current live reader output\n');
  writeFileSync(join(directory, 'status.json'), JSON.stringify({ status: 'running' }));
  const address = app!.server.address() as { port: number };
  await new Promise<void>((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port: address.port, path: '/api/tasks/live-reader/stages/writer/live' }, response => {
      response.once('data', chunk => {
        try {
          expect(response.statusCode).toBe(200);
          expect(String(chunk)).toContain('current live reader output');
          resolve();
        } catch (error) { reject(error); }
        finally { response.destroy(); request.destroy(); }
      });
      response.once('error', reject);
    });
    request.setTimeout(5000, () => { request.destroy(); reject(new Error('owned stream produced no output')); });
    request.once('error', reject);
  });
});
