import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { updateOperationalRunState } from '../../src/store.js';

/** A planner's accepted snapshot, rather than an incidental Markdown file. */
export function writeAdmittedRealityChecks(path: string, markdown: string): void {
  writeFileSync(path, markdown);
  // reality_checks.md lives inside the engine directory in the separated layout.
  updateOperationalRunState(dirname(dirname(path)), state => {
    state.admittedRealityChecks = { markdown,
      sha256: createHash('sha256').update(markdown).digest('hex'), admittedAtIteration: state.currentIteration ?? 1 };
  });
}
