import { runRecordPath, stageWorkPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPlanCheck, renderPlanInterface } from '../src/plan-interface.js';
import * as admission from '../src/scheduler/sched_admission/dispatch.js';
import * as realityReads from '../src/scheduler/sched_admission/reality-reads.js';
import { createDispatchInjector } from '../src/scheduler/sched_policy/dispatch-injection.js';
import { firstImmutableEvidenceConflict, resolveImmutableEvidenceBindings } from '../src/scheduler/sched_scope/path-capabilities.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import * as configuration from '../src/scheduler/sched_admission/configuration.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { log } from '../src/scheduler/sched_admission/shared.js';
import { buildRetryPreamble } from '../src/scheduler/sched_admission/dispatch-retry.js';

const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'spec/fixtures/planner-admission');
const brief = readFileSync(join(fixture, 'brief.md'), 'utf8');
const rejected = JSON.parse(readFileSync(join(fixture, 'rejected.json'), 'utf8'));
const temporary: string[] = [];
const priorHome = fcGlobalDir();
afterEach(() => { vi.restoreAllMocks(); setFcGlobalDir(priorHome); for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(candidate = rejected) {
  const dir = mkdtempSync(join(tmpdir(), 'fc-planner-admission-')); temporary.push(dir);
  const project = join(dir, 'project'); mkdirSync(project);
  setFcGlobalDir(join(dir, 'store'));
  const rolesPath = join(project, 'config/agents'); mkdirSync(rolesPath, { recursive: true });
  for (const role of ['planner', 'coder', 'qa']) writeFileSync(join(rolesPath, `${role}.yaml`), `name: ${role}\ndescription: Fixture role\n`);
  const workflow = 'name: fixture\nstages:\n  - id: plan\n    role: planner\n    dynamic_dispatch: true\n    artifact_contract: {version: 1, produces: [], reads: [], groups: []}\n';
  const { runId } = createRun(project, 'fixture', workflow, ['plan'], brief);
  const directory = runDir(project, runId);
  writeFileSync(runRecordPath(directory, 'task_brief.md'), brief);
  writeFileSync(runRecordPath(directory, 'brief_criteria.json'), JSON.stringify(extractBriefCriteria(brief)));
  updateRunState(project, runId, state => { state.terminalStates = parseBriefFrontmatter(brief).terminalStates; });
  const draft = stageWorkPath(directory, 'draft.json'); writeFileSync(draft, JSON.stringify(candidate));
  return { project, runId, directory, draft, workflow };
}

async function check(ctx: ReturnType<typeof setup>) {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text: string | Uint8Array) => { chunks.push(String(text)); return true; });
  const exitCode = await cmdPlanCheck(['plan-check', '--project', ctx.project, '--run', ctx.directory, ctx.draft]);
  vi.mocked(process.stdout.write).mockRestore();
  return { exitCode, report: JSON.parse(chunks.join('')) };
}

function inject(ctx: ReturnType<typeof setup>, dispatchStageId = 'plan') {
  writeFileSync(stageWorkPath(ctx.directory, 'dispatch.yaml'), readFileSync(ctx.draft));
  const roles = admission.buildRoleRegistry(join(ctx.project, 'config/agents'));
  const sorted = admission.loadWorkflow(runRecordPath(ctx.directory, 'workflow.yaml')).config.stages;
  const { injectDispatchedStages } = createDispatchInjector({ inspectDispatchAdmission: admission.createDispatchAdmission(), resolveImmutableEvidenceBindings });
  injectDispatchedStages(dispatchStageId, roles, sorted, readRunState(ctx.project, ctx.runId), ctx.project, ctx.runId, true);
  return JSON.parse(readFileSync(runRecordPath(ctx.directory, 'dispatch_admission.json'), 'utf8'));
}

