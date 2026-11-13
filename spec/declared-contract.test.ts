import './test-support/policy-runtime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBriefDeclarations } from '../src/brief-declarations.js';
import { extractBriefCriteria, readBriefCriteriaArtifact } from '../src/brief-criteria.js';
import { briefDeclarationFailures, createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { extractBriefOutputDeclarations, parseBriefInputs, verifyDeclaredBriefInputs, nodeShipInputFileSystem } from '../src/ship-inputs.js';
import { collectShipPreflight } from '../src/cli-ship-preflight.js';
import { entryWorkflow, parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { rehearseBrief } from '../src/rehearse.js';
import { readBriefCriteriaForAdmission } from '../src/scheduler/sched_admission/dispatch.js';
import { plannerCriterionAssignmentContext } from '../src/worker.js';
import { prepareWorkflowLaunch } from '../src/scheduler/sched_loop/launch.js';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, listRuns, readRunState, reserveRun, runsRoot, setFcGlobalDir, writeRunState } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { createWatchState, pollWatch } from '../src/watch.js';
import { startDashboard } from '../src/dashboard.js';
import { spawnSync } from 'node:child_process';
import { captureRepairRoundSnapshot } from '../src/scheduler/sched_scope/snapshots.js';
import { ensureRollbackBaseline, closeRollbackBaseline } from '../src/scheduler/sched_scope/rollback-baseline.js';
import { createHash } from 'node:crypto';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'declared-contract-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const envelope = (metadata: string, body = 'Opaque task prose.') => `---\n${metadata}\n---\n${body}`;

describe('one declaration schema', () => {
  it('accepts both authored input/output forms through all consumers', async () => {
    const project = temp(); mkdirSync(join(project, 'source')); writeFileSync(join(project, 'source/input.txt'), 'evidence');
    for (const metadata of [
      'inputs: [{path: source/input.txt, frozen: true}]\noutputs: [result.md]',
      'inputs: [source/input.txt]\noutputs: [{path: result.md, type: file, on_existing: update}]',
    ]) {
      const brief = envelope(metadata);
      const declared = parseBriefDeclarations(brief);
      expect(parseBriefInputs(brief).references).toMatchObject([{ path: 'source/input.txt' }]);
      expect(verifyDeclaredBriefInputs(brief, project).inputs).toMatchObject([{ exists: true, readable: true }]);
      expect(extractBriefOutputDeclarations(brief)).toMatchObject([{ path: 'result.md', expectedType: 'file' }]);
      expect(parseBriefFrontmatter(brief).outputs?.map(({ line, ...output }) => output))
        .toEqual(extractBriefOutputDeclarations(brief).map(({ line, ...output }) => output));
      expect(declared.inputs).toHaveLength(1);
      expect(briefDeclarationFailures(brief)).toEqual([]);
      expect((await rehearseBrief(['fixture.md', '--static-only'], { briefText: brief, projectDir: project })).exitCode).toBe(0);
    }
  });

  it.each([
    ['inputs: [{path: source.txt, freez: true}]', 'freez'],
    ['inputs: [{file: source.txt}]', 'file'],
    ['inputs: {dataset: source.txt}', 'inputs'],
    ['inputs: [{path: source.txt, frozen: "true"}]', 'frozen'],
    ['outputs: [{path: result.md, onExisting: update}]', 'onExisting'],
    ['outputs: [{path: result.md, type: dir}]', 'type'],
    ['criteria: [{id: result, text: Ready, extra: true}]', 'extra'],
    ['criteria: [{id: same, text: A}, {id: same, text: B}]', 'criteria'],
    ['criteria: []', 'criteria'],
    ['inputs: [{path: source.txt, type: file}, {path: source.txt, type: directory}]', 'inputs.1.path'],
    [`inputs: [{path: source.txt, sha256: "${'a'.repeat(64)}"}, {path: source.txt, sha256: "${'b'.repeat(64)}"}]`, 'inputs.1.path'],
  ])('refuses malformed schema with the field named: %s', (metadata, field) => {
    const brief = envelope(metadata);
    expect(() => parseBriefDeclarations(brief)).toThrow(field);
    expect(briefDeclarationFailures(brief).map(f => f.message).join('\n')).toContain(field);
    expect(entryWorkflow(parseBriefFrontmatter(brief)).error).toContain(field);
  });

  it.each([false, true])('refuses missing declared inputs at launch before claiming resources (preparation=%s)', prepared => {
    const root = temp(), project = join(root, 'project'); mkdirSync(project);
    const previous = fcGlobalDir(); setFcGlobalDir(join(root, 'state'));
    try {
      const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{id: 'work', role: 'coder', scope: []}] });
      const reservation = prepared ? reserveRun(project) : undefined;
      const before = listRuns(project);
      expect(() => prepareWorkflowLaunch(workflow, '', project, reservation?.runId, envelope('inputs: [missing.txt]'))).toThrow('inputs.path missing.txt');
      expect(listRuns(project)).toEqual(before);
    } finally { setFcGlobalDir(previous); }
  });

  it('checks declared input hashes and filesystem types', () => {
    const root = temp(); writeFileSync(join(root, 'input.txt'), 'source bytes');
    const sha256 = createHash('sha256').update('source bytes').digest('hex');
    const valid = envelope(`inputs: [{path: input.txt, type: file, frozen: true, sha256: ${JSON.stringify(sha256)}}]`);
    expect(verifyDeclaredBriefInputs(valid, root).unresolvedInputs).toEqual([]);
    const wrongHash = valid.replace(sha256, '0'.repeat(64));
    expect(verifyDeclaredBriefInputs(wrongHash, root).unresolvedInputs).toMatchObject([{ reason: expect.stringContaining('inputs.sha256') }]);
    expect(verifyDeclaredBriefInputs(valid.replace('type: file', 'type: directory'), root).unresolvedInputs)
      .toMatchObject([{ reason: expect.stringContaining('inputs.0.sha256') }]);
    expect(verifyDeclaredBriefInputs(valid.replace('type: file', 'type: directory').replace(', sha256: '+JSON.stringify(sha256), ''), root).unresolvedInputs)
      .toMatchObject([{ reason: expect.stringContaining('inputs.type') }]);
    let hashed = 0;
    const escaped = verifyDeclaredBriefInputs(valid, root, { ...nodeShipInputFileSystem,
      realpath: () => join(temp(), 'outside.txt'), hashFile: () => { hashed++; return { sha256, byteLength: 12 }; } });
    expect(escaped.unresolvedInputs).toMatchObject([{ reason: expect.stringContaining('inputs.path') }]);
    expect(hashed).toBe(0);
    const special = verifyDeclaredBriefInputs(valid, root, { ...nodeShipInputFileSystem,
      stat: () => ({ isDirectory: () => false, isFile: () => false }),
      hashFile: () => { hashed++; return { sha256, byteLength: 12 }; } });
    expect(special.unresolvedInputs).toMatchObject([{ reason: expect.stringContaining('inputs.type') }]);
    expect(hashed).toBe(0);


  });

  it('refuses nested metadata aliases before inferring input/output authority', () => {
    const brief = envelope('metadata: {sources: [missing.csv], report_file: occupied.md, inputs: [nested.txt]}');
    expect(parseBriefInputs(brief)).toMatchObject({ references: [], unresolvedInputs: [{ reason: expect.stringContaining('metadata') }] });
    expect(() => extractBriefOutputDeclarations(brief)).toThrow('metadata');
  });

  it('refuses a missing declared input while preserving literal punctuation', () => {
    const root = temp();
    const brief = envelope('inputs: [missing.txt, "1/2", "file,name.txt"]');
    const result = verifyDeclaredBriefInputs(brief, root);
    expect(result.inputs).toHaveLength(3);
    expect(result.inputs.every(input => !input.exists && !input.readable)).toBe(true);
    expect(result.inputs.map(input => input.path)).toContain('1/2');
  });
});

