import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
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
import { basename, dirname, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Adapter, AgentConfig, RunOpts, RunResult } from '../src/adapters/base.js';
import {
  cmdShipSetupWithDeps,
  type GitWorktreeCreator,
} from '../src/cli-ship-setup.js';
import { cmdEventsWithDeps } from '../src/cli-events.js';
import {
  planRetryRequirement,
  preparePlanRetryCandidate,
  recordPlanRetryRefusal,
} from '../src/plan-retry-monotone.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';
import {
  briefDeclaresNoCandidateOutcome,
  rehearseBriefIsolated,
  type IsolatedRehearsalResult,
} from '../src/rehearse.js';
import {
  inspectDispatchAdmission,
  inspectRealityCheckReachability,
  runWorkflow,
  tryAdvanceResearch,
  type StageConfig,
  type WorkflowConfig,
} from '../src/scheduler.js';
import {
  fcGlobalDir,
  runDir,
  setFcGlobalDir,
  type StoreState,
} from '../src/store.js';
import {
  captureStageArtifactContractPreimages,
  inspectStageArtifactContract,
} from '../src/stage-artifact-contract.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const temporaryRoots: string[] = [];
let isolatedRunStore: string;
let originalRunStore: string;

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(
    tmpdir(),
    `flowcrew-contract-${label}-${randomBytes(4).toString('hex')}-`,
  ));
  temporaryRoots.push(root);
  return root;
}

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function workerAgentDirectory(root: string): string {
  const agents = join(root, 'config', 'agents');
  write(join(agents, 'worker.yaml'), [
    'name: worker',
    'description: isolated contract replay worker',
    'model: default',
    'reasoning_effort: default',
    'tools: []',
    'prompt: execute the isolated replay',
    '',
  ].join('\n'));
  return agents;
}

class CaptureWriter {
  value = '';
  readonly writer = { write: (chunk: string) => { this.value += chunk; } };
}

const inertAdapter: Adapter = {
  async run(): Promise<RunResult> {
    return { output: 'unused', exitCode: 0, duration_ms: 1 };
  },
};

beforeAll(() => {
  originalRunStore = fcGlobalDir();
  isolatedRunStore = temporaryRoot('run-store');
  setFcGlobalDir(isolatedRunStore);
});

