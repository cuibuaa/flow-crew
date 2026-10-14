import './test-support/policy-runtime.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { runRace, type RaceDeps } from '../src/race.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { loadDefaults } from '../src/scheduler/sched_admission/configuration.js';
import { collectGateRuntimeFacts } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { atomicWrite, type StoreState, runDir } from '../src/store.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import type { Adapter, RunOpts } from '../src/adapters/base.js';

const root = join(import.meta.dirname, '..'), agentsDir = join(root, 'config/agents');
const good = 'exports.twice = n => n * 2;\n', bad = 'exports.twice = n => n;\n';
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-workflow-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

/** An executable task oracle, independent of the scripted author. */
function correct(source: string): boolean {
  const exports: { twice?: (n: number) => number } = {};
  runInNewContext(source, { exports }, { timeout: 1000 });
  return [-2, -1, 0, 1, 2].every(n => exports.twice?.(n) === n * 2);
}

async function raceFixture(options: {
  authored: string[]; repairs: string[];
  scores?: number[]; omitCriterion?: boolean; approval?: boolean; peers?: boolean; staged?: boolean; finished?: string[]; gateBudget?: number; failedPeer?: boolean; endAfterFinish?: boolean;
}) {
  const task = ['---', 'outputs: [report.md]', '---', '# Double integers', '', '## What the report must show',
    '1. twice doubles every integer from -2 to 2.', '2. report.md describes the change.', ''].join('\n');
  const states = new Map<string, StoreState>(), calls: Array<{ label: string; stage: string }> = [];
  const adapters = new Map<string, Adapter>(), instructions = new Map<string, string>();
  const authorPrompts: Array<{ label: string; prompt: string }> = [];
  async function runCandidate(target: string) {
    mkdirSync(target, { recursive: true });
    // One repair proves the ordinary handoff; multi-round cases name their
    // own budget. Do not inherit repeated repairs from operator defaults.
    setEngineDefaults({ gate_retry_loops: options.gateBudget ?? 1 });
    expect(loadDefaults().gate_retry_loops).toBe(options.gateBudget ?? 1);
    const i = target.endsWith('-a') ? 0 : 1, label = i ? 'B' : 'A';
    if (!adapters.has(target)) {
      adapters.set(target, { async run(prompt, _role, opts: RunOpts) {
        if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 0 };
        calls.push({ label, stage: opts.stageId });
        if (opts.stageId.startsWith('review')) {
          const pass = correct(readFileSync(join(target, 'twice.js'), 'utf8'));
          const { criteria } = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8'));
          const results = Object.fromEntries(criteria.map(({ id }: { id: string }, n: number) => [id,
            { status: n === 0 && !pass ? 'fail' : 'pass', evidence: 'executable oracle: twice(-2..2), and report.md exists' }]));
          if (options.omitCriterion && i === 0) delete results[criteria[1].id];
          const score = options.scores?.[i];
          // The supplied fixture contract deliberately contradicts A's claimed pass in the score case.
          if (score !== undefined) atomicWrite(join(opts.runDir, 'gate_contract.json'), JSON.stringify({ metric: 'fixture_score', threshold: 1, higherIsBetter: true }));
          writeFileSync(join(opts.runDir, `fixture_verdict_${opts.stageId}.json`), JSON.stringify({ pass, reason: pass ? 'oracle passed' : 'oracle failed', criteria: results,
            ...(score === undefined ? {} : { metric: 'fixture_score', value: score, threshold: 1 }) }));
          return fixtureResult({ output: 'reviewed', exitCode: 0, duration_ms: 1 }, opts);
        }
        if (opts.stageId === 'implement') authorPrompts.push({ label, prompt });
        if (options.approval) {
          writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'approval_request.json'), JSON.stringify({ id: `fixture-${label}`, action: 'publish', target: 'fixture', risk: 'external' }));
        }
        const source = opts.stageId === 'finish' ? options.finished?.[i] ?? 'exports.twice = n => n + n;\n'
          : opts.stageId === 'repair' ? options.repairs[i] : options.authored[i];
        const writes = opts.stageId === 'notes' ? ['report.md'] : options.peers || opts.stageId === 'finish' ? ['twice.js'] : ['twice.js', 'report.md'];
        for (const path of writes) writeFileSync(join(target, path), path === 'twice.js' ? source : 'Doubled integers.\n');
        return fixtureResult({ output: 'authored snapshot', exitCode: options.failedPeer && i === 0 && opts.stageId === 'notes' ? 1 : 0, duration_ms: 1, writes, writeAttribution: 'structured' }, opts);
      } });
    }
    const { config, raw } = loadWorkflow(join(root, 'config/workflows/direct.yaml')); config.defaults.max_iterations = 1;
    if (options.peers) config.dispatch = [
      { id: 'implement', role: 'coder', scope: ['twice.js'] },
      { id: 'notes', role: 'coder', scope: ['report.md'] },
      { id: 'review', role: 'qa', depends_on: options.failedPeer ? ['implement'] : ['implement', 'notes'], is_gate: true, scope: [] },
      { id: 'repair', role: 'coder', depends_on: ['review'], retry_to: ['review'], scope: ['twice.js', 'report.md'] },
    ];
    if (options.staged) config.dispatch = [
      { id: 'implement', role: 'coder', scope: ['twice.js', 'report.md'] },
      { id: 'review', role: 'qa', depends_on: ['implement'], is_gate: true, scope: [] },
      { id: 'finish', role: 'coder', depends_on: ['review'], scope: ['twice.js'] },
      { id: 'review_final', role: 'qa', depends_on: ['finish'], is_gate: true, scope: [] },
      { id: 'repair', role: 'coder', depends_on: ['review', 'review_final'], retry_to: ['review', 'review_final'], scope: ['twice.js', 'report.md'] },
    ];
    if (options.endAfterFinish) config.dispatch = config.dispatch!.filter(stage => stage.id !== 'review_final').map(stage =>
      stage.id === 'repair' ? { ...stage, depends_on: ['review'], retry_to: ['review'] } : stage);
    config.dispatch = config.dispatch!.map(stage => {
      const authored = stage as { id: string; prompt_template?: string; is_gate?: boolean; retry_to?: string[] };
      return authored.is_gate || authored.retry_to?.length ? stage
        : { ...authored, prompt_template: `${authored.prompt_template ?? ''}\n${instructions.get(target) ?? ''}` };
    });
    const state = await runWorkflow(config, raw, target, adapters.get(target)!, new Map(), undefined, agentsDir, undefined,
      task, true, undefined, false);
    states.set(target, state);
    return { code: state.status === 'complete' || state.status === 'parked' ? 0 : 1, output: state.status };
  }
  const deps: RaceDeps = {
    async run(target, _label, instruction) { instructions.set(target, instruction); return runCandidate(target); },
    readRun(target) {
      const state = states.get(target); if (!state) return undefined;
      const stages = state.planControl?.stages ?? [];
      return { runId: state.runId, status: state.status,
        gatePassed: stages.some(s => s.is_gate) && collectGateRuntimeFacts(stages, state, target, state.runId).allPass,
        failureReason: state.failureReason };
    },
    write: (p, text) => writeFileSync(p, text), out: () => {},
  };
  const prefix = join(directory, 'candidate');
  const code = await runRace({ targets: [prefix + '-a', prefix + '-b'], recordPath: prefix + '-race.json' }, deps);
  const record = JSON.parse(readFileSync(prefix + '-race.json', 'utf8'));
  if (record.chosenTarget) expect(correct(readFileSync(join(record.chosenTarget, 'twice.js'), 'utf8'))).toBe(true);
  return { code, record, states, calls, authorPrompts, task };
}

