import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  async function run(script: StageScript, brief: string, declaresOutcome = true) {
    const workflow = WorkflowConfigSchema.parse({
      name: 'loop-close-fixture',
      defaults: { max_retries: 0, max_iterations: 1 },
      stages: [{
        id: 'deliver',
        role: 'coder',
        prompt_template: 'produce the declared outcome',
        scope: ['docs/**'],
        artifact_contract: {
          version: 1,
          produces: declaresOutcome ? [
            { id: 'final', root: 'project', path: 'docs/final_verification.md' },
            { id: 'blocker', root: 'project', path: 'docs/escalation_note.md' },
          ] : [],
          reads: [],
          replays: [],
          groups: declaresOutcome ? [{ id: 'outcome', mode: 'exactly_one', members: ['final', 'blocker'] }] : [],
        },
      }],
    });
    const adapter = new ScriptedAdapter({
      deliver: script,
      _summary: { output: 'summary', exitCode: 0 },
    });
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), 'name: coder\ndescription: fixture\nmodel: test\nreasoning_effort: low\ntools: []\nprompt: fixture\n');
    const state = await runWorkflow(
      workflow,
      '',
      projectDir,
      adapter,
      new Map([['coder', coder]]),
      undefined,
      agentsDir,
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

    expect(state.status, state.failureReason).toBe('escalated');
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
`, false);

    expect(state.status, state.failureReason).toBe('incomplete');
    expect(state.failureReason).toContain('no declared terminal state matched');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run_completed',
      detail: expect.stringContaining('terminal evaluation not_matched'),
    }));
  });
});
