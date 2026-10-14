import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowConfig } from '../../src/scheduler.js';
import { createRun, readRunState, writeRunState } from '../../src/store.js';

/** Shared run setup only; each consumer owns its adapter and assertions. */
export function prepareFixtureRun(projectDir: string, config: WorkflowConfig, yaml: string) {
  const created = createRun(projectDir, config.name, yaml, config.stages.map((stage) => stage.id));
  writeFileSync(join(created.runDirPath, 'scheduler.pid'), String(process.pid));
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  state.maxRetries = 2;
  writeRunState(projectDir, created.runId, state);
  return created;
}
