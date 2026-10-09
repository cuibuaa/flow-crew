import { fixtureResult } from './test-support/declared-dispatch.js';
import { coveredStages, settleCoverageFixture } from './spec_contracts/declared-fixtures.js';
import { stringify as stringifyYaml } from 'yaml';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdDashboard } from '../src/cli-dashboard.js';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import {
  createBriefAdmission,
  inspectBrief,
  verifyBriefAdmission,
  type BriefAdmissionRecord,
} from '../src/brief-preflight.js';
import { buildCommand, Orchestrator, type GitAdapter, type SupervisorBackend, type UnitStatus } from '../src/orchestrator.js';
import { startRpcServer, type RpcRequest } from '../src/orchestrator-rpc.js';
import { recordRequest } from '../src/inbox.js';
import { cmdInbox } from '../src/cli-inbox.js';
import {
  createRun,
  fcGlobalDir,
  listRuns,
  readRunState,
  runsRoot,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { TaskRegistry, type TaskCreateInput } from '../src/task-registry.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';

const repositoryRoot = join(import.meta.dirname, '..');
const WORKFLOW = [
  'name: default',
  'stages:',
  '  - id: work',
  '    role: worker',
  '    prompt_template: work',
  '    artifact_contract: {version: 1, produces: [], reads: [], replays: []}',
  '',
].join('\n');

let fixtureRoot: string;
let projectDir: string;
let realFcHome: string;
let app: Awaited<ReturnType<typeof import('../src/dashboard.js')['startDashboard']>> | undefined;

function explicitAdmission(brief: string): BriefAdmissionRecord {
  return createBriefAdmission(inspectBrief(brief), {
    kind: 'explicit',
    source: 'cli_current_input_flag',
    at: '2026-08-03T00:00:00.000Z',
  });
}

async function preflight(server: NonNullable<typeof app>, brief: string) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/brief-preflight',
    payload: { brief },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    report: ReturnType<typeof inspectBrief>;
    receipt: string;
  };
}

function admissionFields(checked: Awaited<ReturnType<typeof preflight>>) {
  return {
    briefPreflightDigest: checked.report.digest,
    briefPreflightReceipt: checked.receipt,
    ...(checked.report.requiresAcknowledgement ? { acknowledgeBriefWarnings: true } : {}),
  };
}

beforeAll(() => {
  realFcHome = fcGlobalDir();
});

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-p11-entry-'));
  projectDir = join(fixtureRoot, 'project');
  setFcGlobalDir(join(fixtureRoot, 'fc'));
  mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
  mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
  writeFileSync(join(projectDir, 'config', 'workflows', 'default.yaml'), WORKFLOW, 'utf-8');
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(realFcHome);
});