afterAll(() => {
  setFcGlobalDir(originalRunStore);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('1 — malformed completed-round recovery and plan refusal evidence', () => {
  it('recovers the exact status/outcome transposition after its work stage completed', async () => {
    const root = temporaryRoot('malformed-round');
    const projectDir = join(root, 'project');
    const runDirectory = join(root, 'run');
    const sidecar = join(projectDir, 'artifacts', 'round.json.no_candidate.json');
    mkdirSync(runDirectory, { recursive: true });
    write(sidecar, JSON.stringify({
      label: 'dose-floor-round',
      status: 'no_candidate',
      reason: 'every measured candidate violated a hard constraint',
    }));
    const completedAt = new Date(Date.now() - 100).toISOString();
    const state = {
      runId: 'malformed-round',
      workflowName: 'research-replay',
      projectDir,
      status: 'running',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      stages: {
        measure: { status: 'complete', retries: 0, completedAt },
      },
      research: {
        baseline: 0.1,
        policy: 'best_of_n',
        resultFile: 'artifacts/round.json',
        reportDir: 'artifacts',
        stop: { maxRounds: 2 },
      },
    } as StoreState;

    const result = await tryAdvanceResearch(state, {
      projectDir,
      runId: state.runId,
      runDirPath: runDirectory,
      iteration: 1,
      adapter: inertAdapter,
    });
    expect(state.stages.measure).toMatchObject({ status: 'complete', completedAt });
    expect(result).toBeNull();
    expect(readJson(join(runDirectory, 'research_round_contract_repair.json'))).toMatchObject({
      kind: 'no_candidate_status_alias',
      fromField: 'status',
      toField: 'outcome',
    });
    expect(existsSync(join(runDirectory, 'research_round_input_error.json'))).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
    expect(readJson(join(runDirectory, 'research_journal.json')).rounds).toEqual([
      expect.objectContaining({ label: 'dose-floor-round', outcome: 'no_candidate' }),
    ]);
    expect(readdirSync(runDirectory).some((name) => /no_candidate_consumed\.json$/.test(name))).toBe(true);
  });

  it('finishes a run from a completed producer that wrote the transposed sidecar', async () => {
    const root = temporaryRoot('malformed-round-finishes');
    const projectDir = join(root, 'project');
    const agentsDir = workerAgentDirectory(root);
    mkdirSync(projectDir, { recursive: true });
    const resultFile = 'artifacts/round.json';
    const sidecar = `${resultFile}.no_candidate.json`;
    const ceilingPath = 'artifacts/ceiling.md';
    const brief = [
      '---',
      'research:',
      '  baseline: 0.1',
      '  policy: best_of_n',
      `  result_file: ${resultFile}`,
      '  report_dir: artifacts',
      '  stop:',
      '    max_rounds: 1',
      'terminal_states:',
      '  ceiling_hit:',
      `    paths: [${ceilingPath}]`,
      '---',
      '# Completed malformed round finish replay',
    ].join('\n');
    const workflow: WorkflowConfig = {
      name: 'malformed-round-finishes',
      defaults: { max_iterations: 2 },
      stages: [{
        id: 'measure',
        role: 'worker',
        depends_on: [],
        dependency_reasons: {},
        scope: [resultFile, sidecar],
        criterion_refs: [],
        prompt_template: 'measure one research round',
        skills: [],
        dynamic_dispatch: false,
        is_gate: false,
      }],
    };
    const adapter: Adapter = {
      async run(_prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        write(join(projectDir, sidecar), JSON.stringify({
          label: 'completed-dose-floor-round',
          status: 'no_candidate',
          reason: 'every measured candidate violated a hard constraint',
        }));
        return {
          output: 'completed 18690 seconds of measurement',
          exitCode: 0,
          duration_ms: 18_690_000,
          writes: [sidecar],
          writeAttribution: 'structured',
        };
      },
    };

    const final = await runWorkflow(
      workflow, stringifyYaml(workflow), projectDir, adapter, new Map(), undefined,
      agentsDir, undefined, brief, true, false,
    );
    const runDirectory = runDir(projectDir, final.runId);

    expect(final.status).toBe('ceiling_hit');
    expect(final.stages.measure).toMatchObject({ status: 'complete', duration_ms: 18_690_000 });
    expect(readJson(join(runDirectory, 'research_round_contract_repair.json'))).toMatchObject({
      kind: 'no_candidate_status_alias',
    });
    expect(readJson(join(runDirectory, 'research_journal.json')).rounds).toEqual([
      expect.objectContaining({ label: 'completed-dose-floor-round', outcome: 'no_candidate' }),
    ]);
    expect(existsSync(join(projectDir, ceilingPath))).toBe(true);
  }, 30_000);

  it('still refuses a sidecar with an empty identity and no reason field', async () => {
    const root = temporaryRoot('malformed-round-control');
    const projectDir = join(root, 'project');
    const runDirectory = join(root, 'run');
    const sidecar = join(projectDir, 'artifacts', 'round.json.no_candidate.json');
    mkdirSync(runDirectory, { recursive: true });
    write(sidecar, JSON.stringify({ label: '', status: 'no_candidate', note: 'not a contract reason' }));
    const state = {
      runId: 'malformed-round-control',
      workflowName: 'research-replay',
      projectDir,
      status: 'running',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      stages: { measure: { status: 'complete', retries: 0 } },
      research: {
        baseline: 0.1,
        policy: 'best_of_n',
        resultFile: 'artifacts/round.json',
        reportDir: 'artifacts',
        stop: { maxRounds: 1 },
      },
    } as StoreState;

    expect(await tryAdvanceResearch(state, {
      projectDir, runId: state.runId, runDirPath: runDirectory, iteration: 1, adapter: inertAdapter,
    })).toBeNull();
    expect(readJson(join(runDirectory, 'research_round_input_error.json'))).toMatchObject({
      kind: 'missing_label',
    });
    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(join(runDirectory, 'research_round_contract_repair.json'))).toBe(false);
  });

  it('still fails when the recovered round is followed by structurally invalid plans', async () => {
    const root = temporaryRoot('malformed-round-replan');
    const projectDir = join(root, 'project');
    const agentsDir = workerAgentDirectory(root);
    mkdirSync(projectDir, { recursive: true });
    const resultFile = 'artifacts/round.json';
    const sidecar = `${resultFile}.no_candidate.json`;
    const terminalPaths = ['artifacts/ship.md', 'artifacts/ceiling.md', 'artifacts/escalation.md'];
    const brief = [
      '---',
      'research:',
      '  baseline: 0.1',
      '  policy: best_of_n',
      `  result_file: ${resultFile}`,
      '  report_dir: artifacts',
      '  stop:',
      '    max_rounds: 2',
      'terminal_states:',
      '  shipped:',
      `    paths: [${terminalPaths[0]}]`,
      '  ceiling_hit:',
      `    paths: [${terminalPaths[1]}]`,
      '  escalated:',
      `    paths: [${terminalPaths[2]}]`,
      '---',
      '# Completed malformed round replay',
    ].join('\n');
    const workflow: WorkflowConfig = {
      name: 'malformed-round-replan',
      defaults: { max_iterations: 2 },
      stages: [{
        id: 'plan',
        role: 'worker',
        depends_on: [],
        dependency_reasons: {},
        scope: [],
        criterion_refs: [],
        prompt_template: 'plan the current research round',
        skills: [],
        dynamic_dispatch: true,
        is_gate: false,
      }],
    };
    let planCalls = 0;
    const planPrompts: string[] = [];
    let measurePrompt = '';
    const adapter: Adapter = {
      async run(prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        if (opts.stageId === 'plan') {
          planCalls += 1;
          planPrompts.push(prompt);
          const stages = planCalls === 1
            ? [
                {
                  id: 'measure', role: 'worker', depends_on: [], dependency_reasons: {},
                  scope: [resultFile, sidecar], criterion_refs: [],
                  prompt_template: 'write exactly one research round artifact',
                },
                ...terminalPaths.map((path, index) => ({
                  id: ['write_ship', 'write_ceiling', 'write_escalation'][index],
                  role: 'worker',
                  depends_on: ['measure'],
                  dependency_reasons: { measure: 'terminal output consumes the completed round' },
                  scope: [path],
                  condition: `research.terminalPath == ${path}`,
                  criterion_refs: [],
                  prompt_template: `write ${path} only when selected`,
                })),
              ]
            : [{
                id: `orphan_round_${planCalls}`,
                role: 'worker',
                depends_on: [],
                dependency_reasons: {},
                scope: [`artifacts/orphan-${planCalls}.txt`],
                criterion_refs: [],
                prompt_template: `invalid recovery proposal ${planCalls}`,
              }];
          writeFileSync(join(opts.runDir, 'dispatch.yaml'), stringifyYaml({ stages }), 'utf8');
          return { output: `plan attempt ${planCalls}`, exitCode: 0, duration_ms: 1 };
        }
        if (opts.stageId === 'measure') {
          measurePrompt = prompt;
          write(join(projectDir, sidecar), JSON.stringify({
            label: 'completed-dose-floor-round',
            status: 'no_candidate',
            reason: 'every measured candidate violated a hard constraint',
          }));
          return {
            output: 'completed 18690 seconds of measurement and wrote the sidecar',
            exitCode: 0,
            duration_ms: 18_690_000,
            writes: [sidecar],
            writeAttribution: 'structured',
          };
        }
        return { output: 'conditional finalizer did not write', exitCode: 0, duration_ms: 1 };
      },
    };

    const final = await runWorkflow(
      workflow,
      stringifyYaml(workflow),
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      undefined,
      brief,
      true,
      false,
    );
    const runDirectory = runDir(projectDir, final.runId);
    const retryState = readJson(join(runDirectory, 'plan_retry_state.json'));
    const events = readFileSync(join(runDirectory, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>);

    expect(planCalls).toBe(5);
    expect(planPrompts[0]).toContain('# Engine admission contract for this proposal (pre-submit)');
    for (const terminalPath of terminalPaths) {
      expect(planPrompts[0]).toContain(`${terminalPath} — exactly one scoped non-gate, non-repair DAG sink owner`);
    }
    expect(measurePrompt).toContain('the discriminator field is outcome, not status');
    expect(final.status).toBe('failed');
    expect(final.stageEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        iteration: 1,
        stageId: 'measure',
        status: expect.objectContaining({ status: 'complete', duration_ms: 18_690_000 }),
      }),
    ]));
    expect(existsSync(join(runDirectory, 'research_round_input_error.json'))).toBe(false);
    expect(readJson(join(runDirectory, 'research_round_contract_repair.json'))).toMatchObject({
      kind: 'no_candidate_status_alias',
    });
    expect(readJson(join(runDirectory, 'research_journal.json')).rounds).toEqual([
      expect.objectContaining({ label: 'completed-dose-floor-round', outcome: 'no_candidate' }),
    ]);
    expect(events.filter((event) => event.type === 'plan_dispatch_retry')).toHaveLength(2);
    expect(retryState.attempts).toHaveLength(3);
    expect(retryState.attempts.every((attempt: Record<string, any>) => (
      attempt.unsatisfied.filter((item: Record<string, unknown>) => (
        String(item.detail).includes('expected exactly one scoped owner, found 0')
      )).length === 3
    ))).toBe(true);
  }, 60_000);

  it('calibrates the ingestion instrument with a structurally different measured artifact', async () => {
    const root = temporaryRoot('measured-control');
    const projectDir = join(root, 'project');
    const runDirectory = join(root, 'run');
    mkdirSync(runDirectory, { recursive: true });
    write(join(projectDir, 'artifacts', 'round.json'), JSON.stringify({
      label: 'independent-measurement',
      result: 0.12,
    }));
    const state = {
      runId: 'measured-control',
      workflowName: 'research-replay',
      projectDir,
      status: 'running',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      stages: { measure: { status: 'complete', retries: 0 } },
      research: {
        baseline: 0.1,
        policy: 'best_of_n',
        resultFile: 'artifacts/round.json',
        reportDir: 'artifacts',
        stop: { maxRounds: 2 },
      },
    } as StoreState;

    await tryAdvanceResearch(state, {
      projectDir,
      runId: state.runId,
      runDirPath: runDirectory,
      iteration: 1,
      adapter: inertAdapter,
    });

    expect(readJson(join(runDirectory, 'research_journal.json')).rounds).toEqual([
      expect.objectContaining({ label: 'independent-measurement', outcome: 'measured', result: 0.12 }),
    ]);
    expect(existsSync(join(runDirectory, 'research_round_1_consumed.json'))).toBe(true);
    expect(existsSync(join(runDirectory, 'research_round_input_error.json'))).toBe(false);
  });

  it('enumerates terminal-owner cardinalities zero, one, and three through admission', () => {
    const terminalPaths = ['artifacts/ship.md', 'artifacts/ceiling.md', 'artifacts/escalation.md'];
    const stage = (id: string, scope: string[]): StageConfig => ({
      id,
      role: 'worker',
      depends_on: [],
      dependency_reasons: {},
      scope,
      prompt_template: `produce ${id}`,
      skills: [],
      dynamic_dispatch: false,
      is_gate: false,
      criterion_refs: [],
    });
    const terminalStates = {
      shipped: { paths: [terminalPaths[0]] },
      ceiling_hit: { paths: [terminalPaths[1]] },
      escalated: { paths: [terminalPaths[2]] },
    };
    const zero = inspectDispatchAdmission({
      dispatched: [stage('execute_round', ['artifacts/round.json'])],
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates,
    });
    const one = inspectDispatchAdmission({
      dispatched: [stage('write_terminal', terminalPaths)],
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates,
    });
    const many = inspectDispatchAdmission({
      dispatched: [
        stage('execute_round', terminalPaths),
        stage('repair_round', terminalPaths),
        stage('write_ship', terminalPaths),
      ],
      baseStages: [],
      dispatchStageId: 'plan',
      terminalStates,
    });

    expect(zero.errors.filter((error) => error.includes('expected exactly one scoped owner, found 0')))
      .toHaveLength(3);
    expect(one).toMatchObject({ pass: true, errors: [] });
    expect(many.errors.filter((error) => (
      error.includes('expected exactly one scoped owner, found 3 (execute_round, repair_round, write_ship)')
    ))).toHaveLength(3);
    expect([zero, one, many].reduce<Record<string, number>>((counts, report) => {
      const disposition = report.pass ? 'admitted' : 'refused';
      counts[disposition] = (counts[disposition] ?? 0) + 1;
      return counts;
    }, {})).toEqual({ refused: 2, admitted: 1 });
  });

  it('refuses a reality check whose run-store path has no admitted producer', () => {
    const root = temporaryRoot('unowned-check');
    const errors = inspectRealityCheckReachability({
      markdown: [
        '## Reality checks',
        '',
        stringifyYaml({
          checks: [{
            name: 'historical-run-evidence',
            type: 'file-exists-nonempty',
            params: { paths: ['.fc/runs/prior/evidence.json'] },
          }],
        }),
      ].join('\n'),
      projectDir: root,
      stages: [],
      terminalStates: {},
    });

    expect(errors).toEqual([
      'reality check "historical-run-evidence" references absent .fc/runs/prior/evidence.json, but no admitted stage or framework emitter owns it',
    ]);
  });

  it('calibrates a non-repeating retry ledger that reports its final causal refusal', () => {
    const root = temporaryRoot('retry-summary');
    const dispatchPath = join(root, 'dispatch.yaml');
    const dispatches = ['first', 'second', 'third'].map((label) => stringifyYaml({
      stages: [{
        id: `work_${label}`,
        role: 'worker',
        depends_on: [],
        dependency_reasons: {},
        scope: [`artifacts/${label}.txt`],
        criterion_refs: [],
        prompt_template: label,
      }],
    }));
    const observations = [
      [
        planRetryRequirement('terminal_states path artifacts/ship.md: expected exactly one scoped owner, found 0'),
        planRetryRequirement('terminal_states path artifacts/ceiling.md: expected exactly one scoped owner, found 0'),
        planRetryRequirement('terminal_states path artifacts/escalation.md: expected exactly one scoped owner, found 0'),
      ],
      [planRetryRequirement('reality check "run-history" references absent .fc/runs/prior/evidence.json, but no admitted stage or framework emitter owns it')],
      [planRetryRequirement('reality check "run-history" references absent .fc/runs/prior/evidence.json, but no admitted stage or framework emitter owns it')],
    ];
    let terminalReason = '';
    observations.forEach((unsatisfied, index) => {
      writeFileSync(dispatchPath, dispatches[index], 'utf8');
      const prepared = preparePlanRetryCandidate({
        runDirPath: root,
        stageId: 'plan',
        iteration: 1,
        attemptIndex: index + 1,
      });
      const recorded = recordPlanRetryRefusal({
        runDirPath: root,
        prepared,
        maxAttempts: 3,
        unsatisfied,
        stopOnRepeat: false,
      });
      terminalReason = recorded.reason ?? terminalReason;
    });

    expect(terminalReason).toContain('reality-check:run-history');
    expect(terminalReason).toContain('.fc/runs/prior/evidence.json');
    expect(terminalReason).not.toContain('terminal-owner:artifacts/ship.md');
    expect(readJson(join(root, 'plan_retry_state.json')).attempts).toHaveLength(3);
  });

  it('replays three refused planner proposals and reports the final causal refusal', async () => {
    const root = temporaryRoot('scheduler-retry-summary');
    const projectDir = join(root, 'project');
    const agentsDir = workerAgentDirectory(root);
    mkdirSync(projectDir, { recursive: true });
    const terminalPaths = ['artifacts/ship.md', 'artifacts/ceiling.md', 'artifacts/escalation.md'];
    const brief = [
      '---',
      'terminal_states:',
      '  shipped:',
      `    paths: [${terminalPaths[0]}]`,
      '  ceiling_hit:',
      `    paths: [${terminalPaths[1]}]`,
      '  escalated:',
      `    paths: [${terminalPaths[2]}]`,
      '---',
      '# Planner refusal replay',
      '',
      'The required historical evidence artifact is `.fc/runs/prior/evidence.json`.',
    ].join('\n');
    const workflow: WorkflowConfig = {
      name: 'planner-refusal-replay',
      defaults: { max_iterations: 1 },
      stages: [{
        id: 'plan',
        role: 'worker',
        depends_on: [],
        dependency_reasons: {},
        scope: [],
        criterion_refs: [],
        prompt_template: 'write the next bounded proposal',
        skills: [],
        dynamic_dispatch: true,
        is_gate: false,
      }],
    };
    let planCalls = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        if (opts.stageId !== 'plan') return { output: 'unexpected work stage', exitCode: 0, duration_ms: 1 };
        planCalls += 1;
        const stages = ['execute_round', 'repair_round', 'write_ship'].map((id) => ({
          id,
          role: 'worker',
          depends_on: id === 'execute_round' ? ['repair_round', 'write_ship'] : [],
          dependency_reasons: id === 'execute_round'
            ? {
                repair_round: 'the sole terminal writer consumes the completed repair',
                write_ship: 'the sole terminal writer consumes the completed report body',
              }
            : {},
          scope: planCalls === 1 || id === 'execute_round' ? terminalPaths : [],
          criterion_refs: [],
          prompt_template: `produce ${id}`,
        }));
        writeFileSync(join(opts.runDir, 'dispatch.yaml'), stringifyYaml({ stages }), 'utf8');
        writeFileSync(join(opts.runDir, 'reality_checks.md'), [
          '## Reality checks',
          '',
          '```yaml',
          stringifyYaml({
            checks: [{
              name: 'run-history',
              type: 'file-exists-nonempty',
              params: { paths: ['.fc/runs/prior/evidence.json'] },
            }],
          }).trimEnd(),
          '```',
          '',
        ].join('\n'), 'utf8');
        return { output: `plan attempt ${planCalls}`, exitCode: 0, duration_ms: 1 };
      },
    };

    const final = await runWorkflow(
      workflow,
      stringifyYaml(workflow),
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      undefined,
      brief,
      true,
      false,
    );
    const runDirectory = runDir(projectDir, final.runId);
    const retryState = readJson(join(runDirectory, 'plan_retry_state.json'));
    const events = readFileSync(join(runDirectory, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>);
    const retryEvents = events.filter((event) => event.type === 'plan_dispatch_retry');

    expect(planCalls).toBe(3);
    expect(final.status).toBe('failed');
    expect(retryEvents.map((event) => event.detail)).toEqual([
      expect.stringContaining('1/2'),
      expect.stringContaining('2/2'),
    ]);
    expect(retryState.attempts[0].unsatisfied.filter((item: Record<string, unknown>) => (
      String(item.detail).includes('expected exactly one scoped owner, found 3')
    ))).toHaveLength(3);
    expect(retryState.attempts[1].unsatisfied).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining('references absent .fc/runs/prior/evidence.json'),
      }),
    ]);
    expect(retryState.attempts[2].unsatisfied).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining('references absent .fc/runs/prior/evidence.json'),
      }),
    ]);
    expect(final.failureReason).toContain('reality-check:run-history');
    expect(final.failureReason).not.toContain('terminal-owner:artifacts/ship.md');
  }, 60_000);
});

