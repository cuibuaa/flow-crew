import { stageWorkPath, runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseStageRecord } from '../src/handoff.js';
import { ArtifactReadSchema, ArtifactContractSchema } from '../src/artifact-declarations.js';
import { BriefRealityCheckSchema } from '../src/brief-declarations.js';
import { validate, type Schema } from '../src/reality-gate/checks/json-schema-match.js';
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
    writeFileSync(runRecordPath(f.runDirPath, 'reality_checks.md'), markdown);
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
    writeFileSync(runRecordPath(f.runDirPath, 'reality_checks.md'), `## Reality checks\n${stringify({ checks: [missing] })}`);
    const recorded = inspect(f, { stages });
    expect(typed.pass).toBe(false);
    expect(typed.errors).toEqual(recorded.errors);
    expect(typed.errors.map(error => error.message).join(';')).toContain('ARTIFACT_READ_UNBOUND');
  });

  it('publishes typed checks through the existing admitted snapshot only after admission', () => {
    const f = fixture();
    const checksPath = runRecordPath(f.runDirPath, 'reality_checks.md');
    writeFileSync(checksPath, 'old admitted bytes');
    const inject = createDispatchInjector(f.services).injectDispatchedStages;
    writeFileSync(stageWorkPath(f.runDirPath, 'dispatch.yaml'), stringify({ stages, reality_checks: null }));
    expect(inject('plan', f.roleRegistry, [...f.sorted], f.state, f.projectDir, f.runId)).toEqual([]);
    expect(readFileSync(checksPath, 'utf8')).toBe('old admitted bytes');
    writeFileSync(stageWorkPath(f.runDirPath, 'dispatch.yaml'), stringify({ stages, reality_checks: [check] }));
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

// Validate the serialized schema actually injected into the planner, including its local references.
function injectedSchema(): Schema {
  return JSON.parse(renderPlanInterface().split('\n').find(line => line.startsWith('{'))!);
}
const inputRead = { id: 'input', root: 'project', path: 'data.json', source: { kind: 'input' } };
const emptyContract = { version: 1, produces: [], reads: [] };
const output = { id: 'output', root: 'run', path: 'work/result.json' };
const readCases: [string, unknown, boolean][] = [
  ['input defaults', inputRead, true],
  ['stage', { ...inputRead, source: { kind: 'stage', stage: 'work', artifact: 'output' } }, true],
  ['framework brief', { ...inputRead, source: { kind: 'framework', artifact: 'task_brief' } }, true],
  ['framework state', { ...inputRead, source: { kind: 'framework', artifact: 'run_state' } }, true],
  ['directory', { ...inputRead, kind: 'directory' }, true],
  ['conditional', { ...inputRead, when: { stage: 'work', field: 'exitCode', equals: 0 } }, true],
  ['status condition', { ...inputRead, when: { stage: 'work', field: 'status', equals: 'complete' } }, true],
  ['literal punctuation', { ...inputRead, path: 'app/[id]/(view)/{literal}!*.json' }, true],
  ['missing id and source', { root: 'project', path: 'data.json' }, false],
  ['missing path', { id: 'input', root: 'project', source: { kind: 'input' } }, false],
  ['bad id', { ...inputRead, id: 'Bad-id' }, false],
  ['overlong id', { ...inputRead, id: 'a'.repeat(65) }, false],
  ['bad root', { ...inputRead, root: 'workspace' }, false],
  ...['', '/outside', '../data', 'a/../data', './data', 'a//data', 'a/', 'a\\data', 'a/\0data'].map(path =>
    [`unconfined path ${JSON.stringify(path)}`, { ...inputRead, path }, false] as [string, unknown, boolean]),
  ['host drive path', { ...inputRead, path: 'C:/data' }, !isAbsolute('C:/data')],
  ['bad kind', { ...inputRead, kind: 'glob' }, false],
  ['extra read field', { ...inputRead, extra: true }, false],
  ['missing source', { ...inputRead, source: undefined }, false],
  ['unknown source', { ...inputRead, source: { kind: 'other' } }, false],
  ['extra input field', { ...inputRead, source: { kind: 'input', stage: 'work' } }, false],
  ['stage without artifact', { ...inputRead, source: { kind: 'stage', stage: 'work' } }, false],
  ['bad producer id', { ...inputRead, source: { kind: 'stage', stage: 'Bad-id', artifact: 'output' } }, false],
  ['framework alias', { ...inputRead, source: { kind: 'framework', name: 'task_brief' } }, false],
  ['unknown framework artifact', { ...inputRead, source: { kind: 'framework', artifact: 'other' } }, false],
  ['extra source field', { ...inputRead, source: { kind: 'stage', stage: 'work', artifact: 'output', extra: true } }, false],
  ['missing condition value', { ...inputRead, when: { stage: 'work', field: 'status' } }, false],
  ['unknown condition field', { ...inputRead, when: { stage: 'work', field: 'pass', equals: true } }, false],
  ['fractional exit code', { ...inputRead, when: { stage: 'work', field: 'exitCode', equals: 0.5 } }, false],
  ['unsafe exit code', { ...inputRead, when: { stage: 'work', field: 'exitCode', equals: Number.MAX_SAFE_INTEGER + 1 } }, false],
  ['extra condition field', { ...inputRead, when: { stage: 'work', field: 'exitCode', equals: 0, extra: true } }, false],
  ['array', [], false], ['null', null, false],
];
const contractCases: [string, unknown, boolean][] = [
  ['empty defaults', emptyContract, true],
  ['produced file', { ...emptyContract, produces: [output] }, true],
  ['produced directory condition', { ...emptyContract, produces: [{ ...output, kind: 'directory', nonempty: true, when: { stage: 'work', field: 'status', equals: 'complete' } }] }, true],
  ['read', { ...emptyContract, reads: [inputRead] }, true],
  ['group', { ...emptyContract, produces: [output, { ...output, id: 'other', path: 'work/other.json' }], groups: [{ id: 'outcome', mode: 'exactly_one', members: ['output', 'other'] }] }, true],
  ['missing version', { produces: [], reads: [] }, false],
  ['wrong version', { ...emptyContract, version: 2 }, false],
  ['missing reads', { version: 1, produces: [] }, false],
  ['missing produces', { version: 1, reads: [] }, false],
  ['extra contract field', { ...emptyContract, extra: true }, false],
  ['retired replay', { ...emptyContract, replays: [] }, false],
  ['produces is object', { ...emptyContract, produces: {} }, false],
  ['bad produced id', { ...emptyContract, produces: [{ ...output, id: 'Bad' }] }, false],
  ['bad produced root', { ...emptyContract, produces: [{ ...output, root: 'other' }] }, false],
  ['escaping output', { ...emptyContract, produces: [{ ...output, path: '../escape' }] }, false],
  ['bad nonempty', { ...emptyContract, produces: [{ ...output, nonempty: 'true' }] }, false],
  ['extra produced field', { ...emptyContract, produces: [{ ...output, source: { kind: 'input' } }] }, false],
  ['groups is object', { ...emptyContract, groups: {} }, false],
  ['group mode', { ...emptyContract, groups: [{ id: 'outcome', mode: 'all', members: [] }] }, false],
  ['group cardinality', { ...emptyContract, groups: [{ id: 'outcome', mode: 'exactly_one', members: ['output'] }] }, false],
  ['group member id', { ...emptyContract, groups: [{ id: 'outcome', mode: 'exactly_one', members: ['Bad', 'other'] }] }, false],
  ['extra group field', { ...emptyContract, groups: [{ id: 'outcome', mode: 'exactly_one', members: ['output', 'other'], extra: true }] }, false],
  ['null', null, false],
];

describe('injected plan schema carries admission structure', () => {
  it('rejects the real refusal at admission and in the injected schema', () => {
    const f = fixture();
    const plan = { stages, reality_checks: [{ ...check, reads: [{ root: 'run', path: 'work/result.json' }] }] };
    const report = inspect(f, plan);
    expect(report.pass).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'reality_check_invalid',
      message: expect.stringContaining('reads must declare exact rooted inputs') }));
    const errors = validate(plan, injectedSchema(), '$');
    expect(errors.join('\n')).toContain('.reads[0].id required');
    expect(errors.join('\n')).toContain('.reads[0].source required');
  });

  it.each(readCases)('read structural parity: %s', (_name, read, accepted) => {
    const admission = ArtifactReadSchema.safeParse(read).success;
    expect(admission).toBe(accepted);
    expect(parseRealityChecks([{ ...check, reads: [read] }])[0].kind !== 'invalid').toBe(admission);
    expect(validate({ stages, reality_checks: [{ ...check, reads: [read] }] }, injectedSchema(), '$').length === 0).toBe(admission);
    expect(validate({ stages: [{ id: 'work', role: 'coder', artifact_contract: { ...emptyContract, reads: [read] } }] }, injectedSchema(), '$').length === 0).toBe(admission);
  });

  it.each(contractCases)('contract structural parity: %s', (_name, artifact_contract, accepted) => {
    const stage = { id: 'work', role: 'coder', artifact_contract };
    const admission = StageConfigSchema.safeParse(stage).success;
    expect(admission).toBe(accepted);
    expect(ArtifactContractSchema.safeParse(artifact_contract).success).toBe(admission);
    expect(validate({ stages: [stage] }, injectedSchema(), '$').length === 0).toBe(admission);
  });

  it.each([
    ['exec-script-exit-zero', { script: 'exit 0', args: ['x'], timeout_seconds: 1 }, true],
    ['exec-script-exit-zero', {}, false],
    ['exec-script-exit-zero', { script: 'exit 0', args: [1] }, false],
    ['exec-script-exit-zero', { script: 'exit 0', timeout_seconds: 0 }, false],
    ['file-exists-nonempty', { paths: ['data.json'] }, true],
    ['file-exists-nonempty', { paths: { from_manifest: 'manifest.json', field: 'files' } }, true],
    ['file-exists-nonempty', { paths: [] }, false],
    ['file-exists-nonempty', { paths: { from_manifest: 'manifest.json' } }, false],
    ['json-schema-match', { file: 'data.json', schema: { file: 'schema.json' } }, true],
    ['json-schema-match', { file: 'data.json', schema: { properties: { nested: { items: { enum: [null, { value: [1, true] }] } } } } }, true],
    ['json-schema-match', { file: 'data.json', schema: { properties: { nested: { typo: 'string' } } } }, false],
    ['json-schema-match', { file: 'data.json', schema: { properties: { nested: { pattern: '[' } } } }, false],
    ['json-schema-match', { file: 'data.json', schema: { items: { minItems: -1 } } }, false],
    ['json-schema-match', { file: 'data.json' }, false],
  ])('check params reuse the brief admission shape: %s %j', (type, params, accepted) => {
    const declaration = { ...check, type, params };
    expect(BriefRealityCheckSchema.safeParse(declaration).success).toBe(accepted);
    expect(validate({ stages, reality_checks: [declaration] }, injectedSchema(), '$').length === 0).toBe(accepted);
  });

  it.each([{ successors: [], default: '' }, { successors: [''], default: '' }, { successors: ['next'], default: '' }])('decision structural parity: %j', decision => {
    const stage = { id: 'work', role: 'coder', decision };
    expect(StageConfigSchema.safeParse(stage).success).toBe(false);
    expect(validate({ stages: [stage] }, injectedSchema(), '$')).not.toEqual([]);
  });
});
