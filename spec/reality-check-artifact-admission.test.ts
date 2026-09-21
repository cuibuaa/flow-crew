import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAllChecks } from '../src/reality-gate/index.js';
import { readRunEvents } from '../src/run-events.js';
import {
  createRun,
  enforceRealityGateBeforeTerminal,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
} from '../src/store.js';
import type { CheckDecl } from '../src/reality-gate/types.js';

let sandboxRoot: string;
let projectDir: string;
let isolatedRoot: string;
let previousRoot: string;

beforeEach(() => {
  previousRoot = fcGlobalDir();
  sandboxRoot = mkdtempSync(join(tmpdir(), `artifact-admission-${randomBytes(4).toString('hex')}-`));
  projectDir = join(sandboxRoot, 'project');
  isolatedRoot = join(sandboxRoot, 'state');
  mkdirSync(projectDir, { recursive: true });
  setFcGlobalDir(isolatedRoot);
});

afterEach(() => {
  setFcGlobalDir(previousRoot);
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function write(relativePath: string, body: string): string {
  const path = join(projectDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return path;
}

function writeJson(relativePath: string, value: unknown): string {
  return write(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function inlineCheck(options: {
  path?: string;
  prelude?: string[];
  guards: string[];
}): string {
  const artifactPath = options.path ?? 'output/result.json';
  return [
    "node <<'NODE'",
    "const fs = require('fs');",
    `const dataPath = '${artifactPath}';`,
    "const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
    'function fail(message) { console.error(message); process.exit(1); }',
    ...(options.prelude ?? []),
    ...options.guards,
    'NODE',
    '',
  ].join('\n');
}

function declaration(script: string, name = 'artifact integrity'): CheckDecl {
  return { name, type: 'exec-script-exit-zero', params: { script } };
}

function checksMarkdown(script: string, name = 'artifact integrity'): string {
  return [
    '## Reality checks',
    '```yaml',
    'checks:',
    `  - name: ${name}`,
    '    type: exec-script-exit-zero',
    '    params:',
    '      script: |',
    ...script.trimEnd().split('\n').map((line) => `        ${line}`),
    '```',
    '',
  ].join('\n');
}

async function run(script: string) {
  return runAllChecks([declaration(script)], { projectDir, taskDir: join(sandboxRoot, 'task') });
}

function unboundMultiShapeScript(path?: string): string {
  return inlineCheck({
    path,
    guards: [
      "if (!data.expected_one) fail('first shape is absent');",
      "if (!data.expected_two || !Array.isArray(data.expected_two.rows)) fail('second shape is absent');",
    ],
  });
}

describe('late versioned-JSON reality-check admission', () => {
  it('keeps the failed execution intact while making an unbound multi-shape mismatch advisory', async () => {
    writeJson('output/result.json', { artifact: 'generic.summary.v2', records: [] });
    const script = unboundMultiShapeScript();

    const report = await run(script);

    expect(report.pass).toBe(true);
    expect(report.results[0]).toMatchObject({
      pass: false,
      advisory: true,
      evidence: {
        command: script,
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'first shape is absent\n',
        timedOut: false,
        exit: { code: 1, signal: null, timedOut: false },
        terminalAdmission: {
          classification: 'unbound-versioned-json-multi-shape-mismatch',
          artifactPath: 'output/result.json',
          discriminator: { field: 'artifact', value: 'generic.summary.v2' },
          independentFailureGuards: 2,
          matchedDiagnostic: 'first shape is absent',
        },
      },
    });
    const evidence = report.results[0].evidence as {
      terminalAdmission: { incompatiblePaths: Array<{ path: string }> };
    };
    expect(evidence.terminalAdmission.incompatiblePaths.map(({ path }) => path))
      .toEqual(expect.arrayContaining(['expected_one', 'expected_two']));
  });

  it('allows terminal success and emits an advisory event from an isolated store', async () => {
    writeJson('output/result.json', { artifact: 'generic.summary.v2', records: [] });
    const script = unboundMultiShapeScript();
    const created = createRun(projectDir, 'test', 'name: isolated-admission', []);
    const replayDir = runDir(projectDir, created.runId);
    expect(relative(isolatedRoot, replayDir)).not.toMatch(/^\.\.(?:\/|$)/u);
    writeFileSync(join(replayDir, 'reality_checks.md'), checksMarkdown(script), 'utf8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');

    expect(gate.allowed).toBe(true);
    expect(gate.state.status).toBe('complete');
    expect(gate.report).toMatchObject({
      pass: true,
      results: [{ pass: false, advisory: true }],
    });
    const persisted = JSON.parse(readFileSync(join(replayDir, '.reality-gate.json'), 'utf8')) as {
      results: Array<{ evidence: { terminalAdmission?: { classification?: string } } }>;
    };
    expect(persisted.results[0]?.evidence.terminalAdmission?.classification)
      .toBe('unbound-versioned-json-multi-shape-mismatch');
    expect(readRunEvents(projectDir, created.runId)).toContainEqual(expect.objectContaining({
      type: 'reality_gate_advisory',
      detail: expect.stringContaining('artifact integrity'),
    }));
  });

  it('keeps a discriminator-bound referential-integrity defect hard and ends the run', async () => {
    writeJson('graph/graph.json', {
      artifact: 'generic.graph.v3',
      nodes: [{ id: 'root', links: ['absent-node'] }],
    });
    const script = inlineCheck({
      path: 'graph/graph.json',
      prelude: [
        "if (data.artifact !== 'generic.graph.v3') fail('unexpected graph format');",
        'const ids = new Set(data.nodes.map((node) => node.id));',
      ],
      guards: [
        "for (const node of data.nodes) for (const link of node.links) if (!ids.has(link)) fail('dangling graph link');",
      ],
    });
    const created = createRun(projectDir, 'test', 'name: graph-integrity', []);
    const replayDir = runDir(projectDir, created.runId);
    writeFileSync(join(replayDir, 'reality_checks.md'), checksMarkdown(script, 'graph references resolve'), 'utf8');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';

    const gate = await enforceRealityGateBeforeTerminal(projectDir, created.runId, state, 'complete');

    expect(gate.allowed).toBe(false);
    expect(gate.report?.results[0]).toMatchObject({
      pass: false,
      evidence: {
        code: 1,
        stderr: 'dangling graph link\n',
        exit: { code: 1, signal: null, timedOut: false },
      },
    });
    expect(gate.report?.results[0].advisory).not.toBe(true);
    expect(readRunState(projectDir, created.runId).status).toBe('reality_gate_failed');
  });

  it('does not admit a check with only one incompatible guard', async () => {
    writeJson('output/result.json', { artifact: 'generic.summary.v2' });
    const report = await run(inlineCheck({
      guards: ["if (!data.expected_one) fail('one shape is absent');"],
    }));
    expect(report.pass).toBe(false);
    expect(report.results[0].advisory).not.toBe(true);
  });

  it('does not admit an unversioned JSON object', async () => {
    writeJson('output/result.json', { artifact: 'generic.summary', records: [] });
    const report = await run(unboundMultiShapeScript());
    expect(report.pass).toBe(false);
    expect(report.results[0].advisory).not.toBe(true);
  });

  it('does not admit a check that reads the artifact discriminator', async () => {
    writeJson('output/result.json', { artifact: 'generic.summary.v2', records: [] });
    const report = await run(inlineCheck({
      prelude: ["if (data.artifact !== 'generic.summary.v2') fail('unexpected format');"],
      guards: [
        "if (!data.expected_one) fail('first shape is absent');",
        "if (!data.expected_two) fail('second shape is absent');",
      ],
    }));
    expect(report.pass).toBe(false);
    expect(report.results[0].advisory).not.toBe(true);
  });

  it('does not admit computed property assertions', async () => {
    writeJson('output/result.json', { artifact: 'generic.summary.v2', records: [] });
    const report = await run(inlineCheck({
      guards: [
        "if (!data['expected_one']) fail('first shape is absent');",
        "if (!data['expected_two']) fail('second shape is absent');",
      ],
    }));
    expect(report.pass).toBe(false);
    expect(report.results[0].advisory).not.toBe(true);
  });

  it('does not admit malformed JSON', async () => {
    write('output/result.json', '{ not valid JSON\n');
    const report = await run(unboundMultiShapeScript());
    expect(report.pass).toBe(false);
    expect(report.results[0].advisory).not.toBe(true);
    expect(report.results[0].evidence).toMatchObject({ code: 1 });
  });

  it('does not admit a literal path that resolves outside the project', async () => {
    writeFileSync(join(sandboxRoot, 'outside.json'), JSON.stringify({
      artifact: 'generic.summary.v2',
    }), 'utf8');
    const report = await run(unboundMultiShapeScript('../outside.json'));
    expect(report.pass).toBe(false);
    expect(report.results[0].advisory).not.toBe(true);
  });

  it('does not admit value-only failures on fields that exist', async () => {
    writeJson('output/result.json', {
      artifact: 'generic.summary.v2',
      enabled: false,
      count: 0,
    });
    const report = await run(inlineCheck({
      guards: [
        "if (data.enabled !== true) fail('feature is disabled');",
        "if (data.count < 1) fail('count is too small');",
      ],
    }));
    expect(report.pass).toBe(false);
    expect(report.results[0].advisory).not.toBe(true);
  });
});
