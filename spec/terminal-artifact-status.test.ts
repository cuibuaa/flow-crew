import { runRecordPath } from '../src/run-layout.js';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactOwnership, freshTerminalArtifact, terminalArtifactOwnership, terminalArtifactIdentity, terminalArtifactStatusMismatch } from '../src/terminal-artifact-status.js';
import { type ContentIdentity } from '../src/content-identity.js';
import { terminalArtifactSnapshotName } from '../src/store.js';

const content = (sha256: string): ContentIdentity => ({ state: 'present', type: 'file', byteLength: 1, sha256 });

describe('terminal artifact status diagnostics', () => {
  it('shows old on-disk artifacts as unverified regardless of timestamps', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-terminal-status-'));
    try {
      const artifact = join(root, 'result.md');
      const runPath = join(root, 'run.json');
      writeFileSync(runPath, JSON.stringify({
        status: 'running', projectDir: root, startedAt: '2026-01-01T00:00:00.000Z',
        stages: { owner: { status: 'complete' } }, terminalStates: { complete: { paths: ['result.md'] } },
      }));
      const legacyState = JSON.parse(readFileSync(runPath, 'utf8'));
      expect(legacyState).not.toHaveProperty('terminalArtifactBaselines');
      writeFileSync(artifact, 'same result bytes\n');
      const old = new Date('2000-01-01T00:00:00.000Z');
      utimesSync(artifact, old, old);
      expect(terminalArtifactStatusMismatch(legacyState)).toBeUndefined();
      const fresh = new Date('2026-01-01T00:00:01.000Z');
      utimesSync(artifact, fresh, fresh);
      expect(terminalArtifactStatusMismatch(legacyState)).toBeUndefined();
      expect(terminalArtifactOwnership(legacyState)).toEqual([{ path: 'result.md', ownership: 'unverified' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not invent a missing legacy baseline or treat an unreadable alias as absence', () => {
    const state = { status: 'running', stages: { owner: { status: 'complete' } },
      terminalStates: { complete: { paths: ['result.md'] } } };
    expect(terminalArtifactStatusMismatch(state, { projectDir: '/workspace', artifactIdentity: () => content('old') })).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), 'terminal-identity-'));
    try {
      writeFileSync(join(root, 'old.md'), 'old content');
      mkdirSync(join(root, 'docs'));
      symlinkSync('../old.md', join(root, 'docs/result.md'));
      const baseline = terminalArtifactIdentity(join(root, 'docs/result.md'), root);
      expect(baseline).toEqual(terminalArtifactIdentity(join(root, 'old.md'), root));
      expect(terminalArtifactStatusMismatch({ ...state, terminalArtifactBaselines: { 'result.md': baseline } },
        { projectDir: root, artifactIdentity: () => baseline })).toBeUndefined();
      symlinkSync('loop.md', join(root, 'loop.md'));
      expect(terminalArtifactIdentity(join(root, 'loop.md'), root).state).toBe('unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires an explicit recorded baseline for each path', () => {
    expect(artifactOwnership(undefined, content('new'))).toBe('unverified');
    expect(terminalArtifactOwnership({ terminalArtifact: 'recorded.md' })).toEqual([{ path: 'recorded.md', ownership: 'unverified' }]);
    expect(artifactOwnership({ state: 'absent' }, content('new'))).toBe('current');
    expect(artifactOwnership(content('new'), content('new'))).toBe('stale');
  });

  it.each(['touch', 'rewrite', 'inherited'])('rejects %s terminal bytes even with newer timestamps', mode => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-content-'));
    try {
      const path = join(root, 'result.md');
      writeFileSync(path, 'same');
      const state = { startedAt: '2026-01-01', terminalArtifactBaselines: { 'result.md': terminalArtifactIdentity(path, root) } };
      if (mode === 'rewrite') writeFileSync(path, 'same');
      utimesSync(path, new Date(mode === 'inherited' ? '2000-01-01' : '2030-01-01'), new Date(mode === 'inherited' ? '2000-01-01' : '2030-01-01'));
      expect(freshTerminalArtifact(state, 'result.md', path, root)).toBe(false);
      writeFileSync(path, 'changed');
      utimesSync(path, new Date('2000-01-01'), new Date('2000-01-01'));
      expect(freshTerminalArtifact(state, 'result.md', path, root)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns only an unambiguous disagreement and never rewrites lifecycle status', () => {
    const state = {
      status: 'complete',
      terminalArtifact: 'escalation_note.md',
      terminalStates: {
        complete: { paths: ['docs/parity_verification.md'] },
        escalated: { paths: ['docs/front_end_parity/escalation_note.md'] },
      },
    };

    expect(terminalArtifactStatusMismatch(state)).toEqual({
      lifecycleStatus: 'complete',
      terminalStatus: 'escalated',
      terminalArtifact: 'escalation_note.md',
    });
    expect(state.status).toBe('complete');
  });

  it('returns no disagreement for a matching lifecycle status or an ambiguous basename', () => {
    expect(terminalArtifactStatusMismatch({
      status: 'escalated',
      terminalArtifact: 'result.md',
      terminalStates: { escalated: { paths: ['docs/result.md'] } },
    })).toBeUndefined();

    expect(terminalArtifactStatusMismatch({
      status: 'complete',
      terminalArtifact: 'result.md',
      terminalStates: {
        complete: { paths: ['good/result.md'] },
        escalated: { paths: ['blocked/result.md'] },
      },
    })).toBeUndefined();

    expect(terminalArtifactStatusMismatch({
      status: 'complete', terminalArtifact: 'result.md',
      terminalStates: { complete: { paths: ['nested/result.md'] }, escalated: { paths: ['result.md'] } },
    })).toMatchObject({ terminalStatus: 'escalated', terminalArtifact: 'result.md' });
  });

  it('recovers the declared path from distinct bounded snapshots of same-named reports', () => {
    const complete = `${'nested/'.repeat(50)}complete/report.md`;
    const escalated = `${'nested/'.repeat(50)}escalated/report.md`;
    const runDir = '/workspace/run';
    const completeSnapshot = terminalArtifactSnapshotName(complete);
    const escalatedSnapshot = terminalArtifactSnapshotName(escalated);
    expect(completeSnapshot.length).toBeLessThan(255);
    expect(escalatedSnapshot).not.toBe(completeSnapshot);
    const state = {
      status: 'running', terminalArtifactBaselines: { [complete]: { state: 'absent' as const }, [escalated]: { state: 'absent' as const } }, startedAt: new Date(1_000).toISOString(),
      stages: { finalize: { status: 'complete' } },
      terminalStates: { complete: { paths: [complete] }, escalated: { paths: [escalated] } },
    };
    const identities = new Map([[runRecordPath(runDir, escalatedSnapshot), content('new')]]);
    const evidence = { runDir, artifactIdentity: (path: string): ContentIdentity => identities.get(path) ?? { state: 'absent' } };
    expect(terminalArtifactStatusMismatch(state, evidence)).toMatchObject({ terminalStatus: 'escalated', terminalArtifact: escalated });
    identities.set(runRecordPath(runDir, completeSnapshot), content('new'));
    expect(terminalArtifactStatusMismatch(state, evidence)).toBeUndefined();
    expect(terminalArtifactStatusMismatch({ ...state, status: 'complete', terminalArtifact: escalated })).toMatchObject({ terminalStatus: 'escalated' });
  });

  it.each([undefined, 2])('discovers a retained on-disk snapshot in layout %s without a project copy', storageLayout => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-terminal-status-'));
    try {
      const runDir = join(root, 'run'), projectDir = join(root, 'project');
      mkdirSync(runDir); mkdirSync(projectDir);
      const declared = 'docs/result.md';
      const state = { storageLayout, projectDir, status: 'running', terminalArtifactBaselines: { [declared]: { state: 'absent' as const } },
        stages: { done: { status: 'complete' } }, terminalStates: { complete: { paths: [declared] } } };
      const stateBytes = JSON.stringify(state);
      writeFileSync(join(runDir, 'run.json'), stateBytes);
      const name = terminalArtifactSnapshotName(declared);
      const snapshot = join(runDir, ...(storageLayout === 2 ? ['engine', name] : [name]));
      mkdirSync(dirname(snapshot), { recursive: true }); writeFileSync(snapshot, 'Engine-retained result.\n');
      expect(existsSync(join(projectDir, declared))).toBe(false);
      expect(terminalArtifactStatusMismatch(state, { runDir })).toEqual({
        lifecycleStatus: 'running', terminalStatus: 'complete', terminalArtifact: declared,
      });
      expect(readFileSync(join(runDir, 'run.json'), 'utf8')).toBe(stateBytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('discovers one fresh declared artifact only after every stage settles', () => {
    const projectDir = join('/workspace', 'project');
    const completePath = join(projectDir, 'docs', 'final_verification.md');
    const escalatedPath = join(projectDir, 'docs', 'escalation_note.md');
    const identities = new Map([[completePath, content('new')]]);
    const state = {
      status: 'running',
      startedAt: new Date(1_000).toISOString(),
      projectDir,
      terminalArtifactBaselines: { 'docs/final_verification.md': content('old'), 'docs/escalation_note.md': { state: 'absent' as const } },
      stages: {
        implement: { status: 'complete' },
        verify: { status: 'failed' },
      },
      terminalStates: {
        complete: { paths: ['docs/final_verification.md'] },
        escalated: { paths: ['docs/escalation_note.md'] },
      },
    };
    const evidence = {
      projectDir,
      artifactIdentity: (path: string): ContentIdentity => identities.get(path) ?? { state: 'absent' },
    };

    expect(terminalArtifactStatusMismatch(state, evidence)).toEqual({
      lifecycleStatus: 'running',
      terminalStatus: 'complete',
      terminalArtifact: 'docs/final_verification.md',
    });
    expect(state.status).toBe('running');

    state.stages.verify.status = 'running';
    expect(terminalArtifactStatusMismatch(state, evidence)).toBeUndefined();
    state.stages.verify.status = 'complete';
    identities.set(completePath, content('old'));
    expect(terminalArtifactStatusMismatch(state, evidence)).toBeUndefined();
    identities.set(completePath, content('new'));
    identities.set(escalatedPath, content('new'));
    expect(terminalArtifactStatusMismatch(state, evidence)).toBeUndefined();

    const unsafePath = ['..', 'outside.md'].join('/');
    expect(terminalArtifactStatusMismatch({
      ...state,
      terminalStates: { complete: { paths: [unsafePath] } },
    }, {
      projectDir,
      runDir: join('/workspace', 'run'),
      artifactIdentity: () => content('new'),
    })).toBeUndefined();
  });
});