describe('optional planner proposal diagnostics', () => {
  it('exposes every dispatch admission error code through the same validators used by injection', async () => {
    // No copied rule catalog: derive the transport probes from the owners themselves.
    // Schema/parser errors are tested below; uncoded topology errors use the real reproduction.
    const seen = new Set<string>();
    const sources: string[] = [];
    function collect(path: string): void {
      if (seen.has(path)) return;
      seen.add(path);
      const source = readFileSync(path, 'utf8'); sources.push(source);
      // A dependency-closure superset avoids a hand-maintained error-code list,
      // including codes returned by nested artifact and reality-check handlers.
      for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+\.js)['"]/g)) {
        const dependency = resolve(dirname(path), match[1].replace(/\.js$/, '.ts'));
        if (existsSync(dependency)) collect(dependency);
      }
    }
    collect(join(root, 'src/scheduler/sched_policy/dispatch-injection.ts'));
    collect(join(root, 'src/plan-interface.ts')); // Includes the concrete injected input/scope services.
    const codes = [...new Set(sources.flatMap(source => [...source.matchAll(/\b([A-Z][A-Z_]+):|\bcode:\s*['"]([a-z][a-z_]+)['"]/g)].map(match => match[1] ?? match[2])))].filter(code => code !== 'custom').sort();
    expect(codes.length).toBeGreaterThan(15);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const errors = codes.map(code => admission.admissionError(code, `${code}: admission transport probe`, 'probe'));
    const actual = admission.createDispatchAdmission();
    const validator = vi.fn((input: Parameters<typeof actual>[0]) => ({ ...actual(input), pass: false, errors: [...errors] }));
    vi.spyOn(admission, 'createDispatchAdmission').mockReturnValue(validator);
    const reachability = vi.spyOn(realityReads, 'inspectRealityCheckReachability').mockReturnValue(['reachability probe']);
    const parser = vi.spyOn(configuration, 'parseDispatchedStageConfig');
    const ctx = setup(); writeFileSync(runRecordPath(ctx.directory, 'reality_checks.md'), 'No additional hard checks.');
    const checked = await check(ctx);
    const live = inject(ctx);
    expect(checked.report.errors).toEqual(live.errors);
    expect(checked.report.errors).toEqual([...errors, admission.admissionError('reality_check_invalid', 'reachability probe', 'reality_checks')]);
    expect(validator).toHaveBeenCalledTimes(2);
    expect(reachability).toHaveBeenCalledTimes(2);
    expect(parser).toHaveBeenCalledTimes(4);
    expect(renderPlanInterface()).toContain('dispatch.yaml');
  });

  it('reports the missing repair route while admitting report then review topology', async () => {
    const ctx = setup();
    const snapshot = () => Object.fromEntries(readdirSync(ctx.directory, { recursive: true }).map(String)
      .filter(name => statSync(join(ctx.directory, name)).isFile()).map(name => [name, readFileSync(join(ctx.directory, name), 'utf8')]));
    const before = snapshot();
    const { exitCode, report } = await check(ctx);
    expect(exitCode).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'stage_retry_to', stageId: 'review', field: 'retry_to' }));
    expect(report.errors.map(error => error.message)).toContain('review: missing repair route (no ordinary stage declares retry_to: [review], depends_on: [review]); repair rounds are bounded by gate_retry_loops.');
    expect(snapshot()).toEqual(before);
    expect(report.errors).toEqual(inject(ctx).errors);
    mkdirSync(runRecordPath(ctx.directory, 'stages/plan'), { recursive: true });
    writeFileSync(runRecordPath(ctx.directory, 'stages/plan/status.json'), JSON.stringify({ admissionFailure: { code: 'dispatch_refused', attemptIndex: 0 }, error: `invalid dispatch.yaml: dispatch admission rejected the complete proposal before stage injection.\nExact admission errors:\n${report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')}` }));
    const retry = buildRetryPreamble(1, 1000, ctx.directory, 'plan');
    expect(retry).toContain('RE-PLAN');
    const facts = JSON.parse(retry.split('# Dispatch admission facts\n')[1].split('\n')[0]);
    for (const error of report.errors) expect(facts.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: error.message })]));
  });

  it('lets the planner correct a missing repair route within its own read-only plan-check', async () => {
    const ctx = setup();
    updateRunState(ctx.project, ctx.runId, state => { delete state.terminalStates; });
    rmSync(runRecordPath(ctx.directory, 'brief_criteria.json'));
    writeFileSync(runRecordPath(ctx.directory, 'task_brief.md'), '# Review the report\n');
    const refused = await check(ctx);
    expect(refused.exitCode).toBe(1);
    expect(refused.report.errors).toEqual([expect.objectContaining({ field: 'retry_to', stageId: 'review', message: expect.stringContaining('review: missing repair route') })]);
    expect(refused.report.errors).toEqual(inject(ctx).errors);
    const corrected = structuredClone(rejected);
    corrected.stages.push({ id: 'repair', role: 'coder', scope: ['results/report.md'], depends_on: ['review'], retry_to: ['review'] });
    // A second planner also owns dispatch.yaml; order that output after plan
    // so this probe isolates whether a planner can count as ordinary repair.
    writeFileSync(ctx.draft, JSON.stringify({ stages: corrected.stages.map(stage => stage.id === 'repair'
      ? { ...stage, dynamic_dispatch: true, depends_on: ['plan', 'review'] } : stage) }));
    const plannerRoute = await check(ctx);
    expect(plannerRoute.exitCode).toBe(1);
    expect(plannerRoute.report.errors).toEqual([expect.objectContaining({ field: 'retry_to', stageId: 'review', message: expect.stringContaining('review: missing repair route') })]);
    writeFileSync(ctx.draft, JSON.stringify(corrected));
    const admitted = await check(ctx);
    expect(admitted.exitCode).toBe(0);
    expect(admitted.report.errors).toEqual([]);
    expect(admitted.report.errors).toEqual(inject(ctx).errors);
    expect(readRunState(ctx.project, ctx.runId).stages).not.toHaveProperty('repair');
  });

  it('reports malformed stages and prose conditions together', async () => {
    const candidate = structuredClone(rejected);
    candidate.stages.push({ id: 'bad_scope', role: 'coder', scope: 12 });
    candidate.stages.push({ id: 'bad_gate', role: 'qa', is_gate: true, retry_to: ['review'], depends_on: ['review'] });
    candidate.stages.push({ id: 'repair', role: 'coder', scope: ['results/report.md'], depends_on: ['review'], retry_to: ['review'], condition: 'Run if review rejects.' });
    const ctx = setup(candidate);
    const { report } = await check(ctx);
    expect(report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('bad_scope: invalid schema');
    expect(report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('gate stages cannot declare retry_to');
    expect(report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')).toContain('No operator found');
    expect(report.errors).toEqual(inject(ctx).errors);
  });

  it('includes schema issues after the eighth issue in the retry diagnostics', () => {
    const parsed = admission.formatDispatchStageSchemaFailure;
    const invalid = StageConfigSchema.safeParse({ id: 1, role: 2, depends_on: 3, scope: 4, condition: 5, skills: 6, is_gate: 7, dynamic_dispatch: 8, retry_to: 9, criterion_refs: 10, prompt_template: 11 });
    if (invalid.success) throw new Error('Fixture must be invalid');
    const message = parsed(invalid.error);
    for (const issue of invalid.error.issues) expect(message).toContain(`${issue.path.join('.')}:`);
    expect(message).not.toContain('more)');
  });
});


it.each(['initial', 'archived-final', 'active-replan', 'alternate-replan', 'active-planner'] as const)(
  'uses the real scheduler context for retained stage ids: %s', async mode => {
    const candidate = structuredClone(rejected);
    candidate.stages.push({ id: 'repair', role: 'coder', scope: ['results/report.md'], depends_on: ['review'], retry_to: ['review'] });
    const ctx = setup(candidate);
    const plannerId = mode === 'alternate-replan' || mode === 'active-planner' ? 'revise' : 'plan';
    const bootstrap = admission.loadWorkflow(runRecordPath(ctx.directory, 'workflow.yaml')).config.stages;
    if (plannerId !== 'plan') bootstrap.push(StageConfigSchema.parse({ id: plannerId, role: 'planner', dynamic_dispatch: true, depends_on: ['plan'] }));
    const retained = candidate.stages.map(stage => StageConfigSchema.parse(stage));
    const recorded = mode === 'initial' || mode === 'active-planner' ? bootstrap : [...bootstrap, ...retained];
    writeFileSync(runRecordPath(ctx.directory, 'workflow.yaml'), JSON.stringify({ name: 'fixture', stages: recorded }));
    updateRunState(ctx.project, ctx.runId, state => {
      state.stages.implement = { status: 'complete', retries: 0 };
      if (mode !== 'initial') state.planControl = { version: 1, stages: recorded, capabilities: [] };
      if (mode === 'active-planner') state.stages[plannerId] = { status: 'running', retries: 0 };
      if (mode.includes('replan')) state.decisionGraph = { records: [], visits: {}, replan: { stageId: plannerId, reason: 'Revise retained work.' } };
    });
    const actual = admission.createDispatchAdmission();
    const validator = vi.fn(actual);
    vi.spyOn(admission, 'createDispatchAdmission').mockReturnValue(validator);
    const cli = await check(ctx);
    const scheduler = inject(ctx, plannerId);
    expect(cli.report.diagnostic).toContain('does not certify revision commit eligibility');
    const stable = ({ checkedAt: _clock, diagnostic: _diagnostic, ...report }: typeof scheduler) => report;
    expect(stable(cli.report)).toEqual(stable(scheduler));
    expect(cli.exitCode).toBe(mode === 'archived-final' ? 1 : 0);
    expect(cli.report.proposalDigest).toBe(scheduler.proposalDigest);
    const selected = validator.mock.calls.map(([input]) => ({ ids: input.baseStages.map(stage => stage.id), planner: input.dispatchStageId }));
    expect(selected).toEqual(Array(2).fill({ ids: (mode.includes('replan') ? bootstrap : recorded).map(stage => stage.id), planner: plannerId }));
    if (mode === 'archived-final') expect(cli.report.errors).toContainEqual(expect.objectContaining({ code: 'stage_id_duplicate', stageId: 'implement' }));
    expect(readRunState(ctx.project, ctx.runId).stages.implement.status).toBe('complete');
  },
);


it('reports an ambiguous diagnostic planner identity instead of guessing', async () => {
  const ctx = setup();
  const workflow = admission.loadWorkflow(runRecordPath(ctx.directory, 'workflow.yaml')).config;
  workflow.stages.push(StageConfigSchema.parse({ id: 'another', role: 'planner', dynamic_dispatch: true }));
  writeFileSync(runRecordPath(ctx.directory, 'workflow.yaml'), JSON.stringify(workflow));
  const cli = await check(ctx);
  expect(cli.exitCode).toBe(1);
  expect(cli.report.errors).toContainEqual(expect.objectContaining({ code: 'plan_check_failed', message: 'Proposal context has no unique dispatch stage' }));
});
