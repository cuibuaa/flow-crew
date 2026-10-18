import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRun, readRunState, type ResearchIntegrityConfig } from '../src/store.js';
import { assessResearchShipTarget } from '../src/research-policy.js';
import { createResearchAdvancer } from '../src/scheduler/sched_policy/research.js';
import { beginResearchInputGeneration } from '../src/research-candidate.js';
import type { Adapter } from '../src/adapters/base.js';

let project: string;
beforeEach(() => { project = mkdtempSync(join(tmpdir(), 'research-bounds-')); });
afterEach(() => { rmSync(project, { recursive: true, force: true }); });

async function measure(baseline: number, result: number, resultStd?: number, integrity?: ResearchIntegrityConfig) {
  const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
  const state = readRunState(project, created.runId);
  state.research = { baseline, policy: 'best_of_n', integrity, stop: { maxRounds: 8 } };
  beginResearchInputGeneration(project, state);
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs', 'research_round_result.json'), JSON.stringify({
    label: 'independent-measurement', result, ...(resultStd === undefined ? {} : { result_std: resultStd }),
    evidence: { measurement: 'candidate comparison' },
  }));
  const { tryAdvanceResearch } = createResearchAdvancer({
    listProjectFilesAt: () => [], settleFrameworkRollbackPath: () => {}, writeCampaignEntry: () => {},
  });
  await tryAdvanceResearch(state, {
    projectDir: project, runId: created.runId, runDirPath: created.runDirPath, iteration: 1, adapter: {} as Adapter,
  });
  const read = (name: string) => JSON.parse(readFileSync(join(created.runDirPath, name), 'utf8'));
  return {
    journal: existsSync(join(created.runDirPath, 'research_journal.json')) ? read('research_journal.json') : undefined,
    rejection: existsSync(join(created.runDirPath, 'research_integrity_rejections.json')) ? read('research_integrity_rejections.json') : undefined,
    decision: existsSync(join(created.runDirPath, 'research_decision.json')) ? read('research_decision.json') : undefined,
  };
}

describe('brief-declared research integrity bounds', () => {
  it('journals measured standard error and retains improvement-versus-noise accounting', async () => {
    const measured = await measure(1, 1.01, 0.1);
    expect(measured.journal.rounds).toEqual([expect.objectContaining({ result: 1.01, resultStd: 0.1 })]);
    expect(measured.decision).toMatchObject({ runningBest: 1, keptLabels: [], consecutiveNoImprovement: 1 });
  });

  it.each([0, 0.01])('refuses result %s when uncertainty exceeds the declared ratio', async (result) => {
    expect((await measure(0, result, 0.5, { maxStdRatio: 0.3 })).rejection).toEqual({ unstable: 1 });
  });

  it('refuses the same improvement beyond the brief-declared bound', async () => {
    expect((await measure(1, 6, undefined, { outlierFactor: 5 })).rejection).toEqual({ outlier_too_high: 1 });
  });

  it('uses the same declared bounds when deciding whether a ship target is reachable', () => {
    const config = {
      baseline: 1, policy: 'best_of_n' as const, stop: { beat: 6 },
      resultSchema: { properties: { result: { type: 'number', maximum: 6 }, result_std: { type: 'number', minimum: 4 } }, required: ['result_std'] },
    };
    expect(assessResearchShipTarget(config).status).toBe('reachable');
    expect(assessResearchShipTarget({ ...config, integrity: { maxStdRatio: 0.3 } }).status).toBe('unreachable');
    expect(assessResearchShipTarget({ ...config, integrity: { outlierFactor: 5 } }).status).toBe('unreachable');
  });
});
