import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { stageRaceAdapter } from '../src/scheduler/sched_loop/stage-race.js';
import type { GateRuntimeFacts } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { parseDispatchedStageConfig, type StageConfig, type WorkflowConfig } from '../src/scheduler/sched_admission/configuration.js';
import { initializeReservedRun, readRunState, reserveRun, updateRunState, writeStageOutput } from '../src/store.js';

const workflowMock = vi.hoisted(() => vi.fn());
vi.mock('../src/scheduler/sched_loop/run-workflow.js', () => ({ runWorkflow: workflowMock }));
vi.mock('../src/scheduler/sched_settlement/gate-recovery.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/scheduler/sched_settlement/gate-recovery.js')>(),
  collectGateRuntimeFacts: (stages: StageConfig[], state: { status: string }): GateRuntimeFacts => {
    const verdict = { pass: state.status === 'complete', reason: 'Fixture independent gate result.' };
    const gates = stages.filter(stage => stage.is_gate);
    const rejectedGateIds = verdict.pass ? [] : gates.map(stage => stage.id);
    return { allPass: verdict.pass, failedGateIds: rejectedGateIds, rejectedGateIds, contractRefusals: [],
      evaluations: gates.map(stage => ({ id: stage.id, status: 'complete', attempts: 1,
        authoredVerdict: verdict, effectiveVerdict: verdict })) };
  },
}));
const role: AgentConfig = { name: 'coder', description: 'Fixture author', model: 'default', reasoning_effort: 'high', tools: ['write'], prompt: 'Author.' };
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-git-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** Real Git and build commands exercise the snapshot and integration boundary.
 * Gate facts are independent of repository history: committing must change neither
 * the retained patch nor the enforced write scope. */
async function fixture(outsideScope = false) {
  const project = join(directory, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'answer.txt'), 'old answer\n');
  writeFileSync(join(project, 'input.txt'), 'original input\n');
  const git = (target: string, ...args: string[]) => isolatedProjectCommand('git', args, target, directory);
  git(project, 'init', '-q'); git(project, 'add', '.');
  git(project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Input');
  writeFileSync(join(project, 'input.txt'), 'staged predecessor input\n'); git(project, 'add', 'input.txt');
  writeFileSync(join(project, 'input.txt'), 'current predecessor input\n');
  const parentIndex = git(project, 'diff', '--cached');
  const stage = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['answer.txt'], race: true });
  const gate = parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [] });
  const parent = reserveRun(project); initializeReservedRun(project, parent.runId, 'fixture', 'name: fixture\nstages: []\n', ['work', 'review']);
  writeFileSync(join(parent.runDirPath, 'task_brief.md'), '# Goal\nDeliver the new answer.\n');
  workflowMock.mockImplementation(async (workflow: WorkflowConfig, _yaml: string, target: string, _adapter: Adapter,
    _agents: unknown, _skills: unknown, _agentsDir: unknown, id: string, _brief: string,
    _approve: boolean, _campaign: unknown, _inherit: boolean, _admission: unknown, _clock: unknown) => {
    initializeReservedRun(target, id, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    expect(readFileSync(join(target, 'input.txt'), 'utf8')).toBe('current predecessor input\n');
    isolatedProjectCommand(process.execPath, ['-e', "require('node:fs').writeFileSync('answer.txt', 'new answer\\n')"], target, directory);
    if (outsideScope) writeFileSync(join(target, 'input.txt'), 'unauthorized input\n');
    git(target, 'add', '.');
    git(target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Candidate build');
    writeStageOutput(target, id, 'work', 'Built and committed the answer.');
    return updateRunState(target, id, state => {
      state.status = 'complete';
      state.stages.work = { status: 'complete', retries: 0 };
    });
  });
  const adapter: Adapter = { async run() { throw new Error('Unexpected comparison invocation'); } };
  const result = await stageRaceAdapter({ stage, stages: [stage, gate], adapter, agentsDir: join(directory, 'agents'),
    projectDir: project, runDirPath: parent.runDirPath, state: readRunState(project, parent.runId) }).run('Deliver the new answer.', role,
    { timeout_ms: 30000, workDir: project, runDir: parent.runDirPath, stageId: 'work', attemptIndex: 1 });
  expect(git(project, 'diff', '--cached')).toBe(parentIndex);
  return { result, project, parent };
}

describe('race candidate Git history', () => {
  it('retains and integrates the first committed build result against the frozen stage input', async () => {
    const { result, project, parent } = await fixture();
    expect(result.exitCode, result.output).toBe(0);
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('new answer\n');
    expect(readFileSync(join(project, 'input.txt'), 'utf8')).toBe('current predecessor input\n');
    expect(result.writes).toEqual(['answer.txt']);
    expect(readFileSync(join(parent.runDirPath, 'stages/work/candidate_1_a.patch'), 'utf8')).toContain('+new answer');
    expect(existsSync(join(parent.runDirPath, 'stages/work/candidate_1_b.patch'))).toBe(false);
  });

  it('rejects committed writes outside the admitted scope before integrating any file', async () => {
    const { result, project } = await fixture(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('exceeded the admitted author scope');
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('old answer\n');
    expect(readFileSync(join(project, 'input.txt'), 'utf8')).toBe('current predecessor input\n');
  });
});
