import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import { fixtureResult } from './test-support/declared-dispatch.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { type WorkflowConfig } from '../src/scheduler.js';
import { runWorkflow, stationaryStageClock } from './test-support/stage-deadline.js';
import { createRun } from './test-support/create-run.js';
import {
  fcGlobalDir,
  readRunState,
  setFcGlobalDir,
} from '../src/store.js';
import * as worker from '../src/worker.js';
import { executeOrdinaryStage } from '../src/scheduler/sched_loop/ordinary-stage.js';
import { selectRunnableBatch } from '../src/scheduler/sched_admission/frontier.js';

let projectDir: string;
let stateDir: string;
let previousStateDir: string;

function seedProject(project = projectDir): string {
  mkdirSync(join(project, 'config', 'agents'), { recursive: true });
  writeFileSync(join(project, 'config', 'agents', 'coder.yaml'), [
    'name: coder',
    'description: parallel scope fixture',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: fixture',
  ].join('\n'));
  const protectedPath = join(project, 'protected.txt');
  writeFileSync(protectedPath, 'operator preimage\n');
  // Concurrency restoration reuses Git's immutable source preimage without
  // requiring rollback payloads for either read-only stage.
  execFileSync(process.execPath, ['--input-type=module', '-e', String.raw`
    import { execFileSync } from 'node:child_process';
    const git = args => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q']);
    git(['add', 'protected.txt']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'Record protected source']);
  `], { cwd: project, env: { ...process.env, HOME: stateDir, FC_HOME: stateDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  return protectedPath;
}

function role(): AgentConfig {
  return {
    name: 'coder',
    description: 'parallel scope fixture',
    model: 'default',
    reasoning_effort: 'low',
    tools: [],
    prompt: 'fixture',
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-parallel-scope-project-'));
  stateDir = mkdtempSync(join(tmpdir(), 'flowcrew-parallel-scope-state-'));
  previousStateDir = fcGlobalDir();
  setFcGlobalDir(stateDir);
});

afterEach(() => {
  setFcGlobalDir(previousStateDir);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('scheduler scope waves', () => {
  it('refuses a second scheduler for an occupied project while another project runs concurrently', async () => {
    seedProject();
    const otherProject = mkdtempSync(join(tmpdir(), 'flowcrew-concurrent-project-'));
    seedProject(otherProject);
    const stage = (scope: string[]) => ({ id: 'write', role: 'coder', scope, depends_on: [],
      prompt_template: 'write', skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [],
      artifact_contract: { version: 1 as const, produces: [], reads: [] } });
    const workflow: WorkflowConfig = { name: 'project-ownership', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [stage(['src/shared.ts'])] };
    let firstEntered!: () => void, releaseFirst!: () => void;
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });
    const held = new Promise<void>(resolve => { releaseFirst = resolve; });
    let active = 0, maxActive = 0, calls = 0;
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      calls++;
      maxActive = Math.max(maxActive, ++active);
      try {
        if (opts.workDir === projectDir) { firstEntered(); await held; }
        mkdirSync(join(opts.workDir, 'src'), { recursive: true });
        writeFileSync(join(opts.workDir, 'src/shared.ts'), 'independent project result');
        return fixtureResult({ output: 'written', exitCode: 0, duration_ms: 1,
          writes: ['src/shared.ts'], writeAttribution: 'structured' }, opts);
      } finally { active--; }
    } };
    const run = (project: string, config = workflow) => runWorkflow(config, '', project, adapter,
      new Map([['coder', role()]]));
    const first = run(projectDir);
    try {
      await entered;
      const refused = await run(projectDir, { ...workflow, stages: [stage(['src/other.ts'])] });
      expect(refused.status).toBe('failed');
      expect(refused.failureReason).toContain('Single-in-flight');
      expect(calls).toBe(1);
      const independent = await run(otherProject);
      expect(independent.status).toBe('complete');
      expect(maxActive).toBe(2);
      expect(calls).toBe(2);
      expect(readFileSync(join(otherProject, 'src/shared.ts'), 'utf8')).toBe('independent project result');
    } finally {
      releaseFirst();
      await first;
      rmSync(otherProject, { recursive: true, force: true });
    }
    expect((await first).status).toBe('complete');
  });

  for (const preloaded of [false, true]) for (const parallel of [false, true]) {
    it(`loads ${preloaded ? 'preloaded' : 'lazy'} roles for ${parallel ? 'disjoint' : 'overlapping'} stage scopes and reuses the role without topology instructions`, { timeout: 15_000 }, async () => {
      mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
      writeFileSync(join(projectDir, 'config', 'agents', 'coder.yaml'), stringify(role()));
      const stage = (id: string, scope: string[], depends_on: string[] = []) => ({
        id, role: 'coder', scope, depends_on, prompt_template: 'inspect', skills: [],
        dynamic_dispatch: false, is_gate: false, criterion_refs: [],
        artifact_contract: { version: 1 as const, produces: [], reads: [] },
      });
      const workflow: WorkflowConfig = { name: 'prompt-topology', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
        stage('left', ['src/left.ts']), stage('right', [parallel ? 'src/right.ts' : 'src/left.ts']),
        stage('later', [], ['left', 'right']),
      ] };
      const created = createRun(projectDir, workflow.name, '', workflow.stages.map(item => item.id));
      const roles = preloaded ? new Map([['coder', role()]]) : new Map<string, AgentConfig>();
      const received = new Map<string, string>();
      // Exercise the real role loader and prompt builder. Worker lifecycle and
      // project ownership have their integration case above; neither a timer
      // race nor repeated workflow settlement is needed to inspect role input.
      vi.spyOn(worker, 'runStage').mockImplementation(async (_adapter, opts) => {
        received.set(opts.stageId, opts.role.prompt);
        return { output: 'inspected', exitCode: 0, duration_ms: 1 };
      });
      const state = readRunState(projectDir, created.runId);
      const technicalRetries = new Map();
      const execute = async (item: typeof workflow.stages[number]) => executeOrdinaryStage(
        item, workflow.stages, state, projectDir, created.runId, created.runDirPath,
        { run: async () => { throw new Error('Worker stub must own adapter execution'); } },
        roles, join(projectDir, 'config', 'agents'), new Map(), technicalRetries,
        undefined, undefined, undefined, stationaryStageClock);
      let pending = workflow.stages.slice(0, 2);
      while (pending.length) {
        const { selected, deferred } = selectRunnableBatch(pending);
        await Promise.all(selected.map(execute));
        pending = deferred.map(({ stage }) => stage);
      }
      await execute(workflow.stages[2]);
      expect(received.size).toBe(3);
      for (const id of ['left', 'right']) {
        expect(received.get(id)?.includes('# Parallel execution boundary')).toBe(false);
      }
      expect(received.get('later')).not.toContain('# Parallel execution boundary');
      expect(roles.get('coder')?.prompt).not.toContain('# Parallel execution boundary');
    });
  }

});
