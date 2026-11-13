import './test-support/policy-runtime.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { createHash } from 'node:crypto';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { readBriefCriteriaArtifact, writeBriefCriteriaArtifact } from '../src/brief-criteria.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { parseBriefDeclarations } from '../src/brief-declarations.js';
import { captureProjectTree } from '../src/evidence-ledger.js';
import { observeEnginePublications } from '../src/engine-fs.js';
import { releaseLaunchIntent } from '../src/run-lock.js';
import { runRecordPath } from '../src/run-layout.js';
import { WorkflowConfigSchema, runWorkflow } from '../src/scheduler.js';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { removeSchedulerPidIfOwned } from '../src/scheduler/sched_policy/identity.js';
import { captureRepairRoundSnapshot } from '../src/scheduler/sched_scope/snapshots.js';
import { closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { settleProjectWrites } from '../src/scheduler/sched_scope/write-enforcement.js';
import { readAdmittedBriefContract, verifyDeclaredBriefInputs } from '../src/ship-inputs.js';
import { evaluateRealityGate, fcGlobalDir, initializeReservedRun, listRuns, readRunState, reserveRun, setFcGlobalDir } from '../src/store.js';

let root: string, previousStateRoot: string;
let interruptSnapshot = false;
observeEnginePublications(paths => {
  if (interruptSnapshot && paths.some(path => path.endsWith('/brief_criteria.json'))) {
    interruptSnapshot = false;
    throw new Error('fixture: interrupted before declaration snapshot publication');
  }
  return () => {};
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'declared-repair-'));
  previousStateRoot = fcGlobalDir(); setFcGlobalDir(join(root, 'state'));
});
afterEach(() => { interruptSnapshot = false; setFcGlobalDir(previousStateRoot); rmSync(root, { recursive: true, force: true }); });
const brief = (metadata: string, body = 'Opaque task prose.') => `---\n${metadata}\n---\n${body}`;
const workflow = () => WorkflowConfigSchema.parse({ name: 'fixture', defaults: { max_iterations: 1 },
  stages: [{ id: 'work', role: 'coder', scope: [], artifact_contract: { version: 1, produces: [], reads: [] }, prompt_template: 'Return the result.' }] });
function project(name: string) {
  const path = join(root, name); mkdirSync(path);
  writeFileSync(join(path, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(path, 'source.txt'), 'ORIGINAL');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']]) {
    isolatedProjectCommand('git', args, path, root);
  }
  return path;
}

it.each(['## Explanatory examples', '## Reality checks'])('prose headings never veto terminal completion: %s', async heading => {
  const dir = project('prose');
  const text = brief('inputs: []\noutputs: []', `${heading}\nThis explanatory prose is not a check declaration.\nExpected: 42. Do not include within_expected_range.`);
  expect(inspectBrief(text).contractReady).toBe(true);
  const result = await runWorkflow(workflow(), '', dir, new ScriptedAdapter({ work: { output: 'Completed.' } }), new Map(), undefined, join(process.cwd(), 'config/agents'), undefined, text);
  expect(result.status, result.failureReason).toBe('complete');
  expect(readFileSync(runRecordPath(join(fcGlobalDir(), 'runs', result.runId), 'task_brief.md'), 'utf8')).toBe(text);
});

it('declared reality checks retain refusal power while body check examples have none', async () => {
  const dir = project('checks');
  const text = brief('reality_checks: [{name: deliberate failure, type: exec-script-exit-zero, reads: [], params: {script: "exit 1"}}]',
    '## Reality checks\nchecks: [{name: ignored example, type: unknown}]');
  const result = await runWorkflow(workflow(), '', dir, new ScriptedAdapter({ work: { output: 'Completed.' } }), new Map(), undefined, join(process.cwd(), 'config/agents'), undefined, text);
  expect(result.status).toBe('reality_gate_failed');
  expect(result.realityGate?.results).toMatchObject([{ name: 'deliberate failure', pass: false }]);
  expect(result.realityGate?.results).toHaveLength(1);
});