describe('race through admitted scheduler workflows', () => {
  it('transports A guidance through stage prompts while preserving both admitted task criteria', async () => {
    const { code, states, authorPrompts, task } = await raceFixture({ authored: [bad, good], repairs: [bad, good] });
    expect(code).toBe(0);
    const instruction = "Before changing any code, write down in one or two sentences the observable behaviour the task's author expects";
    expect(authorPrompts.find(p => p.label === 'A')!.prompt).toContain(instruction);
    expect(authorPrompts.find(p => p.label === 'B')!.prompt).not.toContain(instruction);
    for (const state of states.values()) {
      expect(state.taskDescription).toBe(task);
      const criteria = JSON.parse(readFileSync(join(runDir(state.projectDir, state.runId), 'brief_criteria.json'), 'utf8'));
      expect(criteria.criteria.map((criterion: { text: string }) => criterion.text)).toEqual(['twice doubles every integer from -2 to 2.', 'report.md describes the change.']);
    }
  });

  it('authors only the first candidate when its independent gate passes', async () => {
    const { code, record, calls, states } = await raceFixture({ authored: [good, bad], repairs: [good, good] });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'A', basis: 'first-passed' });
    expect(calls).toEqual([{ label: 'A', stage: 'implement' }, { label: 'A', stage: 'review' }]);
    expect(states.size).toBe(1);
    expect(record.candidates).toHaveLength(1);
    expect(record.gateAttempts).toEqual([expect.objectContaining({ label: 'A', pass: true })]);
  });

  it('finishes and gates all independent authoring peers before selecting the first candidate', async () => {
    const { code, record, calls } = await raceFixture({ authored: [good, good], repairs: [good, good], peers: true });
    expect(code).toBe(0); expect(record.decision.choice).toBe('A');
    expect(calls.filter(c => c.label === 'B')).toEqual([]);
    expect(calls.filter(c => c.label === 'A').map(c => c.stage).sort()).toEqual(['implement', 'notes', 'review']);
  });

  it('tries the alternative when a first authoring peer fails', async () => {
    const { code, record, calls, states } = await raceFixture({ authored: [good, good], repairs: [good, good], peers: true, failedPeer: true });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(record.gateAttempts.map((a: { pass: boolean }) => a.pass)).toEqual([false, true]);
    expect(calls.filter(c => c.label === 'A' && c.stage === 'review')).toHaveLength(1);
    expect(record.candidates[0].gatePassed).toBe(true);
    expect([...states.values()].find(s => s.projectDir.endsWith('-a'))!.status).toBe('incomplete');
  });

  it('gates distinguishing downstream authoring after intermediate prerequisites', async () => {
    const { code, record, calls, states } = await raceFixture({
      authored: [good, good], repairs: [good, good], staged: true, finished: [good, bad],
    });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'A', basis: 'first-passed' });
    expect(calls).toEqual(['implement', 'review', 'finish', 'review_final'].map(stage => ({ label: 'A', stage })));
    expect(readFileSync(join(record.chosenTarget, 'twice.js'), 'utf8')).toBe(good);
    const winner = states.get(record.chosenTarget)!;
    expect(winner.stages.review_final.attempts).toHaveLength(1);
    expect(winner.stages.finish.attempts).toHaveLength(1);
  });

  it('delivers a completed workflow whose last ordinary stage follows the gate', async () => {
    const { code, record, calls } = await raceFixture({
      authored: [good, good], repairs: [good, good], staged: true, endAfterFinish: true,
      finished: [good, 'exports.twice = n => n + n;\n'],
    });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'A', basis: 'first-passed' });
    expect(record.gateAttempts).toEqual([expect.objectContaining({ label: 'A', pass: true })]);
    expect(calls.map(c => c.stage)).toEqual(['implement', 'review', 'finish']);
  });

  it('repairs a rejected intermediate prerequisite before finishing and gating the first candidate', async () => {
    const { code, record, calls } = await raceFixture({
      authored: [bad, good], finished: [good, bad], repairs: [good, good], staged: true,
    });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'A', basis: 'first-passed' });
    expect(calls.map(c => c.stage)).toEqual(['implement', 'review', 'repair', 'review', 'finish', 'review_final']);
    expect(calls.every(c => c.label === 'A')).toBe(true);
  });

  it('preserves repair round coordinates and rejected evidence across intermediate and final gates', async () => {
    const { code, record, states } = await raceFixture({
      authored: [bad, good], finished: [bad, good], repairs: [good, good], staged: true, gateBudget: 2,
    });
    expect(code).toBe(0); expect(record.decision.choice).toBe('A');
    const winner = states.get(record.chosenTarget)!;
    expect(winner.stages.repair.attempts).toHaveLength(2);
    const archive = join(runDir(winner.projectDir, winner.runId), 'gate_reevaluation', 'iteration_1');
    expect(JSON.parse(readFileSync(join(archive, 'round_1', 'rejected_verdict_review.json'), 'utf8')).pass).toBe(false);
    expect(JSON.parse(readFileSync(join(archive, 'round_2', 'rejected_verdict_review_final.json'), 'utf8')).pass).toBe(false);
    expect(JSON.parse(readFileSync(join(archive, 'round_2', 'repair_diff.json'), 'utf8')).round).toBe(2);
  });

  it('does not reset an exhausted intermediate repair budget when the first final gate rejects', async () => {
    const { code, record, calls, states } = await raceFixture({
      authored: [bad, good], finished: [bad, good], repairs: [good, good], staged: true, gateBudget: 1,
    });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(record.gateAttempts.map((a: { pass: boolean }) => a.pass)).toEqual([false, true]);
    expect(calls.filter(c => c.label === 'A' && c.stage === 'repair')).toHaveLength(1);
    const first = [...states.values()].find(s => s.projectDir.endsWith('-a'))!;
    expect(first.status).toBe('incomplete'); expect(first.stages.repair.attempts).toHaveLength(1);
    expect(calls.findIndex(c => c.label === 'B')).toBe(calls.filter(c => c.label === 'A').length);
  });

  it('preserves author attempts and gates the repaired final revision before considering the alternative', async () => {
    const { code, record, states, calls } = await raceFixture({ authored: [bad, bad], repairs: [good, good] });
    expect(code).toBe(0); expect(record.gateAttempts).toEqual([expect.objectContaining({ label: 'A', pass: true })]);
    expect(calls).toEqual(['implement', 'review', 'repair', 'review'].map(stage => ({ label: 'A', stage })));
    const winner = states.get(record.chosenTarget)!;
    expect(winner.stages.implement.attempts).toHaveLength(1); expect(winner.stages.review.attempts).toHaveLength(2);
    expect(winner.stages.repair.attempts).toHaveLength(1);
    expect(record.gateAttempts[0].runId).toBe(winner.runId); expect(winner.currentIteration).toBe(1);
    expect(readFileSync(join(record.chosenTarget, 'twice.js'), 'utf8')).toBe(good);
    expect(readFileSync(join(runDir(winner.projectDir, winner.runId), 'gate_reevaluation', 'iteration_1', 'round_1', 'rejected_verdict_review.json'), 'utf8')).toContain('false');
  });

  it('authors the alternative only after the first exhausts its bounded gate repair', async () => {
    const { code, record, calls } = await raceFixture({ authored: [bad, good], repairs: [bad, good] });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(record.gateAttempts).toEqual([expect.objectContaining({ label: 'A', pass: false }), expect.objectContaining({ label: 'B', pass: true })]);
    expect(calls).toEqual([
      ...['implement', 'review', 'repair', 'review'].map(stage => ({ label: 'A', stage })),
      ...['implement', 'review'].map(stage => ({ label: 'B', stage })),
    ]);
  });

  it('records why neither passed after both bounded failures', async () => {
    const { code, record, calls } = await raceFixture({ authored: [bad, bad], repairs: [bad, bad] });
    expect(code).toBe(1); expect(record.decision.basis).toBe('none-passed'); expect(record.chosenTarget).toBeUndefined();
    expect(record.gateAttempts.map((a: { pass: boolean }) => a.pass)).toEqual([false, false]);
    expect(calls.filter(call => call.stage === 'repair')).toHaveLength(2);
    expect(record.decision.reason).toContain('gates did not pass');
  });

  it('honors every assigned criterion even when a reviewer claims an aggregate pass', async () => {
    const { code, record } = await raceFixture({ authored: [good, good], repairs: [good, good], omitCriterion: true });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(record.gateAttempts[0].pass).toBe(false);
  });

  it('honors a supplied numeric line independently of the aggregate and criterion passes', async () => {
    const { code, record } = await raceFixture({ authored: [good, good], repairs: [good, good], scores: [0, 1] });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(record.gateAttempts[0].pass).toBe(false);
  });

  it('does not mistake a consequential approval park for a passing candidate', async () => {
    const { code, record, calls } = await raceFixture({ authored: [good, good], repairs: [good, good], approval: true });
    expect(code).toBe(1); expect(record.decision.basis).toBe('none-passed');
    expect(record.gateAttempts.map((a: { pass: boolean }) => a.pass)).toEqual([false, false]);
    expect(calls.every(c => c.stage === 'implement')).toBe(true);
  });
});