interface RehearsalObservation {
  target: number;
  result: IsolatedRehearsalResult;
  run: Record<string, any>;
  journal: Record<string, any>;
  runFiles: string[];
  noCandidateRun: Record<string, any>;
  noCandidateJournal: Record<string, any>;
  noCandidateRunFiles: string[];
}

const rehearsalObservations: RehearsalObservation[] = [];

function boundedResearchBrief(target: number, baseline: number): string {
  return [
    '---',
    'research:',
    `  baseline: ${baseline}`,
    '  policy: greedy_stack',
    '  higher_is_better: true',
    '  result_file: artifacts/round.json',
    '  report_dir: artifacts',
    '  result_schema:',
    '    type: object',
    '    required: [label, result]',
    '    properties:',
    '      label: {type: string}',
    '      result: {type: number, minimum: -0.3, maximum: 0.3}',
    '  confirm:',
    '    command: node -e "process.exit(1)"',
    '    requires: the synthetic ship candidate must be rejected independently',
    '  stop:',
    `    beat: ${target}`,
    '    max_rounds: 4',
    '    halt_after_no_improvement: 1',
    'terminal_states:',
    '  shipped:',
    '    paths: [artifacts/ship.md]',
    '  ceiling_hit:',
    '    paths: [artifacts/ceiling.md]',
    '    floor:',
    '      min_attempted_stages: 1',
    '---',
    '# Bounded outcome rehearsal',
    '',
    '## Declared outcomes',
    '',
    '- Ship after a confirmed threshold-crossing measured round.',
    '- Emit `outcome: no_candidate` when no safe acting candidate exists.',
    '- Finish at the ceiling after the declared stopping rule.',
    '',
    '## What the report must show',
    '',
    '1. Record which declared outcome was exercised and name its durable evidence.',
    '',
    '## Round contract',
    '',
    'Write either the measured result object or the mutually exclusive no-candidate sidecar.',
    '',
  ].join('\n');
}

