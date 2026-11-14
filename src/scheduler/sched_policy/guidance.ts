import { runRecordPath } from '../../run-layout.js';
/** Deduplicated scheduler guidance. */
import { appendGuidanceEnvelope } from '../../guidance.js';
import { existsSync, readFileSync } from 'node:fs';

export function appendSchedulerGuidanceOnce(
  runDirPath: string,
  target: string,
  marker: string,
  body: string,
  knownStageIds: readonly string[] = [],
): void {
  try {
    const ledgerPath = runRecordPath(runDirPath, 'supervisor_guidance.md');
    const prior = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf-8') : '';
    if (prior.includes(marker)) return;
    appendGuidanceEnvelope({
      runDir: runDirPath,
      target,
      source: 'scheduler',
      body: `${marker}\n${body}`,
      knownStageIds,
    });
  } catch { /* non-critical */ }
}
