import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { captureResearchGateCandidate, readResearchGateCandidate } from '../src/research-candidate.js';
import { readRunEvents } from '../src/run-events.js';
import { runWorkflow } from '../src/scheduler.js';
import { advanceSettledResearch } from '../src/scheduler/sched_loop/research-progress.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createRun, fcGlobalDir, readRunState, setFcGlobalDir, writeRunState } from '../src/store.js';

const repository = resolve(import.meta.dirname, '..');
const resultFile = 'artifacts/round.json';
const gate = StageConfigSchema.parse({ id: 'review_new', role: 'qa', is_gate: true });
const workflow = { name: 'captured-research', description: '', defaults: {}, stages: [gate] };
let root: string, project: string, directory: string, runId: string, previousStore: string;

beforeEach(() => {
  root = mkdtempSync(join(repository, '.tmp_captured-research-'));
  project = join(root, 'project');
  mkdirSync(join(project, 'artifacts'), { recursive: true });
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  const run = createRun(project, workflow.name, 'name: captured-research\nstages: []\n', [gate.id]);
  runId = run.runId;
  directory = run.runDirPath;
  const state = readRunState(project, runId);
  state.status = 'running';
  state.startedAt = new Date(0).toISOString();
  state.currentIteration = 2;
  state.research = {
    baseline: 0, policy: 'best_of_n', resultFile, reportDir: 'artifacts', stop: { maxRounds: 8 },
    resultSchema: { type: 'object', required: ['label', 'result', 'admissible'], properties: { admissible: { const: true } } },
    integrity: { maxStdRatio: 0.5 },
  };
  // A same-attempt correction is an accepted completed gate, including for ingestion.
  state.stages[gate.id] = { status: 'complete', retries: 0, attempts: [{ index: 1, status: 'complete', disposition: 'repaired', startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), exitCode: 0 }] };
  writeRunState(project, runId, state);
  writeFileSync(join(directory, `verdict_${gate.id}.json`), JSON.stringify({ pass: true, reason: 'Independent review agrees.' }));
});
afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});
const read = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
function capture(value: object) {
  writeFileSync(join(project, resultFile), JSON.stringify(value));
  return captureResearchGateCandidate(project, directory, gate.id);
}
async function advance() {
  return advanceSettledResearch(readRunState(project, runId), [gate], [], 2, [gate.id], 0, 1, 8,
    new Set(), new Map(), project, runId, directory, workflow, new ScriptedAdapter({}), new Map(),
    join(repository, 'config/agents'), new Map());
}

