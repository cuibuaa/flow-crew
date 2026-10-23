import { atomicWrite } from '../../src/engine-fs.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../../src/adapters/base.js';
import { readRunState, runDir } from '../../src/store.js';
import { TERMINAL_STATUSES } from '../../src/lifecycle-status.js';
import { renderRunSummary } from '../../src/run-summary.js';
import { createLogger } from '../../src/logging.js';

const log = createLogger({ name: 'run-summary-fixture' });

/** Compatibility refresh for callers reading an already published terminal run. */
export async function generateRunSummary(
  projectDir: string,
  runId: string,
  _adapter?: Adapter,
): Promise<string | null> {
  const directory = runDir(projectDir, runId);
  if (!existsSync(join(directory, 'run.json'))) return null;
  try {
    const state = readRunState(projectDir, runId);
    if (!TERMINAL_STATUSES.includes(state.status)) return null;
    const summary = renderRunSummary(projectDir, directory, state);
    atomicWrite(join(directory, 'summary.md'), summary);
    return summary;
  } catch (err) {
    log.warn({ runId, err }, 'Failed to generate run summary');
    return null;
  }
}
