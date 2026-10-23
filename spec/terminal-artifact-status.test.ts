import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { terminalArtifactIdentity, terminalArtifactStatusMismatch } from '../src/terminal-artifact-status.js';
import { type ContentIdentity } from '../src/content-identity.js';
import { terminalArtifactSnapshotName } from '../src/store.js';

const content = (sha256: string): ContentIdentity => ({ state: 'present', type: 'file', byteLength: 1, sha256 });

describe('terminal artifact status diagnostics', () => {
  it('reads an old on-disk run without baselines using its original run-start freshness boundary', () => {
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
      expect(terminalArtifactStatusMismatch(legacyState)).toEqual({
        lifecycleStatus: 'running', terminalStatus: 'complete', terminalArtifact: 'result.md',
      });
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

  it('retains the legacy mtime evidence override without requiring a local content identity', () => {
    const state = {
      status: 'running', startedAt: new Date(1_000).toISOString(),
      stages: { owner: { status: 'complete' } }, terminalStates: { complete: { paths: ['result.md'] } },
    };
    const evidence = { projectDir: '/workspace', artifactMtimeMs: () => 1_000 };
    expect(terminalArtifactStatusMismatch(state, evidence)).toMatchObject({
      lifecycleStatus: 'running', terminalStatus: 'complete', terminalArtifact: 'result.md',
    });
    expect(terminalArtifactStatusMismatch(state, { ...evidence, artifactMtimeMs: () => 999 })).toBeUndefined();
    expect(terminalArtifactStatusMismatch(state, { ...evidence, artifactMtimeMs: () => undefined })).toBeUndefined();
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
      status: 'running', terminalArtifactBaselines: {}, startedAt: new Date(1_000).toISOString(),
      stages: { finalize: { status: 'complete' } },
      terminalStates: { complete: { paths: [complete] }, escalated: { paths: [escalated] } },
    };
    const identities = new Map([[join(runDir, escalatedSnapshot), content('new')]]);
    const evidence = { runDir, artifactIdentity: (path: string): ContentIdentity => identities.get(path) ?? { state: 'absent' } };
    expect(terminalArtifactStatusMismatch(state, evidence)).toMatchObject({ terminalStatus: 'escalated', terminalArtifact: escalated });
    identities.set(join(runDir, completeSnapshot), content('new'));
    expect(terminalArtifactStatusMismatch(state, evidence)).toBeUndefined();
    expect(terminalArtifactStatusMismatch({ ...state, status: 'complete', terminalArtifact: escalated })).toMatchObject({ terminalStatus: 'escalated' });
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
      terminalArtifactBaselines: { 'docs/final_verification.md': content('old') },
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