function pairedBoundedResearchBrief(): string {
  return boundedResearchBrief(0.05, 0.04)
    .replace('required: [label, result]', 'required: [label, result, result_std]')
    .replace(
      '      result: {type: number, minimum: -0.3, maximum: 0.3}',
      [
        '      result: {type: number, minimum: -0.3, maximum: 0.3}',
        '      result_std: {type: number, minimum: 0.001, maximum: 0.3}',
        '  integrity:',
        '    max_std_ratio: 1',
      ].join('\n'),
    )
    .replace('    halt_after_no_improvement: 1', [
      '    halt_after_no_improvement: 1',
      '    improvement_se_multiple: 1',
    ].join('\n'));
}

describe('2 and 3 — declared rehearsal outcomes and bounded ship probes', () => {
  beforeAll(async () => {
    for (const [target, baseline] of [[0.05, 0.04], [0.2, 0.15]] as const) {
      const result = await rehearseBriefIsolated(boundedResearchBrief(target, baseline), {
        projectDir: temporaryRoot(`rehearsal-input-${String(target).replace('.', '-')}`),
        keep: true,
        label: `bounded-target-${target}`,
      });
      if (!result.retainedArtifacts || !result.retainedOutcomeArtifacts?.no_candidate) {
        throw new Error(`rehearsal ${target} did not retain all outcome artifacts`);
      }
      const runDirectory = result.retainedArtifacts.runDir;
      const noCandidate = result.retainedOutcomeArtifacts.no_candidate;
      rehearsalObservations.push({
        target,
        result,
        run: readJson(join(runDirectory, 'run.json')),
        journal: readJson(join(runDirectory, 'research_journal.json')),
        runFiles: readdirSync(runDirectory),
        noCandidateRun: readJson(join(noCandidate.runDir, 'run.json')),
        noCandidateJournal: readJson(join(noCandidate.runDir, 'research_journal.json')),
        noCandidateRunFiles: readdirSync(noCandidate.runDir),
      });
      temporaryRoots.push(result.retainedArtifacts.projectDir);
      temporaryRoots.push(noCandidate.projectDir);
      temporaryRoots.push(dirname(dirname(runDirectory)));
      temporaryRoots.push(dirname(result.diagnosticsLogPath));
    }
  }, 120_000);

  it('writes, journals, and consumes the declared no-candidate outcome', () => {
    for (const observation of rehearsalObservations) {
      expect(observation.result.exitCode).toBe(0);
      expect(observation.noCandidateJournal.rounds).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'rehearse_no_candidate', outcome: 'no_candidate' }),
      ]));
      expect(observation.noCandidateRunFiles.some((name) => /no_candidate_consumed\.json$/.test(name))).toBe(true);
    }
    const outcomes = rehearsalObservations.flatMap((observation) => (
      observation.noCandidateJournal.rounds.map((round: Record<string, unknown>) => round.outcome)
    ));
    expect(outcomes.filter((outcome) => outcome === 'no_candidate')).toHaveLength(2);
  });

  it('enumerates and exercises ship proposal, no-candidate ingestion, and ceiling settlement', () => {
    const observations = rehearsalObservations.map((observation) => ({
      target: observation.target,
      shipped: observation.journal.rounds.some((round: Record<string, unknown>) => (
        String(round.label).includes('decoy') && round.confirmFailed === true
      )) && observation.runFiles.includes('research_confirm.json'),
      no_candidate: observation.noCandidateJournal.rounds.some((round: Record<string, unknown>) => (
        round.outcome === 'no_candidate'
      )),
      ceiling_hit: observation.run.status === 'ceiling_hit'
        && existsSync(join(observation.result.retainedArtifacts!.projectDir, 'artifacts', 'ceiling.md')),
    }));

    expect(observations).toEqual([
      { target: 0.05, shipped: true, no_candidate: true, ceiling_hit: true },
      { target: 0.2, shipped: true, no_candidate: true, ceiling_hit: true },
    ]);
  });

  it('uses an admitted threshold crossing and executes confirm at both bounded targets', () => {
    for (const observation of rehearsalObservations) {
      const texts = observation.result.findings.map((finding) => finding.text);
      expect(observation.journal.rounds.some((round: Record<string, unknown>) => (
        String(round.label).includes('decoy')
      ))).toBe(true);
      expect(observation.runFiles).toContain('research_confirm.json');
      expect(texts).not.toContain('The decoy round is missing from the journal — the ship path was not exercised');
      expect(texts).not.toContain('Confirm was never executed — a ship decision may never have been proposed');
      expect(readJson(join(observation.result.retainedArtifacts!.runDir, 'research_confirm.json')))
        .toMatchObject({ pass: false });
    }
    expect(rehearsalObservations.map(({ target, journal }) => ({
      target,
      mild: journal.rounds.find((round: Record<string, unknown>) => (
        round.label === 'rehearse_r1_mild'
      ))?.result,
    }))).toEqual([
      { target: 0.05, mild: 0.045 },
      { target: 0.2, mild: 0.175 },
    ]);
    expect(rehearsalObservations.map(({ target, journal }) => ({
      target,
      decoy: journal.rounds.find((round: Record<string, unknown>) => (
        round.label === 'rehearse_r2_decoy'
      ))?.result,
    }))).toEqual([
      { target: 0.05, decoy: 0.05 },
      { target: 0.2, decoy: 0.2 },
    ]);
    expect(rehearsalObservations.map(({ target, run }) => ({ target, status: run.status }))).toEqual([
      { target: 0.05, status: 'ceiling_hit' },
      { target: 0.2, status: 'ceiling_hit' },
    ]);
  });

  it('does not synthesize a no-candidate probe for a brief that declares only measured outcomes', async () => {
    const brief = boundedResearchBrief(0.05, 0.04)
      .replace('- Emit `outcome: no_candidate` when no safe acting candidate exists.\n', '')
      .replace('Write either the measured result object or the mutually exclusive no-candidate sidecar.', 'Write the measured result object.');
    const result = await rehearseBriefIsolated(brief, {
      projectDir: temporaryRoot('rehearsal-no-no-candidate-input'),
      keep: true,
      label: 'no-no-candidate-declaration',
    });
    if (!result.retainedArtifacts) throw new Error('control rehearsal did not retain artifacts');
    temporaryRoots.push(result.retainedArtifacts.projectDir);
    temporaryRoots.push(dirname(dirname(result.retainedArtifacts.runDir)));
    temporaryRoots.push(dirname(result.diagnosticsLogPath));

    expect(result.exitCode).toBe(0);
    expect(result.retainedOutcomeArtifacts?.no_candidate).toBeUndefined();
    expect(result.findings.some((finding) => finding.text.includes('Declared outcome no_candidate exercised'))).toBe(false);
  }, 60_000);

  it('does not mistake explicit no-candidate prohibitions for outcome declarations', async () => {
    const negatedDeclaration = 'No no-candidate outcome is declared. Do not emit outcome: no_candidate; measured results only.';
    const brief = boundedResearchBrief(0.05, 0.04)
      .replace('- Emit `outcome: no_candidate` when no safe acting candidate exists.', negatedDeclaration)
      .replace('Write either the measured result object or the mutually exclusive no-candidate sidecar.', 'Write the measured result object.');
    expect(briefDeclaresNoCandidateOutcome(brief)).toBe(false);
    expect(briefDeclaresNoCandidateOutcome(boundedResearchBrief(0.05, 0.04))).toBe(true);
    expect([
      'Emit outcome: no_candidate when no safe acting candidate exists.',
      'Write a no-candidate sidecar when every candidate is unsafe.',
      'No no-candidate outcome is declared.',
      'Do not emit outcome: no_candidate.',
      'Measured results only.',
    ].map(briefDeclaresNoCandidateOutcome)).toEqual([true, true, false, false, false]);

    const result = await rehearseBriefIsolated(brief, {
      projectDir: temporaryRoot('rehearsal-negated-no-candidate-input'),
      keep: true,
      label: 'negated-no-candidate-declaration',
    });
    if (!result.retainedArtifacts) throw new Error('negated-declaration rehearsal did not retain artifacts');
    temporaryRoots.push(result.retainedArtifacts.projectDir);
    temporaryRoots.push(dirname(dirname(result.retainedArtifacts.runDir)));
    temporaryRoots.push(dirname(result.diagnosticsLogPath));

    expect(result.exitCode).toBe(0);
    expect(result.retainedOutcomeArtifacts?.no_candidate).toBeUndefined();
    expect(result.findings.some((finding) => finding.text.includes('Declared outcome no_candidate exercised'))).toBe(false);
  }, 60_000);

  it('uses a schema-valid uncertainty payload to exercise ship and confirm for a paired metric', async () => {
    const result = await rehearseBriefIsolated(pairedBoundedResearchBrief(), {
      projectDir: temporaryRoot('rehearsal-paired-spread-input'),
      keep: true,
      label: 'paired-spread-ship-probe',
    });
    if (!result.retainedArtifacts) throw new Error('paired rehearsal did not retain artifacts');
    temporaryRoots.push(result.retainedArtifacts.projectDir);
    temporaryRoots.push(dirname(dirname(result.retainedArtifacts.runDir)));
    temporaryRoots.push(dirname(result.diagnosticsLogPath));
    if (result.retainedOutcomeArtifacts?.no_candidate) {
      temporaryRoots.push(result.retainedOutcomeArtifacts.no_candidate.projectDir);
    }
    const journal = readJson(join(result.retainedArtifacts.runDir, 'research_journal.json'));
    const texts = result.findings.map((finding) => finding.text);

    expect(result.exitCode).toBe(0);
    expect(journal.rounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'rehearse_r1_mild', result: 0.045, resultStd: 0.001 }),
      expect.objectContaining({ label: 'rehearse_r2_decoy', result: 0.05, resultStd: 0.001, confirmFailed: true }),
    ]));
    expect(existsSync(join(result.retainedArtifacts.runDir, 'research_confirm.json'))).toBe(true);
    expect(texts).not.toContain('The decoy round is missing from the journal — the ship path was not exercised');
    expect(texts).not.toContain('Confirm was never executed — a ship decision may never have been proposed');
  }, 60_000);

  it('reports a bounded target with no admissible crossing instead of emitting permanent ship warnings', async () => {
    const result = await rehearseBriefIsolated(boundedResearchBrief(0.5, 0.1), {
      projectDir: temporaryRoot('rehearsal-unreachable-target-input'),
      keep: true,
      label: 'unreachable-bounded-target',
    });
    if (!result.retainedArtifacts) throw new Error('bounded control rehearsal did not retain artifacts');
    temporaryRoots.push(result.retainedArtifacts.projectDir);
    if (result.retainedOutcomeArtifacts?.no_candidate) {
      temporaryRoots.push(result.retainedOutcomeArtifacts.no_candidate.projectDir);
    }
    temporaryRoots.push(dirname(dirname(result.retainedArtifacts.runDir)));
    temporaryRoots.push(dirname(result.diagnosticsLogPath));
    const texts = result.findings.map((finding) => finding.text);

    expect(texts).toContain('No schema- and integrity-valid value can cross the declared ship target 0.5; the ship outcome is not exercisable by this brief');
    expect(texts).not.toContain('The decoy round is missing from the journal — the ship path was not exercised');
    expect(texts).not.toContain('Confirm was never executed — a ship decision may never have been proposed');
  }, 60_000);
});

