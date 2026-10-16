import './test-support/policy-runtime.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkflow, runWorkflow, parseDispatchedStageConfig, inspectDispatchAdmission, WorkflowConfigSchema } from '../src/scheduler.js';
import { raceAdmissionErrors } from '../src/scheduler/sched_admission/configuration.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { renderPlanInterface } from '../src/plan-interface.js';
import { atomicWrite, fcGlobalDir, runDir, setFcGlobalDir, type StoreState } from '../src/store.js';
import { createReadyFinder } from '../src/scheduler/sched_admission/frontier.js';
import type { Adapter, RunOpts } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { parse, stringify } from 'yaml';

const root = join(import.meta.dirname, '..');
const baselineFixture = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/ship-setup-record.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ship-setup-record.js')>();
  return { ...actual, readShipSetupReadyValidationBaseline: (...args: Parameters<typeof actual.readShipSetupReadyValidationBaseline>) => baselineFixture.enabled
    ? { version: 1, projectDir: args[0], discovery: { state: 'configured', configPath: '', commands: [], missingRoles: [] }, results: [], gateCriteria: [] }
    : actual.readShipSetupReadyValidationBaseline(...args) };
});
const roleAdapters = vi.hoisted(() => new Map<string, Adapter>());
vi.mock('../src/adapters/loader.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/adapters/loader.js')>();
  return { ...actual, loadAdapterByName: (name: string) => roleAdapters.get(name) ?? actual.loadAdapterByName(name) };
});
const brief = '# Double integers\n\n## Acceptance criteria\n1. twice doubles integers, including negative values and zero.\n';
const good = 'exports.twice = n => n * 2;\n', bad = 'exports.twice = n => n;\n';
const record = (summary: string, files: string[] = []) => JSON.stringify({ status: 'delivered', summary,
  files_modified: files, checks: [], caveats: [] });
let directory: string;
let previousStore: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'flowcrew-planner-race-')); roleAdapters.clear(); baselineFixture.enabled = false;
  previousStore = fcGlobalDir(); setFcGlobalDir(join(directory, 'state'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(directory, { recursive: true, force: true }); });

function doubles(source: string): boolean {
  const exports: { twice?: (n: number) => number } = {};
  runInNewContext(source, { exports }, { timeout: 1000 });
  return [-5, -1, 0, 1, 5].every(n => exports.twice?.(n) === n * 2);
}