describe('Dashboard admission handshake', () => {
  it('keeps New Run non-blocking but requires a process-bound exact-text review before registration', async () => {
    const registrations: TaskCreateInput[] = [];
    app = await (await import('../src/dashboard.js')).startDashboard(projectDir, 0, {
      registerTask: async (task) => {
        registrations.push(task);
        return { id: registrations.length, unit: `fixture-${registrations.length}.service`, pid: process.pid, build: 'fixture' };
      },
      isProjectBusy: () => null,
    });
    const brief = '# What the report must show\n\n1. The source must contain `new JSDOM(...)` while fixing the login race.';
    const checked = await preflight(app, brief);
    expect(checked.report).toMatchObject({
      inputKind: 'brief',
      contractReady: true,
      frontmatter: { status: 'absent' },
      requiresAcknowledgement: true,
    });
    expect(checked.report.findings.map((finding) => finding.code)).toContain('criterion_instrument_wording');

    const unchecked = await app.inject({ method: 'POST', url: '/api/tasks', payload: { brief, workflow: 'default' } });
    expect(unchecked.statusCode).toBe(409);
    expect(unchecked.json()).toMatchObject({ report: { digest: checked.report.digest }, receipt: expect.any(String) });
    expect(registrations).toHaveLength(0);

    const unacknowledged = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        brief,
        workflow: 'default',
        briefPreflightDigest: checked.report.digest,
        briefPreflightReceipt: checked.receipt,
      },
    });
    expect(unacknowledged.statusCode).toBe(409);
    expect(registrations).toHaveLength(0);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { brief, workflow: 'default', ...admissionFields(checked) },
    });
    expect(accepted.statusCode).toBe(201);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      brief_text: brief,
      brief_admission: {
        digest: checked.report.digest,
        acknowledgement: { kind: 'explicit', source: 'dashboard_receipt' },
      },
    });
    expect(registrations[0].launch_args).not.toContain('--acknowledge-brief-warnings');

    const changed = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { brief: `${brief}\n`, workflow: 'default', ...admissionFields(checked) },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().report.digest).not.toBe(checked.report.digest);
    expect(registrations).toHaveLength(1);
  });

  it('invalidates an old receipt when the Dashboard process changes', async () => {
    const brief = 'Restart-bound receipt';
    app = await (await import('../src/dashboard.js')).startDashboard(projectDir, 0, {
      registerTask: async () => ({ id: 1, unit: 'never.service', pid: process.pid, build: 'fixture' }),
      isProjectBusy: () => null,
    });
    const checked = await preflight(app, brief);
    await app.close();
    app = undefined;

    let registrations = 0;
    app = await (await import('../src/dashboard.js')).startDashboard(projectDir, 0, {
      registerTask: async () => {
        registrations += 1;
        return { id: 2, unit: 'never.service', pid: process.pid, build: 'fixture' };
      },
      isProjectBusy: () => null,
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { brief, workflow: 'default', ...admissionFields(checked) },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatch(/earlier dashboard process/i);
    expect(registrations).toBe(0);
  });

  it('keeps the captured brief in settled state and the terminal report when a sidecar changes', async () => {
    const brief = '# Goal\nUse the captured scheduler input marker.\n## What the report must show\n1. Preserve the captured scheduler input.\n';
    const changed = '# Goal\nSIDE-CAR-DRIFT-MUST-NOT-RUN\n## What the report must show\n1. Preserve the captured scheduler input.\n';
    const admission = explicitAdmission(brief);
    const scheduler = await import('../src/scheduler.js');
    const { config } = scheduler.loadWorkflow(join(projectDir, 'config', 'workflows', 'default.yaml'));
    config.stages = coveredStages(config.stages[0], brief);
    const raw = stringifyYaml(config);
    const { runId } = createRun(projectDir, 'default', raw, config.stages.map(({ id }) => id));
    const state = readRunState(projectDir, runId);
    state.status = 'pending';
    state.taskDescription = brief;
    state.briefAdmission = admission;
    writeRunState(projectDir, runId, state);
    writeFileSync(join(runsRoot(), runId, 'task_brief.md'), changed, 'utf-8');

    const prompts: string[] = [];
    const adapter: Adapter = {
      async run(prompt, _role, options) {
        prompts.push(options.stageId);
        if (settleCoverageFixture(options)) return fixtureResult({ output: 'fixture prerequisite settled', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, options);
        return fixtureResult({ output: 'completed', exitCode: 0, duration_ms: 1 }, options);
      },
    };
    const worker: AgentConfig = {
      name: 'worker',
      description: 'fixture worker',
      model: 'mock',
      reasoning_effort: 'low',
      tools: [],
      prompt: 'Execute the supplied task.',
    };
    mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'agents', 'worker.yaml'), stringifyYaml(worker));
    const final = await scheduler.runWorkflow(
      config,
      raw,
      projectDir,
      adapter,
      new Map([['worker', worker]]),
      undefined,
      join(projectDir, 'config', 'agents'),
      runId,
      brief,
      true,
      false,
      undefined,
      true,
      admission,
    );

    expect(final.taskDescription).toBe(brief);
    const report = readFileSync(join(runsRoot(), runId, 'summary.md'), 'utf8');
    expect(report).toContain('captured scheduler input marker');
    expect(report).not.toContain('SIDE-CAR-DRIFT-MUST-NOT-RUN');
    expect(prompts).not.toContain('_summary');
  });

  it('replaces a same-digest invalid record before consuming an Inbox decision', async () => {
    const spawns: string[] = [];
    app = await (await import('../src/dashboard.js')).startDashboard(projectDir, 0, {
      registerTask: async (task) => {
        spawns.push(task.run_id!);
        return { id: 1, unit: 'private-resume', pid: process.pid, build: 'fixture' };
      },
      isProjectBusy: () => null,
    });
    const brief = 'Resume this consequential one-line brief';
    const { runId } = createRun(projectDir, 'default', WORKFLOW, ['work']);
    const requestId = 'p11-resume-review';
    const state = readRunState(projectDir, runId);
    const malformed = explicitAdmission(brief);
    malformed.findingFingerprints = [];
    state.status = 'parked';
    state.taskDescription = brief;
    state.briefAdmission = malformed;
    state.parked = {
      requestId,
      action: 'deploy',
      risk: 'external',
      pausedAt: '2026-08-03T00:00:00.000Z',
      atIteration: 1,
    };
    writeRunState(projectDir, runId, state);
    writeFileSync(join(runsRoot(), runId, 'task_brief.md'), brief, 'utf-8');
    recordRequest({
      runId,
      projectDir,
      requestId,
      action: 'deploy',
      risk: 'external',
      title: 'Resume after review',
      createdAt: '2026-08-03T00:00:00.000Z',
      atIteration: 1,
    });

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/inbox/${runId}/${requestId}/resolve`,
      payload: { decision: 'approve' },
    });
    expect(rejected.statusCode).toBe(409);
    expect(spawns).toHaveLength(0);

    const review = rejected.json();
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/inbox/${runId}/${requestId}/resolve`,
      payload: {
        decision: 'approve',
        briefPreflightDigest: review.report.digest,
        briefPreflightReceipt: review.receipt,
        acknowledgeBriefWarnings: true,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ won: true, resumeRegistered: true });
    expect(spawns).toEqual([runId]);
    const persistedAdmission = readRunState(projectDir, runId).briefAdmission;
    expect(verifyBriefAdmission(brief, persistedAdmission).status).toBe('valid');
    expect(accepted.json().resumeRegistered).toBe(true);
  });
});

