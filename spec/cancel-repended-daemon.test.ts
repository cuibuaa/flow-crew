import './test-support/policy-runtime.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { assertContinuationCompatible } from '../src/engine-continuation.js';
import { sendRpc } from '../src/orchestrator-rpc.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { normalizeStageContracts, WorkflowConfigSchema } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import {
  beginStageAttempt, completeStageAttempt, fcGlobalDir, readRunState,
  readStageStatus, rependStageStatus, setFcGlobalDir, updateRunState, writeStageStatus,
} from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';

const repositoryRoot = join(import.meta.dirname, '..');
const distCli = join(repositoryRoot, 'dist/cli.js');
interface Harness {
  root: string;
  project: string;
  socket: string;
  env: NodeJS.ProcessEnv;
  daemon: ChildProcess;
  output: string;
  previousStore: string;
}
let harness: Harness | undefined;

afterEach(async () => {
  if (!harness) return;
  const fixture = harness;
  harness = undefined;
  // Every PID is read solely from supervision records in this fixture's root.
  const owned = new Set<number>();
  const supervision = join(fixture.root, 'supervise');
  if (existsSync(supervision)) for (const unit of readdirSync(supervision)) {
    try {
      const record = JSON.parse(readFileSync(join(supervision, unit, 'running.json'), 'utf8'));
      for (const pid of [record.shimPid, record.agentPid]) if (Number.isInteger(pid) && pid > 1) owned.add(pid);
    } catch { /* a completed unit may have removed its running record */ }
  }
  try { await sendRpc(fixture.socket, { cmd: 'stop' }, 500); } catch { /* fixture daemon already stopped */ }
  await waitUntil(() => fixture.daemon.exitCode !== null, 1_000);
  if (fixture.daemon.exitCode === null) fixture.daemon.kill('SIGTERM');
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of owned) {
      try { process.kill(-pid, signal); } catch { /* not a live fixture process group */ }
      try { process.kill(pid, signal); } catch { /* already exited */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await waitUntil(() => fixture.daemon.exitCode !== null, 1_000);
  await waitUntil(() => [...owned].every(pid => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }), 2_000);
  setFcGlobalDir(fixture.previousStore);
  rmSync(fixture.root, { recursive: true, force: true });
});

