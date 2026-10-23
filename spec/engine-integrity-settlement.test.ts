import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';

import { beginResearchInputGeneration, captureResearchGateCandidate, readResearchGateCandidate } from '../src/research-candidate.js';
import { readRunEvents } from '../src/run-events.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import { fcGlobalDir, readRunState, readStageStatus, setFcGlobalDir, writeRunState } from '../src/store.js';
import { prepareFixtureRun } from './spec_runtime/run-fixture.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';

let root: string, project: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-integrity-settlement-'));
  project = join(root, 'project');
  mkdirSync(join(project, 'config', 'agents'), { recursive: true });
  previousStore = fcGlobalDir();
  setFcGlobalDir(join(root, 'store'));
  });
afterEach(() => {
  setFcGlobalDir(previousStore);
  rmSync(root, { recursive: true, force: true });
});

it.each(['REFUSED', 'TAMPERED'] as const)('settles real ENGINE_STATE_%s once without retrying authored work', async kind => {
  const role: AgentConfig = { name: 'fixture', description: '', model: 'default', reasoning_effort: 'low', tools: [], prompt: 'Review the work.' };
  writeFileSync(join(project, 'config', 'agents', 'fixture.yaml'), stringify(role));
  const workflow: WorkflowConfig = {
    name: 'fixture', description: '', defaults: { max_iterations: 3, max_retries: 2 },
    stages: [{ id: 'review', role: 'fixture', depends_on: [], scope: [], skills: [],
      dynamic_dispatch: false, is_gate: true, criterion_refs: [], prompt_template: 'Review the work.',
      artifact_contract: fixtureArtifactContract('review', true) },
      { id: 'repair', role: 'fixture', depends_on: ['review'], retry_to: ['review'], scope: [], skills: [],
        dynamic_dispatch: false, is_gate: false, criterion_refs: [], prompt_template: 'Repair the rejected work.',
        artifact_contract: fixtureArtifactContract('repair') }],
  };
  const yaml = stringify(workflow);
  const created = prepareFixtureRun(project, workflow, yaml);
  const state = readRunState(project, created.runId);
  state.startedAt = new Date(0).toISOString();
  state.research = { baseline: 0, policy: 'greedy_stack', resultFile: 'round.json' };
  beginResearchInputGeneration(project, state);
  writeRunState(project, created.runId, state);
  writeFileSync(join(project, 'round.json'), JSON.stringify({ label: 'independent-measurement', result: 0.2 }));
  captureResearchGateCandidate(project, created.runDirPath, 'earlier_review');
  const authored = join(project, 'state.json');
  writeFileSync(authored, '{"pass":true}');
  if (kind === 'REFUSED') symlinkSync(authored, join(created.runDirPath, 'verdict_previous.json'));
  let adapterCalls = 0, protectedWorkflow: string | undefined;
  const adapter: Adapter = { async run() {
    adapterCalls++;
    if (kind === 'REFUSED') throw new Error('Carrier refusal must precede adapter execution');
    protectedWorkflow = readFileSync(join(created.runDirPath, 'workflow.yaml'), 'utf8');
    writeFileSync(join(created.runDirPath, 'workflow.yaml'), 'counterfeit workflow');
    return { exitCode: 0, output: 'Counterfeit acceptance.', duration_ms: 1 };
  } };

  const settled = await runWorkflow(workflow, yaml, project, adapter, new Map([['fixture', role]]),
    undefined, join(project, 'config', 'agents'), created.runId);

  expect(readResearchGateCandidate(created.runDirPath, 'earlier_review')?.settlement).toMatchObject({
    disposition: 'rejected', reason: expect.stringContaining('Run ended failed'),
  });
  expect(adapterCalls).toBe(kind === 'REFUSED' ? 0 : 1);
  expect(settled.status).toBe('failed');
  expect(settled.failureReason).toContain(`ENGINE_STATE_${kind}`);
  expect(readRunState(project, created.runId).status).toBe('failed');
  const stage = readStageStatus(project, created.runId, 'review');
  expect(stage.status).toBe('failed');
  expect(stage.error).toContain(`ENGINE_STATE_${kind}`);
  expect(stage.attempts).toHaveLength(1);
  expect(stage.attempts![0]).toMatchObject({ status: 'failed', exitCode: 125, terminationCause: 'engine_void', engineVoid: true });
  expect(stage.retries).toBe(0);
  if (kind === 'TAMPERED') expect(readFileSync(join(created.runDirPath, 'workflow.yaml'), 'utf8')).toBe(protectedWorkflow);
  const events = readRunEvents(project, created.runId);
  const failed = events.filter(event => event.stageId === 'review' && event.type === 'attempt_failed');
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ exitCode: 125, status: 'failed', disposition: 'discarded', source: 'worker' });
  expect(failed[0].detail).toContain(`ENGINE_STATE_${kind}`);
  expect(events.filter(event => event.type === 'run_completed')).toHaveLength(1);
  expect(events.findIndex(event => event.type === 'attempt_failed')).toBeLessThan(events.findIndex(event => event.type === 'run_completed'));
});
