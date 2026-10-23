import './test-support/policy-runtime.js';
import { createRun } from './test-support/create-run.js';
import { declaredDispatch } from './test-support/declared-dispatch.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { evaluateTerminalFloor } from '../src/scheduler/sched_admission/brief-contract.js';
import { type StoreState } from '../src/store.js';

let fcHome: string;
let previousFcHome: string;
let store: typeof import('../src/store.js');
let scheduler: typeof import('../src/scheduler.js');
let ScriptedAdapter: typeof import('../src/adapters/scripted.js').ScriptedAdapter;
const projectDirs: string[] = [];
const PROJECT_ROOT = resolve(import.meta.dirname, '..');

beforeAll(async () => {
  fcHome = mkdtempSync(join(tmpdir(), `flowcrew-terminal-freshness-${randomBytes(4).toString('hex')}-`));
  store = await import('../src/store.js');
  previousFcHome = store.fcGlobalDir();
  store.setFcGlobalDir(fcHome);
  scheduler = await import('../src/scheduler.js');
  ({ ScriptedAdapter } = await import('../src/adapters/scripted.js'));
});

afterAll(() => {
  store.setFcGlobalDir(previousFcHome);
  for (const projectDir of projectDirs) rmSync(projectDir, { recursive: true, force: true });
  rmSync(fcHome, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), `flowcrew-terminal-project-${randomBytes(4).toString('hex')}-`));
  projectDirs.push(dir);
  return dir;
}

function writeOld(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  const old = new Date('2000-01-01T00:00:00.000Z');
  utimesSync(path, old, old);
}

async function run(
  projectDir: string,
  brief: string,
  script: ConstructorParameters<typeof ScriptedAdapter>[0],
) {
  const { config, raw } = scheduler.loadWorkflow(join(PROJECT_ROOT, 'config', 'workflows', 'planner.yaml'));
  config.defaults.max_iterations = 3;
  const adapter = new ScriptedAdapter(script);
  const state = await scheduler.runWorkflow(
    config, raw, projectDir, adapter, new Map(), undefined,
    join(PROJECT_ROOT, 'config', 'agents'), undefined, brief,
    true, undefined, false,
  );
  const runDir = join(fcHome, 'runs', state.runId!);
  let guidance = '';
  const live = join(runDir, 'supervisor_guidance.md');
  if (existsSync(live)) guidance += readFileSync(live, 'utf-8');
  const history = join(runDir, 'guidance_history');
  if (existsSync(history)) {
    for (const name of readdirSync(history)) guidance += readFileSync(join(history, name), 'utf-8');
  }
  return { state, guidance, adapter };
}

const dispatch = (id: string, scope = ['docs/task_summary.md'], outputs = ['docs/task_summary.md']) => ({
  runFiles: {
    'tech_solution.md': '# Planner analysis\nExecute the declared terminal work and verify its freshness.\n',
    'dispatch.yaml': declaredDispatch([
      `- id: ${id}`,
      '  role: coder',
      '  depends_on: [plan]',
      '  dependency_reasons: {plan: "execute the planned terminal work"}',
      `  scope: [${scope.join(', ')}]`,
      '  prompt_template: do the work',
      `  artifact_contract: ${JSON.stringify({ version: 1, produces: outputs.map((path, index) => ({ id: `output_${index}`, root: 'project', path })), reads: [] })}`,
    ].join('\n') + '\n'),
  },
});

