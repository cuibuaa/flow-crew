import './test-support/policy-runtime.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Adapter, AgentConfig, RunOpts } from '../src/adapters/base.js';
import { engineConfigDir, loadEngineDefaults } from '../src/config.js';

import { applyBasePrompt, loadBasePrompt, runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { parseAgent } from '../src/scheduler/sched_admission/configuration.js';
import { cmdPlanCheck } from '../src/plan-interface.js';
import { fcGlobalDir, readStageStatus, setFcGlobalDir } from '../src/store.js';

let fixtureRoot: string;
let projectDir: string;
let previousFcHome: string;
const engineRaw = parseYaml(readFileSync(join(engineConfigDir, 'defaults.yaml'), 'utf8'));
const engineCoder = applyBasePrompt(
  parseAgent(parseYaml(readFileSync(join(engineConfigDir, 'agents', 'coder.yaml'), 'utf8'))),
  loadBasePrompt(join(engineConfigDir, 'agents')),
);

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-default-source-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir);
  previousFcHome = fcGlobalDir();
  setFcGlobalDir(join(fixtureRoot, 'state'));
});

afterEach(() => {
  vi.restoreAllMocks();
  setFcGlobalDir(previousFcHome);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

async function launch(): Promise<{ timeoutMs: number; maxIterations: number; role?: AgentConfig }> {
  const yaml = 'name: defaults-fixture\nstages:\n  - id: work\n    role: coder\n    scope: []\n    artifact_contract: {version: 1, produces: [], reads: []}\n';
  const workflow = WorkflowConfigSchema.parse(parseYaml(yaml));
  const observed: { timeoutMs: number; maxIterations: number; role?: AgentConfig } = { timeoutMs: -1, maxIterations: -1 };
  const adapter: Adapter = {
    async run(_prompt: string, role: AgentConfig, opts: RunOpts) {
      if (opts.stageId === 'work') { observed.timeoutMs = readStageStatus(projectDir, basename(opts.runDir), opts.stageId).timeout!.budgetMs;
        expect(opts.timeout_ms).toBeGreaterThan(0); expect(opts.timeout_ms).toBeLessThanOrEqual(observed.timeoutMs); observed.role = role; }
      return fixtureResult({ output: 'done', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
    },
  };
  const state = await runWorkflow(workflow, yaml, projectDir, adapter, new Map(), undefined, undefined, undefined, '# Defaults fixture', true);
  expect(state.status).toBe('complete');
  observed.maxIterations = state.maxIterations ?? -1;
  return observed;
}

function expectEngineValues(observed: Awaited<ReturnType<typeof launch>>): void {
  expect(observed).toMatchObject({
    timeoutMs: engineRaw.default_timeout_ms,
    maxIterations: engineRaw.max_iterations,
    role: { model: engineCoder.model, reasoning_effort: engineCoder.reasoning_effort },
  });
  expect(observed.role?.prompt).toContain(engineCoder.prompt);
  expect(loadEngineDefaults()).toEqual(engineRaw);
  expect(loadEngineDefaults()).toMatchObject({ model: engineRaw.model, reasoning_effort: engineRaw.reasoning_effort, adapter: engineRaw.adapter });
}

describe('engine configuration owns execution defaults', () => {
  it('ignores a project timeout, retired model, coder prompt and paths indirection', async () => {
    const configDir = join(projectDir, 'config');
    mkdirSync(join(configDir, 'agents'), { recursive: true });
    mkdirSync(join(configDir, 'workflows'));
    const content = JSON.stringify({ ...engineRaw, default_timeout_ms: 3600000, max_iterations: 1, model: 'retired-model', reasoning_effort: 'low', paths: { agents: 'config/agents', workflows: 'config/workflows' } });
    writeFileSync(join(configDir, 'defaults.yaml'), content);
    writeFileSync(join(configDir, 'agents', 'coder.yaml'), 'name: coder\nprompt: stale project coder\nmodel: retired-model\nreasoning_effort: low\n');
    writeFileSync(join(configDir, 'workflows', 'default.yaml'), 'broken: [project workflow\n');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    expectEngineValues(await launch());
    expect(readFileSync(join(configDir, 'defaults.yaml'), 'utf8')).toBe(content);

    const briefPath = join(projectDir, 'brief.md');
    const planPath = join(projectDir, 'dispatch.yaml');
    writeFileSync(briefPath, '# Check the plan\n');
    writeFileSync(planPath, 'stages:\n  - id: work\n    role: coder\n    scope: []\n    artifact_contract: {version: 1, produces: [], reads: []}\n');
    expect(await cmdPlanCheck(['plan-check', '--project', projectDir, '--brief', briefPath, planPath])).toBe(0);
  });

  it('keeps packaged behavior unchanged for a project with no configuration', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    expectEngineValues(await launch());
    expect(existsSync(join(projectDir, 'config'))).toBe(false);
  });

  it('keeps implicit timeout and iteration bindings in the engine docs', () => {
    const root = join(engineConfigDir, '..');
    const skill = readFileSync(join(root, 'skills', 'ship.md'), 'utf8');
    expect(skill).not.toContain('--timeout');
    expect(skill).not.toContain('--max-iterations');
    const configuration = readFileSync(join(root, 'guide', 'configuration.md'), 'utf8');
    for (const key of ['default_timeout_ms', 'max_iterations']) {
      expect(skill).toContain('`' + key + '`');
      const row = configuration.split('\n').find(line => line.startsWith('| `' + key + '` |'));
      expect(Number(row?.split('|')[2].trim()), key).toBe(engineRaw[key]);
    }
  });
});