describe('4 — environment refusal precedence', () => {
  function runBackgroundQuick(root: string, brief = '# Goal\nProbe.\n', acknowledge = false) {
    const bin = join(root, 'bin');
    const home = join(root, 'home');
    const fcHome = join(root, 'fc-home');
    const codexHome = join(root, 'codex-home');
    const project = join(root, 'project');
    for (const path of [bin, home, fcHome, codexHome, project]) mkdirSync(path, { recursive: true });
    const nodeLink = join(bin, basename(process.execPath));
    if (!existsSync(nodeLink)) symlinkSync(process.execPath, nodeLink);
    return spawnSync(
      process.execPath,
      [
        '--import', 'tsx', join(PROJECT_ROOT, 'src', 'cli.ts'), 'quick', '--background',
        '--project', project,
        ...(acknowledge ? ['--acknowledge-brief-warnings'] : []),
        '-',
      ],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PATH: bin,
          HOME: home,
          FC_HOME: fcHome,
          CODEX_HOME: codexHome,
          NO_COLOR: '1',
        },
        input: brief,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
  }

  const criterionBearingBrief = [
    '# Goal',
    'Probe.',
    '',
    '## What the report must show',
    '',
    '1. Report the directly observed probe result.',
    '',
  ].join('\n');

  it('current main names the missing adapter before the zero-criteria refusal', () => {
    const root = temporaryRoot('adapter-absent');
    const result = runBackgroundQuick(root);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain('No adapter CLI is installed or visible on PATH.');
    expect(output).toContain('npm i -g @openai/codex');
    expect(output).not.toContain('Launch refused: the exact brief has no structurally extractable criterion');
  });

  it('keeps the zero-criteria refusal when an adapter executable is visible', () => {
    const root = temporaryRoot('adapter-present');
    const codex = join(root, 'bin', 'codex');
    write(codex, '#!/bin/sh\nexit 0\n');
    chmodSync(codex, 0o755);
    const result = runBackgroundQuick(root);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(output).toContain('Launch refused: the exact brief has no structurally extractable criterion');
    expect(output).not.toContain('No adapter CLI is installed or visible on PATH.');
  });

  it('keeps the environment refusal first when the same adapter-free launch has a criterion', () => {
    const root = temporaryRoot('adapter-absent-with-criterion');
    const result = runBackgroundQuick(root, criterionBearingBrief, true);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain('No adapter CLI is installed or visible on PATH.');
    expect(output).not.toContain('no structurally extractable criterion');
  });

  it('passes both precedence refusals when an adapter and a criterion are present', () => {
    const root = temporaryRoot('adapter-present-with-criterion');
    const codex = join(root, 'bin', 'codex');
    write(codex, '#!/bin/sh\nexit 0\n');
    chmodSync(codex, 0o755);
    const result = runBackgroundQuick(root, criterionBearingBrief, true);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(output).toContain('no exact setup record exists');
    expect(output).not.toContain('No adapter CLI is installed or visible on PATH.');
    expect(output).not.toContain('no structurally extractable criterion');
  });
});