describe('terminal artifact freshness', () => {
  it.each(['file', 'directory'] as const)('finishes an old run whose owner wrote its terminal %s before deployment without rerunning the owner', async kind => {
    const projectDir = project();
    const path = 'docs/task_summary.md';
    const workflow = scheduler.WorkflowConfigSchema.parse({
      name: 'legacy-terminal', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ id: 'deliver', role: 'coder', depends_on: [], scope: [path],
        artifact_contract: { version: 1, produces: [{ id: 'report', root: 'project', path, kind }], reads: [] } }],
    });
    const created = store.reserveRun(projectDir);
    const startedAt = '2026-01-01T00:00:00.000Z';
    const writtenAt = '2026-01-01T00:00:01.000Z';
    const owner = { status: 'complete', retries: 0, startedAt, completedAt: writtenAt,
      attempts: [{ index: 1, status: 'complete', startedAt, completedAt: writtenAt, exitCode: 0, writes: [path] }] };
    // Literal pre-deploy carriers: initialization never observes the owner's existing result.
    const legacyState = {
      runId: created.runId, workflowName: workflow.name, projectDir, status: 'incomplete',
      startedAt, completedAt: writtenAt, currentIteration: 1, maxIterations: 1,
      stages: { deliver: owner }, terminalStates: { shipped: { paths: [path] } },
    };
    mkdirSync(join(created.runDirPath, 'stages/deliver'), { recursive: true });
    writeFileSync(join(created.runDirPath, 'run.json'), JSON.stringify(legacyState));
    writeFileSync(join(created.runDirPath, 'workflow.yaml'), JSON.stringify(workflow));
    writeFileSync(join(created.runDirPath, 'stages/deliver/status.json'), JSON.stringify(owner));
    writeFileSync(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      pass: true, terminalOwners: { [path]: 'deliver' },
    }));
    mkdirSync(join(projectDir, 'docs'));
    const artifact = join(projectDir, path);
    if (kind === 'directory') mkdirSync(artifact);
    else writeFileSync(artifact, '# delivered by the old engine\n');
    utimesSync(artifact, new Date(writtenAt), new Date(writtenAt));
    const before = statSync(artifact).mtimeMs;
    const adapter = new ScriptedAdapter({});

    const state = await scheduler.runWorkflow(
      workflow, JSON.stringify(workflow), projectDir, adapter, new Map(), undefined,
      join(PROJECT_ROOT, 'config', 'agents'), created.runId,
    );

    expect(state.status, state.failureReason).toBe('shipped');
    expect(state.startedAt).toBe(startedAt);
    expect(state).not.toHaveProperty('terminalArtifactBaselines');
    expect(state.stages.deliver).toEqual(owner);
    expect(JSON.parse(readFileSync(join(created.runDirPath, 'run.json'), 'utf8')).stages.deliver).toEqual(owner);
    expect(JSON.parse(readFileSync(join(created.runDirPath, 'stages/deliver/status.json'), 'utf8'))).toEqual(owner);
    expect(adapter.calls).toEqual([]);
    expect(statSync(artifact).mtimeMs).toBe(before);
  }, 60_000);

  it('resumes an old on-disk run without terminal baselines and reaches its declared terminal state', async () => {
    const projectDir = project();
    const { config, raw } = scheduler.loadWorkflow(join(PROJECT_ROOT, 'config', 'workflows', 'planner.yaml'));
    config.defaults.max_iterations = 3;
    const created = createRun(projectDir, config.name, raw, ['plan']);
    store.beginStageAttempt(projectDir, created.runId, 'plan', 0);
    store.completeStageAttempt(projectDir, created.runId, 'plan', 0, {
      exitCode: 1, duration_ms: 1, error: 'The old engine stopped before producing its plan.',
    });
    const legacyRunPath = join(created.runDirPath, 'run.json');
    const legacyState = JSON.parse(readFileSync(legacyRunPath, 'utf8'));
    delete legacyState.terminalArtifactBaselines;
    legacyState.status = 'failed';
    legacyState.completedAt = new Date().toISOString();
    writeFileSync(legacyRunPath, JSON.stringify(legacyState));
    expect(JSON.parse(readFileSync(legacyRunPath, 'utf8'))).not.toHaveProperty('terminalArtifactBaselines');
    const adapter = new ScriptedAdapter({
      plan: dispatch('deliver'),
      deliver: { projectFiles: { 'docs/task_summary.md': '# delivered after deploy\n' } },
    });

    const state = await scheduler.runWorkflow(
      config, raw, projectDir, adapter, new Map(), undefined,
      join(PROJECT_ROOT, 'config', 'agents'), created.runId, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
---
# Resume the admitted old-engine run
`, true, undefined, false,
    );

    expect(state.status, state.failureReason).toBe('shipped');
    expect(state.runId).toBe(created.runId);
    expect(state.startedAt).toBe(legacyState.startedAt);
    expect(state).not.toHaveProperty('terminalArtifactBaselines');
    expect(state.stages.deliver?.status).toBe('complete');
    expect(adapter.calls.map(call => call.stageId)).toEqual(['plan', 'deliver']);
  }, 60_000);

  it('accepts an admitted owner regenerating a preexisting terminal artifact with identical bytes', async () => {
    const projectDir = project();
    const artifact = join(projectDir, 'docs/task_summary.md');
    const content = '# unchanged but regenerated terminal result\n';
    writeOld(artifact, content);

    const { state, adapter } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
---
# Regenerate the terminal result
`, {
      plan: dispatch('regenerate'),
      regenerate: { projectFiles: { 'docs/task_summary.md': content } },
    });

    expect(state.status, state.failureReason).toBe('shipped');
    expect(readFileSync(artifact, 'utf8')).toBe(content);
    expect(state.stages.regenerate?.status).toBe('complete');
    expect(state.stages.regenerate?.attempts?.at(-1)?.writes).toContain('docs/task_summary.md');
    expect(adapter.calls.map(call => call.stageId)).toEqual(['plan', 'regenerate']);
  }, 60_000);

  it('rejects an artifact older than run start, records explicit guidance, then accepts the same path after a non-plan stage rewrites it', async () => {
    const projectDir = project();
    const artifact = join(projectDir, 'docs', 'task_summary.md');
    writeOld(artifact, '# stale result from a previous task\n');

    const { state, guidance, adapter } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
---
# Freshness fixture
`, {
      plan: dispatch('implement'),
      implement: { projectFiles: { 'docs/task_summary.md': '# fresh result from this run\n' } },
    });

    expect(state.status).toBe('shipped');
    expect(state.stages.implement?.status).toBe('complete');
    expect(adapter.calls.some((call) => call.stageId === 'implement')).toBe(true);
    expect(guidance).toContain("docs/task_summary.md exists but its content is unchanged from this run's initial content");
    expect(guidance).not.toContain('早于本次 run 启动');
    expect(statSync(artifact).mtimeMs).toBeGreaterThanOrEqual(Date.parse(state.startedAt));
  }, 60_000);

  it('does not let the plan stage alone turn a freshly written artifact into success', async () => {
    const projectDir = project();
    const { state, guidance, adapter } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
---
# Non-plan proof fixture
`, {
      plan: {
        ...dispatch('execute_work'),
        projectFiles: { 'docs/task_summary.md': '# written during planning, not yet earned\n' },
      },
      execute_work: {
        output: 'real work completed',
        projectFiles: { 'docs/task_summary.md': '# fresh result committed by terminal owner\n' },
      },
    });

    expect(state.status).toBe('shipped');
    expect(state.stages.execute_work?.status).toBe('complete');
    expect(adapter.calls.some((call) => call.stageId === 'execute_work')).toBe(true);
    expect(guidance).toContain('requires at least one non-plan stage to complete during this run');
  }, 60_000);

  it.each(['attempt', 'retired'] as const)('accepts a completed admitted owner write from %s evidence when its current stage is pending', async (kind) => {
    const projectDir = project();
    const path = 'docs/task_summary.md';
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['plan', 'finalize']);
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeFileSync(join(projectDir, path), '# attributed terminal result\n');
    writeFileSync(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      pass: true, terminalOwners: { [path]: 'finalize' },
    }));
    const state: StoreState = {
      runId: created.runId, workflowName: 'fixture', projectDir, status: 'running', terminalArtifactBaselines: {},
      startedAt: new Date(Date.now() - 1000).toISOString(),
      stages: { plan: { status: 'complete', retries: 0 }, finalize: { status: 'pending', retries: 0 } },
      terminalStates: { shipped: { paths: [path] } },
    };
    const completedWrite = {
      index: 1, status: 'complete' as const, startedAt: state.startedAt,
      completedAt: new Date().toISOString(), writes: [path],
      duration_ms: 1, exitCode: 0, tokenUsage: 'unknown' as const,
    };
    const evaluate = () => scheduler.tryTerminateOnTerminalState(state, {
      projectDir, runId: created.runId, runDirPath: created.runDirPath, iteration: 1,
      adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) },
    });

    expect((await evaluate()).decision).toBe('deferred');
    expect(state.status).toBe('running');
    writeFileSync(join(projectDir, path), '# attributed terminal result\n');
    if (kind === 'attempt') state.stages.finalize.attempts = [completedWrite];
    else state.stageEvidence = [{
      stageId: 'finalize', iteration: 1, status: { status: 'complete', retries: 0, attempts: [completedWrite] },
      statusPath: 'iterations/1/stages/finalize/status.json', attemptOutputPaths: [],
    }];

    expect((await evaluate()).decision).toBe('matched');
    expect(state.status).toBe('shipped');
  });

  it.each([
    { label: 'inferred', stageGlobLine: '', verdictDir: 'docs', verdictName: (i: number) => `stage_${i}_verdict.md` },
    { label: 'configured', stageGlobLine: '    stage_glob: evidence/check_*_verdict.md\n', verdictDir: 'evidence', verdictName: (i: number) => `check_${i}_verdict.md` },
  ])('counts only fresh files for a $label stage_glob floor', async ({ label, stageGlobLine, verdictDir, verdictName }) => {
    const projectDir = project();
    const verdicts: Record<string, string> = {};
    for (let i = 1; i <= 2; i += 1) {
      const relative = `${verdictDir}/${verdictName(i)}`;
      const content = `Stage ${i}: pass\n`;
      writeOld(join(projectDir, relative), content);
      verdicts[relative] = content;
    }

    const { state, guidance } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
${stageGlobLine}    floor:
      min_attempted_stages: 2
---
# Glob freshness fixture
`, {
      plan: {
        ...dispatch('refresh_verdicts', ['docs/task_summary.md', ...Object.keys(verdicts)], ['docs/task_summary.md', ...Object.keys(verdicts)]),
        projectFiles: { 'docs/task_summary.md': '# terminal artifact written by plan\n' },
      },
      refresh_verdicts: {
        projectFiles: {
          ...verdicts,
          'docs/task_summary.md': '# terminal artifact committed after fresh stage evidence\n',
        },
      },
    });

    expect(state.status).toBe('shipped');
    expect(state.stages.refresh_verdicts?.status).toBe('complete');
    expect(guidance).toContain(`${label} stage_glob`);
    expect(guidance).toContain('2 matching file(s) exist but predate this run start');
  }, 60_000);

  it('keeps a legitimate fast terminal reachable when fresh stage evidence satisfies the floor', async () => {
    const projectDir = project();
    const { state, guidance } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
    floor:
      min_attempted_stages: 1
      min_wall_minutes: 999
---
# Bug 7 regression fixture
`, {
      plan: dispatch('deliver', ['docs/task_summary.md', 'docs/stage_1_verdict.md'], ['docs/task_summary.md', 'docs/stage_1_verdict.md']),
      deliver: {
        projectFiles: {
          'docs/task_summary.md': '# legitimate terminal result\n',
          'docs/stage_1_verdict.md': 'pass\n',
        },
      },
    });

    expect(state.status).toBe('shipped');
    expect(state.stages.deliver?.status).toBe('complete');
    expect(Date.parse(state.completedAt!) - Date.parse(state.startedAt)).toBeLessThan(60_000);
    expect(guidance).not.toContain('wall time');
  }, 60_000);

  it.each(['missing', 'empty', 'directory'])('refuses a %s receipt and accepts concise declared stage evidence', (shape) => {
    const projectDir = project();
    const receipt = join(projectDir, 'evidence', 'check_1_verdict.md');
    mkdirSync(resolve(receipt, '..'), { recursive: true });
    const state: StoreState = {
      runId: 'fixture', workflowName: 'fixture', projectDir, status: 'running', stages: {},
      startedAt: new Date(Date.now() - 1000).toISOString(),
    };
    const entry = {
      paths: ['docs/task_summary.md'], stageGlob: 'evidence/check_*_verdict.md',
      floor: { minAttemptedStages: 1 },
    };
    if (shape === 'empty') writeFileSync(receipt, '');
    if (shape === 'directory') mkdirSync(receipt);
    expect(evaluateTerminalFloor(state, entry, projectDir).passed).toBe(false);

    if (shape === 'directory') rmSync(receipt, { recursive: true });
    writeFileSync(receipt, 'pass\n');
    expect(evaluateTerminalFloor(state, entry, projectDir).passed).toBe(true);
  });

  it('rejects a stale terminal artifact after a completed non-writing stage', async () => {
    const projectDir = project();
    writeOld(join(projectDir, 'docs', 'task_summary.md'), '# stale result from a previous task\n');

    const { state } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [docs/task_summary.md]
---
# Isolated freshness guard fixture
`, {
      plan: dispatch('implement', ['docs/task_summary.md'], []),
      implement: { output: 'completed real work without touching the stale artifact' },
    });

    expect(state.stages.implement?.status).toBe('complete');
    expect(state.status).not.toBe('shipped');
  }, 60_000);
});
