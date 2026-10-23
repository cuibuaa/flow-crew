import './test-support/policy-runtime.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { WorkflowConfigSchema } from '../src/scheduler.js';
import { createRun } from './test-support/create-run.js';
import { beginStageAttempt, completeStageAttempt, fcGlobalDir, readRunState, setFcGlobalDir, updateRunState } from '../src/store.js';

const repositoryRoot = join(import.meta.dirname, '..');
const fixtures: string[] = [];

function fixture(): { root: string; home: string; fcHome: string; temp: string } {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-p10-cli-'));
  fixtures.push(root);
  const home = join(root, 'home');
  const fcHome = join(root, 'state');
  const temp = join(root, 'tmp');
  for (const path of [home, fcHome, temp]) mkdirSync(path, { recursive: true });
  return { root, home, fcHome, temp };
}

function rehearse(args: string[], env: { home: string; fcHome: string; temp: string }) {
  return spawnSync(
    process.execPath,
    [join(repositoryRoot, 'dist', 'cli.js'), 'rehearse', ...args],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: env.home,
        FC_HOME: env.fcHome,
        TMPDIR: env.temp,
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function diagnosticPath(stdout: string): string {
  const match = stdout.match(/^Engine diagnostics \(not part of the verdict\): (.+)$/m);
  if (!match) throw new Error(`Rehearsal output did not name its diagnostic log:\n${stdout}`);
  return match[1].trim();
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each(['missing', 'invalid'])('continues an admitted run when the current workflow is %s', condition => {
  const isolated = fixture();
  const project = join(isolated.root, 'project'); mkdirSync(project);
  const previousStore = fcGlobalDir();
  setFcGlobalDir(isolated.fcHome);
  try {
    const brief = '# Goal\nContinue the admitted work.\n\n# Acceptance criteria\n1. Both stages complete.\n';
    const admission = createBriefAdmission(inspectBrief(brief), {
      kind: 'explicit', source: 'cli_current_input_flag', at: new Date().toISOString(),
    });
    const criteria = extractBriefCriteria(brief).criteria;
    const workflow = WorkflowConfigSchema.parse({ name: 'admitted', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [...['done', 'work'].map((id, index) => ({ id, role: 'coder', depends_on: index ? ['done'] : [], scope: [],
        ...(index ? { is_gate: true, criterion_refs: criteria.map(criterion => criterion.id) } : {}),
        prompt_template: 'Complete the fixture stage.', artifact_contract: { version: 1,
          produces: index ? [{ id: 'verdict', root: 'run', path: 'verdict_work.json', kind: 'file' }] : [], reads: [] } })),
        { id: 'repair', role: 'coder', depends_on: ['work'], retry_to: ['work'], scope: [],
          prompt_template: 'Repair the fixture work.', artifact_contract: { version: 1, produces: [], reads: [] } }] });
    const created = createRun(project, workflow.name, stringify(workflow), workflow.stages.map(stage => stage.id));
    beginStageAttempt(project, created.runId, 'done', 0);
    completeStageAttempt(project, created.runId, 'done', 0, { exitCode: 0, duration_ms: 1 });
    beginStageAttempt(project, created.runId, 'work', 0);
    completeStageAttempt(project, created.runId, 'work', 0, { exitCode: 1, duration_ms: 1, error: 'Fixture failure' });
    updateRunState(project, created.runId, state => {
      state.status = 'failed'; state.currentIteration = 1; state.maxIterations = 1; state.maxRetries = 0;
      state.taskDescription = brief; state.briefAdmission = admission; state.completedAt = new Date().toISOString();
    });
    const before = readRunState(project, created.runId);
    const roles = join(project, 'config/agents'); mkdirSync(roles, { recursive: true });
    writeFileSync(join(roles, 'coder.yaml'), 'name: coder\ndescription: fixture\nmodel: default\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
    const workflowDir = join(project, 'config/workflows'); mkdirSync(workflowDir, { recursive: true });
    if (condition === 'invalid') writeFileSync(join(workflowDir, 'changed.yaml'), 'stages: [');
    const mockFixtures = join(isolated.root, 'mock'); mkdirSync(mockFixtures);
    writeFileSync(join(mockFixtures, 'work.json'), JSON.stringify({ output_text: JSON.stringify({ pass: true, reason: 'Both stages verified.',
      criteria: Object.fromEntries(criteria.map(criterion => [criterion.id, { status: 'pass', evidence: 'Fixture stages completed.' }])),
      audit_findings: { version: 1, findings: [] },
    }) }));

    const result = spawnSync(process.execPath, [join(repositoryRoot, 'dist/cli.js'), 'quick',
      '--project', project, '--existing-run-id', created.runId, '--workflow', 'changed', '--adapter', 'mock', '--no-campaign'], {
      cwd: project, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: isolated.home, FC_HOME: isolated.fcHome, TMPDIR: isolated.temp, MOCK_FIXTURE_DIR: mockFixtures },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const after = readRunState(project, created.runId);
    expect(after.status).toBe('complete');
    expect(after.stages.done).toEqual(before.stages.done);
    expect(after.stages.work.attempts?.map(attempt => attempt.exitCode)).toEqual([1, 0]);
    expect(after).toMatchObject({ currentIteration: 1, maxIterations: 1, maxRetries: 0, startedAt: before.startedAt, briefAdmission: admission });
  } finally { setFcGlobalDir(previousStore); }
}, 35_000);

describe('rehearsal language and diagnostic integrity', () => {
  it('prints the complete hello-research report in English and retains pino diagnostics outside stdout', { timeout: 70_000 }, () => {
    const isolated = fixture();
    const brief = join(isolated.root, 'hello-with-criterion.brief.md');
    writeFileSync(brief, readFileSync(join(repositoryRoot, 'examples', 'hello-research.brief.md'), 'utf-8').replace(
      '## Round contract',
      '## What the report must show\n\n1. Report the measured count and the direct command evidence.\n\n## Round contract',
    ));
    const result = rehearse([brief], isolated);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Rehearsal report');
    expect(result.stdout).toContain('Contract ready');
    expect(result.stdout).toContain('floor(stages≥1)');
    expect(result.stdout).not.toContain('≥-');
    expect(result.stdout).not.toMatch(/[\u3400-\u9fff]/u);
    expect(result.stdout).not.toMatch(/^\{"level":\d+/m);

    const path = diagnosticPath(result.stdout);
    expect(path.startsWith(isolated.temp)).toBe(true);
    expect(existsSync(path)).toBe(true);
    const diagnostics = readFileSync(path, 'utf-8');
    expect(diagnostics).toMatch(/^\{"level":\d+/m);
    expect(result.stderr).not.toMatch(/^\{"level":\d+/m);
  });


});

describe('doctor tells port occupancy apart from your own dashboard', () => {
  // The probe cannot be exercised here — `spec/` may not open sockets or spawn servers
  // (see spec/purity.ts). Five branches were measured by hand against real listeners: this
  // install's dashboard, a non-FlowCrew server, a 404, a FlowCrew dashboard serving another
  // directory, and a pid whose cwd is unreadable. What is guarded here is that the
  // distinction still exists in the source, because the failure it replaced was a single
  // unconditional "FlowCrew server is running" for any response at all.
  const source = readFileSync(join(repositoryRoot, 'src', 'cli.ts'), 'utf-8');

  it('rejects a non-2xx response instead of counting it as a running server', () => {
    expect(source).toContain('res.statusCode < 200 || res.statusCode >= 300');
  });

  it('requires a FlowCrew-shaped payload before claiming a dashboard answered', () => {
    expect(source).toContain("does not answer as a FlowCrew dashboard");
  });

  it('names the other directory when the port belongs to a different install', () => {
    expect(source).toContain('for a different install');
  });

  it('says the install is unconfirmed rather than claiming it is this one', () => {
    expect(source).toContain('could not be confirmed');
  });

  it('no longer claims a bare "server is running" for whatever holds the port', () => {
    expect(source).not.toContain("message: 'FlowCrew server is running'");
  });
});

// Help must remain safe even when its remaining arguments name a writable run.
describe('command help before side effects', () => {
  it.each([
    ['start', '--help'],
    ['daemon', 'hold', '--timeout-ms', '0', '--help'],
    ['inbox', 'approve', 'missing', '--always', '--help'],
    ['guide', '--run', '2000-01-01T00-00-00-help', 'operator text', '--help'],
  ])('prints help for %s without changing the run', (...args) => {
    const isolated = fixture();
    const run = join(isolated.fcHome, 'runs', '2000-01-01T00-00-00-help');
    mkdirSync(run, { recursive: true });
    const record = JSON.stringify({ runId: '2000-01-01T00-00-00-help', projectDir: repositoryRoot,
      status: 'running', stages: { writer: { status: 'running', retries: 0 } } });
    writeFileSync(join(run, 'run.json'), record);
    const result = spawnSync(process.execPath, [join(repositoryRoot, 'dist', 'cli.js'), ...args], {
      cwd: repositoryRoot, encoding: 'utf-8', timeout: 5000,
      env: { ...process.env, HOME: isolated.home, FC_HOME: isolated.fcHome, TMPDIR: isolated.temp },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage:');
    if (args[0] === 'daemon') {
      expect(result.stdout).toContain('daemon hold');
      expect(result.stdout).toContain('--timeout-ms');
      expect(existsSync(join(isolated.fcHome, 'deployment-hold.json'))).toBe(false);
    }
    expect(readFileSync(join(run, 'run.json'), 'utf8')).toBe(record);
    expect(existsSync(join(run, 'user_input.md'))).toBe(false);
    expect(existsSync(join(run, 'supervisor_guidance.md'))).toBe(false);
    expect(existsSync(join(run, 'approvals.jsonl'))).toBe(false);
  });
});
