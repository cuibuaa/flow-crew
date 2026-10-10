import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { createRun, fcGlobalDir, readRunState, runDir, setFcGlobalDir } from '../src/store.js';
import { configureWorkflowBrief } from '../src/scheduler/sched_loop/brief.js';
import { createResearchBudgetFinalizer } from '../src/scheduler/sched_loop/research-terminal.js';
import { createResearchAdvancer } from '../src/scheduler/sched_policy/research.js';

let root: string, project: string, previousStore: string;
const workflow = { name: 'fixture', description: '', defaults: {}, stages: [] };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-project-writes-'));
  project = join(root, 'project');
  mkdirSync(project);
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'state'));
});
afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

describe('engine bookkeeping stays outside the project', () => {
  it('refuses a program safeguard through run state without creating an abort document', () => {
    writeFileSync(join(project, 'STOP'), 'Stop requested');
    const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []);
    const brief = '---\nprogram:\n  name: fixture\n  phase: first\n  ledger: records/ledger.json\n  safeguards:\n    stop_file: STOP\n---\n# Goal\nExercise safeguard refusal.';
    const configured = configureWorkflowBrief(workflow, project, runId, runDir(project, runId), 1, false, brief);
    expect(configured.kind).toBe('settled');
    expect(readRunState(project, runId)).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('STOP') });
    expect(readdirSync(project)).toEqual(['STOP']);
    expect(readFileSync(join(runDir(project, runId), 'task_brief.md'), 'utf8')).toBe(brief);
  });

  it.each(['budget', 'round'] as const)('keeps only the declared research report (%s terminal)', async kind => {
    const { runId } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', []);
    const state = readRunState(project, runId);
    // No real agent, process, or confirmation command is needed to settle a no-candidate round.
    state.startedAt = '2026-01-01T00:00:00.000Z';
    state.research = { baseline: 0, policy: 'greedy_stack', resultFile: 'round.json', reportDir: 'reports', stop: { maxRounds: 1 } };
    state.terminalStates = { ceiling_hit: { paths: ['declared.md'] } };
    const base = runDir(project, state.runId);
    const adapter = new ScriptedAdapter({});
    let settled;
    if (kind === 'budget') {
      writeFileSync(join(base, 'research_journal.json'), JSON.stringify({ rounds: [{ label: 'first', outcome: 'no_candidate', reason: 'No safe candidate' }] }));
      const finish = createResearchBudgetFinalizer(project, state.runId, base, workflow, adapter, new Map(), project, new Map());
      settled = await finish(state, 1, 'Budget exhausted', { stages: [], injectedDispatchStages: new Set(), planStageRetries: new Map() });
      expect(readdirSync(project)).toEqual(['declared.md']);
    } else {
      writeFileSync(join(project, 'round.json.no_candidate.json'), JSON.stringify({ label: 'first', outcome: 'no_candidate', reason: 'No safe candidate' }));
      const { tryAdvanceResearch } = createResearchAdvancer({ listProjectFilesAt: () => [], settleFrameworkRollbackPath: () => {}, writeCampaignEntry: () => {} });
      settled = await tryAdvanceResearch(state, { projectDir: project, runId: state.runId, runDirPath: base, iteration: 1, adapter });
      // The manifest is consumed by project confirmation and reality checks.
      expect(readdirSync(join(project, 'reports'))).toEqual(['run_manifest.json']);
      expect(JSON.parse(readFileSync(join(project, 'reports', 'run_manifest.json'), 'utf8')).rounds).toHaveLength(1);
    }
    expect(settled?.status).toBe('ceiling_hit');
    expect(readFileSync(join(project, 'declared.md'), 'utf8')).toContain('No safe candidate');
    expect(readRunState(project, state.runId).status).toBe('ceiling_hit');
  });
});
