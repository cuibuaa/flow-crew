import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidApprovalRequestId } from '../src/approval-artifacts.js';
import {
  listStandingRules,
  recordRequest,
  resolveRequest,
} from '../src/inbox.js';
import {
  createRun,
  fcGlobalDir,
  setFcGlobalDir,
} from '../src/store.js';

let fixtureRoot: string;
let projectDir: string;
let priorFcRoot: string;

beforeAll(() => {
  priorFcRoot = fcGlobalDir();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-verify-all-fixes-'));
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

describe('verify-all-fixes QA probes', () => {
  it('mints a standing rule only for a winning always-approve decision', () => {
    const approvedRun = pendingRequest('qa-approved', 'deploy', 'target-approved');
    const deniedRun = pendingRequest('qa-denied', 'spend', 'target-denied');
    const oneShotRun = pendingRequest('qa-one-shot', 'publish', 'target-one-shot');

    expect(resolveRequest(projectDir, approvedRun, 'qa-approved', 'approve', {
      by: 'qa',
      always: true,
    }).won).toBe(true);
    expect(resolveRequest(projectDir, deniedRun, 'qa-denied', 'deny', {
      by: 'qa',
      always: true,
    }).won).toBe(true);
    expect(resolveRequest(projectDir, oneShotRun, 'qa-one-shot', 'approve', {
      by: 'qa',
    }).won).toBe(true);

    expect(listStandingRules().map(({ action, target }) => ({ action, target }))).toEqual([
      { action: 'deploy', target: 'target-approved' },
    ]);
  });

  it('enforces approval request-id length, character, and Unicode boundaries', () => {
    expect(isValidApprovalRequestId('a'.repeat(64))).toBe(true);
    expect(isValidApprovalRequestId('a'.repeat(65))).toBe(false);
    expect(isValidApprovalRequestId('')).toBe(false);
    expect(isValidApprovalRequestId('approval/escape')).toBe(false);
    expect(isValidApprovalRequestId('审批请求')).toBe(false);
  });
});
