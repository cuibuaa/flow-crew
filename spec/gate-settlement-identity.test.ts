import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyArtifactContract } from './spec_presentation/declared-fixtures.js';
import { readGateEvaluation } from '../src/scheduler/sched_settlement/gate-verdict.js';
import { fcGlobalDir, setFcGlobalDir, runDir, writeRunState, type StoreState } from '../src/store.js';
import { parseDispatchedStageConfig } from '../src/scheduler.js';

const carrier = vi.hoisted(() => ({ path: '', reads: 0, first: '', later: '' }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync(path: Parameters<typeof actual.readFileSync>[0], options?: unknown) {
    if (String(path) === carrier.path) {
      const value = ++carrier.reads === 1 ? carrier.first : carrier.later;
      return options === undefined ? Buffer.from(value) : value;
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, options);
  } };
});
const originalHome = fcGlobalDir();
const roots: string[] = [];
afterEach(() => {
  carrier.path = ''; carrier.reads = 0;
  setFcGlobalDir(originalHome);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(first: Record<string, unknown>, later: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'gate-identity-')); roots.push(root);
  const projectDir = join(root, 'project'); mkdirSync(projectDir);
  setFcGlobalDir(join(root, 'store'));
  const runId = 'fixture'; const base = runDir(projectDir, runId); mkdirSync(join(base, 'stages', 'gate'), { recursive: true });
  const stage = parseDispatchedStageConfig({ id: 'gate', role: 'qa', is_gate: true, scope: [],
    artifact_contract: { ...emptyArtifactContract(), produces: [{ id: 'verdict', root: 'run', path: 'verdict_gate.json', kind: 'file' }] } });
  const state: StoreState = { runId, projectDir, workflowName: 'fixture', status: 'running', startedAt: '2026-01-01T00:00:00Z',
    stages: { gate: { status: 'complete', retries: 0, attempts: [{ index: 1, status: 'complete', startedAt: '2026-01-01T00:00:01Z', completedAt: '2026-01-01T00:00:02Z' }] } } };
  writeRunState(projectDir, runId, state);
  Object.assign(carrier, { path: join(base, 'verdict_gate.json'), reads: 0, first: JSON.stringify(first), later: JSON.stringify(later) });
  return { projectDir, stage, state, runId, base };
}

describe('gate settlement binds one authored fact', () => {
  it('does not mix a rejected authored review with a subsequently replaced passing carrier', () => {
    const f = fixture({ pass: false, reason: 'repair this finding' }, { pass: true, reason: 'replacement' });
    expect(readGateEvaluation(f.projectDir, f.stage.id, f.runId)).toEqual({
      pass: false, reason: 'repair this finding',
    });
    expect(carrier.reads).toBe(1);
  });

  it.each([
    { fresh: true, replacement: false },
    { fresh: false, replacement: false },
    { fresh: true, replacement: true },
  ])('binds terminal disposition to fresh receipts authenticating authored bytes (%j)', ({ fresh, replacement }) => {
    const verdict = { pass: false, reason: 'irreparable', repairability: { version: 1, disposition: 'irreparable', evidence: 'fixture fact' } };
    const f = fixture(verdict, replacement ? { ...verdict, reason: 'replacement' } : verdict);
    const attempt = f.state.stages.gate.attempts![0];
    writeFileSync(join(f.base, 'stages', 'gate', 'artifact_contract.json'), JSON.stringify({
      stageId: 'gate', violations: [], completionDeferred: false,
      production: { runId: f.runId, runDir: f.base, attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt },
      observations: [{ path: carrier.path, fresh, sha256: createHash('sha256').update(replacement ? carrier.later : carrier.first).digest('hex') }],
    }));
    const evaluation = readGateEvaluation(f.projectDir, f.stage.id, f.runId);
    if (fresh && !replacement) {
      expect(evaluation).toMatchObject({ pass: false, repairability: { disposition: 'irreparable' } });
    } else {
      expect(evaluation).toMatchObject({ pass: false, refusal: { kind: 'repairability' } });
      expect(evaluation?.repairability).toBeUndefined();
    }
  });

  it.skipIf(process.platform === 'win32').each(['same', 'foreign-production', 'foreign-observation'])(
    'authenticates a resumed physical receipt through a store alias (%s)', location => {
      const verdict = { pass: false, reason: 'repair the retained finding', repairability: { version: 1, disposition: 'repairable', evidence: 'fixture finding' } };
      const f = fixture(verdict, verdict);
      writeFileSync(carrier.path, carrier.first);
      const physical = realpathSync(f.base);
      const aliasStore = join(f.base, '..', '..', '..', 'store-alias');
      symlinkSync(realpathSync(join(f.base, '..', '..')), aliasStore, 'dir');
      setFcGlobalDir(aliasStore);
      carrier.path = join(runDir(f.projectDir, f.runId), 'verdict_gate.json');
      const foreign = join(f.base, '..', 'foreign'); mkdirSync(foreign);
      writeFileSync(join(foreign, 'verdict_gate.json'), carrier.first);
      const attempt = f.state.stages.gate.attempts![0];
      writeFileSync(join(f.base, 'stages', 'gate', 'artifact_contract.json'), JSON.stringify({
        stageId: 'gate', violations: [], completionDeferred: false,
        production: { runId: f.runId, runDir: location === 'foreign-production' ? foreign : physical,
          attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt },
        observations: [{ path: join(location === 'foreign-observation' ? foreign : physical, 'verdict_gate.json'),
          fresh: true, sha256: createHash('sha256').update(carrier.first).digest('hex') }],
      }));
      const evaluation = readGateEvaluation(f.projectDir, f.stage.id, f.runId);
      if (location === 'same') expect(evaluation).toMatchObject({ pass: false, repairability: { disposition: 'repairable' } });
      else expect(evaluation).toMatchObject({ pass: false, refusal: { kind: 'repairability' } });
    },
  );
});
