import { closeRepairRoundSnapshot } from './test-support/close-repair-snapshot.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, fcGlobalDir, runDir, setFcGlobalDir, updateRunState } from '../src/store.js';
import { publishConstraintDecision, readAcceptedScopeRevisionDecisions, scopePathDigest, type ScopeRevisionRequestV1 } from '../src/runtime-negotiation.js';
import type { StageConfig } from '../src/scheduler.js';
import * as scheduler from '../src/scheduler.js';
import { recordAdmittedPlan } from '../src/plan-revisions.js';
import { readLiveConstraintContentIdentity } from '../src/live-constraint-guard.js';

describe('scope dotfile authorization', () => {
  it('treats a terminal directory glob as including nested dotfiles without reaching a peer scope', () => {
    const scopeContainsPath = scheduler.scopeContainsPath;
    expect(scopeContainsPath(['.cache/**'], '.cache/a/b/c.json')).toBe(true);
    expect(scopeContainsPath(['.cache/**'], '.cache/a/.hidden.json')).toBe(true);
    expect(scopeContainsPath(['.cache/**'], '.cache/.hidden/nested.json')).toBe(true);
    expect(scopeContainsPath(['.cache/**'], 'dist/.hidden.json')).toBe(false);
    expect(scopeContainsPath(['.cache/**'], '.cache-peer/.hidden.json')).toBe(false);
    expect(scheduler.findScopeConflict(
      { id: 'left', role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false, scope: ['.cache/**'] },
      { id: 'right', role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false, scope: ['.cache-peer/**'] },
    )).toBeUndefined();
  });
});

