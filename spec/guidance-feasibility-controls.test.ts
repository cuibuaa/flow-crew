import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Adapter,
  AgentConfig,
  CommandLifecycleEvent,
  RunOpts,
  RunResult,
} from '../src/adapters/base.js';
import { CommandActivityTracker } from '../src/command-activity.js';
import { appendGuidanceEnvelope } from '../src/guidance.js';
import { buildStagePrompt } from '../src/handoff.js';
import { readGateVerdict } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  setFcGlobalDir,
  writeStageStatus,
} from '../src/store.js';
import { runStage } from '../src/worker.js';

const repositoryRoot = join(import.meta.dirname, '..');
const role: AgentConfig = {
  name: 'coder',
  description: 'command-control fixture',
  model: 'test',
  reasoning_effort: 'low',
  tools: [],
  prompt: 'fixture system prompt',
};

type LifecycleOpts = RunOpts & {
  onCommandLifecycle?: (event: CommandLifecycleEvent) => void;
};

let projectDir: string;
let stateRoot: string;
let priorStateRoot: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-guidance-controls-project-'));
  stateRoot = mkdtempSync(join(tmpdir(), 'flowcrew-guidance-controls-state-'));
  priorStateRoot = fcGlobalDir();
  setFcGlobalDir(stateRoot);
  mkdirSync(join(projectDir, 'docs'), { recursive: true });
});

