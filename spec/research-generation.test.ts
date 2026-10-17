import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { captureResearchGateCandidate } from '../src/research-candidate.js';
import { createRun, fcGlobalDir, readRunState, setFcGlobalDir, updateRunState } from '../src/store.js';
import { normalizeStageContracts, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { runStage } from '../src/worker.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';

let root: string, project: string, run: string, runId: string, previous: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'research-generation-'));
  project = join(root, 'project'); mkdirSync(join(project, 'docs'), { recursive: true });
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'control'));
  ({ runId, runDirPath: run } = createRun(project, 'research', 'name: research\nstages: []\n', []));
});
afterEach(() => {
  vi.useRealTimers(); closeRollbackBaseline(project, run);
  setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true });
});
function brief(reportDir = 'docs') {
  return `---\nresearch:\n  baseline: 0\n  policy: best_of_n\n  result_file: docs/round.json\n  report_dir: ${reportDir}\n  stop: {beat: 0.5, max_rounds: 1}\n---\n# Goal\nIndependently measure a round.\n`;
}
function configure(reportDir = 'docs') {
  expect(configureWorkflowBrief({ name: 'research', description: '', defaults: {}, stages: [] },
    project, runId, run, 1, false, brief(reportDir)).kind).toBe('configured');
}

it.each(['outward-link', 'internal-link', 'dangling-link', 'directory', 'oversized', 'outward-parent'] as const)(
  'keeps excluded evidence out of admission and inference: %s', kind => {
    let path = 'docs/evidence.json', reportDir = 'docs';
    const bytes = kind === 'oversized' ? Buffer.alloc(4 * 1024 * 1024 + 1, 32) : Buffer.from('Synthetic evidence bytes.');
    const target = join(root, 'synthetic-marker'); writeFileSync(target, bytes);
    if (kind === 'directory') mkdirSync(join(project, path));
    else if (kind === 'oversized') writeFileSync(join(project, path), bytes);
    else if (kind === 'outward-parent') {
      mkdirSync(join(root, 'outside/nested'), { recursive: true });
      writeFileSync(join(root, 'outside/nested/evidence.json'), bytes);
      symlinkSync(join(root, 'outside'), join(project, 'docs/alias'), 'dir');
      reportDir = 'docs/alias/nested'; path = reportDir + '/evidence.json';
    } else {
      if (kind === 'internal-link') writeFileSync(join(project, 'docs/source.json'), bytes);
      symlinkSync(kind === 'internal-link' ? join(project, 'docs/source.json')
        : kind === 'dangling-link' ? join(root, 'absent') : target, join(project, path));
    }
    configure(reportDir);
    const baseline = readRunState(project, runId).researchInputGeneration?.baselines[path];
    expect(baseline).not.toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(baseline ?? null).toBe(null);
  });

it('keeps regular evidence at the existing 4 MiB boundary in the admission snapshot', () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024, 32);
  writeFileSync(join(project, 'docs/evidence.json'), bytes); configure();
  expect(readRunState(project, runId).researchInputGeneration?.baselines['docs/evidence.json'])
    .toBe(createHash('sha256').update(bytes).digest('hex'));
});

it('does not fingerprint an outward result-slot alias', () => {
  const bytes = JSON.stringify({ label: 'external', result: 1 });
  const target = join(root, 'external-result.json'); writeFileSync(target, bytes);
  const future = (Date.now() + 60_000) / 1000; utimesSync(target, future, future);
  symlinkSync(target, join(project, 'docs/round.json'));
  configure();
  expect(readRunState(project, runId).researchInputGeneration?.baselines['docs/round.json'] ?? null).toBe(null);
  expect(captureResearchGateCandidate(project, run, 'review').kind).toBe('absent');
});

