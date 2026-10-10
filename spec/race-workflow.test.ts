import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { runRace, type RaceDeps } from '../src/cli-race.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { collectGateRuntimeFacts } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { type StoreState, runDir } from '../src/store.js';
import { fixtureResult } from './test-support/declared-dispatch.js';
import type { Adapter, RunOpts } from '../src/adapters/base.js';

const root = join(import.meta.dirname, '..'), agentsDir = join(root, 'config/agents');
const good = 'exports.twice = n => n * 2;\n', bad = 'exports.twice = n => n;\n';
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'flowcrew-race-workflow-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

/** An executable task oracle, independent of the scripted author and comparison answers. */
function correct(source: string): boolean {
  const exports: { twice?: (n: number) => number } = {};
  runInNewContext(source, { exports }, { timeout: 1000 });
  return [-2, -1, 0, 1, 2].every(n => exports.twice?.(n) === n * 2);
}

async function raceFixture(options: {
  authored: string[]; repairs: string[]; answers?: Array<'A' | 'B' | undefined>;
  scores?: number[]; omitCriterion?: boolean; approval?: boolean; peers?: boolean; staged?: boolean; finished?: string[]; gateBudget?: number; failedPeer?: boolean;
}) {
  const task = ['---', 'outputs: [report.md]', '---', '# Double integers', '', '## What the report must show',
    '1. twice doubles every integer from -2 to 2.', '2. report.md describes the change.', ''].join('\n');
  const brief = join(directory, 'brief.md'); writeFileSync(brief, task);
  const states = new Map<string, StoreState>(), calls: Array<{ label: string; stage: string }> = [];
  const adapters = new Map<string, Adapter>();
  const comparedSources = new Map<string, string>();
  let callsAtComparison: typeof calls = [];
  let judgment = 0, comparisons = 0;
  const deps: RaceDeps = {
    async runCli(args, stdin) {
      if (args[0] === 'ship-setup') return { code: 0, output: 'Ship setup: READY' };
      const target = args[args.indexOf('--project') + 1]; mkdirSync(target, { recursive: true });
      if (options.gateBudget !== undefined) {
        mkdirSync(join(target, 'config'), { recursive: true });
        writeFileSync(join(target, 'config', 'defaults.yaml'), `default_gate_retry_loops: ${options.gateBudget}\n`);
      }
      const i = target.endsWith('-a') ? 0 : 1, label = i ? 'B' : 'A';
      if (!adapters.has(target)) {
        adapters.set(target, { async run(_prompt, _role, opts: RunOpts) {
          if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 0 };
          calls.push({ label, stage: opts.stageId });
          if (opts.stageId.startsWith('review')) {
            expect(comparisons).toBe(options.approval || options.failedPeer || (options.staged && opts.stageId === 'review') ? 0 : 2);
            const pass = correct(readFileSync(join(target, 'twice.js'), 'utf8'));
            const { criteria } = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf8'));
            const results = Object.fromEntries(criteria.map(({ id }: { id: string }, n: number) => [id,
              { status: n === 0 && !pass ? 'fail' : 'pass', evidence: 'executable oracle: twice(-2..2), and report.md exists' }]));
            if (options.omitCriterion && i === 0) delete results[criteria[1].id];
            const score = options.scores?.[i];
            // The supplied fixture contract deliberately contradicts A's claimed pass in the score case.
            if (score !== undefined) writeFileSync(join(opts.runDir, 'gate_contract.json'), JSON.stringify({ metric: 'fixture_score', threshold: 1, higherIsBetter: true }));
            writeFileSync(join(opts.runDir, `verdict_${opts.stageId}.json`), JSON.stringify({ pass, reason: pass ? 'oracle passed' : 'oracle failed', criteria: results,
              ...(score === undefined ? {} : { metric: 'fixture_score', value: score, threshold: 1 }) }));
            return fixtureResult({ output: 'reviewed', exitCode: 0, duration_ms: 1 }, opts);
          }
          if (options.approval) {
            writeFileSync(join(opts.runDir, 'stages', opts.stageId, 'approval_request.json'), JSON.stringify({ id: `fixture-${label}`, action: 'publish', target: 'fixture' }));
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
      ];
      if (options.staged) config.dispatch = [
        { id: 'implement', role: 'coder', scope: ['twice.js', 'report.md'] },
        { id: 'review', role: 'qa', depends_on: ['implement'], is_gate: true, scope: [] },
        { id: 'finish', role: 'coder', depends_on: ['review'], scope: ['twice.js'] },
        { id: 'review_final', role: 'qa', depends_on: ['finish'], is_gate: true, scope: [] },
        { id: 'repair', role: 'coder', depends_on: ['review', 'review_final'], retry_to: ['review', 'review_final'], scope: ['twice.js', 'report.md'] },
      ];
      const existing = args.includes('--existing-run-id') ? args[args.indexOf('--existing-run-id') + 1] : undefined;
      const state = await runWorkflow(config, raw, target, adapters.get(target)!, new Map(), undefined, agentsDir, existing,
        stdin ?? task, true, false, undefined, false, undefined, undefined, args.includes('--defer-gates'));
      states.set(target, state);
      return { code: state.status === 'complete' || state.status === 'parked' ? 0 : 1, output: state.status };
    },
    readRun(target) {
      const state = states.get(target); if (!state) return undefined;
      const stages = state.planControl?.stages ?? [];
      return { runId: state.runId, status: state.status, gatesDeferred: state.gatesDeferred && !state.parked,
        gatePassed: stages.some(s => s.is_gate) && collectGateRuntimeFacts(stages, state, target, state.runId).allPass,
        failureReason: state.failureReason, declaredOutputs: ['report.md'] };
    },
    diff: target => { const source = readFileSync(join(target, 'twice.js'), 'utf8'); comparedSources.set(target, source); return source; },
    judge: async () => { if (!comparisons) callsAtComparison = [...calls]; comparisons++; return { choice: (options.answers ?? ['A', 'B'])[judgment++] }; },
    write: (p, text) => writeFileSync(p, text), out: () => {},
  };
  const prefix = join(directory, 'candidate');
  const code = await runRace(['--brief', brief, '--project', directory, '--base', 'main', '--target', prefix, '--branch', 'fixture', '--no-supervise'], deps);
  const record = JSON.parse(readFileSync(prefix + '-race.json', 'utf8'));
  if (record.chosenTarget) expect(correct(readFileSync(join(record.chosenTarget, 'twice.js'), 'utf8'))).toBe(true);
  return { code, record, states, calls, comparedSources, callsAtComparison };
}

describe('race through admitted scheduler workflows', () => {
  it('normally delivers only the preferred gated change and spends no loser review/repair', async () => {
    const { code, record, calls, states } = await raceFixture({ authored: [good, bad], repairs: [good, good] });
    expect(code).toBe(0); expect(record.decision.choice).toBe('A');
    expect(calls).toHaveLength(3);
    expect(calls.slice(0, 2)).toEqual(expect.arrayContaining([{ label: 'A', stage: 'implement' }, { label: 'B', stage: 'implement' }]));
    expect(calls[2]).toEqual({ label: 'A', stage: 'review' });
    const loser = [...states.values()].find(s => s.projectDir.endsWith('-b'))!;
    expect(loser.status).toBe('parked'); expect(loser.stages.review.attempts ?? []).toHaveLength(0);
    expect(loser.stages.repair.attempts ?? []).toHaveLength(0);
  });

  it('finishes independent authoring peers before comparison and gates only the selected workflow', async () => {
    const { code, record, calls } = await raceFixture({ authored: [good, good], repairs: [good, good], peers: true });
    expect(code).toBe(0); expect(record.decision.choice).toBe('A');
    expect(calls.filter(c => c.label === 'B').map(c => c.stage).sort()).toEqual(['implement', 'notes']);
    expect(calls.filter(c => c.label === 'A').map(c => c.stage).sort()).toEqual(['implement', 'notes', 'review']);
  });

  it('keeps a failed authoring peer ineligible instead of parking it as a complete candidate', async () => {
    const { code, record, calls, states } = await raceFixture({ authored: [good, good], repairs: [good, good], peers: true, failedPeer: true });
    expect(code).toBe(0); expect(record.selection).toMatchObject({ choice: 'B', basis: 'only-ready' });
    expect(record.judgments).toHaveLength(0);
    expect(calls.filter(c => c.label === 'A' && c.stage === 'review')).toHaveLength(0);
    expect([...states.values()].find(s => s.projectDir.endsWith('-a'))!.status).toBe('incomplete');
  });

  it.each(['A', 'B'])('compares distinguishing downstream authoring after intermediate prerequisites, then gates %s', async preferred => {
    const finished = preferred === 'A' ? [good, bad] : [bad, good];
    const { code, record, calls, states, comparedSources, callsAtComparison } = await raceFixture({
      authored: [good, good], repairs: [good, good], staged: true, finished, answers: preferred === 'A' ? ['A', 'B'] : ['B', 'A'],
    });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: preferred, basis: 'comparison' });
    expect(calls.filter(c => c.label === preferred).map(c => c.stage)).toEqual(['implement', 'review', 'finish', 'review_final']);
    expect(calls.filter(c => c.label !== preferred).map(c => c.stage)).toEqual(['implement', 'review', 'finish']);
    expect(callsAtComparison.filter(c => c.stage === 'finish')).toHaveLength(2);
    expect(callsAtComparison.some(c => c.stage === 'review_final')).toBe(false);
    expect([...comparedSources.values()]).toEqual(finished);
    expect([...comparedSources.values()].map(correct)).toEqual(preferred === 'A' ? [true, false] : [false, true]);
    expect(readFileSync(join(record.chosenTarget, 'twice.js'), 'utf8')).toBe(good);
    const winner = states.get(record.chosenTarget)!;
    expect(winner.stages['review_final'].attempts).toHaveLength(1);
    expect(winner.stages.finish.attempts).toHaveLength(1);
  });

  it('repairs a rejected intermediate prerequisite before comparing both finished candidates', async () => {
    const { code, record, calls, comparedSources, callsAtComparison } = await raceFixture({
      authored: [bad, good], finished: [good, bad], repairs: [good, good], staged: true,
    });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'A', basis: 'comparison' });
    expect(calls.filter(c => c.label === 'A').map(c => c.stage)).toEqual(['implement', 'review', 'repair', 'review', 'finish', 'review_final']);
    expect(calls.filter(c => c.label === 'B').map(c => c.stage)).toEqual(['implement', 'review', 'finish']);
    expect(callsAtComparison.filter(c => c.stage === 'finish')).toHaveLength(2);
    expect([...comparedSources.values()].map(correct)).toEqual([true, false]);
  });

  it('continues repair round coordinates across the comparison hold without overwriting rejected evidence', async () => {
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

  it('does not reset an exhausted intermediate repair budget when the preferred final gate rejects', async () => {
    const { code, record, calls, states } = await raceFixture({
      authored: [bad, good], finished: [bad, good], repairs: [good, good], staged: true, gateBudget: 1,
    });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(record.gateAttempts.map((a: { pass: boolean }) => a.pass)).toEqual([false, true]);
    expect(calls.filter(c => c.label === 'A' && c.stage === 'repair')).toHaveLength(1);
    const preferred = [...states.values()].find(s => s.projectDir.endsWith('-a'))!;
    expect(preferred.status).toBe('incomplete'); expect(preferred.stages.repair.attempts).toHaveLength(1);
  });

  it('continues the same admitted run, preserves author attempts, and gates its repaired final revision', async () => {
    const { code, record, states, calls } = await raceFixture({ authored: [bad, bad], repairs: [good, good] });
    expect(code).toBe(0); expect(record.gateAttempts).toEqual([expect.objectContaining({ label: 'A', pass: true })]);
    expect(calls.filter(c => c.label === 'A').map(c => c.stage)).toEqual(['implement', 'review', 'repair', 'review']);
    const winner = states.get(record.chosenTarget)!;
    expect(winner.stages.implement.attempts).toHaveLength(1); expect(winner.stages.review.attempts).toHaveLength(2);
    expect(winner.stages.repair.attempts).toHaveLength(1); expect(winner.gatesDeferred).toBeUndefined();
    expect(record.gateAttempts[0].runId).toBe(winner.runId); expect(winner.currentIteration).toBe(1);
    expect(readFileSync(join(record.chosenTarget, 'twice.js'), 'utf8')).toBe(good);
    expect(readFileSync(join(runDir(winner.projectDir, winner.runId), 'gate_reevaluation', 'iteration_1', 'round_1', 'rejected_verdict_review.json'), 'utf8')).toContain('false');
  });

  it.each([['A', 'B'], ['A', 'A'], [undefined, undefined]] as const)('gates the alternative after preferred bounded failure, including uncertain comparisons (%s, %s)', async (a, b) => {
    const { code, record, calls } = await raceFixture({ authored: [bad, good], repairs: [bad, good], answers: [a, b] });
    expect(code).toBe(0); expect(record.decision).toMatchObject({ choice: 'B', basis: 'gated-fallback' });
    expect(record.gateAttempts).toEqual([expect.objectContaining({ label: 'A', pass: false }), expect.objectContaining({ label: 'B', pass: true })]);
    expect(calls.filter(c => c.label === 'B').map(c => c.stage)).toEqual(['implement', 'review']);
  });

  it('records why neither passed after both bounded failures', async () => {
    const { code, record } = await raceFixture({ authored: [bad, bad], repairs: [bad, bad] });
    expect(code).toBe(1); expect(record.decision.basis).toBe('none-passed'); expect(record.chosenTarget).toBeUndefined();
    expect(record.gateAttempts.map((a: { pass: boolean }) => a.pass)).toEqual([false, false]);
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

  it('does not mistake a consequential approval park for authored gate readiness', async () => {
    const { code, record, calls } = await raceFixture({ authored: [good, good], repairs: [good, good], approval: true });
    expect(code).toBe(1); expect(record.selection.basis).toBe('none-ready'); expect(record.gateAttempts).toEqual([]);
    expect(calls.every(c => c.stage === 'implement')).toBe(true);
  });
});
