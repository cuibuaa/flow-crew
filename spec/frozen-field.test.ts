import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectBrief, createBriefAdmission } from '../src/brief-preflight.js';
import { cmdShipPreflightWithDeps } from '../src/cli-ship-preflight.js';
import { rehearseBriefIsolated } from './test-support/rehearse.js';

import { parseBriefInputs } from '../src/ship-inputs.js';
import { resolveImmutableEvidenceBindings } from '../src/scheduler/sched_scope/path-capabilities.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runScopeSafeStageGroup } from '../src/scheduler/sched_loop/services.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import type { Adapter } from '../src/adapters/base.js';

let root: string, project: string, previous: string, directory: string;
const original = Buffer.from([0, 255, 10, 128]);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'frozen-field-'));
  project = join(root, 'project');
  mkdirSync(join(project, 'evidence'), { recursive: true });
  writeFileSync(join(project, 'notes.md'), original);
  writeFileSync(join(project, 'evidence/source.md'), 'baseline');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Baseline']]) {
    isolatedProjectCommand('git', args, project, root);
  }
  previous = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
});
afterEach(() => {
  closeRollbackBaseline(project, directory);
  setFcGlobalDir(previous);
  rmSync(root, { recursive: true, force: true });
});

const proseOnly = '---\ninputs: [notes.md, evidence]\n---\nPreserve `notes.md` and `evidence/source.md` as frozen evidence.\n\n## Acceptance Criteria\n1. Deliver `report.md`.';
const structured = '---\ninputs: [{path: notes.md, frozen: true}]\n---\nThe frontmatter marks `notes.md` as frozen immutable evidence.\n\n## Acceptance Criteria\n1. Deliver `report.md`.';

async function author(brief: string, restore = false) {
  const stage = StageConfigSchema.parse({ id: 'author', role: 'coder', scope: ['report.md'] });
  const { runId, runDirPath } = createRun(project, 'frozen-field', 'name: fixture\nstages: []\n', ['author']);
  directory = runDirPath;
  writeFileSync(join(directory, 'task_brief.md'), brief);
  let calls = 0;
  const adapter: Adapter = { async run() {
    calls++;
    writeFileSync(join(project, 'notes.md'), 'changed bytes');
    if (restore) writeFileSync(join(project, 'notes.md'), original);
    writeFileSync(join(project, 'report.md'), 'delivered');
    return { output: 'Delivered.', exitCode: 0, processExitCode: 0, duration_ms: 1, writes: ['notes.md', 'report.md'], writeAttribution: 'structured' };
  } };
  await runScopeSafeStageGroup([stage], project, runId, 1, (s, settlementBoundary) => runStage(adapter, {
    stageId: s.id, role: { name: 'coder', description: 'Fixture', prompt: 'Deliver.', tools: [], model: 'test', reasoning_effort: 'low' },
    dependsOn: [], promptTemplate: 'Deliver.', projectDir: project, runId, runDir: directory,
    retries: 0, timeout_ms: 8_000, artifactContract: fixtureArtifactContract(s.id), settlementBoundary,
  }));
  return { calls, status: readStageStatus(project, runId, 'author'),
    audit: JSON.parse(readFileSync(join(directory, 'stages/author/constraint_audit_attempt_1.json'), 'utf8')) };
}

it('keeps prose-only preservation unfrozen through preflight, rehearsal and authoring', async () => {
  expect(resolveImmutableEvidenceBindings(project, proseOnly)).toEqual([]);
  const report = inspectBrief(proseOnly);
  expect(report.contractReady).toBe(true);
  expect(createBriefAdmission(report, { kind: 'not_required' }).acknowledgement.kind).toBe('not_required');
  const rehearsal = await rehearseBriefIsolated(proseOnly, { projectDir: project, staticOnly: true });
  expect(rehearsal.exitCode, JSON.stringify(rehearsal.findings)).toBe(0);
  writeFileSync(join(project, 'brief.md'), proseOnly);
  let output = '';
  const code = await cmdShipPreflightWithDeps(['ship-preflight', '--brief', 'brief.md'], {
    projectDir: project, runsRoot: () => join(root, 'store/runs'),
    stdout: { write: chunk => { output += chunk; } }, stderr: { write: chunk => { output += chunk; } },
    probeDaemon: async () => ({ state: 'unavailable', reason: 'Isolated fixture' }),
    readCampaignEntries: () => [],
  });
  expect(code, output).toBe(0);
  const result = await author(proseOnly);
  expect(result.calls).toBe(1);
  expect(result.status.status).toBe('complete');
  expect(result.audit.violations).toEqual([]);
  expect(result.audit.rolledBackWrites).toEqual([]);
  expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('changed bytes');
});

it('recheck structured freeze plus explanatory prose launches, catches changed bytes and restores them', async () => {
  expect(resolveImmutableEvidenceBindings(project, structured).map(input => input.path)).toEqual(['notes.md']);
  const report = inspectBrief(structured);
  expect(report.contractReady).toBe(true);
  const result = await author(structured);
  expect(result.calls).toBe(1);
  expect(result.status.status).toBe('failed');
  expect(result.status.attempts[0].processExitCode).toBe(0);
  expect(result.status.attempts[0].exitCode).toBe(1);
  expect(result.audit.violations).toEqual([expect.objectContaining({ path: 'notes.md' })]);
  expect(result.audit.rolledBackWrites).toEqual(['notes.md']);
  expect(result.audit.rollbackFailures).toEqual([]);
  expect(readFileSync(join(project, 'notes.md'))).toEqual(original);
  expect(readFileSync(join(project, 'report.md'), 'utf8')).toBe('delivered');
});

it('accepts a structured frozen input restored to identical bytes before settlement', async () => {
  const result = await author(structured, true);
  expect(result.calls).toBe(1);
  expect(result.status.status).toBe('complete');
  expect(result.audit.violations).toEqual([]);
  expect(result.audit.rolledBackWrites).toEqual([]);
  expect(readFileSync(join(project, 'notes.md'))).toEqual(original);
});

it('freezes only strict structured true, never notes, strings or prose-shaped fields', () => {
  for (const fields of ['note: frozen', 'frozen: false', 'frozen: "true"', 'frozen: [true]', 'description: preserve']) {
    const brief = `---\ninputs: [{path: notes.md, ${fields}}]\n---\nKeep all inputs immutable.`;
    expect(resolveImmutableEvidenceBindings(project, brief)).toEqual([]);
  }
  for (const value of ['"true"', '[true]', 'null', '1']) {
    const parsed = parseBriefInputs(`---\ninputs: [{path: notes.md, frozen: ${value}}]\n---`);
    expect(parsed.unresolvedInputs).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('YAML boolean') }));
  }
  const brief = '---\ninputs: [notes.md, {path: notes.md, frozen: true}, {path: evidence, frozen: false}]\n---\nNever freeze `notes.md`.';
  expect(resolveImmutableEvidenceBindings(project, brief).map(input => input.path)).toEqual(['notes.md']);
});
