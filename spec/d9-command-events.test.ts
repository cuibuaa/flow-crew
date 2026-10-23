import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../src/adapters/base.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { CommandActivityTracker, type CommandActivitySnapshot } from '../src/command-activity.js';
import { observeEnginePublications } from '../src/engine-fs.js';
import { createRun } from './test-support/create-run.js';
import { readStageStatus } from '../src/store.js';
import { runStage } from '../src/worker.js';
import { fixtureArtifactContract } from './test-support/declared-dispatch.js';

const commandReads = vi.hoisted(() => ({ runPath: '', count: 0, active: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync(...args: Parameters<typeof actual.readFileSync>) {
    if (commandReads.active && String(args[0]) === commandReads.runPath) commandReads.count++;
    return actual.readFileSync(...args);
  } };
});

describe('command activity without lifecycle event copies', () => {
  it('keeps 1,000 tool calls out of stage events and run-state publications', async () => {
    const projectDir = join(process.env.FLOWCREW_VITEST_ROOT!, 'tool-events-project');
    mkdirSync(projectDir, { recursive: true });
    async function execute(toolCalls: number) {
      const created = createRun(projectDir, 'tool-events', 'name: tool-events\nstages: []\n', ['work']);
      const eventPath = join(created.runDirPath, 'events.jsonl');
      const runPath = join(created.runDirPath, 'run.json');
      Object.assign(commandReads, { runPath, count: 0, active: false });
      const publications = { events: 0, run: 0 };
      let observing = true;
      observeEnginePublications(paths => {
        if (observing) {
          if (paths.includes(eventPath)) publications.events++;
          if (paths.includes(runPath)) publications.run++;
        }
        return () => {};
      });
      const scripted = new ScriptedAdapter({ work: { output: 'Tool script completed.' } });
      const adapter: Adapter = { async run(prompt, role, opts) {
        const attempt = readStageStatus(projectDir, created.runId, 'work').attempts!.at(-1)!;
        const tracker = new CommandActivityTracker({
          runDir: opts.runDir, stageId: opts.stageId,
          attemptIndex: attempt.index, attemptStartedAt: attempt.startedAt,
          onLifecycle: opts.onCommandLifecycle,
        });
        commandReads.active = true;
        try {
          for (let index = 0; index < toolCalls; index++) {
            tracker.started(`tool-${index}`, 'printf fixture');
            tracker.completed(`tool-${index}`);
          }
        } finally { commandReads.active = false; }
        tracker.close();
        return scripted.run(prompt, role, opts);
      } };
      const deadlineStartedAt = Date.now();
      try {
        const result = await runStage(adapter, {
          stageId: 'work', role: { name: 'coder', model: 'test', reasoning_effort: 'low',
            description: 'deterministic tool fixture', tools: [], prompt: 'Complete the fixture.' },
          dependsOn: [], promptTemplate: 'Execute the tool script.', timeout_ms: 30_000,
          // Measure lifecycle I/O, independent of the host's speed reaching wrap-up.
          deadlineClock: {
            monotonicNow: () => 0, wallNow: () => deadlineStartedAt,
            setTimer: () => ({} as ReturnType<typeof setTimeout>), clearTimer: () => {},
          },
          projectDir, runId: created.runId, runDir: created.runDirPath, retries: 0,
          artifactContract: fixtureArtifactContract('work'),
        });
        expect(result.exitCode, result.output).toBe(0);
        const eventTypes = readFileSync(eventPath, 'utf8').trim().split('\n')
          .filter(Boolean).map(line => (JSON.parse(line) as { type: string }).type);
        const activity = JSON.parse(readFileSync(join(created.runDirPath, 'stages', 'work', 'command_activity.json'), 'utf8')) as CommandActivitySnapshot;
        expect(activity).toMatchObject({ completedCount: toolCalls, active: [], streamClosed: true });
        expect(scripted.calls).toHaveLength(1);
        return { eventTypes, publications, runReads: commandReads.count };
      } finally { observing = false; }
    }
    const empty = await execute(0);
    const busy = await execute(1_000);
    console.info('D9 tool-call evidence', JSON.stringify({
      empty: { events: empty.eventTypes.length, publications: empty.publications, runReads: empty.runReads },
      busy: { events: busy.eventTypes.length, publications: busy.publications, runReads: busy.runReads },
    }));
    expect(busy.eventTypes).toEqual(empty.eventTypes);
    expect(busy.publications).toEqual(empty.publications);
    expect(busy.runReads).toBe(0);
    expect(busy.eventTypes).toContain('attempt_started');
    expect(busy.eventTypes).toContain('attempt_finished');
    expect(busy.eventTypes).not.toContain('stage_command_started');
    expect(busy.eventTypes).not.toContain('stage_command_completed');
  });
});
