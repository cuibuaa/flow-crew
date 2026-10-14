import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { parseDispatchedStageConfig, type WorkflowConfig } from '../src/scheduler/sched_admission/configuration.js';
import { stageRaceAdapter } from '../src/scheduler/sched_loop/stage-race.js';
import { initializeReservedRun, readRunState, reserveRun, updateRunState, writeStageOutput } from '../src/store.js';

const workflowMock = vi.hoisted(() => vi.fn());
vi.mock('../src/scheduler/sched_loop/run-workflow.js', () => ({ runWorkflow: workflowMock }));
vi.mock('../src/scheduler/sched_settlement/gate-recovery.js', () => ({
  collectGateRuntimeFacts: (_stages: unknown, state: { status: string }) => ({ allPass: state.status === 'complete' }),
}));
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-duration-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const role: AgentConfig = { name: 'coder', description: 'Fixture author', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Author.' };

describe('elapsed duration of a raced stage', () => {
  it.each(['success', 'both authors fail', 'scope refusal'])('records the time spent running candidates after %s', async outcome => {
    const project = join(directory, 'project'); mkdirSync(project);
    writeFileSync(join(project, 'answer.txt'), 'old answer\n');
    const git = (...args: string[]) => isolatedProjectCommand('git', args, project, directory);
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Input');
    const work = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['answer.txt'], race: true });
    const review = parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [] });
    const parent = reserveRun(project);
    initializeReservedRun(project, parent.runId, 'fixture', 'name: fixture\nstages: []\n', ['work', 'review']);
    writeFileSync(join(parent.runDirPath, 'task_brief.md'), '# Goal\nDeliver the new answer.\n');
    let observedWait = 0;
    let candidates = 0;
    workflowMock.mockImplementation(async (workflow: WorkflowConfig, _yaml: string, target: string, _adapter: Adapter,
      _agents: unknown, _skills: unknown, _agentsDir: unknown, id: string, _brief: string, _approve: unknown,
      _campaign: unknown, _inherit: unknown, _admission: unknown, _clock: unknown) => {
      candidates++;
      initializeReservedRun(target, id, workflow.name, stringify(workflow), ['work', 'review']);
      const start = performance.now();
      await new Promise(resolve => setTimeout(resolve, 40));
      observedWait += performance.now() - start;
      writeFileSync(join(target, 'answer.txt'), 'new answer\n');
      if (outcome === 'scope refusal') writeFileSync(join(target, 'outside.txt'), 'Outside the admitted scope.\n');
      writeStageOutput(target, id, 'work', JSON.stringify({ status: 'delivered', summary: 'Delivered answer.', checks: [], caveats: [] }));
      return updateRunState(target, id, state => {
        state.status = outcome === 'both authors fail' ? 'incomplete' : 'complete';
      });
    });
    const adapter: Adapter = { async run() { throw new Error('Unexpected comparison invocation'); } };
    const result = await stageRaceAdapter({ stage: work, stages: [work, review], adapter, agentsDir: directory,
      projectDir: project, runDirPath: parent.runDirPath, state: readRunState(project, parent.runId) }).run('Deliver answer.', role,
    { timeout_ms: 30000, workDir: project, runDir: parent.runDirPath, stageId: 'work', attemptIndex: 1, attemptStartedAt: new Date().toISOString() });
    expect(result.exitCode, result.output).toBe(outcome === 'success' ? 0 : 1);
    expect(candidates).toBe(outcome === 'both authors fail' ? 2 : 1);
    expect(observedWait).toBeGreaterThanOrEqual(30 * candidates);
    expect(result.duration_ms).toBeGreaterThanOrEqual(Math.floor(observedWait));
    expect(Number.isSafeInteger(result.duration_ms)).toBe(true);
  });
});
