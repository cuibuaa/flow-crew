import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectDispatchAdmission, parseDispatchedStageConfig, runWorkflow, tryTerminateOnTerminalState, WorkflowConfigSchema } from '../src/scheduler.js';
import { createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir } from '../src/store.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { artifacts, producedRead } from './spec_contracts/declared-fixtures.js';

const root = resolve(import.meta.dirname, '..');
const previous = fcGlobalDir();
const temporary: string[] = [];
afterEach(() => { setFcGlobalDir(previous); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'admission-settlement-')); temporary.push(dir);
  const project = join(dir, 'project'); mkdirSync(project); setFcGlobalDir(join(dir, 'state'));
  return project;
}
const stage = parseDispatchedStageConfig;
const admit = (stages: ReturnType<typeof stage>[], brief: string) => inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan', criteria: extractBriefCriteria(brief) });

describe('criterion ownership follows the result duty', () => {
  it.each([
    'Independent replay and audit must return a verdict before results count.',
    'Run make test at repository root; report direct exit and preserve a red baseline.',
  ])('admits gate-owned verification without inventing another author: %s', duty => {
    const brief = `# Criteria\n1. Produce the measured result.\n2. ${duty}\n`;
    const [product, verification] = extractBriefCriteria(brief).criteria.map(c => c.id);
    const work = stage({ id: 'work', role: 'coder', scope: ['results/value.json'], criterion_refs: [product] });
    const review = stage({ id: 'review', role: 'qa', is_gate: true, depends_on: ['work'], criterion_refs: [product, verification] });
    const repair = stage({ id: 'repair', role: 'coder', scope: work.scope, depends_on: ['review'], retry_to: ['review'] });
    expect(admit([work, review, repair], brief).errors).toEqual([]);
    expect(admit([work, { ...review, criterion_refs: [verification] }, repair], brief).errors.join(';')).toContain('not assigned to a gate');
    expect(admit([work, { ...review, criterion_refs: [product] }, repair], brief).errors.join(';')).toContain('not assigned to a work stage or gate');
  });

  it('still requires a dedicated audit artifact producer when review consumes authored audit work', () => {
    const brief = '# Criteria\n1. A dedicated audit work stage writes its own verdict into the round directory.\n';
    const work = stage({ id: 'audit_work', role: 'coder', scope: ['results/round/audit.json'], artifact_contract: artifacts([{ id: 'audit', root: 'project', path: 'results/round/audit.json' }]) });
    const gate = stage({ id: 'round_audit', role: 'qa', is_gate: true, artifact_contract: artifacts([{ id: 'verdict', root: 'run', path: 'verdict_round_audit.json' }], [producedRead('audit_input', 'results/round/audit.json', 'audit_work', 'audit')]) });
    const repair = stage({ id: 'fix_round', role: 'coder', depends_on: ['round_audit'], retry_to: ['round_audit'], scope: work.scope });
    expect(admit([gate, repair], brief).errors.join(';')).toContain('ARTIFACT_READ_UNBOUND');
    const reviewed = { ...gate, depends_on: ['audit_work'] };
    expect(admit([work, reviewed, repair], brief).errors).toEqual([]);
    for (const producer of ['round_audit', 'fix_round']) {
      const impostor = { ...gate, artifact_contract: artifacts(gate.artifact_contract!.produces, [producedRead('audit_input', 'results/round/audit.json', producer, 'audit')]) };
      expect(admit([impostor, repair], brief).pass).toBe(false);
    }
  });
});