it.each([true, false])(
  'cancels and resumes a repended stage through a private daemon (matching pending ledger=%s)',
  { timeout: 65_000 },
  async matching => {
    const fixture = await createHarness();
    const brief = '# Goal\nComplete the cancellation continuation fixture.\n\n## What the report must show\n1. Retain completed work and finish the repended stage.\n';
    const admission = createBriefAdmission(inspectBrief(brief), {
      kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString(),
    });
    writeReadySetupRecord(fixture.project, brief, fixture.root);
    const workflow = WorkflowConfigSchema.parse({ name: 'cancel-repended-fixture', defaults: { max_iterations: 2, max_retries: 1 }, stages: [
      { id: 'done', role: 'coder', depends_on: [], scope: [], prompt_template: 'Earlier completed work.',
        artifact_contract: { version: 1, produces: [], reads: [] } },
      { id: 'done2', role: 'coder', depends_on: ['done'], scope: [], prompt_template: 'Earlier completed companion.',
        artifact_contract: { version: 1, produces: [], reads: [] } },
      { id: 'work', role: 'coder', depends_on: ['done2'], scope: [], prompt_template: 'Finish the repended work.',
        artifact_contract: { version: 1, produces: [], reads: [] } },
    ] });
    normalizeStageContracts(workflow.stages);
    const run = createRun(fixture.project, workflow.name, stringify(workflow), ['done', 'done2', 'work']);
    updateRunState(fixture.project, run.runId, state => {
      state.taskDescription = brief;
      state.briefAdmission = admission;
      state.currentIteration = 1;
      state.maxIterations = 2;
      state.maxRetries = 1;
      recordAdmittedPlan(state, workflow.stages, run.runDirPath, 'Admitted fixture before cancellation.');
    });
    for (const id of ['done', 'done2', 'work']) {
      beginStageAttempt(fixture.project, run.runId, id, 0);
      if (id === 'work') {
        completeStageAttempt(fixture.project, run.runId, id, 0, { exitCode: 124, duration_ms: 1 });
        beginStageAttempt(fixture.project, run.runId, id, 1);
      }
      completeStageAttempt(fixture.project, run.runId, id, id === 'work' ? 1 : 0, { exitCode: 0, duration_ms: 1 });
    }
    const done = readStageStatus(fixture.project, run.runId, 'done');
    const done2 = readStageStatus(fixture.project, run.runId, 'done2');
    const priorWork = readStageStatus(fixture.project, run.runId, 'work');
    expect(priorWork.retries).toBe(1);
    // terminal.ts/research-progress.ts publish a pending ledger this way; the
    // iteration driver can also retain the previous settled ledger.
    if (matching) writeStageStatus(fixture.project, run.runId, 'work', rependStageStatus(priorWork, 0));
    else updateRunState(fixture.project, run.runId, state => { state.stages.work = rependStageStatus(state.stages.work, 0); });
    const ledgerPath = join(run.runDirPath, 'stages/work/status.json');
    const ledgerBeforeCancel = readFileSync(ledgerPath, 'utf8');
    const registry = new TaskRegistry({ baseDir: fixture.root });
    const task = registry.create({ projectDir: fixture.project, brief_text: brief, brief_admission: admission,
      run_id: run.runId, status: 'deferred', launch_args: ['--adapter', 'mock', '--no-campaign'],
    });
    registry.update(task.id, { not_before: '2099-01-01T00:00:00.000Z', defer_kind: 'wait' });

    const cancelled = cli(fixture, ['task', 'cancel', String(task.id)]);
    expect(cancelled.status, cancelled.stdout + cancelled.stderr).toBe(0);
    expect(cancelled.stdout).toContain(`Task #${task.id} cancelled`);
    expect(() => assertContinuationCompatible(fixture.project, run.runId)).not.toThrow();
    expect(readRunState(fixture.project, run.runId)).toMatchObject({ status: 'cancelled', failureReason: 'Cancelled by user',
      stages: { done, done2, work: { status: 'pending', attempts: priorWork.attempts } } });
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBeforeCancel);

    const resumed = cli(fixture, ['task', 'resume', String(task.id)]);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain(`Task #${task.id}`);
    const complete = await waitUntil(() => readRunState(fixture.project, run.runId).status === 'complete', 45_000);
    const current = registry.get(task.id)!;
    const tail = cli(fixture, ['task', 'tail', String(task.id)]);
    expect(complete, `${JSON.stringify(readRunState(fixture.project, run.runId))}\n${tail.stdout}${tail.stderr}\n${fixture.output}`).toBe(true);
    expect(readRunState(fixture.project, run.runId).stages.done).toEqual(done);
    expect(readStageStatus(fixture.project, run.runId, 'done')).toEqual(done);
    expect(readRunState(fixture.project, run.runId).stages.done2).toEqual(done2);
    expect(readStageStatus(fixture.project, run.runId, 'done2')).toEqual(done2);
    expect(readStageStatus(fixture.project, run.runId, 'work').attempts).toHaveLength(3);
    expect(readStageStatus(fixture.project, run.runId, 'work').attempts?.[0]).toMatchObject(priorWork.attempts![0]);
    expect(readStageStatus(fixture.project, run.runId, 'work').attempts?.[1]).toMatchObject({ ...priorWork.attempts?.[1], disposition: 'superseded' });
    const exitPath = join(fixture.root, 'supervise', current.systemd_unit.replace(/[^a-zA-Z0-9_.-]/g, '_'), 'exit.json');
    expect(await waitUntil(() => existsSync(exitPath), 3_000)).toBe(true);
    expect(JSON.parse(readFileSync(exitPath, 'utf8'))).toMatchObject({ exitCode: 0 });
  },
);

async function createHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'fc-cr-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const mock = join(root, 'mock');
  for (const directory of [home, project, bin, mock]) mkdirSync(directory);
  for (const command of ['bash', 'sh', 'git', 'ps']) {
    const path = [`/bin/${command}`, `/usr/bin/${command}`].find(existsSync);
    if (!path) throw new Error(`fixture command unavailable: ${command}`);
    symlinkSync(path, join(bin, command));
  }
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(home, '.bash_profile'), `export PATH='${bin}'\n`);
  writeFileSync(join(mock, 'work.json'), JSON.stringify({ output_text: 'Repended work completed.', exit_code: 0, tokens_in: 0, tokens_out: 0 }));
  // No done.json/done2.json: repeating either completed stage fails the workflow.
  const socket = join(root, 'daemon.sock');
  const env = { ...process.env, HOME: home, FC_HOME: root, PROJECT_DIR: project, PATH: bin,
    FLOWCREW_DAEMON_SOCKET: socket, MOCK_FIXTURE_DIR: mock, NO_COLOR: '1' };
  const previousStore = fcGlobalDir();
  setFcGlobalDir(root);
  const daemon = spawn(process.execPath, [distCli, 'daemon', 'serve', '--socket', socket], {
    cwd: repositoryRoot, env: { ...env, HOME: home, FC_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fixture: Harness = { root, project, socket, env, daemon, output: '', previousStore };
  harness = fixture;
  daemon.stdout?.on('data', chunk => { fixture.output += String(chunk); });
  daemon.stderr?.on('data', chunk => { fixture.output += String(chunk); });
  const ready = await waitUntil(async () => {
    if (!existsSync(socket) || daemon.exitCode !== null) return false;
    try { await sendRpc(socket, { cmd: 'status' }, 300); return true; } catch { return false; }
  }, 5_000);
  if (!ready) throw new Error(`private daemon failed to start: ${fixture.output}`);
  return fixture;
}

function cli(fixture: Harness, args: string[]) {
  return spawnSync(process.execPath, [distCli, ...args], { cwd: repositoryRoot, env: { ...fixture.env, HOME: join(fixture.root, 'home'), FC_HOME: fixture.root },
    encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return check();
}
