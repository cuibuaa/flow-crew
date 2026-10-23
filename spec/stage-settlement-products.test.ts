import type { ArtifactContractInput } from './test-support/fixture-types.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_SCHEMA } from '../src/handoff.js';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir, updateRunState } from '../src/store.js';
import { runStage } from '../src/worker.js';


// The external-output boundary needs a fixture installation separate from the
// project and its output; worker settlement has no context parameter of its own.
vi.hoisted(() => vi.resetModules());
vi.mock('../src/ship-inputs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ship-inputs.js')>();
  const { dirname, join } = await import('node:path');
  return { ...actual,
    externalOutputDirectory: (...[declaration, project, fs, context]: Parameters<typeof actual.externalOutputDirectory>) =>
      actual.externalOutputDirectory(declaration, project, fs, { engineRoot: join(dirname(project), 'engine'), ...context }),
  };
});

let root: string, project: string, directory: string, runId: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settlement-products-'));
  project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  ({ runId, runDirPath: directory } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });
const role = { name: 'coder', description: 'fixture', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Deliver the declared result.' };
const contract = (produces: ArtifactContractInput['produces'], extra: Partial<ArtifactContractInput> = {}) =>
  ArtifactContractSchema.parse({ version: 1, produces, reads: [], ...extra });
const product = { id: 'product', root: 'project' as const, path: 'report.md', kind: 'file' as const };
async function settle(declaration: ReturnType<typeof contract>, work: () => void = () => {}, exitCode = 0, statuses = {}) {
  return runStage({ async run() { work(); return { output: 'Delivered', exitCode, duration_ms: 1 }; } }, {
    stageId: 'work', role, dependsOn: [], promptTemplate: 'Deliver the result', projectDir: project,
    runId, runDir: directory, retries: 0, timeout_ms: 10000,
    artifactContract: declaration, artifactStatuses: statuses,
  });
}
const audit = () => JSON.parse(readFileSync(join(directory, 'stages/work/artifact_contract.json'), 'utf8'));

describe('deterministic product settlement', () => {
  it.each(['absent', 'wrong-type', 'empty'] as const)('refuses a completed stage with a declared %s file', async kind => {
    const result = await settle(contract([{ ...product, nonempty: true }]), () => {
      if (kind === 'wrong-type') mkdirSync(join(project, 'report.md'));
      if (kind === 'empty') writeFileSync(join(project, 'report.md'), '');
    });
    expect(result.exitCode).toBe(1);
    expect(readStageStatus(project, runId, 'work').status).toBe('failed');
    expect(audit().violations[0].reason).toContain({ absent: 'ARTIFACT_OUTPUT_ABSENT', 'wrong-type': 'ARTIFACT_OUTPUT_KIND', empty: 'ARTIFACT_OUTPUT_EMPTY' }[kind]);
  });
  it.each(['absent', 'wrong-type', 'empty', 'present'] as const)('checks a declared %s directory', async kind => {
    const result = await settle(contract([{ ...product, path: 'reports', kind: 'directory', nonempty: true }]), () => {
      if (kind === 'wrong-type') writeFileSync(join(project, 'reports'), 'file');
      if (kind === 'empty' || kind === 'present') mkdirSync(join(project, 'reports'));
      if (kind === 'present') writeFileSync(join(project, 'reports/report.md'), 'result');
    });
    expect(result.exitCode).toBe(kind === 'present' ? 0 : 1);
  });
  it.each(['file', 'directory'] as const)('accepts an empty %s unless content is required', async kind => {
    const output = kind === 'file' ? product : { ...product, path: 'reports', kind };
    if (kind === 'file') writeFileSync(join(project, output.path), ''); else mkdirSync(join(project, output.path));
    expect((await settle(contract([output]))).exitCode).toBe(0);
    expect((await settle(contract([{ ...output, nonempty: true }]))).exitCode).toBe(1);
    expect(audit().violations[0].reason).toContain('ARTIFACT_OUTPUT_EMPTY');
    writeFileSync(join(project, kind === 'file' ? output.path : 'reports/member'), kind === 'file' ? 'stable result' : '');
    expect((await settle(contract([{ ...output, nonempty: true }]))).exitCode).toBe(0);
  });
  it.each([0, 1])('settles a stable output again after a prior exit %s', async firstExit => {
    let calls = 0;
    expect((await settle(contract([product]), () => { calls++; writeFileSync(join(project, product.path), 'stable result'); }, firstExit)).exitCode).toBe(firstExit);
    expect((await settle(contract([product]), () => { calls++; })).exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(readStageStatus(project, runId, 'work').attempts?.map(attempt => attempt.status)).toEqual([
      firstExit === 0 ? 'complete' : 'failed', 'complete',
    ]);
  });
  it.each(['complete', 'failed', 'running'] as const)('uses the declared output predicate with dependency %s', async status => {
    const conditional = { ...product, when: { stage: 'prior', field: 'status' as const, equals: 'complete' } };
    const result = await settle(contract([conditional]), undefined, 0, { prior: { status, retries: 0 } });
    expect(result.exitCode).toBe(status === 'failed' ? 0 : 1);
    if (status === 'running') expect(audit().violations[0].reason).toContain('ARTIFACT_FACT_UNKNOWN');
  });
  it.each([0, 1, 2])('refuses exactly-one settlement unless one of its %s outputs exists', async count => {
    const result = await settle(contract([product, { ...product, id: 'other', path: 'other.md' }], {
      groups: [{ id: 'outcome', mode: 'exactly_one', members: ['product', 'other'] }],
    }), () => {
      if (count > 0) writeFileSync(join(project, 'report.md'), 'result');
      if (count > 1) writeFileSync(join(project, 'other.md'), 'other result');
    });
    expect(result.exitCode).toBe(count === 1 ? 0 : 1);
    if (count !== 1) expect(audit().violations[0].reason).toContain('ARTIFACT_OUTPUT_GROUP');
  });
  it('does not demand outputs from an attempt that failed before completion', async () => {
    expect((await settle(contract([product]), undefined, 9)).exitCode).toBe(9);
    expect(audit().completionDeferred).toBe(true);
    expect(audit().violations).toEqual([]);
  });
  it.each(['deleted', 'wrong-type', 'retained'] as const)('checks a previously valid declared run product when %s by an ordinary stage', async kind => {
    updateRunState(project, runId, state => { state.declaredOutputs = [{ path: 'report.md', expectedType: 'file', line: 1, source: 'outputs', disposition: 'create' }]; });
    writeFileSync(join(project, 'report.md'), 'required run product');
    const result = await settle(contract([]), () => {
      if (kind !== 'retained') rmSync(join(project, 'report.md'));
      if (kind === 'wrong-type') mkdirSync(join(project, 'report.md'));
    });
    expect(result.exitCode).toBe(kind === 'retained' ? 0 : 1);
    if (kind !== 'retained') {
      expect(audit().violations[0].reason).toContain('DECLARED_OUTPUT_REMOVED');
      expect(readStageStatus(project, runId, 'work').status).toBe('failed');
    }
  });
  it('leaves a declared run product assigned to later work undemanded', async () => {
    updateRunState(project, runId, state => { state.declaredOutputs = [{ path: 'report.md', expectedType: 'file', line: 1, source: 'outputs', disposition: 'create' }]; });
    expect((await settle(contract([]))).exitCode).toBe(0);
    expect(audit().violations).toEqual([]);
  });
});

describe('direct author product settlement', () => {
  it.each(['delivered', 'blocked'] as const)('checks whole-brief products when the direct author reports %s', async status => {
    updateRunState(project, runId, state => {
      state.workflowName = 'direct';
      state.declaredOutputs = [{ path: 'report.md', expectedType: 'file', line: 1, source: 'outputs', disposition: 'create' }];
    });
    const result = await runStage({ async run() { return {
      output: JSON.stringify({ status, summary: 'Result', files_modified: [], checks: [], caveats: [] }), exitCode: 0, duration_ms: 1,
    }; } }, {
      stageId: 'work', role, dependsOn: [], promptTemplate: 'Deliver the entire brief', projectDir: project,
      runId, runDir: directory, retries: 0, timeout_ms: 10000,
      artifactContract: contract([]), gateReviewed: true,
      outputSchema: HANDOFF_SCHEMA,
    });
    expect(result.exitCode).toBe(status === 'delivered' ? 1 : 0);
    if (status === 'delivered') expect(audit().violations[0].reason).toContain('DECLARED_OUTPUT_REQUIRED');
  });
});

it('refuses removal of an authorized external product and records its absolute locator', async () => {
  const output = join(root, 'external-results'); mkdirSync(output);
  updateRunState(project, runId, state => {
    state.declaredOutputs = [{ path: output, expectedType: 'directory', line: 1, source: 'outputs', disposition: 'create' }];
  });
  const result = await settle(contract([]), () => rmSync(output, { recursive: true }));
  expect(result.exitCode).toBe(1);
  expect(audit().violations).toEqual([expect.objectContaining({ path: output, reason: expect.stringContaining('DECLARED_OUTPUT_REMOVED') })]);
});

it('records product removal even when the adapter already failed', async () => {
  updateRunState(project, runId, state => {
    state.declaredOutputs = [{ path: 'report.md', expectedType: 'file', line: 1, source: 'outputs', disposition: 'create' }];
  });
  writeFileSync(join(project, 'report.md'), 'required product');
  const result = await settle(contract([]), () => rmSync(join(project, 'report.md')), 9);
  expect(result.exitCode).toBe(9);
  expect(readStageStatus(project, runId, 'work').status).toBe('failed');
  expect(audit().violations[0].reason).toContain('DECLARED_OUTPUT_REMOVED');
});
