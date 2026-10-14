import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-git-failure-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const role: AgentConfig = { name: 'coder', description: 'Fixture author', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Author.' };

describe('race candidates with unreadable Git changes', () => {
  it.each(['failed run', 'complete run'].flatMap(phase => ['lock', 'index'].map(fault => ({ phase, fault }))))(
    'keeps the healthy winner after a $phase leaves an unreadable $fault', async ({ phase, fault }) => {
      const project = join(directory, 'project'); mkdirSync(project);
      writeFileSync(join(project, 'answer.txt'), 'old answer\n');
      const git = (...args: string[]) => isolatedProjectCommand('git', args, project, directory);
      git('init', '-q'); git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
      const parentHead = git('rev-parse', 'HEAD'), parentIndex = readFileSync(join(project, '.git/index'));
      const work = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['answer.txt'], race: true });
      const review = parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [] });
      const parent = reserveRun(project);
      initializeReservedRun(project, parent.runId, 'fixture', 'name: fixture\nstages: []\n', ['work', 'review']);
      writeFileSync(join(parent.runDirPath, 'task_brief.md'), '# Goal\nDeliver the new answer.\n');
      const candidates: string[] = [];
      workflowMock.mockImplementation(async (workflow: WorkflowConfig, _yaml: string, target: string, _adapter: Adapter,
        _agents: unknown, _skills: unknown, _agentsDir: unknown, id: string, _brief: string, _approve: unknown,
        _campaign: unknown, _inherit: unknown, _admission: unknown, _clock: unknown) => {
        const label = basename(target);
        initializeReservedRun(target, id, workflow.name, stringify(workflow), ['work', 'review']);
        writeFileSync(join(target, 'answer.txt'), 'new answer\n');
        writeStageOutput(target, id, 'work', JSON.stringify({ status: 'delivered', summary: 'Delivered answer.', checks: [], caveats: [] }));
        candidates.push(label);
        if (label === 'a') {
          writeFileSync(join(target, '.git', fault === 'lock' ? 'index.lock' : 'index'), 'Interrupted Git operation\n');
        }
        return updateRunState(target, id, state => {
          state.status = label === 'a' && phase === 'failed run' ? 'incomplete' : 'complete';
          state.stages.work = { status: 'complete', retries: 0, attempts: [{ index: 1, startedAt: new Date().toISOString(), status: 'complete', tokens_in: 3, tokens_out: 7, tokenUsage: 'known' }] };
        });
      });
      const adapter: Adapter = { async run() { throw new Error('Unexpected comparison invocation'); } };
      const result = await stageRaceAdapter({ stage: work, stages: [work, review], adapter, agentsDir: directory,
        projectDir: project, runDirPath: parent.runDirPath, state: readRunState(project, parent.runId) }).run('Deliver answer.', role,
      { timeout_ms: 30000, workDir: project, runDir: parent.runDirPath, stageId: 'work', attemptIndex: 1, attemptStartedAt: new Date().toISOString() });
      expect(result.exitCode, result.output).toBe(0);
      expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('new answer\n');
      expect(candidates).toEqual(['a', 'b']);
      const race = JSON.parse(readFileSync(join(parent.runDirPath, 'stages/work/race_1.json'), 'utf8'));
      expect(race.decision.choice).toBe('B');
      expect(race.candidates[0].patchError).toMatch(/index/);
      expect(existsSync(join(parent.runDirPath, 'stages/work/candidate_1_b.patch'))).toBe(true);
      expect(result.tokens_in).toBe(6); expect(result.tokens_out).toBe(14);
      expect(git('rev-parse', 'HEAD')).toBe(parentHead);
      expect(readFileSync(join(project, '.git/index'))).toEqual(parentIndex);
    });
});
