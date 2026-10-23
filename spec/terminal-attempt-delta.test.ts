import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, writeRunState } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { type Adapter, type AgentConfig } from '../src/adapters/base.js';
import { createScopeReconciler } from '../src/scheduler/sched_scope/reconciliation.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { renameSync } from '../src/engine-fs.js';

let root: string, project: string, prior: string;
const terminalPath = 'docs/result.md';
const role: AgentConfig = { name: 'coder', description: 'fixture', model: 'local', reasoning_effort: 'low', tools: [], prompt: 'fixture' };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terminal-delta-'));
  project = join(root, 'project'); mkdirSync(project);
  prior = fcGlobalDir(); setFcGlobalDir(join(root, 'fc'));
  projectProbe("require('node:child_process').execFileSync('git', ['init', '-q', '.'])");
});
afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });

function projectProbe(script: string) {
  execFileSync(process.execPath, ['-e', script], {
    cwd: project, env: { ...process.env, HOME: root, FC_HOME: fcGlobalDir() },
  });
}
function shellWrite(path = terminalPath) {
  // A real shell/heredoc write has no corresponding structured file tool event.
  const script = "python3 - <<'PY'\nfrom pathlib import Path\np = Path('" + path + "')\np.parent.mkdir(parents=True, exist_ok=True)\np.write_text('result from this execution\\n')\nPY";
  projectProbe("require('node:child_process').execFileSync('sh', ['-c', " + JSON.stringify(script) + "])");
  writeFileSync(join(project, 'tool-note.md'), 'structured tool wrote this other path\n');
}

it.each([false, true])('direct terminal owner keeps shell writes with ignored=%s', async ignored => {
  if (ignored) writeFileSync(join(project, '.gitignore'), 'docs/\n');
  const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/direct.yaml'));
  config.defaults.max_iterations = 1;
  const adapter: Adapter = { async run(_prompt, _role, opts) {
    if (opts.stageId === 'implement') shellWrite();
    return fixtureResult({ output: opts.stageId === 'review'
      ? JSON.stringify({ pass: true, reason: 'Inspected result.', criteria: {}, audit_findings: { version: 1, findings: [] } })
      : 'Completed the result.', exitCode: 0, duration_ms: 1,
      writes: opts.stageId === 'implement' ? ['tool-note.md'] : [], writeAttribution: 'structured' }, opts);
  } };
  const state = await runWorkflow(config, raw, project, adapter, new Map(), undefined,
    join(import.meta.dirname, '../config/agents'), undefined,
    '---\nterminal_states:\n  complete: [docs/result.md]\n---\nProduce the result.\n', true);
  const directory = join(fcGlobalDir(), 'runs', state.runId);
  expect(state.status, state.failureReason).toBe('complete');
  const attempt = state.stages.implement.attempts!.at(-1)!;
  expect(attempt.writes).toContain(terminalPath);
  const audit = JSON.parse(readFileSync(join(directory, attempt.constraintAudit!.path), 'utf8'));
  expect(attempt.writes).toEqual(audit.rawWrites);
  if (ignored) expect(audit.exemptedWrites).toContain(terminalPath);
  expect(readdirSync(directory).some(path => path.startsWith('non_owner_terminal_'))).toBe(false);
  expect(readFileSync(join(project, terminalPath), 'utf8')).toContain('this execution');
});

it('worker publishes the complete shell delta before scheduler reconciliation', async () => {
  const created = createRun(project, 'direct', 'name: direct', ['implement']);
  const state = readRunState(project, created.runId);
  state.terminalStates = { complete: { paths: [terminalPath] } };
  writeRunState(project, created.runId, state);
  await runStage({ run: async () => {
    shellWrite();
    const backwards = new Date(Date.parse(state.startedAt) - 1500);
    utimesSync(join(project, terminalPath), backwards, backwards);
    return { output: 'Finished.', exitCode: 0, duration_ms: 1, writes: ['tool-note.md'], writeAttribution: 'structured' };
  } }, { stageId: 'implement', role, dependsOn: [], promptTemplate: 'fixture', timeout_ms: 60000,
    projectDir: project, runId: created.runId, runDir: created.runDirPath, retries: 0,
    artifactContract: { version: 1, produces: [], reads: [] },
    settlementBoundary: async () => {
      expect(readStageStatus(project, created.runId, 'implement').attempts?.at(-1)?.writes).toContain(terminalPath);
    } });
  expect(readStageStatus(project, created.runId, 'implement').status).toBe('complete');
});

