/**
 * `flowcrew inbox` — review and resolve the approval requests that parked runs.
 *
 * Verbs: list | show | approve | deny | rules | revoke
 *
 * Approving does two things: it appends the (first-wins) resolution to the run's
 * append-only approvals log, and it RESUMES the parked run — same runId, same
 * DAG, same iteration — by relaunching the scheduler with --existing-run-id.
 * Denying resolves without resuming unless --resume is passed (a denial usually
 * wants the agent to continue and record the block, which resuming does).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { approvalArtifactPath, isValidApprovalRequestId } from './approval-artifacts.js';
import { isPausedRunStatus, readRunState, runsRoot } from './store.js';
import { claimLaunchIntent, releaseLaunchIntent } from './run-lock.js';
import {
  formatBriefPreflightReport,
  verifyBriefAdmission,
  type BriefAdmissionRecord,
} from './brief-preflight.js';
import {
  foldItems, listAll, listStandingRules, resolveRequest, revokeStandingRule,
  standingRuleEligible, INBOX_FILTER_STATE, isPendingInboxItemState,
  type InboxFilterState, type InboxItem,
} from './inbox.js';

type ResumeSpawner = (
  command: string,
  args: string[],
  options: { detached: true; stdio: 'ignore' },
) => { pid?: number; unref: () => void };

const defaultResumeSpawner: ResumeSpawner = (command, args, options) =>
  spawn(command, args, options);

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Locate the (runId, item) for a requestId — request ids are unique per run, so scan pending first. */
function findByRequestId(requestId: string, runIdHint?: string): { runId: string; item: InboxItem } | undefined {
  if (runIdHint) {
    const item = foldItems(runIdHint).get(requestId);
    return item ? { runId: runIdHint, item } : undefined;
  }
  for (const item of listAll({ state: INBOX_FILTER_STATE.ALL })) {
    if (item.requestId === requestId) return { runId: item.runId, item };
  }
  return undefined;
}

function fmtRow(item: InboxItem): string {
  const state = isPendingInboxItemState(item.state) ? 'PENDING' : item.state.toUpperCase();
  return [
    item.requestId.padEnd(24),
    state.padEnd(9),
    (item.risk ?? 'unknown').padEnd(9),
    `${item.action}${item.target ? ` → ${item.target}` : ''}`.padEnd(38),
    item.runId,
  ].join(' ');
}

interface ResumeBriefSnapshot {
  exactBrief: string;
  admission: BriefAdmissionRecord;
  workflowName?: string;
}

function captureResumeBriefAdmission(runId: string, projectDir: string, out: NodeJS.WriteStream): ResumeBriefSnapshot {
  const state = readRunState(projectDir, runId);
  const briefPath = join(runsRoot(), runId, 'task_brief.md');
  const brief = existsSync(briefPath) ? readFileSync(briefPath, 'utf-8') : state.taskDescription ?? '';
  const verification = verifyBriefAdmission(brief, state.briefAdmission as BriefAdmissionRecord | undefined);
  if (verification.status !== 'valid' || !state.briefAdmission) {
    out.write(`${formatBriefPreflightReport(verification.report)}\n`);
    throw new Error(
      `Brief admission ${verification.status}; run ${runId} was not resumed. `
      + `Review with flowcrew quick --existing-run-id ${runId}, then explicitly admit digest ${verification.report.digest}.`,
    );
  }
  return { exactBrief: brief, admission: state.briefAdmission, workflowName: state.workflowName };
}

