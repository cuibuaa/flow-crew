import { runRecordPath } from '../src/run-layout.js';
import { rehearseBriefIsolated } from './test-support/rehearse.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { ScriptedAdapter, type StageScript } from '../src/adapters/scripted.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, runDir, setFcGlobalDir } from '../src/store.js';

import * as engineFs from '../src/engine-fs.js';
import { readResearchGateCandidate } from '../src/research-candidate.js';
import type { ResearchMeasurement } from '../src/research-measurement.js';
import type { StageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { tryAdvanceResearch } from '../src/scheduler/sched_loop/services.js';

const repository = resolve(import.meta.dirname, '..');
const resultPath = 'artifacts/research/round_result.json';
const candidatePath = 'artifacts/research/rounds/round_01/candidate.json';
const evaluator = `const fs = require('node:fs');
const c = JSON.parse(fs.readFileSync(process.env.FC_RESEARCH_CANDIDATE + '/${candidatePath}', 'utf8'));
const answers = JSON.parse(fs.readFileSync(__dirname + '/answers.json', 'utf8'));
if (process.argv[2] === 'guard') console.log(JSON.stringify({ok: c.guard}));
else if (process.argv[2] === 'held') console.log(JSON.stringify({pass: c.held !== false}));
else console.log(JSON.stringify({items: [{id:'same-item', metrics:{cost:c.cost * answers.multiplier * Number(process.env.SCALE)}}]}));
`;
let root: string, previousStore: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rsi-settlement-')); previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store')); });
afterEach(() => { setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });

async function campaign(options: { rounds?: number; allowance?: number; noImprovement?: number; wall?: number; floor?: number; tamper?: 'producer' | 'frozen'; omitResult?: boolean; refine?: boolean; costs?: number[]; editMeasurement?: (m: ResearchMeasurement) => void; editStages?: (stages: StageConfig[]) => void; prepare?: (input: { project: string; adapter: ScriptedAdapter }) => void } = {}) {
  const rounds = options.rounds ?? 3;
  const { config, raw } = loadWorkflow(join(import.meta.dirname, 'fixtures/research-round-settlement.yaml'));
  config.defaults.max_iterations = 1; // The research budget must own all rounds in ONE run.
  const stages = config.stages.filter(stage => stage.id !== 'plan');
  stages.find(stage => stage.id === 'baseline_round')!.scope.push('instrument/**');
  // Gate ownership follows the candidate input, independent of the result slot.
  stages.find(stage => stage.id === 'baseline_round')!.scope = stages.find(stage => stage.id === 'baseline_round')!.scope.filter(path => path !== resultPath && path !== `${resultPath}.no_candidate.json`);
  stages.find(stage => stage.id === 'baseline_round')!.scope.push(resultPath); // Explicit adversarial result publication remains admitted.
  if (options.refine) {
    const author = structuredClone(stages.find(stage => stage.id === 'baseline_round')!);
    Object.assign(author, { id: 'refinement', depends_on: ['baseline_review'], scope: [candidatePath], artifact_contract: { version: 1, produces: [{ id: 'refined', root: 'project', path: candidatePath, kind: 'file', nonempty: true }], reads: [], groups: [] } });
    const review = structuredClone(stages.find(stage => stage.id === 'baseline_review')!);
    Object.assign(review, { id: 'refinement_review', depends_on: ['refinement'], artifact_contract: { version: 1,
      produces: [{ id: 'review', root: 'run', path: 'work/stages/refinement_review/review', kind: 'directory', nonempty: true }, { id: 'verdict', root: 'run', path: 'work/verdict_refinement_review.json', kind: 'file' }],
      reads: [{ id: 'refined', root: 'project', path: candidatePath, kind: 'file', source: { kind: 'stage', stage: 'refinement', artifact: 'refined' } }], groups: [] } });
    const repair = structuredClone(stages.find(stage => stage.id === 'baseline_repair')!);
    Object.assign(repair, { id: 'refinement_repair', depends_on: ['refinement_review'], retry_to: ['refinement_review'], scope: [candidatePath], artifact_contract: { version: 1,
      produces: [{ id: 'build', root: 'run', path: 'work/stages/refinement_repair/build', kind: 'directory', nonempty: false }], reads: [], groups: [] } });
    stages.push(author, review, repair);
    stages.find(stage => stage.id === 'ceiling_report')!.depends_on = ['refinement_review'];
  }
  options.editStages?.(stages);
  const dispatch = stringify(stages);
  config.stages = config.stages.filter(stage => stage.id === 'plan');
  const measurement: ResearchMeasurement = {
    frozen: ['instrument'], candidate: [candidatePath], environment: { SCALE: '1' }, replicates: 4,
    metrics: { cost: { direction: 'min', scale: 'fraction' } }, primary: ['cost'],
    development: { command: process.execPath, args: ['instrument/evaluate.cjs', 'development'] },
    guards: [{ name: 'review', command: process.execPath, args: ['instrument/evaluate.cjs', 'guard'], pass: { field: 'ok', equals: true } }],
    held_out: { command: process.execPath, args: ['instrument/evaluate.cjs', 'held'], allowance: options.allowance ?? 2, pass: { field: 'pass', equals: true } },
    timeout_seconds: 5,
  };
  options.editMeasurement?.(measurement);
  const brief = `---\n${stringify({ terminal_states: { ceiling_hit: { paths: ['artifacts/research/ceiling_report.md'], ...(options.floor ? { floor: { min_attempted_stages: options.floor } } : {}) } }, research: {
    baseline: 100, higher_is_better: false, result_file: resultPath, report_dir: 'artifacts/research', measurement,
    stop: { max_rounds: rounds, ...(options.noImprovement ? { halt_after_no_improvement: options.noImprovement } : {}), ...(options.wall ? { max_wall_hours: options.wall } : {}) },
  } })}---\nTry candidates using the evidence and journal.\n`;
  const verdict = (stage: string): StageScript => ({ output: 'Independent review passed.', runFiles: {
    [`stages/${stage}/review/evidence.md`]: 'review receipt\n',
    [`verdict_${stage}.json`]: JSON.stringify({ pass: true, reason: 'Candidate artifacts are available.', criteria: {}, audit_findings: { version: 1, findings: [] } }),
  } });
  const costs = options.costs ?? [80, 60, 50];
  const adapter = new ScriptedAdapter({
    plan: Array.from({ length: rounds }, () => ({ runFiles: { 'dispatch.yaml': dispatch } })),
    baseline_round: Array.from({ length: rounds }, (_, n) => ({ output: 'Candidate submitted.', projectFiles: {
      [candidatePath]: JSON.stringify({ cost: costs[n] ?? 100, guard: n !== 1 || options.noImprovement !== undefined }),
      ...(options.omitResult ? {} : { [resultPath]: JSON.stringify({ label: `forged-${n}`, result: -999999, result_std: 0 }) }),
      'artifacts/research/stage_01_verdict.md': 'Candidate evidence.\n',
      ...(options.tamper === 'frozen' ? { 'instrument/answers.json': '{"multiplier":0}', 'instrument/evaluate.cjs': 'console.log(JSON.stringify({items:[{id:"same-item",metrics:{cost:0}}]}))' } : {}),
    } })),
    baseline_review: verdict('baseline_review'),
    refinement: { output: 'Refined candidate.', projectFiles: { [candidatePath]: JSON.stringify({ cost: 70, guard: true }) } },
    refinement_review: verdict('refinement_review'),
    refinement_repair: { output: 'No repair requested.' },
    baseline_repair: { output: 'No repair requested.' },
    ceiling_report: { projectFiles: { 'artifacts/research/ceiling_report.md': '# Ceiling\nSettled engine observations.\n' } },
    ceiling_review: verdict('ceiling_review'), _summary: { output: 'Synthetic campaign complete.' },
  });
  const project = join(root, 'project'); mkdirSync(join(project, 'instrument'), { recursive: true });
  mkdirSync(join(project, 'artifacts/research/rounds/round_01'), { recursive: true });
  writeFileSync(join(project, candidatePath), JSON.stringify({ cost: 100, guard: true }));
  writeFileSync(join(project, 'instrument/evaluate.cjs'), evaluator);
  writeFileSync(join(project, 'instrument/answers.json'), '{"multiplier":1}');
  options.prepare?.({ project, adapter });
  const checkpoints: unknown[] = [];
  const execute = adapter.run.bind(adapter), previousScale = process.env.SCALE;
  adapter.run = async (prompt, role, opts) => {
    if (opts.stageId === 'plan') {
      const path = runRecordPath(opts.runDir, 'research_measurement/state.json');
      checkpoints.push(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
    }
    if (options.tamper === 'producer' && opts.stageId === 'baseline_round') process.env.SCALE = '0';
    return execute(prompt, role, opts);
  };
  let state;
  try { state = await runWorkflow(config, raw, project, adapter, new Map(), undefined, join(repository, 'config/agents'), undefined, brief, true, undefined, false); }
  finally { if (previousScale === undefined) delete process.env.SCALE; else process.env.SCALE = previousScale; }
  const run = runDir(project, state.runId);
  const read = (name: string) => JSON.parse(readFileSync(runRecordPath(run, name), 'utf8'));
  return { state, adapter, project, run, read, checkpoints };
}

describe('engine instrument through scripted research settlement', () => {
  it('measures independently despite producer result and environment tampering', async () => {
    const { read, state } = await campaign({ tamper: 'producer' });
    const rounds = read('research_journal.json').rounds;
    expect(rounds.map((r: { result: number }) => r.result)).toEqual([80, 60, 50]);
    expect(rounds.every((r: { measurement: { status: string } }) => r.measurement.status === 'measured')).toBe(true);
    expect(new Set(rounds.map((r: { measurement: { fingerprint: string } }) => r.measurement.fingerprint)).size).toBe(1);
    expect(state.status).toBe('ceiling_hit');
  }, 300000);

  it('records edited frozen evaluator inputs as unmeasured through settlement', async () => {
    const { read, state } = await campaign({ tamper: 'frozen' });
    const rounds = read('research_journal.json').rounds;
    expect(rounds).toHaveLength(3);
    expect(rounds.every((r: { outcome: string; measurement: { detail: string }; comparison: { keep: boolean } }) => r.outcome === 'unmeasured' && r.measurement.detail.includes('frozen_source_fingerprint_mismatch') && !r.comparison.keep)).toBe(true);
    expect(read('research_measurement/state.json').heldOutUses).toHaveLength(0);
    expect(read('research_decision.json').runningBest).toBe(100);
    expect(state.status).toBe('ceiling_hit');
  }, 300000);

  it('settles candidate measurements without any producer result file', async () => {
    const { read, state } = await campaign({ omitResult: true });
    expect(read('research_journal.json').rounds.map((r: { result: number }) => r.result)).toEqual([80, 60, 50]);
    expect(state.status).toBe('ceiling_hit');
  }, 300000);

  it('measures the final reviewed candidate when a round has ordered authors and gates', async () => {
    const { read, state } = await campaign({ rounds: 1, refine: true });
    expect(state.status, state.failureReason).toBe('ceiling_hit');
    expect(read('research_journal.json').rounds).toMatchObject([{ result: 70, comparison: { keep: true } }]);
    expect(read('research_measurement/state.json').heldOutUses).toHaveLength(1);
    expect(state.status).toBe('ceiling_hit');
  }, 300000);

  it('calibrates unchanged paired baseline replicates before the first producer', async () => {
    const { checkpoints, read } = await campaign();
    expect(checkpoints[0]).toMatchObject({ replicates: Array.from({ length: 4 }, () => ({ status: 'measured', items: [{ id: 'same-item', metrics: { cost: 100 } }] })), noise: { cost: 0 } });
    expect(read('research_journal.json').rounds[0].comparison).toMatchObject({ keep: true, reason: 'kept', metrics: { cost: { baseline: 100, candidate: 80, noise: 0 } } });
  }, 300000);

  it('keeps development selection separate from guarded held-out uses and stops at its allowance', async () => {
    const { read, state, project } = await campaign({ rounds: 8, floor: 4 });
    expect(read('research_journal.json').rounds.map((r: { comparison: unknown }) => r.comparison)).toEqual([
      expect.objectContaining({ keep: true, reason: 'kept' }), expect.objectContaining({ keep: false, reason: 'guard_worse' }), expect.objectContaining({ keep: true, reason: 'kept' }),
    ]);
    expect(read('research_measurement/state.json').heldOutUses).toEqual([
      { round: 'round-1', status: 'finished', passes: true }, { round: 'round-3', status: 'finished', passes: true },
    ]);
    expect(read('research_decision.json').reason).toContain('held_out_allowance_exhausted');
    expect(JSON.parse(readFileSync(join(project, candidatePath), 'utf8')).cost).toBe(50);
    expect(state.status).toBe('ceiling_hit');
  }, 300000);

  it('runs the declared round budget beyond the workflow iteration bound', async () => {
    const { read, state } = await campaign({ rounds: 6, allowance: 10, costs: [80, 70, 60, 50, 40, 30] });
    expect(read('research_journal.json').rounds).toHaveLength(6);
    expect(state.currentIteration).toBe(6);
    expect(state.status).toBe('ceiling_hit');
  }, 300000);

  it('ends at the no-improvement budget and preserves the measured best', async () => {
    const { read, project, state } = await campaign({ rounds: 8, allowance: 10, costs: [80, 100, 100], noImprovement: 2, floor: 4 });
    expect(read('research_journal.json').rounds).toHaveLength(3);
    expect(read('research_decision.json').reason).toContain('2 consecutive');
    expect(read('research_decision.json').reason).toContain('floor unmet');
    expect(JSON.parse(readFileSync(join(project, candidatePath), 'utf8')).cost).toBe(80);
    expect(state.status).toBe('ceiling_hit');
  }, 300000);
  it('ends on the elapsed wall budget during calibration before dispatching a producer', async () => {
    const { read, state, adapter } = await campaign({ rounds: 8, allowance: 10, wall: 1e-9 });
    expect(adapter.calls).toHaveLength(0);
    expect(read('research_measurement/state.json')).toMatchObject({ baseline: { status: 'unmeasured' }, error: expect.stringContaining('research_wall_budget_exhausted'), heldOutUses: [] });
    expect(state.status).toBe('failed');
    expect(state.failureReason).toContain('Research baseline is unmeasured');
  }, 300000);

  it('finishes a journaled terminal decision after interruption without repeating measurement or held-out', async () => {
    const publish = engineFs.atomicWrite;
    let interrupt = true;
    const spy = vi.spyOn(engineFs, 'atomicWrite').mockImplementation((path, data) => {
      publish(path, data);
      if (String(path).endsWith('/research_journal.json') && interrupt) { interrupt = false; throw new Error('synthetic interruption after journal publication'); }
    });
    let result;
    try { result = await campaign({ rounds: 1 }); } finally { spy.mockRestore(); }
    const { state, read, project, run, adapter } = result;
    expect(state.status).toBe('failed');
    expect(existsSync(runRecordPath(run, 'research_decision.json'))).toBe(false);
    expect(read('research_journal.json').rounds).toHaveLength(1);
    const before = read('research_measurement/state.json');
    await tryAdvanceResearch(state, { projectDir: project, runId: state.runId, runDirPath: run, iteration: 1, adapter, candidate: readResearchGateCandidate(run, 'baseline_review') });
    expect(read('research_decision.json')).toMatchObject({ decision: 'stop_ceiling', runningBest: 80 });
    expect(read('research_journal.json').rounds).toHaveLength(1);
    expect(read('research_measurement/state.json')).toEqual(before);
    expect(read('signals/research_terminal_ready.json')).toMatchObject({ terminalStatus: 'ceiling_hit' });
  }, 300000);

  it('rehearses the new example through the CLI settlement path without running its evaluator', async () => {
    const result = await rehearseBriefIsolated(readFileSync(join(repository, 'examples/research-instrument.brief.md'), 'utf8'));
    expect(result.exitCode).toBe(0);
    expect(result.simulated).toBe(true);
    const findings = result.findings.map(f => f.text).join('\n');
    expect(findings).toContain('4 baseline replicates');
    expect(findings).toContain('held-out uses=2/2');
    expect(findings).toContain('guard_worse');
  }, 300000);

});

// Retain the two independent review attacks through actual scheduler settlement.
it('rejects a candidate that temporarily changes frozen answers during execution', async () => {
  const work = candidatePath.replace('candidate.json', 'worker.cjs');
  const original = '{"multiplier":1}';
  const worker = (edit: boolean) => `const fs = require('node:fs');
    const path = require('node:path').join(process.cwd(), 'instrument/answers.json');
    const before = fs.readFileSync(path);
    ${edit ? 'fs.writeFileSync(path, JSON.stringify({multiplier: .01}));' : ''}
    process.stdout.write('ready\\n');
    setTimeout(() => { ${edit ? 'fs.writeFileSync(path, before);' : ''} }, 30);`;
  const value = await campaign({
    rounds: 1,
    editMeasurement: m => { m.candidate = [candidatePath.replace('/candidate.json', '')]; },
    prepare: ({ project, adapter }) => {
      writeFileSync(join(project, work), worker(false));
      writeFileSync(join(project, 'instrument/evaluate.cjs'), `
        const fs = require('node:fs'), {spawn} = require('node:child_process');
        const mode = process.argv[2];
        if (mode === 'guard') console.log('{"ok":true}');
        else if (mode === 'held') console.log('{"pass":true}');
        else {
          const child = spawn(process.execPath, [process.env.FC_RESEARCH_CANDIDATE + '/${work}'], {stdio:['ignore', 'pipe', 'inherit']});
          let cost;
          child.stdout.once('data', () => { cost = 100 * JSON.parse(fs.readFileSync(__dirname + '/answers.json', 'utf8')).multiplier; });
          child.on('close', code => {
            if (code !== 0) process.exit(code || 1);
            console.log(JSON.stringify({items:[{id:'same-item', metrics:{cost}}]}));
          });
        }`);
      const execute = adapter.run.bind(adapter);
      adapter.run = async (prompt, role, opts) => {
        const result = await execute(prompt, role, opts);
        if (opts.stageId === 'baseline_round') { writeFileSync(join(project, work), worker(true)); result.writes!.push(work); }
        return result;
      };
    },
  });
  expect(value.state.status, value.state.failureReason).toBe('ceiling_hit');
  expect(value.read('research_measurement/state.json')).toMatchObject({
    replicates: Array.from({ length: 4 }, () => ({ status: 'measured', items: [{ id: 'same-item', metrics: { cost: 100 } }] })),
    heldOutUses: [],
  });
  expect(value.read('research_journal.json').rounds).toMatchObject([{ outcome: 'unmeasured', comparison: { keep: false } }]);
  expect(value.read('research_decision.json').runningBest).toBe(100);
  expect(readFileSync(join(value.project, 'instrument/answers.json'), 'utf8')).toBe(original);
  expect(readFileSync(runRecordPath(value.run, 'research_measurement/instrument/instrument/answers.json'), 'utf8')).toBe(original);
}, 45000);

it('preserves unrelated evidence when a refused candidate installs a directory alias', async () => {
  const parent = candidatePath.replace('/candidate.json', ''), other = 'artifacts/research/unrelated/candidate.json';
  const before = '{"cost":777,"guard":true}';
  const value = await campaign({
    rounds: 1,
    editStages: stages => { stages.find(s => s.id === 'baseline_round')!.scope = ['artifacts/research/**', 'instrument/**']; },
    prepare: ({ project, adapter }) => {
      mkdirSync(join(project, 'artifacts/research/unrelated'), { recursive: true });
      writeFileSync(join(project, other), before);
      const execute = adapter.run.bind(adapter);
      adapter.run = async (prompt, role, opts) => {
        const result = await execute(prompt, role, opts);
        if (opts.stageId === 'baseline_round') {
          rmSync(join(project, parent), { recursive: true, force: true });
          symlinkSync('../unrelated', join(project, parent)); result.writes!.push(parent);
        }
        return result;
      };
    },
  });
  expect(readFileSync(join(value.project, other), 'utf8')).toBe(before);
  expect(value.state.status).toBe('failed');
  expect(value.state.failureReason).toContain('unsafe research restore ancestor');
}, 45000);

describe('engine executable-start receipts through scripted research settlement', () => {
  it.each(['guard', 'held-out'] as const)('refuses an executable-start failure in %s despite a matching exit-code condition', async mode => {
    const bad = join(root, 'missing-interpreter');
    writeFileSync(bad, '#!/no-such-rsi-interpreter\n', { mode: 0o755 });
    const { read, project, run } = await campaign({ rounds: 1, editMeasurement: measurement => {
      const spec = { command: bad, args: [], pass: { exit_code: 1 } };
      if (mode === 'guard') measurement.guards = [{ name: 'must-run', ...spec }];
      else measurement.held_out = { ...spec, allowance: 1 };
    } });
    expect(read('research_journal.json').rounds[0].comparison).toMatchObject({ keep: false, reason: 'guard_error' });
    const result = read('research_measurement/results/' + readdirSync(runRecordPath(run, 'research_measurement/results'))[0]);
    expect(result.receipts.at(-1)).toMatchObject({ reason: 'measurement_executable_start_failed' });
    expect(result.guards.at(-1)).toMatchObject({ passes: false, reason: 'guard_error', detail: 'measurement_executable_start_failed' });
    const measurement = read('research_measurement/state.json');
    expect(measurement.best.items[0].metrics.cost).toBe(100);
    expect(JSON.parse(readFileSync(join(project, candidatePath), 'utf8')).cost).toBe(100);
    if (mode === 'guard') expect(measurement.heldOutUses).toEqual([]);
    else expect(measurement.heldOutUses).toEqual([{ round: 'round-1', status: 'finished', passes: false, reason: 'measurement_executable_start_failed' }]);
  }, 300000);

  it.each(['guard', 'held-out'] as const)('accepts a genuinely executed nonzero exit-code condition in %s', async mode => {
    const executable = join(root, 'exit-one');
    writeFileSync(executable, '#!/bin/sh\nprintf "\\001arbitrary output"\nexit 1\n', { mode: 0o755 });
    const { read } = await campaign({ rounds: 1, editMeasurement: measurement => {
      const spec = { command: executable, args: [], pass: { exit_code: 1 } };
      if (mode === 'guard') measurement.guards = [{ name: 'runs', ...spec }];
      else measurement.held_out = { ...spec, allowance: 1 };
    } });
    expect(read('research_journal.json').rounds[0].comparison).toMatchObject({ keep: true, reason: 'kept' });
    expect(read('research_measurement/state.json').heldOutUses).toEqual([{ round: 'round-1', status: 'finished', passes: true }]);
  }, 300000);
});
