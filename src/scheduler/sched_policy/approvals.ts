/** Approval slot ingestion, parking, attempt suspension and active monitoring; receives the campaign writer only. */
import { APPROVAL_REQUEST_FILE, APPROVALS_DIR, approvalArtifactPath, isValidApprovalRequestId } from '../../approval-artifacts.js';
import { existsSync, readdirSync, mkdirSync, unlinkSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, type StoreState, isRunningStageStatus, RUN_STATUS, readStageStatus, suspendStageAttempt, writeRunState, readOperationalRunState } from '../../store.js';
import { ABORT_SIGNAL_VERSION, type StageAbortSignal } from '../../abort-signal.js';
import { type ApprovalRisk, INBOX_ITEM_STATE, foldItems, isPendingInboxItemState, recordRequest } from '../../inbox.js';
import { log } from '../sched_admission/shared.js';
import { recordRunEvent } from '../../run-events.js';
import { type StageConfig } from '../sched_admission/configuration.js';
import { SCHEDULER_HEARTBEAT_FILE, SCHEDULER_LOOP_STALL_FILE } from '../../scheduler-heartbeat.js';
import { RUN_WIDE_GUIDANCE_TARGET } from '../../guidance.js';
import { appendSchedulerGuidanceOnce } from './guidance.js';

export interface ApprovalMonitorServices {
  writeCampaignEntryUnlessPaused(projectDir: string, state: StoreState): void;
}

interface ApprovalRequestSource {
  path: string;
  stageId?: string;
}