/** Relaunch a parked run in the background, continuing the same runId. */
function resumeRun(
  runId: string,
  projectDir: string,
  snapshot: ResumeBriefSnapshot,
  out: NodeJS.WriteStream,
  spawnProcess: ResumeSpawner,
): void {
  const claim = claimLaunchIntent(projectDir, runId);
  if (!claim.claimed) {
    throw new Error(`Project launch already in progress (${claim.blockingOwnerRunId ?? 'unknown'})`);
  }
  const cliPath = resolve(import.meta.dirname ?? '.', 'cli.js');
  const args = [
    cliPath,
    'quick',
    '--project', projectDir,
    '--brief-input-base64', Buffer.from(snapshot.exactBrief, 'utf8').toString('base64url'),
    '--brief-admission-record', Buffer.from(JSON.stringify(snapshot.admission), 'utf8').toString('base64url'),
    '--existing-run-id', runId,
    '--no-campaign',
  ];
  if (snapshot.workflowName && snapshot.workflowName !== 'default') args.push('--workflow', snapshot.workflowName);
  let child: ReturnType<ResumeSpawner>;
  try {
    child = spawnProcess(process.execPath, args, { detached: true, stdio: 'ignore' });
  } catch (err) {
    releaseLaunchIntent(projectDir, runId);
    throw err;
  }
  child.unref();
  out.write(`▶ resumed run ${runId} (pid ${child.pid})\n`);
}