describe('durable daemon boundary', () => {
  it('rejects registration before registry or spawn side effects and binds a valid exact record', async () => {
    const registry = new TaskRegistry({ baseDir: join(fixtureRoot, 'registry') });
    const systemd = new CapturingSystemd();
    const orchestrator = new Orchestrator({
      registry,
      systemd,
      git: new NoopGit(),
      cliPath: join(repositoryRoot, 'src', 'cli.ts'),
      isProjectBusy: () => null,
    });
    await expect(orchestrator.register({ brief_text: 'unchecked prose', projectDir }))
      .rejects.toThrow(/Brief admission missing/);
    expect(registry.list()).toHaveLength(0);
    expect(systemd.commands).toHaveLength(0);

    const brief = 'admitted prose';
    const task = await orchestrator.register({
      brief_text: brief,
      brief_admission: explicitAdmission(brief),
      projectDir,
    });
    expect(task.status).toBe('running');
    expect(systemd.commands).toHaveLength(1);
    expect(systemd.commands[0]).toContain("'--brief-admission-record'");
    expect(systemd.commands[0]).not.toContain('--acknowledge-brief-warnings');
  });

  it('preserves admissions through sidecar externalization, JSONL round-trip, and compaction', () => {
    const registry = new TaskRegistry({ baseDir: join(fixtureRoot, 'registry') });
    const brief = '  exact brief with outer spaces  \n';
    const admission = explicitAdmission(brief);
    const created = registry.create({ brief_text: brief, brief_admission: admission, projectDir });
    registry.update(created.id, { notes: 'force a second row' });
    const compacted = registry.compact({ apply: true });
    expect(compacted.applied).toBe(true);
    const roundTrip = new TaskRegistry({ baseDir: join(fixtureRoot, 'registry') }).get(created.id)!;
    expect(roundTrip.brief_admission).toEqual(admission);
    expect(readFileSync(roundTrip.brief_path!, 'utf-8')).toBe(brief);
  });

  it('removes caller attempts to override daemon-owned text, project, binding, or acknowledgement', () => {
    const registry = new TaskRegistry({ baseDir: join(fixtureRoot, 'registry') });
    const brief = 'daemon-owned brief';
    const admission = explicitAdmission(brief);
    const task = registry.create({
      brief_text: brief,
      brief_admission: admission,
      projectDir,
      launch_args: [
        '--task', 'evil brief',
        '--project', 'evil-project',
        '--existing-run-id', 'evil-run',
        '--brief-admission-record', 'evil-record',
        '--acknowledge-brief-warnings',
        '--background',
        '-',
      ],
    });
    const command = buildCommand(task, join(repositoryRoot, 'src', 'cli.ts'));
    expect(command).not.toContain('evil brief');
    expect(command).not.toContain('evil-project');
    expect(command).not.toContain('evil-run');
    expect(command).not.toContain('evil-record');
    expect(command).not.toContain('--acknowledge-brief-warnings');
    expect(command).not.toContain("'--background'");
  });

  it('round-trips a brief containing shell metacharacters through the relaunch transport', () => {
    const registry = new TaskRegistry({ baseDir: join(fixtureRoot, 'registry') });
    // A single quote is what broke the raw `--task` transport: shellJoin escapes it
    // for bash, then systemd's own ExecStart unescaping mangles that escape, so the
    // relaunched CLI digested different bytes than the operator admitted and refused
    // to start. Assert the decoded bytes, not the command's shape.
    const brief = "# Goal\nKeep `return 'claude'` and \"quotes\" and a literal \\n intact.\n";
    const admission = explicitAdmission(brief);
    const task = registry.create({ brief_text: brief, brief_admission: admission, projectDir });
    const command = buildCommand(task, join(repositoryRoot, 'src', 'cli.ts'));

    expect(command).not.toContain("'--task'");
    const encoded = /'--brief-input-base64' '([A-Za-z0-9_-]+)'/.exec(command)?.[1];
    expect(encoded, command).toBeTruthy();
    expect(Buffer.from(encoded!, 'base64url').toString('utf8')).toBe(brief);
  });
});