describe('terminal outcome waits for required settlement', () => {
  it.each([['complete', false], ['complete', true], ['escalated', true]] as const)('runs independent review after the %s terminal report and preserves rejection/repair (%s)', async (outcome, reject) => {
    const project = setup();
    const candidate = JSON.parse(readFileSync(join(root, 'spec/fixtures/planner-admission/rejected.json'), 'utf8'));
    candidate.stages.push({ id: 'repair', role: 'coder', scope: ['results/report.md'], depends_on: ['review'], retry_to: ['review'], artifact_contract: artifacts() });
    const brief = readFileSync(join(root, 'spec/fixtures/planner-admission/brief.md'), 'utf8').replace('  complete:', `  ${outcome}:`);
    const criteria = extractBriefCriteria(brief).criteria;
    const verdict = (pass: boolean) => JSON.stringify({ pass, reason: pass ? 'independently accepted' : 'required parity evidence is missing', criteria: Object.fromEntries(criteria.map(({ id }) => [id, { status: pass ? 'pass' : 'fail', evidence: 'results/parity.json' }])) });
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 1, max_retries: 0 }, stages: candidate.stages });
    const adapter = new ScriptedAdapter({
      implement: { output: 'Measured report', projectFiles: { 'results/report.md': 'measured report', 'results/parity.json': '{}', 'results/benchmark.json': '{}' } },
      review: [{ output: 'review', runFiles: { 'verdict_review.json': verdict(!reject) } }, { output: 'review', runFiles: { 'verdict_review.json': verdict(true) } }],
      repair: { output: 'repaired', projectFiles: { 'results/report.md': 'corrected report' } },
      _summary: { output: 'summary' },
    });
    const final = await runWorkflow(workflow, '', project, adapter, new Map(), undefined, join(root, 'config/agents'), undefined, brief, true);
    expect(final.status, final.failureReason).toBe(outcome);
    expect(adapter.calls.filter(call => !call.stageId.startsWith('_')).map(call => call.stageId)).toEqual(reject ? ['implement', 'review', 'repair', 'review'] : ['implement', 'review']);
    expect(final.stages.review.status).toBe('complete');
  });

  it('does not settle product writes through a reviewer in a skipped branch', async () => {
    const project = setup();
    const work = stage({ id: 'work', role: 'coder', scope: ['report.md', 'value.json'], artifact_contract: artifacts([
      { id: 'report', root: 'project', path: 'report.md' }, { id: 'value', root: 'project', path: 'value.json' },
    ]) });
    const optional = stage({ id: 'optional', role: 'coder', scope: [], depends_on: ['work'], condition: 'work.status == failed' });
    const review = stage({ id: 'review', role: 'qa', is_gate: true, depends_on: ['optional'], artifact_contract: artifacts(
      [{ id: 'verdict', root: 'run', path: 'verdict_review.json' }], [producedRead('value_input', 'value.json', 'work', 'value')],
    ) });
    const repair = stage({ id: 'repair', role: 'coder', scope: work.scope, depends_on: ['review'], retry_to: ['review'] });
    const workflow = WorkflowConfigSchema.parse({ name: 'skippable-review', defaults: { max_iterations: 1, max_retries: 0 }, stages: [work, optional, review, repair, stage({ id: 'settle', role: 'coder', scope: [], depends_on: ['work'] })] });
    const adapter = new ScriptedAdapter({ work: { output: 'product', projectFiles: { 'report.md': 'candidate report', 'value.json': '{}' } }, settle: { output: 'settled' }, _summary: { output: 'summary' } });
    const final = await runWorkflow(workflow, '', project, adapter, new Map(), undefined, join(root, 'config/agents'), undefined,
      '---\nterminal_states:\n  complete:\n    paths: [report.md]\n---\n# Review the product.\n', true);
    expect(final.status).not.toBe('complete');
    expect(final.failureReason).toContain('unreviewed product writes (value.json)');
    expect(readFileSync(join(project, 'value.json'), 'utf8')).toBe('{}');
    expect(adapter.calls.some(call => call.stageId === 'review')).toBe(false);
  });

  it('settles a terminal outcome without executing an inapplicable review branch', async () => {
    const project = setup();
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []', ['author', 'optional', 'review']);
    const state = readRunState(project, created.runId);
    const optional = stage({ id: 'optional', role: 'coder', condition: 'author.status == failed' });
    const review = stage({ id: 'review', role: 'qa', is_gate: true, depends_on: ['optional'] });
    state.terminalStates = { complete: { paths: ['report.md'] } };
    state.planControl = { version: 1, stages: [optional, review], capabilities: [] };
    state.stages.author = { status: 'complete', retries: 0 };
    state.stages.optional = { status: 'skipped', retries: 0 };
    state.stages.review = { status: 'pending', retries: 0 };
    writeFileSync(join(project, 'report.md'), 'fresh result');
    const result = await tryTerminateOnTerminalState(state, { projectDir: project, runId: created.runId, runDirPath: created.runDirPath, iteration: 1, adapter: new ScriptedAdapter({}) });
    expect(result.decision).toBe('matched');
    expect(state.status).toBe('complete');
  });

  it.each(['pending', 'running', 'rejected', 'retired', 'failed_work'] as const)('does not let a fresh report bypass %s required review', async disposition => {
    const project = setup();
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []', ['author', 'review']);
    const state = readRunState(project, created.runId);
    const review = stage({ id: 'review', role: 'qa', is_gate: true });
    state.terminalStates = { complete: { paths: ['report.md'] } };
    state.planControl = { version: 1, stages: [review], capabilities: [] };
    state.stages.author = { status: 'complete', retries: 0 };
    state.stages.review = { status: disposition === 'rejected' ? 'complete' : 'pending', retries: 0 };
    if (disposition === 'running') state.stages.review.status = 'running';
    if (disposition === 'retired') { state.planControl.stages = []; state.unresolvedStageObligations = [{ stageId: 'review', declaredIteration: 1 }]; }
    if (disposition === 'failed_work') { state.planControl.stages = [stage({ id: 'work', role: 'coder' })]; state.stages.work = { status: 'failed', retries: 0 }; }
    writeFileSync(join(project, 'report.md'), 'fresh terminal report');
    if (disposition === 'rejected') writeFileSync(join(created.runDirPath, 'verdict_review.json'), JSON.stringify({ pass: false, reason: 'The required dedicated audit work artifact is absent.' }));
    const result = await tryTerminateOnTerminalState(state, { projectDir: project, runId: created.runId, runDirPath: runDir(project, created.runId), iteration: 1, adapter: new ScriptedAdapter({}) });
    expect(result.decision).toBe('deferred');
    expect(state.status).toBe('running');
    expect(state.stages.review.status).not.toBe('skipped');
  });
});
