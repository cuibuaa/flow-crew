import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { cmdInbox } from '../src/cli-inbox.js';
import { isValidApprovalRequestId } from '../src/approval-artifacts.js';
import {
  foldItems,
  recordRequest,
  resolveRequest,
} from '../src/inbox.js';
import {
  RUN_STATUS,
  readRunState,
  writeRunState,
  createRun,
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

  it('enforces approval request-id length, character, and Unicode boundaries', () => {
    expect(isValidApprovalRequestId('a'.repeat(64))).toBe(true);
    expect(isValidApprovalRequestId('a'.repeat(65))).toBe(false);
    expect(isValidApprovalRequestId('')).toBe(false);
    expect(isValidApprovalRequestId('approval/escape')).toBe(false);
    expect(isValidApprovalRequestId('审批请求')).toBe(false);
  });

  it('shows that a pending obligation belongs to an ended run without auto-closing it', async () => {
    const { runId } = createRun(projectDir, 'default', 'name: default\nstages: []\n', []);
    recordRequest({
      runId,
      projectDir,
      requestId: 'ended-run-cleanup',
      action: 'remove_generated_cache',
      risk: 'write',
      title: 'Review post-run cleanup',
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    const state = readRunState(projectDir, runId);
    state.status = RUN_STATUS.STOPPED;
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
