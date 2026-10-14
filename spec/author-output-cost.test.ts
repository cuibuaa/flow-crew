import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_SCHEMA, RECORDED_HANDOFF_SCHEMA, parseStageRecord } from '../src/handoff.js';
import { createRun, fcGlobalDir, readRunState, readStageStatus, runDir, setFcGlobalDir, writeRunState } from '../src/store.js';
import { generateRunSummary } from '../src/run-summary.js';
import { clearAttemptSummaryRefreshDebounce } from '../src/run-events.js';
import { runStage } from '../src/worker.js';

const record = () => ({ status: 'delivered', summary: 'Delivered the requested report.',
  checks: [{ command: 'node check.mjs', exit_code: 0, evidence: 'checks/stdout.txt' }], caveats: [] });
let root: string, project: string, directory: string, runId: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'author-output-cost-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  ({ runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']));
  directory = runDir(project, runId);
});
afterEach(() => { clearAttemptSummaryRefreshDebounce(); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

describe('author result reuses the engine write record', () => {
  it('delivers without typing a file list and records the actual write independently', async () => {
    const result = await runStage({ async run(_prompt, _role, opts) {
      expect(opts.outputSchema?.properties).not.toHaveProperty('files_modified');
      writeFileSync(join(project, 'report.md'), '# Required report\n');
      return { output: JSON.stringify(record()), exitCode: 0, duration_ms: 1,
        writes: ['report.md'], writeAttribution: 'structured' };
    } }, {
      stageId: 'work', projectDir: project, runDir: directory, runId,
      role: { name: 'coder', description: '', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Deliver the requested report.' },
      dependsOn: [], promptTemplate: 'Write report.md.', timeout_ms: 10000, retries: 0,
      projectWriteScope: ['report.md'], outputSchema: HANDOFF_SCHEMA,
      artifactContract: { version: 1, produces: [{ id: 'report', root: 'project', path: 'report.md' }], reads: [], groups: [] },
    });
    expect(result.exitCode, result.friendlyError).toBe(0);
    expect(JSON.parse(result.output)).toEqual(record());
    expect(readFileSync(join(project, 'report.md'), 'utf8')).toContain('Required report');
    expect(readStageStatus(project, runId, 'work').attempts?.[0]).toMatchObject({ writes: ['report.md'], writeAttribution: 'structured' });
  });

  it('keeps literal checks while the response schema excludes a duplicate file list', () => {
    expect(parseStageRecord(JSON.stringify(record()), HANDOFF_SCHEMA)).toEqual(record());
    expect(() => parseStageRecord(JSON.stringify({ ...record(), files_modified: ['report.md'] }), HANDOFF_SCHEMA)).toThrow('unknown field');
    expect(parseStageRecord(JSON.stringify({ ...record(), files_modified: ['old.md'] }), RECORDED_HANDOFF_SCHEMA)).toHaveProperty('files_modified', ['old.md']);
  });

  it('reports each execution write with attribution and retains historical author reports', async () => {
    const state = readRunState(project, runId);
    state.status = 'complete'; state.completedAt = new Date().toISOString();
    state.stages.work = { status: 'complete', retries: 0, artifacts: ['cumulative-only.md'], attempts: [
      { index: 1, startedAt: state.startedAt, status: 'complete', exitCode: 0, writes: ['first.md'], writeAttribution: 'structured' },
      { index: 2, startedAt: state.startedAt, status: 'complete', exitCode: 0, writes: ['second.md'], writeAttribution: 'snapshot' },
    ] };
    writeRunState(project, runId, state);
    writeFileSync(join(directory, 'stages/work/output_attempt_1.md'), JSON.stringify({ ...record(), files_modified: ['historical-reported.md'] }));
    writeFileSync(join(directory, 'stages/work/output_attempt_2.md'), JSON.stringify(record()));
    writeFileSync(join(directory, 'stages/work/output.md'), JSON.stringify(record()));
    const report = await generateRunSummary(project, runId);
    const first = report.split('### work, execution 1')[1].split('### work, execution 2')[0];
    const second = report.split('### work, execution 2')[1];
    expect(first).toContain('Recorded writes (structured): `first.md`');
    expect(first).toContain('Reported files: `historical-reported.md`');
    expect(first).not.toContain('second.md');
    expect(second).toContain('Recorded writes (snapshot): `second.md`');
    expect(second).not.toContain('historical-reported.md');
    expect(report).not.toContain('cumulative-only.md');
    expect(report).toContain('`node check.mjs` — exit 0; evidence: checks/stdout.txt');
  });
});