async function fixture(options: { baseline?: boolean; race?: boolean; a?: string; b?: string; neither?: boolean; malformed?: unknown; repair?: boolean; authorAdapter?: boolean; gateAdapter?: boolean; cancel?: boolean; inputCarriers?: boolean; separateReport?: boolean; unassignedReport?: boolean; lastCriterion?: boolean; direct?: boolean; broadScope?: boolean; ancestorCriteria?: boolean; defaultGateRefs?: boolean; omitAncestorEvidence?: boolean; repairReportRefs?: boolean }) {
  const taskBody = options.ancestorCriteria ? '# Double integers\n\n## Acceptance criteria\n1. input.md preserves the settled predecessor input.\n2. twice doubles integers, including negative values and zero.\n' : options.separateReport ? '# Double integers\n\nKeep the source input unchanged.\n\n## Acceptance criteria\n' + (options.lastCriterion
    ? '1. report.md names the implementation.\n2. report.md records the executable check.\n3. twice doubles integers, including negative values and zero.\n   - Preserve negative values in the implementation and literal $&.\n'
    : '1. report.md names the implementation.\n2. twice doubles integers, including negative values and zero.\n3. report.md records the executable check.\n') : brief;
  const task = options.direct ? `---\nworkflow: direct\noutputs: [report.md]\n---\n${taskBody}` : taskBody;
  const taskCriteria = extractBriefCriteria(task).criteria;
  const workRefs = taskCriteria.filter(criterion => criterion.text.startsWith('twice')).map(criterion => criterion.id);
  const reportRefs = taskCriteria.filter(criterion => !workRefs.includes(criterion.id)).map(criterion => criterion.id);
  baselineFixture.enabled = options.baseline ?? false;
  const project = join(directory, 'project'); mkdirSync(project);
  setEngineDefaults({ gate_retry_loops: options.repair ? 1 : 0, stage_technical_retries: 0 });
  const git = (...args: string[]) => execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { execFileSync } from 'node:child_process'; process.stdout.write(execFileSync('git', process.argv.slice(1)));", '--', ...args],
  { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: directory, FC_HOME: join(directory, '.fc') } });
  git('init', '-q'); writeFileSync(join(project, 'twice.js'), bad);
  writeFileSync(join(project, 'input.md'), 'committed input\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  // Each candidate must see current predecessor edits, without moving the parent index.
  writeFileSync(join(project, 'input.md'), 'staged input\n'); git('add', 'input.md');
  writeFileSync(join(project, 'input.md'), 'current predecessor input\n');
  const stagedBefore = git('diff', '--cached');
  const calls: Array<{ id: string; target: string; prompt: string; provider: string }> = [];
  let parentRunDir = '', cancelledAuthors = 0;
  const reviewRefs = options.ancestorCriteria ? taskCriteria.map(criterion => criterion.id) : workRefs;
  const plan = [
    ...(options.ancestorCriteria ? [{ id: 'prepare', role: 'coder', scope: [], criterion_refs: reportRefs }] : []),
    { id: 'implement', role: 'coder', scope: options.broadScope ? ['**', 'twice.js'] : ['twice.js'], ...(options.race === undefined ? {} : { race: options.race }),
      criterion_refs: workRefs, depends_on: options.ancestorCriteria ? ['prepare'] : [],
      ...(options.malformed === undefined ? {} : { race: options.malformed }),
      artifact_contract: { version: 1, produces: [{ id: 'build', root: 'run', path: 'stages/implement/build', kind: 'directory' }], reads: [
        { id: 'state', root: 'run', path: 'run.json', source: options.inputCarriers ? { kind: 'input' } : { kind: 'framework', artifact: 'run_state' } },
        { id: 'task', root: 'run', path: 'task_brief.md', source: options.inputCarriers ? { kind: 'input' } : { kind: 'framework', artifact: 'task_brief' } },
      ], replays: [] } },
    { id: 'review', role: 'qa', depends_on: options.ancestorCriteria ? ['implement', 'prepare'] : ['implement'], is_gate: true, scope: [],
      ...(options.defaultGateRefs ? {} : { criterion_refs: reviewRefs }) },
    { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['twice.js'],
      criterion_refs: options.repairReportRefs ? reportRefs : [] },
    ...(options.separateReport && !options.unassignedReport ? [
      { id: 'report', role: 'coder', depends_on: ['review'], scope: ['report.md'], criterion_refs: reportRefs },
      { id: 'report_review', role: 'qa', depends_on: ['report'], is_gate: true, scope: [], criterion_refs: reportRefs },
      { id: 'report_repair', role: 'coder', depends_on: ['report_review'], retry_to: ['report_review'], scope: ['report.md'] },
    ] : []),
  ];
  const makeAdapter = (provider: string): Adapter => ({ async run(prompt, _role, opts: RunOpts) {
    if (opts.stageId === '_summary') return { output: 'Summary.', exitCode: 0, duration_ms: 1 };
    calls.push({ id: opts.stageId, target: opts.workDir, prompt, provider });
    if (opts.stageId === 'plan') {
      parentRunDir = opts.runDir;
      writeFileSync(join(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages: plan }));
      return { output: record('Authored the execution plan.'), exitCode: 0, duration_ms: 1,
        writes: ['run:dispatch.yaml'], writeAttribution: 'structured' };
    }
    if (opts.stageId === 'prepare') return { output: record('Settled predecessor input.'), exitCode: 0, duration_ms: 1 };
    if (opts.stageId === 'implement') {
      expect(JSON.parse(readFileSync(join(opts.runDir, 'run.json'), 'utf8')).projectDir).toBe(opts.workDir);
      expect(readFileSync(join(opts.workDir, 'input.md'), 'utf8')).toBe('current predecessor input\n');
      if (options.cancel) {
        if (calls.filter(call => call.id === 'implement').length === 1) {
          mkdirSync(join(parentRunDir, 'signals'), { recursive: true });
          atomicWrite(join(parentRunDir, 'signals/abort_implement.json'), JSON.stringify({
            version: 1, stageId: 'implement', attemptIndex: 1, reason: 'Cancel the active candidate',
            timestamp: new Date().toISOString(), source: 'supervisor',
          }));
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5000);
          const closed = () => { clearTimeout(timer); resolve(); };
          if (opts.abortSignal!.aborted) closed();
          else opts.abortSignal!.addEventListener('abort', closed, { once: true });
        });
        if (opts.abortSignal!.aborted) cancelledAuthors++;
        return { output: 'Candidate closed after cancellation.', exitCode: 1, duration_ms: 1 };
      }
      const source = options.neither ? bad : basename(opts.workDir) === 'a' ? options.a ?? good
        : basename(opts.workDir) === 'b' ? options.b ?? good : good;
      writeFileSync(join(opts.workDir, 'twice.js'), source);
      mkdirSync(join(opts.runDir, 'stages/implement/build'), { recursive: true });
      writeFileSync(join(opts.runDir, 'stages/implement/build/result.txt'), 'candidate build artifact\n');
      return { output: record('Implemented doubling.', ['twice.js']), exitCode: 0, duration_ms: 1,
        writes: ['twice.js', 'run:stages/implement/build/result.txt'], writeAttribution: 'structured' };
    }
    if (opts.stageId === 'repair') {
      writeFileSync(join(opts.workDir, 'twice.js'), good);
      return { output: record('Repaired doubling.', ['twice.js']), exitCode: 0, duration_ms: 1,
        writes: ['twice.js'], writeAttribution: 'structured' };
    }
    if (opts.stageId === 'report' || opts.stageId === 'report_repair') {
      writeFileSync(join(opts.workDir, 'report.md'), 'Implemented twice; checked negative values and zero.\n');
      return { output: record('Reported doubling.', ['report.md']), exitCode: 0, duration_ms: 1,
        writes: ['report.md'], writeAttribution: 'structured' };
    }
    const pass = doubles(readFileSync(join(opts.workDir, 'twice.js'), 'utf8'));
    const { criteria: admittedCriteria } = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8'));
    const refs = opts.stageId === 'report_review' ? reportRefs : options.omitAncestorEvidence ? workRefs : reviewRefs;
    const gatePass = pass && (opts.stageId !== 'report_review' || readFileSync(join(opts.workDir, 'report.md'), 'utf8').includes('checked negative values and zero'));
    const criteria = Object.fromEntries(admittedCriteria.filter(({ id }: { id: string }) => refs.includes(id)).map(({ id }: { id: string }) => [id,
      { status: pass ? 'pass' : 'fail', evidence: workRefs.includes(id) ? 'Executed twice(-5, -1, 0, 1, 5) against n * 2.'
        : `Read settled input: ${readFileSync(join(opts.workDir, 'input.md'), 'utf8').trim()}` }]));
    return { output: JSON.stringify({ pass: gatePass, reason: gatePass ? 'Independent oracle passed.' : 'Independent oracle rejected.',
      criteria, audit_findings: { version: 1, findings: [] },
      ...(pass ? {} : { repairability: { version: 1, disposition: options.repair ? 'repairable' : 'irreparable', evidence: 'The executable oracle requires doubling.' } }) }),
      exitCode: 0, duration_ms: 1 };
  } });
  const adapter = makeAdapter('default');
  let agentsDir = join(root, 'config/agents');
  if (options.authorAdapter || options.gateAdapter || options.cancel) {
    agentsDir = join(project, 'config/agents'); mkdirSync(agentsDir, { recursive: true });
    for (const name of ['planner', 'coder', 'qa']) {
      const role = parse(readFileSync(join(root, `config/agents/${name}.yaml`), 'utf8'));
      if (name === 'coder') role.adapter = 'fixture_author';
      if (name === 'qa' && options.gateAdapter) role.adapter = 'fixture_gate';
      writeFileSync(join(agentsDir, `${name}.yaml`), JSON.stringify(role));
    }
    roleAdapters.set('fixture_author', makeAdapter('author'));
    roleAdapters.set('fixture_gate', makeAdapter('gate'));
  }
  const { config } = loadWorkflow(join(root, options.direct ? 'config/workflows/direct.yaml' : 'config/workflows/default.yaml'));
  if (options.direct) delete config.dispatch;
  config.defaults.max_iterations = 1; config.defaults.max_retries = 0;
  const state = await runWorkflow(config, stringify(config), project, adapter, new Map(), undefined,
    agentsDir, undefined, task, false, false);
  expect(git('diff', '--cached')).toBe(stagedBefore);
  expect(readFileSync(join(project, 'input.md'), 'utf8')).toBe('current predecessor input\n');
  const evidence = join(runDir(project, state.runId), 'stages/implement/race_1.json');
  const race = options.race && options.malformed === undefined && !options.unassignedReport ? JSON.parse(readFileSync(evidence, 'utf8')) : undefined;
  return { state, calls, race, project, cancelledAuthors, taskCriteria };
}