describe('5 — violation path at durable and human event layers', () => {
  it('retains the path in both JSON and the published human event row', async () => {
    const root = temporaryRoot('event-path');
    const runsRoot = join(root, 'runs');
    const runId = 'violation-event';
    const runDirectory = join(runsRoot, runId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'run.json'), JSON.stringify({
      runId,
      projectDir: join(root, 'project'),
      workflowName: 'event-replay',
      status: 'failed',
      stages: {},
      startedAt: '2030-01-01T00:00:00.000Z',
    }));
    writeFileSync(join(runDirectory, 'events.jsonl'), `${JSON.stringify({
      type: 'live_constraint_violation',
      runId,
      timestamp: '2030-01-01T00:00:01.000Z',
      stageId: 'writer',
      attemptIndex: 1,
      files: ['src/restored.ts'],
      detail: 'the concurrent batch observed a write outside every admitted scope partition; live enforcement restored its preimage before the invocation ended',
      source: 'scheduler',
      level: 'warning',
    })}\n`);
    const human = new CaptureWriter();
    const humanErr = new CaptureWriter();
    const json = new CaptureWriter();
    const jsonErr = new CaptureWriter();

    expect(await cmdEventsWithDeps(['events', '--run', runId], {
      runsRoot,
      stdout: human.writer,
      stderr: humanErr.writer,
    })).toBe(0);
    expect(await cmdEventsWithDeps(['events', '--run', runId, '--json'], {
      runsRoot,
      stdout: json.writer,
      stderr: jsonErr.writer,
    })).toBe(0);
    const durable = JSON.parse(json.value.trim()) as Record<string, any>;

    expect(humanErr.value).toBe('');
    expect(jsonErr.value).toBe('');
    expect(durable).toMatchObject({
      type: 'live_constraint_violation',
      files: ['src/restored.ts'],
    });
    expect(human.value).toContain('live_constraint_violation');
    expect(human.value).toContain('restored its preimage');
    expect(human.value).toContain('paths=src/restored.ts');
  });

  it('does not invent a path for a legacy violation event whose durable row has none', async () => {
    const root = temporaryRoot('event-path-control');
    const runsRoot = join(root, 'runs');
    const runId = 'pathless-violation-event';
    const runDirectory = join(runsRoot, runId);
    mkdirSync(runDirectory, { recursive: true });
    write(join(runDirectory, 'run.json'), JSON.stringify({
      runId, projectDir: join(root, 'project'), status: 'failed', stages: {}, startedAt: '2030-01-01T00:00:00.000Z',
    }));
    write(join(runDirectory, 'events.jsonl'), `${JSON.stringify({
      type: 'live_constraint_violation',
      runId,
      timestamp: '2030-01-01T00:00:01.000Z',
      detail: 'legacy event predates path capture',
    })}\n`);
    const human = new CaptureWriter();
    const stderr = new CaptureWriter();

    expect(await cmdEventsWithDeps(['events', '--run', runId], {
      runsRoot, stdout: human.writer, stderr: stderr.writer,
    })).toBe(0);
    expect(stderr.value).toBe('');
    expect(human.value).toContain('legacy event predates path capture');
    expect(human.value).not.toContain('paths=');
  });

  it('projects a real restored out-of-scope write with the path shown by its durable events', async () => {
    const root = temporaryRoot('live-event-path');
    const projectDir = join(root, 'project');
    const agentsDir = workerAgentDirectory(root);
    mkdirSync(projectDir, { recursive: true });
    const workflow: WorkflowConfig = {
      name: 'live-event-path-replay',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'writer',
        role: 'worker',
        depends_on: [],
        dependency_reasons: {},
        scope: ['src/allowed.ts'],
        criterion_refs: [],
        prompt_template: 'write only the admitted source path',
        skills: [],
        dynamic_dispatch: false,
        is_gate: false,
      }],
    };
    const violatingPath = 'src/restored.ts';
    let invocations = 0;
    const adapter: Adapter = {
      async run(_prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        invocations += 1;
        write(join(projectDir, violatingPath), `export const attempt = ${invocations};\n`);
        const deadline = Date.now() + 1_500;
        while (existsSync(join(projectDir, violatingPath)) && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        return {
          output: 'wrote outside the admitted scope',
          exitCode: 0,
          duration_ms: 1,
          writes: [violatingPath],
          writeAttribution: 'structured',
        };
      },
    };
    const final = await runWorkflow(
      workflow,
      stringifyYaml(workflow),
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      undefined,
      '# Live constraint path replay',
      true,
      false,
    );
    const runDirectory = runDir(projectDir, final.runId);
    const durableEvents = readFileSync(join(runDirectory, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.type === 'live_constraint_violation');
    const human = new CaptureWriter();
    const humanErr = new CaptureWriter();
    const json = new CaptureWriter();
    const jsonErr = new CaptureWriter();

    expect(await cmdEventsWithDeps(['events', '--run', final.runId], {
      runsRoot: dirname(runDirectory),
      stdout: human.writer,
      stderr: humanErr.writer,
    })).toBe(0);
    expect(await cmdEventsWithDeps(['events', '--run', final.runId, '--json'], {
      runsRoot: dirname(runDirectory),
      stdout: json.writer,
      stderr: jsonErr.writer,
    })).toBe(0);
    const jsonEvents = json.value.trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.type === 'live_constraint_violation');

    expect(final.status).toBe('failed');
    expect(invocations).toBe(2);
    expect(existsSync(join(projectDir, violatingPath))).toBe(false);
    expect(durableEvents).toHaveLength(2);
    expect(durableEvents.every((event) => event.files?.includes(violatingPath))).toBe(true);
    expect(jsonEvents).toEqual(durableEvents);
    expect(humanErr.value).toBe('');
    expect(jsonErr.value).toBe('');
    const humanViolationRows = human.value.split('\n')
      .filter((line) => line.includes('live_constraint_violation'));
    expect(humanViolationRows).toHaveLength(2);
    expect(humanViolationRows.every((line) => line.includes(`paths=${violatingPath}`))).toBe(true);
  }, 30_000);
});