export async function cmdInbox(
  args: string[],
  opts: {
    stdout?: NodeJS.WriteStream;
    stderr?: NodeJS.WriteStream;
    /** Test seam: production always uses the imported first-wins resolver. */
    resolveApproval?: typeof resolveRequest;
    /** Test seam: production always uses node:child_process spawn. */
    resumeSpawner?: ResumeSpawner;
  } = {},
): Promise<number> {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const verb = args[1];
  const positional = args[2];

  try {
    if (!verb || verb === 'list') {
      const state = (valueAfter(args, '--state') as InboxFilterState) ?? INBOX_FILTER_STATE.PENDING;
      const items = listAll({ state, runId: valueAfter(args, '--run') });
      if (items.length === 0) {
        out.write(state === INBOX_FILTER_STATE.PENDING ? 'No pending approval requests.\n' : `No ${state} approval requests.\n`);
        return 0;
      }
      out.write(['REQUEST'.padEnd(24), 'STATE'.padEnd(9), 'RISK'.padEnd(9), 'ACTION'.padEnd(38), 'RUN'].join(' ') + '\n');
      for (const item of items) out.write(fmtRow(item) + '\n');
      if (state === INBOX_FILTER_STATE.PENDING) out.write('\nResolve with: flowcrew inbox approve <REQUEST>  |  flowcrew inbox deny <REQUEST>\n');
      return 0;
    }

    if (verb === 'show') {
      if (!positional) { err.write('Usage: flowcrew inbox show <requestId>\n'); return 1; }
      const found = findByRequestId(positional, valueAfter(args, '--run'));
      if (!found) { err.write(`Unknown request: ${positional}\n`); return 1; }
      const { item } = found;
      out.write(`request:   ${item.requestId}\nstate:     ${item.state}\nrisk:      ${item.risk}\n`
        + `action:    ${item.action}${item.target ? `\ntarget:    ${item.target}` : ''}\n`
        + `run:       ${item.runId}\nproject:   ${item.projectDir}\ncreated:   ${item.createdAt}\n`
        + `title:     ${item.title}\n${item.body ? `\n${item.body}\n` : ''}`);
      if (item.resolution) {
        out.write(`\nresolved:  ${item.resolution.decision} by ${item.resolution.by} at ${item.resolution.at}`
          + `${item.resolution.reason ? ` — ${item.resolution.reason}` : ''}`
          + `${item.resolution.viaRule ? ` (standing rule ${item.resolution.viaRule})` : ''}\n`);
      } else {
        const eligible = standingRuleEligible(item);
        out.write(`\nstanding rule: ${eligible.ok ? 'eligible (--always available)' : `not eligible — ${eligible.reason}`}\n`);
      }
      return 0;
    }

    if (verb === 'approve' || verb === 'deny') {
      if (!positional) { err.write(`Usage: flowcrew inbox ${verb} <requestId> [--reason "..."] [--always] [--no-resume]\n`); return 1; }
      const found = findByRequestId(positional, valueAfter(args, '--run'));
      if (!found) { err.write(`Unknown request: ${positional}\n`); return 1; }
      const { runId, item } = found;
      if (!isValidApprovalRequestId(item.requestId)) {
        err.write(`Unsafe request id: ${item.requestId}\n`);
        return 1;
      }
      const decision = verb === 'approve' ? 'approve' : 'deny';
      const always = args.includes('--always');
      const runState = existsSync(join(runsRoot(), runId, 'run.json'))
        ? JSON.parse(readFileSync(join(runsRoot(), runId, 'run.json'), 'utf-8')) as { status?: string }
        : {};
      let resumeSnapshot: ResumeBriefSnapshot | undefined;
      if (!args.includes('--no-resume') && runState.status && isPausedRunStatus(runState.status)) {
        // Capture once before consuming the first-wins approval record. The
        // detached child receives these exact bytes and cannot drift to a
        // later sidecar edit.
        resumeSnapshot = captureResumeBriefAdmission(runId, item.projectDir, out);
      }
      const res = (opts.resolveApproval ?? resolveRequest)(item.projectDir, runId, item.requestId, decision, {
        by: process.env.USER || 'operator',
        reason: valueAfter(args, '--reason'),
        always,
      });
      if (!res.won) {
        const winner = res.item?.resolution;
        if (winner) {
          err.write(`Resolution lost race; winning decision is ${winner.decision}`
            + ` by ${winner.by}${winner.at ? ` at ${winner.at}` : ''}.\n`);
          return 2;
        }
        err.write(`${res.error ?? `Request ${item.requestId} was not resolved`}\n`);
        return 1;
      }
      if (res.error) { err.write(`${res.error}\n`); return 1; }
      out.write(`${decision === 'approve' ? '✓ approved' : '✗ denied'} ${item.requestId}`
        + `${always ? ' (+ standing rule for this action→target)' : ''}\n`);

      // The agent reads this file on resume; write it before relaunching.
      try {
        const dir = join(runsRoot(), runId, 'approvals');
        mkdirSync(dir, { recursive: true });
        writeFileSync(approvalArtifactPath(join(runsRoot(), runId), item.requestId, 'decision'),
          JSON.stringify({ requestId: item.requestId, decision, reason: valueAfter(args, '--reason') ?? '', at: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
      } catch { /* the inbox record remains the durable truth */ }

      if (args.includes('--no-resume')) {
        out.write('(not resuming — pass no flag to resume, or run `flowcrew quick --existing-run-id` yourself)\n');
      } else if (runState.status && isPausedRunStatus(runState.status)) {
        resumeRun(runId, item.projectDir, resumeSnapshot!, out, opts.resumeSpawner ?? defaultResumeSpawner);
      } else {
        out.write(`(run ${runId} is ${runState.status ?? 'unknown'}, not parked — nothing to resume)\n`);
      }
      return 0;
    }

    if (verb === 'rules') {
      const rules = listStandingRules();
      if (rules.length === 0) { out.write('No standing approval rules.\n'); return 0; }
      out.write(['ACTION'.padEnd(20), 'TARGET'.padEnd(28), 'GRANTED'.padEnd(22), 'PROJECT'].join(' ') + '\n');
      for (const r of rules) {
        out.write([r.action.padEnd(20), r.target.padEnd(28), r.grantedAt.padEnd(22), r.projectDir].join(' ') + '\n');
      }
      out.write('\nRevoke with: flowcrew inbox revoke <action> <target> [--project <dir>]\n');
      return 0;
    }

    if (verb === 'revoke') {
      const action = args[2];
      const target = args[3];
      if (!action || !target) { err.write('Usage: flowcrew inbox revoke <action> <target> [--project <dir>]\n'); return 1; }
      const projectDir = valueAfter(args, '--project') ?? process.cwd();
      const ok = revokeStandingRule(projectDir, action, target);
      out.write(ok ? `✓ revoked ${action} → ${target}\n` : `no such rule: ${action} → ${target} (project ${projectDir})\n`);
      return ok ? 0 : 1;
    }

    err.write('Usage: flowcrew inbox list|show|approve|deny|rules|revoke ...\n');
    return 1;
  } catch (e) {
    err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
