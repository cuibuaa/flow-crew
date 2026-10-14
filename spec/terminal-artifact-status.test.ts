import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { terminalArtifactStatusMismatch } from '../src/terminal-artifact-status.js';
import { terminalArtifactSnapshotName } from '../src/store.js';

describe('terminal artifact status diagnostics', () => {
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
      status: 'running', startedAt: new Date(1_000).toISOString(),
      stages: { finalize: { status: 'complete' } },
      terminalStates: { complete: { paths: [complete] }, escalated: { paths: [escalated] } },
    };
    const mtimes = new Map([[join(runDir, escalatedSnapshot), 2_000]]);
    const evidence = { runDir, artifactMtimeMs: (path: string) => mtimes.get(path) };
    expect(terminalArtifactStatusMismatch(state, evidence)).toMatchObject({ terminalStatus: 'escalated', terminalArtifact: escalated });
    mtimes.set(join(runDir, completeSnapshot), 2_000);
    expect(terminalArtifactStatusMismatch(state, evidence)).toBeUndefined();
    expect(terminalArtifactStatusMismatch({ ...state, status: 'complete', terminalArtifact: escalated })).toMatchObject({ terminalStatus: 'escalated' });
  });

  it('discovers one fresh declared artifact only after every stage settles', () => {
    const projectDir = join('/workspace', 'project');
    const completePath = join(projectDir, 'docs', 'final_verification.md');
    const escalatedPath = join(projectDir, 'docs', 'escalation_note.md');
    const mtimes = new Map([[completePath, 2_000]]);
    const state = {
      status: 'running',
      startedAt: new Date(1_000).toISOString(),
      projectDir,
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
      artifactMtimeMs: (path: string) => mtimes.get(path),
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
    mtimes.set(completePath, 999);
    expect(terminalArtifactStatusMismatch(state, evidence)).toBeUndefined();
    mtimes.set(completePath, 2_000);
    mtimes.set(escalatedPath, 2_000);
    expect(terminalArtifactStatusMismatch(state, evidence)).toBeUndefined();

    const unsafePath = ['..', 'outside.md'].join('/');
    expect(terminalArtifactStatusMismatch({
      ...state,
      terminalStates: { complete: { paths: [unsafePath] } },
    }, {
      projectDir,
      runDir: join('/workspace', 'run'),
      artifactMtimeMs: () => 2_000,
    })).toBeUndefined();
  });
});
