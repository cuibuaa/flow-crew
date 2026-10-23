import { stageWrapUpTiming } from '../src/attempt-deadline.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';
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
import { parseStageCommandInterrupt, requestStageCommandInterrupt } from '../src/command-interrupt.js';
import { appendGuidanceEnvelope } from '../src/guidance.js';
import { createRun } from './test-support/create-run.js';
import {
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
      artifactContract: fixtureArtifactContract(stageId),
    stageId,
    role,
    dependsOn: [],
    promptTemplate: 'Do the fixture work.',
    timeout_ms: 10_000,
    projectDir,
    runId: created.runId,
    runDir: created.runDirPath,
    retries: 0,

  };
}

function events(runDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, 'events.jsonl'), 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('live guidance and command controls', () => {
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
    const writtenAt = ledger.findIndex((event) => (
      event.type === 'guidance_written' && event.guidanceId === writtenGuidanceId
    ));
    const deliveredAt = ledger.findIndex((event) => (
      event.type === 'guidance_delivery_checked'
      && event.boundary === 'tool_call_completion'
      && event.delivered === true
    ));
    expect(writtenAt).toBeGreaterThanOrEqual(0);
    expect(deliveredAt).toBeGreaterThan(writtenAt);
    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'guidance_delivery_checked', boundary: 'tool_call_completion', delivered: true,
      }),
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
    expect(Number(projection?.remainingBudgetMs)).toBeLessThanOrEqual(stageWrapUpTiming(5_000).hardLimitMs);
    expect(Number(projection?.shortfallMs)).toBeGreaterThanOrEqual(60_000 - stageWrapUpTiming(5_000).hardLimitMs);
  });

  async function interruptScenario(repeatAfterInterrupt: boolean, reason = 'The 10000-block job is infeasible; stop it and use the measured rate.') {
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
          ...(reason ? [reason] : []),
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
      expect.objectContaining({ type: 'stage_command_interrupt_requested', source: 'operator' }),
      expect.objectContaining({ type: 'guidance_delivery_checked', boundary: 'operator_interrupt', delivered: true }),
      expect.objectContaining({ type: 'stage_command_interrupted', commandId: 'active-command' }),
    ]));
    expect(scenario.ledger.some((event) => event.type === 'interrupted_command_repeated')).toBe(false);
    const eventTypes = scenario.ledger.map((event) => event.type);
    const writtenAt = eventTypes.indexOf('guidance_written');
    const requestedAt = eventTypes.indexOf('stage_command_interrupt_requested', writtenAt + 1);
    const deliveredAt = eventTypes.indexOf('guidance_delivery_checked', requestedAt + 1);
    const interruptedAt = eventTypes.indexOf('stage_command_interrupted', deliveredAt + 1);
    expect(writtenAt).toBeGreaterThanOrEqual(0);
    expect(requestedAt).toBeGreaterThan(writtenAt);
    expect(deliveredAt).toBeGreaterThan(requestedAt);
    expect(interruptedAt).toBeGreaterThan(deliveredAt);
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

  it('interrupts the bound command without a rationale and delivers an action description', async () => {
    const scenario = await interruptScenario(false, '');
    expect({ cliExit: scenario.cliExit, exitCode: scenario.result.exitCode, invocations: scenario.prompts.length })
      .toEqual({ cliExit: 0, exitCode: 0, invocations: 2 });
    expect(scenario.prompts[1]).toContain('Operator requested interruption of the active command.');
    expect(scenario.ledger).toContainEqual(expect.objectContaining({
      type: 'stage_command_interrupt_requested', detail: 'Operator requested interruption of the active command.',
    }));
  });

  it('refuses an interrupt whose command lifecycle belongs to a stale attempt', () => {
    const created = makeRun(['work']);
    writeStageStatus(projectDir, created.runId, 'work', {
      status: 'running', retries: 0,
      attempts: [{ index: 2, status: 'running', startedAt: '2026-01-01T00:00:02Z' }],
    });
    mkdirSync(join(created.runDirPath, 'stages', 'work'), { recursive: true });
    writeFileSync(join(created.runDirPath, 'stages', 'work', 'command_activity.json'), JSON.stringify({
      version: 1, stageId: 'work', attemptIndex: 1, attemptStartedAt: '2026-01-01T00:00:01Z',
      active: [{ id: 'command', command: 'node check.mjs' }], streamClosed: false,
    }));
    expect(() => requestStageCommandInterrupt({ runDir: created.runDirPath, stageId: 'work' })).toThrow('stale');
  });

  it('keeps command fingerprint validation when the interrupt rationale is omitted', () => {
    expect(parseStageCommandInterrupt(JSON.stringify({
      version: 1, requestId: 'request', stageId: 'work', attemptIndex: 1,
      attemptStartedAt: '2026-01-01T00:00:01Z', commandId: 'command', command: 'node check.mjs',
      commandFingerprint: 'incorrect', guidanceId: 'notice', requestedAt: '2026-01-01T00:00:02Z', source: 'operator',
    }))).toEqual({ ok: false, error: 'command fingerprint mismatch' });
  });

  it.each(['first', 'passing', 'rejected'] as const)('frames a standalone review from %s history', async history => {
    const created = makeRun(['qa']);
    const archive = join(created.runDirPath, 'gate_reevaluation', 'iteration_1', 'round_1');
    if (history === 'rejected') {
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, 'rejected_verdict_qa.json'), '{"pass":false}');
    } else if (history === 'passing') {
      writeFileSync(join(created.runDirPath, 'verdict_qa.json'), '{"pass":true}');
    }
    const prompts: string[] = [];
    const adapter: Adapter = { async run(prompt) {
      prompts.push(prompt);
      return { output: 'Captured review contract.', exitCode: 1, duration_ms: 1 };
    } };
    const result = await runStage(adapter, { ...stageOptions(created, 'qa'), isGate: true });
    expect(result.exitCode).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain({ first: 'FIRST EVALUATION', passing: 'INITIAL EVALUATION', rejected: 'RE-EVALUATION' }[history]);
    if (history === 'rejected') {
      expect(prompts[0]).toContain(join(archive, 'rejected_verdict_qa.json'));
      expect(prompts[0]).toContain('Reject again only for a rejected finding the repair did not resolve');
      expect(prompts[0]).toContain('record any other difference you find as a stated limitation');
    } else {
      expect(prompts[0]).not.toContain('RE-EVALUATION');
      if (history === 'passing') expect(prompts[0]).toContain('Run a complete initial evaluation');
    }
  });

});

