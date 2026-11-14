import './test-support/policy-runtime.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReadySetupRecord } from './test-support/ready-setup.js';
import { fcGlobalDir, writeStageStatus } from '../src/store.js';
import { assertMeasuredSetupLaunch, inspectShipSetupRecord } from '../src/ship-setup-record.js';
import { createRun } from './test-support/create-run.js';
import { runRecordPath } from '../src/run-layout.js';
import { recordGateValidationDelta } from '../src/scheduler/sched_settlement/gate-validation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = () => { const root = mkdtempSync(join(tmpdir(), 'setup-completion-')); roots.push(root); return root; };
const brief = '# Setup completion';

it('refuses launch without acknowledgement when a persisted completion flag is not a boolean', () => {
  for (const unfinished of ['true', 1]) {
    const root = project();
    const path = writeReadySetupRecord(root, brief, fcGlobalDir());
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.validationBaseline.results[0].exitCode = 0;
    record.validationBaseline.results[0].unfinished = unfinished;
    writeFileSync(path, JSON.stringify(record));
    expect(inspectShipSetupRecord(root, brief).state).toBe('ready');
    expect(() => assertMeasuredSetupLaunch(root, brief)).toThrow('setup_acknowledgement_required');
  }
});

it('publishes no validation reference for a retained continuation when commands are configured', async () => {
  const root = project();
  const run = createRun(root, 'continuation', 'name: continuation\nstages: []\n', ['review']);
  writeFileSync(runRecordPath(run.runDirPath, 'validation_baseline.json'), JSON.stringify({ version: 1, baseline: {
    version: 1, projectDir: root, discovery: { state: 'configured', commands: [{ role: 'test', command: 'fixture', args: [], display: 'fixture' }], missingRoles: [] }, results: [],
  } }));
  writeStageStatus(root, run.runId, 'review', { status: 'complete', retries: 0,
    continuation: { reason: 'stage_budget', forced: true },
    attempts: [{ index: 1, startedAt: 'start', completedAt: 'end', status: 'complete', exitCode: 0 }] } as never);
  expect(await recordGateValidationDelta(root, run.runId, 'review')).toBeUndefined();
  expect(existsSync(runRecordPath(run.runDirPath, 'validation_delta_review.json'))).toBe(false);
});
