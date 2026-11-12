import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { reconcileResearchConclusion } from '../src/scheduler/sched_policy/run-completion.js';
import { renderRunSummary } from '../src/run-summary.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startDashboard } from '../src/dashboard.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { fcGlobalDir, listRuns, readRunState, runsRoot, setFcGlobalDir, writeRunState } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { readResearchHistory, decodeLegacyResearchHistory, legacyResearchConfig, readProtocolResearchRecord } from '../src/research-history.js';
import { makeInstrument } from './test-support/research-instrument-fixture.js';
import { initializeResearchInstrument, captureMeasuredCandidate, invokeResearchInstrument, researchDirectory } from '../src/research-measurement.js';
import * as engineFiles from '../src/engine-fs.js';
import { createRun } from './test-support/create-run.js';

let root: string, project: string, previous: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'research-readers-')); project = join(root, 'project'); mkdirSync(project); previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store')); });
afterEach(() => { vi.restoreAllMocks(); setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });
it.each(['legacy', 'measurement'] as const)('keeps historical %s records readable and unchanged through status, watch, UI API and listing', async contract => {
  const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
  const directory = created.runDirPath;
  const state = readRunState(project, created.runId);
  state.status = 'ceiling_hit'; state.completedAt = new Date().toISOString(); state.taskDescription = '# Historical measurement';
  const old = { opaque_extension: { preserved: ['legacy', 7] }, baseline: 100, policy: 'greedy_stack', resultFile: 'retired-result.json', resultSchema: { type: 'object' }, reportDir: 'retired-reports',
    integrity: { maxStdRatio: .2 }, confirm: { command: 'exit 0' }, stop: { maxRounds: 2, minImprovement: 1 } };
  state.research = (contract === 'legacy' ? old : { ...old, measurement: ({ frozen: ['instrument'], candidate: ['src'], replicates: 2,
    metrics: { cost: { direction: 'min', scale: 'fraction' } }, primary: ['cost'], development: { command: process.execPath, args: [] } }) }) as any;
  state.researchReportPaths = ['retired-reports/result.md']; state.terminalArtifact = 'retired-reports/result.md';
  writeRunState(project, state.runId, state);
  mkdirSync(join(project, 'retired-reports')); writeFileSync(join(project, 'retired-reports/result.md'), '# Published historical report');
  rmSync(join(project, 'retired-reports'), { recursive: true });
  writeFileSync(runRecordPath(directory, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'historical round', result: 90 }] }));
  if (contract === 'measurement') {
    mkdirSync(runRecordPath(directory, 'research_measurement'), { recursive: true });
    writeFileSync(runRecordPath(directory, 'research_measurement/state.json'), JSON.stringify({
    opaque_extension: { preserved: ['measurement', 8] }, revision: 2, baseline: { status: 'measured', fingerprint: 'historic', candidate: 'tree', items: [{ id: 'a', metrics: { cost: 100 } }] },
    noise: { cost: .04 }, replicates: [], heldOutUses: [], // Historical native state has no rounds property.
    }));
  }
  writeFileSync(runRecordPath(directory, 'research_confirm.json'), '{"status":"not_run"}');
  const files = ['run.json', 'events.jsonl', 'research_journal.json', 'research_confirm.json', 'research_measurement/state.json'].filter(p => { try { statSync(runRecordPath(directory, p)); return true; } catch { return false; } });
  const before = files.map(p => ({ bytes: readFileSync(runRecordPath(directory, p)), mtime: statSync(runRecordPath(directory, p)).mtimeMs }));
  expect(reconcileHostInterruptedRun(project, state.runId).status).toBe('ceiling_hit');
  expect(reconcileResearchConclusion(project, state.runId).status).toBe('ceiling_hit');
  expect(() => statSync(join(project, 'retired-reports'))).toThrow();
  expect(readRunState(project, state.runId).research).toEqual(state.research);
  expect(legacyResearchConfig(state.research)).toEqual(state.research);
  if (contract === 'measurement') expect(readResearchHistory(directory).value).toMatchObject({ opaque_extension: { preserved: ['measurement', 8] } });
  expect(renderRunSummary(project, directory, state)).toContain('historical round');
  expect(listRuns(project)).toContain(state.runId);
  const watched = pollWatch(createWatchState(), { runsRoot: runsRoot(project), candidateRunIds: () => [state.runId], isProcessAlive: () => false });
  expect(watched.stats.readableRuns).toBe(1);
  const status = spawnSync(process.execPath, [join(import.meta.dirname, '../dist/cli.js'), 'status', '--project', project, '--details'], {
    cwd: project, env: { ...process.env, FC_HOME: fcGlobalDir(), HOME: join(root, 'home') }, encoding: 'utf8', timeout: 15000,
  });
  expect(status.status, status.stderr).toBe(0); expect(status.stdout).toContain('ceiling_hit'); expect(status.stdout).toContain('historical round');
  const listed = spawnSync(process.execPath, [join(import.meta.dirname, '../dist/cli.js'), 'list'], { cwd: project, env: { ...process.env, FC_HOME: fcGlobalDir(), HOME: join(root, 'home') }, encoding: 'utf8', timeout: 15000 });
  expect(listed.status, listed.stderr).toBe(0); expect(listed.stdout).toContain(state.runId);
  const app = await startDashboard(project, 0, { listTasks: async () => [] });
  try {
    const detail = await app.inject({ method: 'GET', url: `/api/runs/${state.runId}` });
    expect(detail.statusCode).toBe(200); expect(detail.json().status).toBe('ceiling_hit');
    const listing = await app.inject({ method: 'GET', url: '/api/standalone-runs' });
    expect(listing.statusCode).toBe(200); expect(JSON.stringify(listing.json())).toContain(state.runId);
  } finally { await app.close(); }
  for (const [n, path] of files.entries()) {
    expect(readFileSync(runRecordPath(directory, path))).toEqual(before[n].bytes);
    expect(statSync(runRecordPath(directory, path)).mtimeMs).toBe(before[n].mtime);
  }
});