describe('planner-selected stage races', () => {
  it.each([false, true])('accepts the winner without a parent gate stage execution (setup baseline: %s)', async baseline => {
    const { state, calls, race, project } = await fixture({ race: true, baseline });
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.map(call => call.id)).toEqual(['plan', 'implement', 'review']);
    expect(calls.filter(call => call.target === project).map(call => call.id)).toEqual(['plan']);
    if (baseline) expect(JSON.parse(readFileSync(join(runDir(project, state.runId), 'validation_baseline.json'), 'utf8')))
      .toMatchObject({ source: 'ship-setup-ready-record' });
    expect(state.stages.review.attempts ?? []).toEqual([]);
    expect(state.stages.review.acceptedFrom).toMatchObject({ runId: race.candidates[0].runId, verdict: { pass: true } });
    expect(state.stages.repair.status).toBe('skipped');
  }, 90_000);

  it.each([false, true])('settles a direct planner race before a later author produces the declared report (broad scope: %s)', async broadScope => {
    const { state, calls, project } = await fixture({ race: true, separateReport: true, direct: true, broadScope });
    expect(state.status, state.failureReason).toBe('complete');
    expect(state.workflowName).toBe('direct');
    expect(calls.filter(call => call.id === 'plan')).toHaveLength(1);
    expect(calls.filter(call => call.id === 'implement')).toHaveLength(1);
    expect(state.stages.report.status).toBe('complete');
    expect(calls.filter(call => call.id === 'report_review' && call.target === project)).toHaveLength(1);
    expect(readFileSync(join(project, 'report.md'), 'utf8')).toContain('checked negative values and zero');
  });
  it('completes one passing candidate with an unused repair and then the parent report', async () => {
    const { state, calls, race, project } = await fixture({ race: true, repair: true, separateReport: true });
    expect(state.status, state.failureReason).toBe('complete');
    expect(race.gateAttempts).toEqual([expect.objectContaining({ label: 'A', pass: true, status: 'complete' })]);
    expect(calls.filter(call => call.id === 'repair')).toHaveLength(0);
    expect(calls.filter(call => call.id === 'implement')).toHaveLength(1);
    expect(race.candidates).toHaveLength(1);
    expect(race.version).toBe(3);
    expect(race.decision).toMatchObject({ choice: 'A', basis: 'first-passed' });
    expect(state.stages.repair.status).toBe('skipped');
    expect(state.stages.report.status).toBe('complete');
    expect(readFileSync(join(project, 'report.md'), 'utf8')).toContain('checked negative values and zero');
  });
  it('admits and gates the raced author criteria before a separate report stage', async () => {
    const { state, calls, race, project, taskCriteria } = await fixture({ race: true, separateReport: true, repair: true, a: bad, repairReportRefs: true });
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.filter(call => call.id === 'implement')).toHaveLength(1);
    expect(calls.filter(call => call.id === 'repair')).toHaveLength(1);
    expect(calls.filter(call => call.id === 'report')).toHaveLength(1);
    for (const author of calls.filter(call => call.id === 'implement')) {
      expect(author.prompt).toContain('Keep the source input unchanged.');
      expect(author.prompt).not.toContain('report.md names the implementation');
      expect(author.prompt).not.toContain('report.md records the executable check');
    }
    expect(readFileSync(join(project, 'report.md'), 'utf8')).toContain('checked negative values and zero');
    for (const candidate of race.candidates) {
      const child = runDir(candidate.target, candidate.runId);
      const childBrief = readFileSync(join(child, 'task_brief.md'), 'utf8');
      const criteria = JSON.parse(readFileSync(join(child, 'brief_criteria.json'), 'utf8'));
      expect(criteria).toEqual(extractBriefCriteria(childBrief));
      expect(criteria.criteria.map(({ id }: { id: string }) => id)).toEqual([taskCriteria[1].id]);
      const workflow = parse(readFileSync(join(child, 'workflow.yaml'), 'utf8'));
      expect(workflow.stages.map((stage: { id: string }) => stage.id)).toEqual(['implement', 'review', 'repair']);
      expect(workflow.stages.flatMap((stage: { criterion_refs: string[] }) => stage.criterion_refs))
        .toEqual([taskCriteria[1].id, taskCriteria[1].id]);
    }
  });
  it.each([false, true])('settles all gate criteria when the raced author owns a subset (omitted gate refs: %s)', async defaultGateRefs => {
    const { state, calls, race, project, taskCriteria } = await fixture({ race: true, ancestorCriteria: true, defaultGateRefs });
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.map(call => call.id)).toEqual(['plan', 'prepare', 'implement', 'review']);
    expect(calls.filter(call => call.id === 'review' && call.target === project)).toEqual([]);
    expect(state.stages.review.attempts ?? []).toEqual([]);
    expect(state.stages.review.acceptedFrom!.verdict.pass).toBe(true);
    const child = runDir(race.candidates[0].target, race.candidates[0].runId);
    expect(JSON.parse(readFileSync(join(child, 'verdict_review.json'), 'utf8'))).toMatchObject({ pass: true,
      criteria: Object.fromEntries(taskCriteria.map(criterion => [criterion.id, { status: 'pass', evidence: expect.any(String) }])) });
    expect(extractBriefCriteria(readFileSync(join(child, 'task_brief.md'), 'utf8')).criteria.map(criterion => criterion.id))
      .toEqual(taskCriteria.map(criterion => criterion.id));
    const workflow = parse(readFileSync(join(child, 'workflow.yaml'), 'utf8'));
    expect(workflow.stages.find((stage: { id: string }) => stage.id === 'review').criterion_refs)
      .toEqual(taskCriteria.map(criterion => criterion.id));
    const author = calls.find(call => call.id === 'implement')!;
    expect(author.prompt).not.toContain('input.md preserves the settled predecessor input');
    expect(calls.find(call => call.id === 'review')!.prompt).toContain('input.md preserves the settled predecessor input');
  });
  it('rejects both candidates when their gate omits evidence outside the author subset', async () => {
    const { state, calls, race } = await fixture({ race: true, ancestorCriteria: true, defaultGateRefs: true, omitAncestorEvidence: true });
    expect(state.status).not.toBe('complete');
    expect(race.decision.basis).toBe('none-passed');
    expect(race.candidates.map((candidate: { gatePassed: boolean }) => candidate.gatePassed)).toEqual([false, false]);
    expect(new Set(calls.filter(call => call.id === 'review').map(call => call.target)).size).toBe(2);
    expect(state.stages.review.acceptedFrom).toBeUndefined();
  });
  it('still refuses a parent plan that leaves report criteria without an author', async () => {
    const { state, calls } = await fixture({ race: true, separateReport: true, unassignedReport: true });
    expect(['failed', 'escalated', 'incomplete']).toContain(state.status);
    expect(calls.every(call => call.id === 'plan')).toBe(true);
    const admission = readFileSync(join(runDir(state.projectDir, state.runId), 'dispatch_admission.json'), 'utf8');
    expect(admission).toContain('not assigned to a work stage or gate');
  });
  it('preserves the owned final criterion and its nested duties in compiled author prompts', async () => {
    const { state, calls } = await fixture({ race: true, separateReport: true, lastCriterion: true });
    expect(state.status, state.failureReason).toBe('complete');
    for (const author of calls.filter(call => call.id === 'implement')) {
      expect(author.prompt).toContain('3. twice doubles integers');
      expect(author.prompt).toContain('   - Preserve negative values in the implementation and literal $&.');
      expect(author.prompt).toContain(`Project: ${author.target}`);
      expect(author.prompt).not.toContain('report.md names the implementation');
    }
  });
  it('authors the alternative only after the first gate fails and integrates its outputs', async () => {
    const { state, calls, race, project } = await fixture({ race: true, a: bad });
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.map(call => call.id)).toEqual(['plan', 'implement', 'review', 'implement', 'review']);
    const authors = calls.filter(call => call.id === 'implement');
    expect(new Set(authors.map(call => call.target)).size).toBe(2);
    expect(authors.every(call => call.target !== project)).toBe(true);
    expect(authors.find(call => basename(call.target) === 'a')!.prompt).toContain("the observable behaviour the task's author expects");
    expect(race.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(race.gateAttempts).toEqual([expect.objectContaining({ label: 'A', pass: false }), expect.objectContaining({ label: 'B', pass: true })]);
    expect(doubles(readFileSync(join(project, 'twice.js'), 'utf8'))).toBe(true);
    expect(readFileSync(join(runDir(project, state.runId), 'stages/implement/build/result.txt'), 'utf8')).toContain('build artifact');
    expect(readFileSync(join(runDir(project, state.runId), 'stages/implement/candidate_1_b.patch'), 'utf8')).toContain(good.trim());
  }, 90_000);

  it('tries the alternative when the first candidate cannot pass an independent gate', async () => {
    const { state, race, calls } = await fixture({ race: true, a: bad, b: good });
    expect(state.status, state.failureReason).toBe('complete');
    expect(race.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(race.gateAttempts.map((attempt: { pass: boolean }) => attempt.pass)).toEqual([false, true]);
    expect(calls.filter(call => call.id === 'review')).toHaveLength(2);
  }, 90_000);

  it('leaves the parent unchanged when neither candidate passes', async () => {
    const { state, race, project } = await fixture({ race: true, neither: true });
    expect(state.status).not.toBe('complete');
    expect(race.decision.basis).toBe('none-passed');
    expect(readFileSync(join(project, 'twice.js'), 'utf8')).toBe(bad);
  }, 90_000);

  it('reuses bounded candidate repair and reports the actual repair attempts', async () => {
    const { state, race, calls, project } = await fixture({ race: true, a: bad, b: bad, repair: true });
    expect(state.status, state.failureReason).toBe('complete');
    expect(race.decision).toMatchObject({ choice: 'A', basis: 'first-passed' });
    expect(race.candidates.find((candidate: { label: string }) => candidate.label === 'A').repairs).toBe(1);
    expect(calls.filter(call => call.id === 'repair')).toHaveLength(1);
    expect(calls.filter(call => call.id === 'implement')).toHaveLength(1);
    expect(race.candidates).toHaveLength(1);
    expect(doubles(readFileSync(join(project, 'twice.js'), 'utf8'))).toBe(true);
    expect(calls.filter(call => call.id === 'review')).toHaveLength(2);
    expect(calls.filter(call => call.id === 'review' && call.target === project)).toEqual([]);
    expect(state.stages.review.attempts ?? []).toEqual([]);
    expect(state.stages.review.acceptedFrom).toMatchObject({ runId: race.candidates[0].runId, verdict: { pass: true } });
  }, 90_000);

  it.each([false, true])('preserves per-role adapters with gate override=%s', async gateAdapter => {
    const { state, calls } = await fixture({ race: true, authorAdapter: true, gateAdapter });
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.filter(call => call.id === 'implement').map(call => call.provider))
      .toEqual(['author']);
    expect(calls.filter(call => call.id === 'review').map(call => call.provider))
      .toEqual([gateAdapter ? 'gate' : 'default']);
  }, 90_000);

  it('closes the active role-selected candidate when the parent attempt is cancelled', async () => {
    const { state, calls, project, cancelledAuthors } = await fixture({ race: true, cancel: true });
    expect(state.status).not.toBe('complete');
    expect(cancelledAuthors).toBe(1);
    expect(calls.map(call => call.id)).toEqual(['plan', 'implement']);
    expect(readFileSync(join(project, 'twice.js'), 'utf8')).toBe(bad);
  }, 90_000);

  it('keeps child carrier ownership when run identity reads are labelled as inputs', async () => {
    const { state } = await fixture({ race: true, inputCarriers: true });
    expect(state.status, state.failureReason).toBe('complete');
  }, 90_000);

  it.each([undefined, false])('retains one ordinary author with race=%s', async race => {
    const { state, calls } = await fixture({ race });
    expect(state.status, state.failureReason).toBe('complete');
    expect(calls.map(call => call.id)).toEqual(['plan', 'implement', 'review']);
  }, 90_000);

  it('admits a gate with review duties beyond the raced author', () => {
    const work = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['src/**'], race: true, criterion_refs: ['own'] });
    const review = parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [], criterion_refs: ['own', 'ancestor'] });
    expect(raceAdmissionErrors(work, [work, review])).toEqual([]);
    expect(raceAdmissionErrors({ ...work, race: false }, [work, review])).toEqual([]);
  });

  it('refuses malformed planner race dispatch before any author runs', async () => {
    const { state, calls } = await fixture({ malformed: { candidates: 2 } });
    expect(state.status).not.toBe('complete');
    expect(calls.every(call => call.id === 'plan')).toBe(true);
    const admission = JSON.parse(readFileSync(join(runDir(state.projectDir, state.runId), 'dispatch_admission.json'), 'utf8'));
    expect(admission.pass).toBe(false);
    expect(admission.errors).toContainEqual(expect.stringMatching(/implement: invalid schema.*race/));
  }, 90_000);

  it.each([
    { is_gate: true }, { dynamic_dispatch: true }, { retry_to: ['review'], depends_on: ['review'] },
  ])('refuses race on a non-author (%j)', extra => {
    const work = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['twice.js'], race: true, ...extra });
    const gate = parseDispatchedStageConfig({ id: 'review', role: 'qa', is_gate: true, scope: [], depends_on: ['work'] });
    expect(inspectDispatchAdmission({ dispatched: [work, gate], baseStages: [], dispatchStageId: 'plan' }).errors.join(';')).toContain('race: only ordinary author');
  });

  it.each(['missing', 'same_role', 'other_author', 'repair_scope', 'repair_peer', 'repair_condition'])('refuses an unsafe race gate graph (%s)', kind => {
    const work = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['twice.js'], race: true });
    const gate = parseDispatchedStageConfig({ id: 'review', role: kind === 'same_role' ? 'coder' : 'qa', is_gate: true, scope: [],
      depends_on: kind === 'other_author' ? ['work', 'peer'] : ['work'],
 });
    const stages = kind === 'missing' ? [work] : [work, gate];
    if (kind === 'other_author') stages.push(parseDispatchedStageConfig({ id: 'peer', role: 'coder' }));
    if (kind === 'repair_scope') stages.push(parseDispatchedStageConfig({ id: 'repair', role: 'coder', scope: ['other.js'], depends_on: ['review'], retry_to: ['review'] }));
    if (kind === 'repair_peer') stages.push(parseDispatchedStageConfig({ id: 'peer', role: 'coder' }),
      parseDispatchedStageConfig({ id: 'repair', role: 'coder', scope: ['twice.js'], depends_on: ['review', 'peer'], retry_to: ['review'] }));
    if (kind === 'repair_condition') stages.push(parseDispatchedStageConfig({ id: 'peer', role: 'coder' }),
      parseDispatchedStageConfig({ id: 'repair', role: 'coder', scope: ['twice.js'], depends_on: ['review'], retry_to: ['review'], condition: 'peer.status == "complete"' }));
    expect(inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan' }).errors.join(';')).toContain('.race:');
    expect(() => prepareWorkflowLaunch(WorkflowConfigSchema.parse({ name: 'fixture', stages }), '', directory)).toThrow(/\.race:/);
  });

  it.each(['src/widget.ts', 'src/widgets/**'])('admits a candidate repair within the author tree (%s)', scope => {
    const work = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['src/**'], race: true });
    const review = parseDispatchedStageConfig({ id: 'review', role: 'qa', is_gate: true, depends_on: ['work'], scope: [] });
    const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: [scope] });
    expect(inspectDispatchAdmission({ dispatched: [work, review, repair], baseStages: [], dispatchStageId: 'plan' }).errors).toEqual([]);
    repair.scope = ['other/widget.ts'];
    expect(inspectDispatchAdmission({ dispatched: [work, review, repair], baseStages: [], dispatchStageId: 'plan' }).errors.join(';')).toContain('must stay within');
  });

  it('starts a raced author only after its projected ancestor inputs have completed', () => {
    const prepare = parseDispatchedStageConfig({ id: 'prepare', role: 'researcher' });
    const work = parseDispatchedStageConfig({ id: 'work', role: 'coder', depends_on: ['prepare'], scope: ['src/**'], race: true });
    const review = parseDispatchedStageConfig({ id: 'review', role: 'qa', is_gate: true, depends_on: ['work', 'prepare'] });
    const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['src/**'] });
    const stages = [prepare, work, review, repair];
    expect(inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: 'plan' }).errors).toEqual([]);
    const ready = createReadyFinder({ loadGateContract: () => null, readGateVerdict: () => null });
    const state = { stages: { prepare: { status: 'pending', retries: 0 }, work: { status: 'pending', retries: 0 }, review: { status: 'pending', retries: 0 } } } as StoreState;
    for (const status of ['pending', 'skipped', 'failed', 'complete'] as const) {
      state.stages.prepare.status = status;
      expect(ready(stages, state).some(stage => stage.id === 'work')).toBe(status === 'complete');
    }
  });

  it('teaches the planner selective correctness competition and exposes the typed capability', () => {
    const planner = parse(readFileSync(join(root, 'config/agents/planner.yaml'), 'utf8'));
    expect(planner.prompt).toContain('Select race: true per ordinary implementation stage');
    expect(planner.prompt).toContain('Default to one author for mechanical edits');
    expect(renderPlanInterface()).toContain('"race":{"type":"boolean"}');
    expect(renderPlanInterface()).toContain('Gates, planners and repairs cannot race');
  });
});
