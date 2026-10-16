import './test-support/policy-runtime.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Adapter } from '../src/adapters/base.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { parseDispatchedStageConfig, WorkflowConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { runWorkflow } from '../src/scheduler/sched_loop/run-workflow.js';
import { stageRaceAdapter } from '../src/scheduler/sched_loop/stage-race.js';
import { fcGlobalDir, initializeReservedRun, readRunState, reserveRun, runDir, setFcGlobalDir } from '../src/store.js';

let directory: string;
let previousStore: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-artifact-links-'));
  previousStore = fcGlobalDir(); setFcGlobalDir(join(directory, 'state'));
});
afterEach(() => { setFcGlobalDir(previousStore); rmSync(directory, { recursive: true, force: true }); });
const agentsDir = join(import.meta.dirname, '../config/agents');
const brief = '# Deliver an answer\n\n## Acceptance criteria\n1. answer.txt contains the current generated answer.\n';
const criterion = extractBriefCriteria(brief).criteria[0].id;
type Case = 'project-file' | 'project-directory' | 'internal-toolchain' | 'dependency';

function packageFiles(path: string, answer: string) {
  mkdirSync(join(path, '.bin'), { recursive: true }); mkdirSync(join(path, 'compiler/bin'), { recursive: true });
  writeFileSync(join(path, 'compiler/config.json'), JSON.stringify({ answer }));
  writeFileSync(join(path, 'compiler/bin/read.cjs'), "const fs=require('node:fs'),path=require('node:path');process.stdout.write(JSON.parse(fs.readFileSync(path.join(__dirname,'../config.json'),'utf8')).answer);\n");
  symlinkSync(join(path, 'compiler/bin/read.cjs'), join(path, '.bin/read'));
  symlinkSync('../compiler/bin/read.cjs', join(path, '.bin/relative'));
  symlinkSync('.', join(path, 'cycle'));
}

function fixture(kind: Case) {
  const project = join(directory, 'project'); mkdirSync(project); mkdirSync(join(project, 'config'));
  setEngineDefaults({ stage_technical_retries: 0, gate_retry_loops: 0 });
  writeFileSync(join(project, 'answer.txt'), 'old answer\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Input']])
    isolatedProjectCommand('git', args, project, directory);
  const build = { id: 'build', root: 'run' as const, path: 'stages/work/build', kind: 'directory' as const };
  const prepared = { id: 'package', root: 'run' as const, path: 'stages/prepare/package', kind: 'directory' as const };
  const author = parseDispatchedStageConfig({ id: 'work', role: 'coder', depends_on: kind === 'dependency' ? ['prepare'] : [],
    scope: ['answer.txt'], race: true, criterion_refs: [criterion], artifact_contract: { version: 1,
      produces: kind === 'dependency' ? [] : [build], reads: kind === 'dependency' ? [{ ...prepared, source: { kind: 'stage', stage: 'prepare', artifact: 'package' } }] : [], replays: [] } });
  const gate = parseDispatchedStageConfig({ id: 'review', role: 'qa', depends_on: ['work'], is_gate: true, scope: [], criterion_refs: [criterion] });
  const repair = parseDispatchedStageConfig({ id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['answer.txt'] });
  const workflow = WorkflowConfigSchema.parse({ name: 'artifact_links', defaults: { max_iterations: 1, max_retries: 0 }, stages: [
    ...(kind === 'dependency' ? [parseDispatchedStageConfig({ id: 'prepare', role: 'coder', scope: [],
      artifact_contract: { version: 1, produces: [prepared], reads: [], replays: [] } })] : []), author, gate, repair,
    parseDispatchedStageConfig({ id: 'report', role: 'coder', depends_on: ['review'], scope: [], artifact_contract: { version: 1, produces: [],
      reads: kind === 'dependency' ? [] : [{ ...build, source: { kind: 'stage', stage: 'work', artifact: 'build' } }], replays: [] } }),
  ] });
  let generation = 1;
  const answer = () => generation === 1 ? 'first answer\n' : 'second answer\n';
  const inputCopies: Array<{ root: string; script: string }> = [];
  const delivered = (summary: string) => ({ output: JSON.stringify({ status: 'delivered', summary, checks: [], caveats: [] }), exitCode: 0, duration_ms: 0 });
  const adapter: Adapter = { async run(_prompt, role, opts) {
    if (opts.stageId === '_summary') return { output: 'Summary.', exitCode: 0, duration_ms: 0 };
    if (opts.stageId === 'prepare') {
      packageFiles(join(opts.runDir, prepared.path), answer());
      return { ...delivered('Prepared package.'), writes: [`run:${prepared.path}`], writeAttribution: 'structured' };
    }
    if (opts.stageId === 'work') {
      if (kind === 'dependency') {
        const root = join(opts.runDir, prepared.path), script = realpathSync(join(root, '.bin/read'));
        inputCopies.push({ root, script });
        writeFileSync(join(opts.workDir, 'answer.txt'), isolatedProjectCommand(process.execPath, [join(root, '.bin/read')], opts.workDir, directory));
      } else writeFileSync(join(opts.workDir, 'answer.txt'), answer());
      if (kind !== 'dependency') {
        const path = join(opts.runDir, build.path); mkdirSync(path, { recursive: true });
        if (kind === 'project-file') symlinkSync(join(opts.workDir, 'answer.txt'), join(path, 'alias'));
        else if (kind === 'project-directory') symlinkSync(opts.workDir, join(path, 'project'));
        else packageFiles(path, answer());
        if (generation === 1) writeFileSync(join(path, 'first-only.txt'), 'First snapshot only.\n');
      }
      return { ...delivered('Delivered answer and artifact.'), writes: ['answer.txt', ...(kind === 'dependency' ? [] : [`run:${build.path}`])], writeAttribution: 'structured' };
    }
    if (opts.stageId === 'report') {
      const path = join(opts.runDir, build.path);
      const value = kind === 'dependency' ? readFileSync(join(opts.workDir, 'answer.txt'), 'utf8')
        : kind === 'project-file' ? readFileSync(join(path, 'alias'), 'utf8')
          : kind === 'project-directory' ? readFileSync(join(path, 'project/answer.txt'), 'utf8')
            : isolatedProjectCommand(process.execPath, [join(path, '.bin/read')], opts.workDir, directory);
      return delivered(`Read published artifact: ${value}`);
    }
    const pass = readFileSync(join(opts.workDir, 'answer.txt'), 'utf8') === answer();
    return { output: JSON.stringify({ pass, reason: 'Inspected answer.', criteria: { [criterion]: { status: pass ? 'pass' : 'fail', evidence: 'The generated answer matches.' } },
      audit_findings: { version: 1, findings: [] } }), exitCode: 0, duration_ms: 0 };
  } };
  return { project, build, author, gate, repair, workflow, adapter, inputCopies, next: () => { generation++; } };
}

