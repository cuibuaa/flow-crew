import { renderRunSummary } from '../src/run-summary.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startDashboard } from '../src/dashboard.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { fcGlobalDir, listRuns, readRunState, runsRoot, setFcGlobalDir, writeRunState } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { ResearchMeasurementSchema } from '../src/research-measurement.js';
import { createRun } from './test-support/create-run.js';

let root: string, project: string, previous: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'research-readers-')); project = join(root, 'project'); mkdirSync(project); previous = fcGlobalDir(); setFcGlobalDir(join(root, 'store')); });
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });
it.each(['legacy', 'measurement'] as const)('keeps historical %s records readable and unchanged through status, watch, UI API and listing', async contract => {
  const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
  const directory = created.runDirPath;
  const state = readRunState(project, created.runId);
  state.status = 'ceiling_hit'; state.completedAt = new Date().toISOString(); state.taskDescription = '# Historical measurement';
  const old = { baseline: 100, policy: 'greedy_stack', resultFile: 'retired-result.json', resultSchema: { type: 'object' }, reportDir: 'retired-reports',
    integrity: { maxStdRatio: .2 }, confirm: { command: 'exit 0' }, stop: { maxRounds: 2, minImprovement: 1 } };
  state.research = (contract === 'legacy' ? old : { ...old, measurement: ResearchMeasurementSchema.parse({ frozen: ['instrument'], candidate: ['src'], replicates: 2,
    metrics: { cost: { direction: 'min', scale: 'fraction' } }, primary: ['cost'], development: { command: process.execPath, args: [] } }) }) as any;
  writeRunState(project, state.runId, state);
  writeFileSync(runRecordPath(directory, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'historical round', result: 90 }] }));
  if (contract === 'measurement') {
    mkdirSync(runRecordPath(directory, 'research_measurement'), { recursive: true });
    writeFileSync(runRecordPath(directory, 'research_measurement/state.json'), JSON.stringify({
    revision: 2, baseline: { status: 'measured', fingerprint: 'historic', candidate: 'tree', items: [{ id: 'a', metrics: { cost: 100 } }] },
    noise: { cost: .04 }, replicates: [], heldOutUses: [], // Historical native state has no rounds property.
    }));
  }
  writeFileSync(runRecordPath(directory, 'research_confirm.json'), '{"status":"not_run"}');
  const files = ['run.json', 'events.jsonl', 'research_journal.json', 'research_confirm.json', 'research_measurement/state.json'].filter(p => { try { statSync(runRecordPath(directory, p)); return true; } catch { return false; } });
  const before = files.map(p => ({ bytes: readFileSync(runRecordPath(directory, p)), mtime: statSync(runRecordPath(directory, p)).mtimeMs }));
  expect(readRunState(project, state.runId).research).toEqual(state.research);
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