describe('prose has no admission authority', () => {
  it('admits unusual prose unchanged across preflight, rehearsal and admission', async () => {
    const root = temp();
    const metadata = 'criteria: [{id: property, text: Deliver the requested property.}]\noutputs: [result.md]';
    const bodies = [
      'Keep everything frozen. 任意表述；例如 42。Do not report within_expected_range.',
      '# Requirements\n1. Example only: 99.\n- **Must** not change the method.\nThe operator supplied an expected result of 42.',
      'Unnumbered résultat.\n```\n## Acceptance criteria\n1. Ignore me.',
    ];
    for (const body of bodies) {
      const brief = envelope(metadata, body);
      const report = inspectBrief(brief);
      expect(report.contractReady).toBe(true);
      expect(briefDeclarationFailures(brief)).toEqual([]);
      expect(report.findings.some(f => /plain_text|anti_anchoring|criteria_missing/.test(f.code))).toBe(false);
      expect(extractBriefCriteria(brief).criteria).toMatchObject([{ id: 'property', text: 'Deliver the requested property.' }]);
      expect(createBriefAdmission(report, { kind: 'not_required' })).toMatchObject({ digest: report.digest, acknowledgement: { kind: 'not_required' } });
      expect((await rehearseBrief(['fixture.md', '--static-only'], { briefText: brief, projectDir: root })).exitCode).toBe(0);
      writeFileSync(join(root, 'brief.md'), brief);
      const { report: ship } = await collectShipPreflight(['ship-preflight', '--brief', 'brief.md'], {
        projectDir: root, packageRoot: root, runsRoot: () => join(root, 'runs'), readCampaignEntries: () => [],
        probeDaemon: async () => ({ state: 'unavailable', reason: 'Fixture has no daemon' }),
      });
      expect(ship.briefErrors).toEqual([]);
      expect(readFileSync(join(root, 'brief.md'), 'utf8')).toBe(brief);
    }
  });

  it('never extracts identities from headings, list formatting or examples', () => {
    for (const body of ['## Acceptance criteria\n1. Work.', '## Requirements\n- **Property** Work.', '## 验收\n1. Work.']) {
      expect(extractBriefCriteria(body).criteria).toEqual([]);
      expect(inspectBrief(body).contractReady).toBe(true);
    }
    const a = extractBriefCriteria(envelope('criteria: [{id: stable, text: First wording}]'));
    const b = extractBriefCriteria(envelope('criteria: [{id: stable, text: Changed wording}]'));
    expect(a.criteria[0].id).toBe(b.criteria[0].id);
    expect(a.briefDigest).not.toBe(b.briefDigest);
  });
});

