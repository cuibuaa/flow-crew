import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { startDashboard } from '../src/dashboard.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  fcGlobalDir,
  runDir,
  setFcGlobalDir,
  type StageStatus,
  type StoreState,
} from '../src/store.js';

interface HistoricalStageEvidence {
  iteration: number;
  stageId: string;
  status: StageStatus;
  statusPath: string;
  outputPath?: string;
  attemptOutputPaths: Array<{ attemptIndex: number; path: string }>;
  verdictPath?: string;
}

let fixtureRoot: string;
let projectDir: string;
let previousFcGlobalDir: string;

const workflowYaml = [
  'name: replan-evidence-retention',
  'defaults:',
  '  max_iterations: 2',
  '  max_retries: 0',
  'stages:',
  '  - id: plan',
  '    role: planner',
  '    dynamic_dispatch: true',
].join('\n');

const workflow: WorkflowConfig = {
  name: 'replan-evidence-retention',
  defaults: { max_iterations: 2, max_retries: 0 },
  stages: [{
    id: 'plan',
    role: 'planner',
    depends_on: [],
    prompt_template: '',
    dynamic_dispatch: true,
    is_gate: false,
    skills: [],
  }],
};

function writeRoles(): string {
  const agentsDir = join(projectDir, 'config', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const role of ['planner', 'builder', 'qa']) {
    writeFileSync(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: re-plan evidence fixture role',
      'model: default',
      'reasoning_effort: default',
      'tools: []',
      'prompt: fixture',
    ].join('\n'));
  }
  return agentsDir;
}

function dispatch(workId: string, gateId: string): string {
  return [
    'stages:',
    `  - id: ${workId}`,
    '    role: builder',
    '    depends_on: [plan]',
    '    dependency_reasons: {plan: "execute this iteration"}',
    '    scope: [docs/final.md]',
    '    task: produce non-empty implementation evidence',
    `  - id: ${gateId}`,
    '    role: qa',
    `    depends_on: [${workId}]`,
    `    dependency_reasons: {${workId}: "verify this iteration"}`,
    '    scope: []',
    '    is_gate: true',
    '    task: decide whether to re-plan',
  ].join('\n');
}

function stageEvidence(state: StoreState): HistoricalStageEvidence[] {
  return (state as StoreState & { stageEvidence?: HistoricalStageEvidence[] }).stageEvidence ?? [];
}

function checksMarkdown(check: Record<string, unknown>): string {
  const params = check.params as { paths?: string[]; script?: string };
  return `## Reality checks\n\n\`\`\`yaml\nchecks:\n${[
    `  - name: ${check.name}`,
    `    type: ${check.type}`,
    ...(params.paths
      ? ['    params:', '      paths:', ...params.paths.map((path) => `        - ${path}`)]
      : [
          '    params:',
          `      script: ${JSON.stringify(params.script)}`,
        ]),
  ].join('\n')}\n\`\`\`\n`;
}

