import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../src/adapters/base.js';
import { ScriptedAdapter, type StageScript } from '../src/adapters/scripted.js';
import { readRunEvents } from '../src/run-events.js';
import { runWorkflow, WorkflowConfigSchema } from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

const coder: AgentConfig = {
  name: 'coder',
  description: 'loop-close fixture',
  model: 'test',
  reasoning_effort: 'low',
  tools: [],
  prompt: 'fixture',
};

describe('settled terminal decisions', () => {
  let projectDir: string;
  let isolatedStateDir: string;
  let previousStateDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-loop-close-project-'));
    isolatedStateDir = mkdtempSync(join(tmpdir(), 'flowcrew-loop-close-state-'));
    previousStateDir = fcGlobalDir();
    setFcGlobalDir(isolatedStateDir);
  });

  afterEach(() => {
    setFcGlobalDir(previousStateDir);
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(isolatedStateDir, { recursive: true, force: true });
  });

  async function run(script: StageScript, brief: string) {
    const workflow = WorkflowConfigSchema.parse({
      name: 'loop-close-fixture',
      defaults: { timeout_ms: 5_000, max_retries: 0, max_iterations: 1 },
      stages: [{
        id: 'deliver',
        role: 'coder',
        prompt_template: 'produce the declared outcome',
        scope: ['docs/**'],
      }],
    });
    const adapter = new ScriptedAdapter({
      deliver: script,
      _summary: { output: 'summary', exitCode: 0 },
    });
    const state = await runWorkflow(
      workflow,
      '',
      projectDir,
      adapter,
      new Map([['coder', coder]]),
      undefined,
      undefined,
      undefined,
      brief,
      true,
      false,
      undefined,
      false,
    );
    return { state, events: readRunEvents(projectDir, state.runId!) };
  }

  it('evaluates a fresh terminal artifact even when the settled batch contains a failure', async () => {
    const { state } = await run({
      exitCode: 1,
      projectFiles: { 'docs/escalation_note.md': '# Exact blocker\n\nThe implementation cannot continue safely.\n' },
    }, `---
terminal_states:
  escalated:
    paths: [docs/escalation_note.md]
---
# Failure-containing terminal fixture
`);

    expect(state.status).toBe('escalated');
    expect(state.terminalArtifact).toBe('escalation_note.md');
    expect(state.stages.deliver.status).toBe('failed');
  });

  it('publishes an explicit incomplete conclusion when a settled DAG matches no declared terminal', async () => {
    const { state, events } = await run({ output: 'work settled without an outcome artifact' }, `---
terminal_states:
  complete:
    paths: [docs/final_verification.md]
  escalated:
    paths: [docs/escalation_note.md]
---
# No-match terminal fixture
`);

    expect(state.status).toBe('incomplete');
    expect(state.failureReason).toContain('no declared terminal state matched');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_completed',
      detail: expect.stringContaining('terminal evaluation not_matched'),
    }));
  });
});