it.each((['unproven', 'earlier-iteration', 'unsettled', 'existing-snapshot'] as const).flatMap(mode => [
  { mode, hardlink: false }, { mode, hardlink: true },
]))('does not promote old result bytes through legacy migration: %j', ({ mode, hardlink }) => {
    const path = join(project, 'docs/round.json'), written = hardlink ? 'docs/value.json' : 'docs/round.json';
    writeFileSync(join(project, written), JSON.stringify({ label: 'old', result: 1 }));
    if (hardlink) linkSync(join(project, written), path);
    const future = (Date.now() + 60_000) / 1000; utimesSync(path, future, future);
    if (mode === 'existing-snapshot') {
      configure();
      // A closed producer for a separate file cannot freshen this old slot.
      writeFileSync(join(project, 'docs/unrelated.json'), readFileSync(path));
    }
    updateRunState(project, runId, state => {
      state.currentIteration = 1;
      state.stages.measure = { status: mode === 'unsettled' ? 'pending' : 'complete', retries: 0,
        ...(mode === 'unproven' ? {} : { attempts: [{ index: 1, startedAt: state.startedAt,
          status: mode === 'unsettled' ? 'suspended' : 'complete', exitCode: 0,
          iteration: mode === 'earlier-iteration' ? 0 : 1,
          writes: [mode === 'existing-snapshot' ? 'docs/unrelated.json' : written] }] }) };
    });
    configure();
    expect(captureResearchGateCandidate(project, run, 'review').kind).toBe('absent');
    expect(existsSync(join(run, 'research_journal.json'))).toBe(false);
  });

it('does not promote an independent old result with the same bytes as a completed publication', () => {
  const bytes = JSON.stringify({ label: 'old', result: 1 });
  writeFileSync(join(project, 'docs/round.json'), bytes);
  writeFileSync(join(project, 'docs/value.json'), bytes);
  expect(statSync(join(project, 'docs/round.json')).ino).not.toBe(statSync(join(project, 'docs/value.json')).ino);
  updateRunState(project, runId, state => {
    state.currentIteration = 1;
    state.stages.measure = { status: 'complete', retries: 0, attempts: [{ index: 1, startedAt: state.startedAt,
      status: 'complete', exitCode: 0, iteration: 1, writes: ['docs/value.json'] }] };
  });
  configure();
  expect(captureResearchGateCandidate(project, run, 'review').kind).toBe('absent');
  expect(existsSync(join(run, 'research_journal.json'))).toBe(false);
});