describe('deferred continuation snapshots', () => {
  it('passes CLI Inbox resume the brief captured before the approval is consumed', async () => {
    const brief = '# Goal\nResume the captured Inbox brief.\n';
    const changed = `${brief}\n`;
    const admission = explicitAdmission(brief);
    const { runId } = createRun(projectDir, 'default', WORKFLOW, ['work']);
    const state = readRunState(projectDir, runId);
    state.status = 'parked';
    state.taskDescription = brief;
    state.briefAdmission = admission;
    state.parked = {
      requestId: 'captured-cli-resume',
      action: 'deploy',
      pausedAt: '2026-08-03T00:00:00.000Z',
      atIteration: 1,
    };
    writeRunState(projectDir, runId, state);
    const sidecar = join(runsRoot(), runId, 'task_brief.md');
    writeFileSync(sidecar, brief, 'utf-8');
    recordRequest({
      runId,
      projectDir,
      requestId: 'captured-cli-resume',
      action: 'deploy',
      risk: 'write',
      title: 'Resume captured CLI brief',
      createdAt: '2026-08-03T00:00:00.000Z',
      atIteration: 1,
    });

    let registeredTask: TaskCreateInput | undefined;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const code = await cmdInbox(['inbox', 'approve', 'captured-cli-resume'], {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      registerTask: async (task) => {
        writeFileSync(sidecar, changed, 'utf-8');
        registeredTask = task;
        return { id: 1, unit: 'private-resume', pid: process.pid, build: 'fixture' };
      },
    });

    expect(code).toBe(0);
    expect(registeredTask).toMatchObject({ run_id: runId, brief_text: brief, brief_admission: admission });
    expect(registeredTask?.launch_args).not.toContain('--task');
    expect(readFileSync(sidecar, 'utf-8')).toBe(changed);
  });
});

