import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdShipSetupWithDeps } from '../src/cli-ship-setup.js';

import { inspectRealityChecks } from '../src/reality-check-preflight.js';
import { runAllChecks } from '../src/reality-gate/index.js';

import {
  fcGlobalDir,
  setFcGlobalDir,
} from '../src/store.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestCacheRoot = ['node_modules', '.vite', 'vitest'].join('/');

let sandboxRoot: string;
let isolatedStateRoot: string;
let previousStateRoot: string;

beforeEach(() => {
  sandboxRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'engine-controls-round-')));
  isolatedStateRoot = join(sandboxRoot, 'state');
  mkdirSync(isolatedStateRoot, { recursive: true });
  previousStateRoot = fcGlobalDir();
  setFcGlobalDir(isolatedStateRoot);
});

afterEach(() => {
  setFcGlobalDir(previousStateRoot);
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function inlineManifestCheck(options: {
  path?: string;
  prelude?: string[];
  guards?: string[];
} = {}): string {
  return [
    "node <<'NODE'",
    "const fs = require('fs');",
    `const dataPath = '${options.path ?? 'output/manifest.json'}';`,
    "const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
    'function fail(message) { console.error(message); process.exit(1); }',
    ...(options.prelude ?? []),
    ...(options.guards ?? [
      "if (!data.expected_one) fail('expected_one is absent');",
      "if (!data.expected_two || !Array.isArray(data.expected_two.rows)) fail('expected_two.rows is absent');",
    ]),
    'NODE',
    '',
  ].join('\n');
}

function checkMarkdown(script: string, reads?: unknown[]): string {
  return [
    '## Reality checks',
    '```yaml',
    'checks:',
    '  - name: manifest fields exist',
    '    type: exec-script-exit-zero',
    `    reads: ${JSON.stringify(reads ?? [])}`,
    '    params:',
    '      script: |',
    ...script.trimEnd().split('\n').map((line) => `        ${line}`),
    '```',
    '',
  ].join('\n');
}

describe('reality shape advice and test population evidence', () => {
  it('advises only for unbound incompatible versioned shapes', { timeout: 30_000 }, async () => {
    const brief = '# Admission replay\nThe worker may inspect the already-present versioned manifest before completing.\n';
    const variants: Array<{
      id: string;
      artifact?: unknown;
      artifactBytes?: string;
      outsideArtifact?: unknown;
      script: string;
      expectedPreflight: 'admitted' | 'admitted_with_advisories';
      expectedTerminal: 'advisory' | 'hard';
    }> = [
      {
        id: 'unbound-versioned-multi-shape',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck(),
        expectedPreflight: 'admitted_with_advisories',
        expectedTerminal: 'advisory',
      },
      {
        id: 'discriminator-bound-multi-shape',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({
          prelude: ["if (data.artifact !== 'generic.summary.v2') fail('unexpected format');"],
        }),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'single-incompatible-guard',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({ guards: ["if (!data.expected_one) fail('expected_one is absent');"] }),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'unversioned-artifact',
        artifact: { artifact: 'generic.summary', records: [] },
        script: inlineManifestCheck(),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'computed-property-access',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({
          guards: [
            "if (!data['expected_one']) fail('expected_one is absent');",
            "if (!data['expected_two']) fail('expected_two is absent');",
          ],
        }),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'malformed-json',
        artifactBytes: '{ malformed json\n',
        script: inlineManifestCheck(),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'escaping-artifact-path',
        outsideArtifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({ path: '../outside.json' }),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'absent-artifact',
        script: inlineManifestCheck(),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
    ];
    for (const variant of variants) {
      const fixtureRoot = join(sandboxRoot, 'problem-1', variant.id);
      const projectDir = join(fixtureRoot, 'project');
      mkdirSync(projectDir, { recursive: true });
      if (variant.artifact !== undefined) writeJson(join(projectDir, 'output', 'manifest.json'), variant.artifact);
      if (variant.artifactBytes !== undefined) write(join(projectDir, 'output', 'manifest.json'), variant.artifactBytes);
      if (variant.outsideArtifact !== undefined) writeJson(join(fixtureRoot, 'outside.json'), variant.outsideArtifact);
      const preflight = inspectRealityChecks(brief, checkMarkdown(variant.script), { projectDir });
      const disposition = preflight.advisoryFindings.length > 0
        ? 'admitted_with_advisories'
        : 'admitted';
      mkdirSync(join(fixtureRoot, 'task'), { recursive: true });
      const terminal = await runAllChecks(
        [{ reads: [], name: 'manifest fields exist', type: 'exec-script-exit-zero', params: { script: variant.script } }],
        { projectDir, taskDir: join(fixtureRoot, 'task') },
      );
      const result = terminal.results[0];
      expect(disposition).toBe(variant.expectedPreflight);
      expect(result.advisory === true ? 'advisory' : 'hard').toBe(variant.expectedTerminal);
    }});

  it('keeps opaque Make output unverified without inventing test identities', async () => {
    const sourceDir = join(sandboxRoot, 'problem-5', 'source');
    const targetDir = join(sandboxRoot, 'problem-5', 'target');
    const stateDir = join(sandboxRoot, 'problem-5', 'state');
    write(join(sourceDir, 'Makefile'), [
      '.PHONY: test',
      'test:',
      "\t@printf '1 passed\\n'",
      '',
    ].join('\n'));
    const briefPath = join(sourceDir, 'brief.md');
    write(briefPath, '# Population replay\nRun the configured test population.\n');
    class CaptureWriter {
      value = '';
      writer = { write: (chunk: string) => { this.value += chunk; } };
    }
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    const runnerCalls: Array<{ side: string; display: string; role: string }> = [];
    const runner = vi.fn<ValidationCommandRunner>((request) => {
      runnerCalls.push({
        side: request.cwd === sourceDir ? 'source' : 'target',
        display: request.display,
        role: request.role,
      });
      return { exitCode: 0, stdout: '1 passed\n', stderr: '', durationMs: 1 };
    });
    const code = await cmdShipSetupWithDeps([
      'ship-setup', '--brief', briefPath, '--project', sourceDir,
      '--target', targetDir, '--base', 'fixture-base', '--branch', 'fixture-branch',
    ], {
      createWorktree: (request) => {
        mkdirSync(request.targetDir, { recursive: true });
        copyFileSync(join(sourceDir, 'Makefile'), join(request.targetDir, 'Makefile'));
        return { exitCode: 0 };
      },
      runValidationCommand: runner,
      globalDir: () => stateDir,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });
    const recordNames = readdirSync(join(stateDir, 'ship-setups'));
    expect(code).toBe(0);
    expect(stderr.value).toBe('');
    expect(recordNames).toHaveLength(1);
    const record = readJson(join(stateDir, 'ship-setups', recordNames[0]));
    expect(record).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'unverified',
        missingFromTarget: [],
        extraInTarget: [],
      },
    });
    expect(record.testPopulation.reason).toContain('Configured test runner "make test"');
    expect(record.testPopulation.reason).toContain('could not be unwrapped safely from Make');
    expect(record.testPopulation.reason).toContain('source tests are not executed for population evidence');
    expect(runnerCalls).toEqual([
      { side: 'target', role: 'test', display: 'make test' },
      { side: 'source', role: 'test', display: 'make -n test' },
      { side: 'target', role: 'test', display: 'make -n test' },
    ]);
  });
});