it.each([
  { rolledBack: false, reviewPass: true },
  { rolledBack: true, reviewPass: true },
  { rolledBack: false, reviewPass: true, aliasedResult: true },
  { rolledBack: false, reviewPass: false },
  { rolledBack: false, reviewPass: true, hardlinkedResult: true },
  { rolledBack: true, reviewPass: true, hardlinkedResult: true },
  { rolledBack: false, reviewPass: false, hardlinkedResult: true },
  { rolledBack: false, reviewPass: true, sameValue: true },
  { rolledBack: true, reviewPass: true, sameValue: true },
  { rolledBack: true, reviewPass: true, sameValue: true, aliasedResult: true },
  { rolledBack: true, reviewPass: true, sameValue: true, hardlinkedResult: true },
  { rolledBack: true, reviewPass: false, sameValue: true },
])('resumes completed production through independent review: %j', async ({ rolledBack, reviewPass, aliasedResult = false, hardlinkedResult = false, sameValue = false }) => {
  const workflow = WorkflowConfigSchema.parse({ name: 'research', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
    { id: 'measure', role: 'coder', scope: ['docs'], depends_on: [], prompt_template: 'Publish measured evidence.',
      artifact_contract: { version: 1, produces: [{ id: 'round', root: 'project', path: 'docs/round.json', kind: 'file', nonempty: true }], reads: [] } },
    { id: 'review', role: 'qa', scope: [], depends_on: ['measure'], is_gate: true, prompt_template: 'Independently verify measured evidence.',
      artifact_contract: { version: 1, produces: [{ id: 'verdict', root: 'run', path: 'verdict_review.json', kind: 'file' }],
        reads: [{ id: 'round', root: 'project', path: 'docs/round.json', kind: 'file', source: { kind: 'stage', stage: 'measure', artifact: 'round' } }] } },
    { id: 'repair', role: 'coder', scope: ['docs/round.json'], depends_on: ['review'], retry_to: ['review'], prompt_template: 'Repair rejected evidence.',
      artifact_contract: { version: 1, produces: [], reads: [] } },
  ] });
  normalizeStageContracts(workflow.stages);
  ({ runId, runDirPath: run } = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id)));
  updateRunState(project, runId, state => {
    state.currentIteration = 1; state.maxIterations = 1; state.maxRetries = 0;
    recordAdmittedPlan(state, workflow.stages, run, 'Synthetic previously admitted workflow.');
  });
  const start = Date.now();
  const bytes = JSON.stringify({ label: 'pending-review', result: 1 });
  if (aliasedResult) symlinkSync(join(project, 'docs/value.json'), join(project, 'docs/round.json'));
  if (hardlinkedResult) {
    writeFileSync(join(project, 'docs/value.json'), 'Previous result.');
    linkSync(join(project, 'docs/value.json'), join(project, 'docs/round.json'));
  }
  const written = aliasedResult || hardlinkedResult ? 'docs/value.json' : 'docs/round.json';
  if (sameValue) {
    writeFileSync(join(project, written), bytes);
    configure();
    expect(captureResearchGateCandidate(project, run, 'review').kind).toBe('absent');
  }
  const produced = await runStage(new ScriptedAdapter({ measure: { output: 'Measured evidence produced.',
    projectFiles: { [written]: bytes } } }), {
    stageId: 'measure', projectDir: project, runId, runDir: run,
    role: { name: 'coder', description: 'fixture', model: 'default', reasoning_effort: 'low', tools: [], prompt: '' },
    dependsOn: [], promptTemplate: 'Publish measurement.', timeout_ms: 20000, retries: 0,
    artifactContract: workflow.stages[0].artifact_contract!, gateReviewed: true,
  });
  expect(produced.exitCode, produced.output).toBe(0);
  expect(readRunState(project, runId).stages.measure.attempts?.at(-1)?.writes).toContain(written);
  if (hardlinkedResult) {
    expect(statSync(join(project, 'docs/value.json')).dev).toBe(statSync(join(project, 'docs/round.json')).dev);
    expect(statSync(join(project, 'docs/value.json')).ino).toBe(statSync(join(project, 'docs/round.json')).ino);
  }
  if (rolledBack) {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start - 1500);
    utimesSync(join(project, 'docs/round.json'), (start - 1500) / 1000, (start - 1500) / 1000);
  }
  writeFileSync(join(run, 'task_brief.md'), brief());
  updateRunState(project, runId, state => {
    state.status = 'stopped'; state.failureReason = 'Synthetic interruption after production.';
    state.completedAt = new Date().toISOString();
    state.research = { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json', reportDir: 'docs', stop: { beat: 0.5, maxRounds: 1 } };
    if (!sameValue) delete state.researchInputGeneration;
  });
  const adapter = new ScriptedAdapter({ review: { output: 'Independent review.', runFiles: {
    'verdict_review.json': JSON.stringify({ pass: reviewPass, reason: 'Independent review.', criteria: {}, audit_findings: { version: 1, findings: [] },
      ...(!reviewPass ? { repairability: { version: 1, disposition: 'irreparable', evidence: 'Synthetic adverse measurement.' } } : {}) }),
  } }, repair: { output: 'Do not repeat completed production.' }, _summary: { output: 'Synthetic continuation summary.' } });
  const result = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined,
    join(resolve(import.meta.dirname, '..'), 'config/agents'), runId);
  expect(adapter.calls.some(call => call.stageId === 'measure')).toBe(false);
  expect(adapter.calls.filter(call => call.stageId === 'review')).toHaveLength(1);
  const journal = join(run, 'research_journal.json');
  expect(result.status, result.failureReason).toBe(reviewPass ? 'shipped' : 'escalated');
  expect(existsSync(journal)).toBe(reviewPass);
  if (reviewPass) {
    const rounds = JSON.parse(readFileSync(journal, 'utf8')).rounds;
    expect(rounds).toHaveLength(1); expect(rounds[0].label).toBe('pending-review');
  }
});