describe('quick and operator entry behavior', () => {
  it('prints the full report and stops plain text or a wrong digest before project writes', () => {
    const isolated = cliFixture();
    const plain = runQuickSync(isolated, ['quick', 'Fix the race', '--project', isolated.project]);
    expect(plain.status).toBe(2);
    expect(`${plain.stdout}${plain.stderr}`).toContain('Brief preflight');
    expect(`${plain.stdout}${plain.stderr}`).toContain('[plain_text_input]');
    expect(`${plain.stdout}${plain.stderr}`).toContain('no structurally extractable criterion');
    expect(`${plain.stdout}${plain.stderr}`).not.toContain('--acknowledge-brief-warnings=');
    expect(readProjectBrief(isolated.project)).toBeUndefined();

    const digestGuardedBrief = '# Goal\nFix the race.\n\n## What the report must show\n1. Preserve exact brief admission.\n';
    const wrong = runQuickSync(isolated, [
      'quick', digestGuardedBrief, '--project', isolated.project,
      '--acknowledge-brief-warnings=wrong-digest',
    ]);
    expect(wrong.status).toBe(2);
    expect(`${wrong.stdout}${wrong.stderr}`).toContain('digest mismatch');
    expect(readProjectBrief(isolated.project)).toBeUndefined();
  });

  it('keeps the bare automation flag non-interactive, prints findings, and registers exact stdin bytes', async () => {
    const isolated = cliFixture();
    const socketPath = join(isolated.fcHome, 'daemon.sock');
    let request: RpcRequest | undefined;
    const server = await startRpcServer(socketPath, (incoming) => {
      request = incoming;
      return { id: 7, unit: 'fixture.service', pid: process.pid, build: 'fixture' };
    });
    try {
      const exact = [
        '# Goal',
        'Automate the guarded submit.',
        '',
        '## What the report must show',
        '1. Preserve these exact stdin bytes through registration.',
        '',
      ].join('\n');
      writeReadySetupRecord(isolated.project, exact, isolated.fcHome);
      const result = await runQuick(isolated, [
        'quick', '--background', '--acknowledge-brief-warnings', '--project', isolated.project, '-',
      ], exact, socketPath);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Brief preflight');
      expect(result.stdout).toContain('[terminal_states_missing]');
      expect(request).toMatchObject({
        cmd: 'register',
        task: {
          brief_text: exact,
          brief_admission: { digest: inspectBrief(exact).digest },
        },
      });
      const task = (request as Extract<RpcRequest, { cmd: 'register' }>).task;
      expect(task.launch_args).not.toContain('--acknowledge-brief-warnings');
      expect(readProjectBrief(isolated.project)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('consumes adverse campaign hygiene as a no-flag skip default while explicit inherit wins', async () => {
    const isolated = cliFixture();
    const brief = '# Goal\nKeep campaign context bounded.\n\n## What the report must show\n1. Preserve an explicit context override.\n';
    writeReadySetupRecord(isolated.project, brief, isolated.fcHome);
    const campaignDir = join(isolated.project, '.fc', 'campaigns');
    mkdirSync(campaignDir, { recursive: true });
    writeFileSync(join(campaignDir, 'hygiene.jsonl'), [1, 2, 3].map((seq) => JSON.stringify({
      seq,
      runId: `adverse-${seq}`,
      kind: 'task_ended',
      pass: false,
      status: 'failed',
      timestamp: `2026-08-03T00:0${seq}:00.000Z`,
      campaignId: 'hygiene',
      campaignStorageKey: 'hygiene',
    })).join('\n') + '\n', 'utf-8');

    const socketPath = join(isolated.fcHome, 'daemon.sock');
    const requests: RpcRequest[] = [];
    const server = await startRpcServer(socketPath, (incoming) => {
      requests.push(incoming);
      return { id: requests.length, unit: 'fixture.service', pid: process.pid, build: 'fixture' };
    });
    try {
      const automatic = await runQuick(isolated, [
        'quick', '--background', '--acknowledge-brief-warnings', '--project', isolated.project,
        '--campaign', 'hygiene', '-',
      ], brief, socketPath);
      expect(automatic.code).toBe(0);
      expect(automatic.stderr).toContain('defaulted planner context to skip');
      expect((requests[0] as Extract<RpcRequest, { cmd: 'register' }>).task.launch_args)
        .toContain('--campaign-context=skip');

      const explicit = await runQuick(isolated, [
        'quick', '--background', '--acknowledge-brief-warnings', '--project', isolated.project,
        '--campaign', 'hygiene', '--campaign-context=inherit', '-',
      ], brief, socketPath);
      expect(explicit.code).toBe(0);
      expect(explicit.stderr).not.toContain('defaulted planner context to skip');
      const explicitArgs = (requests[1] as Extract<RpcRequest, { cmd: 'register' }>).task.launch_args;
      expect(explicitArgs).toContain('--campaign-context=inherit');
      expect(explicitArgs).not.toContain('--campaign-context=skip');
      console.info(`[ENGINE_INSTRUMENT_ITEM3] ${JSON.stringify({
        automatic: { stderr: automatic.stderr, launchArgs: (requests[0] as Extract<RpcRequest, { cmd: 'register' }>).task.launch_args },
        explicit: { stderr: explicit.stderr, launchArgs: explicitArgs },
      })}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('requires a fresh decision for missing existing-run admission and reuses a valid same-digest record', () => {
    const isolated = cliFixture();
    const runId = 'existing-fixture';
    const runPath = join(isolated.fcHome, 'runs', runId);
    mkdirSync(runPath, { recursive: true });
    const brief = '# Goal\nContinue exactly.\n\n## What the report must show\n1. Continue the admitted run snapshot.\n';
    writeFileSync(join(runPath, 'task_brief.md'), brief, 'utf-8');
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      runId,
      projectDir: isolated.project,
      status: 'failed',
      taskDescription: brief,
      stages: {},
    }), 'utf-8');

    const missing = runQuickSync(isolated, [
      'quick', '--existing-run-id', runId, '--project', isolated.project,
      '--adapter', 'mock', '--workflow', 'p11-missing',
    ]);
    expect(missing.status).toBe(2);
    expect(`${missing.stdout}${missing.stderr}`).toContain('Launch paused before run creation');

    const state = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf-8'));
    state.briefAdmission = explicitAdmission(brief);
    writeFileSync(join(runPath, 'run.json'), JSON.stringify(state), 'utf-8');
    const valid = runQuickSync(isolated, [
      'quick', '--existing-run-id', runId, '--project', isolated.project,
      '--adapter', 'mock', '--workflow', 'p11-missing',
    ]);
    expect(valid.status).toBe(1);
    expect(`${valid.stdout}${valid.stderr}`).toContain('Workflow not found: p11-missing.yaml');
    expect(`${valid.stdout}${valid.stderr}`).not.toContain('Launch paused before run creation');
  });

  it('binds a background continuation to its named run while a fresh background launch stays unbound', async () => {
    const isolated = cliFixture();
    const runId = 'background-existing-run';
    const runPath = join(isolated.fcHome, 'runs', runId);
    const brief = '# Goal\nContinue the named run.\n\n## What the report must show\n1. Preserve the existing run identity.\n';
    mkdirSync(runPath, { recursive: true });
    writeFileSync(join(runPath, 'task_brief.md'), brief, 'utf-8');
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      runId,
      projectDir: isolated.project,
      status: 'failed',
      taskDescription: brief,
      briefAdmission: explicitAdmission(brief),
      stages: {},
    }), 'utf-8');

    const socketPath = join(isolated.fcHome, 'daemon.sock');
    const requests: RpcRequest[] = [];
    const server = await startRpcServer(socketPath, (incoming) => {
      requests.push(incoming);
      return { id: requests.length, unit: `fixture-${requests.length}.service`, pid: process.pid, build: 'fixture' };
    });
    try {
      const resumed = await runQuick(isolated, [
        'quick', '--background', '--existing-run-id', runId,
        '--project', isolated.project, '--adapter', 'mock',
      ], '', socketPath);
      expect(resumed.code, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
      const resumedTask = (requests[0] as Extract<RpcRequest, { cmd: 'register' }>).task;
      expect(resumedTask.run_id).toBe(runId);

      writeReadySetupRecord(isolated.project, brief, isolated.fcHome);
      const fresh = await runQuick(isolated, [
        'quick', '--background', '--project', isolated.project, '--adapter', 'mock', '-',
        '--acknowledge-brief-warnings',
      ], brief, socketPath);
      expect(fresh.code, `${fresh.stdout}\n${fresh.stderr}`).toBe(0);
      const freshTask = (requests[1] as Extract<RpcRequest, { cmd: 'register' }>).task;
      expect(freshTask.run_id).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('uses an internally transported admitted snapshot instead of a later sidecar edit', () => {
    const isolated = cliFixture();
    const runId = 'transported-existing-fixture';
    const runPath = join(isolated.fcHome, 'runs', runId);
    mkdirSync(runPath, { recursive: true });
    const brief = '# Goal\nConsume the captured continuation.\n\n## What the report must show\n1. Use the transported admitted snapshot.\n';
    const admission = explicitAdmission(brief);
    writeFileSync(join(runPath, 'task_brief.md'), `${brief}\n`, 'utf-8');
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      runId,
      projectDir: isolated.project,
      status: 'failed',
      taskDescription: brief,
      briefAdmission: admission,
      stages: {},
    }), 'utf-8');

    const result = runQuickSync(isolated, [
      'quick',
      '--task', brief,
      '--brief-admission-record', Buffer.from(JSON.stringify(admission), 'utf8').toString('base64url'),
      '--existing-run-id', runId,
      '--project', isolated.project,
      '--adapter', 'mock',
      '--workflow', 'p11-transported-missing',
    ]);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`Digest: ${inspectBrief(brief).digest}`);
    expect(`${result.stdout}${result.stderr}`).toContain('Workflow not found: p11-transported-missing.yaml');
    expect(`${result.stdout}${result.stderr}`).not.toContain('Launch paused before run creation');
  });

  it('keeps /ship warning consent after rehearsal and before the exact-stdin launch', () => {
    const source = readFileSync(join(repositoryRoot, 'skills', 'ship.md'), 'utf-8');
    const rehearsal = source.indexOf('flowcrew rehearse docs/task_brief.md');
    const postReportQuestion = source.indexOf('Start this exact brief digest');
    const launch = source.indexOf('flowcrew quick --background', postReportQuestion);
    expect(rehearsal).toBeGreaterThan(0);
    expect(postReportQuestion).toBeGreaterThan(rehearsal);
    expect(launch).toBeGreaterThan(postReportQuestion);
    expect(source.slice(postReportQuestion, launch)).toContain('Wait for a new explicit answer');
    expect(source.slice(launch, launch + 700)).toContain('- < docs/task_brief.md');
    expect(source).toContain('Do not treat the original `/ship` request or an earlier “ship it” as');
  });

  it('gives stale Dashboard status an executable PID-and-port next step', async () => {
    let output = '';
    const code = await cmdDashboard(['dashboard', 'status', '--port', '43123'], {
      stdout: { write: (chunk) => { output += String(chunk); } },
      fetch: async () => new Response(JSON.stringify({
        freshness: 'stale',
        pid: 2468,
        startedAt: '2026-08-03T00:00:00.000Z',
        loadedBuild: { hash: 'old' },
        diskBuild: { hash: 'new' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    expect(code).toBe(2);
    expect(output).toContain('kill 2468 && PORT=43123 flowcrew start');
    expect(output).not.toMatch(/dashboard restart/);
  });
});

class CapturingSystemd implements SupervisorBackend {
  commands: string[] = [];
  async isActive(): Promise<UnitStatus> { return { kind: 'absent' }; }
  async runUnit(options: { command: string }): Promise<void> { this.commands.push(options.command); }
  async stopUnit(): Promise<void> {}
  async journalTail(): Promise<string> { return ''; }
}

class NoopGit implements GitAdapter {
  async findCommitByPrefix(): Promise<string | undefined> { return undefined; }
  async hasUncommittedChanges(): Promise<boolean> { return false; }
  async findCommitSince(): Promise<{ sha: string; subject: string } | undefined> { return undefined; }
}

interface CliFixture {
  root: string;
  home: string;
  fcHome: string;
  project: string;
  bin: string;
}

function cliFixture(): CliFixture {
  const root = join(fixtureRoot, `cli-${Math.random().toString(16).slice(2)}`);
  const home = join(root, 'home');
  const fcHome = join(root, 'fc');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  for (const directory of [home, fcHome, project, bin]) mkdirSync(directory, { recursive: true });
  // A stub agent CLI. These tests are about brief admission and registration,
  // not adapter discovery, but the submit path now refuses to register a run
  // that nothing could execute. Without this the whole file would pass or fail
  // according to whether the developer happens to have codex installed — which
  // is exactly the machine dependency the spec purity gate exists to prevent.
  const stub = join(bin, 'codex');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(stub, 0o755);
  return { root, home, fcHome, project, bin };
}

function runQuickSync(isolated: CliFixture, quickArgs: string[]) {
  return runCliSync(isolated, quickArgs);
}

function runCliSync(isolated: CliFixture, cliArgs: string[], input?: string) {
  return spawnSync(
    process.execPath,
    [join(repositoryRoot, 'dist', 'cli.js'), ...cliArgs],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: isolated.home,
        FC_HOME: isolated.fcHome,
        PROJECT_DIR: isolated.project,
        PATH: [isolated.bin, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
      input,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function runQuick(
  isolated: CliFixture,
  quickArgs: string[],
  stdin: string,
  socketPath: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, 'dist', 'cli.js'), ...quickArgs],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: isolated.home,
        FC_HOME: isolated.fcHome,
        PROJECT_DIR: isolated.project,
        FLOWCREW_DAEMON_SOCKET: socketPath,
        PATH: [isolated.bin, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('quick child timed out'));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

function readProjectBrief(targetProject: string): string | undefined {
  try { return readFileSync(join(targetProject, 'docs', 'task_brief.md'), 'utf-8'); }
  catch { return undefined; }
}
