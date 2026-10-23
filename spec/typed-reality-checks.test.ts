import './test-support/policy-runtime.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseStageRecord } from '../src/handoff.js';
import { PLAN_SCHEMA, renderPlanInterface } from '../src/plan-interface.js';
import { parseChecksFromMarkdown, parseRealityChecks, runAllChecks } from '../src/reality-gate/index.js';
import { createDispatchAdmission } from '../src/scheduler/sched_admission/dispatch.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createDispatchInjector, inspectDispatchProposal } from '../src/scheduler/sched_policy/dispatch-injection.js';
import { fcGlobalDir, readRunState, setFcGlobalDir } from '../src/store.js';
import { createRun } from './test-support/create-run.js';

const roots: string[] = [];
const previousHome = fcGlobalDir();
afterEach(() => { setFcGlobalDir(previousHome); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stages = [
  { id: 'work', role: 'coder' },
  { id: 'review', role: 'qa', is_gate: true, depends_on: ['work'] },
  { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], condition: 'review.pass == false' },
];
const check = { name: 'portable', type: 'exec-script-exit-zero', reads: [], params: { script: 'exit 0' } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fc-typed-checks-')); roots.push(root);
  const projectDir = join(root, 'project'); mkdirSync(projectDir); setFcGlobalDir(join(root, 'store'));
  const sorted = [StageConfigSchema.parse({ id: 'plan', role: 'planner', dynamic_dispatch: true, artifact_contract: { version: 1, produces: [], reads: [], groups: [] } })];
  const { runId, runDirPath } = createRun(projectDir, 'fixture', stringify({ name: 'fixture', stages: sorted }), ['plan']);
  const state = readRunState(projectDir, runId);
  const roleRegistry = new Map(['coder', 'qa'].map(name => [name, { name, description: name }]));
  const services = { inspectDispatchAdmission: createDispatchAdmission() };
  return { projectDir, runId, runDirPath, sorted, state, roleRegistry, services };
}
function inspect(f: ReturnType<typeof fixture>, plan: object) {
  return inspectDispatchProposal(f.services, { ...f, rawDispatchText: stringify(plan), dispatchStageId: 'plan' }).report;
}

describe('typed dispatch reality checks and the one-release Markdown read alias', () => {
  it('uses one declaration normalizer for PLAN_SCHEMA fields and fenced recorded checks', () => {
    const plan = { stages, reality_checks: [check] };
    expect(parseStageRecord(JSON.stringify(plan), PLAN_SCHEMA)).toEqual(plan);
    const markdown = `## Reality checks\n\x60\x60\x60yaml\n${stringify({ checks: [check] })}\x60\x60\x60\n`;
    expect(parseRealityChecks(plan.reality_checks)).toEqual(parseChecksFromMarkdown(markdown));
    expect(renderPlanInterface()).toContain('reality_checks');
    const f = fixture();
    expect(inspect(f, plan).pass).toBe(true);
    writeFileSync(join(f.runDirPath, 'reality_checks.md'), markdown);
    expect(inspect(f, { stages }).pass).toBe(true);
  });

  it('reports malformed typed declarations at reality_checks instead of inferring Markdown', () => {
    const f = fixture();
    for (const reality_checks of [null, {}, 'checks: []', [null], [{ ...check, reads: undefined }]]) {
      const report = inspect(f, { stages, reality_checks });
      expect(report.pass).toBe(false);
      expect(report.errors).toContainEqual(expect.objectContaining({ code: 'reality_check_invalid', field: 'reality_checks' }));
    }
  });

  it('reports concrete typed fields for every invalid stage declaration', () => {
    const f = fixture();
    const report = inspect(f, { stages: [{ id: 'work', role: 'coder', scope: false, depends_on: 42 }] });
    expect(report.pass).toBe(false);
    expect(report.errors.filter(error => error.code === 'stage_schema_invalid').map(error => error.field).sort()).toEqual(['depends_on', 'scope']);
    expect(report.errors.filter(error => error.code === 'stage_schema_invalid').every(error => error.stageId === 'work')).toBe(true);
  });

  it('keeps exact producer reachability refusals for both declaration shapes', () => {
    const f = fixture();
    const missing = { ...check, reads: [{ id: 'result', root: 'project', path: 'result.json', source: { kind: 'stage', stage: 'absent', artifact: 'result' } }] };
    const typed = inspect(f, { stages, reality_checks: [missing] });
    writeFileSync(join(f.runDirPath, 'reality_checks.md'), `## Reality checks\n${stringify({ checks: [missing] })}`);
    const recorded = inspect(f, { stages });
    expect(typed.pass).toBe(false);
    expect(typed.errors).toEqual(recorded.errors);
    expect(typed.errors.map(error => error.message).join(';')).toContain('ARTIFACT_READ_UNBOUND');
  });

  it('publishes typed checks through the existing admitted snapshot only after admission', () => {
    const f = fixture();
    const checksPath = join(f.runDirPath, 'reality_checks.md');
    writeFileSync(checksPath, 'old admitted bytes');
    const inject = createDispatchInjector(f.services).injectDispatchedStages;
    writeFileSync(join(f.runDirPath, 'dispatch.yaml'), stringify({ stages, reality_checks: null }));
    expect(inject('plan', f.roleRegistry, [...f.sorted], f.state, f.projectDir, f.runId)).toEqual([]);
    expect(readFileSync(checksPath, 'utf8')).toBe('old admitted bytes');
    writeFileSync(join(f.runDirPath, 'dispatch.yaml'), stringify({ stages, reality_checks: [check] }));
    expect(inject('plan', f.roleRegistry, [...f.sorted], f.state, f.projectDir, f.runId)).toHaveLength(3);
    expect(parseChecksFromMarkdown(readFileSync(checksPath, 'utf8'))).toEqual(parseRealityChecks([check]));
    expect(f.state.admittedRealityChecks?.markdown).toBe(readFileSync(checksPath, 'utf8'));
  });

  it('still fails terminal JSON checks when required fields are missing (report §7 reality gate)', async () => {
    const f = fixture(); writeFileSync(join(f.projectDir, 'result.json'), '{}');
    const declarations = parseRealityChecks([{ name: 'required result', type: 'json-schema-match',
      reads: [{ id: 'result', root: 'project', path: 'result.json', source: { kind: 'input' } }],
      params: { file: 'result.json', schema: { type: 'object', required: ['measurement'] } } }]);
    const report = await runAllChecks(declarations, { projectDir: f.projectDir, taskDir: f.runDirPath });
    expect(report.pass).toBe(false);
    expect(report.results[0].details).toContain('measurement required');
  });
});
