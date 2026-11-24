import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentCommandReceipts, gateReview, type AttemptRequest } from '../../dist-rewrite/contract/runtime.js';
import type { StageAnswer } from '../../dist-rewrite/contract/answers.js';
import type { WorkflowPorts } from '../../dist-rewrite/core/loop.js';
import { putEvidence, commitCommand } from '../../dist-rewrite/records/state.js';
import { captureTree } from '../../dist-rewrite/records/content.js';
import { activityRecorder } from '../../dist-rewrite/ops/activity.js';
import { publishRunStatus } from '../../dist-rewrite/ops/status.js';
import { get, type StateFixture } from './rewrite-state.js';
export function workflowFixture(f: StateFixture) {
  const seen: AttemptRequest[] = [];
  let clock = 0;
  const answer = (request: AttemptRequest): StageAnswer => request.stage.purpose === 'gate' ? { kind: 'gate', answer: {
   outcome: 'accepted', reason: 'Independent full-map review', criteria: Object.fromEntries(f.brief.declaration.criteria.map(item => [item.id,
   { status: 'pass' as const, evidence: 'Fixture bytes and direct facts' }])), findings: [], remainingWork: [] } } : { kind: 'work', answer: {
   status: 'delivered', summary: 'Work ready', caveats: [], remainingWork: [], blocks: null } };
  const ports: WorkflowPorts = { recordActivity: activityRecorder(f.journal), now: () => ({ at: new Date().toISOString(), monotonicMs: ++clock }),
    publishStatus: async (c, elapsed) => publishRunStatus(f.location, c.at, elapsed),
    attempt: async (request) => {
      seen.push(request);
      const before = get(await captureTree(f.scope));
      if (request.stage.purpose === 'work')
        await writeFile(join(f.project, 'delivery'), request.stage.id);
      const after = get(await captureTree(f.scope)), value = answer(request), answerRef = get(await putEvidence(f.journal,
       Buffer.from(JSON.stringify(value))));
      return { ok: true, value: { address: request.address, ending: 'delivered', answer: value, answerRef, before, after,
       ...await attemptAudit(f, request), closure: 'dead', usage: { state: 'unknown', raw: [] }, evidence: [], inputChars: 100, ...(request.guidance ? {
       guidance: request.guidance.map(guide => guide.intent) } : {}) } };
    },
    command: async (request) => {
      const receipt = { command: request.command.id, key: request.key, execution: { state: 'complete' as const, exit: 0 },
       stdout: f.ref, stderr: f.ref, before: request.key.tree, after: request.key.tree, delta: f.ref,
       spent: { durationMs: 1 } };
      const p = await f.projection();
      get(await commitCommand(f.execution, p.cursor, request.reservation, receipt));
      return { ok: true, value: receipt };
    }
  };
  return { ports, seen, answer };
}

/** Synthetic native audit through the engine's own review record (`gateReview`): the loop's `commandReview` when present (final gate),
 * otherwise the current receipts. Spread into the attempt receipt: it carries the audit and the reused-command record. */
export async function attemptAudit(f: Pick<StateFixture,'projection'|'journal'|'ref'>, request: Pick<AttemptRequest,'address'|'stage'|'commandReview'>) {
  if (request.stage.purpose !== 'gate') return { audit: f.ref };
  const { address } = request, p = await f.projection(), stage = p.plan.plan.stages.find(s => s.id === address.stage)!;
  const { commands, reusedCommands } = request.commandReview ?? { commands: currentCommandReceipts(p.commands, stage, p.brief), reusedCommands: [] };
  const review = get(await putEvidence(f.journal,Buffer.from(JSON.stringify(gateReview(p,commands,reusedCommands)))));
  const audit = get(await putEvidence(f.journal,Buffer.from(JSON.stringify({address,review}))));
  return { audit, ...(reusedCommands.length ? { reusedCommands } : {}) };
}