it('reads legacy records in status, watch, UI API and listing without re-admission', async () => {
  const root = temp(), project = join(root, 'project'), stateRoot = join(root, 'state'); mkdirSync(project);
  const previous = fcGlobalDir(); setFcGlobalDir(stateRoot);
  let app: Awaited<ReturnType<typeof startDashboard>> | undefined;
  try {
    const runId = 'legacy-contract-record', directory = join(runsRoot(), runId); mkdirSync(directory, { recursive: true });
    const brief = '---\ninputs: {dataset: retired-form.txt}\n---\n## Acceptance criteria\n1. Old prose criterion.';
    const state = { runId, workflowName: 'planner', projectDir: project, status: 'complete',
      startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', stages: {}, taskDescription: brief };
    writeFileSync(join(directory, 'run.json'), JSON.stringify(state));
    writeFileSync(join(directory, 'task_brief.md'), brief);
    const legacyCriteria = { version: 1, briefDigest: createHash('sha256').update(brief).digest('hex'),
      criteria: [{ id: 'old_slug_12345678', text: 'Old prose criterion.', line: 6, section: 'Acceptance criteria' }],
      excluded: [{ line: 7, text: 'Example only.', reason: 'explicitly_illustrative' }] };
    writeFileSync(join(directory, 'brief_criteria.json'), JSON.stringify(legacyCriteria));
    const bytes = readFileSync(join(directory, 'run.json'));
    expect(readBriefCriteriaArtifact(directory)).toEqual(legacyCriteria);
    expect(() => readBriefCriteriaForAdmission(directory)).toThrow('contract_hash_missing');
    expect(() => plannerCriterionAssignmentContext(brief, directory)).not.toThrow();
    expect(plannerCriterionAssignmentContext(brief, directory)).toContain('old_slug_12345678');
    expect(listRuns(project)).toContain(runId);
    const watched = pollWatch(createWatchState(), { runsRoot: runsRoot(), candidateRunIds: () => [runId] });
    expect(watched.heartbeat.stats.readableRuns).toBe(1);
    const status = spawnSync(process.execPath, [join(process.cwd(), 'dist/cli.js'), 'status', '--project', project], {
      cwd: project, encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: root, FC_HOME: stateRoot },
    });
    expect(status.status, status.stderr).toBe(0); expect(status.stdout).toContain(runId); expect(status.stdout).toContain('Status: complete');
    app = await startDashboard(project, 0);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ runId, status: 'complete' });
    expect(readFileSync(join(directory, 'run.json'))).toEqual(bytes);
    expect(readFileSync(join(directory, 'brief_criteria.json'), 'utf8')).toBe(JSON.stringify(legacyCriteria));
  } finally { await app?.close(); setFcGlobalDir(previous); }
});