it.each([false, true])('preparation interruption retains the complete first brief contract (interrupted=%s)', interrupted => {
  const dir = project('preparation'), config = workflow();
  const text = brief('outputs: [required.txt]\nmax_continuations: 2\nterminal_states: {complete: {paths: [required.txt]}}');
  let launch = prepareWorkflowLaunch(config, '', dir, undefined, text);
  if (launch.kind !== 'ready') throw new Error('Expected launch preparation');
  try {
    expect(readRunState(dir, launch.runId).briefConfigured).toBe(false);
    if (interrupted) {
      removeSchedulerPidIfOwned(launch.schedulerPidPath);
      launch = prepareWorkflowLaunch(config, '', dir, launch.runId, text);
      if (launch.kind !== 'ready') throw new Error('Expected repeated preparation');
    }
    const configured = configureWorkflowBrief(config, dir, launch.runId, launch.runDirPath, launch.maxIterations, launch,
      interrupted ? brief('outputs: [replacement.txt]') : text);
    expect(configured.kind).toBe('configured');
    const state = readRunState(dir, launch.runId);
    expect(state).toMatchObject({ briefConfigured: true, taskDescription: text, maxContinuations: 2,
      declaredOutputs: [{ path: 'required.txt' }], terminalStates: { complete: { paths: ['required.txt'] } } });
    expect(configured.kind === 'configured' && configured.taskDescription).toContain('required.txt');
    expect(readFileSync(runRecordPath(launch.runDirPath, 'task_brief.md'), 'utf8')).toBe(text);
  } finally { if (launch.kind === 'ready') removeSchedulerPidIfOwned(launch.schedulerPidPath); }
});

it.each(['snapshot', 'criterion coverage', 'frozen settlement'])('recovers interruption before snapshot publication: %s', async property => {
  const dir = project('early-preparation'), config = workflow();
  const source = 'source evidence.txt'; writeFileSync(join(dir, source), 'ORIGINAL');
  const text = brief(`inputs: [{path: ${source}, frozen: true}]\noutputs: []`
    + (property === 'frozen settlement' ? '' : '\ncriteria: [{id: preserved, text: Preserve the result.}]'),
    '## Reality checks\nThis is explanatory prose. Expected: 42. 不需要额外义务。');
  interruptSnapshot = true;
  expect(() => prepareWorkflowLaunch(config, '', dir, undefined, text)).toThrow('interrupted before declaration snapshot');
  const [runId] = listRuns(dir);
  expect(runId).toBeTruthy();
  const directory = join(fcGlobalDir(), 'runs', runId);
  expect(readRunState(dir, runId).briefConfigured).toBe(false);
  expect(existsSync(runRecordPath(directory, 'brief_criteria.json'))).toBe(false);
  releaseLaunchIntent(dir, runId);

  if (property === 'snapshot') {
    const launch = prepareWorkflowLaunch(config, '', dir, runId, brief('outputs: [replacement.txt]'));
    if (launch.kind !== 'ready') throw new Error('Expected recovered preparation');
    try {
      expect(readBriefCriteriaArtifact(directory)).toMatchObject({ criteria: [{ id: 'preserved' }],
        declarations: { inputs: [{ path: source, frozen: true }], outputs: [] } });
      expect(configureWorkflowBrief(config, dir, runId, directory, launch.maxIterations, launch).kind).toBe('configured');
      expect(await evaluateRealityGate(dir, runId, 'complete')).not.toHaveProperty('failureReason');
      expect(readFileSync(runRecordPath(directory, 'task_brief.md'), 'utf8')).toBe(text);
    } finally { removeSchedulerPidIfOwned(launch.schedulerPidPath); }
  } else {
    const result = await runWorkflow(config, '', dir, new ScriptedAdapter({ work: { output: 'Completed.',
      ...(property === 'frozen settlement' ? { projectFiles: { [source]: 'MUTATED' } } : {}) } }),
      new Map(), undefined, join(process.cwd(), 'config/agents'), runId, text);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain(property === 'criterion coverage'
      ? 'criterion preserved: not assigned to a gate' : `immutable_evidence_violation: ${source}`);
    expect(readFileSync(join(dir, source), 'utf8')).toBe('ORIGINAL');
  }
});