function approvalRequestSources(runDirPath: string): ApprovalRequestSource[] {
  const sources: ApprovalRequestSource[] = [];
  try {
    for (const name of readdirSync(runDirPath).sort()) {
      if (name === APPROVAL_REQUEST_FILE || /^approval_request[._-][A-Za-z0-9._-]+\.json$/.test(name)) {
        sources.push({ path: join(runDirPath, name) });
      }
    }
  } catch { /* run directory disappeared */ }

  const stagesPath = join(runDirPath, 'stages');
  try {
    for (const entry of readdirSync(stagesPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const path = join(stagesPath, entry.name, APPROVAL_REQUEST_FILE);
      if (existsSync(path)) sources.push({ path, stageId: entry.name });
    }
  } catch { /* no stages directory */ }
  return sources;
}

function archiveApprovalRequest(runDirPath: string, sourcePath: string, requestId: string, acknowledgedBytes: string): void {
  const target = approvalArtifactPath(runDirPath, requestId, 'request');
  mkdirSync(join(runDirPath, APPROVALS_DIR), { recursive: true });
  if (existsSync(target)) {
    // Keep the first audit copy, matching the append log's first-request-wins
    // arbitration, and merely consume a duplicate slot.
    if (sourcePath !== target) unlinkSync(sourcePath);
    return;
  }
  // A live child's file capability follows its inode. Publish acknowledged
  // bytes to a fresh inode, then consume the mutable transport slot.
  atomicWrite(target, acknowledgedBytes);
  unlinkSync(sourcePath);
}

function writeApprovalSuspensionSignal(input: {
  runDirPath: string;
  stageId: string;
  attemptIndex: number;
  requestId: string;
  requestingStageId?: string;
}): void {
  const signalsDir = join(input.runDirPath, 'signals');
  mkdirSync(signalsDir, { recursive: true });
  const target = join(signalsDir, `abort_${input.stageId}.json`);
  // A supervisor ABORT remains authoritative if it won the slot first.
  if (existsSync(target)) return;
  const signal: StageAbortSignal = {
    version: ABORT_SIGNAL_VERSION,
    stageId: input.stageId,
    attemptIndex: input.attemptIndex,
    reason: `run parked for approval ${input.requestId}`,
    timestamp: new Date().toISOString(),
    source: 'scheduler',
    requestId: input.requestId,
    ...(input.requestingStageId ? { requestingStageId: input.requestingStageId } : {}),
  };
  atomicWrite(target, `${JSON.stringify(signal, null, 2)}\n`);
}

function inferredApprovalStageId(
  state: StoreState,
  explicitStageId: string | undefined,
  candidateStageIds: readonly string[] | undefined,
): string | undefined {
  if (explicitStageId) return explicitStageId;
  const candidates = [...new Set(candidateStageIds ?? [])];
  if (candidates.length === 1) return candidates[0];
  const running = Object.entries(state.stages)
    .filter(([, status]) => isRunningStageStatus(status.status))
    .map(([stageId]) => stageId);
  return running.length === 1 ? running[0] : undefined;
}

function writeApprovalDecision(runDirPath: string, requestId: string, decision: 'approve' | 'deny', reason?: string): void {
  try {
    const target = approvalArtifactPath(runDirPath, requestId, 'decision');
    mkdirSync(join(runDirPath, APPROVALS_DIR), { recursive: true });
    writeFileSync(target,
      JSON.stringify({ requestId, decision, reason: reason ?? '', at: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
  } catch (err) {
    log.warn({ requestId, err }, 'failed to write approval decision artifact');
  }
}

function appendApprovalGuidance(runDirPath: string, requestId: string, title: string): void {
  appendSchedulerGuidanceOnce(
    runDirPath,
    RUN_WIDE_GUIDANCE_TARGET,
    `[approval-parked:${requestId}]`,
    `This run PARKED awaiting human approval for: ${title}.\n`
      + `When you resume, read approvals/${requestId}.decision.json FIRST. If decision is "deny", do NOT perform the action — `
      + 'record the denial and continue with the remaining work (or write an honest terminal artifact explaining what the denial blocks).',
  );
}

export function createApprovalMonitor(services: ApprovalMonitorServices) {
  const { writeCampaignEntryUnlessPaused } = services;

  async function tryParkOnApprovalRequest(
    state: StoreState,
    ctx: {
      projectDir: string;
      runId: string;
      runDirPath: string;
      iteration: number;
      candidateStageIds?: readonly string[];
    },
  ): Promise<StoreState | null> {
    // Ingestion is deliberately separate from choosing which request parks the
    // run: parallel stages may produce several slots in one batch, and all must
    // reach the append-only inbox before the first pending item suspends us.
    for (const source of approvalRequestSources(ctx.runDirPath)) {
      let parsed: unknown;
      let acknowledgedBytes: string;
      try {
        const text = readFileSync(source.path, 'utf-8');
        acknowledgedBytes = text;
        if (!text.trim()) continue; // untouched native write-capability slot
        parsed = JSON.parse(text);
      } catch {
        log.warn({ runId: ctx.runId, reqPath: source.path }, 'approval request is not valid JSON — ignoring');
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log.warn({ runId: ctx.runId, reqPath: source.path }, 'approval request is not a JSON object — ignoring');
        continue;
      }
      const raw = parsed as {
        id?: unknown;
        requestId?: unknown;
        action?: unknown;
        target?: unknown;
        risk?: unknown;
        title?: unknown;
        body?: unknown;
        stageId?: unknown;
        requestedAt?: unknown;
      };
      const requestIdRaw = typeof raw.requestId === 'string' ? raw.requestId : typeof raw.id === 'string' ? raw.id : '';
      const requestId = requestIdRaw.trim();
      const action = typeof raw.action === 'string' ? raw.action.trim() : '';
      if (!requestId || !action) {
        log.warn({ runId: ctx.runId, reqPath: source.path }, 'approval request needs at least {id, action} — ignoring');
        continue;
      }
      if (!isValidApprovalRequestId(requestId)) {
        log.warn({ runId: ctx.runId, requestId, reqPath: source.path }, 'unsafe approval request id — rejecting artifact');
        continue;
      }
      const target = typeof raw.target === 'string' && raw.target.trim() ? raw.target.trim() : undefined;
      const risk: ApprovalRisk = raw.risk === 'external' || raw.risk === 'exec' || raw.risk === 'write' ? raw.risk : 'unknown';
      const explicitStageId = typeof raw.stageId === 'string' && raw.stageId.trim() ? raw.stageId.trim() : source.stageId;
      const stageId = inferredApprovalStageId(state, explicitStageId, ctx.candidateStageIds);
      const requestedAt = typeof raw.requestedAt === 'string' && Number.isFinite(Date.parse(raw.requestedAt))
        ? raw.requestedAt
        : new Date().toISOString();
      const req = {
        runId: ctx.runId,
        projectDir: ctx.projectDir,
        requestId,
        action,
        ...(target ? { target } : {}),
        risk,
        title: typeof raw.title === 'string' && raw.title.trim()
          ? raw.title.trim()
          : `${action}${target ? ` → ${target}` : ''}`,
        ...(typeof raw.body === 'string' && raw.body ? { body: raw.body } : {}),
        createdAt: requestedAt,
        atIteration: ctx.iteration,
        ...(stageId ? { stageId } : {}),
      };
      try {
        recordRequest(req);
        archiveApprovalRequest(ctx.runDirPath, source.path, requestId, acknowledgedBytes);
      } catch (err) {
        log.warn({ runId: ctx.runId, requestId, reqPath: source.path, err }, 'failed to ingest approval request');
      }
    }

    // Materialize settled decisions before selecting the first pending request.
    const items = [...foldItems(ctx.runId).values()];
    for (const item of items) {
      if (!isValidApprovalRequestId(item.requestId) || isPendingInboxItemState(item.state)) continue;
      writeApprovalDecision(
        ctx.runDirPath,
        item.requestId,
        item.state === INBOX_ITEM_STATE.APPROVED ? 'approve' : 'deny',
        item.resolution?.reason,
      );
    }
    const item = items
      .filter((candidate) => isPendingInboxItemState(candidate.state) && isValidApprovalRequestId(candidate.requestId))
      .sort((a, b) => {
        const aTime = Date.parse(a.createdAt);
        const bTime = Date.parse(b.createdAt);
        const byTime = (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
        return byTime || a.requestId.localeCompare(b.requestId);
      })[0];
    if (!item) return null;
    const { requestId, action } = item;

    const detectedAt = new Date().toISOString();
    const requestingStageId = item.stageId;
    const pausedAt = detectedAt;
    state.status = RUN_STATUS.PARKED;
    state.parked = {
      requestId, action,
      ...(item.target ? { target: item.target } : {}),
      reason: item.title,
      atIteration: ctx.iteration,
      ...(requestingStageId ? { stageId: requestingStageId } : {}),
      requestedAt: item.createdAt,
      pausedAt,
    };
    // Deliberately NO completedAt: that field is what every reader treats as
    // "this run finished". Publish this before asking any child to stop.
    writeRunState(ctx.projectDir, ctx.runId, state);
    let requestingAttemptIndex: number | undefined;
    if (requestingStageId) {
      try {
        const status = readStageStatus(ctx.projectDir, ctx.runId, requestingStageId);
        const attempt = status.attempts?.at(-1);
        requestingAttemptIndex = attempt?.index;
        if (attempt && !isRunningStageStatus(attempt.status)) {
          const suspended = suspendStageAttempt(
            ctx.projectDir,
            ctx.runId,
            requestingStageId,
            attempt.index,
          );
          state.stages[requestingStageId] = suspended;
          recordRunEvent(ctx.projectDir, ctx.runId, {
            type: 'approval_attempt_suspended',
            runId: ctx.runId,
            timestamp: detectedAt,
            iteration: ctx.iteration,
            stageId: requestingStageId,
            attemptIndex: attempt.index,
            requestId,
            requestingStageId,
            detail: `settled attempt suspended for approval ${requestId}`,
            source: 'scheduler',
          });
        }
      } catch { /* the running worker will publish the authoritative settlement */ }
    }
    for (const [stageId, projected] of Object.entries(state.stages)) {
      if (!isRunningStageStatus(projected.status)) continue;
      try {
        const status = readStageStatus(ctx.projectDir, ctx.runId, stageId);
        const attempt = status.attempts?.at(-1);
        if (!attempt || !isRunningStageStatus(attempt.status)) continue;
        writeApprovalSuspensionSignal({
          runDirPath: ctx.runDirPath,
          stageId,
          attemptIndex: attempt.index,
          requestId,
          requestingStageId,
        });
      } catch { /* final batch reconciliation catches a synchronously settled requester */ }
    }
    // Capture any synchronous requester suspension in the parked projection.
    writeRunState(ctx.projectDir, ctx.runId, state);
    writeCampaignEntryUnlessPaused(ctx.projectDir, state);
    recordRunEvent(ctx.projectDir, ctx.runId, {
      type: 'approval_parked', runId: ctx.runId, timestamp: pausedAt, iteration: ctx.iteration,
      ...(requestingStageId ? { stageId: requestingStageId } : {}),
      ...(requestingAttemptIndex === undefined ? {} : { attemptIndex: requestingAttemptIndex }),
      requestId,
      requestedAt: item.createdAt,
      detectedAt,
      detail: `${action}${item.target ? ` → ${item.target}` : ''} awaiting approval (${requestId})`,
      source: 'scheduler',
    });
    appendApprovalGuidance(ctx.runDirPath, requestId, item.title);
    log.warn({ runId: ctx.runId, requestId, action, target: item.target },
      'PARKED awaiting human approval — resolve with `flowcrew inbox approve <requestId>`');
    return state;
  }

  async function inspectApprovalRequests(input: {
    selected: readonly StageConfig[];
    projectDir: string;
    runId: string;
    runDirPath: string;
    iteration: number;
  }): Promise<StoreState | null> {
    const state = readOperationalRunState(input.projectDir, input.runId);
    return tryParkOnApprovalRequest(state, {
      projectDir: input.projectDir,
      runId: input.runId,
      runDirPath: input.runDirPath,
      iteration: input.iteration,
      candidateStageIds: input.selected.map((stage) => stage.id),
    });
  }

  async function monitorApprovalRequests(input: {
    selected: readonly StageConfig[];
    projectDir: string;
    runId: string;
    runDirPath: string;
    iteration: number;
    isComplete: () => boolean;
  }): Promise<StoreState | null> {
    let parked: StoreState | null = null;
    let wake: (() => void) | undefined;
    const inspect = async (): Promise<void> => {
      if (parked) return;
      parked = await inspectApprovalRequests(input);
    };
    const watchers: import('node:fs').FSWatcher[] = [];
    try {
      for (const directory of [
        input.runDirPath,
        ...input.selected.map((stage) => join(input.runDirPath, 'stages', stage.id)),
      ]) {
        mkdirSync(directory, { recursive: true });
        watchers.push(watch(directory, { persistent: false }, (_event, fileName) => {
          const name = fileName?.toString();
          if (directory === input.runDirPath
              && (name === SCHEDULER_HEARTBEAT_FILE || name === SCHEDULER_LOOP_STALL_FILE)) return;
          wake?.();
        }));
      }
    } catch { /* one-second heartbeat remains the portable fallback */ }
    try {
      await inspect();
      while (!parked && !input.isComplete()) {
        await new Promise<void>((resolvePromise) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            wake = undefined;
            resolvePromise();
          };
          wake = finish;
          timer = setTimeout(finish, 1000);
          if (input.isComplete()) finish();
        });
        await inspect();
      }
      if (!parked) await inspect();
      return parked;
    } finally {
      for (const watcher of watchers) watcher.close();
    }
  }

  return { tryParkOnApprovalRequest, inspectApprovalRequests, monitorApprovalRequests };
}