describe('continuation at closed tool boundaries', () => {
  it('keeps the stage UUID and all delivered guidance, with complete duties for a fresh fallback', async () => {
    const created = makeRun(['work']);
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const calls: Array<{ prompt: string; resume?: string; fresh?: string }> = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push({ prompt, resume: opts.resumeSessionId, fresh: opts.freshSessionPrompt });
      if (calls.length < 3) {
        const id = `tool-${calls.length}`;
        opts.onCommandLifecycle?.({ phase: 'started', id, timestamp: new Date().toISOString() });
        appendGuidanceEnvelope({ runDir: created.runDirPath, target: 'work', source: 'operator', body: `Keep correction ${calls.length}.`, knownStageIds: ['work'] });
        opts.onCommandLifecycle?.({ phase: 'completed', id, timestamp: new Date().toISOString() });
      }
      return { output: 'done', exitCode: opts.abortSignal?.aborted ? 137 : 0, duration_ms: 1, sessionId: uuid };
    } };
    const result = await runStage(adapter, stageOptions(created));
    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.resume)).toEqual([undefined, uuid, uuid]);
    expect(calls[2].prompt).toContain('Keep correction 1.');
    expect(calls[2].prompt).toContain('Keep correction 2.');
    expect(calls[2].prompt).not.toContain('Do the fixture work.');
    expect(calls[2].fresh).toContain('Do the fixture work.');
    expect(calls[2].fresh).toContain('Keep correction 1.');
    expect(calls[2].fresh).toContain('Keep correction 2.');
    expect(calls[2].prompt).toContain('# Live guidance delivered at tool completion');
    expect(calls[2].fresh).toContain('# Live guidance delivered at tool completion');
    expect(calls[2].prompt).toContain('hard stop');
  });

  it('omits unchanged empty tool checks and command copies while retaining invocation checks', async () => {
    const created = makeRun(['work']);
    const adapter: Adapter = { async run(_prompt, _role, opts) {
      for (let index = 0; index < 4; index++) {
        const id = `tool-${index}`;
        opts.onCommandLifecycle?.({ phase: 'started', id, timestamp: new Date().toISOString() });
        opts.onCommandLifecycle?.({ phase: 'completed', id, timestamp: new Date().toISOString() });
      }
      return { output: 'done', exitCode: 0, duration_ms: 1 };
    } };
    expect((await runStage(adapter, stageOptions(created))).exitCode).toBe(0);
    const ledger = events(created.runDirPath);
    expect(ledger.filter((event) => event.type === 'guidance_delivery_checked').map((event) => event.boundary)).toEqual(['attempt_start', 'adapter_invocation']);
    expect(ledger.filter((event) => event.type === 'stage_command_completed')).toHaveLength(0);
  });
});