describe('6 — prompt-named artifacts and report-published commands', () => {
  it('extracts unquoted exact filenames and distinguishes fresh production from a stale preimage', () => {
    const root = temporaryRoot('artifact-production-provenance');
    const projectDir = join(root, 'project');
    const runDirectory = join(root, 'run');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(runDirectory, { recursive: true });

    write(join(projectDir, 'reports.md'), '# stale\n');
    const stale = inspectStageArtifactContract({
      stageId: 'stale',
      template: 'Write `reports.md`.',
      projectDir,
      runDir: runDirectory,
      writes: [],
    });
    expect(stale.obligations).toHaveLength(1);
    expect(stale.producedPromptArtifacts).toEqual([]);
    expect(stale.violations).toEqual([
      expect.objectContaining({
        mention: 'reports.md',
        reason: expect.stringContaining('predated the stage'),
      }),
    ]);

    const unquoted = inspectStageArtifactContract({
      stageId: 'unquoted',
      template: 'Write evidence_before.md.',
      projectDir,
      runDir: runDirectory,
      writes: [],
    });
    expect(unquoted.obligations).toEqual([
      expect.objectContaining({ mention: 'evidence_before.md', kind: 'prompt_artifact' }),
    ]);
    expect(unquoted.violations).toHaveLength(1);

    const inputReference = inspectStageArtifactContract({
      stageId: 'input-reference',
      template: 'Write only the terminal path selected by research_decision.json.',
      projectDir,
      runDir: runDirectory,
      writes: [],
    });
    expect(inputReference.obligations).toEqual([]);

    const freshTemplate = 'Write fresh_evidence.json.';
    const preimages = captureStageArtifactContractPreimages({
      template: freshTemplate,
      projectDir,
      runDir: runDirectory,
    });
    write(join(projectDir, 'fresh_evidence.json'), '{"fresh":true}\n');
    const fresh = inspectStageArtifactContract({
      stageId: 'fresh',
      template: freshTemplate,
      projectDir,
      runDir: runDirectory,
      preimages,
    });
    expect(fresh.producedPromptArtifacts).toEqual([join(projectDir, 'fresh_evidence.json')]);
    expect(fresh.violations).toEqual([]);
  });

  it('refuses a stage that returns success while leaving an unquoted promised artifact stale', async () => {
    const root = temporaryRoot('artifact-stale-stage');
    const projectDir = join(root, 'project');
    const agentsDir = workerAgentDirectory(root);
    mkdirSync(projectDir, { recursive: true });
    write(join(projectDir, 'reports.md'), '# stale preimage\n');
    const workflow: WorkflowConfig = {
      name: 'artifact-stale-stage-replay',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'capture',
        role: 'worker',
        depends_on: [],
        dependency_reasons: {},
        scope: ['reports.md'],
        criterion_refs: [],
        prompt_template: 'Write reports.md.',
        skills: [],
        dynamic_dispatch: false,
        is_gate: false,
      }],
    };
    const adapter: Adapter = {
      async run(_prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        return { output: 'left the stale file untouched', exitCode: 0, duration_ms: 1 };
      },
    };

    const final = await runWorkflow(
      workflow, stringifyYaml(workflow), projectDir, adapter, new Map(), undefined,
      agentsDir, undefined, '# Stale artifact production replay', true, false,
    );
    const audit = readJson(join(runDir(projectDir, final.runId), 'stages', 'capture', 'artifact_contract.json'));

    expect(final.status).toBe('failed');
    expect(final.stages.capture).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('artifact contract violation'),
    });
    expect(audit.obligations).toEqual([
      expect.objectContaining({ mention: 'reports.md' }),
    ]);
    expect(audit.producedPromptArtifacts).toEqual([]);
    expect(audit.violations).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('predated the stage') }),
    ]);
  }, 30_000);

  it('refuses completion when the stage transposes artifact names and publishes a missing replay target', async () => {
    const root = temporaryRoot('artifact-promise');
    const projectDir = join(root, 'project');
    const agentsDir = workerAgentDirectory(root);
    mkdirSync(projectDir, { recursive: true });
    const workflow: WorkflowConfig = {
      name: 'artifact-promise-replay',
      defaults: { max_iterations: 1 },
      stages: [
        {
          id: 'plan',
          role: 'worker',
          depends_on: [],
          dependency_reasons: {},
          scope: [],
          criterion_refs: [],
          prompt_template: 'prepare the downstream artifact stage',
          skills: [],
          dynamic_dispatch: false,
          is_gate: false,
        },
        {
          id: 'capture',
          role: 'worker',
          depends_on: ['plan'],
          dependency_reasons: { plan: 'consume the planner-authored artifact contract' },
          scope: ['reports/final.md'],
          criterion_refs: [],
          prompt_template: [
            'Write {run_dir}/evidence_before.md and {run_dir}/evidence_before.json.',
            'Publish reports/final.md with replay command: npm exec vitest -- run spec/missing-replay.test.ts',
          ].join('\n'),
          skills: [],
          dynamic_dispatch: false,
          is_gate: false,
        },
      ],
    };
    let deliveredPrompt = '';
    const adapter: Adapter = {
      async run(prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        if (opts.stageId === 'plan') return { output: 'planned capture stage', exitCode: 0, duration_ms: 1 };
        deliveredPrompt = prompt;
        write(join(opts.runDir, 'stages', opts.stageId, 'before_evidence.md'), '# transposed\n');
        write(join(opts.runDir, 'stages', opts.stageId, 'before_evidence.json'), '{"transposed":true}\n');
        write(
          join(projectDir, 'reports', 'final.md'),
          '# Replay\n\n`npm exec vitest -- run spec/missing-replay.test.ts`\n',
        );
        return {
          output: 'published transposed evidence and report',
          exitCode: 0,
          duration_ms: 1,
          writes: ['reports/final.md'],
          writeAttribution: 'structured',
        };
      },
    };

    const final = await runWorkflow(
      workflow,
      stringifyYaml(workflow),
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      undefined,
      '# Artifact promise replay',
      true,
      false,
    );
    const runDirectory = runDir(projectDir, final.runId);

    expect(final.status).toBe('failed');
    expect(final.stages.capture).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('artifact contract violation'),
    });
    expect(deliveredPrompt).toContain(`${runDirectory}/evidence_before.md`);
    expect(deliveredPrompt).toContain(`${runDirectory}/evidence_before.json`);
    expect(existsSync(join(runDirectory, 'evidence_before.md'))).toBe(false);
    expect(existsSync(join(runDirectory, 'evidence_before.json'))).toBe(false);
    expect(existsSync(join(runDirectory, 'stages', 'capture', 'before_evidence.md'))).toBe(true);
    expect(existsSync(join(runDirectory, 'stages', 'capture', 'before_evidence.json'))).toBe(true);
    expect(readFileSync(join(projectDir, 'reports', 'final.md'), 'utf8'))
      .toContain('spec/missing-replay.test.ts');
    expect(existsSync(join(PROJECT_ROOT, 'spec', 'missing-replay.test.ts'))).toBe(false);
    expect(readJson(join(runDirectory, 'stages', 'capture', 'artifact_contract.json'))).toMatchObject({
      stageId: 'capture',
      obligations: expect.arrayContaining([
        expect.objectContaining({ mention: `${runDirectory}/evidence_before.md` }),
        expect.objectContaining({ mention: `${runDirectory}/evidence_before.json` }),
        expect.objectContaining({ mention: 'spec/missing-replay.test.ts' }),
      ]),
      violations: expect.arrayContaining([
        expect.objectContaining({ mention: `${runDirectory}/evidence_before.md` }),
        expect.objectContaining({ mention: `${runDirectory}/evidence_before.json` }),
        expect.objectContaining({ mention: 'spec/missing-replay.test.ts' }),
      ]),
    });
  }, 30_000);

  it('allows exact promised artifacts and ignores illustrative or optional path mentions', async () => {
    const root = temporaryRoot('artifact-promise-control');
    const projectDir = join(root, 'project');
    const agentsDir = workerAgentDirectory(root);
    mkdirSync(projectDir, { recursive: true });
    const replayPath = 'spec/existing-replay.test.ts';
    const workflow: WorkflowConfig = {
      name: 'artifact-promise-control',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'capture',
        role: 'worker',
        depends_on: [],
        dependency_reasons: {},
        scope: ['reports/final.md', replayPath],
        criterion_refs: [],
        prompt_template: [
          'Write {run_dir}/evidence_before.md and {run_dir}/evidence_before.json.',
          `Publish reports/final.md with replay command: npm exec vitest -- run ${replayPath}`,
          'Example: Write reports/illustrative-only.md.',
          'Optional: Write reports/optional-only.md if needed.',
        ].join('\n'),
        skills: [],
        dynamic_dispatch: false,
        is_gate: false,
      }],
    };
    const adapter: Adapter = {
      async run(_prompt: string, _agent: AgentConfig, opts: RunOpts): Promise<RunResult> {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        write(join(opts.runDir, 'evidence_before.md'), '# exact\n');
        write(join(opts.runDir, 'evidence_before.json'), '{"exact":true}\n');
        write(join(projectDir, replayPath), 'import { it } from "vitest"; it("exists", () => {});\n');
        write(join(projectDir, 'reports', 'final.md'), `# Replay\n\n\`npm exec vitest -- run ${replayPath}\`\n`);
        return {
          output: 'published exact evidence and command',
          exitCode: 0,
          duration_ms: 1,
          writes: ['reports/final.md', replayPath],
          writeAttribution: 'structured',
        };
      },
    };

    const final = await runWorkflow(
      workflow, stringifyYaml(workflow), projectDir, adapter, new Map(), undefined,
      agentsDir, undefined, '# Exact artifact promise control', true, false,
    );
    const audit = readJson(join(runDir(projectDir, final.runId), 'stages', 'capture', 'artifact_contract.json'));

    expect(final.status).toBe('complete');
    expect(audit.obligations).toHaveLength(4);
    expect(audit.violations).toEqual([]);
    expect(existsSync(join(projectDir, 'reports', 'illustrative-only.md'))).toBe(false);
    expect(existsSync(join(projectDir, 'reports', 'optional-only.md'))).toBe(false);
  }, 30_000);
});