// Independent capabilities remain independent under reservations and peer leases.
describe('path-wise scope admission', () => {
  let root: string, project: string, prior: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fc-scope-paths-'));
    project = join(root, 'project');
    mkdirSync(project);
    prior = fcGlobalDir();
    setFcGlobalDir(join(root, 'state'));
  });
  afterEach(() => { setFcGlobalDir(prior); rmSync(root, { recursive: true, force: true }); });
  const stage = (id: string, scope: string[]): StageConfig => ({
    id, scope, role: 'coder', depends_on: [], prompt_template: '', skills: [], dynamic_dispatch: false, is_gate: false,
  });
  function setup(paths: string[]) {
    const writer = stage('writer', []);
    const created = createRun(project, 'scope-paths', 'name: scope-paths', ['writer']);
    const request: ScopeRevisionRequestV1 = {
      version: 1, kind: 'scope_revision', requestId: 'paths', runId: created.runId,
      stageId: writer.id, attemptIndex: 1, requestedBy: 'stage', requestedPaths: paths,
      pathDigest: scopePathDigest(paths), reason: 'produce independently owned outputs',
    };
    return { created, request, input: { request, stage: writer, priorScope: [] as string[], activePeers: [] as StageConfig[],
      projectDir: project, runId: created.runId, attemptIndex: 1 } };
  }
  function recordFailedRollbacks(runId: string, paths: string[]): void {
    const directory = join(runDir(project, runId), 'stages/writer');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'live_constraint_incidents_attempt_1.jsonl'), paths.map(path => JSON.stringify({
      version: 1, kind: 'live_constraint_incident', stageId: 'writer', attemptIndex: 1, path,
      changeObserved: true, rollbackAttempted: true, restored: false, rollbackFailure: 'unobserved preimage',
      unrestoredContent: readLiveConstraintContentIdentity(join(project, path)),
    })).join('\n') + '\n');
  }
  it.each(['static', 'dispatched'])('grants two safe paths and reports every conflicting capability and owner (%s)', mode => {
    const { created, request, input } = setup(['safe/a.txt', 'shared/one.txt', 'shared/two.txt', 'safe/b.txt']);
    if (mode === 'dispatched') {
      input.stage = scheduler.parseDispatchedStageConfig({ id: 'writer', role: 'coder', scope: [] });
      const planner = scheduler.parseDispatchedStageConfig({ id: 'plan', role: 'planner', dynamic_dispatch: true });
      updateRunState(project, created.runId, state => {
        recordAdmittedPlan(state, [planner, input.stage], created.runDirPath, 'scope fixture', true);
        state.dispatchedStages = [input.stage];
      });
    }
    input.activePeers = [stage('first', ['shared/one.txt', 'shared/two.txt']), stage('second', ['shared/two.txt'])];
    const decision = scheduler.decideScopeRevision(input);
    expect(decision).toMatchObject({ accepted: true, requestedPaths: request.requestedPaths,
      authorizedPaths: ['safe/a.txt', 'safe/b.txt'], effectiveScope: ['safe/a.txt', 'safe/b.txt'],
      rejectedPaths: ['shared/one.txt', 'shared/two.txt'] });
    expect(decision.conflicts).toEqual([
      expect.objectContaining({ path: 'shared/one.txt', conflictingStageId: 'first' }),
      expect.objectContaining({ path: 'shared/two.txt', conflictingStageId: 'first' }),
      expect.objectContaining({ path: 'shared/two.txt', conflictingStageId: 'second' }),
    ]);
    const publication = publishConstraintDecision({ stagePath: join(created.runDirPath, 'stages', 'writer'), request,
      decidedBy: 'scheduler-policy', decision: decision as Parameters<typeof publishConstraintDecision>[0]['decision'] });
    expect(publication.kind).toBe('published');
    expect(scheduler.stageWithInheritedScope(created.runDirPath, input.stage).scope).toEqual(['safe/a.txt', 'safe/b.txt']);
    expect(readAcceptedScopeRevisionDecisions(join(created.runDirPath, 'stages', 'writer'), {
      runId: created.runId, stageId: 'writer', attemptIndex: 2,
    })).toEqual([]);
  });
  it.each([
    { request: 'dist/**/.*', changed: 'dist/adapters/base.d.ts', existing: true },
    { request: 'dist/generations/current/.manifest.json', changed: 'dist/generations/current/.manifest.json', existing: false },
  ])('recognizes changes already covered by a declared tree ($request)', ({ request, changed, existing }) => {
    const { input } = setup([request]);
    input.stage.scope = ['dist/**']; input.priorScope = ['dist/**'];
    mkdirSync(join(project, changed, '..'), { recursive: true });
    if (existing) writeFileSync(join(project, changed), 'before');
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage]);
    try {
      writeFileSync(join(project, changed), 'authorized change');
      expect(scheduler.decideScopeRevision({ ...input, snapshot })).toMatchObject({
        accepted: true, decision: 'accepted', authorizedPaths: [], alreadyAuthorizedPaths: [request], effectiveScope: ['dist/**'],
      });
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('withholds frozen inputs while capturing the current preimage for future grants', () => {
    writeFileSync(join(project, 'input.txt'), 'read-only evidence');
    writeFileSync(join(project, 'changed.txt'), 'before');
    const { created, input } = setup(['input.txt', 'changed.txt', 'safe.txt']);
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '---\ninputs:\n  - input.txt\n---\nRead the evidence.');
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage], { runDirPath: created.runDirPath });
    try {
      writeFileSync(join(project, 'changed.txt'), 'after');
      const decision = scheduler.decideScopeRevision({ ...input, snapshot });
      expect(decision).toMatchObject({ accepted: true, authorizedPaths: ['changed.txt', 'safe.txt'], effectiveScope: ['changed.txt', 'safe.txt'],
        rejectedPaths: ['input.txt'] });
      expect(decision.conflicts).toEqual([
        expect.objectContaining({ path: 'input.txt', reason: expect.stringContaining('declared read-only input') }),
      ]);
      expect(snapshot.files.has('safe.txt')).toBe(true);
      expect(snapshot.files.get('changed.txt')).toMatchObject({ exists: true, text: 'after' });
      expect(readFileSync(join(project, 'input.txt'), 'utf8')).toBe('read-only evidence');
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('grants a declared output inside an input tree while withholding its preserved sibling', () => {
    mkdirSync(join(project, 'fixtures', 'source'), { recursive: true });
    writeFileSync(join(project, 'fixtures', 'source', 'evidence.txt'), 'read-only evidence');
    const output = 'fixtures/source/report.md';
    const sibling = 'fixtures/source/evidence.txt';
    const { created, input } = setup([output, sibling]);
    writeFileSync(join(created.runDirPath, 'task_brief.md'), [
      '---', 'inputs: [fixtures/source]', `outputs: [${output}]`, '---', 'Write the declared report.',
    ].join('\n'));
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage], { runDirPath: created.runDirPath });
    try {
      const decision = scheduler.decideScopeRevision({ ...input, snapshot });
      expect(decision).toMatchObject({ accepted: true, authorizedPaths: [output], effectiveScope: [output],
        rejectedPaths: [sibling], conflicts: [expect.objectContaining({
          path: sibling, reason: expect.stringContaining('declared read-only input'),
        })] });
      const bindings = scheduler.resolveDeclaredInputWriteBindings(project,
        readFileSync(join(created.runDirPath, 'task_brief.md'), 'utf8'));
      expect(scheduler.scopeContainsPath(decision.effectiveScope, output, project, bindings)).toBe(true);
      expect(scheduler.scopeContainsPath(['**'], sibling, project, bindings)).toBe(false);
      expect(snapshot.files.has(output)).toBe(true);
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('admits future recovery independently of earlier failed-rollback identities', () => {
    const parent = ['artifacts', '.comparison', 'node_modules'].join('/');
    const paths = ['recorded.txt', 'tampered.txt', 'unrecorded.txt'].map(name => `${parent}/${name}`);
    const { input } = setup(paths);
    mkdirSync(join(project, parent), { recursive: true });
    for (const path of paths) writeFileSync(join(project, path), 'observed original content');
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage]);
    try {
      for (const path of paths) writeFileSync(join(project, path), 'unauthorized content');
      recordFailedRollbacks(input.runId, paths.slice(0, 2));
      writeFileSync(join(project, paths[1]), 'changed after the engine observation');
      const decision = scheduler.decideScopeRevision({ ...input, snapshot });
      expect(decision).toMatchObject({ accepted: true, authorizedPaths: paths, effectiveScope: paths });
      expect(snapshot.files.get(paths[0])).toMatchObject({ exists: true, text: 'unauthorized content' });
      expect(snapshot.files.get(paths[1])).toMatchObject({ exists: true, text: 'changed after the engine observation' });
      const tree = ['artifacts/.comparison/'];
      expect(scheduler.decideScopeRevision({ ...input, request: { ...input.request,
        requestedPaths: tree, pathDigest: scopePathDigest(tree) }, snapshot })).toMatchObject({ accepted: true });
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it.each(['dist/', 'dist/**', '**'])('grants a changed output subtree prospectively and preserves prior violation evidence (%s)', requested => {
    const path = 'dist/adapters/base.d.ts';
    const { created, input } = setup([requested]);
    mkdirSync(join(project, 'dist', 'adapters'), { recursive: true });
    writeFileSync(join(project, path), 'before build');
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage], { runDirPath: created.runDirPath });
    try {
      writeFileSync(join(project, path), 'generated before admission');
      recordFailedRollbacks(input.runId, [path]);
      const incidentPath = join(created.runDirPath, 'stages/writer/live_constraint_incidents_attempt_1.jsonl');
      const history = readFileSync(incidentPath, 'utf8');
      const decision = scheduler.decideScopeRevision({ ...input, snapshot });
      expect(decision).toMatchObject({ accepted: true, authorizedPaths: [requested], effectiveScope: [requested] });
      expect(readFileSync(incidentPath, 'utf8')).toBe(history);
      expect(snapshot.files.get(path)).toMatchObject({ exists: true, text: 'generated before admission' });
      writeFileSync(join(project, path), 'later authorized write');
      expect(snapshot.files.get(path)).toMatchObject({ text: 'generated before admission' });
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('keeps read-only inputs and peers binding even for recorded failed rollbacks', () => {
    const paths = ['input.txt', 'peer.txt'];
    for (const path of paths) writeFileSync(join(project, path), 'before');
    const { created, input } = setup(paths);
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '---\ninputs:\n  - input.txt\n---\nRead the evidence.');
    input.activePeers = [stage('peer', ['peer.txt'])];
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage]);
    try {
      for (const path of paths) writeFileSync(join(project, path), 'failed rollback content');
      recordFailedRollbacks(input.runId, paths);
      expect(scheduler.decideScopeRevision({ ...input, snapshot })).toMatchObject({
        accepted: false, authorizedPaths: [], rejectedPaths: paths,
        conflicts: [expect.objectContaining({ reason: expect.stringContaining('declared read-only input') }),
          expect.objectContaining({ conflictingStageId: 'peer' })],
      });
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('withholds the scheduler manifest and an active peer from a broad changed-tree request', () => {
    const paths = ['artifacts/', 'spec/shared.test.ts', 'safe.txt'];
    const { created, input } = setup(paths);
    const research = scheduler.parseBriefFrontmatter([
      '---', 'research:', '  baseline: 0', '  policy: greedy_stack',
      '  result_file: artifacts/round.json', '  report_dir: artifacts',
      '  stop:', '    max_rounds: 2', '---',
    ].join('\n')).research!;
    updateRunState(project, created.runId, state => { state.research = research; });
    input.activePeers = [stage('peer', ['spec/shared.test.ts'])];
    mkdirSync(join(project, 'artifacts'), { recursive: true });
    writeFileSync(join(project, 'artifacts/run_manifest.json'), 'scheduler state');
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage], { runDirPath: created.runDirPath });
    try {
      writeFileSync(join(project, 'artifacts/run_manifest.json'), 'updated scheduler state');
      const decision = scheduler.decideScopeRevision({ ...input, snapshot });
      expect(decision).toMatchObject({ accepted: true, authorizedPaths: ['safe.txt'], rejectedPaths: paths.slice(0, 2),
        conflicts: [expect.objectContaining({ path: 'artifacts/', reason: expect.stringContaining('framework-owned research manifest') }),
          expect.objectContaining({ path: 'spec/shared.test.ts', conflictingStageId: 'peer' })] });
      expect(snapshot.files.has('artifacts/run_manifest.json')).toBe(false);
      expect(snapshot.files.has('safe.txt')).toBe(true);
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it.each(['run', 'stage', 'attempt', 'malformed'] as const)('never partially accepts an invalid %s binding', (kind) => {
    const { input, request } = setup(['safe.txt', 'blocked.txt']);
    input.activePeers = [stage('owner', ['blocked.txt'])];
    if (kind === 'run') request.runId = 'foreign';
    if (kind === 'stage') request.stageId = 'foreign';
    if (kind === 'attempt') request.attemptIndex = 2;
    if (kind === 'malformed') { request.requestedPaths = ['safe.txt', '../outside']; request.pathDigest = scopePathDigest(request.requestedPaths); }
    expect(scheduler.decideScopeRevision(input)).toMatchObject({ accepted: false, authorizedPaths: [], effectiveScope: [] });
  });
  it('rejects a wholly conflicting set with all owners, rather than granting an empty subset', () => {
    const { input } = setup(['shared.txt']);
    input.activePeers = [stage('first', ['shared.txt']), stage('second', ['shared.txt'])];
    const decision = scheduler.decideScopeRevision(input);
    expect(decision).toMatchObject({ accepted: false, authorizedPaths: [], effectiveScope: [], rejectedPaths: ['shared.txt'] });
    expect(decision.conflicts).toHaveLength(2);
    expect(decision.rejectionReason).toContain('first');
    expect(decision.rejectionReason).toContain('second');
  });
});