describe('race run-artifact snapshots', () => {
  it.each(['project-file', 'project-directory', 'internal-toolchain'] as const)('publishes a self-contained %s artifact for a later parent stage', async kind => {
    const { project, build, workflow, adapter } = fixture(kind);
    const state = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, agentsDir, undefined, brief, false, undefined, false);
    expect(state.status, state.failureReason).toBe('complete');
    const root = join(runDir(project, state.runId), build.path);
    const alias = join(root, kind === 'project-file' ? 'alias' : kind === 'project-directory' ? 'project/answer.txt' : '.bin/read');
    expect(realpathSync(alias).startsWith(`${root}/`)).toBe(true);
    if (kind === 'internal-toolchain') {
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(root, 'cycle')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(root, 'cycle/compiler/config.json'), 'utf8')).toContain('first answer');
    }
  });

  it('freezes upstream run-directory inputs and their package aliases inside each child run', async () => {
    const { project, workflow, adapter, inputCopies } = fixture('dependency');
    const state = await runWorkflow(workflow, stringify(workflow), project, adapter, new Map(), undefined, agentsDir, undefined, brief, false, undefined, false);
    expect(state.status, state.failureReason).toBe('complete');
    expect(inputCopies).toHaveLength(1);
    for (const input of inputCopies) expect(input.script.startsWith(`${input.root}/`)).toBe(true);
  });

  it('replaces an earlier published directory snapshot including its aliases and removed files', async () => {
    const { project, build, author, gate, repair, workflow, adapter, next } = fixture('internal-toolchain');
    const parent = reserveRun(project);
    initializeReservedRun(project, parent.runId, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    writeFileSync(join(parent.runDirPath, 'task_brief.md'), brief);
    const race = stageRaceAdapter({ stage: author, stages: [author, gate, repair], adapter, agentsDir,
      projectDir: project, runDirPath: parent.runDirPath, state: readRunState(project, parent.runId), defaults: workflow.defaults });
    const role = { name: 'coder', description: 'Fixture author', model: 'default', reasoning_effort: 'default', tools: [], prompt: 'Author.' };
    const root = join(parent.runDirPath, build.path);
    for (const attemptIndex of [1, 2]) {
      const result = await race.run('Deliver answer.', role, { timeout_ms: 30000, workDir: project, runDir: parent.runDirPath, stageId: 'work', attemptIndex });
      expect(result.exitCode, result.output).toBe(0);
      expect(isolatedProjectCommand(process.execPath, [join(root, '.bin/read')], project, directory)).toBe(attemptIndex === 1 ? 'first answer\n' : 'second answer\n');
      expect(lstatSync(join(root, '.bin/read')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(root, 'first-only.txt'))).toBe(attemptIndex === 1);
      next();
    }
  });
});