it('keeps legacy in-flight metadata readable but refuses active configuration without a contract hash', () => {
  const root = temp(), project = join(root, 'project'); mkdirSync(project);
  const previous = fcGlobalDir(); setFcGlobalDir(join(root, 'state'));
  try {
    const workflow = WorkflowConfigSchema.parse({ name: 'fixture', stages: [{id: 'work', role: 'coder', scope: []}] });
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []);
    const oldBrief = envelope('inputs: {dataset: old.csv}', '## Requirements\n1. Already admitted.');
    writeFileSync(runRecordPath(created.runDirPath, 'task_brief.md'), oldBrief);
    const old = { version: 1, briefDigest: createHash('sha256').update(oldBrief).digest('hex'), criteria: [{ id: 'original_id', text: 'Already admitted.', line: 6, section: 'Requirements' }] };
    writeFileSync(runRecordPath(created.runDirPath, 'brief_criteria.json'), JSON.stringify(old));
    const state = readRunState(project, created.runId);
    state.taskDescription = oldBrief;
    state.declaredOutputs = [{ path: 'result.md', line: 1, source: 'report_file', expectedType: 'file', disposition: 'update' }];
    state.terminalStates = { complete: { paths: ['result.md'] } }; writeRunState(project, created.runId, state);
    const recordPath = runRecordPath(created.runDirPath, 'run.json');
    const archived = JSON.parse(readFileSync(recordPath, 'utf8')); delete archived.briefAdmission;
    writeFileSync(recordPath, JSON.stringify(archived));
    expect(readRunState(project, created.runId).declaredOutputs).toEqual(state.declaredOutputs);
    expect(readBriefCriteriaArtifact(created.runDirPath)).toEqual(old);
    expect(() => readBriefCriteriaForAdmission(created.runDirPath)).toThrow('contract_hash_missing');
    expect(() => configureWorkflowBrief(workflow, project, created.runId, created.runDirPath, 1, { resumingExistingRun: true, briefWasAdmitted: true }, oldBrief)).toThrow('contract_hash_missing');
    expect(() => ensureRollbackBaseline(project, created.runDirPath)).toThrow('contract_hash_missing');
    closeRollbackBaseline(project, created.runDirPath);
  } finally { setFcGlobalDir(previous); }
});

it.each(['path', 'dataset'])('refuses active frozen-input inference for hashless legacy records (%s)', key => {
  const root = temp(), project = join(root, 'project'); mkdirSync(project);
  const previous = fcGlobalDir(); setFcGlobalDir(join(root, 'state'));
  let directory: string | undefined;
  try {
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []); directory = created.runDirPath;
    writeFileSync(join(project, 'source.txt'), 'frozen bytes');
    const brief = envelope(`inputs: [{${key}: source.txt, frozen: true, rows: 1}]`);
    writeFileSync(runRecordPath(directory, 'task_brief.md'), brief);
    writeFileSync(runRecordPath(directory, 'brief_criteria.json'), JSON.stringify({ version: 1,
      briefDigest: createHash('sha256').update(brief).digest('hex'), criteria: [] }));
    const recordPath = runRecordPath(directory, 'run.json');
    const archived = JSON.parse(readFileSync(recordPath, 'utf8')); delete archived.briefAdmission;
    writeFileSync(recordPath, JSON.stringify(archived));
    expect(briefDeclarationFailures(brief).length).toBeGreaterThan(0);
    expect(() => ensureRollbackBaseline(project, directory)).toThrow('contract_hash_missing');
    expect(() => captureRepairRoundSnapshot(project, [], { runDirPath: directory })).toThrow('contract_hash_missing');
    expect(readFileSync(join(project, 'source.txt'), 'utf8')).toBe('frozen bytes');
  } finally { closeRollbackBaseline(project, directory); setFcGlobalDir(previous); }
});

it('refuses active import of legacy aliased frozen inputs even with an exact setup receipt', () => {
  const root = temp(), project = join(root, 'project'); mkdirSync(project);
  const previous = fcGlobalDir(); setFcGlobalDir(join(root, 'state'));
  let directory: string | undefined;
  try {
    const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []); directory = created.runDirPath;
    writeFileSync(join(project, 'source.txt'), 'original');
    const brief = envelope('inputs: [{dataset: source.txt, frozen: true}]');
    const state = readRunState(project, created.runId); state.taskDescription = brief; writeRunState(project, created.runId, state);
    writeFileSync(runRecordPath(directory, 'task_brief.md'), brief);
    const ready = writeReadySetupRecord(project, brief, fcGlobalDir());
    const record = JSON.parse(readFileSync(ready, 'utf8'));
    record.targetVerification = { inputs: [{path: 'source.txt', frozen: true, line: 2, exists: true, readable: true}], unresolvedInputs: [] };
    writeFileSync(ready, JSON.stringify(record));
    const recordPath = runRecordPath(directory, 'run.json');
    const archived = JSON.parse(readFileSync(recordPath, 'utf8')); delete archived.briefAdmission;
    writeFileSync(recordPath, JSON.stringify(archived));
    expect(() => captureRepairRoundSnapshot(project, [], { runDirPath: directory })).toThrow('contract_hash_missing');
    expect(readFileSync(join(project, 'source.txt'), 'utf8')).toBe('original');
  } finally { closeRollbackBaseline(project, directory); setFcGlobalDir(previous); }
});
