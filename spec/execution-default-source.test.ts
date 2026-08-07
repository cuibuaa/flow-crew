import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import { resetConfigCache } from '../src/config.js';
import { readExecutionDefaults } from '../src/dashboard.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

/**
 * The ship workflow deliberately carries no timeout or iteration override.
 * Both the scheduler and dashboard must therefore consume the same project
 * defaults, including after an operator edits that single source of truth.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
let fixtureRoot: string;
let projectDir: string;
let previousFcHome: string;
let configRevision = 0;

function writeDefaults(timeoutMs: number, maxIterations: number): void {
  const path = join(projectDir, 'config', 'defaults.yaml');
  writeFileSync(path, [
    `default_timeout_ms: ${timeoutMs}`,
    `default_max_iterations: ${maxIterations}`,
    'adapter: mock',
    '',
  ].join('\n'), 'utf-8');
  configRevision++;
  const timestamp = new Date(1_900_000_000_000 + configRevision * 1_000);
  utimesSync(path, timestamp, timestamp);
}

function writeAgent(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'coder.yaml'), [
    'name: coder',
    'description: defaults fixture',
    'model: default',
    'reasoning_effort: default',
    'tools: []',
    'prompt: defaults fixture',
    '',
  ].join('\n'), 'utf-8');
  return agentsDir;
}

async function launchWithoutOverrides(): Promise<{ timeoutMs: number; maxIterations: number }> {
  const yaml = [
    'name: defaults-fixture',
    'stages:',
    '  - id: work',
    '    role: coder',
    '    scope: []',
    '',
  ].join('\n');
  const workflow = WorkflowConfigSchema.parse(parseYaml(yaml));
  let observedTimeout = -1;
  const adapter: Adapter = {
    async run(_prompt: string, _role: AgentConfig, opts: RunOpts): Promise<RunResult> {
      if (opts.stageId === 'work') observedTimeout = opts.timeout_ms;
      return {
        output: opts.stageId === '_summary' ? '## What was done\n- checked defaults' : 'done',
        exitCode: 0,
        duration_ms: 1,
        writes: [],
        writeAttribution: 'structured',
      };
    },
  };
  const state = await runWorkflow(
    workflow,
    yaml,
    projectDir,
    adapter,
    new Map(),
    undefined,
    writeAgent(),
    undefined,
    '# Defaults fixture',
    true,
    false,
  );
  expect(state.status).toBe('complete');
  return { timeoutMs: observedTimeout, maxIterations: state.maxIterations ?? -1 };
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-default-source-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(join(projectDir, 'config'), { recursive: true });
  previousFcHome = fcGlobalDir();
  setFcGlobalDir(join(fixtureRoot, 'state'));
  configRevision = 0;
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  setFcGlobalDir(previousFcHome);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('project execution defaults are the only implicit source', () => {
  it('keeps both overrides out of the ship command and names the configured values', () => {
    const skill = readFileSync(join(repositoryRoot, 'skills', 'ship.md'), 'utf-8');
    expect(skill).not.toContain('--timeout');
    expect(skill).not.toContain('--max-iterations');
    expect(skill).toContain('`default_timeout_ms` (currently 60 minutes)');
    expect(skill).toContain('`default_max_iterations` (currently 5)');
  });

  it('changes the real stage timeout, run budget, and dashboard view by editing only defaults.yaml', async () => {
    writeDefaults(1_234_567, 2);
    expect(readExecutionDefaults(join(projectDir, 'config'))).toMatchObject({
      timeoutMs: 1_234_567,
      maxIterations: 2,
    });
    expect(await launchWithoutOverrides()).toEqual({ timeoutMs: 1_234_567, maxIterations: 2 });

    writeDefaults(7_654_321, 4);
    expect(readExecutionDefaults(join(projectDir, 'config'))).toMatchObject({
      timeoutMs: 7_654_321,
      maxIterations: 4,
    });
    expect(await launchWithoutOverrides()).toEqual({ timeoutMs: 7_654_321, maxIterations: 4 });
  });

  it('reports malformed configuration on every read instead of using a five-minute fallback or stale cache', () => {
    writeDefaults(1_234_567, 2);
    expect(readExecutionDefaults(join(projectDir, 'config')).timeoutMs).toBe(1_234_567);

    const path = join(projectDir, 'config', 'defaults.yaml');
    writeFileSync(path, 'default_timeout_ms: [broken\n', 'utf-8');
    const timestamp = new Date(1_900_000_100_000);
    utimesSync(path, timestamp, timestamp);

    expect(() => readExecutionDefaults(join(projectDir, 'config'))).toThrow();
    expect(() => readExecutionDefaults(join(projectDir, 'config'))).toThrow();
  });
});
