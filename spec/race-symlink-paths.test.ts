import './test-support/policy-runtime.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { stageRaceAdapter } from '../src/scheduler/sched_loop/stage-race.js';
import { parseDispatchedStageConfig, type WorkflowConfig } from '../src/scheduler/sched_admission/configuration.js';
import { initializeReservedRun, readRunState, reserveRun, updateRunState, writeStageOutput } from '../src/store.js';

const workflowMock = vi.hoisted(() => vi.fn());
vi.mock('../src/scheduler/sched_loop/run-workflow.js', () => ({ runWorkflow: workflowMock }));
vi.mock('../src/scheduler/sched_settlement/gate-recovery.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/scheduler/sched_settlement/gate-recovery.js')>(),
  collectGateRuntimeFacts: (_stages: unknown, state: { status: string }) => ({ allPass: state.status === 'complete' }),
}));
const role: AgentConfig = { name: 'coder', description: 'Fixture author', model: 'default', reasoning_effort: 'high', tools: ['write'], prompt: 'Author.' };
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-links-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
type LinkCase = 'relative' | 'absolute' | 'created-absolute' | 'changed-absolute' | 'cycle' | 'external' | 'external-toolchain';

async function fixture(kind: LinkCase) {
  const project = join(directory, 'project'); mkdirSync(project);
  writeFileSync(join(project, 'answer.txt'), 'old answer\n');
  writeFileSync(join(project, 'alternate.txt'), 'old answer\n');
  const outside = join(directory, 'dependency.txt'); writeFileSync(outside, 'external input\n');
  if (kind === 'relative') symlinkSync('answer.txt', join(project, 'alias.txt'));
  if (kind === 'absolute' || kind === 'changed-absolute') symlinkSync(join(project, 'answer.txt'), join(project, 'alias.txt'));
  if (kind === 'cycle') symlinkSync('.', join(project, 'cycle'));
  if (kind === 'external') symlinkSync(outside, join(project, 'dependency.txt'));
  if (kind === 'external-toolchain') {
    const toolchain = join(directory, 'toolchain');
    mkdirSync(join(toolchain, '.bin'), { recursive: true }); mkdirSync(join(toolchain, 'compiler/bin'), { recursive: true });
    writeFileSync(join(toolchain, 'compiler/config.json'), JSON.stringify({ answer: 'new answer\n' }));
    writeFileSync(join(toolchain, 'compiler/bin/build.cjs'), "const fs=require('node:fs'),path=require('node:path');const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../config.json'),'utf8'));fs.writeFileSync('answer.txt',config.answer);\n");
    symlinkSync('../compiler/bin/build.cjs', join(toolchain, '.bin/build.cjs'));
    symlinkSync(toolchain, join(project, 'toolchain'));
  }
  const git = (target: string, ...args: string[]) => isolatedProjectCommand('git', args, target, directory);
  git(project, 'init', '-q'); git(project, 'add', '.');
  git(project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Input');
  const parentHead = git(project, 'rev-parse', 'HEAD'), parentIndex = git(project, 'diff', '--cached');
  const stage = parseDispatchedStageConfig({ id: 'work', role: 'coder', scope: ['answer.txt', 'alternate.txt', 'alias.txt', 'dependency.txt', 'cycle'], race: true });
  const gate = parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [] });
  const parent = reserveRun(project); initializeReservedRun(project, parent.runId, 'fixture', 'name: fixture\nstages: []\n', ['work', 'review']);
  writeFileSync(join(parent.runDirPath, 'task_brief.md'), '# Goal\nDeliver the new answer through the existing project aliases.\n');
  const authored: string[] = [];
  workflowMock.mockImplementation(async (workflow: WorkflowConfig, _yaml: string, target: string, _adapter: Adapter,
    _agents: unknown, _skills: unknown, _agentsDir: unknown, id: string, _brief: string,
    _approve: boolean, _campaign: unknown, _inherit: boolean, _admission: unknown, _clock: unknown) => {
    initializeReservedRun(target, id, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    if (kind === 'created-absolute' || kind === 'changed-absolute') {
      rmSync(join(target, 'alias.txt'), { force: true });
      symlinkSync(join(target, kind === 'changed-absolute' ? 'alternate.txt' : 'answer.txt'), join(target, 'alias.txt'));
    }
    if (kind === 'external') {
      writeFileSync(join(target, 'dependency.txt'), 'candidate private write\n');
      expect(readFileSync(outside, 'utf8')).toBe('external input\n');
      writeFileSync(join(target, 'dependency.txt'), 'external input\n');
    }
    if (kind === 'external-toolchain') {
      expect(realpathSync(join(target, 'toolchain/.bin/build.cjs')).startsWith(`${target}/`)).toBe(true);
      isolatedProjectCommand(process.execPath, [join(target, 'toolchain/.bin/build.cjs')], target, directory);
    }
    else writeFileSync(join(target, existsSync(join(target, 'alias.txt')) ? 'alias.txt' : 'answer.txt'), 'new answer\n');
    if (kind === 'changed-absolute') writeFileSync(join(target, 'answer.txt'), 'new answer\n');
    git(target, 'add', '.');
    git(target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Candidate');
    authored.push(target);
    writeStageOutput(target, id, 'work', 'Delivered through project aliases.');
    // A gate may reset to the author's committed result: neither HEAD nor
    // the real index may ever contain links back into the parent project.
    git(target, 'reset', '--hard', 'HEAD');
    if (existsSync(join(target, 'alias.txt'))) writeFileSync(join(target, 'alias.txt'), 'new answer\n');
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('old answer\n');
    expect(readFileSync(join(project, 'alternate.txt'), 'utf8')).toBe('old answer\n');
    return updateRunState(target, id, state => {
      state.status = 'complete';
      state.stages.work = { status: 'complete', retries: 0 };
    });
  });
  const adapter: Adapter = { async run() { throw new Error('Unexpected comparison invocation'); } };
  const result = await stageRaceAdapter({ stage, stages: [stage, gate], adapter, agentsDir: join(directory, 'agents'),
    projectDir: project, runDirPath: parent.runDirPath, state: readRunState(project, parent.runId) }).run('Deliver the new answer.', role,
    { timeout_ms: 30000, workDir: project, runDir: parent.runDirPath, stageId: 'work', attemptIndex: 1 });
  expect(git(project, 'rev-parse', 'HEAD')).toBe(parentHead);
  expect(git(project, 'diff', '--cached')).toBe(parentIndex);
  return { result, project, outside, authored };
}

describe('race project symlinks', () => {
  it.each(['relative', 'absolute', 'created-absolute', 'changed-absolute'] as const)('preserves %s links through authoring, Git reset and winner integration', async kind => {
    const { result, project } = await fixture(kind);
    expect(result.exitCode, result.output).toBe(0);
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('new answer\n');
    expect(lstatSync(join(project, 'alias.txt')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(project, 'alias.txt'))).toBe(join(project, kind === 'changed-absolute' ? 'alternate.txt' : 'answer.txt'));
  });

  it('copies an internal directory cycle without recursively dereferencing it', async () => {
    const { result, project } = await fixture('cycle');
    expect(result.exitCode, result.output).toBe(0);
    expect(readFileSync(join(project, 'cycle/answer.txt'), 'utf8')).toBe('new answer\n');
  });

  it('copies external dependencies so candidate writes cannot reach their source', async () => {
    const { result, project, outside } = await fixture('external');
    expect(result.exitCode, result.output).toBe(0);
    expect(readFileSync(outside, 'utf8')).toBe('external input\n');
    expect(readFileSync(join(project, 'dependency.txt'), 'utf8')).toBe('external input\n');
  });
  it('preserves aliases inside an external toolchain so builds resolve their own package files', async () => {
    const { result, project, authored } = await fixture('external-toolchain');
    expect(result.exitCode, result.output).toBe(0);
    expect(authored).toHaveLength(1);
    expect(readFileSync(join(project, 'answer.txt'), 'utf8')).toBe('new answer\n');
    expect(lstatSync(join(project, 'toolchain')).isSymbolicLink()).toBe(true);
  });
});