beforeEach(() => {
  previousFcGlobalDir = fcGlobalDir();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-replan-evidence-'));
  projectDir = join(fixtureRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  setFcGlobalDir(join(fixtureRoot, 'fc-home'));
});

afterEach(() => {
  setFcGlobalDir(previousFcGlobalDir);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('outer re-plan evidence retention', () => {
  it('keeps iteration-1 status, attempts, output, and verdict reachable after iteration 2 replaces the DAG', async () => {
    const adapter = new ScriptedAdapter({
      plan: [
        { output: 'iteration 1 plan', runFiles: { 'dispatch.yaml': dispatch('first_work', 'first_gate') } },
        { output: 'iteration 2 plan', runFiles: { 'dispatch.yaml': dispatch('replacement_work', 'replacement_gate') } },
      ],
      first_work: { output: 'iteration 1 implementation evidence' },
      first_gate: {
        output: 'iteration 1 audit evidence',
        runFiles: { 'verdict_first_gate.json': JSON.stringify({ pass: false, reason: 'outer re-plan required' }) },
      },
      replacement_work: { output: 'iteration 2 implementation evidence' },
      replacement_gate: {
        output: 'iteration 2 audit evidence',
        runFiles: { 'verdict_replacement_gate.json': JSON.stringify({ pass: true, reason: 'replacement accepted' }) },
      },
      _summary: { output: '## What was done\n- completed through a real outer re-plan' },
    });

    const final = await runWorkflow(
      workflow,
      workflowYaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      undefined,
      'Complete work, reject it at a gate, then preserve its evidence through the re-plan.',
      true,
      false,
    );

    expect(final.status).toBe('complete');
    expect(final.currentIteration).toBe(2);
    expect(adapter.calls.filter((call) => call.stageId === 'plan')).toHaveLength(2);
    expect(final.stages).not.toHaveProperty('first_work');
    expect(final.stages).not.toHaveProperty('first_gate');

    const work = stageEvidence(final).find((entry) => entry.iteration === 1 && entry.stageId === 'first_work');
    expect(work).toBeDefined();
    expect(work?.status).toMatchObject({ status: 'complete', exitCode: 0, attempts: [{ index: 1, status: 'complete' }] });
    expect(work?.outputPath).toBeTruthy();
    expect(readFileSync(join(runDir(projectDir, final.runId), work!.outputPath!), 'utf-8'))
      .toBe('iteration 1 implementation evidence');
    expect(work?.attemptOutputPaths).toHaveLength(1);
    expect(readFileSync(join(runDir(projectDir, final.runId), work!.attemptOutputPaths[0].path), 'utf-8'))
      .toBe('iteration 1 implementation evidence');

    const gate = stageEvidence(final).find((entry) => entry.iteration === 1 && entry.stageId === 'first_gate');
    expect(gate).toBeDefined();
    expect(gate?.status.attempts).toHaveLength(1);
    expect(gate?.verdictPath).toBeTruthy();
    expect(JSON.parse(readFileSync(join(runDir(projectDir, final.runId), gate!.verdictPath!), 'utf-8')))
      .toMatchObject({ pass: false, reason: 'outer re-plan required' });
    expect(existsSync(join(runDir(projectDir, final.runId), gate!.statusPath))).toBe(true);

    const app = await startDashboard(projectDir, 0, { distDir: join(projectDir, 'missing-dist') });
    try {
      const list = (await app.inject({ method: 'GET', url: '/api/runs' })).json() as Array<{
        runId: string;
        stageEvidence?: HistoricalStageEvidence[];
      }>;
      expect(list.find((run) => run.runId === final.runId)?.stageEvidence)
        .toEqual(expect.arrayContaining([expect.objectContaining({ iteration: 1, stageId: 'first_work' })]));

      const detail = (await app.inject({ method: 'GET', url: `/api/runs/${final.runId}` })).json() as {
        stages: Array<{ id: string }>;
        stageEvidence: HistoricalStageEvidence[];
      };
      expect(detail.stages.map((stage) => stage.id)).not.toContain('first_work');
      expect(detail.stageEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ iteration: 1, stageId: 'first_work' }),
      ]));

      const task = (await app.inject({ method: 'GET', url: `/api/tasks/${final.runId}` })).json() as {
        stageEvidence?: HistoricalStageEvidence[];
      };
      expect(task.stageEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ iteration: 1, stageId: 'first_gate' }),
      ]));
    } finally {
      await app.close();
    }
  }, 15_000);

  it('keeps same-ID iterations distinct without stale completion or attempt aliases suppressing new work', async () => {
    const adapter = new ScriptedAdapter({
      plan: [
        { output: 'first shared plan', runFiles: { 'dispatch.yaml': dispatch('shared_work', 'shared_gate') } },
        { output: 'second shared plan', runFiles: { 'dispatch.yaml': dispatch('shared_work', 'shared_gate') } },
      ],
      shared_work: [
        { output: 'shared work from iteration 1' },
        { output: 'shared work from iteration 2' },
      ],
      shared_gate: [
        {
          output: 'shared gate rejected iteration 1',
          runFiles: { 'verdict_shared_gate.json': JSON.stringify({ pass: false, reason: 'replace this plan' }) },
        },
        {
          output: 'shared gate accepted iteration 2',
          runFiles: { 'verdict_shared_gate.json': JSON.stringify({ pass: true, reason: 'replacement accepted' }) },
        },
      ],
      _summary: { output: '## What was done\n- completed same-ID replacement work' },
    });

    const final = await runWorkflow(
      workflow,
      workflowYaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      undefined,
      'Re-dispatch the same stage IDs after an outer gate rejection.',
      true,
      false,
    );

    expect(final.status).toBe('complete');
    expect(adapter.calls.filter((call) => call.stageId === 'shared_work')).toHaveLength(2);
    expect(final.stages.shared_work).toMatchObject({
      status: 'complete',
      reruns: 0,
      attempts: [{ index: 1, status: 'complete' }],
    });
    const archived = stageEvidence(final).find((entry) => entry.iteration === 1 && entry.stageId === 'shared_work');
    expect(archived?.status.attempts).toEqual([expect.objectContaining({ index: 1, status: 'complete' })]);
    expect(readFileSync(join(runDir(projectDir, final.runId), archived!.outputPath!), 'utf-8'))
      .toBe('shared work from iteration 1');
    expect(readFileSync(join(runDir(projectDir, final.runId), 'stages', 'shared_work', 'output.md'), 'utf-8'))
      .toBe('shared work from iteration 2');
    expect(readFileSync(join(runDir(projectDir, final.runId), 'stages', 'shared_work', 'output_attempt_1.md'), 'utf-8'))
      .toBe('shared work from iteration 2');
  }, 15_000);

  it('does not alter retired evidence when blocking preflight deletes and retries iteration-2 proposal files', async () => {
    const goodChecks = checksMarkdown({
      name: 'the final file exists',
      type: 'file-exists-nonempty',
      params: { paths: ['docs/final.md'] },
    });
    const blockingChecks = checksMarkdown({
      name: 'validation always passes',
      type: 'exec-script-exit-zero',
      params: { script: 'true' },
    });
    const adapter = new ScriptedAdapter({
      plan: [
        {
          output: 'iteration 1 plan',
          runFiles: { 'dispatch.yaml': dispatch('first_work', 'first_gate'), 'reality_checks.md': goodChecks },
        },
        {
          output: 'blocked iteration 2 proposal',
          runFiles: { 'dispatch.yaml': dispatch('replacement_work', 'replacement_gate'), 'reality_checks.md': blockingChecks },
        },
        {
          output: 'corrected iteration 2 proposal',
          runFiles: { 'dispatch.yaml': dispatch('replacement_work', 'replacement_gate'), 'reality_checks.md': goodChecks },
        },
      ],
      first_work: {
        output: 'evidence captured before the blocking preflight retry',
        projectFiles: { 'docs/final.md': '# Iteration 1\n' },
      },
      first_gate: {
        output: 'iteration 1 rejected',
        runFiles: { 'verdict_first_gate.json': JSON.stringify({ pass: false, reason: 'outer re-plan required' }) },
      },
      replacement_work: {
        output: 'corrected replacement executed',
        projectFiles: { 'docs/final.md': '# Iteration 2\n' },
      },
      replacement_gate: {
        output: 'corrected replacement accepted',
        runFiles: { 'verdict_replacement_gate.json': JSON.stringify({ pass: true, reason: 'accepted' }) },
      },
      _summary: { output: '## What was done\n- corrected a blocked proposal without touching history' },
    });

    const final = await runWorkflow(
      workflow,
      workflowYaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      writeRoles(),
      undefined,
      'Create docs/final.md, preserve completed evidence, and correct any refused planner checks.',
      true,
      false,
    );

    expect(final.status).toBe('complete');
    expect(final.currentIteration).toBe(2);
    expect(adapter.calls.filter((call) => call.stageId === 'plan')).toHaveLength(3);
    expect(adapter.calls.filter((call) => call.stageId === 'replacement_work')).toHaveLength(1);
    expect(adapter.calls.filter((call) => call.stageId === 'plan')[2].prompt).toContain('hard_check_cannot_fail');
    const archived = stageEvidence(final).filter((entry) => entry.iteration === 1 && entry.stageId === 'first_work');
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(runDir(projectDir, final.runId), archived[0].outputPath!), 'utf-8'))
      .toBe('evidence captured before the blocking preflight retry');
    expect(readFileSync(join(runDir(projectDir, final.runId), archived[0].statusPath), 'utf-8'))
      .toContain('"status": "complete"');
  }, 15_000);
});
