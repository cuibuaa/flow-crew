import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { cmdInbox } from '../src/cli-inbox.js';
import {
  foldItems,
  matchStandingRule,
  recordRequest,
  resolveRequest,
  standingRuleEligible,
} from '../src/inbox.js';
import {
  createRun,
  fcGlobalDir,
  runDir,
  setFcGlobalDir,
} from '../src/store.js';

let fixtureRoot: string;
let projectDir: string;
let priorFcRoot: string;

beforeEach(() => {
  priorFcRoot = fcGlobalDir();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-approval-standing-rules-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  setFcGlobalDir(join(fixtureRoot, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(priorFcRoot);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('operator approval standing rules', () => {
  it('C3 explicit project action-pattern rule auto-approves unknown risk and identifies the rule event', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const args = [
      'inbox', 'rules', 'add',
      '--project', join(projectDir, '.'),
      '--action', 'launch_*training*',
      'approve',
    ];

    expect(await cmdInbox(args, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    })).toBe(0);

    const ruleFile = join(fcGlobalDir(), 'approval-rules.jsonl');
    expect(existsSync(ruleFile)).toBe(true);
    const ruleRows = readFileSync(ruleFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0]).toMatchObject({
      version: 1,
      kind: 'standing_rule',
      id: expect.any(String),
      projectDir: resolve(projectDir),
      actionPattern: 'launch_*training*',
      decision: 'approve',
      grantedBy: expect.any(String),
      grantedAt: expect.any(String),
    });

    // Adding the same explicit grant is idempotent and preserves the event identity.
    const duplicateOut = new PassThrough();
    expect(await cmdInbox(args, {
      stdout: duplicateOut as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    })).toBe(0);
    const duplicateRows = readFileSync(ruleFile, 'utf-8')
      .trim()
      .split('\n');
    expect(duplicateRows).toHaveLength(1);

    const { runId } = createRun(projectDir, 'default', 'name: default\nstages: []\n', []);
    const request = recordRequest({
      runId,
      projectDir,
      requestId: 'unknown-training',
      action: 'launch_long_shared_gpu_training',
      target: 'round-01',
      risk: 'unknown',
      title: 'Launch long shared GPU training',
      createdAt: '2026-09-14T12:00:00.000Z',
      stageId: 'run_round',
    }).item;
    expect(standingRuleEligible(request)).toMatchObject({ ok: false });
    const matchingRule = matchStandingRule(request);
    expect(matchingRule).toMatchObject({
      id: ruleRows[0].id,
      actionPattern: 'launch_*training*',
      projectDir: resolve(projectDir),
    });

    const resolution = resolveRequest(projectDir, runId, request.requestId, 'approve', {
      by: 'standing-rule',
      viaRule: matchingRule?.id,
    });
    expect(resolution.won).toBe(true);
    expect(foldItems(runId).get(request.requestId)?.resolution).toMatchObject({
      decision: 'approve',
      by: 'standing-rule',
      viaRule: ruleRows[0].id,
    });
    const resolutionEvent = readFileSync(join(runDir(projectDir, runId), 'approvals.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.kind === 'resolution');
    expect(resolutionEvent).toMatchObject({
      kind: 'resolution',
      requestId: request.requestId,
      decision: 'approve',
      viaRule: ruleRows[0].id,
    });

    const unmatched = recordRequest({
      runId,
      projectDir,
      requestId: 'unknown-nonmatching-action',
      action: 'collect_training_metrics',
      risk: 'unknown',
      title: 'Collect metrics without an explicit standing grant',
      createdAt: '2026-09-14T12:01:00.000Z',
      stageId: 'run_round',
    }).item;
    expect(matchStandingRule(unmatched)).toBeUndefined();
    expect(foldItems(runId).get(unmatched.requestId)).toMatchObject({ state: 'pending' });

    expect(matchStandingRule({ ...request, projectDir: join(fixtureRoot, 'other-project') })).toBeUndefined();
    expect(matchStandingRule({ ...request, action: 'prelaunch_long_shared_gpu_training' })).toBeUndefined();
  });
});
