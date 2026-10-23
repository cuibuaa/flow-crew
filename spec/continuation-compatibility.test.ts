import './test-support/policy-runtime.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { assertContinuationCompatible } from '../src/engine-continuation.js';
import { Orchestrator } from '../src/orchestrator.js';
import { startRpcServer } from '../src/orchestrator-rpc.js';
import { captureEngineCheckpoint } from '../src/restart-recovery.js';
import { normalizeStageContracts, WorkflowConfigSchema } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, completeStageAttempt, interruptedStageStatus, fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { TaskRegistry } from '../src/task-registry.js';

let root: string, project: string, previous: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-continuation-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
});
afterEach(() => {
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});

function cancelled(retry = false) {
  const workflow = WorkflowConfigSchema.parse({ name: 'legacy-cancellation', defaults: { max_iterations: 1, max_retries: 0 },
    stages: ['work'].map((id, index, ids) => ({ id, role: 'coder', scope: [],
      depends_on: index ? [ids[index - 1]] : [], prompt_template: 'Complete fixture.',
      artifact_contract: { version: 1, produces: [], reads: [] } })) });
  normalizeStageContracts(workflow.stages);
  const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
  if (retry) {
    beginStageAttempt(project, created.runId, 'work', 0);
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 124, duration_ms: 1, error: 'Attempt deadline exceeded' });
  }
  beginStageAttempt(project, created.runId, 'work', Number(retry));
  // A real, exited controller supplies positive death evidence without a
  // hard-coded PID that another machine could own.
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', cwd: project,
    env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() } }).trim());
  updateRunState(project, created.runId, state => {
    state.engineCheckpoint = { ...captureEngineCheckpoint(project, created.runId), pid: deadPid, processStart: undefined, processes: [] };
    state.status = 'cancelled'; state.failureReason = 'Cancelled by user'; state.completedAt = new Date().toISOString();
    state.stages.work.status = 'failed';
  });
  // Bypass today's writer to preserve the literal status in legacy run.json.
  const path = join(created.runDirPath, 'run.json');
  const legacy = JSON.parse(readFileSync(path, 'utf8'));
  if (legacy.status === 'cancelled') legacy.status = 'stopped';
  writeFileSync(path, JSON.stringify(legacy));
  return created;
}

it.each(['index', 'start time'] as const)('refuses matching malformed %s history in both carriers', field => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const stage = interruptedStageStatus(raw.stages.work, raw.completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user');
  if (field === 'index') stage.attempts![0].index = 2;
  else stage.attempts![0].startedAt = 'invalid';
  raw.stages.work = stage;
  writeFileSync(rawPath, JSON.stringify(raw));
  writeFileSync(ledgerPath, JSON.stringify(stage));
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('invalid attempt history');
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readStageStatus(project, created.runId, 'work')).toEqual(stage);
});

it.each(['stage', 'attempt'] as const)('refuses an unknown ledger %s status despite proven owner death', carrier => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.stages.work = interruptedStageStatus(raw.stages.work, raw.completedAt, 'CANCELLED_INTERRUPTED: Cancelled by user');
  const ledger = structuredClone(raw.stages.work);
  if (carrier === 'stage') ledger.status = 'unknown';
  else ledger.attempts[0].status = 'unknown';
  writeFileSync(rawPath, JSON.stringify(raw));
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow(
    carrier === 'stage' ? 'invalid stage record' : 'invalid attempt history',
  );
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readStageStatus(project, created.runId, 'work')).toEqual(ledger);
});

it('refuses an unsupported projection status before normalizing its interrupted attempt', () => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.stages.work.status = 'unknown';
  writeFileSync(rawPath, JSON.stringify(raw));
  const ledger = readFileSync(ledgerPath, 'utf8');
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('invalid stage record');
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger);
});

it.each([null, false, 0, ''])('refuses an existing falsy JSON ledger %j for an unstarted stage', ledger => {
  const created = cancelled();
  const rawPath = join(created.runDirPath, 'run.json');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.stages.work.status = 'pending';
  raw.stages.work.attempts = [];
  delete raw.engineCheckpoint;
  writeFileSync(rawPath, JSON.stringify(raw));
  const persistedLedger = JSON.stringify(ledger);
  writeFileSync(ledgerPath, persistedLedger);
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow('invalid stage record');
  expect(readRunState(project, created.runId).stages).toEqual(raw.stages);
  expect(readFileSync(ledgerPath, 'utf8')).toBe(persistedLedger);
});

