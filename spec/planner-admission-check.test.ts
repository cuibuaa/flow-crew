import './test-support/policy-runtime.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPlanCheck, renderPlanInterface } from '../src/plan-interface.js';
import * as planInterface from '../src/plan-interface.js';
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
import { preparePlanRetryCandidate, recordPlanRetryRefusal } from '../src/plan-retry-monotone.js';
import { planRetryRequirementsFromAdmission } from '../src/scheduler/sched_admission/dispatch-retry.js';
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
  const { runId } = createRun(project, 'fixture', workflow, ['plan']);
  const directory = runDir(project, runId);
  writeFileSync(join(directory, 'task_brief.md'), brief);
  writeFileSync(join(directory, 'brief_criteria.json'), JSON.stringify(extractBriefCriteria(brief)));
  updateRunState(project, runId, state => { state.terminalStates = parseBriefFrontmatter(brief).terminalStates; });
  const draft = join(directory, 'draft.json'); writeFileSync(draft, JSON.stringify(candidate));
  return { project, runId, directory, draft, workflow };
}

async function check(ctx: ReturnType<typeof setup>) {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text: string | Uint8Array) => { chunks.push(String(text)); return true; });
  const exitCode = await cmdPlanCheck(['plan-check', '--project', ctx.project, '--run', ctx.directory, ctx.draft]);
  vi.mocked(process.stdout.write).mockRestore();
  return { exitCode, report: JSON.parse(chunks.join('')) };
}

function inject(ctx: ReturnType<typeof setup>) {
  writeFileSync(join(ctx.directory, 'dispatch.yaml'), readFileSync(ctx.draft));
  const roles = admission.buildRoleRegistry(join(ctx.project, 'config/agents'));
  const sorted = admission.loadWorkflow(join(ctx.directory, 'workflow.yaml')).config.stages;
  const { injectDispatchedStages } = createDispatchInjector({ inspectDispatchAdmission: admission.createDispatchAdmission(), resolveImmutableEvidenceBindings });
  injectDispatchedStages('plan', roles, sorted, readRunState(ctx.project, ctx.runId), ctx.project, ctx.runId, true);
  return JSON.parse(readFileSync(join(ctx.directory, 'dispatch_admission.json'), 'utf8'));
}

describe('planner checks real admission before its first result', () => {
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
    const ctx = setup(); writeFileSync(join(ctx.directory, 'reality_checks.md'), 'No additional hard checks.');
    const checked = await check(ctx);
    const live = inject(ctx);
    expect(checked.report.errors).toEqual(live.errors);
    expect(checked.report.errors).toEqual([...errors, admission.admissionError('reality_check_invalid', 'reachability probe', 'reality_checks')]);
    expect(validator).toHaveBeenCalledTimes(2);
    expect(reachability).toHaveBeenCalledTimes(2);
    expect(parser).toHaveBeenCalledTimes(4);
    // Exposing the current engine command is what makes every current and future
    // validator refusal learnable in the SAME planner attempt.
    const render = (planInterface as unknown as { renderPlannerAdmissionCheck: (project: string, directory: string) => string }).renderPlannerAdmissionCheck;
    expect(render(ctx.project, ctx.directory)).toContain(`--run '${ctx.directory}'`);
    expect(render(ctx.project, ctx.directory)).toContain('within this planner attempt');
    expect(render(ctx.project, ctx.directory)).toContain(`'${join(ctx.directory, 'dispatch.yaml')}'`);
    expect(render(ctx.project, ctx.directory)).not.toContain('$TMPDIR/dispatch.json');
    const worker = readFileSync(join(root, 'src/worker.ts'), 'utf8');
    expect(worker).toContain('renderPlannerAdmissionCheck(opts.projectDir, opts.runDir)');
    expect(worker).toContain('if (opts.dynamicDispatch)');
    expect(renderPlanInterface()).toContain('dispatch.yaml');
  });

  it('reports the missing repair route while admitting report then review topology', async () => {
    const ctx = setup();
    const before = Object.fromEntries(readdirSync(ctx.directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => [entry.name, readFileSync(join(ctx.directory, entry.name), 'utf8')]));
    const { exitCode, report } = await check(ctx);
    expect(exitCode).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'stage_retry_to', stageId: 'review', field: 'retry_to' }));
    expect(report.errors.map(error => error.message)).toContain('review: missing repair route; declare an ordinary repair stage with retry_to: [review], depends_on: [review], and scope for the permitted repairs. The engine bounds repair rounds by gate_retry_loops without re-planning.');
    expect(Object.fromEntries(readdirSync(ctx.directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => [entry.name, readFileSync(join(ctx.directory, entry.name), 'utf8')]))).toEqual(before);
    expect(report.errors).toEqual(inject(ctx).errors);
    mkdirSync(join(ctx.directory, 'stages/plan'), { recursive: true });
    writeFileSync(join(ctx.directory, 'stages/plan/status.json'), JSON.stringify({ admissionFailure: { code: 'dispatch_refused', attemptIndex: 0 }, error: `invalid dispatch.yaml: dispatch admission rejected the complete proposal before stage injection.\nExact admission errors:\n${report.errors.map(error => typeof error === 'string' ? error : error.message).join('\n')}` }));
    recordPlanRetryRefusal({ runDirPath: ctx.directory, prepared: preparePlanRetryCandidate({ runDirPath: ctx.directory, stageId: 'plan', iteration: 1, attemptIndex: 1 }), maxAttempts: 3, unsatisfied: planRetryRequirementsFromAdmission(report) });
    const retry = buildRetryPreamble(1, 1000, ctx.directory, 'plan');
    expect(retry).toContain('RE-PLAN');
    for (const error of report.errors) expect(retry).toContain(error.message);
  });

  it('lets the planner correct a missing repair route within its own read-only plan-check', async () => {
    const ctx = setup();
    updateRunState(ctx.project, ctx.runId, state => { delete state.terminalStates; });
    rmSync(join(ctx.directory, 'brief_criteria.json'));
    writeFileSync(join(ctx.directory, 'task_brief.md'), '# Review the report\n');
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
    expect(report.terminalOwners).toEqual({ 'results/report.md': 'implement' });
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
