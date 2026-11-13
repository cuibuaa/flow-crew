import { createTerminalEvaluator } from '../src/scheduler/sched_policy/terminal.js';
import { createBriefAdmission, inspectBrief } from '../src/brief-preflight.js';
import { runRecordPath } from '../src/run-layout.js';
import './test-support/policy-runtime.js';
import { createRun } from './test-support/create-run.js';
import { declaredDispatch } from './test-support/declared-dispatch.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { captureTerminalReceiptBaselines, evaluateTerminalFloor } from '../src/scheduler/sched_admission/brief-contract.js';
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
  const live = runRecordPath(runDir, 'supervisor_guidance.md');
  if (existsSync(live)) guidance += readFileSync(live, 'utf-8');
  const history = runRecordPath(runDir, 'guidance_history');
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
  it.each(['file', 'directory'] as const)('refuses a retained run without a launch baseline for a terminal %s', async kind => {
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
      storageLayout: 2, runId: created.runId, workflowName: workflow.name, projectDir, status: 'incomplete',
      briefAdmission: createBriefAdmission(inspectBrief(`---\nterminal_states: {shipped: ${path}}\n---\n`), { kind: 'not_required' }), briefConfigured: true,
      startedAt, completedAt: writtenAt, currentIteration: 1, maxIterations: 1,
      stages: { deliver: owner }, terminalStates: { shipped: { paths: [path] } },
    };
    mkdirSync(runRecordPath(created.runDirPath, 'stages/deliver'), { recursive: true });
    writeFileSync(runRecordPath(created.runDirPath, 'run.json'), JSON.stringify(legacyState));
    writeFileSync(runRecordPath(created.runDirPath, 'workflow.yaml'), JSON.stringify(workflow));
    writeFileSync(runRecordPath(created.runDirPath, 'stages/deliver/status.json'), JSON.stringify(owner));
    writeFileSync(runRecordPath(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
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

    expect(state.status, state.failureReason).toBe('incomplete');
    expect(state.reasonCode).toBe('artifact_ownership_unverified');
    expect(state.startedAt).toBe(startedAt);
    expect(state).not.toHaveProperty('terminalArtifactBaselines');
    expect(state.stages.deliver).toEqual(owner);
    expect(JSON.parse(readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8')).stages.deliver).toEqual(owner);
    expect(JSON.parse(readFileSync(runRecordPath(created.runDirPath, 'stages/deliver/status.json'), 'utf8'))).toEqual(owner);
    expect(adapter.calls).toEqual([]);
    expect(statSync(artifact).mtimeMs).toBe(before);
  }, 60_000);

  it('refuses continuation of an old run without manufacturing terminal baselines', async () => {
    const projectDir = project();
    const { config, raw } = scheduler.loadWorkflow(join(PROJECT_ROOT, 'config', 'workflows', 'planner.yaml'));
    config.defaults.max_iterations = 3;
    const brief = '---\nterminal_states: {shipped: {paths: [docs/task_summary.md]}}\n---\n# Resume the admitted run\n';
    const created = createRun(projectDir, config.name, raw, ['plan'], brief);
    store.beginStageAttempt(projectDir, created.runId, 'plan', 0);
    store.completeStageAttempt(projectDir, created.runId, 'plan', 0, {
      exitCode: 1, duration_ms: 1, error: 'The old engine stopped before producing its plan.',
    });
    const legacyRunPath = runRecordPath(created.runDirPath, 'run.json');
    const legacyState = JSON.parse(readFileSync(legacyRunPath, 'utf8'));
    // format-is-declared / legacy-resume-imports-once: this is an old run.
    delete legacyState.lifecycleAuthority;
    delete legacyState.lifecycleCursor;
    delete legacyState.terminalArtifactBaselines;
    legacyState.briefConfigured = true;
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

    const imports = readFileSync(runRecordPath(created.runDirPath, 'events.jsonl'), 'utf8').trim().split('\n')
      .map(row => JSON.parse(row)).filter(row => row.type === 'run_status_imported');
    expect(imports).toEqual([expect.objectContaining({ lifecycleVersion: 1, snapshotSource: 'run.json', snapshotStatus: 'failed', runStatus: 'failed' })]);
    expect(state.status, state.failureReason).toBe('incomplete');
    expect(state.reasonCode).toBe('artifact_ownership_unverified');
    expect(state.runId).toBe(created.runId);
    expect(state.startedAt).toBe(legacyState.startedAt);
    expect(state).not.toHaveProperty('terminalArtifactBaselines');
    expect(state.stages.deliver).toBeUndefined();
    expect(adapter.calls).toEqual([]);
  }, 60_000);

  it.each(['configured', 'inferred'])('persists %s receipt launch content before adapters work and accepts changed bytes with old mtimes', async mode => {
    const projectDir = project();
    const terminal = 'docs/task_summary.md', receipt = 'docs/stage_1_verdict.md';
    writeOld(join(projectDir, terminal), 'inherited terminal');
    writeOld(join(projectDir, receipt), 'inherited receipt');
    const original = ScriptedAdapter.prototype.run;
    const baselines: string[] = [];
    vi.spyOn(ScriptedAdapter.prototype, 'run').mockImplementation(async function(prompt, role, opts) {
      const saved = JSON.parse(readFileSync(runRecordPath(opts.runDir, 'run.json'), 'utf8'));
      expect(saved.terminalArtifactBaselines[terminal].state).toBe('present');
      expect(saved.terminalReceiptBaselines['docs/stage_*_verdict.md'].files[receipt].state).toBe('present');
      baselines.push(JSON.stringify([saved.terminalArtifactBaselines, saved.terminalReceiptBaselines]));
      const result = await original.call(this, prompt, role, opts);
      for (const path of [terminal, receipt]) utimesSync(join(projectDir, path), new Date('2000-01-01'), new Date('2000-01-01'));
      return result;
    });
    const { state } = await run(projectDir, `---
terminal_states:
  shipped:
    paths: [${terminal}]
${mode === 'configured' ? '    stage_glob: docs/stage_*_verdict.md\n' : ''}    floor: {min_attempted_stages: 1}
---
`, { plan: dispatch('deliver', [terminal, receipt], [terminal, receipt]),
      deliver: { projectFiles: { [terminal]: 'changed terminal', [receipt]: 'changed receipt' } } });
    expect(state.status, state.failureReason).toBe('shipped');
    expect(baselines.length).toBe(2);
    expect(new Set(baselines).size).toBe(1);
    expect(statSync(join(projectDir, terminal)).mtimeMs).toBe(Date.parse('2000-01-01'));
    vi.restoreAllMocks();
  });

  it.each(['touch', 'rewrite', 'inherited'])('refuses a %s receipt with unchanged bytes despite a newer mtime', mode => {
    const projectDir = project(), path = join(projectDir, 'stage_1_verdict.md');
    writeOld(path, 'same receipt');
    const entry = { paths: ['result.md'], floor: { minAttemptedStages: 1 } };
    const state = { startedAt: '2026-01-01T00:00:00.000Z', terminalReceiptBaselines: captureTerminalReceiptBaselines(projectDir, [entry]) } as StoreState;
    if (mode === 'rewrite') writeFileSync(path, 'same receipt');
    if (mode !== 'inherited') utimesSync(path, new Date('2030-01-01'), new Date('2030-01-01'));
    expect(evaluateTerminalFloor(state, entry, projectDir)).toMatchObject({ passed: false, reason: expect.stringContaining('unchanged launch content') });
  });

  it('refuses legacy receipt floors with a typed reason rather than accepting timestamps', () => {
    const projectDir = project();
    writeOld(join(projectDir, 'stage_1_verdict.md'), 'receipt');
    expect(evaluateTerminalFloor({ startedAt: '1990-01-01' } as StoreState,
      { paths: ['result.md'], floor: { minAttemptedStages: 1 } }, projectDir)).toMatchObject({ passed: false, reasonCode: 'artifact_ownership_unverified' });
  });

  it('preserves launch baselines across resume and records absence before files exist', async () => {
    const { configureWorkflowBrief } = await import('../src/scheduler/sched_loop/brief.js');
    const projectDir = project();
    const brief = '---\nterminal_states: {shipped: {paths: [result.md], floor: {min_attempted_stages: 1}}}\n---\n';
    const { config, raw } = scheduler.loadWorkflow(join(PROJECT_ROOT, 'config/workflows/planner.yaml'));
    const created = createRun(projectDir, config.name, raw, ['plan'], brief);
    const configure = (resumingExistingRun: boolean) => configureWorkflowBrief(config, projectDir, created.runId, created.runDirPath, 1,
      { resumingExistingRun, briefWasAdmitted: true });
    expect(configure(false).kind).toBe('configured');
    const launched = store.readRunState(projectDir, created.runId);
    expect(launched.terminalArtifactBaselines).toEqual({ 'result.md': { state: 'absent' } });
    expect(launched.terminalReceiptBaselines).toEqual({ './stage_*_verdict.md': { files: {} } });
    writeOld(join(projectDir, 'result.md'), 'terminal');
    writeOld(join(projectDir, 'stage_1_verdict.md'), 'receipt');
    expect(configure(true).kind).toBe('configured');
    const resumed = store.readRunState(projectDir, created.runId);
    expect(resumed.terminalArtifactBaselines).toEqual(launched.terminalArtifactBaselines);
    expect(resumed.terminalReceiptBaselines).toEqual(launched.terminalReceiptBaselines);
    expect(evaluateTerminalFloor(resumed, resumed.terminalStates!.shipped!, projectDir).passed).toBe(true);
  });

  it.each([true, false])('never captures a historical baseline for unconfigured legacy metadata (resuming=%s)', async resumingExistingRun => {
    const { configureWorkflowBrief } = await import('../src/scheduler/sched_loop/brief.js');
    const projectDir = project();
    const { config, raw } = scheduler.loadWorkflow(join(PROJECT_ROOT, 'config/workflows/planner.yaml'));
    const created = createRun(projectDir, config.name, raw, ['plan'], '---\nterminal_states: {shipped: result.md}\n---\n');
    const legacy = store.readRunState(projectDir, created.runId);
    delete legacy.terminalArtifactBaselines;
    delete legacy.terminalReceiptBaselines;
    legacy.briefConfigured = false;
    store.writeRunState(projectDir, created.runId, legacy);
    writeOld(join(projectDir, 'result.md'), 'existing legacy result');
    const outcome = configureWorkflowBrief(config, projectDir, created.runId, created.runDirPath, 1, { resumingExistingRun, briefWasAdmitted: true });
    expect(outcome.kind).toBe('settled');
    const refused = store.readRunState(projectDir, created.runId);
    expect(refused.reasonCode).toBe('artifact_ownership_unverified');
    expect(refused).not.toHaveProperty('terminalArtifactBaselines');
    expect(refused).not.toHaveProperty('terminalReceiptBaselines');
  });

  it('refuses receipt globs and symlink targets outside the project boundary', () => {
    const root = project(), projectDir = join(root, 'project');
    mkdirSync(projectDir);
    writeOld(join(root, 'stage_1_verdict.md'), 'outside receipt');
    const entry = { paths: ['result.md'], stageGlob: '../stage_*_verdict.md', floor: { minAttemptedStages: 1 } };
    const state = { startedAt: '2026-01-01', terminalReceiptBaselines: captureTerminalReceiptBaselines(projectDir, [entry]) } as StoreState;
    expect(evaluateTerminalFloor(state, entry, projectDir)).toMatchObject({ passed: false, reasonCode: 'artifact_ownership_unverified' });
    const inside = { ...entry, stageGlob: 'stage_*_verdict.md' };
    state.terminalReceiptBaselines = captureTerminalReceiptBaselines(projectDir, [inside]);
    symlinkSync('../stage_1_verdict.md', join(projectDir, 'stage_1_verdict.md'));
    expect(evaluateTerminalFloor(state, inside, projectDir).passed).toBe(false);
  });

  it('terminal evaluation refuses a missing baseline with a typed reason', async () => {
    const evaluator = createTerminalEvaluator({ writeCampaignEntry: () => {}, concludeRepeatedBlockage: () => null });
    expect(await evaluator.tryTerminateOnTerminalState({ terminalStates: { shipped: { paths: ['result.md'] } }, stages: {} } as StoreState,
      { projectDir: project(), runDirPath: '/unused', runId: 'fixture', iteration: 1, stages: [] })).toMatchObject({ decision: 'deferred', reasonCode: 'artifact_ownership_unverified' });
  });

  it.each(['terminal', 'receipt'] as const)('preserves the typed %s ownership refusal through quiescent conclusion', async missing => {
    const { createTerminalEvaluator: evaluatorFactory } = await import('../src/scheduler/sched_policy/terminal.js');
    const projectDir = project();
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['work']);
    const state = store.readRunState(projectDir, created.runId);
    state.stages.work = { status: 'complete', retries: 0 };
    state.startedAt = '2026-01-01T00:00:00.000Z';
    state.terminalStates = { shipped: { paths: ['result.md'], floor: { minAttemptedStages: 1 } } };
    delete state.terminalReceiptBaselines;
    if (missing === 'terminal') delete state.terminalArtifactBaselines;
    else state.terminalArtifactBaselines = { 'result.md': { state: 'absent' } };
    store.writeRunState(projectDir, created.runId, state);
    writeOld(join(projectDir, 'result.md'), 'terminal bytes');
    writeOld(join(projectDir, 'stage_1_verdict.md'), 'receipt bytes');
    const evaluator = evaluatorFactory({ writeCampaignEntry: () => {}, concludeRepeatedBlockage: () => null });
    const ctx = { projectDir, runDirPath: created.runDirPath, runId: created.runId, iteration: 1, stages: [] };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:00:00.000Z'));
    try {
      expect(await evaluator.tryTerminateOnTerminalState(state, ctx)).toMatchObject({ decision: 'deferred', reasonCode: 'artifact_ownership_unverified' });
      expect(await evaluator.concludeDeclaredTerminalAtQuiescence(state, [], ctx, 'fixture')).toMatchObject({ status: 'incomplete', reasonCode: 'artifact_ownership_unverified' });
      expect(store.readRunState(projectDir, created.runId)).toMatchObject({ status: 'incomplete', reasonCode: 'artifact_ownership_unverified' });
    } finally { clock.mockRestore(); }
  });

  it('rejects a preexisting terminal artifact rewritten with identical bytes', async () => {
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

    expect(state.status, state.failureReason).toBe('incomplete');
    expect(readFileSync(artifact, 'utf8')).toBe(content);
    expect(state.stages.regenerate?.status).toBe('complete');
    expect(state.stages.regenerate?.attempts?.at(-1)?.writes).toContain('docs/task_summary.md');
    expect(adapter.calls.map(call => call.stageId)).toEqual(['plan', 'regenerate']);
  }, 60_000);

  it('rejects unchanged inherited content then accepts changed terminal bytes', async () => {
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
  }, 60_000);

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
      verdicts[relative] = `Changed receipt ${i}: pass\n`;
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
    expect(guidance).toContain('2 matching file(s) have unchanged launch content');
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

    expect(guidance).not.toContain('wall time');
  }, 60_000);

  it.each(['missing', 'empty', 'directory'])('refuses a %s receipt and accepts concise declared stage evidence', (shape) => {
    const projectDir = project();
    const receipt = join(projectDir, 'evidence', 'check_1_verdict.md');
    mkdirSync(resolve(receipt, '..'), { recursive: true });
    const state: StoreState = {
      runId: 'fixture', workflowName: 'fixture', projectDir, status: 'running', stages: {},
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    const entry = {
      paths: ['docs/task_summary.md'], stageGlob: 'evidence/check_*_verdict.md',
      floor: { minAttemptedStages: 1 },
    };
    state.terminalReceiptBaselines = captureTerminalReceiptBaselines(projectDir, [entry]);
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