it.each(['attempt disagreement', 'invalid budget'] as const)('refuses %s in settled execution records', kind => {
  const created = cancelled();
  const path = join(created.runDirPath, 'run.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const stage = interruptedStageStatus(raw.stages.work, raw.completedAt, 'Fixture interruption');
  const settledLedger = structuredClone(stage);
  if (kind === 'attempt disagreement') stage.attempts![0].index++;
  else raw.maxIterations = 0;
  raw.stages.work = stage;
  writeFileSync(path, JSON.stringify(raw));
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  writeFileSync(ledgerPath, JSON.stringify(settledLedger));
  const before = readFileSync(path, 'utf8');
  const ledger = readFileSync(ledgerPath, 'utf8');
  expect(() => assertContinuationCompatible(project, created.runId)).toThrow(
    kind === 'attempt disagreement' ? 'invalid attempt history' : 'invalid maxIterations budget',
  );
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger);
});

it.each(['running', 'closed', 'ledger-only', 'projection-only', 'summary-only', 'historical'] as const)(
  'refuses legacy stopped cancellation with %s unsettled work without rewriting it', kind => {
    const created = cancelled(kind === 'historical');
    const path = join(created.runDirPath, 'run.json');
    const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const ledger = readStageStatus(project, created.runId, 'work');
    if (kind === 'closed') {
      Object.assign(ledger.attempts!.at(-1)!, { status: 'closed', completedAt: raw.completedAt, duration_ms: 1, exitCode: 0, tokenUsage: 'unknown' });
      raw.stages.work = { ...ledger, status: 'failed' };
    }
    if (kind === 'ledger-only') raw.stages.work = interruptedStageStatus(raw.stages.work, raw.completedAt, 'Fixture interruption');
    if (kind === 'projection-only') Object.assign(ledger, interruptedStageStatus(ledger, raw.completedAt, 'Fixture interruption'));
    if (kind === 'summary-only') {
      raw.stages.work.status = ledger.status = 'running';
      raw.stages.work.attempts = ledger.attempts = [];
    }
    if (kind === 'historical') raw.stages.work.attempts[0].status = ledger.attempts![0].status = 'running';
    writeFileSync(path, JSON.stringify(raw));
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const before = readFileSync(path, 'utf8');
    const beforeLedger = readFileSync(ledgerPath, 'utf8');
    expect(JSON.parse(before).status).toBe('stopped');
    expect(readRunState(project, created.runId).status).toBe('cancelled');
    const message = 'CONTINUATION_INCOMPATIBLE: unsettled attempt in work; restart recovery is required'
      + (kind === 'projection-only' ? '; attempt ledger is ahead of stage projection for work' : '');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => assertContinuationCompatible(project, created.runId)).toThrow(new Error(message));
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(readFileSync(ledgerPath, 'utf8')).toBe(beforeLedger);
    }
  },
);

it('returns CLI exit 1 with a stable refusal when resuming legacy stopped cancellation through RPC', async () => {
  const created = cancelled();
  const path = join(created.runDirPath, 'run.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const brief = '# Goal\nComplete the fixture.\n\n# Acceptance criteria\n1. The fixture is complete.';
  const admission = createBriefAdmission(inspectBrief(brief), { kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString() });
  raw.taskDescription = brief; raw.briefAdmission = admission;
  writeFileSync(path, JSON.stringify(raw));
  const before = readFileSync(path, 'utf8');
  const ledgerPath = join(created.runDirPath, 'stages/work/status.json');
  const ledger = readFileSync(ledgerPath, 'utf8');
  const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
  const task = registry.create({ kind: 'quick', name: 'Legacy cancellation', projectDir: project,
    brief_text: brief, brief_admission: admission, status: 'cancelled', run_id: created.runId });
  const orchestrator = new Orchestrator({ registry });
  const socketPath = join(root, 'command.sock');
  const server = await startRpcServer(socketPath, async request => {
    if (request.cmd !== 'resume') throw new Error('Unexpected request');
    const queued = await orchestrator.resume(request.id);
    return { new_attempt: queued.attempt, unit: queued.systemd_unit };
  });
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [new URL('../dist/cli.js', import.meta.url).pathname,
        'task', 'resume', String(task.id), '--socket', socketPath], {
        cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() }, timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('CONTINUATION_INCOMPATIBLE: unsettled attempt in work; restart recovery is required\n');
    expect(result.stdout).toBe('');
    expect(registry.get(task.id)).toEqual(task);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('decides continuation from execution records without reading failureReason prose', () => {
  const source = readFileSync(new URL('../src/engine-continuation.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\bfailureReason\b/);
});