describe('captured research evidence is the ingestion source', () => {
  it('banks the exact repaired-gate candidate after an old producer overwrites the latest result', async () => {
    const old = { label: 'measurement-old', outcome: 'measured', result: 0.1 };
    writeFileSync(join(directory, 'research_journal.json'), JSON.stringify({ rounds: [old] }));
    writeFileSync(join(directory, 'research_round_1_consumed.json'), JSON.stringify(old));
    const measured = { label: 'measurement-new', result: 0.2, result_std: 0.01, admissible: true, evidence: 'artifacts/new-evidence.json' };
    capture(measured);
    writeFileSync(join(project, resultFile), JSON.stringify(old));
    await advance();
    expect(read('research_journal.json').rounds).toEqual([old, expect.objectContaining({ label: measured.label, result: measured.result, resultStd: 0.01, evidence: measured.evidence })]);
    expect(read('research_round_2_consumed.json')).toEqual(measured);
    expect(JSON.parse(readFileSync(join(project, resultFile), 'utf8'))).toEqual(old);
    expect(readResearchGateCandidate(directory, gate.id)?.settlement).toMatchObject({ disposition: 'ingested' });
    await advance();
    expect(read('research_journal.json').rounds).toHaveLength(2);
    expect(readRunEvents(project, runId).filter(event => event.type === 'research_gate_candidate_settled')).toHaveLength(1);
  });

  it('settles every leftover capture before the policy terminal completion is published', async () => {
    const state = readRunState(project, runId);
    state.research!.stop = { maxRounds: 1 };
    writeRunState(project, runId, state);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      capture({ label: 'accepted-measurement', result: 0.2, admissible: true });
      vi.setSystemTime(Date.now() + 1);
      captureResearchGateCandidate(project, directory, 'unaccepted-review');
    } finally {
      vi.useRealTimers();
    }
    const outcome = await advance();
    expect(outcome.state.status).toBe('ceiling_hit');
    expect(readResearchGateCandidate(directory, 'unaccepted-review')?.settlement?.disposition).toBe('rejected');
    const events = readRunEvents(project, runId);
    const completionIndex = events.findIndex(event => event.type === 'run_completed');
    const settlementIndices = events.flatMap((event, index) => event.type === 'research_gate_candidate_settled' ? [index] : []);
    expect(completionIndex).toBeGreaterThan(-1);
    expect(settlementIndices).toHaveLength(2);
    expect(settlementIndices.every(index => index < completionIndex)).toBe(true);
  });

  it('checks the captured integrity fields and records their rejection even after replacement', async () => {
    capture({ label: 'unstable-measurement', result: 0.2, result_std: 1, admissible: true });
    const replacement = { label: 'later-measurement', result: 0.3, admissible: true };
    writeFileSync(join(project, resultFile), JSON.stringify(replacement));
    await advance();
    expect(readResearchGateCandidate(directory, gate.id)?.settlement).toMatchObject({ disposition: 'rejected', reason: expect.stringContaining('unstable') });
    expect(read('research_integrity_rejections.json')).toEqual({ unstable: 1 });
    expect(JSON.parse(readFileSync(join(project, resultFile), 'utf8'))).toEqual(replacement);
  });

  it('records why a captured measurement was excluded by unsettled gates', async () => {
    capture({ label: 'unaccepted-measurement', result: 0.2, admissible: true });
    writeFileSync(join(directory, `verdict_${gate.id}.json`), JSON.stringify({ pass: false, reason: 'Measurement did not reproduce.' }));
    await advance();
    expect(readResearchGateCandidate(directory, gate.id)?.settlement).toMatchObject({ disposition: 'rejected', reason: expect.stringContaining('review_new') });
    expect(readRunEvents(project, runId).some(event => event.type === 'research_gate_candidate_settled' && event.detail?.includes('rejected'))).toBe(true);
  });

  it('records rejection before a gate re-evaluation replaces an unconsumed capture', () => {
    const first = capture({ label: 'first-measurement', result: 0.1, admissible: true });
    capture({ label: 'replacement-measurement', result: 0.2, admissible: true });
    expect(readRunEvents(project, runId).filter(event => event.type === 'research_gate_candidate_settled')).toEqual([
      expect.objectContaining({ detail: expect.stringContaining(first.sha256!) }),
    ]);
    expect(readResearchGateCandidate(directory, gate.id)?.label).toBe('replacement-measurement');
  });

  it('preserves the supported no-candidate discriminator correction in captured evidence', async () => {
    writeFileSync(join(project, `${resultFile}.no_candidate.json`), JSON.stringify({ label: 'no-safe-candidate', status: 'no_candidate', reason: 'No independent improvement.' }));
    captureResearchGateCandidate(project, directory, gate.id);
    await advance();
    expect(read('research_journal.json').rounds).toEqual([expect.objectContaining({ label: 'no-safe-candidate', outcome: 'no_candidate' })]);
    expect(readResearchGateCandidate(directory, gate.id)?.settlement?.disposition).toBe('ingested');
  });

  it('does not require the mutable result for a non-shipping round with confirmation configured', async () => {
    const state = readRunState(project, runId);
    state.research!.stop!.beat = 1;
    state.research!.confirm = { command: 'exit 0', requires: 'Independent final confirmation' };
    writeRunState(project, runId, state);
    capture({ label: 'below-target', result: 0.2, admissible: true });
    writeFileSync(join(project, resultFile), JSON.stringify({ label: 'later', result: 0.3, admissible: true }));
    await advance();
    expect(read('research_journal.json').rounds).toEqual([expect.objectContaining({ label: 'below-target', result: 0.2 })]);
    expect(readResearchGateCandidate(directory, gate.id)?.settlement?.disposition).toBe('ingested');
  });


  it('records an explicit rejection when admission ends the run before iteration dispatch', async () => {
    capture({ label: 'terminal-leftover', result: 0.2, admissible: true });
    const state = readRunState(project, runId);
    state.stages[gate.id] = { status: 'pending', retries: 0 };
    state.maxIterations = 1;
    writeRunState(project, runId, state);
    writeFileSync(join(project, 'STOP'), 'Synthetic stop requested');
    const brief = '---\nprogram:\n  name: fixture\n  phase: first\n  ledger: artifacts/ledger.json\n  safeguards:\n    stop_file: STOP\n---\n# Synthetic goal';
    const settled = await runWorkflow(workflow, 'name: captured-research\nstages: []\n', project, new ScriptedAdapter({}),
      new Map(), undefined, join(repository, 'config/agents'), runId, brief);
    expect(settled.status).toBe('failed');
    expect(settled.failureReason).toContain('STOP');
    expect(readResearchGateCandidate(directory, gate.id)?.settlement).toMatchObject({
      disposition: 'rejected', reason: expect.stringContaining('Run ended failed'),
    });
  });

});
