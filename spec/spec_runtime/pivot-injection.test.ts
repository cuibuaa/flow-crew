import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../../src/adapters/base.js';
import { runWorkflow, WorkflowConfigSchema } from '../../src/scheduler.js';
import { readRunState, writeRunState } from '../../src/store.js';
import { fixtureArtifactContract } from '../test-support/declared-dispatch.js';
import { prepareFixtureRun } from './run-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('native planner pivot injection', () => {
  it.each(['plateau', 'regression', 'repeated_failure', undefined] as const)
  ('delivers scheduler-owned %s context to the actual adapter prompt', async (alertType) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-pivot-prompt-'));
    roots.push(projectDir);
    const agentsDir = join(projectDir, 'config', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'planner.yaml'), [
      'name: planner', 'description: native prompt control', 'model: default',
      'reasoning_effort: default', 'tools: []', 'prompt: fixture',
    ].join('\n'));
    const config = WorkflowConfigSchema.parse({
      name: 'native-pivot', defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{ id: 'plan', role: 'planner', scope: [], prompt_template: 'Base plan',
        artifact_contract: fixtureArtifactContract('plan') }],
    });
    const created = prepareFixtureRun(projectDir, config, 'synthetic pivot control');
    const state = readRunState(projectDir, created.runId);
    if (alertType) state.researchInjection = {
      source: 'campaign_health', triggeredAt: new Date().toISOString(), iteration: 1,
      alertType, message: 'measured synthetic campaign alert',
    };
    writeRunState(projectDir, created.runId, state);
    let observed = '';
    const adapter: Adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === 'plan') observed = prompt;
      return { output: 'fixture settled', exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured' };
    } };
    const final = await runWorkflow(config, 'synthetic pivot control', projectDir, adapter,
      new Map(), undefined, agentsDir, created.runId, undefined, true);
    expect(final.status).toBe('complete');
    expect(observed).toContain('Base plan');
    if (alertType) {
      expect(observed).toContain('PIVOT REQUIRED');
      expect(observed).toContain(alertType);
      expect(observed).toContain('measured synthetic campaign alert');
      expect(observed).toContain('research stage');
      expect(observed).toContain('dead_end');
    } else expect(observed).not.toContain('PIVOT REQUIRED');
  });
});
