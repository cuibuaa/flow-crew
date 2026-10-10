import { closeRepairRoundSnapshot } from './test-support/close-repair-snapshot.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';
import { publishConstraintDecision, readAcceptedScopeRevisionDecisions, scopePathDigest, type ScopeRevisionRequestV1 } from '../src/runtime-negotiation.js';
import type { StageConfig } from '../src/scheduler.js';
import * as scheduler from '../src/scheduler.js';
import { readLiveConstraintContentIdentity } from '../src/live-constraint-guard.js';

describe('scope dotfile authorization', () => {
  it('[J7] treats a terminal directory glob as including nested dotfiles without reaching a peer scope', () => {
    const scopeContainsPath = (scheduler as unknown as {
      scopeContainsPath?: (scope: string[], path: string) => boolean;
    }).scopeContainsPath;
    expect(typeof scopeContainsPath).toBe('function');
    if (!scopeContainsPath) return;
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
    return { created, request, input: { request, stage: writer, priorScope: [], activePeers: [] as StageConfig[],
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
  it('grants two safe paths and reports every conflicting capability and owner', () => {
    const { created, request, input } = setup(['safe/a.txt', 'shared/one.txt', 'shared/two.txt', 'safe/b.txt']);
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
  it('withholds input, terminal and prewritten paths while capturing only the safe preimage', () => {
    writeFileSync(join(project, 'input.txt'), 'read-only evidence');
    writeFileSync(join(project, 'changed.txt'), 'before');
    const { created, input } = setup(['input.txt', 'terminal.txt', 'changed.txt', 'safe.txt']);
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '---\ninputs:\n  - input.txt\n---\nRead the evidence.');
    writeFileSync(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({ terminalOwners: { 'terminal.txt': 'publisher' } }));
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage], { runDirPath: created.runDirPath });
    try {
      writeFileSync(join(project, 'changed.txt'), 'after');
      const decision = scheduler.decideScopeRevision({ ...input, snapshot });
      expect(decision).toMatchObject({ accepted: true, authorizedPaths: ['safe.txt'], effectiveScope: ['safe.txt'],
        rejectedPaths: ['input.txt', 'terminal.txt', 'changed.txt'] });
      expect(decision.conflicts).toEqual([
        expect.objectContaining({ path: 'input.txt', reason: expect.stringContaining('declared read-only input') }),
        expect.objectContaining({ path: 'terminal.txt', conflictingStageId: 'publisher' }),
        expect.objectContaining({ path: 'changed.txt', reason: expect.stringContaining('requested content changed before scope approval') }),
      ]);
      expect(snapshot.files.has('safe.txt')).toBe(true);
      expect(snapshot.files.has('changed.txt')).toBe(false);
      expect(readFileSync(join(project, 'input.txt'), 'utf8')).toBe('read-only evidence');
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('admits exact failed-rollback recovery without ratifying unrecorded or subsequently changed writes', () => {
    const parent = ['docs', '.comparison', 'node_modules'].join('/');
    const paths = ['recorded.txt', 'tampered.txt', 'unrecorded.txt'].map(name => `${parent}/${name}`);
    const { input } = setup(paths);
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage]);
    try {
      mkdirSync(join(project, parent), { recursive: true });
      for (const path of paths) writeFileSync(join(project, path), 'unauthorized content');
      recordFailedRollbacks(input.runId, paths.slice(0, 2));
      writeFileSync(join(project, paths[1]), 'changed after the engine observation');
      const decision = scheduler.decideScopeRevision({ ...input, snapshot });
      expect(decision).toMatchObject({ accepted: true, authorizedPaths: [paths[0]],
        rejectedPaths: paths.slice(1), effectiveScope: [paths[0]] });
      expect(snapshot.files.get(paths[0])).toMatchObject({ exists: true, text: 'unauthorized content' });
      expect(snapshot.files.has(paths[1])).toBe(false);
      const tree = ['docs/.comparison/'];
      expect(scheduler.decideScopeRevision({ ...input, request: { ...input.request,
        requestedPaths: tree, pathDigest: scopePathDigest(tree) }, snapshot })).toMatchObject({ accepted: false });
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('keeps read-only inputs, terminal owners and peers binding even for recorded failed rollbacks', () => {
    const paths = ['input.txt', 'terminal.txt', 'peer.txt'];
    for (const path of paths) writeFileSync(join(project, path), 'before');
    const { created, input } = setup(paths);
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '---\ninputs:\n  - input.txt\n---\nRead the evidence.');
    writeFileSync(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({ terminalOwners: { 'terminal.txt': 'publisher' } }));
    input.activePeers = [stage('peer', ['peer.txt'])];
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage]);
    try {
      for (const path of paths) writeFileSync(join(project, path), 'failed rollback content');
      recordFailedRollbacks(input.runId, paths);
      expect(scheduler.decideScopeRevision({ ...input, snapshot })).toMatchObject({
        accepted: false, authorizedPaths: [], rejectedPaths: paths,
        conflicts: [expect.objectContaining({ reason: expect.stringContaining('declared read-only input') }),
          expect.objectContaining({ conflictingStageId: 'publisher' }), expect.objectContaining({ conflictingStageId: 'peer' })],
      });
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('never uses failed-rollback evidence to acquire repository or engine dot-directory authority', () => {
    const paths = ['.git/config', '.fc/state.json', 'nested/.git/config', 'nested/.fc/state.json'];
    const { input } = setup(paths);
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage]);
    try {
      for (const path of paths) {
        mkdirSync(join(project, path, '..'), { recursive: true });
        writeFileSync(join(project, path), 'protected content');
      }
      recordFailedRollbacks(input.runId, paths);
      expect(scheduler.decideScopeRevision({ ...input, snapshot })).toMatchObject({
        accepted: false, authorizedPaths: [], rejectedPaths: paths,
      });
      expect(scheduler.scopeContainsPath(['**'], '.git/config')).toBe(false);
      expect(scheduler.scopeContainsPath(['**'], '.fc/state.json')).toBe(false);
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it('withholds engine carrier aliases even when their content matches a recorded failed rollback', () => {
    const paths = ['.carrier-link', '.carrier-inode'].map(name => ['node_modules', name].join('/'));
    const { created, input } = setup(paths);
    const snapshot = scheduler.captureRepairRoundSnapshot(project, [input.stage]);
    try {
      mkdirSync(join(project, 'node_modules'));
      const carrier = join(created.runDirPath, 'run.json');
      symlinkSync(carrier, join(project, paths[0]));
      linkSync(carrier, join(project, paths[1]));
      recordFailedRollbacks(input.runId, paths);
      expect(scheduler.decideScopeRevision({ ...input, snapshot })).toMatchObject({
        accepted: false, authorizedPaths: [], rejectedPaths: paths,
      });
    } finally { closeRepairRoundSnapshot(snapshot); }
  });
  it.each(['run', 'stage', 'attempt', 'digest', 'malformed'] as const)('never partially accepts an invalid %s binding', (kind) => {
    const { input, request } = setup(['safe.txt', 'blocked.txt']);
    input.activePeers = [stage('owner', ['blocked.txt'])];
    if (kind === 'run') request.runId = 'foreign';
    if (kind === 'stage') request.stageId = 'foreign';
    if (kind === 'attempt') request.attemptIndex = 2;
    if (kind === 'digest') request.pathDigest = 'bad';
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
