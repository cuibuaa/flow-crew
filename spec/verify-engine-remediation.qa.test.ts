import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { loadProjectDefaultsLocally } from '../src/config.js';
import {
  cmdLandWithDeps,
  type LandGitRequest,
  type LandGitResponse,
  type LandGitRunner,
} from '../src/cli-land.js';
import { archiveDeclaredOutputs } from '../src/declared-output-archive.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { appendRunEvent, readRunEvents } from '../src/run-events.js';
import {
  checkCampaignHealth,
  findGateRecoveryStages,
  loadWorkflow,
  readGateVerdict,
  recordGateValidationDelta,
  runWorkflow,
  tryTerminateOnTerminalState,
  writeCampaignEntry,
  type CampaignEntry,
  type StageConfig,
} from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { writeReadySetupRecord } from './test-support/ready-setup.js';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const roots: string[] = [];
const originalFcRoot = fcGlobalDir();

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-remediation-qa-'));
  roots.push(root);
  return root;
}

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf-8');
}

function stage(input: Partial<StageConfig> & Pick<StageConfig, 'id' | 'role'>): StageConfig {
  return {
    depends_on: [],
    prompt_template: 'QA fixture',
    skills: [],
    dynamic_dispatch: false,
    is_gate: false,
    ...input,
  };
}

function writeRole(projectDir: string, role: string): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  write(join(agentsDir, `${role}.yaml`), [
    `name: ${role}`,
    'description: independent remediation verifier',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: fixture',
  ].join('\n'));
  return agentsDir;
}

async function waitForDecision(directory: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = readdirSync(directory).find((name) => name.startsWith('scope_revision_decision_'));
    if (match) return join(directory, match);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`scope decision was not published in ${directory}`);
}

function landRunner(
  projectDir: string,
  primaryDir: string,
  ignoredPath: string,
  operations: LandGitRequest['operation'][],
): LandGitRunner {
  return async (request): Promise<LandGitResponse> => {
    operations.push(request.operation);
    if (request.operation === 'ignored') return { exitCode: 0, stdout: `${ignoredPath}\0` };
    if (request.operation === 'root') return { exitCode: 0, stdout: `${projectDir}\n` };
    if (request.operation === 'worktrees') {
      return {
        exitCode: 0,
        stdout: [
          `worktree ${primaryDir}`,
          `HEAD ${'a'.repeat(40)}`,
          'branch refs/heads/main',
          '',
          `worktree ${projectDir}`,
          `HEAD ${'b'.repeat(40)}`,
          'branch refs/heads/remediation-fixture',
          '',
        ].join('\n'),
      };
    }
    if (request.operation === 'branch') return { exitCode: 0, stdout: 'remediation-fixture\n' };
    return { exitCode: 0, stdout: '' };
  };
}

