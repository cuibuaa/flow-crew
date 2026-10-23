import './test-support/policy-runtime.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { DaemonUnavailableError, RpcOutcomeUnknownError } from '../src/orchestrator-rpc.js';
import { cmdInbox } from '../src/cli-inbox.js';
import { approvalArtifactPath, isValidApprovalRequestId } from '../src/approval-artifacts.js';
import { createApprovalMonitor } from '../src/scheduler/sched_policy/approvals.js';
import {
  foldItems,
  recordRequest,
  resolveRequest,
} from '../src/inbox.js';
import { createRun } from './test-support/create-run.js';
import {
  RUN_STATUS,
  readRunState,
  writeRunState,
  runDir,
  fcGlobalDir,
  setFcGlobalDir,
} from '../src/store.js';

let fixtureRoot: string;
let projectDir: string;
let priorFcRoot: string;

beforeAll(() => {
  priorFcRoot = fcGlobalDir();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-approval-policy-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  setFcGlobalDir(join(fixtureRoot, 'fc-home'));
});

afterAll(() => {
  setFcGlobalDir(priorFcRoot);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function pendingRequest(requestId: string, action: string, target: string) {
  const { runId } = createRun(projectDir, 'default', 'name: default\nstages: []\n', []);
  recordRequest({
    runId,
    projectDir,
    requestId,
    action,
    target,
    risk: 'external',
    title: `${action} ${target}`,
    createdAt: new Date().toISOString(),
  });
  return runId;
}

describe('approval policy and request identifiers', () => {
  it('publishes only the winning human resolution as an operator event', () => {
    const runId = pendingRequest('operator-deploy', 'deploy', 'production');
    expect(resolveRequest(projectDir, runId, 'operator-deploy', 'approve', { by: 'operator' }).won).toBe(true);
    expect(resolveRequest(projectDir, runId, 'operator-deploy', 'deny', { by: 'late-operator' }).won).toBe(false);
    const events = readFileSync(join(runDir(projectDir, runId), 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'approval_resolved')).toEqual([
      expect.objectContaining({ requestId: 'operator-deploy', decision: 'accepted', source: 'operator' }),
    ]);
  });

  it.each([
    ['unavailable', new DaemonUnavailableError(), 0],
    ['refused', new Error('daemon refused resume'), 0],
    ['unknown', new RpcOutcomeUnknownError('response lost after write'), 2],
  ])('keeps the recorded approval when resume is %s', async (_kind, failure, expected) => {
    const runId = pendingRequest('resume-publish', 'publish', 'result');
    const brief = '# Goal\nPublish the verified report.\n\n## What the report must show\n1. The report contains verified evidence.\n';
    const report = inspectBrief(brief);
    const state = readRunState(projectDir, runId);
    state.status = RUN_STATUS.PARKED;
    state.taskDescription = brief;
    state.briefAdmission = createBriefAdmission(report, report.requiresAcknowledgement
      ? { kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString() }
      : { kind: 'not_required' });
    writeRunState(projectDir, runId, state);
    const output = new PassThrough();
    let messages = '';
    output.on('data', chunk => { messages += chunk; });
    const code = await cmdInbox(['inbox', 'approve', 'resume-publish', '--run', runId], {
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: output as unknown as NodeJS.WriteStream,
      registerTask: async () => { throw failure; },
    });
    expect(foldItems(runId).get('resume-publish')?.state).toBe('approved');
    expect(code).toBe(expected);
    expect(messages).toContain('approved');
    if (expected === 0) expect(messages).toContain('resume was not queued');
  });

  it('reports a lost approval race as a known refusal', async () => {
    const runId = pendingRequest('raced', 'publish', 'result');
    resolveRequest(projectDir, runId, 'raced', 'deny', { by: 'first' });
    const output = new PassThrough();
    expect(await cmdInbox(['inbox', 'approve', 'raced', '--run', runId, '--no-resume'], {
      stdout: output as unknown as NodeJS.WriteStream, stderr: output as unknown as NodeJS.WriteStream,
    })).toBe(1);
    expect(foldItems(runId).get('raced')?.resolution?.decision).toBe('deny');
  });

  it('enforces approval request-id length, character, and Unicode boundaries', () => {
    expect(isValidApprovalRequestId('a'.repeat(64))).toBe(true);
    expect(isValidApprovalRequestId('a'.repeat(65))).toBe(false);
    expect(isValidApprovalRequestId('')).toBe(false);
    expect(isValidApprovalRequestId('approval/escape')).toBe(false);
    expect(isValidApprovalRequestId('审批请求')).toBe(false);
    for (const requestId of ['../escape', 'approval\\escape', '/outside']) {
      expect(() => approvalArtifactPath(projectDir, requestId, 'request')).toThrow('unsafe approval request id');
    }
    for (const requestId of ['..safe', '.', '..']) {
      const runId = pendingRequest(requestId, 'publish', 'result');
      const directory = runDir(projectDir, runId);
      expect(approvalArtifactPath(directory, requestId, 'request')).toBe(join(directory, 'approvals', `${requestId}.request.json`));
      expect(resolveRequest(projectDir, runId, requestId, 'approve').won).toBe(true);
      expect(JSON.parse(readFileSync(join(directory, 'approvals', `${requestId}.decision.json`), 'utf8'))).toMatchObject({ decision: 'approve' });
    }
  });

  it('shows that a pending obligation belongs to an ended run without auto-closing it', async () => {
    const { runId } = createRun(projectDir, 'default', 'name: default\nstages: []\n', []);
    recordRequest({
      runId,
      projectDir,
      requestId: 'ended-run-cleanup',
      action: 'remove_user_data',
      risk: 'external',
      title: 'Review external cleanup',
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    const state = readRunState(projectDir, runId);
    state.status = RUN_STATUS.CANCELLED;
    state.completedAt = '2026-09-18T00:00:00.000Z';
    writeRunState(projectDir, runId, state);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let rendered = '';
    stdout.setEncoding('utf-8');
    stdout.on('data', (chunk: string) => { rendered += chunk; });

    expect(await cmdInbox(['inbox', 'list', '--state', 'pending'], {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    })).toBe(0);

    expect(rendered).toContain('ENDED');
    expect(rendered).toContain('ended-run-cleanup');
    expect(foldItems(runId).get('ended-run-cleanup')).toMatchObject({ state: 'pending' });
  });
});

describe('approval necessity follows authority', () => {
  async function inspect(action: string, risk: 'exec' | 'write' | 'unknown' | 'external', target: (run: string) => string, stageId = 'work') {
    const { runId, runDirPath } = createRun(projectDir, 'default', 'name: default\nstages: []\n', ['work', 'peer']);
    const slot = join(runDirPath, 'stages', 'work', 'approval_request.json');
    mkdirSync(join(runDirPath, 'stages', 'work'), { recursive: true });
    writeFileSync(slot, JSON.stringify({ id: 'request', action, risk, target: target(runDirPath), stageId }));
    const monitor = createApprovalMonitor({ writeCampaignEntryUnlessPaused() {} });
    const parked = await monitor.tryParkOnApprovalRequest(readRunState(projectDir, runId), {
      projectDir, runId, runDirPath, iteration: 1,
    });
    return { parked, runId, runDirPath, item: foldItems(runId).get('request')! };
  }

  it('acknowledges stage scratch once without parking or an operator decision', async () => {
    const result = await inspect('validate', 'exec', run => join(run, 'stages/work/build/candidate'));
    expect(result.parked).toBeNull();
    expect(result.item).toMatchObject({ state: 'approved', resolution: { by: 'engine', source: 'scheduler' } });
    const decision = JSON.parse(readFileSync(join(result.runDirPath, 'approvals/request.decision.json'), 'utf8'));
    expect(decision).toMatchObject({ decision: 'approve', by: 'engine' });
    expect(decision.reason).toContain('no external effects');
    const monitor = createApprovalMonitor({ writeCampaignEntryUnlessPaused() {} });
    await monitor.tryParkOnApprovalRequest(readRunState(projectDir, result.runId), {
      projectDir, runId: result.runId, runDirPath: result.runDirPath, iteration: 1,
    });
    const log = readFileSync(join(result.runDirPath, 'approvals.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(log.map(record => record.kind)).toEqual(['request', 'resolution']);
    const events = readFileSync(join(result.runDirPath, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(event => event.type === 'approval_parked')).toBe(false);
    expect(events.filter(event => event.type === 'approval_resolved')).toEqual([
      expect.objectContaining({ source: 'scheduler', decision: 'accepted' }),
    ]);
  });

  it.each([
    'run.json', 'approvals/request.decision.json', 'stages/work/status.json',
    'stages/peer/build/candidate',
  ])('refuses %s without offering a human override', async target => {
    const result = await inspect('mutate', 'write', run => join(run, target), 'peer');
    expect(result.parked).toBeNull();
    expect(result.item).toMatchObject({ stageId: 'work', state: 'denied', resolution: { source: 'scheduler' } });
  });

  it('refuses a link to external data even when the lexical target is stage scratch', async () => {
    const external = join(fixtureRoot, 'external-data');
    mkdirSync(external, { recursive: true });
    const result = await inspect('validate', 'exec', run => {
      symlinkSync(external, join(run, 'stages/work/build'));
      return join(run, 'stages/work/build/candidate');
    });
    expect(result.parked).toBeNull();
    expect(result.item.state).toBe('denied');
  });

  it('refuses an ambiguous permission request instead of parking', async () => {
    const result = await inspect('configure_environment', 'unknown', () => 'executor environment');
    expect(result.parked).toBeNull();
    expect(result.item.state).toBe('denied');
  });

  it('resolves a relative link before its following parent traversal', async () => {
    const external = join(fixtureRoot, 'external-tree', 'child');
    mkdirSync(external, { recursive: true });
    const result = await inspect('validate', 'exec', run => {
      symlinkSync(external, join(run, 'stages/work/link'));
      return ['stages/work/link', '..', 'candidate'].join('/');
    });
    expect(result.parked).toBeNull();
    expect(result.item.state).toBe('denied');
  });

  it('keeps explicit external effects pending even when their output is stage scratch', async () => {
    const result = await inspect('use_shared_device', 'external', run => join(run, 'stages/work/build/candidate'));
    expect(result.parked?.status).toBe(RUN_STATUS.PARKED);
    expect(result.item.state).toBe('pending');
    expect(resolveRequest(projectDir, result.runId, 'request', 'deny').won).toBe(true);
    expect(resolveRequest(projectDir, result.runId, 'request', 'approve').won).toBe(false);
  });

  it('settles a historical non-external request through the same authority owner', async () => {
    const { runId, runDirPath } = createRun(projectDir, 'default', 'name: default\nstages: []\n', ['work']);
    writeFileSync(join(runDirPath, 'approvals.jsonl'), JSON.stringify({
      kind: 'request', requestId: 'historic', projectDir, runId, action: 'validate', risk: 'exec',
      target: join(runDirPath, 'stages/work/build/candidate'), stageId: 'work', title: 'Validate', createdAt: new Date().toISOString(),
    }) + '\n');
    const monitor = createApprovalMonitor({ writeCampaignEntryUnlessPaused() {} });
    expect(await monitor.tryParkOnApprovalRequest(readRunState(projectDir, runId), {
      projectDir, runId, runDirPath, iteration: 1,
    })).toBeNull();
    expect(foldItems(runId).get('historic')).toMatchObject({ state: 'approved', resolution: { source: 'scheduler' } });
  });

  it('refuses a human override of an unclassified historical request', () => {
    const { runId, runDirPath } = createRun(projectDir, 'default', 'name: default\nstages: []\n', ['work']);
    writeFileSync(join(runDirPath, 'approvals.jsonl'), JSON.stringify({
      kind: 'request', requestId: 'historic', projectDir, runId, action: 'configure', risk: 'unknown',
      stageId: 'work', title: 'Configure', createdAt: new Date().toISOString(),
    }) + '\n');
    const result = resolveRequest(projectDir, runId, 'historic', 'approve');
    expect(result.won).toBe(false);
    expect(result.item).toMatchObject({ state: 'denied', resolution: { by: 'engine', source: 'scheduler' } });
  });
});
