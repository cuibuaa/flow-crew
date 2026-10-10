import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPlanCheck, renderPlanInterface } from '../src/plan-interface.js';
import * as planInterface from '../src/plan-interface.js';
import * as admission from '../src/scheduler/sched_admission/dispatch.js';
import * as realityReads from '../src/scheduler/sched_admission/reality-reads.js';
import * as preflight from '../src/reality-check-preflight.js';
import { createDispatchInjector } from '../src/scheduler/sched_policy/dispatch-injection.js';
import { firstDeclaredInputScopeConflict, resolveDeclaredInputWriteBindings } from '../src/scheduler/sched_scope/path-capabilities.js';
import { createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';
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
  const workflow = 'name: fixture\nstages:\n  - id: plan\n    role: planner\n    dynamic_dispatch: true\n    artifact_contract: {version: 1, produces: [], reads: [], groups: [], replays: []}\n';
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
  const { injectDispatchedStages } = createDispatchInjector({ inspectDispatchAdmission: admission.createDispatchAdmission(firstDeclaredInputScopeConflict), resolveDeclaredInputWriteBindings, applyScopePlanningDispositions: () => { throw new Error('Self-check must not inject'); } });
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
    const errors = codes.map(code => `${code}: admission transport probe`);
    const actual = admission.createDispatchAdmission(firstDeclaredInputScopeConflict);
    const validator = vi.fn((input: Parameters<typeof actual>[0]) => ({ ...actual(input), pass: false, errors: [...errors] }));
    vi.spyOn(admission, 'createDispatchAdmission').mockReturnValue(validator);
    const reachability = vi.spyOn(realityReads, 'inspectRealityCheckReachability').mockReturnValue(['reachability probe']);
    const preflightSource = readFileSync(join(root, 'src/reality-check-preflight.ts'), 'utf8');
    const union = preflightSource.match(/export type RealityCheckPreflightCode =([\s\S]*?);/)![1];
    const findingCodes = [...union.matchAll(/'([^']+)'/g)].map(match => match[1]);
    const findings = findingCodes.map(code => ({ code, checkIndex: 0, checkName: 'probe', checkType: 'probe', message: `${code}: preflight transport probe`, tier: 'structural', blocking: true })) as preflight.RealityCheckPreflightFinding[];
    const empty = preflight.inspectRealityChecks(brief, '');
    const checkIntent = vi.spyOn(preflight, 'inspectRealityChecks').mockReturnValue({ ...empty, refusingFindings: findings });
    const parser = vi.spyOn(configuration, 'parseDispatchedStageConfig');
    const ctx = setup(); writeFileSync(join(ctx.directory, 'reality_checks.md'), 'No additional hard checks.');
    const checked = await check(ctx);
    const live = inject(ctx);
    expect(checked.report.errors).toEqual(live.errors);
    expect(checked.report.errors).toEqual([...errors, 'reachability probe', preflight.formatRealityCheckPreflightFindings(findings)]);
    for (const code of findingCodes) expect(checked.report.errors.join('\n')).toContain(code);
    expect(validator).toHaveBeenCalledTimes(2);
    expect(reachability).toHaveBeenCalledTimes(2);
    expect(checkIntent).toHaveBeenCalledTimes(2);
    expect(parser).toHaveBeenCalledTimes(4);
    // Exposing the current engine command is what makes every current and future
    // validator refusal learnable in the SAME planner attempt.
    const render = (planInterface as unknown as { renderPlannerAdmissionCheck: (project: string, directory: string) => string }).renderPlannerAdmissionCheck;
    expect(render(ctx.project, ctx.directory)).toContain(`--run '${ctx.directory}'`);
    expect(render(ctx.project, ctx.directory)).toContain('within this planner attempt');
    expect(render(ctx.project, ctx.directory)).toContain('"$TMPDIR/dispatch.json"');
    expect(render(ctx.project, ctx.directory)).toContain('writable scratch directory');
    const worker = readFileSync(join(root, 'src/worker.ts'), 'utf8');
    expect(worker).toContain('renderPlannerAdmissionCheck(opts.projectDir, opts.runDir)');
    expect(worker).toContain("if (opts.dynamicDispatch || opts.role.name === 'planner')");
    expect(renderPlanInterface()).toContain('dispatch.yaml');
  });

  it('diagnoses all eight terminal and six-criterion topology refusals in one read-only pass', async () => {
    const ctx = setup();
    const before = Object.fromEntries(readdirSync(ctx.directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => [entry.name, readFileSync(join(ctx.directory, entry.name), 'utf8')]));
    const { exitCode, report } = await check(ctx);
    expect(exitCode).toBe(1);
    expect(report.errors).toHaveLength(8);
    expect(report.errors).toContain('terminal owner implement: must be a DAG sink; depended on by review');
    expect(report.errors).toContain('terminal owner implement.depends_on: mandatory stage review is not an ancestor');
    for (const criterion of extractBriefCriteria(brief).criteria) expect(report.errors).toContain(`criterion ${criterion.id}: assigned gate review must be an ancestor of terminal owner(s) implement`);
    expect(Object.fromEntries(readdirSync(ctx.directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => [entry.name, readFileSync(join(ctx.directory, entry.name), 'utf8')]))).toEqual(before);
    expect(report.errors).toEqual(inject(ctx).errors);
    mkdirSync(join(ctx.directory, 'stages/plan'), { recursive: true });
    writeFileSync(join(ctx.directory, 'stages/plan/status.json'), JSON.stringify({ error: `invalid dispatch.yaml: dispatch admission rejected the complete proposal before stage injection.\nExact admission errors:\n${report.errors.join('\n')}` }));
    const retry = buildRetryPreamble(1, 1000, ctx.directory, 'plan');
    for (const error of report.errors) expect(retry).toContain(error);
  });

  it('reports malformed stages, gate contracts, prose conditions and terminal topology together', async () => {
    const candidate = structuredClone(rejected);
    candidate.stages.push({ id: 'bad_scope', role: 'coder', scope: 12 });
    candidate.stages.push({ id: 'bad_gate', role: 'qa', is_gate: true, retry_to: ['review'], depends_on: ['review'] });
    candidate.stages[1].artifact_contract.produces = [];
    candidate.stages.push({ id: 'repair', role: 'coder', scope: ['results/report.md'], depends_on: ['review'], retry_to: ['review'], condition: 'Run if review rejects.' });
    const ctx = setup(candidate);
    const { report } = await check(ctx);
    expect(report.errors.join('\n')).toContain('bad_scope: invalid schema');
    expect(report.errors.join('\n')).toContain('gate stages cannot declare retry_to');
    expect(report.errors.join('\n')).toContain('ARTIFACT_GATE_VERDICT_REQUIRED');
    expect(report.errors.join('\n')).toContain('No operator found');
    expect(report.errors.join('\n')).toContain('expected exactly one scoped owner, found 2');
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
