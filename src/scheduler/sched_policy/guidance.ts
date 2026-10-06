/** Deduplicated scheduler guidance and stable blockage escalation; terminal owner lookup is shared, campaign persistence is supplied. */
import { appendGuidanceEnvelope, RUN_WIDE_GUIDANCE_TARGET } from '../../guidance.js';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordBlockageOccurrence } from '../../blockage-ledger.js';
import { RUN_STATUS, type StoreState, writeRunState } from '../../store.js';
import { markLeftoverStagesSkipped } from '../sched_admission/brief-contract.js';
import { recordRunEvent } from '../../run-events.js';
import { admittedTerminalOwner } from './terminal-ownership.js';

export function appendSchedulerGuidanceOnce(
  runDirPath: string,
  target: string,
  marker: string,
  body: string,
  knownStageIds: readonly string[] = [],
): void {
  try {
    const ledgerPath = join(runDirPath, 'supervisor_guidance.md');
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

export function observeStableBlockage(input: {
  runDirPath: string;
  kind: string;
  detail: string;
  stageId?: string;
  evidenceDigest?: string;
  repairDigest?: string;
  threshold?: number;
}): ReturnType<typeof recordBlockageOccurrence> | undefined {
  try {
    const observed = recordBlockageOccurrence({
      runDir: input.runDirPath,
      kind: input.kind,
      detail: input.detail,
      stageId: input.stageId,
      evidenceDigest: input.evidenceDigest,
      repairDigest: input.repairDigest,
      threshold: input.threshold,
    });
    if (!observed.escalatedNow) return observed;
    const signalsDir = join(input.runDirPath, 'signals');
    mkdirSync(signalsDir, { recursive: true });
    writeFileSync(join(signalsDir, 'repeated_blockage.json'), `${JSON.stringify({
      version: 1,
      ...observed.occurrence,
      action: 'escalate',
    }, null, 2)}\n`, 'utf-8');
    appendSchedulerGuidanceOnce(
      input.runDirPath,
      RUN_WIDE_GUIDANCE_TARGET,
      `[repeated-blockage:${observed.occurrence.fingerprint}]`,
      `The same blockage has recurred ${observed.occurrence.consecutive} consecutive times without a state change: ${input.detail}. Stop repeating the same repair. Route the run through its declared escalation/finalizer outcome and name the external change needed.`,
    );
    return observed;
  } catch { /* non-critical */ }
  return undefined;
}

export function createBlockageConcluder(writeCampaignEntry: (projectDir: string, state: StoreState) => void) {
  function concludeRepeatedBlockage(
    state: StoreState,
    ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number },
  ): StoreState | null {
    const signalPath = join(ctx.runDirPath, 'signals', 'repeated_blockage.json');
    if (!existsSync(signalPath)) return null;
    let signal: Record<string, unknown>;
    try {
      signal = JSON.parse(readFileSync(signalPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (signal.action !== 'escalate') return null;
    const detail = typeof signal.detail === 'string' ? signal.detail : 'unchanged structured blockage';
    const consecutive = typeof signal.consecutive === 'number' ? signal.consecutive : 3;
    const stageId = typeof signal.stageId === 'string' ? signal.stageId : undefined;
    const reason = `Escalated after ${consecutive} consecutive observations of the same blockage${stageId ? ` at ${stageId}` : ''}: ${detail}. A different repair/evidence state or external intervention is required.`;
    state.status = RUN_STATUS.ESCALATED;
    state.failureReason = reason;
    state.completedAt = new Date().toISOString();
    markLeftoverStagesSkipped(state, reason);
    const escalationPath = state.terminalStates?.[RUN_STATUS.ESCALATED]?.paths?.[0];
    const terminalOwner = escalationPath ? admittedTerminalOwner(ctx.runDirPath, escalationPath) : undefined;
    if (terminalOwner) {
      appendSchedulerGuidanceOnce(
        ctx.runDirPath,
        terminalOwner,
        `[repeated-blockage-final:${String(signal.fingerprint ?? 'unknown')}]`,
        `${reason} The run has stopped; any resumption must write only the declared escalation evidence at ${escalationPath}.`,
        Object.keys(state.stages),
      );
    }
    writeRunState(ctx.projectDir, ctx.runId, state);
    writeCampaignEntry(ctx.projectDir, state);
    recordRunEvent(ctx.projectDir, ctx.runId, {
      type: 'run_completed',
      runId: ctx.runId,
      timestamp: state.completedAt,
      iteration: ctx.iteration,
      ...(stageId ? { stageId } : {}),
      detail: reason,
    });
    return state;
  }

  return { concludeRepeatedBlockage };
}
