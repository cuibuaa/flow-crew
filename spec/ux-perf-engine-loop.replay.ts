import './test-support/policy-runtime.js';
import { readAdapterCapabilityMemory, rememberUnsupportedEffort } from '../src/adapters/diagnose.js';
import { fixtureResult, fixtureArtifactContract } from './test-support/declared-dispatch.js';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import * as codexModule from '../src/adapters/codex.js';
import { captureRepairRoundSnapshot, inspectDispatchAdmission, inspectRealityCheckReachability, parseDispatchedStageConfig, runWorkflow, writeRepairRoundDiffArtifact, type WorkflowConfig } from '../src/scheduler.js';
import * as schedulerModule from '../src/scheduler.js';
import * as workerModule from '../src/worker.js';
import { createRun } from './test-support/create-run.js';
import {
  fcGlobalDir,
  readRunState,
  setFcGlobalDir,
  writeRunState,
  type StageStatus,
} from '../src/store.js';
import { readRunEvents } from '../src/run-events.js';
import { waitForPathEvent } from './test-support/wait-for-path-event.js';
import { recordedEvidence } from './test-support/recorded-evidence.js';
import { parse as parseYaml } from 'yaml';

const roots: string[] = [];
let priorStateRoot: string | undefined;
let priorEnvironment: Record<string, string | undefined> | undefined;

// Namespace lookups keep the file loadable in the frozen base checkout. The
// dedicated unchanged-base seam cases below exercise only APIs that existed at
// the baseline revision; current-only unit cases may use the newly exported
// observability helpers.
const resolveCodexCapabilityIdentity = codexModule.resolveCodexCapabilityIdentity!;
const appendResearchPathContract = schedulerModule.appendResearchPathContract!;
const beginAttemptEvidenceGeneration = workerModule.beginAttemptEvidenceGeneration!;

function temporaryRoot(prefix = 'flowcrew-ux-loop-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const GIT_FIXTURE_SCRIPT = [
  "import { spawnSync } from 'node:child_process';",
  // gc.auto=0: a background `git gc --auto` spawned by a fixture commit can still be writing
  // under .git when afterEach removes the root, which surfaced on CI as ENOTEMPTY.
  'const result = spawnSync(\'git\', [\'-c\', \'gc.auto=0\', ...JSON.parse(process.argv[1])], { encoding: \'utf8\' });',
  'if (result.error) throw result.error;',
  'if (result.status !== 0) { process.stderr.write(result.stderr ?? \'\'); process.exit(result.status ?? 1); }',
].join('\n');

function runFixtureGit(cwd: string, args: string[], isolationRoot: string): void {
  execFileSync(process.execPath, [
    '--input-type=module', '-e', GIT_FIXTURE_SCRIPT, JSON.stringify(args),
  ], {
    cwd,
    env: { ...process.env, HOME: isolationRoot, FC_HOME: isolationRoot },
    stdio: 'pipe',
  });
}

