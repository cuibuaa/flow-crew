import './test-support/policy-runtime.js';
import { fixtureResult, declaredDispatch } from './test-support/declared-dispatch.js';
import { artifacts, inputFile } from './spec_contracts/declared-fixtures.js';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { cmdEventsWithDeps } from '../src/cli-events.js';
import { rehearseBriefIsolated } from './test-support/rehearse.js';
import {
  briefDeclaresNoCandidateOutcome,
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
  async run(_record0, _record1, recordOpts: import("../src/adapters/base.js").RunOpts): Promise<RunResult> {
    return fixtureResult({ output: 'unused', exitCode: 0, duration_ms: 1 }, recordOpts);
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

describe('research ingestion and planner refusal evidence', () => {
  it.each([
    { name: 'measured', sidecar: false, record: { label: 'candidate', result: 0.12 }, outcome: 'measured' },
    { name: 'no candidate', sidecar: true, record: { label: 'candidate', outcome: 'no_candidate', reason: 'No safe candidate' }, outcome: 'no_candidate' },
    { name: 'legacy discriminator', sidecar: true, record: { label: 'candidate', status: 'no_candidate', reason: 'No safe candidate' }, outcome: 'no_candidate' },
    { name: 'missing identity', sidecar: true, record: { label: '', status: 'no_candidate', note: 'Not a reason' }, outcome: undefined },
  ])('ingests $name without rerunning a completed producer', async ({ sidecar, record, outcome, name }) => {
    const root = temporaryRoot('round-ingestion'), projectDir = join(root, 'project'), runDirectory = join(root, 'run');
    mkdirSync(runDirectory, { recursive: true });
    const path = join(projectDir, `artifacts/round.json${sidecar ? '.no_candidate.json' : ''}`);
    const completedAt = new Date(Date.now() - 100).toISOString();
    const producer = { status: 'complete', retries: 0, completedAt };
    const state = { runId: 'fixture', workflowName: 'research', projectDir, status: 'running',
      startedAt: new Date(Date.now() - 1_000).toISOString(), stages: { measure: producer },
      research: { baseline: 0.1, policy: 'greedy_stack', resultFile: 'artifacts/round.json', reportDir: 'artifacts', stop: { maxRounds: 2 } },
    } as StoreState;
    const { beginResearchInputGeneration } = await import('../src/research-candidate.js');
    beginResearchInputGeneration(projectDir, state);
    write(path, JSON.stringify(record));
    const result = await tryAdvanceResearch(state, { projectDir, runId: state.runId, runDirPath: runDirectory, iteration: 1, adapter: inertAdapter });
    expect(state.stages.measure).toEqual({ status: 'complete', retries: 0, completedAt });
    if (!outcome) {
      expect(result).toBeNull();
      expect(readJson(join(runDirectory, 'research_round_input_error.json'))).toMatchObject({ kind: 'missing_label' });
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(runDirectory, 'research_round_contract_repair.json'))).toBe(false);
      return;
    }
    expect(readJson(join(runDirectory, 'research_journal.json')).rounds).toEqual([
      expect.objectContaining({ label: record.label, outcome, ...(!sidecar ? { result: record.result } : {}) }),
    ]);
    expect(existsSync(join(runDirectory, 'research_round_input_error.json'))).toBe(false);
    if (sidecar) {
      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(runDirectory).some(file => /no_candidate_consumed\.json$/.test(file))).toBe(true);
    } else expect(existsSync(join(runDirectory, 'research_round_1_consumed.json'))).toBe(true);
    if (name === 'legacy discriminator') {
      expect(readJson(join(runDirectory, 'research_round_contract_repair.json'))).toMatchObject({
        kind: 'no_candidate_status_alias', fromField: 'status', toField: 'outcome',
      });
    }
  });

  it('enumerates terminal-owner cardinalities zero, one, and three through admission', () => {
    const terminalPaths = ['artifacts/ship.md', 'artifacts/ceiling.md', 'artifacts/escalation.md'];
    const stage = (id: string, scope: string[]): StageConfig => ({ artifact_contract: artifacts([], [], []),
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

    expect(zero.errors.filter((error) => error.message.includes('expected exactly one final producer, found 0')))
      .toHaveLength(3);
    expect(one).toMatchObject({ pass: true, errors: [] });
    expect(many.errors.filter((error) => (
      error.message.includes('expected exactly one final producer, found 3 (execute_round, repair_round, write_ship)')
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
          checks: [{ reads: [inputFile('file_0', '.fc/runs/prior/evidence.json')],
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
      expect.stringContaining('ARTIFACT_INPUT_ABSENT'),
    ]);
  });

  it('bounds planner invocations and reports the final causal refusal', async () => {
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
    const workflow: WorkflowConfig = {description: '',
      name: 'planner-refusal-replay',
      defaults: { max_iterations: 1 },
      stages: [{ artifact_contract: artifacts([], [], []),
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
        if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
        if (opts.stageId !== 'plan') return fixtureResult({ output: 'unexpected work stage', exitCode: 0, duration_ms: 1 }, opts);
        planCalls += 1;
        const stages = ['execute_round', 'repair_round', 'write_ship'].map((id) => ({ artifact_contract: artifacts([], [], []),dynamic_dispatch: false,
          id,
          role: 'worker',
          depends_on: id === 'execute_round' && planCalls > 1 ? ['repair_round', 'write_ship'] : [],
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
        writeFileSync(join(opts.runDir, 'fixture_dispatch.yaml'), declaredDispatch(stringifyYaml({ stages })), 'utf8');
        writeFileSync(join(opts.runDir, 'reality_checks.md'), [
          '## Reality checks',
          '',
          '```yaml',
          stringifyYaml({
            checks: [{
              name: 'run-history',
              type: 'file-exists-nonempty',
              params: { paths: ['.fc/runs/prior/evidence.json'] },
              reads: [{id:'history',root:'project',path:'.fc/runs/prior/evidence.json',source:{kind:'input'}}],
            }],
          }).trimEnd(),
          '```',
          '',
        ].join('\n'), 'utf8');
        return fixtureResult({ output: `plan attempt ${planCalls}`, exitCode: 0, duration_ms: 1 }, opts);
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
      String(item.detail).includes('expected exactly one final producer, found 3')
    ))).toHaveLength(3);
    expect(retryState.attempts[1].unsatisfied).toEqual([
      expect.objectContaining({
        id:'reality_check_invalid:reality_checks',detail: expect.stringContaining('.fc/runs/prior/evidence.json'),
      }),
    ]);
    expect(retryState.attempts[2].unsatisfied).toEqual([
      expect.objectContaining({
        id:'reality_check_invalid:reality_checks',detail: expect.stringContaining('.fc/runs/prior/evidence.json'),
      }),
    ]);
    expect(final.failureReason).toContain('reality_check_invalid:reality_checks');
    expect(final.failureReason).not.toContain('terminal_owner:terminal_states.artifacts/ship.md');
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

describe('declared rehearsal outcomes and bounded ship probes', () => {
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

describe('environment refusal precedence', () => {
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

  it('names the missing adapter before the zero-criteria refusal', () => {
    const root = temporaryRoot('adapter-absent');
    const result = runBackgroundQuick(root);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain('No adapter CLI is installed or visible on PATH.');
    expect(output).toContain('npm i -g @openai/codex');
    expect(result.stderr).not.toContain('[brief_criteria_missing]');
  });

  it('keeps the zero-criteria refusal when an adapter executable is visible', () => {
    const root = temporaryRoot('adapter-present');
    const codex = join(root, 'bin', 'codex');
    write(codex, '#!/bin/sh\nexit 0\n');
    chmodSync(codex, 0o755);
    const result = runBackgroundQuick(root);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[brief_criteria_missing] No structurally extractable criterion');
    expect(output).not.toContain('No adapter CLI is installed or visible on PATH.');
  });

  it('keeps the environment refusal first when the same adapter-free launch has a criterion', () => {
    const root = temporaryRoot('adapter-absent-with-criterion');
    const result = runBackgroundQuick(root, criterionBearingBrief, true);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain('No adapter CLI is installed or visible on PATH.');
    expect(result.stderr).not.toContain('[brief_criteria_missing]');
  });

  it('passes both precedence refusals when an adapter and a criterion are present', () => {
    const root = temporaryRoot('adapter-present-with-criterion');
    const codex = join(root, 'bin', 'codex');
    write(codex, '#!/bin/sh\nexit 0\n');
    chmodSync(codex, 0o755);
    const result = runBackgroundQuick(root, criterionBearingBrief, true);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain('no exact setup record exists');
    expect(output).not.toContain('No adapter CLI is installed or visible on PATH.');
    expect(result.stderr).not.toContain('[brief_criteria_missing]');
  });
});

describe('violation paths at durable and human event layers', () => {
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

  it('accepts legitimate writes outside the estimate without a fabricated violation event', async () => {
    const root = temporaryRoot('live-event-path');
    const projectDir = join(root, 'project');
    const agentsDir = workerAgentDirectory(root);
    mkdirSync(projectDir, { recursive: true });
    const workflow: WorkflowConfig = {description: '',
      name: 'live-event-path-replay',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ artifact_contract: artifacts([], [], []),
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
        if (opts.stageId === '_summary') return fixtureResult({ output: 'summary', exitCode: 0, duration_ms: 1 }, opts);
        invocations += 1;
        write(join(projectDir, violatingPath), `export const attempt = ${invocations};\n`);
        const deadline = Date.now() + 1_500;
        while (existsSync(join(projectDir, violatingPath)) && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        return fixtureResult({
          output: 'wrote outside the admitted scope',
          exitCode: 0,
          duration_ms: 1,
          writes: [violatingPath],
          writeAttribution: 'structured',
        }, opts);
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

    expect(final.status).toBe('complete');
    expect(invocations).toBe(1);
    expect(existsSync(join(projectDir, violatingPath))).toBe(true);
    expect(durableEvents).toEqual([]);
    expect(durableEvents.every((event) => event.files?.includes(violatingPath))).toBe(true);
    expect(jsonEvents).toEqual(durableEvents);
    expect(humanErr.value).toBe('');
    expect(jsonErr.value).toBe('');
    const humanViolationRows = human.value.split('\n')
      .filter((line) => line.includes('live_constraint_violation'));
    expect(humanViolationRows).toEqual([]);
    expect(humanViolationRows.every((line) => line.includes(`paths=${violatingPath}`))).toBe(true);
  }, 30_000);
});