afterEach(() => {
  setFcGlobalDir(originalFcRoot);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REPORT_PATH = join(PROJECT_ROOT, 'docs', 'engine-remediation', 'report.md');

describe('independent engine-remediation verification', () => {
  it('reports exactly one numbered result for every claimed decision', (context) => {
    // The report lives under a git-ignored docs/ tree, so a clean checkout (CI)
    // does not carry it. Skip where it is absent; assert in full where it is.
    if (!existsSync(REPORT_PATH)) return context.skip();
    const report = readFileSync(REPORT_PATH, 'utf-8');
    const ids = [...report.matchAll(/^### (\d+) —/gm)].map((match) => Number(match[1]));
    expect(ids).toEqual(Array.from({ length: 20 }, (_value, index) => index + 1));
  });

  it('keeps the report-published before replay command executable from the project root', (context) => {
    if (!existsSync(REPORT_PATH)) return context.skip();
    const report = readFileSync(REPORT_PATH, 'utf-8');
    const target = /node node_modules\/vitest\/vitest\.mjs run (spec\/\S+) --config/.exec(report)?.[1];
    expect(target, 'the report must publish a concrete frozen before-spec target').toBeTypeOf('string');
    expect(existsSync(join(PROJECT_ROOT, target!)), `reported replay target does not exist: ${target}`).toBe(true);
  });

  it('calibrates reach counting through the reach instrument rather than a fixed sentinel predicate', () => {
    const source = readFileSync(join(PROJECT_ROOT, 'spec', 'engine-remediation.test.ts'), 'utf-8');
    const start = source.indexOf('function reach(');
    const end = source.indexOf('\n}\n\nfunction recordAfter', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const helper = source.slice(start, end);
    expect(helper).not.toContain("['known-positive'].filter");
  });

  it('records and consumes the validation delta through a completed scheduler gate', { timeout: 20_000 }, async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    mkdirSync(projectDir);
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\ndefault_max_iterations: 1\n');
    write(join(projectDir, 'validation-probe.mjs'), 'process.stderr.write("FAIL spec/new.test.ts\\n"); process.exit(1);\n');
    const agentsDir = writeRole(projectDir, 'qa');
    setFcGlobalDir(globalRoot);
    const brief = '# Goal\n## What the report must show\n1. Audit the validation delta.\n';
    const readyPath = writeReadySetupRecord(projectDir, brief, globalRoot);
    const ready = JSON.parse(readFileSync(readyPath, 'utf-8')) as {
      validationBaseline: { discovery: { commands: Array<{ args: string[] }> } };
    };
    ready.validationBaseline.discovery.commands[0].args = ['validation-probe.mjs'];
    write(readyPath, `${JSON.stringify(ready, null, 2)}\n`);
    let gatePrompt = '';
    const qa = stage({ id: 'qa', role: 'qa', is_gate: true });
    const final = await runWorkflow(
      { name: 'validation-wire-qa', defaults: { max_iterations: 1, max_retries: 0 }, stages: [qa] },
      'name: validation-wire-qa',
      projectDir,
      { async run(prompt, _role, options) {
        if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        gatePrompt = prompt;
        write(join(options.runDir, 'verdict_qa.json'), JSON.stringify({ pass: true, reason: 'model accepted' }));
        return { output: 'gate complete', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
      } },
      new Map(), undefined, agentsDir, undefined, brief, true,
    );
    const runDirectory = runDir(projectDir, final.runId);
    expect(gatePrompt).toContain('Engine-enforced validation baseline');
    expect(existsSync(join(runDirectory, 'validation_baseline.json'))).toBe(true);
    const producedByScheduler = existsSync(join(runDirectory, 'validation_delta_qa.json'));
    if (!producedByScheduler) await recordGateValidationDelta(projectDir, final.runId, 'qa');
    expect(existsSync(join(runDirectory, 'validation_delta_qa.json'))).toBe(true);
    const delta = JSON.parse(readFileSync(join(runDirectory, 'validation_delta_qa.json'), 'utf-8')) as {
      pass: boolean;
      delta: Array<{ state: string }>;
    };
    expect(delta).toMatchObject({ pass: false, delta: [{ state: 'regression' }] });
    expect(readGateVerdict(projectDir, 'qa', final.runId)).toMatchObject({
      pass: false,
      reason: expect.stringContaining('regressed'),
    });
    expect({
      producedByScheduler,
      settledGateStatus: readRunState(projectDir, final.runId).stages.qa?.status,
    }, 'scheduler gate settlement must invoke the working recorder').toEqual({
      producedByScheduler: true,
      settledGateStatus: 'complete',
    });
  });

  it('refuses to archive a declared output reached through a symlinked ancestor', () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const outsideDir = join(root, 'outside');
    const runDirectory = join(root, 'run');
    mkdirSync(projectDir);
    mkdirSync(outsideDir);
    mkdirSync(runDirectory);
    write(join(outsideDir, 'report.md'), 'outside project\n');
    symlinkSync(outsideDir, join(projectDir, 'docs'), 'dir');

    expect(() => archiveDeclaredOutputs(projectDir, runDirectory, [{
      path: 'docs/report.md', line: 2, source: 'outputs', disposition: 'create', expectedType: 'file',
    }])).toThrow(/symlink/i);
  });

  it('archives declared outputs when a workflow completes without terminal_states', { timeout: 20_000 }, async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\ndefault_max_iterations: 1\n');
    const agentsDir = writeRole(projectDir, 'worker');
    setFcGlobalDir(join(root, 'fc-home'));
    const outputPath = 'docs/report.md';
    const brief = [
      '---',
      'outputs:',
      `  - path: ${outputPath}`,
      '---',
      '# Goal',
      '## What the report must show',
      '1. Produce and archive the report.',
      '',
    ].join('\n');
    const final = await runWorkflow(
      {
        name: 'plain-output-archive',
        defaults: { max_iterations: 1, max_retries: 0 },
        stages: [stage({ id: 'work', role: 'worker', scope: [outputPath] })],
      },
      'name: plain-output-archive',
      projectDir,
      { async run(_prompt, _role, options) {
        if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        write(join(projectDir, outputPath), 'plain completion report\n');
        return { output: 'report complete', exitCode: 0, duration_ms: 1, writes: [outputPath], writeAttribution: 'structured' };
      } },
      new Map(), undefined, agentsDir, undefined, brief, true,
    );
    const runDirectory = runDir(projectDir, final.runId);
    expect({
      status: final.status,
      manifestExists: existsSync(join(runDirectory, 'declared_outputs_manifest.json')),
      archivedOutputExists: existsSync(join(runDirectory, 'declared_outputs', outputPath)),
    }).toEqual({ status: 'complete', manifestExists: true, archivedOutputExists: true });
  });

  it('rejects a traversing run identifier even when its target has run state', () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const globalRoot = join(root, 'fc-home');
    const escapedDirectory = join(globalRoot, 'escape');
    mkdirSync(projectDir);
    setFcGlobalDir(globalRoot);
    write(join(escapedDirectory, 'run.json'), JSON.stringify({ runId: '../escape' }));
    let thrown: unknown;
    try {
      appendRunEvent(projectDir, '../escape', {
        type: 'guidance_written',
        runId: '../escape',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      thrown = error;
    }
    expect({
      threw: thrown instanceof Error,
      wroteOutsideRunsRoot: existsSync(join(escapedDirectory, 'events.jsonl')),
    }).toEqual({ threw: true, wroteOutsideRunsRoot: false });
  });

  it('keeps an unlisted cache anchor out of the exemption policy', () => {
    const root = temporaryRoot();
    write(join(root, 'config', 'defaults.yaml'), [
      'live_constraint_exempt_patterns:',
      '  - .unlisted_cache/**',
      '',
    ].join('\n'));
    expect(() => loadProjectDefaultsLocally(root)).toThrow(/unsafe non-cache pattern/i);
  });

  it('rejects an impossible status literal when loading a static workflow', () => {
    const root = temporaryRoot();
    const workflowPath = join(root, 'impossible.yaml');
    write(workflowPath, [
      'name: impossible-static-condition',
      'stages:',
      '  - id: producer',
      '    role: worker',
      '  - id: conditional',
      '    role: worker',
      '    depends_on: [producer]',
      '    condition: producer.status == status_that_does_not_exist',
      '',
    ].join('\n'));
    expect(() => loadWorkflow(workflowPath)).toThrow(/status literal .* cannot occur/i);
  });

  it('lets land remove a worktree whose only ignored output is byte-identically archived', async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const primaryDir = join(root, 'primary');
    const globalRoot = join(root, 'fc-home');
    mkdirSync(projectDir);
    mkdirSync(primaryDir);
    setFcGlobalDir(globalRoot);
    const created = createRun(projectDir, 'fixture', 'name: fixture', []);
    const terminalPath = 'docs/final.md';
    const outputPath = 'docs/report.md';
    write(join(projectDir, terminalPath), '# final\n');
    write(join(projectDir, outputPath), 'archived report\n');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';
    state.baseCommit = 'a'.repeat(40);
    state.completedAt = new Date().toISOString();
    state.terminalStates = { complete: { paths: [terminalPath] } };
    writeRunState(projectDir, created.runId, state);
    archiveDeclaredOutputs(projectDir, created.runDirPath, [{
      path: outputPath, line: 2, source: 'outputs', disposition: 'create', expectedType: 'file',
    }]);
    const operations: LandGitRequest['operation'][] = [];
    let stdout = '';
    let stderr = '';
    const code = await cmdLandWithDeps([
      'land', '--run', created.runId, '--remove', '--acknowledge-regenerable=0',
    ], {
      git: landRunner(projectDir, primaryDir, outputPath, operations),
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Land: REMOVED');
    expect(operations).toEqual(expect.arrayContaining(['remove_worktree', 'prune_worktrees', 'delete_branch']));
  });

  it('keeps land refusal when an archived ignored output changes afterward', async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    const primaryDir = join(root, 'primary');
    const globalRoot = join(root, 'fc-home');
    mkdirSync(projectDir);
    mkdirSync(primaryDir);
    setFcGlobalDir(globalRoot);
    const created = createRun(projectDir, 'fixture', 'name: fixture', []);
    const terminalPath = 'docs/final.md';
    const outputPath = 'docs/report.md';
    write(join(projectDir, terminalPath), '# final\n');
    write(join(projectDir, outputPath), 'archived report\n');
    const state = readRunState(projectDir, created.runId);
    state.status = 'complete';
    state.baseCommit = 'a'.repeat(40);
    state.completedAt = new Date().toISOString();
    state.terminalStates = { complete: { paths: [terminalPath] } };
    writeRunState(projectDir, created.runId, state);
    archiveDeclaredOutputs(projectDir, created.runDirPath, [{
      path: outputPath, line: 2, source: 'outputs', disposition: 'create', expectedType: 'file',
    }]);
    write(join(projectDir, outputPath), 'mutated after archive\n');
    const operations: LandGitRequest['operation'][] = [];
    let stderr = '';
    const code = await cmdLandWithDeps([
      'land', '--run', created.runId, '--remove', '--acknowledge-regenerable=0',
    ], {
      git: landRunner(projectDir, primaryDir, outputPath, operations),
      stderr: { write: (chunk) => { stderr += chunk; } },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('REFUSED 1 ignored ungraded path remains');
    expect(operations).not.toEqual(expect.arrayContaining(['remove_worktree', 'prune_worktrees', 'delete_branch']));
  });

  it('retains a substantive hyphenated criterion whose first word is Example', () => {
    const artifact = extractBriefCriteria([
      '# Goal',
      '## What the report must show',
      '1. Example-driven proof must include the failing identity.',
      '',
    ].join('\n'));
    expect(artifact.criteria).toHaveLength(1);
    expect(artifact.excluded).toBeUndefined();
  });

  it('does not redispatch a completed producer when the gate says no measurement is missing', () => {
    const measure = stage({ id: 'measure', role: 'researcher', scope: ['docs/round.json'] });
    const gate = stage({ id: 'qa', role: 'qa', is_gate: true, depends_on: ['measure'] });
    const repair = stage({ id: 'repair_report', role: 'writer', depends_on: ['qa'], retry_to: ['qa'] });
    const selected = findGateRecoveryStages(
      [measure, gate, repair],
      ['qa'],
      { qa: 'The report needs prose edits; no missing measurement remains.' },
      { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json' },
    );
    expect(selected.map((entry) => entry.id)).toEqual(['repair_report']);
  });

  it('settles a terminal artifact during the fifth and final admitted research iteration', async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    setFcGlobalDir(join(root, 'fc-home'));
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['finalizer']);
    const terminalPath = 'docs/final.md';
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    write(join(projectDir, terminalPath), '# final round terminal\n');
    const state = readRunState(projectDir, created.runId);
    state.startedAt = startedAt;
    state.status = 'running';
    state.currentIteration = 5;
    state.maxIterations = 5;
    state.research = { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json', stop: { maxRounds: 5 } };
    state.terminalStates = { complete: { paths: [terminalPath] } };
    state.stages.finalizer = {
      status: 'complete',
      retries: 0,
      attempts: [{ index: 1, status: 'complete', startedAt, writes: [terminalPath] }],
    };
    writeRunState(projectDir, created.runId, state);
    write(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      version: 1,
      pass: true,
      checkedAt: new Date().toISOString(),
      errors: [],
      terminalOwners: { [terminalPath]: 'finalizer' },
    }));
    const result = await tryTerminateOnTerminalState(state, {
      projectDir,
      runId: created.runId,
      runDirPath: created.runDirPath,
      iteration: 5,
      adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 0 }) },
    });
    expect(result).toMatchObject({ decision: 'matched' });
    expect(state).toMatchObject({ status: 'complete', currentIteration: 5, maxIterations: 5 });
  });

  it('accepts and re-dispatches an ordinary non-terminal scope request', { timeout: 20_000 }, async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    write(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\ndefault_max_iterations: 1\n');
    const agentsDir = writeRole(projectDir, 'worker');
    setFcGlobalDir(join(root, 'fc-home'));
    const requestedPath = 'docs/report.md';
    const work = stage({ id: 'work', role: 'worker', scope: [] });
    let calls = 0;
    let decisionPath = '';
    const final = await runWorkflow(
      { name: 'ordinary-scope-control', defaults: { max_iterations: 1, max_retries: 0 }, stages: [work] },
      'name: ordinary-scope-control',
      projectDir,
      { async run(prompt, _role, options) {
        if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        calls += 1;
        if (calls === 1) {
          const directory = join(options.runDir, 'stages', options.stageId);
          write(join(directory, 'scope_revision_request.json'), JSON.stringify({
            version: 1,
            kind: 'scope_revision',
            requestId: 'ordinary-control',
            runId: basename(options.runDir),
            stageId: options.stageId,
            attemptIndex: 1,
            requestedPaths: [requestedPath],
            pathDigest: scopePathDigest([requestedPath]),
            reason: 'write the ordinary report',
          }));
          decisionPath = await waitForDecision(directory);
          return { output: 'accepted at control boundary', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
        }
        expect(prompt).toContain('Scope revision ordinary-control was accepted');
        write(join(projectDir, requestedPath), 'ordinary report\n');
        return { output: 'ordinary path written', exitCode: 0, duration_ms: 1, writes: [requestedPath], writeAttribution: 'structured' };
      } },
      new Map(), undefined, agentsDir, undefined,
      '# Goal\n## What the report must show\n1. Exercise ordinary scope negotiation.\n', true,
    );
    const decision = JSON.parse(readFileSync(decisionPath, 'utf-8')) as Record<string, unknown>;
    expect(final.status).toBe('complete');
    expect(calls).toBe(2);
    expect(decision).toMatchObject({ accepted: true, decision: 'accepted', authorizedPaths: [requestedPath] });
    expect(readRunEvents(projectDir, final.runId)).toContainEqual(expect.objectContaining({
      type: 'scope_revision_decided', stageId: 'work', decision: 'accepted',
    }));
  });

  it('quarantines a non-owner terminal file and accepts a later owner-attributed replacement', async () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    setFcGlobalDir(join(root, 'fc-home'));
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['finalizer']);
    const terminalPath = 'docs/final.md';
    const state = readRunState(projectDir, created.runId);
    state.startedAt = new Date(Date.now() - 1_000).toISOString();
    state.status = 'running';
    state.terminalStates = { complete: { paths: [terminalPath] } };
    writeRunState(projectDir, created.runId, state);
    write(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      version: 1,
      pass: true,
      checkedAt: new Date().toISOString(),
      errors: [],
      terminalOwners: { [terminalPath]: 'finalizer' },
    }));
    write(join(projectDir, terminalPath), 'written by non-owner\n');

    const context = {
      projectDir,
      runId: created.runId,
      runDirPath: created.runDirPath,
      iteration: 1,
      adapter: { run: async () => ({ output: '', exitCode: 0, duration_ms: 0 }) },
    };
    const rejected = await tryTerminateOnTerminalState(state, context);
    expect(rejected.decision).toBe('deferred');
    expect(existsSync(join(projectDir, terminalPath))).toBe(false);
    expect(readRunEvents(projectDir, created.runId).some((event) => event.type === 'terminal_candidate_quarantined')).toBe(true);

    write(join(projectDir, terminalPath), 'written by finalizer\n');
    const ownerState = readRunState(projectDir, created.runId);
    ownerState.stages.finalizer = {
      status: 'complete',
      retries: 0,
      attempts: [{
        index: 1,
        status: 'complete',
        startedAt: new Date().toISOString(),
        writes: [terminalPath],
      }],
    };
    writeRunState(projectDir, created.runId, ownerState);
    const accepted = await tryTerminateOnTerminalState(ownerState, context);
    expect(accepted.decision).toBe('matched');
  });

  it('persists lower-is-better direction at the campaign write/read boundary', () => {
    const root = temporaryRoot();
    const projectDir = join(root, 'project');
    mkdirSync(projectDir);
    setFcGlobalDir(join(root, 'fc-home'));
    const created = createRun(projectDir, 'fixture', 'name: fixture', ['qa']);
    const state = readRunState(projectDir, created.runId);
    state.campaignId = 'lower-is-better';
    state.campaignStorageKey = 'lower-is-better';
    state.research = { baseline: 30, policy: 'best_of_n', higherIsBetter: false };
    state.dispatchedStages = [stage({ id: 'qa', role: 'qa', is_gate: true })];
    state.stages.qa = { status: 'complete', retries: 0 };
    write(join(created.runDirPath, 'stages', 'qa', 'metric.json'), JSON.stringify({
      hasMetric: true,
      metric: 'error_count',
      value: 10,
      higherIsBetter: false,
      threshold: 0,
      pass: false,
    }));
    writeCampaignEntry(projectDir, state);
    const campaignDir = join(projectDir, '.fc', 'campaigns');
    const files = readdirSync(campaignDir);
    expect(files).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(campaignDir, files[0]), 'utf-8')) as CampaignEntry;
    expect(entry.higherIsBetter).toBe(false);
    expect(checkCampaignHealth([
      { ...entry, seq: 1, runId: 'first', score: 30, metric: 'error_count' },
      { ...entry, seq: 2, runId: 'second', score: 20, metric: 'error_count' },
      { ...entry, seq: 3, runId: 'third', score: 10, metric: 'error_count' },
    ], { enabled: true, regressionAfter: 2, plateauAfter: 99, repeatedFailureAfter: 99 })).toBeNull();
  });
});
