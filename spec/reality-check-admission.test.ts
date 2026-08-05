import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseChecksFromMarkdown } from '../src/reality-gate/index.js';
import {
  createRun,
  enforceRealityGateBeforeTerminal,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
} from '../src/store.js';

let projectDir: string;
let taskDir: string;
let previousFcGlobalDir: string;

beforeEach(() => {
  previousFcGlobalDir = fcGlobalDir();
  projectDir = mkdtempSync(join(tmpdir(), `p2-m4-project-${randomBytes(4).toString('hex')}-`));
  taskDir = mkdtempSync(join(tmpdir(), `p2-m4-task-${randomBytes(4).toString('hex')}-`));
  setFcGlobalDir(join(taskDir, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousFcGlobalDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(taskDir, { recursive: true, force: true });
});

function createRealityRun(markdown: string) {
  const created = createRun(projectDir, 'test', 'name: test', []);
  writeFileSync(join(runDir(projectDir, created.runId), 'reality_checks.md'), markdown, 'utf-8');
  const state = readRunState(projectDir, created.runId);
  state.status = 'complete';
  return { ...created, state };
}

async function expectMalformedAdmission(
  yamlItem: string[],
  expectedName: string,
  expectedDiagnostic: string,
) {
  const markdown = ['## Reality checks', 'checks:', ...yamlItem].join('\n');
  const parsed = parseChecksFromMarkdown(markdown);
  expect(parsed).toEqual([{
    kind: 'invalid',
    name: expectedName,
    type: '__invalid-reality-check-declaration__',
    diagnostic: expectedDiagnostic,
  }]);

  const created = createRealityRun(markdown);
  const gate = await enforceRealityGateBeforeTerminal(
    projectDir,
    created.runId,
    created.state,
    'complete',
  );

  expect(gate.allowed).toBe(false);
  expect(gate.report).toMatchObject({
    pass: false,
    checksRun: 1,
    results: [{
      name: expectedName,
      type: '__invalid-reality-check-declaration__',
      pass: false,
      details: expectedDiagnostic,
    }],
  });
  expect(gate.report?.results[0].advisory).not.toBe(true);

  const persisted = readRunState(projectDir, created.runId);
  expect(persisted.status).toBe('reality_gate_failed');
  expect(persisted.failureReason).toContain(expectedName);
  expect(persisted.failureReason).toContain(expectedDiagnostic);
  expect(persisted.realityGate?.results[0]).toMatchObject({
    name: expectedName,
    pass: false,
    advisory: false,
    details: expectedDiagnostic,
  });

  const artifact = JSON.parse(readFileSync(
    join(created.runDirPath, '.reality-gate.json'),
    'utf-8',
  )) as { pass: boolean; checksRun: number; results: Array<{ details: string }> };
  expect(artifact).toMatchObject({ pass: false, checksRun: 1 });
  expect(artifact.results[0].details).toBe(expectedDiagnostic);
  expect(readFileSync(join(created.runDirPath, '.reality-gate.failures.md'), 'utf-8'))
    .toContain(expectedDiagnostic);
}

describe('malformed Reality-check admission', () => {
  it('keeps a brief without a Reality checks heading admissible as an empty declaration set', async () => {
    const markdown = ['# Task', 'No deterministic checks are declared.'].join('\n');
    expect(parseChecksFromMarkdown(markdown)).toEqual([]);
    const created = createRealityRun(markdown);

    const gate = await enforceRealityGateBeforeTerminal(
      projectDir,
      created.runId,
      created.state,
      'complete',
    );

    expect(gate.allowed).toBe(true);
    expect(gate.report).toBeUndefined();
    expect(existsSync(join(created.runDirPath, '.reality-gate.json'))).toBe(false);
  });

  it.each([
    { label: 'scalar', item: ['  - 42'] },
    { label: 'null', item: ['  - null'] },
    { label: 'array', item: ['  - [nested]'] },
  ])('turns a non-object $label item into a named hard failure', async ({ item }) => {
    await expectMalformedAdmission(
      item,
      'Reality check item #1',
      'Reality check item #1 must be an object',
    );
  });

  it('turns a declaration without a string name into a non-advisory hard failure', async () => {
    await expectMalformedAdmission(
      [
        '  - type: file-exists-nonempty',
        '    advisory: true',
        '    params: { paths: [artifact.txt] }',
      ],
      'Reality check item #1',
      'Reality check item #1 must have a string name',
    );
  });

  it('preserves a supplied name when a declaration has no string type', async () => {
    await expectMalformedAdmission(
      [
        '  - name: required-artifact',
        '    advisory: true',
        '    params: { paths: [artifact.txt] }',
      ],
      'required-artifact',
      'Reality check item #1 must have a string type',
    );
  });

  it('preserves valid declaration and execution order, results, and terminal outcome', async () => {
    mkdirSync(join(projectDir, 'artifacts'), { recursive: true });
    writeFileSync(join(projectDir, 'artifacts', 'present.txt'), 'present\n', 'utf-8');
    const markdown = [
      '## Reality checks',
      'checks:',
      '  - name: present-first',
      '    type: file-exists-nonempty',
      '    params: { paths: [artifacts/present.txt] }',
      '  - name: missing-second',
      '    type: file-exists-nonempty',
      '    params: { paths: [artifacts/missing.txt] }',
    ].join('\n');

    expect(parseChecksFromMarkdown(markdown)).toEqual([
      {
        name: 'present-first',
        type: 'file-exists-nonempty',
        params: { paths: ['artifacts/present.txt'] },
      },
      {
        name: 'missing-second',
        type: 'file-exists-nonempty',
        params: { paths: ['artifacts/missing.txt'] },
      },
    ]);
    const created = createRealityRun(markdown);

    const gate = await enforceRealityGateBeforeTerminal(
      projectDir,
      created.runId,
      created.state,
      'complete',
    );

    expect(gate.allowed).toBe(false);
    expect(gate.report?.results.map(({ name, pass }) => ({ name, pass }))).toEqual([
      { name: 'present-first', pass: true },
      { name: 'missing-second', pass: false },
    ]);
    expect(readRunState(projectDir, created.runId).status).toBe('reality_gate_failed');
  });
});