describe('7 — empty pytest populations compared as a match', () => {
  async function runPopulationFixture(
    label: string,
    collection: (side: 'source' | 'target', testPath: string) => { exitCode?: number; stdout?: string; stderr?: string },
  ) {
    const root = temporaryRoot(label);
    const sourceDir = join(root, 'source');
    const targetDir = join(root, 'target');
    const stateDir = join(root, 'state');
    const briefPath = join(sourceDir, 'brief.md');
    const testPath = 'checks/test_population.py';
    write(join(sourceDir, 'Makefile'), `test:\n\t@python3 -m pytest ${testPath}\n`);
    write(join(sourceDir, testPath), 'def test_population():\n    assert True\n');
    write(briefPath, '# Goal\n\nPreserve the configured test population.\n');
    const collectorCalls: Array<{ cwd: string; command: string; args: string[] }> = [];
    const collector = vi.fn<ValidationCommandRunner>((request) => {
      collectorCalls.push({ cwd: request.cwd, command: request.command, args: [...request.args] });
      if (request.command === 'make') {
        return {
          exitCode: 0,
          stdout: `python3 -m pytest ${testPath}\n`,
          stderr: '',
          durationMs: 1,
        };
      }
      const side = request.cwd === sourceDir ? 'source' : 'target';
      const observed = collection(side, testPath);
      return {
        exitCode: observed.exitCode ?? 0,
        stdout: observed.stdout ?? '',
        stderr: observed.stderr ?? '',
        durationMs: 1,
      };
    });
    const baseline = vi.fn<ValidationCommandRunner>(() => ({
      exitCode: 0,
      stdout: '1 passed in 0.01s\n',
      stderr: '',
      durationMs: 1,
    }));
    const createWorktree = vi.fn<GitWorktreeCreator>((request) => {
      mkdirSync(request.targetDir, { recursive: true });
      copyFileSync(join(sourceDir, 'Makefile'), join(request.targetDir, 'Makefile'));
      write(join(request.targetDir, testPath), readFileSync(join(sourceDir, testPath), 'utf8'));
      return { exitCode: 0 };
    });
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();

    const exitCode = await cmdShipSetupWithDeps([
      'ship-setup',
      '--brief', briefPath,
      '--project', sourceDir,
      '--target', targetDir,
      '--base', 'fixture-base',
      '--branch', 'fixture-branch',
    ], {
      createWorktree,
      runTestCollectionCommand: collector,
      runValidationCommand: baseline,
      globalDir: () => stateDir,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });
    const records = readdirSync(join(stateDir, 'ship-setups'));
    const record = readJson(join(stateDir, 'ship-setups', records[0]));
    const exactCollectors = collectorCalls.filter((call) => call.command === 'python3');

    return {
      exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      record,
      exactCollectors,
      sourceDir,
      targetDir,
      testPath,
    };
  }

  it('records the nonempty matched population when successful collectors use stderr', async () => {
    const observation = await runPopulationFixture('empty-population', (_side, testPath) => ({
      stderr: `${testPath}::test_population\n1 test collected in 0.01s\n`,
    }));

    expect(observation.exitCode).toBe(0);
    expect(observation.stderr).toBe('');
    expect(observation.stdout).toContain('Test population: MATCHED source=1 target=1');
    expect(observation.record).toMatchObject({
      state: 'ready',
      ready: true,
      testPopulation: {
        state: 'matched',
        source: { count: 1, identities: [observation.testPath] },
        target: { count: 1, identities: [observation.testPath] },
        missingFromTarget: [],
        extraInTarget: [],
      },
    });
    expect(observation.exactCollectors).toEqual([
      {
        cwd: observation.sourceDir,
        command: 'python3',
        args: ['-m', 'pytest', observation.testPath, '--collect-only', '-q'],
      },
      {
        cwd: observation.targetDir,
        command: 'python3',
        args: ['-m', 'pytest', observation.testPath, '--collect-only', '-q'],
      },
    ]);
    expect(existsSync(join(observation.sourceDir, observation.testPath))).toBe(true);
    expect(existsSync(join(observation.targetDir, observation.testPath))).toBe(true);
  });

  it('reports UNVERIFIED when successful collectors provide no population evidence', async () => {
    const observation = await runPopulationFixture('unproved-empty-population', () => ({}));

    expect(observation.exitCode).toBe(0);
    expect(observation.stderr).toBe('');
    expect(observation.stdout).toContain('Test population: UNVERIFIED');
    expect(observation.record).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'unverified',
        reason: expect.stringContaining('produced no parseable test identities'),
      },
    });
  });

  it('keeps a positively reported genuinely empty collection matched', async () => {
    const observation = await runPopulationFixture('proved-empty-population', () => ({
      exitCode: 5,
      stderr: 'no tests collected in 0.01s\n',
    }));

    expect(observation.exitCode).toBe(0);
    expect(observation.stderr).toBe('');
    expect(observation.stdout).toContain('Test population: MATCHED source=0 target=0');
    expect(observation.record).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'matched',
        source: { count: 0, identities: [] },
        target: { count: 0, identities: [] },
      },
    });
  });

  it('calibrates the same collector with identical nonempty stdout populations', async () => {
    const observation = await runPopulationFixture('nonempty-population', (_side, testPath) => ({
      stdout: `${testPath}::test_population\n1 test collected in 0.01s\n`,
    }));

    expect(observation.exitCode).toBe(0);
    expect(observation.stderr).toBe('');
    expect(observation.stdout).toContain('Test population: MATCHED source=1 target=1');
    expect(observation.record).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'matched',
        source: { count: 1, identities: [observation.testPath] },
        target: { count: 1, identities: [observation.testPath] },
      },
    });
  });

  it('calibrates the same collector with a nonempty identity mismatch', async () => {
    const observation = await runPopulationFixture('mismatched-population', (side, testPath) => ({
      stdout: side === 'source'
        ? `${testPath}::test_population\n1 test collected in 0.01s\n`
        : 'checks/test_renamed.py::test_population\n1 test collected in 0.01s\n',
    }));

    expect(observation.exitCode).toBe(1);
    expect(observation.stdout).toBe('');
    expect(observation.stderr).toContain('Test population: MISMATCHED');
    expect(observation.record).toMatchObject({
      state: 'refused',
      ready: false,
      testPopulation: {
        state: 'mismatched',
        source: { count: 1 },
        target: { count: 1 },
        missingFromTarget: [observation.testPath],
        extraInTarget: ['checks/test_renamed.py'],
      },
    });
  });
});
