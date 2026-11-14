import { writeFileSync } from 'node:fs';
import { stageWorkPath } from '../../src/run-layout.js';
import type { RunOpts, RunResult } from '../../src/adapters/base.js';

/** An explicitly authored stub planner answer for review/repair integration scenarios. */
export const entryPlan = [
  { id: 'implement', role: 'coder', scope: ['.'] },
  { id: 'assess', role: 'qa', scope: [], depends_on: ['implement'],
    decision: { kind: 'review', successors: ['review', 'review_full'], default: 'review_full' } },
  { id: 'review', role: 'qa', scope: [], depends_on: ['assess'], is_gate: true },
  { id: 'review_full', role: 'qa', scope: [], depends_on: ['assess'], is_gate: true },
  { id: 'repair', role: 'coder', scope: ['.'], depends_on: ['review', 'review_full'],
    retry_to: ['review', 'review_full'], decision: { successors: ['assess', 'replan'], default: 'assess' } },
].map(stage => ({ ...stage, artifact_contract: { version: 1, produces: [], reads: [] } }));
export const mockEntryPlan = { output_text: 'Plan ready.', write_files: { 'dispatch.yaml': JSON.stringify({ stages: entryPlan }) } };
export function plannerReply(opts: RunOpts, stages: unknown[] = entryPlan): RunResult {
  writeFileSync(stageWorkPath(opts.runDir, 'dispatch.yaml'), JSON.stringify({ stages }));
  return { output: JSON.stringify({ status: 'delivered', summary: 'Plan ready.', caveats: [], remaining_work: [], blocks: null }),
    exitCode: 0, duration_ms: 0, writes: ['run:work/dispatch.yaml'], writeAttribution: 'structured' };
}