it('never decodes a protocol record as a scientific legacy record', () => {
  expect(decodeLegacyResearchHistory({ protocol: 'research-instrument/v1', rounds: [{ result: -999999 }] }, null).value).toBeNull();
  expect(legacyResearchConfig({ protocol: 'research-instrument/v1', baseline: -999999 })).toBeUndefined();
});

it('protocol readers use committed results without repairing a crashed state projection or dropping diagnostics', async () => {
  const config = makeInstrument(project);
  const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
  const directory = created.runDirPath;
  const state = readRunState(project, created.runId); state.research = config; writeRunState(project, state.runId, state);
  await initializeResearchInstrument(project, directory, config);
  const projection = join(researchDirectory(directory), 'state.json');
  const before = readFileSync(projection);
  writeFileSync(join(project, 'candidate.json'), '{"value":50}');
  const candidate = captureMeasuredCandidate(project, directory, 'round-1');
  const write = engineFiles.atomicWrite;
  const fault = vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
    if (path === projection) throw new Error('controlled projection failure');
    return write(path, data, options);
  });
  await expect(invokeResearchInstrument(directory, 'evaluate', candidate, 1)).rejects.toThrow('controlled projection failure');
  fault.mockRestore();
  const writes = vi.spyOn(engineFiles, 'atomicWrite');
  const record = readProtocolResearchRecord(directory);
  expect(record.error).toBeUndefined();
  expect(record.value?.incumbent).toEqual(candidate);
  expect(record.value?.history.map(h => h.outcome)).toEqual(['baseline', 'keep']);
  const committed = JSON.parse(readFileSync(record.value!.history[1].result.path, 'utf8'));
  expect(JSON.stringify(record.value!.history[1].response!.diagnostics)).toBe(JSON.stringify(committed.response.diagnostics));
  expect(JSON.stringify(record.value!.history[1].response!.observations)).toBe(JSON.stringify(committed.response.observations));
  const summary = renderRunSummary(project, directory, state);
  expect(summary).toContain(candidate.sha256); expect(summary).toContain('evaluate 1: keep'); expect(summary).toContain('provenance');
  const app = await startDashboard(project, 0, { listTasks: async () => [] });
  try {
    const response = await app.inject({ method: 'GET', url: `/api/runs/${state.runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().researchRecord.value.incumbent).toEqual(candidate);
    expect(response.json().researchRecord.value.history[1].response.diagnostics).toEqual(committed.response.diagnostics);
  } finally { await app.close(); }
  const status = spawnSync(process.execPath, [join(import.meta.dirname, '../dist/cli.js'), 'status', '--project', project, '--details'], {
    cwd: project, env: { ...process.env, FC_HOME: fcGlobalDir(), HOME: join(root, 'home') }, encoding: 'utf8', timeout: 15000,
  });
  expect(status.status, status.stderr).toBe(0); expect(status.stdout).toContain(candidate.sha256);
  expect(status.stdout).toContain('evaluate 1: keep'); expect(status.stdout).toContain('provenance');
  expect(readFileSync(projection)).toEqual(before);
  expect(writes).not.toHaveBeenCalled();
});