afterEach(() => {
  setFcGlobalDir(priorStateRoot);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

function makeRun(stageIds: string[]) {
  const created = createRun(
    projectDir,
    'guidance-controls',
    `name: guidance-controls\nstages:\n${stageIds.map((id) => `  - id: ${id}\n    role: coder`).join('\n')}\n`,
    stageIds,
  );
  mkdirSync(join(created.runDirPath, 'signals'), { recursive: true });
  writeFileSync(join(created.runDirPath, 'task_brief.md'), '# Command control fixture\n', 'utf-8');
  return created;
}

function stageOptions(created: { runId: string; runDirPath: string }, stageId = 'work') {
  return {
    stageId,
    role,
    dependsOn: [],
    promptTemplate: 'Do the fixture work.',
    timeout_ms: 10_000,
    projectDir,
    runId: created.runId,
    runDir: created.runDirPath,
    retries: 0,
    projectWriteScope: [],
  };
}

function events(runDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, 'events.jsonl'), 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('live guidance and feasibility controls', () => {
  it('[J1] delivers guidance written after attempt start at a long-command completion boundary', async () => {
    const created = makeRun(['work']);
    const prompts: string[] = [];
    let commandStarts = 0;
    let writtenGuidanceId: string | undefined;
    const adapter: Adapter = {
      async run(prompt, _agent, rawOpts): Promise<RunResult> {
        prompts.push(prompt);
        if (prompts.length > 1) return { output: 'bounded completion', exitCode: 0, duration_ms: 1 };
        const opts = rawOpts as LifecycleOpts;
        commandStarts++;
        opts.onCommandLifecycle?.({
          phase: 'started', id: 'long-command', command: 'python measure.py --blocks 10000',
          timestamp: new Date().toISOString(),
        });
        writtenGuidanceId = appendGuidanceEnvelope({
          runDir: created.runDirPath,
          target: 'work',
          source: 'operator',
          body: 'Stop the oversized measurement and report the bounded evidence already available.',
          knownStageIds: ['work'],
        }).id;
        opts.onCommandLifecycle?.({
          phase: 'completed', id: 'long-command', timestamp: new Date().toISOString(),
        });
        return {
          output: 'first invocation ended at command boundary',
          exitCode: opts.abortSignal?.aborted ? 137 : 0,
          duration_ms: 1,
        };
      },
    };

    const result = await runStage(adapter, stageOptions(created));
    const ledger = events(created.runDirPath);
    const receipt = readFileSync(
      join(created.runDirPath, 'stages', 'work', 'guidance_consumed.md'),
      'utf-8',
    );
    expect({ exitCode: result.exitCode, invocations: prompts.length, commandStarts }).toEqual({
      exitCode: 0, invocations: 2, commandStarts: 1,
    });
    expect(prompts[1]).toContain('Stop the oversized measurement');
    expect(receipt).toContain('Stop the oversized measurement');
    const startedAt = ledger.findIndex((event) => event.type === 'stage_command_started');
    const writtenAt = ledger.findIndex((event) => (
      event.type === 'guidance_written' && event.guidanceId === writtenGuidanceId
    ));
    const deliveredAt = ledger.findIndex((event) => (
      event.type === 'guidance_delivery_checked'
      && event.boundary === 'tool_call_completion'
      && event.delivered === true
    ));
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(writtenAt).toBeGreaterThan(startedAt);
    expect(deliveredAt).toBeGreaterThan(writtenAt);
    expect(ledger.filter((event) => event.type === 'stage_command_started')).toHaveLength(1);
    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'stage_command_started', commandId: 'long-command' }),
      expect.objectContaining({
        type: 'guidance_delivery_checked', boundary: 'tool_call_completion', delivered: true,
      }),
      expect.objectContaining({ type: 'stage_command_completed', commandId: 'long-command' }),
    ]));
  });

  it('[J2] records and stops an explicit command timeout that exceeds the remaining attempt budget', async () => {
    const created = makeRun(['work']);
    const prompts: string[] = [];
    const adapter: Adapter = {
      async run(prompt, _agent, rawOpts): Promise<RunResult> {
        prompts.push(prompt);
        if (prompts.length > 1) return { output: 'bounded alternative', exitCode: 0, duration_ms: 1 };
        const opts = rawOpts as LifecycleOpts;
        opts.onCommandLifecycle?.({
          phase: 'started', id: 'over-budget', command: 'timeout 60s python measure.py',
          timestamp: new Date().toISOString(),
        });
        return {
          output: 'projection boundary',
          exitCode: opts.abortSignal?.aborted ? 137 : 0,
          duration_ms: 1,
        };
      },
    };
    const options = { ...stageOptions(created), timeout_ms: 5_000 };

    const result = await runStage(adapter, options);
    const projection = events(created.runDirPath)
      .find((event) => event.type === 'command_timeout_projection');
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Projected shortfall');
    expect(projection).toMatchObject({
      commandId: 'over-budget',
      command: 'timeout 60s python measure.py',
      commandTimeoutMs: 60_000,
      shortfallMs: expect.any(Number),
    });
    expect(Number(projection?.remainingBudgetMs)).toBeLessThanOrEqual(5_000);
    expect(Number(projection?.shortfallMs)).toBeGreaterThanOrEqual(55_000);
  });

  async function interruptScenario(repeatAfterInterrupt: boolean) {
    const created = makeRun(['work']);
    const prompts: string[] = [];
    let cliExit: number | null = null;
    const command = 'python measure.py --blocks 10000';
    const adapter: Adapter = {
      async run(prompt, _agent, rawOpts): Promise<RunResult> {
        prompts.push(prompt);
        const opts = rawOpts as LifecycleOpts;
        if (prompts.length > 1) {
          if (repeatAfterInterrupt) {
            const repeated = new CommandActivityTracker({
              runDir: opts.runDir,
              stageId: opts.stageId,
              attemptIndex: opts.attemptIndex!,
              attemptStartedAt: opts.attemptStartedAt!,
              onLifecycle: opts.onCommandLifecycle,
            });
            repeated.feed(`${JSON.stringify({
              type: 'item.started', item: { id: 'repeated-command', type: 'command_execution', command },
            })}\n`);
            repeated.feed(`${JSON.stringify({
              type: 'item.completed', item: { id: 'repeated-command', type: 'command_execution' },
            })}\n`);
            repeated.close();
          }
          return { output: 'continued with operator reason', exitCode: 0, duration_ms: 1 };
        }
        const tracker = new CommandActivityTracker({
          runDir: opts.runDir,
          stageId: opts.stageId,
          attemptIndex: opts.attemptIndex!,
          attemptStartedAt: opts.attemptStartedAt!,
          onLifecycle: opts.onCommandLifecycle,
        });
        tracker.feed(`${JSON.stringify({
          type: 'item.started', item: { id: 'active-command', type: 'command_execution', command },
        })}\n`);
        const cli = spawnSync(process.execPath, [
          '--import', 'tsx', join(repositoryRoot, 'src', 'cli.ts'),
          'interrupt', '--run', created.runId, '--stage', 'work',
          'The 10000-block job is infeasible; stop it and use the measured rate.',
        ], {
          cwd: repositoryRoot,
          env: { ...process.env, HOME: stateRoot, FC_HOME: stateRoot },
          encoding: 'utf-8',
          timeout: 5_000,
        });
        cliExit = cli.status;
        if (cli.status !== 0) {
          tracker.close();
          return { output: `${cli.stdout}${cli.stderr}`, exitCode: cli.status ?? 1, duration_ms: 1 };
        }
        await new Promise<void>((resolve) => {
          if (opts.abortSignal?.aborted) return resolve();
          opts.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        tracker.close();
        return { output: 'operator-interrupted invocation', exitCode: 137, duration_ms: 1 };
      },
    };
    const result = await runStage(adapter, stageOptions(created));
    return { created, prompts, cliExit, result, ledger: events(created.runDirPath) };
  }

  it('[J3] interrupts a named stage command with operator guidance and does not repeat it', async () => {
    const scenario = await interruptScenario(false);
    expect({ cliExit: scenario.cliExit, exitCode: scenario.result.exitCode, invocations: scenario.prompts.length })
      .toEqual({ cliExit: 0, exitCode: 0, invocations: 2 });
    expect(scenario.prompts[1]).toContain('10000-block job is infeasible');
    expect(scenario.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'stage_command_started', commandId: 'active-command' }),
      expect.objectContaining({ type: 'stage_command_interrupt_requested', source: 'operator' }),
      expect.objectContaining({ type: 'guidance_delivery_checked', boundary: 'operator_interrupt', delivered: true }),
      expect.objectContaining({ type: 'stage_command_interrupted', commandId: 'active-command' }),
    ]));
    expect(scenario.ledger.some((event) => event.type === 'interrupted_command_repeated')).toBe(false);
    const eventTypes = scenario.ledger.map((event) => event.type);
    const startedAt = eventTypes.indexOf('stage_command_started');
    const writtenAt = eventTypes.indexOf('guidance_written', startedAt + 1);
    const requestedAt = eventTypes.indexOf('stage_command_interrupt_requested', writtenAt + 1);
    const deliveredAt = eventTypes.indexOf('guidance_delivery_checked', requestedAt + 1);
    const interruptedAt = eventTypes.indexOf('stage_command_interrupted', deliveredAt + 1);
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(writtenAt).toBeGreaterThan(startedAt);
    expect(requestedAt).toBeGreaterThan(writtenAt);
    expect(deliveredAt).toBeGreaterThan(requestedAt);
    expect(interruptedAt).toBeGreaterThan(deliveredAt);
    expect(scenario.ledger.filter((event) => event.type === 'stage_command_started')).toHaveLength(1);
  });

  it('[J3 edge] reports a byte-equivalent command repeated after an operator interrupt', async () => {
    const scenario = await interruptScenario(true);
    expect(scenario.result.exitCode).toBe(0);
    expect(scenario.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'interrupted_command_repeated',
        commandId: 'repeated-command',
        originalRequestId: expect.any(String),
      }),
    ]));
  });

  it('[J4] requires implied wall time for a quantified remedy with recorded unit cost', () => {
    const criterionId = 'criterion_acceptance_criteria_4_feedface';
    const created = makeRun(['measure', 'repair', 'qa']);
    const sourcePath = join(projectDir, 'docs', 'unit-cost.json');
    writeFileSync(sourcePath, '{"unitCostMs":400,"unit":"blocks"}\n', 'utf-8');
    writeStageStatus(projectDir, created.runId, 'measure', {
      status: 'complete', retries: 0, writeAttribution: 'snapshot', writes: ['docs/unit-cost.json'],
      attempts: [{
        index: 1, status: 'complete', startedAt: '2026-09-18T00:00:00.000Z',
        completedAt: '2026-09-18T00:00:01.000Z', writes: ['docs/unit-cost.json'],
      }],
    });
    writeStageStatus(projectDir, created.runId, 'repair', {
      status: 'complete', retries: 0,
      attempts: [{
        index: 1, status: 'complete', startedAt: '2026-09-18T00:00:00.000Z',
        completedAt: '2026-09-18T00:00:01.000Z',
        timeout: {
          attemptId: 'repair:1', budgetMs: 11_000,
          attemptStartedAt: '2026-09-18T00:00:00.000Z', deadlineAt: '2026-09-18T00:00:11.000Z',
          elapsedMs: 1_000, remainingMs: 10_000, rejectedExtensionCount: 0,
          decisionPaths: [], mismatchPaths: [], terminationCause: 'complete',
        },
      }],
    });
    writeFileSync(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: 'now', terminalOwners: {}, errors: [],
      criterionGateRefs: { qa: [criterionId] },
    }), 'utf-8');
    const verdictPath = join(created.runDirPath, 'verdict_qa.json');
    const baseVerdict = {
      pass: false,
      reason: 'Increase the run to 40 blocks before acceptance.',
      criteria: { [criterionId]: { status: 'fail', evidence: 'The repair must run 40 blocks.' } },
    };
    writeFileSync(verdictPath, JSON.stringify(baseVerdict), 'utf-8');

    expect(readGateVerdict(projectDir, 'qa', created.runId)?.reason)
      .toContain('quantified remedy has no remedyFeasibility entry');

    const knownStatement = 'The 40-block target implies 16000 ms and is infeasible within the 11000 ms stage budget.';
    writeFileSync(verdictPath, JSON.stringify({
      ...baseVerdict,
      reason: knownStatement,
      criteria: { [criterionId]: { status: 'fail', evidence: knownStatement } },
      remedyFeasibility: [{
        criterionId,
        targetStageId: 'repair',
        targetQuantity: 40,
        unit: 'blocks',
        cost: {
          status: 'known', unitCostMs: 400, costedQuantity: 40, unit: 'blocks',
          source: {
            stageId: 'measure', attemptIndex: 1, path: 'docs/unit-cost.json',
            unitCostPath: 'unitCostMs', unitCostUnit: 'ms', unitPath: 'unit',
          },
        },
        impliedWallTimeMs: 16_000,
        stageBudgetMs: 11_000,
        fitsStageBudget: false,
        disposition: 'infeasible',
        statement: knownStatement,
      }],
    }), 'utf-8');
    expect(readGateVerdict(projectDir, 'qa', created.runId)).toMatchObject({
      pass: false, reason: knownStatement,
    });

    const unknownStatement = 'The cost and implied wall time for the 40-block target are unknown.';
    const unknownVerdict = {
      ...baseVerdict,
      reason: unknownStatement,
      criteria: { [criterionId]: { status: 'fail', evidence: unknownStatement } },
      remedyFeasibility: [{
        criterionId,
        targetStageId: 'repair',
        targetQuantity: 40,
        unit: 'blocks',
        cost: { status: 'unknown', reason: 'No completed attempt recorded a per-block rate.' },
        impliedWallTimeMs: null,
        stageBudgetMs: 11_000,
        fitsStageBudget: null,
        disposition: 'unknown',
        statement: unknownStatement,
      }],
    };
    writeFileSync(verdictPath, JSON.stringify(unknownVerdict), 'utf-8');
    expect(readGateVerdict(projectDir, 'qa', created.runId)?.reason)
      .toContain('cost cannot be unknown');
    rmSync(sourcePath);
    writeFileSync(verdictPath, JSON.stringify(unknownVerdict), 'utf-8');
    expect(readGateVerdict(projectDir, 'qa', created.runId)).toMatchObject({
      pass: false, reason: unknownStatement,
    });
  });

  it('[J5] rejects a criterion failure that ignores its attached operator ruling', () => {
    const criterionId = 'criterion_acceptance_criteria_10_cafebabe';
    const created = makeRun(['repair', 'qa']);
    writeFileSync(join(created.runDirPath, 'brief_criteria.json'), JSON.stringify({
      version: 1, briefDigest: 'fixture',
      criteria: [{ id: criterionId, text: 'Satisfy the validation gate.', line: 1, section: 'Acceptance criteria' }],
    }), 'utf-8');
    const ruling = appendGuidanceEnvelope({
      runDir: created.runDirPath,
      target: 'repair',
      source: 'operator',
      body: 'Criterion 10 remains the operator ruling: the named red baseline is acceptable when no failures are added.',
      knownStageIds: ['repair', 'qa'],
    });
    writeFileSync(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: 'now', terminalOwners: {}, errors: [],
      criterionGateRefs: { qa: [criterionId] },
    }), 'utf-8');
    const verdictPath = join(created.runDirPath, 'verdict_qa.json');
    writeFileSync(verdictPath, JSON.stringify({
      pass: false,
      reason: 'Validation is red.',
      criteria: { [criterionId]: { status: 'fail', evidence: 'The exact named baseline failures remain.' } },
    }), 'utf-8');

    const rejected = readGateVerdict(projectDir, 'qa', created.runId);
    expect(rejected).toMatchObject({ pass: false });
    expect(rejected?.reason).toContain(`ignores operator guidance ${ruling.id}`);
    const laterGatePrompt = buildStagePrompt({
      dependsOn: ['repair'],
      promptTemplate: 'Evaluate the assigned criterion.',
      projectDir,
      runId: created.runId,
      runDir: created.runDirPath,
      stageId: 'qa',
      role: 'qa',
      isGate: true,
      criterionRefs: [criterionId],
    });
    expect(laterGatePrompt).toContain(`Guidance ${ruling.id}`);
    expect(laterGatePrompt).toContain('the named red baseline is acceptable');
  });

  it('[J6] reports a stage-authored check that conflicts with the ruling on its criterion', () => {
    const criterionId = 'criterion_acceptance_criteria_10_decafbad';
    const created = makeRun(['work', 'qa']);
    writeFileSync(join(created.runDirPath, 'brief_criteria.json'), JSON.stringify({
      version: 1, briefDigest: 'fixture',
      criteria: [{ id: criterionId, text: 'Satisfy the validation gate.', line: 1, section: 'Acceptance criteria' }],
    }), 'utf-8');
    const ruling = appendGuidanceEnvelope({
      runDir: created.runDirPath,
      target: 'work',
      source: 'operator',
      body: 'Criterion 10: the named red baseline is acceptable; do not encode a green-only gate.',
      knownStageIds: ['work', 'qa'],
    });
    writeFileSync(join(created.runDirPath, 'dispatch.yaml'), [
      'stages:',
      '  - id: work',
      '    depends_on: []',
      `    criterion_refs: [${criterionId}]`,
      '  - id: qa',
      '    depends_on: [work]',
      `    criterion_refs: [${criterionId}]`,
      '    is_gate: true',
    ].join('\n'), 'utf-8');
    const checkPath = 'spec/verify_delivery_audit.test.ts';
    mkdirSync(join(projectDir, 'spec'), { recursive: true });
    writeFileSync(join(projectDir, checkPath), 'expect(makeTestExit).toBe(0);\n', 'utf-8');
    writeStageStatus(projectDir, created.runId, 'work', {
      status: 'complete', retries: 0, writeAttribution: 'snapshot', writes: [checkPath],
      artifacts: [checkPath],
      attempts: [{
        index: 1, status: 'complete', startedAt: '2026-09-18T00:00:00.000Z',
        completedAt: '2026-09-18T00:00:01.000Z', writes: [checkPath],
      }],
    });
    writeFileSync(join(created.runDirPath, 'dispatch_admission.json'), JSON.stringify({
      version: 1, pass: true, checkedAt: 'now', terminalOwners: {}, errors: [],
      criterionGateRefs: { qa: [criterionId] },
    }), 'utf-8');
    writeFileSync(join(created.runDirPath, 'verdict_qa.json'), JSON.stringify({
      pass: false,
      reason: 'The stage-authored contract requires operator review.',
      criteria: {
        [criterionId]: {
          status: 'judgement',
          evidence: 'The check requires green although the operator accepted the named red baseline.',
          checkAssessments: [{
            path: checkPath,
            authorStageId: 'work',
            guidanceId: ruling.id,
            status: 'conflict',
            reason: 'The check requires a green exit while the ruling accepts only the named baseline failures.',
          }],
        },
      },
    }), 'utf-8');

    const verdict = readGateVerdict(projectDir, 'qa', created.runId);
    expect(verdict?.reason).toContain(`Criterion check conflict: ${checkPath} by work`);
    expect(events(created.runDirPath)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'criterion_check_conflict',
        criterionId,
        checkPath,
        authorStageId: 'work',
        guidanceId: ruling.id,
      }),
    ]));
  });
});