it('accepts changed terminal content whose mtime predates run start by 1.5 seconds', async () => {
  const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/direct.yaml'));
  config.defaults.max_iterations = 1;
  mkdirSync(join(project, 'docs')); writeFileSync(join(project, terminalPath), 'previous run\n');
  const state = await runWorkflow(config, raw, project, { async run(_prompt, _role, opts) {
    if (opts.stageId === 'implement') {
      shellWrite();
      const backwards = new Date(Date.parse(readRunState(project, basename(opts.runDir)).startedAt) - 1500);
      utimesSync(join(project, terminalPath), backwards, backwards);
    }
    return fixtureResult({ output: opts.stageId === 'review'
      ? JSON.stringify({ pass: true, reason: 'Inspected result.', criteria: {}, audit_findings: { version: 1, findings: [] } }) : 'Finished.',
      exitCode: 0, duration_ms: 1, writes: opts.stageId === 'implement' ? ['tool-note.md'] : [], writeAttribution: 'structured' }, opts);
  } }, new Map(), undefined, join(import.meta.dirname, '../config/agents'), undefined,
  '---\nterminal_states:\n  complete: [docs/result.md]\n---\nProduce the result.\n', true);
  expect(state.status, state.failureReason).toBe('complete');
  expect(existsSync(join(project, terminalPath))).toBe(true);
});

it('quarantines a reviewer-only terminal write when the admitted owner never wrote it', async () => {
  const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/direct.yaml'));
  config.defaults.max_iterations = 1;
  const state = await runWorkflow(config, raw, project, { async run(_prompt, _role, opts) {
    if (opts.stageId === 'review') shellWrite();
    return fixtureResult({ output: opts.stageId === 'review'
      ? JSON.stringify({ pass: true, reason: 'Reviewed.', criteria: {}, audit_findings: { version: 1, findings: [] } }) : 'Finished.',
    exitCode: 0, duration_ms: 1, writes: opts.stageId === 'review' ? [terminalPath] : [], writeAttribution: 'structured' }, opts);
  } }, new Map(), undefined, join(import.meta.dirname, '../config/agents'), undefined,
  '---\nterminal_states:\n  complete: [docs/result.md]\n---\nProduce the result.\n', true);
  expect(state.status).not.toBe('complete');
  expect(existsSync(join(project, terminalPath))).toBe(false);
  expect(readdirSync(join(fcGlobalDir(), 'runs', state.runId)).some(path => path.startsWith('non_owner_terminal_'))).toBe(true);
});

it('does not attribute an engine quarantine or restore to the following attempt', async () => {
  const created = createRun(project, 'fixture', 'name: fixture', ['implement']);
  const stage = StageConfigSchema.parse({ id: 'implement', role: 'coder', scope: ['docs/'], prompt_template: 'fixture', artifact_contract: { version: 1, produces: [], reads: [] } });
  const reconciler = createScopeReconciler();
  const context = createScopeBatchContext(project, [stage], undefined, created.runId);
  const execute = async (write: () => void, exitCode = 0) => {
    await runStage({ run: async () => { write(); return { output: 'Finished.', exitCode, duration_ms: 1 }; } }, {
      stageId: stage.id, role, dependsOn: [], promptTemplate: 'fixture', timeout_ms: 60000,
      projectDir: project, runId: created.runId, runDir: created.runDirPath, retries: 0,
      artifactContract: { version: 1, produces: [], reads: [] },
      settlementBoundary: async () => { reconciler.reconcileCompletedStageAttempts({ stage, projectDir: project, runId: created.runId, context }); },
    });
  };
  try {
    await execute(() => shellWrite());
    const quarantined = join(created.runDirPath, 'quarantined.md');
    renameSync(join(project, terminalPath), quarantined);
    await execute(() => {});
    expect(readStageStatus(project, created.runId, stage.id).attempts?.at(-1)?.writes).not.toContain(terminalPath);
    renameSync(quarantined, join(project, terminalPath));
    await execute(() => {});
    expect(readStageStatus(project, created.runId, stage.id).attempts?.at(-1)?.writes).not.toContain(terminalPath);
    await execute(() => writeFileSync(join(project, terminalPath), 'different author content\n'));
    await execute(() => writeFileSync(join(project, terminalPath), 'result from this execution\n'));
    expect(readStageStatus(project, created.runId, stage.id).attempts?.at(-1)?.writes).toContain(terminalPath);
    await execute(() => writeFileSync(join(project, terminalPath), 'failed attempt content\n'), 7);
    await execute(() => writeFileSync(join(project, terminalPath), 'result from this execution\n'));
    expect(readStageStatus(project, created.runId, stage.id).attempts?.at(-1)?.writes).toContain(terminalPath);
  } finally { closeRollbackBaseline(project, created.runDirPath); }
});