afterEach(() => {
  vi.useRealTimers();
  if (priorStateRoot !== undefined) {
    setFcGlobalDir(priorStateRoot);
    priorStateRoot = undefined;
  }
  if (priorEnvironment) {
    for (const [key, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    priorEnvironment = undefined;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stage(raw: Record<string, unknown>) {
  return parseDispatchedStageConfig({
    artifact_contract: fixtureArtifactContract(String(raw.id), raw.is_gate === true),
    prompt_template: 'bounded replay', skills: [], is_gate: false, criterion_refs: [],
    ...raw,
  });
}

describe('UX/performance engine-loop evidence replays', () => {

  it('item 4: the first proposal remains fail-closed after exact path guidance is supplied', () => {
    const originalMarkdown = recordedEvidence('item4_first_plan_proposal').toString('utf-8');
    // Authored declarations on a working copy; the recorded evidence remains byte-identical.
    const inputs: Record<string, string[]> = {
      terminal_artifacts_are_mutually_exclusive: ['ship_report.md', 'ceiling_report.md', 'escalation_note.md'],
      round_result_and_no_candidate_are_mutually_exclusive: ['round_result.json', 'round_result.json.no_candidate.json'],
      no_candidate_artifact_shape_when_present: ['round_result.json.no_candidate.json'],
      shipped_result_survives_confirmation: ['ship_report.md', 'round_result.json'],
    };
    const markdown = originalMarkdown.replace(/(  - name: ([a-z_]+)\n    type: exec-script-exit-zero\n)/g,
      (line, _prefix: string, name: string) => line + `    reads: ${JSON.stringify(inputs[name].map((path, index) => ({
        id: `input_${index}`, root: 'project', path: `docs/example_explore7/${path}`, source: { kind: 'input' },
      })))}\n`);

    const guided = appendResearchPathContract('plan now', {
      baseline: 0, policy: 'greedy_stack', resultFile: 'docs/example_explore7/round_result.json',
    }, { complete: { paths: ['docs/example_explore7/ship_report.md'] } });
    expect(guided).toContain('docs/example_explore7/round_result.json.no_candidate.json');
    expect(guided).toContain('docs/example_explore7/run_manifest.json');
    expect(guided).toContain('hard check that references docs/example_explore7/round_result.json is still rejected');

    const errors = inspectRealityCheckReachability({
      markdown, projectDir: temporaryRoot(),
      stages: [stage({
        id: 'measure', role: 'coder', scope: ['docs/example_explore7/round_result.json'],
        depends_on: [], dependency_reasons: {},
      })],
      research: {
        baseline: 0,
        policy: 'greedy_stack',
        resultFile: 'docs/example_explore7/round_result.json',
      },
    });
    expect(errors.join('\n')).toContain('writes only its sidecar docs/example_explore7/round_result.json.no_candidate.json');
    expect(errors.join('\n')).not.toContain('framework manifest docs/example_explore7/run_manifest.json');
  });

  it('unchanged-base seam item 4: the first research-stage call receives the resolved universal rule', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-first-research-prompt-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'planner.yaml'), [
      'name: planner', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'first-research-prompt-replay', defaults: { max_iterations: 1, max_retries: 0 },
      research: { baseline: 0, policy: 'greedy_stack', resultFile: 'docs/example/round_result.json' },
      stages: [{ artifact_contract: fixtureArtifactContract('plan', false),
        id: 'plan', role: 'planner', depends_on: [], scope: [],
        prompt_template: 'plan the first research round', skills: [], dynamic_dispatch: false,
        is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['plan']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    initial.research = config.research;
    writeRunState(projectDir, created.runId, initial);
    let firstPrompt = '';
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      firstPrompt ||= prompt;
      return fixtureResult({ output: 'planned', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' }, opts);
    } };

    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    expect(firstPrompt).toContain('docs/example/round_result.json.no_candidate.json');
    expect(firstPrompt).toContain('docs/example/run_manifest.json');
    expect(firstPrompt).toContain('Hard checks must declare inputs that are available');
  }, 15_000);

  it('unchanged-base seam item 6: copied research conditions are rejected at non-research admission with a remedy', () => {
    const rawStages = parseYaml(
      recordedEvidence('item6_copied_dispatch').toString('utf-8'),
    ) as Array<Record<string, unknown>>;
    const report = inspectDispatchAdmission({
      dispatched: rawStages.map((raw) => stage(raw)),
      baseStages: [], dispatchStageId: 'plan',
    });
    expect(report.errors.map(error => error.message).join('\n')).toContain('references framework research facts in a non-research run');
    expect(report.errors.map(error => error.message).join('\n')).toContain('remove the condition or declare research mode');
  });

  it('item 6: the framework namespace stays reserved even if a non-research dispatch names a stage research', () => {
    const report = inspectDispatchAdmission({
      dispatched: [
        stage({ id: 'research', role: 'coder', scope: [], depends_on: [], dependency_reasons: {} }),
        stage({
          id: 'final_complete', role: 'writer', scope: ['docs/final.md'], depends_on: ['research'],
          dependency_reasons: { research: 'copied research-shaped topology' },
          condition: 'research.decision == "ship"',
        }),
      ],
      baseStages: [], dispatchStageId: 'plan',
    });
    expect(report.errors.map(error => error.message).join('\n')).toContain('references framework research facts in a non-research run');
  });

  it('canonical events: an unknown role is refused before an attempt is admitted', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-thrown-attempt-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const config: WorkflowConfig = {
      name: 'thrown-attempt-event-replay', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ artifact_contract: fixtureArtifactContract('work', false),
        id: 'work', role: 'missing_role', depends_on: [], scope: [],
        prompt_template: 'this call must fail before the adapter starts', skills: [],
        dynamic_dispatch: false, is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['work']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    const adapter: Adapter = { async run() {
      throw new Error('adapter must not run for a missing role');
    } };

    const final = await runWorkflow(
      config, 'fixture', projectDir, adapter, new Map(), undefined,
      agentsDir, created.runId, 'replay', true,
    );
    expect(final.status).toBe('failed');
    expect(final.failureReason).toContain('PLAN_REVISION_ROLE_UNKNOWN: work.role missing_role is not configured');
    expect(final.stages.work.status).toBe('pending');
    expect(readRunEvents(projectDir, created.runId).filter((event) => event.type === 'attempt_failed')).toEqual([]);
  }, 15_000);

  it('canonical events: an adapter exception still publishes one attributed attempt failure', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-thrown-adapter-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: coder', 'description: synthetic exception control', 'model: default',
      'reasoning_effort: default', 'tools: []', 'prompt: fixture',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'thrown-adapter-event-replay', description: 'synthetic attributed exception', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [stage({ id: 'work', role: 'coder', depends_on: [], dependency_reasons: {}, scope: [], prompt_template: 'throw inside the admitted attempt' })],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['work']);
    const adapter: Adapter = { async run() { throw new Error('synthetic adapter settlement failure'); } };
    const final = await runWorkflow(
      config, 'fixture', projectDir, adapter, new Map(), undefined,
      agentsDir, created.runId, 'replay', true,
    );
    expect(final.status).toBe('failed');
    const failureEvents = readRunEvents(projectDir, created.runId)
      .filter((event) => event.type === 'attempt_failed' && event.stageId === 'work');
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]).toMatchObject({
      attemptIndex: 1, source: 'scheduler', status: 'failed',
    });
    expect(failureEvents[0].detail).toContain('synthetic adapter settlement failure');
  }, 15_000);

  it('item 11: warm project observations reuse clean identities without reading or hashing bytes', () => {
    const projectDir = temporaryRoot();
    const runDirectory = temporaryRoot('flowcrew-rollback-run-');
    mkdirSync(join(projectDir, 'scoped'), { recursive: true });
    mkdirSync(join(projectDir, 'outside'), { recursive: true });
    writeFileSync(join(projectDir, 'scoped', 'only.txt'), 'scope\n');
    for (let index = 0; index < 3; index++) {
      writeFileSync(join(projectDir, 'outside', `${index}.txt`), `${index}\n`);
    }
    runFixtureGit(projectDir, ['init', '-q'], runDirectory);
    runFixtureGit(projectDir, ['add', '.'], runDirectory);
    runFixtureGit(projectDir, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], runDirectory);
    const scopedStage = stage({
      id: 'work', role: 'coder', scope: ['scoped/only.txt'], depends_on: [], dependency_reasons: {},
    });
    const first = captureRepairRoundSnapshot(projectDir, [scopedStage], { runDirPath: runDirectory });
    const warm = captureRepairRoundSnapshot(projectDir, [scopedStage], { runDirPath: runDirectory });
    expect(first.measurement).toMatchObject({
      baselineInitialized: true, baselineStrategy: 'git-index-plus-dirty-images',
      baselineFilesRead: 0, baselineFilesHashed: 0, baselineBytesRead: 0, baselineBytesHashed: 0,
    });
    expect(warm.measurement).toMatchObject({
      baselineInitialized: false, scopedFilesRead: 0, scopedFilesHashed: 0,
      scopedBytesRead: 0, scopedBytesHashed: 0,
      outsideScopeFilesVisited: 0, outsideScopeFilesRead: 0, outsideScopeFilesHashed: 0,
      outsideScopeBytesVisited: 0, outsideScopeBytesRead: 0, outsideScopeBytesHashed: 0,
      conservativeFallback: false,
    });
  }, 20_000);

  it('item 11: a watcher reliability loss takes the conservative full audit and detects an outside write', () => {
    const projectDir = temporaryRoot();
    const runDirectory = temporaryRoot('flowcrew-rollback-overflow-');
    mkdirSync(join(projectDir, 'scoped'), { recursive: true });
    mkdirSync(join(projectDir, 'outside'), { recursive: true });
    writeFileSync(join(projectDir, 'scoped', 'only.txt'), 'scope\n');
    writeFileSync(join(projectDir, 'outside', 'guarded.txt'), 'before\n');
    runFixtureGit(projectDir, ['init', '-q'], runDirectory);
    runFixtureGit(projectDir, ['add', '.'], runDirectory);
    runFixtureGit(projectDir, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], runDirectory);
    const scopedStage = stage({
      id: 'work', role: 'coder', scope: ['scoped/only.txt'], depends_on: [], dependency_reasons: {},
    });
    const snapshot = captureRepairRoundSnapshot(projectDir, [scopedStage], { runDirPath: runDirectory });
    (snapshot.rollbackBaseline as unknown as { reliable: boolean }).reliable = false;
    writeFileSync(join(projectDir, 'outside', 'guarded.txt'), 'after\n');
    runFixtureGit(projectDir, ['add', 'outside/guarded.txt'], runDirectory);
    runFixtureGit(projectDir, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'move head after baseline'], runDirectory);
    const artifact = writeRepairRoundDiffArtifact({
      snapshot, projectDir, runDirPath: runDirectory, iteration: 1, round: 1,
      repairStages: [scopedStage], statuses: {},
    });
    const parsed = JSON.parse(readFileSync(artifact, 'utf-8')) as { files: Array<{ path: string }> };
    expect(snapshot.measurement.conservativeFallback).toBe(true);
    expect(parsed.files.map((file) => file.path)).toContain('outside/guarded.txt');
  });

  it('item 11: admitted writable content preserves clean, dirty, untracked, deleted, and mode preimages', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-rollback-shapes-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const originals = {
      clean: 'clean committed\n',
      dirty: 'operator dirty bytes\n',
      untracked: 'operator untracked bytes\n',
      deleted: 'restore after delete\n',
      mode: 'restore mode\n',
    };
    for (const [name, contents] of Object.entries({
      clean: originals.clean, dirty: 'dirty committed\n', deleted: originals.deleted, mode: originals.mode,
    })) writeFileSync(join(projectDir, 'src', `${name}.txt`), contents);
    runFixtureGit(projectDir, ['init', '-q'], stateRoot);
    runFixtureGit(projectDir, ['add', '.'], stateRoot);
    runFixtureGit(projectDir, ['-c', 'user.name=FlowCrew Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], stateRoot);
    writeFileSync(join(projectDir, 'src', 'dirty.txt'), originals.dirty);
    writeFileSync(join(projectDir, 'src', 'untracked.txt'), originals.untracked);

    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: coder', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'rollback-shapes-replay', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ artifact_contract: fixtureArtifactContract('work', false),
        id: 'work', role: 'coder', depends_on: [], scope: [], prompt_template: 'mutate outside scope',
        skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['work']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    // A previous writer admission owns rollback for these mutable source files;
    // the later empty-scope stage must still be caught and restored independently.
    const admittedWriter = stage({ id: 'prior_writer', role: 'coder', scope: ['src/**'],
      depends_on: [], dependency_reasons: {} });
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '---\ninputs: [{path: src, frozen: true}]\n---\nKeep `src` frozen.');
    const admitted = captureRepairRoundSnapshot(projectDir, [admittedWriter], { runDirPath: created.runDirPath });
    expect(admitted.files.get('src/dirty.txt')?.backingPath).toBeTruthy();
    expect(admitted.files.get('src/untracked.txt')?.backingPath).toBeTruthy();
    const warm = captureRepairRoundSnapshot(projectDir, [admittedWriter], { runDirPath: created.runDirPath });
    expect(warm.measurement).toMatchObject({ baselineInitialized: false, scopedFilesRead: 0, scopedFilesHashed: 0 });
    const paths = ['src/clean.txt', 'src/dirty.txt', 'src/untracked.txt', 'src/deleted.txt', 'src/mode.txt', 'src/new.txt'];
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      for (const path of paths.slice(0, 3)) writeFileSync(join(projectDir, path), 'unauthorized\n');
      rmSync(join(projectDir, 'src', 'deleted.txt'));
      chmodSync(join(projectDir, 'src', 'mode.txt'), 0o755);
      writeFileSync(join(projectDir, 'src', 'new.txt'), 'unauthorized new\n');
      return fixtureResult({ output: 'mutated', exitCode: 0, duration_ms: 1, writes: paths, writeAttribution: 'structured' }, opts);
    } };

    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    expect(readFileSync(join(projectDir, 'src', 'clean.txt'), 'utf-8')).toBe(originals.clean);
    expect(readFileSync(join(projectDir, 'src', 'dirty.txt'), 'utf-8')).toBe(originals.dirty);
    expect(readFileSync(join(projectDir, 'src', 'untracked.txt'), 'utf-8')).toBe(originals.untracked);
    expect(readFileSync(join(projectDir, 'src', 'deleted.txt'), 'utf-8')).toBe(originals.deleted);
    expect(readFileSync(join(projectDir, 'src', 'mode.txt'), 'utf-8')).toBe(originals.mode);
    expect(statSync(join(projectDir, 'src', 'mode.txt')).mode & 0o777).toBe(0o755);
    expect(() => statSync(join(projectDir, 'src', 'new.txt'))).toThrow();
  }, 20_000);

  it('item 11: a non-Git run captures admitted content once and restores a later task-frozen overwrite', async () => {
    const projectDir = temporaryRoot();
    const stateRoot = temporaryRoot('flowcrew-nongit-rollback-state-');
    priorStateRoot = fcGlobalDir();
    setFcGlobalDir(stateRoot);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'protected.txt'), 'operator preimage\n');
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: coder', 'description: replay', 'model: default', 'reasoning_effort: default',
      'tools: []', 'prompt: replay',
    ].join('\n'));
    const config: WorkflowConfig = {
      name: 'nongit-rollback-replay', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ artifact_contract: fixtureArtifactContract('work', false),
        id: 'work', role: 'coder', depends_on: [], scope: [], prompt_template: 'mutate outside scope',
        skills: [], dynamic_dispatch: false, is_gate: false, criterion_refs: [],
      }],
    };
    const created = createRun(projectDir, config.name, 'fixture', ['work']);
    const initial = readRunState(projectDir, created.runId);
    initial.autoApprove = true;
    writeRunState(projectDir, created.runId, initial);
    const admittedWriter = stage({ id: 'prior_writer', role: 'coder', scope: ['src/protected.txt'],
      depends_on: [], dependency_reasons: {} });
    writeFileSync(join(created.runDirPath, 'task_brief.md'), '---\ninputs: [{path: src, frozen: true}]\n---\nKeep `src` frozen.');
    const admitted = captureRepairRoundSnapshot(projectDir, [admittedWriter], { runDirPath: created.runDirPath });
    expect(admitted.measurement.baselineStrategy).toBe('filesystem-images');
    expect(admitted.files.get('src/protected.txt')?.backingPath).toBeTruthy();
    const warm = captureRepairRoundSnapshot(projectDir, [admittedWriter], { runDirPath: created.runDirPath });
    expect(warm.measurement).toMatchObject({ baselineInitialized: false, scopedFilesRead: 0, scopedFilesHashed: 0,
      scopedBytesRead: 0, scopedBytesHashed: 0 });
    expect(readdirSync(join(created.runDirPath, '.rollback-preimages')).length).toBeGreaterThanOrEqual(1);
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
      writeFileSync(join(projectDir, 'src', 'protected.txt'), 'unauthorized\n');
      return fixtureResult({
        output: 'mutated', exitCode: 0, duration_ms: 1,
        writes: ['src/protected.txt'], writeAttribution: 'structured',
      }, opts);
    } };
    await runWorkflow(config, 'fixture', projectDir, adapter, new Map(), undefined, agentsDir, created.runId, 'replay', true);
    expect(readFileSync(join(projectDir, 'src', 'protected.txt'), 'utf-8')).toBe('operator preimage\n');
  }, 15_000);

  it('items 13–14: capability identity is run-scoped and supervisor static/novel evidence stays stable', () => {
    const runDirectory = temporaryRoot();
    const role = { model: 'gpt-fixture', reasoning_effort: 'ultra' };
    const identity = resolveCodexCapabilityIdentity(role, {
      executable: 'codex', version: 'codex-cli 1.2.3', provider: 'fixture',
      model: role.model, reasoningEffort: role.reasoning_effort,
    });
    rememberUnsupportedEffort(runDirectory, identity, 'codex');
    expect(readAdapterCapabilityMemory(runDirectory, identity, 'codex')?.capability).toBe('reasoning_effort_unsupported');
    expect(readAdapterCapabilityMemory(runDirectory, { ...identity, version: 'codex-cli 2.0.0' }, 'codex')).toBeUndefined();


  });

  it('unchanged-base seam item 13: one diagnosed effort rejection is reused by the next Codex stage in the same run', async () => {
    const root = temporaryRoot('flowcrew-codex-capability-seam-');
    const bin = join(root, 'bin');
    const runDirectory = join(root, 'run');
    const projectDir = join(root, 'project');
    const counter = join(root, 'codex-calls.txt');
    mkdirSync(bin, { recursive: true });
    mkdirSync(runDirectory, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const executable = join(bin, 'codex');
    writeFileSync(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  printf "%s\\n" "codex-fixture 1.0.0"',
      '  exit 0',
      'fi',
      'printf "%s\\n" x >> "$FLOWCREW_CODEX_COUNTER"',
      'if grep -q "^model_reasoning_effort" "$CODEX_HOME/config.toml"; then',
      '  printf "%s\\n" "400 invalid_request: reasoning effort not supported" >&2',
      '  exit 1',
      'fi',
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fixture ok\"}}'",
    ].join('\n'));
    chmodSync(executable, 0o755);
    priorEnvironment = Object.fromEntries(['PATH', 'CODEX_HOME', 'CODEX_PLUGINS_CACHE', 'CODEX_SKILLS_CACHE', 'FLOWCREW_CODEX_COUNTER']
      .map((key) => [key, process.env[key]]));
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.CODEX_HOME = join(root, 'user-codex-home');
    process.env.CODEX_PLUGINS_CACHE = join(root, 'plugins');
    process.env.CODEX_SKILLS_CACHE = join(root, 'skills');
    process.env.FLOWCREW_CODEX_COUNTER = counter;
    const role = {
      name: 'coder', description: 'fixture', model: 'fixture-model', reasoning_effort: 'max',
      tools: [], prompt: 'fixture instructions',
    };
    const adapter = new CodexAdapter();
    for (const [index, stageId] of ['first', 'second'].entries()) {
      const result = await adapter.run('do fixture work', role, {
        timeout_ms: 5_000, workDir: projectDir, runDir: runDirectory, stageId,
        attemptIndex: 1, attemptStartedAt: `2026-09-02T12:00:0${index}.000Z`,
      });
      expect(result).toMatchObject({ exitCode: 0, output: 'fixture ok' });
    }
    expect(readFileSync(counter, 'utf-8').trim().split('\n')).toHaveLength(3);
  }, 15_000);

  it('unchanged-base seam item 16: request handling is watcher-driven with a slow fallback, never a 20 ms loop', () => {
    const worker = readFileSync(join(import.meta.dirname, '..', 'src', 'worker.ts'), 'utf-8');
    expect(worker).toContain("watch(directory, { persistent: false }");
    expect(worker).not.toContain('pollTimeoutExtensionRequests');
  });
});