it.each(['Explanatory body text.\n', '\n', ' \n', '\r\n'])('configuration keeps the exact frontmatter boundary after prefix %j', async prefix => {
  const dir = project('leading-prose');
  const text = prefix + brief('outputs: [required.txt]\nmax_continuations: 2', '任意原文；Opaque task prose.\n');
  expect(inspectBrief(text)).toMatchObject({ contractReady: true, frontmatter: { status: 'absent' } });
  const result = await runWorkflow(workflow(), '', dir, new ScriptedAdapter({ work: { output: 'Completed.' } }),
    new Map(), undefined, join(process.cwd(), 'config/agents'), undefined, text);
  expect(result.status, result.failureReason).toBe('complete');
  expect(result.declaredOutputs).toBeUndefined();
  expect(result.maxContinuations).toBeUndefined();
  const directory = join(fcGlobalDir(), 'runs', result.runId);
  expect(readBriefCriteriaArtifact(directory)?.declarations).toEqual({});
  expect(readFileSync(runRecordPath(directory, 'task_brief.md'), 'utf8')).toBe(text);
});

it.each([
  ['normalized frozen alias', 'inputs: [{dataset: "./source.txt", frozen: true}]', 'source.txt', true],
  ['unrelated metadata', 'metadata: {path: source.txt, frozen: true}', 'source.txt', false],
  ['mutable ignored alias', 'inputs: [{dataset: ignored.txt}]', 'ignored.txt', false],
  ['nested alias', 'metadata: {sources: [{path: "./source.txt", frozen: true}]}', 'source.txt', true],
  ['parent does not freeze nested input', 'inputs: [{frozen: true, nested: {path: source.txt}}]', 'source.txt', false],
  ['direct path suppresses nested input', 'inputs: [{path: source.txt, nested: {dataset: ignored.txt, frozen: true}}]', 'ignored.txt', false],
  ['outputs do not freeze', 'outputs: [{inputs: [{path: source.txt, frozen: true}]}]', 'source.txt', false],
] as const)('legacy decoding refuses activation without a stored contract hash: %s', (_label, metadata, name, frozen) => {
  const dir = project('legacy'); writeFileSync(join(dir, 'ignored.txt'), 'ORIGINAL');
  const created = reserveRun(dir); initializeReservedRun(dir, created.runId, 'fixture', 'name: fixture\nstages: []\n', []);
  const text = brief(metadata);
  writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), text);
  writeFileSync(runRecordPath(created.runDirPath, 'brief_criteria.json'), JSON.stringify({ version: 1,
    briefDigest: createHash('sha256').update(text).digest('hex'), criteria: [] }));
  expect(() => readAdmittedBriefContract(created.runDirPath)).toThrow('contract_hash_missing');
  expect(readRunState(dir, created.runId).status).toBe('running');
  expect(readFileSync(join(dir, name), 'utf8')).toBe('ORIGINAL');
});

it.each(['  source.txt  ', ' source.txt', 'source.txt ', 'C:source.txt'])('refuses unsupported literal path before verification/admission: %j', name => {
  const dir = project('literal'); writeFileSync(join(dir, name), 'ORIGINAL');
  const text = brief(`inputs: [{path: ${JSON.stringify(name)}, frozen: true}]`);
  expect(() => parseBriefDeclarations(text)).toThrow('inputs.0.path');
  expect(verifyDeclaredBriefInputs(text, dir).unresolvedInputs).toMatchObject([{ reason: expect.stringContaining('inputs.0.path') }]);
  expect(() => prepareWorkflowLaunch(workflow(), '', dir, undefined, text)).toThrow('inputs.0.path');
});

it('ordinary declared frozen input still detects and restores mutation', () => {
  const dir = project('frozen');
  const text = brief('inputs: [{path: source.txt, frozen: true}]');
  const created = reserveRun(dir); initializeReservedRun(dir, created.runId, 'fixture', 'name: fixture\nstages: []\n', [], createBriefAdmission(inspectBrief(text), { kind: 'not_required' }));
  writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), text); writeBriefCriteriaArtifact(created.runDirPath, text);
  expect(verifyDeclaredBriefInputs(text, dir).unresolvedInputs).toEqual([]);
  const snapshot = captureRepairRoundSnapshot(dir, [], { runDirPath: created.runDirPath });
  try {
    writeFileSync(join(dir, 'source.txt'), 'MUTATED');
    const settled = settleProjectWrites({ projectDir: dir, snapshot, rawWrites: ['source.txt'], definiteWrites: new Set(['source.txt']) });
    expect(settled.violations).toMatchObject([{ path: 'source.txt' }]);
    expect(readFileSync(join(dir, 'source.txt'), 'utf8')).toBe('ORIGINAL');
  } finally { closeRollbackBaseline(dir, created.runDirPath); }
});
