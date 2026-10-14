import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, AgentConfig } from '../src/adapters/base.js';
import { executeOrdinaryStage } from '../src/scheduler/sched_loop/ordinary-stage.js';
import { executeSingleStage } from '../src/scheduler/sched_settlement/stage-execution.js';
import { StageConfigSchema } from '../src/scheduler/sched_admission/configuration.js';
import { createScopeBatchContext } from '../src/scheduler/sched_scope/scope-batch.js';
import { createRun, fcGlobalDir, readRunState, setFcGlobalDir } from '../src/store.js';
import { clearAttemptSummaryRefreshDebounce } from '../src/run-events.js';
import { readDispatchDocument } from '../src/dispatch-document.js';
import { collectStageAuthoredChecks } from '../src/verdict-controls.js';
import { renderGuidanceEnvelope } from '../src/guidance.js';

const roots: string[] = [];
let previousStore: string;
beforeEach(() => { previousStore = fcGlobalDir(); });
afterEach(() => { clearAttemptSummaryRefreshDebounce(); setFcGlobalDir(previousStore); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('dispatch transport and gate-control readers', () => {
  it('retains bare and wrapped stage lists through the same reader', () => {
    const stages = [{ id: 'work', role: 'coder' }];
    expect(readDispatchDocument(JSON.stringify(stages)).stages).toEqual(stages);
    expect(readDispatchDocument(JSON.stringify({ stages, scope_negotiation: { defer: ['known'] } })).document).toEqual({ stages, scope_negotiation: { defer: ['known'] } });
    for (const text of ['', 'stages: false', 'scalar', 'stages: [']) expect(() => readDispatchDocument(text)).toThrow();
  });

  it.each(['ordinary', 'retry'])('loads a typed role and refuses unreadable or malformed role files before invoking a %s worker', async boundary => {
    const root = mkdtempSync(join(tmpdir(), 'fc-role-reader-')); roots.push(root);
    const project = join(root, 'project'), agentsDir = join(project, 'config/agents');
    mkdirSync(agentsDir, { recursive: true }); setFcGlobalDir(join(root, 'store'));
    const stage = StageConfigSchema.parse({ id: 'work', role: 'writer', scope: [], artifact_contract: { version: 1, produces: [], reads: [], groups: [], replays: [] } });
    const { runId, runDirPath } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', [stage.id]);
    const state = readRunState(project, runId), agents = new Map<string, AgentConfig>();
    const run = vi.fn<Adapter['run']>(async () => ({ output: JSON.stringify({ status: 'delivered', summary: 'Role loaded.', checks: [], caveats: [] }), exitCode: 0, duration_ms: 1 }));
    const execute = async () => boundary === 'ordinary'
      ? (await executeOrdinaryStage(stage, [stage], state, project, runId, runDirPath, { run }, agents, agentsDir,
          new Map(), new Map(), createScopeBatchContext(project, [stage], undefined, runId))).result
      : executeSingleStage(stage, project, runId, runDirPath, { name: 'fixture', defaults: {}, stages: [stage] }, { run }, agents, agentsDir, state, [stage]);
    await expect(execute()).rejects.toMatchObject({ code: 'ENOENT' });
    writeFileSync(join(agentsDir, 'writer.yaml'), JSON.stringify({ name: 'writer', prompt: false }));
    await expect(execute()).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    writeFileSync(join(agentsDir, 'writer.yaml'), JSON.stringify({ name: 'writer', prompt: 'Write the requested result.' }));
    expect((await execute())?.exitCode).toBe(0);
    expect(run).toHaveBeenCalled();
    expect(agents.get('writer')?.name).toBe('writer');
  });
  it('finds attributed criterion checks for both recorded transport shapes', () => {
    const run = mkdtempSync(join(tmpdir(), 'fc-dispatch-reader-')); roots.push(run);
    mkdirSync(join(run, 'stages/work'), { recursive: true });
    writeFileSync(join(run, 'stages/work/status.json'), JSON.stringify({ status: 'complete', writeAttribution: 'structured', writes: ['spec/current.test.ts'] }));
    writeFileSync(join(run, 'supervisor_guidance.md'), renderGuidanceEnvelope({ version: 1, id: 'ruling', target: '*', source: 'operator', createdAt: '2026-10-06T00:00:00.000Z', criterionIds: ['C1'], body: 'Account for C1.' }));
    const stages = [{ id: 'work', criterion_refs: ['C1'] }, { id: 'audit', is_gate: true, depends_on: ['work'] }];
    for (const document of [stages, { stages }]) {
      writeFileSync(join(run, 'dispatch.yaml'), JSON.stringify(document));
      expect(collectStageAuthoredChecks(run, 'audit', ['C1'])).toEqual([{ criterionId: 'C1', authorStageId: 'work', path: 'spec/current.test.ts' }]);
    }
    writeFileSync(join(run, 'stages/work/status.json'), JSON.stringify({ status: 'pending', writeAttribution: 'structured', writes: ['spec/current.test.ts'] }));
    expect(collectStageAuthoredChecks(run, 'audit', ['C1'])).toEqual([]);
  });
});
