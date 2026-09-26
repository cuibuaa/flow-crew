import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import {
  atomicWrite,
  isAwaitingApprovalRunStatus,
  isPausedRunStatus,
  isRunningStageStatus,
  isSettledStageStatus,
  isTerminalRunStatus,
  readStageStatus,
  readRunState,
  resolveRunStatus,
  RUN_STATUS,
  runDir as getRunDirPath,
  STAGE_STATUS,
  stageDir,
  updateRunState,
} from './store.js';
import type { RunStatus, StageStatus, StoreState, SupervisorAttempt, SupervisorUsage } from './store.js';
import { loadProjectDefaults, type SupervisorConfig } from './config.js';
import { appendTraceEvent } from './trace.js';
import { ABORT_SIGNAL_VERSION, type AbortSignalSource, type StageAbortSignal } from './abort-signal.js';
import { createLogger } from './logging.js';
import {
  appendGuidanceEnvelope,
  renderGuidanceEnvelope,
  RUN_WIDE_GUIDANCE_TARGET,
} from './guidance.js';
import { readRunEvents, recordRunEvent, type RunEvent } from './run-events.js';
import {
  SupervisorEventCursor,
  resolveSupervisorDeadlineMarginMs,
  type SupervisorEvent,
  type SupervisorEventCandidate,
  type SupervisorEventCursorSnapshot,
  type SupervisorEventQuantities,
} from './supervisor-events.js';

const log = createLogger({ name: 'supervisor' });

/** Preserve the established progress wording while making every known row explicit. */
export const SUPERVISOR_PROGRESS_OUTCOME_LABELS = {
  [RUN_STATUS.PENDING]: 'In progress',
  [RUN_STATUS.RUNNING]: 'In progress',
  [RUN_STATUS.PARKED]: 'In progress',
  [RUN_STATUS.COMPLETE]: 'Complete',
  [RUN_STATUS.FAILED]: 'Failed',
  [RUN_STATUS.AWAITING_APPROVAL]: 'In progress',
  [RUN_STATUS.SHIPPED]: 'In progress',
  [RUN_STATUS.CEILING_HIT]: 'In progress',
  [RUN_STATUS.ESCALATED]: 'In progress',
  [RUN_STATUS.REALITY_GATE_FAILED]: 'In progress',
  [RUN_STATUS.PHASE_COMPLETE]: 'In progress',
  [RUN_STATUS.STOPPED]: 'In progress',
  [RUN_STATUS.INCOMPLETE]: 'In progress',
} as const satisfies Record<RunStatus, string>;

/**
 * Single source of truth for supervisor verdicts (P4 of the Atom Architecture).
 * The system prompt's verdict union + descriptions are RENDERED from this — no
 * second prose copy to drift. Adding a verdict = add a descriptor here.
 */
export const SUPERVISOR_VERDICTS = [
  { id: 'WAIT', description: 'Agents making progress. No intervention.' },
  { id: 'GUIDE', description: 'Agent going wrong direction. Provide corrective instruction in "guidance".' },
  { id: 'ABORT', description: 'Stage stuck/looping/wasting time. Kill it and let retry handle it.' },
  { id: 'REPLAN', description: 'Fundamental approach is wrong. Needs a new plan entirely.' },
  { id: 'REJECT', description: 'A stage emitted a deliverable that does NOT meet its own declared work/acceptance criteria (e.g. a verdict claims pass while its evidence shows otherwise, or a stage marked itself done with the required artifact missing/empty). The result must NOT be accepted — set "target_stage" to the stage and the work is re-done.' },
  { id: 'DONE', description: 'The original goal is fully met based on evidence in the output.' },
] as const;
export type SupervisorVerdict = typeof SUPERVISOR_VERDICTS[number]['id'];

export interface SupervisorAssessment {
  verdict: SupervisorVerdict;
  targetStage: string | null;
  reason: string;
  guidance: string | null;
  /** Stable identity for one concrete wrong direction. GUIDE and direction-
   * ABORT assessments reuse this key; idle ABORT and all other verdicts omit it. */
  directionKey?: string;
  /** Stable identity assigned to one completed model assessment. */
  assessmentId?: string;
  assessedAt?: string;
  /** Evidence rows the model says its consequential judgment rests on. */
  evidenceIds?: string[];
  /** Explicit retraction/replacement of one earlier assessment. */
  supersedesAssessmentId?: string;
  /** Exact envelope written for an effective GUIDE. */
  guidanceId?: string;
}

export type SupervisorEvidenceKind =
  | 'agent_statement'
  | 'command_invocation'
  | 'file_change'
  | 'tool_output'
  | 'unattributed';

export interface SupervisorEvidenceRow {
  id: string;
  kind: SupervisorEvidenceKind;
  authority: 'action' | 'inspection';
  text: string;
}

export interface SupervisorStageEvidence {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  rows: SupervisorEvidenceRow[];
}

interface SupervisorShellToken {
  value: string;
  operator: boolean;
}

const SUPERVISOR_INSPECTION_COMMANDS = new Set([
  '[',
  'basename',
  'cat',
  'cmp',
  'diff',
  'dirname',
  'echo',
  'file',
  'find',
  'grep',
  'head',
  'ls',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'sed',
  'sha256sum',
  'stat',
  'tail',
  'test',
  'wc',
]);

const SUPERVISOR_INSPECTION_GIT_SUBCOMMANDS = new Set([
  'blame',
  'branch',
  'diff',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'show',
  'status',
]);

const SUPERVISOR_CLAIM_STOP_WORDS = new Set([
  'about', 'after', 'again', 'assessment', 'attempt', 'because', 'before',
  'being', 'continue', 'continues', 'correction', 'current', 'direction',
  'evidence', 'instead', 'instruction', 'required', 'stage', 'still',
  'their', 'there', 'these', 'this', 'those', 'wrong', 'work',
]);

function supervisorShellTokens(command: string): SupervisorShellToken[] | undefined {
  const tokens: SupervisorShellToken[] = [];
  let value = '';
  let quote: '"' | "'" | undefined;
  const flush = (): void => {
    if (value) tokens.push({ value, operator: false });
    value = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        value += command[index + 1];
        index += 1;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      value += command[index + 1];
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      if (character === '\n') tokens.push({ value: '\n', operator: true });
      continue;
    }
    if (';|&<>'.includes(character)) {
      flush();
      let operator = character;
      while (index + 1 < command.length && command[index + 1] === character && operator.length < 2) {
        operator += command[index + 1];
        index += 1;
      }
      tokens.push({ value: operator, operator: true });
      continue;
    }
    value += character;
  }
  if (quote) return undefined;
  flush();
  return tokens;
}

function supervisorCommandSegments(command: string): string[][] | undefined {
  // Command substitutions and shell programs can hide arbitrary writes. Keep
  // them action-bearing unless a structured adapter reports their inner work.
  if (command.includes('$(') || command.includes('`')) return undefined;
  const tokens = supervisorShellTokens(command);
  if (!tokens) return undefined;
  const segments: string[][] = [[]];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.operator) {
      segments.at(-1)!.push(token.value);
      continue;
    }
    if (token.value === '<') {
      const target = tokens[index + 1];
      if (!target || target.operator) return undefined;
      segments.at(-1)!.push('<', target.value);
      index += 1;
      continue;
    }
    // Output redirection is observable work even when the producer itself is
    // read-only. A pipeline/conditional is inspection only when every member
    // is independently inspection-only.
    if (token.value === '>' || token.value === '>>' || token.value === '<<') return undefined;
    if (!['\n', ';', '|', '||', '&&', '&'].includes(token.value)) return undefined;
    if (segments.at(-1)!.length === 0) return undefined;
    segments.push([]);
  }
  if (segments.length === 0 || segments.at(-1)!.length === 0) return undefined;
  return segments;
}

function unwrapSupervisorCommand(tokens: string[]): string[] {
  let cursor = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) cursor += 1;
  if (tokens[cursor] === 'command') cursor += 1;
  if (tokens[cursor] === 'env') {
    cursor += 1;
    while ((tokens[cursor] ?? '').startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) cursor += 1;
  }
  if (tokens[cursor] === 'timeout') {
    cursor += 1;
    while ((tokens[cursor] ?? '').startsWith('-')) cursor += 1;
    if (tokens[cursor]) cursor += 1;
  }
  return tokens.slice(cursor);
}

function supervisorSedIsInspection(tokens: string[]): boolean {
  if (tokens.some((token) => token === '-i' || token.startsWith('-i') || token.startsWith('--in-place'))) return false;
  // GNU sed's e/w commands execute a program or write a file. This is a
  // deliberately conservative recognizer; unfamiliar programs remain ACTION.
  const programs = tokens.slice(1).filter((token) => !token.startsWith('-'));
  return programs.every((program) => !/(?:^|[;{}\s])(?:e|w|W)(?:\s|$)/.test(program));
}

/**
 * Decide whether a shell invocation can establish pursuit or only inspection.
 * The inspection set is intentionally narrow: every command in a compound
 * invocation must be a known read-only form and no output redirection or
 * opaque shell expansion may be present. Unknown commands remain ACTION.
 */
export function classifySupervisorCommandEvidence(command: string): SupervisorEvidenceRow['authority'] {
  const segments = supervisorCommandSegments(command.trim());
  if (!segments) return 'action';
  for (const rawSegment of segments) {
    const segment = unwrapSupervisorCommand(rawSegment);
    const executable = (segment[0] ?? '').split('/').at(-1) ?? '';
    if (!SUPERVISOR_INSPECTION_COMMANDS.has(executable) && executable !== 'git') return 'action';
    if (executable === 'sed' && !supervisorSedIsInspection(segment)) return 'action';
    if (executable === 'find' && segment.some((token) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(token))) return 'action';
    if (executable === 'git') {
      const subcommand = segment.slice(1).find((token) => !token.startsWith('-'));
      if (!subcommand || !SUPERVISOR_INSPECTION_GIT_SUBCOMMANDS.has(subcommand)) return 'action';
    }
  }
  return 'inspection';
}

function classifySupervisorToolUseEvidence(name: unknown, input: unknown): SupervisorEvidenceRow['authority'] {
  if (typeof name !== 'string') return 'action';
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (/^(?:read|view|search|glob|grep|find|list|get|open)(?:_|$)/.test(normalized)) return 'inspection';
  if (/^(?:bash|shell|exec|exec_command|run_command)$/.test(normalized) && input && typeof input === 'object') {
    const payload = input as Record<string, unknown>;
    const command = typeof payload.command === 'string' ? payload.command
      : typeof payload.cmd === 'string' ? payload.cmd
        : undefined;
    return command ? classifySupervisorCommandEvidence(command) : 'action';
  }
  return 'action';
}

function supervisorClaimTerms(value: string): Set<string> {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return new Set(normalized.split(/[^a-z0-9]+/).filter((term) => (
    term.length >= 4
    && !/^\d+$/.test(term)
    && !SUPERVISOR_CLAIM_STOP_WORDS.has(term)
  )));
}

function supervisorEvidenceSupportsAssessment(
  assessment: SupervisorAssessment,
  rows: readonly SupervisorEvidenceRow[],
): { supported: boolean; sharedTerms: string[] } {
  const claimTerms = supervisorClaimTerms(`${assessment.reason} ${assessment.directionKey ?? ''}`);
  const sharedTerms = [...new Set(rows.flatMap((row) => {
    const evidenceTerms = supervisorClaimTerms(row.text);
    return [...claimTerms].filter((term) => evidenceTerms.has(term));
  }))].sort();
  return { supported: sharedTerms.length > 0, sharedTerms };
}

/** Comparison is deliberately stricter than citation validation. A citation
 * needs one concrete lexical anchor; declaring an unaccused stage to be on the
 * same direction requires one command/tool invocation to satisfy the whole
 * stable direction-key predicate. Structural path features make a home run
 * store read comparable without treating generic words such as "marker" or
 * "population" as the behavior itself. */
function supervisorDirectionEvidenceSupportsAssessment(
  assessment: SupervisorAssessment,
  rows: readonly SupervisorEvidenceRow[],
): boolean | undefined {
  const directionKey = normalizeDirectionKey(assessment.directionKey);
  if (!directionKey) return undefined;
  const predicateTerms = supervisorClaimTerms(directionKey);
  // One open-vocabulary word has no independently checkable conjunction. It
  // cannot safely turn sibling activity into either a match or a negative.
  if (predicateTerms.size < 2) return undefined;

  return rows.some((row) => {
    const actionTerms = supervisorClaimTerms(row.text);
    const referencesHomeRunStore = /(?:~|\$\{?HOME\}?|\/home\/[^/\s"'`]+)\/\.fc\/runs(?:\/|\b)/i.test(row.text);
    if (referencesHomeRunStore) {
      for (const feature of ['using', 'home', 'run', 'store', 'input']) actionTerms.add(feature);
    }
    return [...predicateTerms].every((term) => actionTerms.has(term));
  });
}

function boundedEvidenceText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\r\n/g, '\n').trim();
  return text ? text.slice(0, 4_000) : undefined;
}

function evidenceRow(
  input: Pick<SupervisorStageEvidence, 'stageId' | 'attemptIndex' | 'attemptStartedAt'>,
  kind: SupervisorEvidenceKind,
  authority: SupervisorEvidenceRow['authority'],
  text: string,
  identity: unknown,
): SupervisorEvidenceRow {
  const id = `ev_${createHash('sha256').update(JSON.stringify([
    input.stageId,
    input.attemptIndex,
    input.attemptStartedAt,
    kind,
    identity,
  ])).digest('hex').slice(0, 20)}`;
  return { id, kind, authority, text };
}

/**
 * Project supported adapter JSONL into evidence that preserves provenance.
 * Agent statements, mutating/action-bearing invocations, and file changes can
 * establish what a stage did. Read-only invocations, tool results, and opaque
 * legacy text remain visible for inspection, but cannot by themselves
 * establish what the stage was pursuing.
 */
export function projectSupervisorStageEvidence(input: {
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  raw: string;
}): SupervisorStageEvidence {
  const rows: SupervisorEvidenceRow[] = [];
  const add = (
    kind: SupervisorEvidenceKind,
    authority: SupervisorEvidenceRow['authority'],
    textValue: unknown,
    identity: unknown,
  ): void => {
    const text = boundedEvidenceText(textValue);
    if (!text) return;
    rows.push(evidenceRow(input, kind, authority, text, identity));
  };

  for (const [lineIndex, rawLine] of input.raw.replace(/\r\n/g, '\n').split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      add('unattributed', 'inspection', line, ['plain', lineIndex, line]);
      continue;
    }

    const eventType = typeof event.type === 'string' ? event.type : 'unknown';
    const item = event.item && typeof event.item === 'object'
      ? event.item as Record<string, unknown>
      : undefined;
    const itemType = typeof item?.type === 'string' ? item.type : undefined;
    const eventIdentity = [eventType, item?.id ?? event.id ?? null, line];
    let recognized = false;

    // Codex JSONL.
    if (itemType === 'agent_message') {
      add('agent_statement', 'action', item?.text, [...eventIdentity, 'agent_message']);
      recognized = true;
    }
    if (eventType === 'message' && event.role === 'assistant') {
      add('agent_statement', 'action', event.content, [...eventIdentity, 'assistant_message']);
      recognized = true;
    }
    if (itemType === 'command_execution') {
      const command = boundedEvidenceText(item?.command);
      if (command) add('command_invocation', classifySupervisorCommandEvidence(command), command, [...eventIdentity, 'command']);
      add('tool_output', 'inspection', item?.aggregated_output, [...eventIdentity, 'command_output']);
      add('tool_output', 'inspection', item?.output, [...eventIdentity, 'command_output_fallback']);
      recognized = true;
    }
    if (itemType === 'file_change' || eventType === 'file_change') {
      const payload = item ?? event;
      add('file_change', 'action', JSON.stringify(payload.changes ?? payload), [...eventIdentity, 'file_change']);
      recognized = true;
    }

    // Claude stream-json. A single assistant event can contain both authored
    // text/tool requests and later tool-result blocks, so classify each block.
    const message = event.message && typeof event.message === 'object'
      ? event.message as Record<string, unknown>
      : undefined;
    const content = Array.isArray(message?.content)
      ? message.content
      : Array.isArray(event.content) ? event.content : undefined;
    if ((eventType === 'assistant' || eventType === 'user') && content) {
      for (const [blockIndex, rawBlock] of content.entries()) {
        if (!rawBlock || typeof rawBlock !== 'object') continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type === 'text' && eventType === 'assistant') {
          add('agent_statement', 'action', block.text, [...eventIdentity, 'text', blockIndex]);
          recognized = true;
        } else if (block.type === 'tool_use' && eventType === 'assistant') {
          add(
            'command_invocation',
            classifySupervisorToolUseEvidence(block.name, block.input),
            JSON.stringify({ name: block.name, input: block.input }),
            [...eventIdentity, 'tool_use', blockIndex],
          );
          recognized = true;
        } else if (block.type === 'tool_result') {
          add('tool_output', 'inspection', typeof block.content === 'string' ? block.content : JSON.stringify(block.content), [...eventIdentity, 'tool_result', blockIndex]);
          recognized = true;
        }
      }
    } else if (eventType === 'assistant') {
      add('agent_statement', 'action', event.content, [...eventIdentity, 'assistant_fallback']);
      recognized = true;
    } else if (eventType === 'content_block_delta') {
      const delta = event.delta && typeof event.delta === 'object' ? event.delta as Record<string, unknown> : undefined;
      add('agent_statement', 'action', delta?.text, [...eventIdentity, 'assistant_delta']);
      recognized = true;
    } else if (eventType === 'result') {
      add('unattributed', 'inspection', event.result, [...eventIdentity, 'result']);
      recognized = true;
    }

    if (!recognized) add('unattributed', 'inspection', line, [...eventIdentity, 'unrecognized']);
  }

  const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()];
  return {
    version: 1,
    stageId: input.stageId,
    attemptIndex: input.attemptIndex,
    attemptStartedAt: input.attemptStartedAt,
    rows: uniqueRows,
  };
}

const DIRECTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{20}$/;
const ASSESSMENT_ID_PATTERN = /^sa_[0-9a-f]{20}$/;

function normalizeDirectionKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return DIRECTION_KEY_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeEvidenceIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value.filter((entry): entry is string => (
    typeof entry === 'string' && EVIDENCE_ID_PATTERN.test(entry)
  )))];
  return ids.length > 0 ? ids : undefined;
}

function normalizeAssessmentId(value: unknown): string | undefined {
  return typeof value === 'string' && ASSESSMENT_ID_PATTERN.test(value) ? value : undefined;
}

export function summarizeSupervisorGuidanceHistory(
  actions: ReadonlyArray<{ assessment: SupervisorAssessment }>,
  runningStages: readonly string[],
): string {
  const running = new Set(runningStages);
  const byStage = new Map<string, SupervisorAssessment[]>();
  for (const action of actions) {
    const assessment = action.assessment;
    if (assessment.verdict !== 'GUIDE' || !assessment.targetStage || !running.has(assessment.targetStage)) continue;
    const prior = byStage.get(assessment.targetStage) ?? [];
    prior.push(assessment);
    byStage.set(assessment.targetStage, prior);
  }
  return runningStages.flatMap((stageId) => {
    const guidance = byStage.get(stageId) ?? [];
    if (guidance.length === 0) return [];
    const recentReasons = guidance.slice(-3).map((assessment) =>
      `${assessment.directionKey ? `[${assessment.directionKey}] ` : ''}${assessment.reason.replace(/\s+/g, ' ').trim().slice(0, 240) || '(reason unavailable)'}`
    );
    return [`- ${stageId}: ${guidance.length} cumulative GUIDE decisions; recent reasons: ${recentReasons.join(' | ')}`];
  }).join('\n');
}

interface SupervisorAction {
  timestamp: string;
  tick: number;
  assessment: SupervisorAssessment;
  /** The deterministic event that authorized this model call. */
  trigger: SupervisorEvent;
  runningStages: string[];
  /** Attempt that was running when the action targeted its stage. */
  targetAttemptIndex?: number;
  /** Operator additions remain guidance, but do not authorize direction ABORT. */
  source?: 'supervisor' | 'operator';
  /** Exact attempt/progress generation visible to the assessment. */
  directionEvidence?: DirectionEvidenceBinding;
}

function actionAttemptIndex(action: SupervisorAction, status: StageStatus | undefined): number | undefined {
  if (Number.isInteger(action.targetAttemptIndex)) return action.targetAttemptIndex;
  if (!status) return undefined;
  const actionAt = Date.parse(action.timestamp);
  if (!Number.isFinite(actionAt)) return undefined;
  return status.attempts?.find((attempt) => {
    const startedAt = Date.parse(attempt.startedAt);
    const completedAt = attempt.completedAt ? Date.parse(attempt.completedAt) : Number.POSITIVE_INFINITY;
    return Number.isFinite(startedAt) && actionAt >= startedAt && actionAt <= completedAt;
  })?.index;
}

/**
 * Parse a supervisor verdict from raw adapter output. Pure + exported so it is unit-
 * testable (a prior JSON-parse bug silently killed the supervisor for whole runs).
 * Collects ALL `{...verdict...}` matches and scans LAST-to-FIRST — the real response is
 * at the end; the prompt's echoed template (with `<placeholders>`) appears earlier and
 * must not be mistaken for the answer. Valid verdicts derive from SUPERVISOR_VERDICTS.
 */
export function parseSupervisorVerdict(output: string): SupervisorAssessment | null {
  const matches = [...output.matchAll(/\{[^}]*"verdict"[^}]*\}/g)];
  if (matches.length === 0) return null;
  const valid = SUPERVISOR_VERDICTS.map((v) => v.id);
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i][0]);
      if (!valid.includes(parsed.verdict)) continue;
      const directionKey = parsed.verdict === 'GUIDE' || parsed.verdict === 'ABORT'
        ? normalizeDirectionKey(parsed.direction_key)
        : undefined;
      const evidenceIds = normalizeEvidenceIds(parsed.evidence_ids);
      const supersedesAssessmentId = normalizeAssessmentId(parsed.supersedes_assessment_id);
      return {
        verdict: parsed.verdict,
        targetStage: parsed.target_stage ?? null,
        reason: parsed.reason ?? '',
        guidance: parsed.guidance ?? null,
        ...(directionKey ? { directionKey } : {}),
        ...(evidenceIds ? { evidenceIds } : {}),
        ...(supersedesAssessmentId ? { supersedesAssessmentId } : {}),
      };
    } catch { /* try the next earlier match */ }
  }
  return null;
}

/**
 * GAP-2: deterministic per-running-stage no-progress watchdog. PURE + exported so it is
 * unit-testable independent of the LLM supervisor verdict. Generic mechanism — no domain
 * knowledge: "progress" is any of the per-tick signals the supervisor already computes
 * (new live.log bytes for that stage, a new artifact, or a stage transition); the threshold
 * is config-owned.
 *
 * Tracks the last time each running stage showed progress in `lastProgressMs` (a map the
 * caller persists across ticks). On each tick:
 *   - a stage seen for the FIRST time is initialized to `now` (it just started — not stalled).
 *   - a stage that made progress this tick has its timestamp refreshed to `now`.
 *   - a stage that has shown no progress for >= thresholdMs is reported as STALLED.
 *   - stages no longer running are dropped from the map (completed / iteration transition).
 *
 * Returns the next map (caller stores it) and the list of stalled stage ids to abort.
 */
export function detectStalledStages(input: {
  runningStages: string[];
  /** Stage ids that showed progress THIS tick (new live.log bytes, new artifact, or a transition). */
  progressedStageIds: Set<string>;
  /** Per-stage last-progress timestamps carried across ticks (caller-owned). */
  lastProgressMs: Record<string, number>;
  now: number;
  thresholdMs: number;
}): { nextLastProgressMs: Record<string, number>; stalledStageIds: string[] } {
  const { runningStages, progressedStageIds, lastProgressMs, now, thresholdMs } = input;
  const running = new Set(runningStages);
  const next: Record<string, number> = {};
  const stalled: string[] = [];
  for (const stageId of runningStages) {
    if (progressedStageIds.has(stageId) || lastProgressMs[stageId] === undefined) {
      // First appearance OR fresh progress this tick → (re)set the clock; not stalled.
      next[stageId] = now;
      continue;
    }
    // No progress this tick — carry the prior timestamp forward and check the gap.
    next[stageId] = lastProgressMs[stageId];
    if (now - lastProgressMs[stageId] >= thresholdMs) stalled.push(stageId);
  }
  // Drop any tracked stage that is no longer running (completed / iteration transition).
  for (const stageId of Object.keys(lastProgressMs)) {
    if (!running.has(stageId)) delete next[stageId];
  }
  return { nextLastProgressMs: next, stalledStageIds: stalled };
}

export interface StageExecutionFacts {
  stageId: string;
  attemptIndex?: number;
  attemptStartedAt?: string;
  verdictObserved: boolean;
  outputObserved: boolean;
  handoffObserved: boolean;
  commitObserved: boolean;
  liveProgressThisTick: boolean;
  artifactProgressThisTick: boolean;
  activeCommandCount: number;
  commandActivityValid: boolean;
  finalizing: boolean;
  protectedFromIdleAbort: boolean;
}

interface ProjectCommitFact {
  hash: string;
  committedAtMs: number;
}

/** Attempt-scoped progress generation that was visible when the supervisor
 * made one semantic judgment. The generation is persisted with the action; it
 * does not claim that output volume is correctness evidence. */
export interface DirectionEvidenceBinding {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  generation: string;
}

export interface DirectionGuidanceFact {
  timestamp: string;
  assessment: SupervisorAssessment;
  targetAttemptIndex?: number;
  source?: 'supervisor' | 'operator';
  directionEvidence?: DirectionEvidenceBinding;
}

export interface DirectionPersistenceResult {
  verified: boolean;
  guideCount: number;
  matchingGuideCount: number;
  mode: 'delivered_opportunities' | 'non_discriminating' | 'unverified';
  generations: string[];
  opportunities: string[];
  siblingComparison: SupervisorDirectionComparison;
  reason: string;
}

export interface SupervisorDirectionComparison {
  populationStageIds: string[];
  matchingStageIds: string[];
  denominator: number;
  matchingCount: number;
}

/** Apply the same assessment predicate to the unaccused execution population.
 * Command/tool-use rows include read-only inputs as well as writes, but exclude
 * prompt/output prose that can merely repeat the supervisor's accusation. */
export function compareSupervisorDirectionAcrossStages(input: {
  accusedStageId: string;
  assessment: SupervisorAssessment;
  stageEvidence: readonly SupervisorStageEvidence[];
}): SupervisorDirectionComparison {
  const candidates = input.stageEvidence.filter((projection) => (
    projection.stageId !== input.accusedStageId
  ));
  const evaluated = candidates.map((projection) => ({
    projection,
    matches: supervisorDirectionEvidenceSupportsAssessment(
      input.assessment,
      projection.rows.filter((row) => row.kind === 'command_invocation'),
    ),
  })).filter((entry): entry is typeof entry & { matches: boolean } => entry.matches !== undefined);
  const matchingStageIds = evaluated
    .filter((entry) => entry.matches)
    .map((entry) => entry.projection.stageId)
    .sort();
  const populationStageIds = evaluated
    .map((entry) => entry.projection.stageId)
    .sort();
  return {
    populationStageIds,
    matchingStageIds,
    denominator: populationStageIds.length,
    matchingCount: matchingStageIds.length,
  };
}

/** A count or advancing file hash is not proof that a correction was declined.
 * Each GUIDE must have been delivered in its target attempt, followed by a
 * distinct adapter invocation in which the worker could act. The next
 * judgment must then cite new action-bearing evidence for the same direction. */
export function verifyRepeatedWrongDirection(input: {
  stageId: string;
  attemptIndex: number | undefined;
  assessment: SupervisorAssessment;
  currentEvidence?: DirectionEvidenceBinding;
  accusedEvidence?: SupervisorStageEvidence;
  guidance: readonly DirectionGuidanceFact[];
  deliveryEvents?: readonly RunEvent[];
  assessmentTimestamp?: string;
  siblingEvidence: readonly SupervisorStageEvidence[];
}): DirectionPersistenceResult {
  const guides = input.guidance.filter((action) => (
    action.assessment.verdict === 'GUIDE'
    && action.assessment.targetStage === input.stageId
    && (action.source ?? 'supervisor') === 'supervisor'
    && action.targetAttemptIndex === input.attemptIndex
  ));
  const guideCount = guides.length;
  const directionKey = normalizeDirectionKey(input.assessment.directionKey);
  const currentEvidence = input.currentEvidence;
  const currentEvidenceValid = currentEvidence?.version === 1
    && currentEvidence.stageId === input.stageId
    && currentEvidence.attemptIndex === input.attemptIndex
    && Number.isFinite(Date.parse(currentEvidence.attemptStartedAt))
    && /^[0-9a-f]{64}$/.test(currentEvidence.generation);
  const boundToCurrentDirection = (guide: DirectionGuidanceFact): boolean => Boolean(
    normalizeDirectionKey(guide.assessment.directionKey) === directionKey
      && guide.directionEvidence?.version === 1
      && guide.directionEvidence?.stageId === input.stageId
      && guide.directionEvidence.attemptIndex === input.attemptIndex
      && guide.directionEvidence.attemptStartedAt === currentEvidence!.attemptStartedAt
      && /^[0-9a-f]{64}$/.test(guide.directionEvidence.generation)
      && guide.assessment.guidanceId
      && guide.assessment.evidenceIds?.length
  );
  const matching = directionKey && currentEvidenceValid
    ? guides.filter(boundToCurrentDirection)
    : [];
  const latestGuides = guides.slice(-2);
  const latestMatching = directionKey && currentEvidenceValid
    ? latestGuides.filter(boundToCurrentDirection)
    : [];
  const deliveryEvents = input.deliveryEvents ?? [];
  const siblingComparison = compareSupervisorDirectionAcrossStages({
    accusedStageId: input.stageId,
    assessment: input.assessment,
    stageEvidence: input.siblingEvidence,
  });
  const accusedProjection = input.accusedEvidence;
  const accusedProjectionBound = Boolean(
    accusedProjection
      && accusedProjection.stageId === input.stageId
      && accusedProjection.attemptIndex === input.attemptIndex
      && accusedProjection.attemptStartedAt === currentEvidence?.attemptStartedAt
  );
  const citedEvidenceIds = new Set(input.assessment.evidenceIds ?? []);
  const accusedPredicate = accusedProjectionBound
    ? supervisorDirectionEvidenceSupportsAssessment(
        input.assessment,
        accusedProjection!.rows.filter((row) => (
          row.kind === 'command_invocation' && citedEvidenceIds.has(row.id)
        )),
      )
    : undefined;
  const opportunityFor = (guide: DirectionGuidanceFact): { key: string; timestamp: string } | undefined => {
    const guidanceId = guide.assessment.guidanceId;
    if (!guidanceId) return undefined;
    const guideAt = Date.parse(guide.timestamp);
    const delivered = deliveryEvents.find((event) => (
      event.type === 'guidance_delivery_checked'
      && event.delivered === true
      && event.stageId === input.stageId
      && event.attemptIndex === input.attemptIndex
      && event.attemptStartedAt === currentEvidence?.attemptStartedAt
      && event.guidanceIds?.includes(guidanceId)
      && (!Number.isFinite(guideAt) || Date.parse(event.timestamp) >= guideAt)
    ));
    if (!delivered) return undefined;
    const invocation = delivered.boundary === 'adapter_invocation'
      ? delivered
      : deliveryEvents.find((event) => (
          event.type === 'guidance_delivery_checked'
          && event.boundary === 'adapter_invocation'
          && event.stageId === input.stageId
          && event.attemptIndex === input.attemptIndex
          && event.attemptStartedAt === currentEvidence?.attemptStartedAt
          && Date.parse(event.timestamp) >= Date.parse(delivered.timestamp)
          && (delivered.invocationIndex === undefined
            || event.invocationIndex === undefined
            || event.invocationIndex > delivered.invocationIndex)
        ));
    if (!invocation) return undefined;
    return {
      key: `${input.stageId}:${input.attemptIndex ?? 'unknown'}:${invocation.invocationIndex ?? invocation.timestamp}`,
      timestamp: invocation.timestamp,
    };
  };

  if (latestMatching.length === 2 && currentEvidenceValid && latestMatching.length === latestGuides.length) {
    const generations = [
      latestMatching[0].directionEvidence!.generation,
      latestMatching[1].directionEvidence!.generation,
      currentEvidence.generation,
    ];
    const opportunities = latestMatching.map(opportunityFor);
    const currentAssessmentAt = input.assessmentTimestamp ?? new Date().toISOString();
    const nextJudgments = [
      {
        timestamp: latestMatching[1].timestamp,
        evidenceIds: latestMatching[1].assessment.evidenceIds ?? [],
        priorEvidenceIds: latestMatching[0].assessment.evidenceIds ?? [],
      },
      {
        timestamp: currentAssessmentAt,
        evidenceIds: input.assessment.evidenceIds ?? [],
        priorEvidenceIds: latestMatching[1].assessment.evidenceIds ?? [],
      },
    ];
    const eachOpportunityPrecedesNewActionEvidence = opportunities.every((opportunity, index) => {
      if (!opportunity) return false;
      const next = nextJudgments[index];
      const opportunityAt = Date.parse(opportunity.timestamp);
      const judgmentAt = Date.parse(next.timestamp);
      return Number.isFinite(opportunityAt)
        && Number.isFinite(judgmentAt)
        && opportunityAt <= judgmentAt
        && next.evidenceIds.some((id) => !next.priorEvidenceIds.includes(id));
    });
    const opportunityKeys = opportunities.flatMap((opportunity) => opportunity?.key ?? []);
    if (
      new Set(generations).size === generations.length
      && opportunityKeys.length === 2
      && new Set(opportunityKeys).size === opportunityKeys.length
      && eachOpportunityPrecedesNewActionEvidence
    ) {
      if (accusedPredicate !== true) {
        return {
          verified: false,
          guideCount,
          matchingGuideCount: matching.length,
          mode: 'unverified',
          generations,
          opportunities: opportunityKeys,
          siblingComparison,
          reason: accusedPredicate === false
            ? `direction ${directionKey} did not hold for the accused stage's cited command evidence`
            : `direction ${directionKey} could not be applied to current cited command evidence for the accused stage`,
        };
      }
      if (siblingComparison.denominator === 0) {
        return {
          verified: false,
          guideCount,
          matchingGuideCount: matching.length,
          mode: 'unverified',
          generations,
          opportunities: opportunityKeys,
          siblingComparison,
          reason: `direction ${directionKey} persisted, but no unaccused stage evidence was available for a discriminating comparison`,
        };
      }
      if (siblingComparison.matchingCount > 0) {
        return {
          verified: false,
          guideCount,
          matchingGuideCount: matching.length,
          mode: 'non_discriminating',
          generations,
          opportunities: opportunityKeys,
          siblingComparison,
          reason: `direction ${directionKey} also held for ${siblingComparison.matchingCount}/${siblingComparison.denominator} unaccused stages (${siblingComparison.matchingStageIds.join(', ')})`,
        };
      }
      return {
        verified: true,
        guideCount,
        matchingGuideCount: matching.length,
        mode: 'delivered_opportunities',
        generations,
        opportunities: opportunityKeys,
        siblingComparison,
        reason: `direction ${directionKey} persisted after two separately delivered corrections and two distinct worker invocation opportunities and held for 0/${siblingComparison.denominator} unaccused stages`,
      };
    }
  }
  const opportunities = latestMatching.flatMap((guide) => opportunityFor(guide)?.key ?? []);
  const reason = guideCount < 2
    ? `only ${guideCount} prior GUIDE decision(s) were observed`
    : !directionKey
        ? 'the ABORT supplied no stable wrong-direction key'
        : matching.length < 2
          ? `only ${matching.length} GUIDE decision(s) were evidence-bound to direction ${directionKey} and this attempt`
          : opportunities.length < 2
            ? `only ${opportunities.length} matching GUIDE decision(s) had a recorded delivery followed by a worker invocation opportunity`
            : new Set(opportunities).size < 2
              ? 'the matching GUIDE decisions were delivered together and provided only one worker response opportunity'
              : 'the later judgments did not cite new action evidence after each delivered correction';
  return {
    verified: false,
    guideCount,
    matchingGuideCount: matching.length,
    mode: 'unverified',
    generations: latestMatching.flatMap((guide) => guide.directionEvidence?.generation ?? [])
      .concat(currentEvidence?.generation ?? []),
    opportunities,
    siblingComparison,
    reason,
  };
}

type AbortBasis =
  | { kind: 'idle'; stalledMs: number }
  | { kind: 'repeated_guidance'; persistence: DirectionPersistenceResult };

interface VerifiedAbortResult {
  written: boolean;
  reason: string;
}

function currentRunningAttempt(status: StageStatus | undefined): { index: number; startedAt: string } | undefined {
  const attempts = status?.attempts ?? [];
  for (let index = attempts.length - 1; index >= 0; index--) {
    const attempt = attempts[index];
    if (attempt.status === STAGE_STATUS.RUNNING) return { index: attempt.index, startedAt: attempt.startedAt };
  }
  return undefined;
}

function operationalDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export interface SupervisorEvidenceBinding {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  generation: string;
  emittedDeliverable: boolean;
}

interface AttemptGenerationRecord {
  version: 1;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  segmentStart: number;
  artifactBaselines?: Record<string, string | null>;
}

function readAttemptGeneration(runDirectory: string, stageId: string): AttemptGenerationRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(runDirectory, 'stages', stageId, 'attempt_generation.json'), 'utf-8')) as AttemptGenerationRecord;
    if (parsed.version !== 1 || parsed.stageId !== stageId || !Number.isSafeInteger(parsed.attemptIndex)
      || typeof parsed.attemptStartedAt !== 'string' || !Number.isSafeInteger(parsed.segmentStart) || parsed.segmentStart < 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function projectLatestAttemptEvidence(
  runDirectory: string,
  stageId: string,
  status: StageStatus,
): SupervisorStageEvidence | undefined {
  const attempt = [...(status.attempts ?? [])].reverse().find((candidate) => (
    candidate.status === STAGE_STATUS.RUNNING
      || candidate.status === STAGE_STATUS.COMPLETE
      || candidate.status === STAGE_STATUS.FAILED
  ));
  if (!attempt) return undefined;
  const generation = readAttemptGeneration(runDirectory, stageId);
  if (!generation
    || generation.attemptIndex !== attempt.index
    || generation.attemptStartedAt !== attempt.startedAt) return undefined;
  try {
    const bytes = readFileSync(join(runDirectory, 'stages', stageId, 'live.log'));
    const segment = bytes.subarray(Math.min(bytes.length, generation.segmentStart));
    return projectSupervisorStageEvidence({
      stageId,
      attemptIndex: attempt.index,
      attemptStartedAt: attempt.startedAt,
      // Comparison is a census of the engine-held current attempt, not model
      // prompt context. Truncating to the supervisor prompt tail would make a
      // common early input read disappear for longer sibling stages.
      raw: segment.toString('utf-8'),
    });
  } catch {
    return projectSupervisorStageEvidence({
      stageId,
      attemptIndex: attempt.index,
      attemptStartedAt: attempt.startedAt,
      raw: '',
    });
  }
}

function isEnginePlaceholderMetric(path: string): boolean {
  if (!/metric\.json$/.test(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { source?: { kind?: unknown } };
    return parsed.source?.kind === 'engine_attempt_default';
  } catch {
    return false;
  }
}

/** Bind a rejection to exactly one scheduler attempt and its current evidence
 * bytes. Engine-written placeholder metrics never count as deliverables. */
export function computeSupervisorEvidenceBinding(
  runDirectory: string,
  stageId: string,
  status: StageStatus,
): SupervisorEvidenceBinding | undefined {
  const attempt = [...(status.attempts ?? [])].reverse().find((candidate) => (
    candidate.status === STAGE_STATUS.RUNNING || candidate.status === STAGE_STATUS.COMPLETE || candidate.status === STAGE_STATUS.FAILED
  ));
  if (!attempt) return undefined;
  const record = readAttemptGeneration(runDirectory, stageId);
  if (!record || record.attemptIndex !== attempt.index || record.attemptStartedAt !== attempt.startedAt) return undefined;
  const stagePath = join(runDirectory, 'stages', stageId);
  const logPath = join(stagePath, 'live.log');
  const outputPath = join(stagePath, `output_attempt_${attempt.index}.md`);
  const verdictPath = join(runDirectory, `verdict_${stageId}.json`);
  const metricPath = join(stagePath, 'metric.json');
  const hash = createHash('sha256').update(JSON.stringify(record));
  try {
    const bytes = readFileSync(logPath);
    hash.update(bytes.subarray(Math.min(record.segmentStart, bytes.length)));
  } catch { /* an empty current segment remains a valid generation */ }
  let emittedDeliverable = false;
  for (const [kind, path] of [['output', outputPath], ['verdict', verdictPath], ['metric', metricPath]] as const) {
    if (!existsSync(path) || isEnginePlaceholderMetric(path)) continue;
    try {
      const bytes = readFileSync(path);
      const fingerprint = createHash('sha256').update(bytes).digest('hex');
      if ((record.artifactBaselines?.[kind] ?? null) === fingerprint) continue;
      if (bytes.length > 0) emittedDeliverable = true;
      hash.update(path.slice(runDirectory.length)).update(bytes);
    } catch { /* ignore a file racing an atomic replacement */ }
  }
  return {
    version: 1,
    stageId,
    attemptIndex: attempt.index,
    attemptStartedAt: attempt.startedAt,
    generation: hash.digest('hex'),
    emittedDeliverable,
  };
}

export function supervisorEvidenceDigest(input: {
  tails: ReadonlyMap<string, string>;
  artifacts: readonly { path: string; content: string }[];
  anomalySignals: readonly string[];
  attemptKeys: readonly string[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    tails: [...input.tails.entries()].sort(([a], [b]) => a.localeCompare(b)),
    artifacts: [...input.artifacts].sort((a, b) => a.path.localeCompare(b.path)),
    anomalySignals: [...input.anomalySignals].sort(),
    attemptKeys: [...input.attemptKeys].sort(),
  })).digest('hex');
}

/**
 * Inspect only durable, current-attempt evidence. An output/verdict left by an
 * older attempt cannot make a new execution permanently immune to supervision.
 */
export function inspectStageExecutionFacts(input: {
  runDir: string;
  stageId: string;
  status: StageStatus;
  sinceMs: number;
  commitObserved?: boolean;
}): StageExecutionFacts {
  const attempt = currentRunningAttempt(input.status);
  const attemptStartedMs = attempt ? Date.parse(attempt.startedAt) : Number.NaN;
  const belongsToAttempt = (path: string): boolean => {
    if (!attempt || !Number.isFinite(attemptStartedMs)) return false;
    try {
      const stat = statSync(path);
      return stat.isFile() && stat.size > 0 && stat.mtimeMs >= attemptStartedMs;
    } catch {
      return false;
    }
  };
  const changedThisTick = (path: string): boolean => {
    if (!belongsToAttempt(path)) return false;
    try { return statSync(path).mtimeMs >= input.sinceMs; } catch { return false; }
  };

  const stageRoot = join(input.runDir, 'stages', input.stageId);
  const liveLogPath = join(stageRoot, 'live.log');
  const outputPath = join(stageRoot, 'output.md');
  const verdictPath = join(input.runDir, `verdict_${input.stageId}.json`);
  const handoffPath = join(input.runDir, `handoff_${input.stageId}.md`);
  const verdictObserved = belongsToAttempt(verdictPath);
  const outputObserved = belongsToAttempt(outputPath);
  const handoffObserved = belongsToAttempt(handoffPath);
  const commitObserved = input.commitObserved === true;
  let activeCommandCount = 0;
  let commandActivityValid = false;
  if (attempt) {
    try {
      const activity = JSON.parse(readFileSync(join(stageRoot, 'command_activity.json'), 'utf-8')) as Record<string, unknown>;
      const active = Array.isArray(activity.active) ? activity.active : undefined;
      const updatedAtMs = typeof activity.updatedAt === 'string' ? Date.parse(activity.updatedAt) : Number.NaN;
      commandActivityValid = activity.version === 1
        && activity.stageId === input.stageId
        && activity.attemptIndex === attempt.index
        && activity.attemptStartedAt === attempt.startedAt
        && activity.streamClosed === false
        && active !== undefined
        && Number.isFinite(updatedAtMs)
        && updatedAtMs >= attemptStartedMs;
      if (commandActivityValid) {
        activeCommandCount = active!.filter((record) => {
          if (!record || typeof record !== 'object') return false;
          const value = record as Record<string, unknown>;
          const startedAtMs = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : Number.NaN;
          return typeof value.id === 'string' && value.id.length > 0
            && Number.isFinite(startedAtMs) && startedAtMs >= attemptStartedMs;
        }).length;
      }
    } catch { /* missing/malformed activity never grants protection */ }
  }

  const internalNames = new Set([
    'live.log', 'status.json', 'input.md', 'guidance.md', 'guidance_consumed.md', 'command_activity.json',
  ]);
  let stageArtifactChanged = false;
  const walk = (dir: string, depth: number): void => {
    if (stageArtifactChanged || depth > 3) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[]; } catch { return; }
    for (const entry of entries) {
      if (internalNames.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && changedThisTick(path)) stageArtifactChanged = true;
      if (stageArtifactChanged) return;
    }
  };
  walk(stageRoot, 0);
  const liveProgressThisTick = changedThisTick(liveLogPath);
  const artifactProgressThisTick = stageArtifactChanged
    || changedThisTick(verdictPath)
    || changedThisTick(handoffPath)
    || commitObserved;
  const finalizing = outputObserved && !verdictObserved;
  const protectedFromIdleAbort = verdictObserved || handoffObserved || commitObserved || finalizing || activeCommandCount > 0;
  return {
    stageId: input.stageId,
    attemptIndex: attempt?.index,
    attemptStartedAt: attempt?.startedAt,
    verdictObserved,
    outputObserved,
    handoffObserved,
    commitObserved,
    liveProgressThisTick,
    artifactProgressThisTick,
    activeCommandCount,
    commandActivityValid,
    finalizing,
    protectedFromIdleAbort,
  };
}

export function describeStageExecutionFacts(facts: StageExecutionFacts): string {
  const attempt = facts.attemptIndex === undefined ? 'no active attempt observed' : `active attempt ${facts.attemptIndex}`;
  return [
    attempt,
    facts.verdictObserved ? 'verdict observed' : 'no verdict observed',
    facts.outputObserved ? 'final output observed' : 'no final output observed',
    facts.handoffObserved ? 'handoff observed' : 'no handoff observed',
    facts.commitObserved ? 'commit observed' : 'no current-attempt commit observed',
    facts.activeCommandCount > 0
      ? `${facts.activeCommandCount} active command${facts.activeCommandCount === 1 ? '' : 's'} observed`
      : facts.commandActivityValid ? 'no active command observed' : 'no valid command activity record',
    facts.liveProgressThisTick ? 'live output changed during verification' : 'no live-output change during verification',
    facts.finalizing ? 'finalization window active' : 'finalization window inactive',
  ].join('; ');
}

export function buildSupervisorSystemPrompt(stuckThresholdMs: number): string {
  const stuckMinutes = Math.max(1, Math.round(stuckThresholdMs / 60_000));
  const verdictUnion = SUPERVISOR_VERDICTS.map((v) => v.id).join('|');
  const verdictList = SUPERVISOR_VERDICTS.map((v) => `- ${v.id}: ${v.description}`).join('\n');
  return `You are a workflow supervisor monitoring agent progress toward a goal.
Analyze the running stages below and respond with exactly ONE JSON object.
Do NOT explain your reasoning — output ONLY the JSON.

Format: {"verdict":"${verdictUnion}","target_stage":"<stage_id or null>","reason":"<1 sentence>","guidance":"<instruction if GUIDE, else null>","direction_key":"<stable lower_snake_case key for one concrete wrong direction, else null>","evidence_ids":["<exact evidence id>"] ,"supersedes_assessment_id":"<exact prior assessment id or null>"}

Verdicts:
${verdictList}

Rules:
- Default to WAIT when agents are making progress toward the goal.
- GUIDE only when you see a concrete wrong direction (not just slow progress).
- REJECT only when an EMITTED deliverable contradicts its OWN declared work or acceptance criteria — e.g. a gate verdict says pass:true while the evidence/metric it cites shows fail, a stage claims it produced an artifact that is missing or empty, or a result codifies a smoke/error as success. Set "target_stage" to that stage; "reason" must name the specific contradiction (what was claimed vs what the evidence shows). REJECT forces the work to be re-done — it is NOT for slow progress (use WAIT) or a wrong overall approach (use REPLAN). CRITICAL GUARD: an HONEST NEGATIVE is a VALID deliverable, not a rejection — do NOT REJECT a result simply because the target metric was not beaten, the hypothesis failed, or the run found no improvement. Only REJECT when the deliverable itself is internally inconsistent or does not actually do the work it declares.
- DONE only when the ORIGINAL GOAL (stated at the top of this prompt) is fully satisfied — not when an intermediate stage passes its own tests. A stage's tests passing means that STAGE succeeded, not that the overall goal is met. Only signal DONE if you see evidence that ALL acceptance criteria from the original goal are achieved (e.g., final QA gate passes, target metric exceeded, all deliverables confirmed). For exploration/research tasks where the goal is to improve a metric, NEVER signal DONE just because code compiles or intermediate tests pass.
- ABORT only in either of these cases: (1) a stage has made no real progress for ${stuckMinutes}+ minutes and is truly stuck, or (2) the same concrete wrong direction continues after repeated GUIDE decisions. Active or high-volume output is not proof that the direction is correct and must not prevent case (2) from escalating to ABORT. Note: codex agents often edit files silently via tool calls without printing to stdout; do NOT infer case (1) from stdout silence alone if you can see file/artifact activity in the snapshot.
- For every GUIDE, set direction_key to a short lower_snake_case identity for the concrete wrong direction. For ABORT case (2), reuse that exact key only when the evidence produced after each correction still shows the same direction. Set direction_key to null for idle ABORT and every other verdict.
- Evidence rows marked ACTION can establish what a stage said or did. Rows marked INSPECTION are read-only commands, text the stage read, or tool output it received; they remain context, but cannot establish that the stage pursued the content. Every GUIDE, direction-based ABORT, and REPLAN must name the exact current ACTION rows it relies on in evidence_ids, and its reason or direction_key must repeat at least one concrete term from those rows. Do not cite an adjacent action for a claim found only in inspection output. Idle ABORT, WAIT, REJECT, and DONE may use an empty array.
- If this assessment explicitly retracts or replaces one prior assessment, copy that assessment's exact id into supersedes_assessment_id. Otherwise use null.
- Treat the verified stage-facts line as authoritative. \`output.md\` is not a verdict: say a verdict exists only when the facts explicitly say "verdict observed". Never ABORT during a stated finalization window; the stage timeout remains the outer bound.
- Do not ABORT slow but correct work, ordinary progress, or an honestly reported negative result.
- Keep "reason" to one sentence. Keep "guidance" to 1-2 sentences max.`;
}

export function buildSupervisorRolePrompt(stuckThresholdMs: number, taskDescription: string): string {
  return `${buildSupervisorSystemPrompt(stuckThresholdMs)}\n\n# Original Goal\n${taskDescription}`;
}

export type SupervisorAssessmentTrigger = 'event' | 'none';

export function selectSupervisorAssessmentTrigger(input: {
  deterministicEvents?: readonly SupervisorEvent[];
  /** Legacy clock/counter inputs remain accepted for replay compatibility only. */
  anomalySignals?: string[];
  runningStageCount?: number;
  accumulatedOutputBytes?: number;
  minDeltaBytes?: number;
  now?: number;
  lastRoutineAssessmentAt?: number;
  routineAssessmentIntervalMs?: number;
  routineAssessmentsThisIteration?: number;
  maxRoutineAssessmentsPerIteration?: number;
  cooldownUntil?: number;
}): SupervisorAssessmentTrigger {
  return (input.deterministicEvents?.length ?? 0) > 0 ? 'event' : 'none';
}

function artifactShowsFailedGate(artifact: { path: string; content: string }): boolean {
  if (!/(^|\/)verdict(?:[_.][^/]*)?\.json$/i.test(artifact.path)) return false;
  try {
    const parsed = JSON.parse(artifact.content) as { pass?: unknown };
    return parsed.pass === false;
  } catch { return false; }
}

/** Stable signal ids let the heartbeat edge-trigger anomalies instead of spamming every 30s. */
export function detectSupervisorAnomalySignals(input: {
  state: StoreState;
  stageTransitionFingerprint?: string;
  stalledStageIds?: string[];
  recentArtifacts?: Array<{ path: string; content: string }>;
  userInput?: string | null;
  pendingApprovalFingerprint?: string;
}): string[] {
  const signals: string[] = [];
  if (input.stageTransitionFingerprint) signals.push(`stage_transition:${input.stageTransitionFingerprint}`);
  for (const stageId of input.stalledStageIds ?? []) signals.push(`stalled:${stageId}`);
  if (input.userInput) signals.push(`user_input:${input.userInput.slice(0, 120)}`);
  if (input.pendingApprovalFingerprint) signals.push(`pending_approval:${input.pendingApprovalFingerprint}`);
  for (const artifact of input.recentArtifacts ?? []) {
    if (artifactShowsFailedGate(artifact)) signals.push(`gate_failed:${artifact.path}:${artifact.content.slice(0, 160)}`);
  }
  for (const [stageId, status] of Object.entries(input.state.stages)) {
    const failedAttempts = (status.attempts ?? []).filter((attempt) => attempt.status === STAGE_STATUS.FAILED).length;
    if (failedAttempts >= 2) signals.push(`repeated_failure:${stageId}:${failedAttempts}`);
  }
  if (input.state.campaignAlert?.type === 'plateau') {
    signals.push(`metric_plateau:${input.state.campaignAlert.triggeredAt}`);
  }
  const budget = input.state.budget;
  if (budget) {
    const tokenRatio = budget.totalTokens && budget.totalTokens > 0 ? (budget.usedTokens ?? 0) / budget.totalTokens : 0;
    const timeRatio = budget.totalTimeMs && budget.totalTimeMs > 0 ? (budget.usedTimeMs ?? 0) / budget.totalTimeMs : 0;
    if (Math.max(tokenRatio, timeRatio) >= 0.9) signals.push(`budget_near_exhaustion:${Math.max(tokenRatio, timeRatio).toFixed(3)}`);
  }
  if (isAwaitingApprovalRunStatus(input.state.status) || isPausedRunStatus(input.state.status)) {
    signals.push(`pending_approval_state:${input.state.status}`);
  }
  return [...new Set(signals)];
}

export class Supervisor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private byteOffsets = new Map<string, number>();
  private attemptEvidenceKeys = new Map<string, string>();
  private attemptSegmentFloors = new Map<string, number>();
  private stageEvidenceDigests = new Map<string, string>();
  private lastActionTime = 0;
  private assessmentCount = 0;
  /** Consecutive failed assessments (null returns from assess()). After a
   * threshold, the supervisor writes a visible `supervisor_degraded.json`
   * signal instead of silently producing zero ticks (the Phase E failure mode,
   * where a JSON-parse bug made the supervisor silently dead for a whole run). */
  private consecutiveAssessFailures = 0;
  private static readonly DEGRADED_AFTER_FAILURES = 3;
  private tickCount = 0;
  private actions: SupervisorAction[] = [];
  private stopped = false;
  private startTime = Date.now();
  private decisions: string[] = [];
  private deliverables: string[] = [];
  private observations: string[] = [];
  private knownStages = new Set<string>();
  private completedStages = new Map<string, { role: string; duration: number }>();
  private lastState: StoreState | null = null;
  private usage: SupervisorUsage | null = null;
  private eventCursor = new SupervisorEventCursor();
  private runEventCursor = 0;

  constructor(
    private projectDir: string,
    private runId: string,
    private adapter: Adapter,
    private config: SupervisorConfig,
    private taskDescription: string,
  ) {}

  // Heartbeats stay cheap and fixed-rate. They collect deterministic events;
  // only an event dequeued from eventCursor authorizes a model call.
  private effectivePollIntervalMs: number = 0;
  private consecutiveWaits = 0;
  private prevStageStatusSnapshot: Record<string, string> = {};
  private accumulatedOutputBytes = 0;
  private pendingTails = new Map<string, string>();
  private pendingArtifacts = new Map<string, { path: string; content: string }>();
  // Per-iteration count remains visible as a quantity, but never authorizes a call.
  private lastSeenIteration = 0;
  private iterationAssessmentCount = 0;
  // GAP-2 watchdog: last-progress timestamp per running stage (carried across ticks).
  private stageLastProgressMs: Record<string, number> = {};
  // Idempotency is attempt-scoped, so an immediate same-name rerun remains supervisable.
  private watchdogAbortedStages = new Set<string>();
  private watchdogAttemptKeys: Record<string, string> = {};
  // Cursor for stage-attributed durable artifact checks (independent of the LLM scan).
  private watchdogLastArtifactCheckMs = 0;

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.effectivePollIntervalMs = this.config.pollIntervalMs;
    const startedAt = new Date().toISOString();
    this.restoreEventState();
    try {
      const state = readRunState(this.projectDir, this.runId);
      const prior = state.supervisor;
      if (prior) {
        const snapshot = this.eventCursor.snapshot();
        this.eventCursor = new SupervisorEventCursor({
          seenEventIds: [
            ...snapshot.seenEventIds,
            ...prior.attempts.flatMap((attempt) => attempt.trigger?.eventId ? [attempt.trigger.eventId] : []),
          ],
          pendingEvents: snapshot.pendingEvents,
        });
      }
      this.usage = prior ? {
        ...prior,
        status: 'running',
        completedAt: undefined,
        attempts: [...prior.attempts],
      } : {
        status: 'running',
        calls: 0,
        tokens_in: 0,
        tokens_out: 0,
        duration_ms: 0,
        startedAt,
        attempts: [],
      };
      this.assessmentCount = this.usage.calls;
      this.startTime = Date.parse(this.usage.startedAt) || Date.now();
      this.persistUsage();
    } catch { /* run state may not be initialized yet */ }
    const logPath = this.logPath();
    mkdirSync(join(this.runDir(), 'signals'), { recursive: true });
    appendFileSync(logPath, `# Supervisor Log\n\nGoal: ${this.taskDescription.slice(0, 200)}\nStarted: ${startedAt}\nConfig: heartbeat=${this.config.pollIntervalMs}ms, assessment-mode=deterministic-events, model=${this.config.model}, legacy-routine=${this.config.routineAssessmentIntervalMs}ms, legacy-max/iter=${this.config.maxAssessmentsPerIteration}\n\n`);
    log.info({ runId: this.runId }, 'Supervisor started');
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch(err => log.error(err, 'Supervisor tick error'))
        .finally(() => this.scheduleNextTick());
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Re-read final state for accurate progress report
    try {
      const finalState = readRunState(this.projectDir, this.runId);
      this.trackMilestones(finalState);
    } catch { /* ignore */ }
    if (this.usage) {
      this.usage.status = STAGE_STATUS.COMPLETE;
      this.usage.completedAt = new Date().toISOString();
      this.persistUsage();
    }
    appendFileSync(this.logPath(), `\n---\nSupervisor stopped: ${new Date().toISOString()}, ${this.assessmentCount} assessments made.\n`);
    this.writeProgress();
    log.info({ runId: this.runId, assessments: this.assessmentCount }, 'Supervisor stopped');
  }

  private persistUsage(): void {
    if (!this.usage) return;
    const usage: SupervisorUsage = {
      ...this.usage,
      attempts: [...this.usage.attempts],
    };
    try {
      const dir = stageDir(this.projectDir, this.runId, '_supervisor');
      mkdirSync(dir, { recursive: true });
      atomicWrite(join(dir, 'status.json'), JSON.stringify(usage, null, 2));
    } catch { /* non-critical */ }
    try {
      updateRunState(this.projectDir, this.runId, (state) => { state.supervisor = usage; });
    } catch { /* non-critical */ }
    // Summaries are normally generated just before the scheduler's finally
    // block stops the supervisor. Refresh only the deterministic usage line
    // here so the final call cannot remain invisible (and do not trigger a
    // second, costly summary-model invocation).
    if (usage.status === STAGE_STATUS.COMPLETE) this.refreshSummaryUsage(usage);
  }

  private refreshSummaryUsage(usage: SupervisorUsage): void {
    const summaryPath = join(this.runDir(), 'summary.md');
    if (!existsSync(summaryPath)) return;
    try {
      const tokensTotal = usage.tokens_in + usage.tokens_out;
      const line = `- _supervisor: ${usage.calls} calls, ${Math.round(usage.duration_ms / 1000)}s cumulative, ${tokensTotal} tokens total (${usage.tokens_in} in + ${usage.tokens_out} out)`;
      let summary = readFileSync(summaryPath, 'utf-8');
      if (/^- _supervisor:.*$/m.test(summary)) {
        summary = summary.replace(/^- _supervisor:.*$/m, line);
      } else if (/^## Stages\s*$/m.test(summary)) {
        summary = summary.replace(/^## Stages\s*$/m, (heading) => `${heading}\n${line}`);
      } else {
        summary = `${summary.trimEnd()}\n\n## Stages\n${line}\n`;
      }
      atomicWrite(summaryPath, summary);
    } catch { /* non-critical observability refresh */ }
  }

  private recordAssessmentUsage(
    startedAt: string,
    result: RunResult | undefined,
    verdict: SupervisorAssessment | null,
    trigger: SupervisorEvent,
    error?: string,
  ): void {
    if (!this.usage) {
      this.usage = {
        status: 'running', calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0,
        startedAt, attempts: [],
      };
    }
    const completedAt = new Date().toISOString();
    const durationMs = typeof result?.duration_ms === 'number'
      ? result.duration_ms
      : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
    const exitCode = result?.exitCode ?? 1;
    const attempt: SupervisorAttempt = {
      index: this.usage.attempts.length + 1,
      startedAt,
      completedAt,
      status: exitCode === 0 && verdict ? 'complete' : 'failed',
      duration_ms: durationMs,
      exitCode,
      tokens_in: result?.tokens_in,
      tokens_out: result?.tokens_out,
      trigger,
      ...(verdict ? {
        unverifiedAssessment: {
          verdict: verdict.verdict,
          targetStage: verdict.targetStage,
          reason: verdict.reason,
        },
      } : {}),
      error,
    };
    this.usage.attempts.push(attempt);
    this.usage.calls = this.usage.attempts.length;
    this.usage.tokens_in += result?.tokens_in ?? 0;
    this.usage.tokens_out += result?.tokens_out ?? 0;
    this.usage.duration_ms += durationMs;
    this.assessmentCount = this.usage.calls;
    try {
      appendTraceEvent(this.projectDir, this.runId, '_supervisor', {
        timestamp: completedAt,
        stageId: '_supervisor',
        type: 'llm_call',
        inputSummary: `Supervisor semantic assessment triggered by ${trigger.type} (${trigger.eventId})`,
        outputSummary: verdict
          ? `Unverified model assessment — ${verdict.verdict}: ${verdict.reason}`
          : (error ?? `exit ${exitCode}`),
        tokensIn: result?.tokens_in,
        tokensOut: result?.tokens_out,
        durationMs,
      });
    } catch { /* non-critical */ }
    this.persistUsage();
  }

  private recordEffectiveAssessment(assessment: SupervisorAssessment): void {
    const attempt = this.usage?.attempts.at(-1);
    if (!attempt || attempt.status !== STAGE_STATUS.COMPLETE || !attempt.unverifiedAssessment) return;
    attempt.verdict = assessment.verdict;
    attempt.effectiveReason = assessment.reason;
    this.persistUsage();
  }

  private writeProgress(): void {
    const state = this.lastState;
    const elapsed = operationalDuration(Date.now() - this.startTime);
    const status = state?.status ?? 'unknown';
    const iteration = state?.currentIteration ?? 1;
    const maxIter = state?.maxIterations ?? '?';
    const retries = this.actions.filter(a => a.assessment.verdict !== 'WAIT').length;

    // No Goal section — page header / tab title already show the task name,
    // and the full brief is one click away. Repeating 300 chars of Goal here
    // pushes the actually-actionable Outcome below the fold.
    const lines: string[] = [
      `# Run: ${this.runId}`,
      '',
    ];

    // Outcome first — single most actionable line. Read this and you know
    // whether you need to do anything.
    const statusResolution = resolveRunStatus(status);
    const outcomeLabel = statusResolution.kind === 'known'
      ? SUPERVISOR_PROGRESS_OUTCOME_LABELS[statusResolution.status]
      : `Unrecognized status ${statusResolution.display}`;
    lines.push('## Outcome');
    lines.push(`${outcomeLabel} (${elapsed}, iteration ${iteration}/${maxIter}, ${retries} supervisor interventions)`);
    lines.push('');

    lines.push('## Current work');
    const running = Object.entries(state?.stages ?? {})
      .flatMap(([stageId, stage]) => {
        if (!isRunningStageStatus(stage.status)) return [];
        const execution = currentRunningAttempt(stage);
        const startedAt = execution ? Date.parse(execution.startedAt) : NaN;
        const runningFor = Number.isFinite(startedAt) ? operationalDuration(Date.now() - startedAt) : 'unknown duration';
        return [`- ${stageId}: execution ${execution?.index ?? '?'} · ${runningFor}`];
      });
    lines.push(...(running.length > 0 ? running : ['- No stage is executing.']));
    lines.push('');

    if (this.decisions.length > 0) {
      lines.push('## What was decided');
      for (const d of this.decisions) lines.push(`- ${d}`);
      lines.push('');
    }

    // Deliverables: don't dump every artifact path (a single run with images +
    // keyframes can produce 100+ paths and turn this section into a wall of
    // text). Show artifact count per stage, surface the final_package path if
    // one is present, and cap individual entries to a readable preview.
    if (this.deliverables.length > 0) {
      lines.push('## What was delivered');
      let finalPackagePath: string | null = null;
      for (const d of this.deliverables) {
        const colon = d.indexOf(':');
        const stageId = colon > 0 ? d.slice(0, colon).trim() : d;
        const rest = colon > 0 ? d.slice(colon + 1).trim() : '';
        const items = rest ? rest.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!finalPackagePath) {
          const fp = items.find(p => /\/final_package(?:\/|$)/.test(p));
          if (fp) finalPackagePath = fp.split('/final_package')[0] + '/final_package';
        }
        if (items.length === 0) {
          lines.push(`- ${stageId}: (no artifacts)`);
        } else if (items.length === 1) {
          lines.push(`- ${stageId}: ${items[0]}`);
        } else {
          lines.push(`- ${stageId}: ${items.length} artifacts (e.g. ${items[0]})`);
        }
      }
      if (finalPackagePath) {
        lines.push(`- final_package: ${finalPackagePath}`);
      }
      lines.push('');
    }

    // Observations: only keep the recent non-WAIT verdicts and user-guidance
    // events. Per-tick WAIT reasons ("stage still making progress") are noise
    // here — they're already visible in the SupervisorPane action list. The
    // tag convention in act(): WAIT pushes a bare reason, non-WAIT pushes
    // "VERDICT: reason"; user input pushes "User guidance received: ...".
    if (this.observations.length > 0) {
      const noteworthy = this.observations.filter(o =>
        /^(GUIDE|ABORT|REPLAN|REJECT|DONE):/.test(o) || o.startsWith('User guidance received:'),
      );
      const recent = noteworthy.slice(-5);
      if (recent.length > 0) {
        lines.push('## Notable supervisor events');
        for (const o of recent) lines.push(`- ${o}`);
        lines.push('');
      }
    }

    writeFileSync(this.progressPath(), lines.join('\n'), 'utf-8');
    this.writeSupervisorState();
  }

  private progressPath(): string {
    return join(this.runDir(), 'progress.md');
  }

  /**
   * Structured state for the dashboard UI to render the supervisor activity pane.
   * Refreshed on every assessment, on idle ticks, and at stop. Keeps last 30 actions.
   */
  private writeSupervisorState(): void {
    const path = join(this.runDir(), 'supervisor_state.json');
    const payload = {
      runId: this.runId,
      startedAt: new Date(this.startTime).toISOString(),
      stoppedAt: this.stopped ? new Date().toISOString() : null,
      assessmentCount: this.assessmentCount,
      iterationAssessmentCount: this.iterationAssessmentCount,
      maxAssessmentsPerIteration: this.config.maxAssessmentsPerIteration,
      currentIteration: this.lastSeenIteration,
      basePollIntervalMs: this.config.pollIntervalMs,
      routineAssessmentIntervalMs: this.config.routineAssessmentIntervalMs,
      effectivePollIntervalMs: this.effectivePollIntervalMs,
      consecutiveWaits: this.consecutiveWaits,
      tickCount: this.tickCount,
      tokensIn: this.usage?.tokens_in ?? 0,
      tokensOut: this.usage?.tokens_out ?? 0,
      assessmentDurationMs: this.usage?.duration_ms ?? 0,
      runEventCursor: this.runEventCursor,
      eventCursor: this.eventCursor.snapshot(),
      stageStatusSnapshot: this.prevStageStatusSnapshot,
      actions: this.actions.slice(-30).map(a => ({
        tick: a.tick,
        timestamp: a.timestamp,
        runningStages: a.runningStages,
        verdict: a.assessment.verdict,
        targetStage: a.assessment.targetStage,
        reason: a.assessment.reason,
        guidance: a.assessment.guidance,
        directionKey: a.assessment.directionKey,
        assessmentId: a.assessment.assessmentId,
        assessedAt: a.assessment.assessedAt,
        evidenceIds: a.assessment.evidenceIds,
        supersedesAssessmentId: a.assessment.supersedesAssessmentId,
        guidanceId: a.assessment.guidanceId,
        directionEvidence: a.directionEvidence,
        targetAttemptIndex: a.targetAttemptIndex,
        source: a.source,
        trigger: a.trigger,
      })),
    };
    try { writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8'); } catch { /* non-critical */ }
  }

  private restoreEventState(): void {
    try {
      const parsed = JSON.parse(readFileSync(join(this.runDir(), 'supervisor_state.json'), 'utf-8')) as {
        runEventCursor?: unknown;
        eventCursor?: Partial<SupervisorEventCursorSnapshot>;
        stageStatusSnapshot?: unknown;
      };
      if (Number.isSafeInteger(parsed.runEventCursor) && Number(parsed.runEventCursor) >= 0) {
        this.runEventCursor = Number(parsed.runEventCursor);
      }
      if (parsed.eventCursor) this.eventCursor = new SupervisorEventCursor(parsed.eventCursor);
      if (parsed.stageStatusSnapshot && typeof parsed.stageStatusSnapshot === 'object') {
        this.prevStageStatusSnapshot = Object.fromEntries(
          Object.entries(parsed.stageStatusSnapshot as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
      }
    } catch { /* first start or legacy state */ }
  }

  private readUserInput(): string | null {
    const inputPath = join(this.runDir(), 'user_input.md');
    if (!existsSync(inputPath)) return null;
    try {
      const content = readFileSync(inputPath, 'utf-8').trim();
      unlinkSync(inputPath); // consume it
      if (content) return content;
    } catch { /* ignore */ }
    return null;
  }

  private trackMilestones(state: StoreState): void {
    this.lastState = state;

    // Detect new stages starting
    for (const [id, ss] of Object.entries(state.stages)) {
      if (isRunningStageStatus(ss.status) && !this.knownStages.has(id)) {
        this.knownStages.add(id);
      }
      // Detect stage completions
      if (isSettledStageStatus(ss.status) && !this.completedStages.has(id)) {
        const duration = ss.duration_ms ? Math.round(ss.duration_ms / 1000) : 0;
        this.completedStages.set(id, { role: '', duration });

        if (ss.status === STAGE_STATUS.COMPLETE) {
          // Check for deliverables (artifacts)
          if (ss.artifacts && ss.artifacts.length > 0) {
            this.deliverables.push(`${id}: ${ss.artifacts.join(', ')}`);
          }
        }
      }
    }

    // Detect dispatch decisions
    if (state.dispatchedStages && Array.isArray(state.dispatchedStages)) {
      const dispatched = state.dispatchedStages as unknown[];
      const dispatchCount = dispatched.length;
      const stageNames = dispatched.map((s) => (s && typeof s === 'object' && 'id' in s ? (s as { id: string }).id : 'unknown')).join(', ');
      const decision = `Planner dispatched ${dispatchCount} stages: ${stageNames}`;
      if (!this.decisions.includes(decision)) {
        this.decisions.push(decision);
      }
    }
  }

  private runDir(): string {
    return getRunDirPath(this.projectDir, this.runId);
  }

  private logPath(): string {
    return join(this.runDir(), 'supervisor_log.md');
  }

  private signalDir(): string {
    return join(this.runDir(), 'signals');
  }

  private pendingApprovalFingerprint(): string | undefined {
    const stagesRoot = join(this.runDir(), 'stages');
    try {
      const found: string[] = [];
      for (const stageId of readdirSync(stagesRoot)) {
        const path = join(stagesRoot, stageId, 'approval_request.json');
        if (!existsSync(path)) continue;
        const stat = statSync(path);
        found.push(`${stageId}:${stat.mtimeMs}`);
      }
      return found.sort().join('|') || undefined;
    } catch {
      return undefined;
    }
  }

  private readProjectCommit(): ProjectCommitFact | undefined {
    try {
      const output = execFileSync('git', ['show', '-s', '--format=%H%x00%cI', 'HEAD'], {
        cwd: this.projectDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      const [hash, committedAt] = output.split('\0');
      const committedAtMs = Date.parse(committedAt);
      if (!/^[0-9a-f]{7,40}$/i.test(hash) || !Number.isFinite(committedAtMs)) return undefined;
      return { hash, committedAtMs };
    } catch {
      return undefined;
    }
  }

  private inspectFacts(
    stageId: string,
    status: StageStatus,
    sinceMs: number,
    baseCommit?: string,
    projectCommit = this.readProjectCommit(),
  ): StageExecutionFacts {
    const attempt = currentRunningAttempt(status);
    const attemptStartedMs = attempt ? Date.parse(attempt.startedAt) : Number.NaN;
    const commitObserved = Boolean(
      attempt
      && projectCommit
      && projectCommit.hash !== baseCommit
      && Number.isFinite(attemptStartedMs)
      // Git commit timestamps have one-second precision; tolerate that
      // truncation when the commit and attempt start share a second.
      && projectCommit.committedAtMs + 999 >= attemptStartedMs,
    );
    return inspectStageExecutionFacts({
      runDir: this.runDir(),
      stageId,
      status,
      sinceMs,
      commitObserved,
    });
  }

  private bindDirectionEvidence(
    stageId: string,
    status: StageStatus,
  ): DirectionEvidenceBinding | undefined {
    const attempt = currentRunningAttempt(status);
    if (!attempt) return undefined;
    const generation = createHash('sha256').update(JSON.stringify({
      stageId,
      attemptIndex: attempt.index,
      attemptStartedAt: attempt.startedAt,
      liveEvidence: this.stageEvidenceDigests.get(stageId) ?? null,
      lastProgressMs: this.stageLastProgressMs[stageId] ?? null,
    })).digest('hex');
    return {
      version: 1,
      stageId,
      attemptIndex: attempt.index,
      attemptStartedAt: attempt.startedAt,
      generation,
    };
  }

  private authoritativeStageStatus(stageId: string, fallback: StageStatus): StageStatus {
    try { return readStageStatus(this.projectDir, this.runId, stageId); } catch { return fallback; }
  }

  private activeAttemptQuantities(
    state: StoreState,
    runningStages: readonly string[],
    now: number,
  ): SupervisorEventQuantities['activeAttempts'] {
    return runningStages.flatMap((stageId) => {
      const attempt = currentRunningAttempt(state.stages[stageId]);
      if (!attempt) return [];
      const attemptStartedMs = Date.parse(attempt.startedAt);
      const base = {
        stageId,
        attemptIndex: attempt.index,
        attemptStartedAt: attempt.startedAt,
        elapsedMs: Number.isFinite(attemptStartedMs) ? Math.max(0, now - attemptStartedMs) : 0,
      };
      const ledgerPath = join(
        this.runDir(),
        'stages',
        stageId,
        `attempt_deadline_execution_${attempt.index}_budget.jsonl`,
      );
      try {
        const created = readFileSync(ledgerPath, 'utf-8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((entry) => entry.type === 'attempt_deadline_created');
        const deadlineAt = typeof created?.deadlineAt === 'string' ? created.deadlineAt : undefined;
        const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
        if (deadlineAt && Number.isFinite(deadlineMs)) {
          return [{ ...base, deadlineAt, remainingMs: Math.max(0, deadlineMs - now) }];
        }
      } catch { /* the status-backed active-attempt facts remain usable */ }
      return [base];
    });
  }

  private eventQuantities(
    state: StoreState,
    runningStages: readonly string[],
    now: number,
  ): SupervisorEventQuantities {
    let gateRetryMaximum = Math.max(0, Math.floor(state.maxRetries ?? 0));
    let supervisorRejectMaximum = 0;
    // Reading a project's existing defaults is safe. Do not cause a supervisor
    // heartbeat to scaffold configuration in projects that do not have it.
    if (existsSync(join(this.projectDir, 'config', 'defaults.yaml'))) {
      try {
        const defaults = loadProjectDefaults(this.projectDir);
        gateRetryMaximum = Math.max(0, Math.floor(state.maxRetries ?? defaults.gate_retry_loops));
        supervisorRejectMaximum = Math.max(0, Math.floor(defaults.supervisor_max_rejects));
      } catch { /* zero/explicit state quantities fail closed and remain visible */ }
    }
    const maximum = Math.max(0, Math.floor(this.config.maxAssessmentsPerIteration));
    const changedPaths = new Set([...this.pendingTails.keys(), ...this.pendingArtifacts.keys()]);
    return {
      iteration: state.currentIteration ?? 1,
      runningStageCount: runningStages.length,
      activeAttempts: this.activeAttemptQuantities(state, runningStages, now),
      minArtifactDeltaBytes: this.config.minDeltaBytes,
      deadlineMarginMs: resolveSupervisorDeadlineMarginMs(this.config.pollIntervalMs),
      pollIntervalMs: this.config.pollIntervalMs,
      changedBytes: this.accumulatedOutputBytes,
      changedPathCount: changedPaths.size,
      supervisorAssessmentBudget: {
        used: this.iterationAssessmentCount,
        maximum,
        remaining: Math.max(0, maximum - this.iterationAssessmentCount),
      },
      supervisorRejectBudget: { maximum: supervisorRejectMaximum },
      gateRetryBudget: { maximum: gateRetryMaximum },
    };
  }

  private readNewRunEvents(): RunEvent[] {
    const events = readRunEvents(this.projectDir, this.runId);
    if (this.runEventCursor > events.length) this.runEventCursor = 0;
    const next = events.slice(this.runEventCursor);
    this.runEventCursor = events.length;
    return next;
  }

  private eventCandidates(input: {
    state: StoreState;
    runningStages: string[];
    transitionParts: string[];
    recentArtifacts: Array<{ path: string; content: string }>;
    userInput: string | null;
    now: number;
  }): SupervisorEventCandidate[] {
    const { state, runningStages, transitionParts, recentArtifacts, userInput, now } = input;
    const observedAt = new Date(now).toISOString();
    const quantities = this.eventQuantities(state, runningStages, now);
    const candidates: SupervisorEventCandidate[] = [];
    const newRunEvents = this.readNewRunEvents();
    const gateArtifactsFromEvents = new Set<string>();
    let operatorGuidanceRecorded = false;

    for (const event of newRunEvents) {
      const common = {
        observedAt: event.timestamp,
        ...(event.stageId ? { stageId: event.stageId } : {}),
        quantities,
      };
      if (event.type === 'scope_revision_requested') {
        candidates.push({
          ...common,
          type: 'scope_request',
          source: 'run_event:scope_revision_requested',
          fingerprint: {
            requestId: event.requestId,
            stageId: event.stageId,
            attemptIndex: event.attemptIndex,
            timestamp: event.timestamp,
          },
          quantities: {
            ...quantities,
            scopeRequestId: event.requestId,
            scopeRequestAttemptIndex: event.attemptIndex,
          },
        });
      } else if (event.type === 'guidance_written' && event.source !== 'supervisor') {
        operatorGuidanceRecorded ||= event.source === 'operator';
        candidates.push({
          ...common,
          type: 'guidance_arrival',
          source: 'run_event:guidance_written',
          fingerprint: {
            source: event.source,
            stageId: event.stageId,
            timestamp: event.timestamp,
            detailDigest: createHash('sha256').update(event.detail ?? '').digest('hex'),
          },
          quantities: {
            ...quantities,
            guidanceSource: event.source,
            guidanceTargetStage: event.stageId ?? RUN_WIDE_GUIDANCE_TARGET,
          },
        });
      } else if (event.type === 'verdict_written') {
        for (const artifact of event.artifacts ?? []) gateArtifactsFromEvents.add(artifact);
        candidates.push({
          ...common,
          type: 'gate_verdict',
          source: 'run_event:verdict_written',
          fingerprint: {
            stageId: event.stageId,
            artifacts: [...(event.artifacts ?? [])].sort(),
            timestamp: event.timestamp,
          },
          quantities: {
            ...quantities,
            gateStageId: event.stageId,
            gateArtifacts: [...(event.artifacts ?? [])].sort(),
          },
        });
      } else if (
        event.type === 'attempt_failed'
        && (
          event.adapterFailure === true
          || /adapter(?: connection)? (?:failed|failure|error)|connection (?:failed|failure|error)/i.test(event.detail ?? '')
        )
      ) {
        candidates.push({
          ...common,
          type: 'adapter_failure',
          source: 'run_event:attempt_failed',
          fingerprint: {
            stageId: event.stageId,
            attemptIndex: event.attemptIndex,
            attemptStartedAt: event.attemptStartedAt,
            timestamp: event.timestamp,
          },
          quantities: {
            ...quantities,
            failedAttemptIndex: event.attemptIndex,
            failedExitCode: event.exitCode,
            failureDetail: event.detail,
          },
        });
      }
    }

    if (transitionParts.length > 0) {
      const transitionedStageIds = transitionParts.map((transition) => transition.split(':', 1)[0]);
      candidates.push({
        type: 'stage_transition',
        observedAt,
        source: 'run_state',
        fingerprint: {
          iteration: state.currentIteration ?? 1,
          transitions: [...transitionParts].sort(),
          executions: transitionedStageIds.map((stageId) => {
            const status = state.stages[stageId];
            const attempt = status?.attempts?.at(-1);
            return {
              stageId,
              status: status?.status ?? 'absent',
              retries: status?.retries,
              attemptIndex: attempt?.index,
              attemptStartedAt: attempt?.startedAt,
              attemptCompletedAt: attempt?.completedAt,
            };
          }),
        },
        quantities: { ...quantities, transitions: [...transitionParts].sort() },
      });
    }
    if (userInput && !operatorGuidanceRecorded) {
      candidates.push({
        type: 'guidance_arrival',
        observedAt,
        source: 'operator_input_fallback',
        fingerprint: {
          observedAt,
          contentDigest: createHash('sha256').update(userInput).digest('hex'),
        },
        quantities: {
          ...quantities,
          guidanceSource: 'operator',
          guidanceTargetStage: null,
        },
      });
    }
    for (const artifact of recentArtifacts) {
      if (!/(^|\/)verdict(?:[_.][^/]*)?\.json$/i.test(artifact.path)) continue;
      if (gateArtifactsFromEvents.has(artifact.path)) continue;
      candidates.push({
        type: 'gate_verdict',
        observedAt,
        source: 'artifact_scan',
        fingerprint: {
          path: artifact.path,
          contentDigest: createHash('sha256').update(artifact.content).digest('hex'),
        },
        quantities: {
          ...quantities,
          gateArtifacts: [artifact.path],
          gatePass: (() => {
            try { return (JSON.parse(artifact.content) as { pass?: unknown }).pass; }
            catch { return undefined; }
          })(),
        },
      });
    }
    if (quantities.changedBytes >= quantities.minArtifactDeltaBytes) {
      candidates.push({
        type: 'artifact_change',
        observedAt,
        source: 'bounded_evidence_scan',
        fingerprint: {
          paths: [...new Set([...this.pendingTails.keys(), ...this.pendingArtifacts.keys()])].sort(),
          stageDigests: [...this.stageEvidenceDigests].sort(([left], [right]) => left.localeCompare(right)),
          artifactDigests: [...this.pendingArtifacts].map(([path, artifact]) => [
            path,
            createHash('sha256').update(artifact.content).digest('hex'),
          ]).sort(([left], [right]) => left.localeCompare(right)),
        },
        quantities: {
          ...quantities,
          changedPaths: [...new Set([...this.pendingTails.keys(), ...this.pendingArtifacts.keys()])].sort(),
        },
      });
    }
    for (const attempt of quantities.activeAttempts) {
      if (attempt.remainingMs === undefined || attempt.remainingMs > quantities.deadlineMarginMs) continue;
      candidates.push({
        type: 'deadline_margin',
        observedAt,
        source: 'attempt_deadline_ledger',
        stageId: attempt.stageId,
        fingerprint: {
          stageId: attempt.stageId,
          attemptIndex: attempt.attemptIndex,
          attemptStartedAt: attempt.attemptStartedAt,
          deadlineAt: attempt.deadlineAt,
        },
        quantities: {
          ...quantities,
          deadlineStageId: attempt.stageId,
          deadlineAttemptIndex: attempt.attemptIndex,
          deadlineRemainingMs: attempt.remainingMs,
        },
      });
    }
    return candidates;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;

    // Read current state
    let state: StoreState;
    try {
      state = readRunState(this.projectDir, this.runId);
    } catch { /* non-critical */
      return; // run not ready yet
    }

    // Track milestones and update progress
    this.trackMilestones(state);

    // Reset the compatibility counter when the iteration advances. It is
    // recorded in event quantities but never authorizes or suppresses a call.
    const currentIter = state.currentIteration ?? 1;
    if (currentIter !== this.lastSeenIteration) {
      if (this.lastSeenIteration !== 0) {
        log.info({ from: this.lastSeenIteration, to: currentIter, perIterUsed: this.iterationAssessmentCount }, 'Supervisor per-iteration event counter reset');
      }
      this.lastSeenIteration = currentIter;
      this.iterationAssessmentCount = 0;
    }

    // Stop if run is no longer active (any terminal state, not just complete/failed)
    if (isTerminalRunStatus(state.status)) {
      this.stop();
      return;
    }

    // Check for user input
    const userInput = this.readUserInput();
    const addressedOperatorTarget = (() => {
      if (!userInput) return undefined;
      const targets = [...userInput.matchAll(/(?:^|\n)\s*\[([a-z][a-z0-9_]{0,19}|all|\*)\]\s*:/g)]
        .map((match) => match[1] === 'all' ? RUN_WIDE_GUIDANCE_TARGET : match[1]);
      return new Set(targets).size === 1 ? targets[0] : undefined;
    })();
    if (userInput) {
      this.observations.push(`User guidance received: "${userInput.slice(0, 100)}"`);
      // Preserve the operator's exact text in the audit ledger, but quarantine
      // it until the supervisor has selected a concrete target. Delivering it
      // run-wide here races the later targeted decision and leaks stage-specific
      // instructions to every concurrently running worker.
      appendGuidanceEnvelope({
        runDir: this.runDir(),
        target: null,
        body: `[user]: ${userInput}`,
        source: 'operator',
        knownStageIds: Object.keys(state.stages),
      });
      log.info({ runId: this.runId }, 'User input received and queued for targeted guidance routing');
      this.writeProgress();
    }

    // Find running stages
    const runningStages = Object.entries(state.stages)
      .filter(([, s]) => isRunningStageStatus(s.status))
      .map(([id]) => id);

    // Freeze the rejection authority before reading any prompt evidence. If
    // an output/verdict/metric changes during tail collection, artifact scan,
    // prompt assembly, or the model call, act()'s fresh comparison suppresses
    // REJECT instead of binding a judgement to bytes the assessor never saw.
    const observedEvidenceBindings = new Map<string, SupervisorEvidenceBinding>();
    for (const [stageId, fallback] of Object.entries(state.stages)) {
      try {
        const binding = computeSupervisorEvidenceBinding(
          this.runDir(),
          stageId,
          this.authoritativeStageStatus(stageId, fallback),
        );
        if (binding) observedEvidenceBindings.set(stageId, binding);
      } catch { /* a racing artifact cannot become reject authority */ }
    }

    // Read and ACCUMULATE live.log tails across cheap heartbeats. The previous
    // implementation advanced byte offsets every 30s, so a 180s LLM cadence
    // would otherwise see only the final 30s and miss the wrong-direction arc.
    const tails = this.readStageTails(runningStages, state);
    const totalDelta = [...tails.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    this.accumulatedOutputBytes += totalDelta;
    for (const [stageId, text] of tails) {
      const accumulated = (this.pendingTails.get(stageId) ?? '') + text;
      this.pendingTails.set(stageId, accumulated.slice(-this.config.tailBytes));
    }

    // Stage transitions are anomaly signals and therefore bypass routine cadence.
    const currentSnapshot: Record<string, string> = {};
    for (const [id, s] of Object.entries(state.stages)) currentSnapshot[id] = s.status;
    const transitionParts: string[] = [];
    const transitionedStageIds = new Set<string>();
    const allStageIds = new Set([...Object.keys(this.prevStageStatusSnapshot), ...Object.keys(currentSnapshot)]);
    for (const id of allStageIds) {
      const before = this.prevStageStatusSnapshot[id] ?? 'absent';
      const after = currentSnapshot[id] ?? 'absent';
      if (before !== after) {
        transitionParts.push(`${id}:${before}>${after}`);
        transitionedStageIds.add(id);
      }
    }
    this.prevStageStatusSnapshot = currentSnapshot;

    // === GAP-2: deterministic no-progress watchdog ===
    // BEFORE the idle / minDeltaBytes early-returns below (which would otherwise skip the
    // whole tick on a quiet run — the exact condition under which a stage silently hangs).
    // This fires the SAME abort_<stage> signal the LLM ABORT verdict uses, but
    // deterministically, independent of the model: a stage that has shown NO progress
    // signal (new live.log bytes, new artifact, or a stage transition) for
    // config.stuckThresholdMs is killed and left to the retry machinery.
    let stalledStageIds: string[];
    const stageFacts = new Map<string, StageExecutionFacts>();
    {
      const now = Date.now();
      const artifactCutoff = this.watchdogLastArtifactCheckMs || (now - this.config.stuckThresholdMs);
      this.watchdogLastArtifactCheckMs = now;
      const projectCommit = this.readProjectCommit();
      const progressedStageIds = new Set<string>();
      for (const stageId of runningStages) {
        const stageStatus = this.authoritativeStageStatus(stageId, state.stages[stageId]);
        const facts = this.inspectFacts(
          stageId,
          stageStatus,
          artifactCutoff,
          state.baseCommit,
          projectCommit,
        );
        stageFacts.set(stageId, facts);
        const attemptKey = `${stageId}:${facts.attemptIndex ?? 'unknown'}:${facts.attemptStartedAt ?? 'unknown'}`;
        const attemptChanged = this.watchdogAttemptKeys[stageId] !== attemptKey;
        this.watchdogAttemptKeys[stageId] = attemptKey;
        const stageProgressed = (tails.get(stageId)?.length ?? 0) > 0
          || transitionedStageIds.has(stageId)
          || attemptChanged
          || facts.artifactProgressThisTick
          || facts.protectedFromIdleAbort;
        if (stageProgressed) progressedStageIds.add(stageId);
      }
      const detected = detectStalledStages({
        runningStages,
        progressedStageIds,
        lastProgressMs: this.stageLastProgressMs,
        now,
        thresholdMs: this.config.stuckThresholdMs,
      });
      this.stageLastProgressMs = detected.nextLastProgressMs;
      stalledStageIds = detected.stalledStageIds;
      const activeAttemptKeys = new Set(runningStages.map((stageId) => {
        const facts = stageFacts.get(stageId)!;
        return `${stageId}:${facts.attemptIndex ?? 'unknown'}:${facts.attemptStartedAt ?? 'unknown'}`;
      }));
      for (const aborted of [...this.watchdogAbortedStages]) {
        if (!activeAttemptKeys.has(aborted)) this.watchdogAbortedStages.delete(aborted);
      }
      for (const stageId of stalledStageIds) {
        const facts = stageFacts.get(stageId)!;
        const attemptKey = `${stageId}:${facts.attemptIndex ?? 'unknown'}:${facts.attemptStartedAt ?? 'unknown'}`;
        if (this.watchdogAbortedStages.has(attemptKey)) continue;
        const stalledMs = now - (this.stageLastProgressMs[stageId] ?? now);
        const abort = this.writeVerifiedAbort(
          stageId,
          'watchdog',
          { kind: 'idle', stalledMs },
          undefined,
          artifactCutoff,
        );
        if (abort.written) {
          this.watchdogAbortedStages.add(attemptKey);
          log.warn({ runId: this.runId, stageId, stalledMs }, 'Watchdog ABORT — stage made no progress past threshold');
          this.observations.push(`Watchdog aborted stuck stage '${stageId}' (${Math.round(stalledMs / 1000)}s no progress)`);
        } else {
          log.warn({ runId: this.runId, stageId, reason: abort.reason }, 'Watchdog ABORT suppressed by verified stage facts');
        }
      }
    }

    // Scan artifacts on every heartbeat and retain their exact bounded bytes.
    // The scan is evidence collection only; it authorizes a model call solely
    // when it produces one of the typed events below.
    const recentArtifacts = this.readRecentArtifacts();
    for (const artifact of recentArtifacts) {
      const previous = this.pendingArtifacts.get(artifact.path);
      if (previous?.content !== artifact.content) {
        this.accumulatedOutputBytes += Buffer.byteLength(artifact.content);
      }
      this.pendingArtifacts.set(artifact.path, artifact);
    }
    const now = Date.now();
    this.eventCursor.offer(this.eventCandidates({
      state,
      runningStages,
      transitionParts,
      recentArtifacts,
      userInput,
      now,
    }));
    const triggeringEvent = this.eventCursor.next();
    if (selectSupervisorAssessmentTrigger({
      deterministicEvents: triggeringEvent ? [triggeringEvent] : [],
    }) === 'none' || !triggeringEvent) {
      this.writeProgress();
      return;
    }
    // Persist consumption before the external call. A daemon restart cannot
    // replay the same event merely because the model call was in flight.
    this.writeSupervisorState();

    let extraContext = `\n\n# Deterministic Triggering Event\n${JSON.stringify(triggeringEvent, null, 2)}\nThis event authorized this assessment. Its quantities are the values read when the event crossed its threshold.`;
    if (userInput) {
      extraContext += `\n\n# User Guidance (just received)\n${userInput}\nIncorporate this into your assessment.`;
    }
    const assessmentEvidenceCapturedAt = Date.now();
    const assessmentTails = new Map(this.pendingTails);
    const assessmentArtifacts = [...this.pendingArtifacts.values()];
    const observedDirectionEvidence = new Map<string, DirectionEvidenceBinding>();
    const observedStageEvidence = new Map<string, SupervisorStageEvidence>();
    const comparisonStageEvidence = new Map<string, SupervisorStageEvidence>();
    for (const stageId of runningStages) {
      const authoritative = this.authoritativeStageStatus(stageId, state.stages[stageId]);
      const binding = this.bindDirectionEvidence(stageId, authoritative);
      if (binding) observedDirectionEvidence.set(stageId, binding);
      const attempt = currentRunningAttempt(authoritative);
      if (attempt) {
        observedStageEvidence.set(stageId, projectSupervisorStageEvidence({
          stageId,
          attemptIndex: attempt.index,
          attemptStartedAt: attempt.startedAt,
          raw: assessmentTails.get(stageId) ?? '',
        }));
      }
    }
    for (const [stageId, status] of Object.entries(state.stages)) {
      const projection = projectLatestAttemptEvidence(
        this.runDir(),
        stageId,
        this.authoritativeStageStatus(stageId, status),
      );
      if (projection) comparisonStageEvidence.set(stageId, projection);
    }
    this.iterationAssessmentCount++;
    const prompt = this.buildAssessmentPrompt(
      assessmentTails,
      state,
      runningStages,
      assessmentArtifacts,
      stageFacts,
      observedStageEvidence,
    ) + extraContext;
    let assessment = await this.assess(prompt, triggeringEvent);
    this.accumulatedOutputBytes = 0;
    this.pendingTails.clear();
    this.pendingArtifacts.clear();
    if (!assessment) {
      // Track consecutive failures so a silently-broken supervisor (e.g. an
      // adapter that keeps returning unparseable output) becomes observable
      // instead of just emitting zero ticks.
      this.consecutiveAssessFailures++;
      if (this.consecutiveAssessFailures >= Supervisor.DEGRADED_AFTER_FAILURES) {
        try {
          writeFileSync(join(this.signalDir(), 'supervisor_degraded.json'), JSON.stringify({
            runId: this.runId,
            consecutiveFailures: this.consecutiveAssessFailures,
            timestamp: new Date().toISOString(),
            note: 'Supervisor assess() returned null repeatedly — it is NOT steering the run. Check adapter output / model availability.',
          }, null, 2), 'utf-8');
        } catch { /* non-critical */ }
        log.warn({ runId: this.runId, consecutiveFailures: this.consecutiveAssessFailures }, 'Supervisor DEGRADED — repeated assessment failures, not steering the run');
      }
      this.writeProgress();
      return;
    }
    if (userInput && addressedOperatorTarget && assessment.verdict === 'GUIDE') {
      const targetIsKnown = addressedOperatorTarget === RUN_WIDE_GUIDANCE_TARGET
        || Object.hasOwn(state.stages, addressedOperatorTarget);
      assessment = targetIsKnown
        ? { ...assessment, targetStage: addressedOperatorTarget }
        : {
            verdict: 'WAIT',
            targetStage: null,
            guidance: null,
            reason: `Operator guidance remains quarantined because addressed stage ${addressedOperatorTarget} is not admitted in this run.`,
          };
    }
    // Recovered: a successful assessment clears the degraded state.
    if (this.consecutiveAssessFailures > 0) {
      this.consecutiveAssessFailures = 0;
      try { const p = join(this.signalDir(), 'supervisor_degraded.json'); if (existsSync(p)) unlinkSync(p); } catch { /* non-critical */ }
    }

    // Validate any consequential verdict against fresh on-disk facts before it
    // becomes an action, log entry, dashboard state, or signal.
    const effectiveAssessment = await this.act(
      assessment,
      assessmentEvidenceCapturedAt,
      userInput ? 'operator' : 'supervisor',
      observedEvidenceBindings,
      observedDirectionEvidence,
      observedStageEvidence,
      comparisonStageEvidence,
    );
    this.recordEffectiveAssessment(effectiveAssessment);

    // Keep WAIT streak telemetry, but do not let it slow the 30s anomaly heartbeat.
    if (effectiveAssessment.verdict === 'WAIT') {
      this.consecutiveWaits++;
    } else {
      this.consecutiveWaits = 0;
    }

    // Record action
    const action: SupervisorAction = {
      timestamp: new Date().toISOString(),
      tick: this.tickCount,
      assessment: effectiveAssessment,
      trigger: triggeringEvent,
      runningStages,
      targetAttemptIndex: effectiveAssessment.targetStage
        ? currentRunningAttempt(this.authoritativeStageStatus(
            effectiveAssessment.targetStage,
            state.stages[effectiveAssessment.targetStage] ?? { status: STAGE_STATUS.PENDING, retries: 0 },
          ))?.index
        : undefined,
      source: userInput ? 'operator' : 'supervisor',
      ...(effectiveAssessment.targetStage
        && observedDirectionEvidence.has(effectiveAssessment.targetStage)
        ? { directionEvidence: observedDirectionEvidence.get(effectiveAssessment.targetStage) }
        : {}),
    };
    this.actions.push(action);
    if (effectiveAssessment.assessmentId) {
      recordRunEvent(this.projectDir, this.runId, {
        type: 'supervisor_assessment',
        runId: this.runId,
        timestamp: action.timestamp,
        iteration: state.currentIteration,
        stageId: effectiveAssessment.targetStage ?? undefined,
        attemptIndex: action.targetAttemptIndex,
        attemptStartedAt: action.directionEvidence?.attemptStartedAt,
        evidenceGeneration: action.directionEvidence?.generation,
        assessmentId: effectiveAssessment.assessmentId,
        supersedesAssessmentId: effectiveAssessment.supersedesAssessmentId,
        supervisorVerdict: effectiveAssessment.verdict,
        evidenceIds: effectiveAssessment.evidenceIds,
        guidanceId: effectiveAssessment.guidanceId,
        detail: effectiveAssessment.reason,
        source: action.source,
      });
    }

    // Log
    this.appendLog(action);

    // Record observation
    if (effectiveAssessment.verdict === 'WAIT') {
      this.observations.push(effectiveAssessment.reason);
    } else {
      this.observations.push(`${effectiveAssessment.verdict}: ${effectiveAssessment.reason}`);
      if (effectiveAssessment.verdict === 'GUIDE' && effectiveAssessment.guidance) {
        this.decisions.push(`Guided ${effectiveAssessment.targetStage}: ${effectiveAssessment.guidance.slice(0, 100)}`);
      } else if (effectiveAssessment.verdict === 'REPLAN') {
        this.decisions.push(`Triggered replan: ${effectiveAssessment.reason}`);
      } else if (effectiveAssessment.verdict === 'REJECT') {
        this.decisions.push(`Rejected ${effectiveAssessment.targetStage ?? 'deliverable'}: ${effectiveAssessment.reason.slice(0, 100)}`);
      } else if (effectiveAssessment.verdict === 'DONE') {
        this.decisions.push(`Goal confirmed met: ${effectiveAssessment.reason}`);
      }
      log.info({ tick: this.tickCount, verdict: effectiveAssessment.verdict, target: effectiveAssessment.targetStage, reason: effectiveAssessment.reason }, 'Supervisor action');
    }

    // Update progress file
    this.writeProgress();
  }

  private readStageTails(stageIds: string[], state: StoreState): Map<string, string> {
    const tails = new Map<string, string>();
    for (const stageId of stageIds) {
      const logPath = join(this.runDir(), 'stages', stageId, 'live.log');
      if (!existsSync(logPath)) continue;

      try {
        const stat = statSync(logPath);
        const attempt = currentRunningAttempt(state.stages[stageId]);
        const generation = readAttemptGeneration(this.runDir(), stageId);
        const generationMatches = Boolean(attempt && generation
          && generation.attemptIndex === attempt.index
          && generation.attemptStartedAt === attempt.startedAt);
        const attemptKey = generationMatches
          ? `${stageId}:${generation!.attemptIndex}:${generation!.attemptStartedAt}`
          : `${stageId}:unbound:${attempt?.index ?? 'unknown'}:${attempt?.startedAt ?? 'unknown'}`;
        const previousKey = this.attemptEvidenceKeys.get(stageId);
        if (previousKey !== attemptKey) {
          this.attemptEvidenceKeys.set(stageId, attemptKey);
          this.pendingTails.delete(stageId);
          // Without a current generation record, fail closed by observing only
          // future appends. Never inherit a prior attempt's tail.
          const boundary = generationMatches ? generation!.segmentStart : stat.size;
          this.attemptSegmentFloors.set(stageId, boundary);
          this.byteOffsets.set(stageId, boundary);
          this.stageEvidenceDigests.set(stageId, createHash('sha256').update(attemptKey).digest('hex'));
        }
        const floor = this.attemptSegmentFloors.get(stageId) ?? stat.size;
        const prevOffset = Math.max(floor, this.byteOffsets.get(stageId) ?? floor);
        const bytesToRead = Math.min(this.config.tailBytes, stat.size - prevOffset);
        if (bytesToRead <= 0) continue;

        const fd = openSync(logPath, 'r');
        const buf = Buffer.alloc(bytesToRead);
        const bytesRead = readSync(fd, buf, 0, bytesToRead, prevOffset);
        closeSync(fd);

        const delta = buf.subarray(0, bytesRead);
        this.byteOffsets.set(stageId, prevOffset + bytesRead);
        const previousDigest = this.stageEvidenceDigests.get(stageId) ?? attemptKey;
        this.stageEvidenceDigests.set(stageId, createHash('sha256').update(previousDigest).update(delta).digest('hex'));
        tails.set(stageId, delta.toString('utf-8'));
      } catch { /* file access error, skip */ }
    }
    return tails;
  }

  private buildAssessmentPrompt(
    tails: Map<string, string>,
    state: StoreState,
    runningStages: string[],
    recentArtifacts: Array<{ path: string; content: string }>,
    stageFacts: ReadonlyMap<string, StageExecutionFacts>,
    stageEvidence?: ReadonlyMap<string, SupervisorStageEvidence>,
  ): string {
    const parts: string[] = [];

    parts.push(`# Iteration ${state.currentIteration ?? 1}/${state.maxIterations ?? 5}`);

    // Running stages with output (8 KB per stage so silent fallbacks are visible in stdout)
    parts.push('\n# Running Stages');
    for (const stageId of runningStages) {
      const facts = stageFacts.get(stageId);
      const elapsed = facts?.attemptStartedAt ? Math.round((Date.now() - new Date(facts.attemptStartedAt).getTime()) / 1000) : 0;
      const tail = tails.get(stageId) ?? '';
      parts.push(`\n## ${stageId} — ${elapsed}s elapsed`);
      if (facts) parts.push(`Verified facts: ${describeStageExecutionFacts(facts)}.`);
      const projection = stageEvidence?.get(stageId);
      if (projection && projection.rows.length > 0) {
        parts.push('Evidence projection (cite exact ids; INSPECTION rows cannot establish pursuit; consequential reasons must share a concrete term with cited ACTION rows):');
        for (const row of projection.rows) {
          const label = row.authority === 'action' ? 'ACTION' : 'INSPECTION';
          parts.push(`[${row.id}] [${label}:${row.kind}] ${row.text}`);
        }
      } else {
        // Direct legacy callers can still inspect their raw bytes, but the
        // production path always supplies a provenance projection.
        parts.push(tail ? `\`\`\`\n${tail.slice(-8000)}\n\`\`\`` : '(no output yet)');
      }
    }

    // Recent JSON artifacts: capability reports, gate verdicts, metric files modified
    // since the previous tick. Catches silent fallbacks (e.g. "selected_provider falls back")
    // that show up in JSON files but not in live.log stdout.
    if (recentArtifacts.length > 0) {
      parts.push('\n# Recent Artifacts (modified since last tick)');
      parts.push('These JSON files were written by stages and may signal silent fallbacks, blockers, or completion. Read them carefully — gates lying with `pass:true` while `value<threshold` is a known failure mode.');
      for (const { path, content } of recentArtifacts) {
        parts.push(`\n## ${path}\n\`\`\`json\n${content}\n\`\`\``);
      }
    }

    // Completed stages summary
    const completed = Object.entries(state.stages)
      .filter(([, s]) => isSettledStageStatus(s.status))
      .map(([id, s]) => `- ${id}: ${s.status}${s.error ? ` (${s.error})` : ''}`);
    if (completed.length > 0) {
      parts.push(`\n# Completed Stages\n${completed.join('\n')}`);
    }

    const currentStatuses = new Map(runningStages.map((stageId) => {
      const fallback = state.stages[stageId];
      return [stageId, fallback ? this.authoritativeStageStatus(stageId, fallback) : undefined] as const;
    }));
    const guidanceHistory = summarizeSupervisorGuidanceHistory(
      this.actions.filter((action) => (
        (action.source ?? 'supervisor') === 'supervisor'
        && action.assessment.targetStage !== null
        && actionAttemptIndex(action, currentStatuses.get(action.assessment.targetStage))
          === currentRunningAttempt(currentStatuses.get(action.assessment.targetStage))?.index
      )),
      runningStages,
    );
    if (guidanceHistory) {
      parts.push(`\n# Cumulative GUIDE History\n${guidanceHistory}\nRepeatedly unheeded concrete guidance may justify ABORT even when the stage remains highly productive; output volume alone does not establish correctness.`);
    }

    // Previous supervisor actions (last 3)
    if (this.actions.length > 0) {
      const recent = this.actions.slice(-3).map(a =>
        `- ${a.assessment.assessmentId ?? 'legacy-assessment'} · Tick ${a.tick}: ${a.assessment.verdict}${a.assessment.targetStage ? ` → ${a.assessment.targetStage}` : ''} — ${a.assessment.reason}`
      );
      parts.push(`\n# Previous Supervisor Actions\n${recent.join('\n')}`);
    }

    return parts.join('\n');
  }

  /**
   * Scan the run dir for JSON artifacts that were modified since the last assessment.
   * Caps results so the assessment prompt stays bounded.
   */
  private lastArtifactScanAt: number = 0;
  private readRecentArtifacts(): Array<{ path: string; content: string }> {
    const runDirAbs = this.runDir();
    const since = this.lastArtifactScanAt;
    const now = Date.now();
    this.lastArtifactScanAt = now;
    // First tick: look back one poll interval so the first assessment isn't empty.
    const cutoff = since > 0 ? since : now - Math.max(this.config.pollIntervalMs * 2, 30_000);

    const interesting = (name: string) =>
      /capability_report\.json$/.test(name) ||
      /^verdict[_.].*\.json$/.test(name) ||
      /^metric\.json$/.test(name) ||
      /capability_blocker\.json$/.test(name);

    const walk = (dir: string, depth: number, acc: Array<{ path: string; mtime: number }>) => {
      if (depth > 4) return;
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[]; } catch { return; }
      for (const e of entries) {
        if (e.name === 'codex_home' || e.name === 'node_modules' || e.name === '.tmp') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p, depth + 1, acc);
        } else if (e.isFile() && interesting(e.name)) {
          try {
            const st = statSync(p);
            if (st.mtimeMs >= cutoff) acc.push({ path: p, mtime: st.mtimeMs });
          } catch { /* skip */ }
        }
      }
    };

    const found: Array<{ path: string; mtime: number }> = [];
    walk(runDirAbs, 0, found);

    // Most recent first, cap at 5 files, 4 KB each to keep prompt bounded.
    found.sort((a, b) => b.mtime - a.mtime);
    const top = found.filter(({ path }) => !isEnginePlaceholderMetric(path)).slice(0, 5);
    return top.map(({ path }) => {
      let content: string;
      try {
        const raw = readFileSync(path, 'utf-8');
        content = raw.length > 4000 ? raw.slice(0, 4000) + '\n... [truncated]' : raw;
      } catch { content = '[unreadable]'; }
      return { path: relative(runDirAbs, path), content };
    });
  }

  private async assess(prompt: string, trigger: SupervisorEvent): Promise<SupervisorAssessment | null> {
    const agentConfig: AgentConfig = {
      name: 'supervisor',
      description: 'Workflow supervisor',
      model: this.config.model,
      reasoning_effort: this.config.reasoningEffort,
      tools: [],
      prompt: buildSupervisorRolePrompt(this.config.stuckThresholdMs, this.taskDescription),
    };

    const startedAt = new Date().toISOString();
    let result: RunResult;
    try {
      result = await this.adapter.run(prompt, agentConfig, {
        timeout_ms: 30000,
        workDir: this.projectDir,
        runDir: this.runDir(),
        stageId: '_supervisor',
      });
    } catch (err) {
      this.recordAssessmentUsage(startedAt, undefined, null, trigger, err instanceof Error ? err.message : String(err));
      log.warn({ err }, 'Supervisor assessment call failed');
      return null;
    }

    if (result.exitCode !== 0) {
      this.recordAssessmentUsage(startedAt, result, null, trigger, `adapter exit ${result.exitCode}`);
      log.warn({ exitCode: result.exitCode }, 'Supervisor assessment returned non-zero');
      return null;
    }

    // Parse the verdict (codex echoes the prompt+template before the real answer;
    // parseSupervisorVerdict scans last-to-first to skip the echoed template).
    const verdict = parseSupervisorVerdict(result.output);
    if (!verdict) {
      this.recordAssessmentUsage(startedAt, result, null, trigger, 'unparseable supervisor verdict');
      log.warn({ outputPreview: result.output.slice(-500) }, 'No parseable supervisor verdict in response');
      return null;
    }
    const assessedAt = new Date().toISOString();
    const assessmentId = `sa_${createHash('sha256').update(JSON.stringify([
      this.runId,
      trigger.eventId,
      startedAt,
      result.output,
    ])).digest('hex').slice(0, 20)}`;
    const identifiedVerdict: SupervisorAssessment = { ...verdict, assessmentId, assessedAt };
    this.recordAssessmentUsage(startedAt, result, identifiedVerdict, trigger);
    return identifiedVerdict;
  }

  private writeVerifiedAbort(
    stageId: string,
    source: AbortSignalSource,
    basis: AbortBasis,
    unverifiedAssessmentReason?: string,
    progressSinceMs = Date.now(),
  ): VerifiedAbortResult {
    let state: StoreState;
    try {
      state = readRunState(this.projectDir, this.runId);
    } catch {
      return { written: false, reason: `ABORT suppressed for ${stageId}: no readable run state observed.` };
    }
    const status = state.stages[stageId];
    if (!status || !isRunningStageStatus(status.status)) {
      return { written: false, reason: `ABORT suppressed for ${stageId}: no active running stage observed.` };
    }
    const authoritativeStatus = this.authoritativeStageStatus(stageId, status);
    if (!isRunningStageStatus(authoritativeStatus.status)) {
      return { written: false, reason: `ABORT suppressed for ${stageId}: no active running execution observed.` };
    }
    const facts = this.inspectFacts(stageId, authoritativeStatus, progressSinceMs, state.baseCommit);
    const factSummary = describeStageExecutionFacts(facts);
    if (facts.attemptIndex === undefined) {
      return { written: false, reason: `ABORT suppressed for ${stageId}: ${factSummary}.` };
    }
    if (facts.finalizing) {
      return {
        written: false,
        reason: `ABORT suppressed for ${stageId}: ${factSummary}; the current execution is in its finalization window.`,
      };
    }
    if (basis.kind === 'idle' && facts.protectedFromIdleAbort) {
      return {
        written: false,
        reason: `Idle ABORT suppressed for ${stageId}: durable current-execution completion evidence exists; ${factSummary}.`,
      };
    }
    if (basis.kind === 'idle' && (facts.liveProgressThisTick || facts.artifactProgressThisTick)) {
      this.stageLastProgressMs[stageId] = Date.now();
      return {
        written: false,
        reason: `Idle ABORT suppressed for ${stageId}: durable live or artifact progress was observed during final verification; ${factSummary}.`,
      };
    }
    if (basis.kind === 'repeated_guidance' && (facts.liveProgressThisTick || facts.artifactProgressThisTick)) {
      return {
        written: false,
        reason: `Direction ABORT suppressed for ${stageId}: durable progress changed after the assessed evidence snapshot; the same direction must be judged again from those bytes; ${factSummary}.`,
      };
    }

    let verifiedBasis: string;
    if (basis.kind === 'idle') {
      const lastProgressAt = this.stageLastProgressMs[stageId];
      const verifiedIdleMs = lastProgressAt === undefined ? -1 : Date.now() - lastProgressAt;
      if (verifiedIdleMs < this.config.stuckThresholdMs) {
        return {
          written: false,
          reason: `Idle ABORT suppressed for ${stageId}: verified idle duration is unavailable or below the configured threshold; ${factSummary}.`,
        };
      }
      verifiedBasis = `no verified live/artifact/transition progress for ${Math.round(verifiedIdleMs / 1000)}s (threshold ${Math.round(this.config.stuckThresholdMs / 1000)}s)`;
    } else {
      if (!basis.persistence.verified) {
        return {
          written: false,
          reason: `Direction ABORT suppressed for ${stageId}: ${basis.persistence.reason}; ${factSummary}.`,
        };
      }
      verifiedBasis = `${basis.persistence.guideCount} prior GUIDE decisions observed for the same running stage; ${basis.persistence.reason}`;
    }

    const reason = `${source === 'watchdog' ? 'Watchdog' : 'Supervisor'} ABORT verified for ${stageId} attempt ${facts.attemptIndex}: ${verifiedBasis}; ${factSummary}.`;
    const signal: StageAbortSignal = {
      version: ABORT_SIGNAL_VERSION,
      stageId,
      attemptIndex: facts.attemptIndex,
      reason,
      timestamp: new Date().toISOString(),
      source,
      ...(basis.kind === 'repeated_guidance'
        ? { directionComparison: basis.persistence.siblingComparison }
        : {}),
      ...(unverifiedAssessmentReason
        ? { unverifiedAssessmentReason: unverifiedAssessmentReason.slice(0, 500) }
        : {}),
    };
    try {
      mkdirSync(this.signalDir(), { recursive: true });
      atomicWrite(join(this.signalDir(), `abort_${stageId}.json`), JSON.stringify(signal, null, 2));
      return { written: true, reason };
    } catch {
      return { written: false, reason: `ABORT suppressed for ${stageId}: the owned signal could not be persisted; ${factSummary}.` };
    }
  }

  private async act(
    assessment: SupervisorAssessment,
    progressSinceMs = Date.now(),
    source: 'supervisor' | 'operator' = 'supervisor',
    observedEvidenceBindings?: ReadonlyMap<string, SupervisorEvidenceBinding>,
    observedDirectionEvidence?: ReadonlyMap<string, DirectionEvidenceBinding>,
    observedStageEvidence?: ReadonlyMap<string, SupervisorStageEvidence>,
    comparisonStageEvidence?: ReadonlyMap<string, SupervisorStageEvidence>,
  ): Promise<SupervisorAssessment> {
    const signalDir = this.signalDir();
    const citedActionEvidence = (): {
      verified: boolean;
      reason: string;
      attempt?: { index: number; startedAt: string };
    } => {
      // Direct unit callers that do not provide the production projection keep
      // their narrow compatibility behavior. Every production tick supplies
      // this map, including an empty projection when no attributable evidence
      // was observed.
      if (observedStageEvidence === undefined) return { verified: true, reason: 'direct caller supplied no projection' };
      if (!assessment.targetStage) return { verified: false, reason: 'the assessment named no target stage' };
      let attempt: { index: number; startedAt: string } | undefined;
      try {
        const state = readRunState(this.projectDir, this.runId);
        const status = state.stages[assessment.targetStage];
        if (status) attempt = currentRunningAttempt(this.authoritativeStageStatus(assessment.targetStage, status));
      } catch { /* fail closed below */ }
      if (!attempt) return { verified: false, reason: 'the target has no current running execution' };
      const projection = observedStageEvidence.get(assessment.targetStage);
      if (!projection
        || projection.attemptIndex !== attempt.index
        || projection.attemptStartedAt !== attempt.startedAt) {
        return { verified: false, reason: 'the cited evidence is not bound to the current target execution', attempt };
      }
      const ids = assessment.evidenceIds ?? [];
      if (ids.length === 0) return { verified: false, reason: 'the assessment cited no action-bearing evidence', attempt };
      const actionIds = new Set(projection.rows
        .filter((row) => row.authority === 'action')
        .map((row) => row.id));
      const invalid = ids.filter((id) => !actionIds.has(id));
      if (invalid.length > 0) {
        return {
          verified: false,
          reason: `evidence ${invalid.join(', ')} is absent, stale, or inspection-only`,
          attempt,
        };
      }
      const citedRows = projection.rows.filter((row) => ids.includes(row.id));
      const support = supervisorEvidenceSupportsAssessment(assessment, citedRows);
      if (!support.supported) {
        return {
          verified: false,
          reason: 'the cited action rows share no concrete claim term with the assessment reason or direction key',
          attempt,
        };
      }
      return {
        verified: true,
        reason: `${ids.length} current action evidence row(s) verified with concrete support term(s): ${support.sharedTerms.join(', ')}`,
        attempt,
      };
    };

    switch (assessment.verdict) {
      case 'WAIT':
        return assessment;

      case 'GUIDE':
        if (assessment.targetStage && assessment.guidance) {
          if (source === 'supervisor') {
            const evidence = citedActionEvidence();
            if (!evidence.verified) {
              return {
                ...assessment,
                verdict: 'WAIT',
                guidance: null,
                reason: `GUIDE suppressed for ${assessment.targetStage}: ${evidence.reason}.`,
              };
            }
          }
          let knownStageIds: string[] = [];
          try { knownStageIds = Object.keys(readRunState(this.projectDir, this.runId).stages); } catch { /* quarantine below */ }
          const envelope = appendGuidanceEnvelope({
            runDir: this.runDir(),
            target: assessment.targetStage,
            body: assessment.guidance,
            source,
            knownStageIds,
          });
          if (envelope.quarantined) {
            return {
              ...assessment,
              verdict: 'WAIT',
              guidance: null,
              reason: `GUIDE suppressed for ${assessment.targetStage}: ${envelope.quarantineReason ?? 'guidance target was quarantined'}.`,
            };
          }
          if (!envelope.quarantined && assessment.targetStage !== RUN_WIDE_GUIDANCE_TARGET) {
            const guidancePath = join(this.runDir(), 'stages', assessment.targetStage, 'guidance.md');
            mkdirSync(join(this.runDir(), 'stages', assessment.targetStage), { recursive: true });
            appendFileSync(guidancePath, `${existsSync(guidancePath) ? '\n\n' : ''}${renderGuidanceEnvelope(envelope)}\n`, 'utf-8');
          }
          assessment = { ...assessment, guidanceId: envelope.id };
        }
        this.lastActionTime = Date.now();
        return assessment;

      case 'ABORT':
        if (!assessment.targetStage) {
          return {
            verdict: 'WAIT', targetStage: null, guidance: null,
            reason: 'ABORT suppressed: the assessment named no target stage.',
          };
        }
        {
          if (assessment.directionKey && source === 'supervisor') {
            const evidence = citedActionEvidence();
            if (!evidence.verified) {
              return {
                ...assessment,
                verdict: 'WAIT',
                guidance: null,
                reason: `Direction ABORT suppressed for ${assessment.targetStage}: ${evidence.reason}.`,
              };
            }
          }
          let targetAttemptIndex: number | undefined;
          let targetStatus: StageStatus | undefined;
          try {
            const state = readRunState(this.projectDir, this.runId);
            const status = state.stages[assessment.targetStage];
            if (status) {
              targetStatus = this.authoritativeStageStatus(assessment.targetStage, status);
              targetAttemptIndex = currentRunningAttempt(targetStatus)?.index;
            }
          } catch { /* writeVerifiedAbort performs the authoritative fail-closed check */ }
          const guidance = this.actions.map((action): DirectionGuidanceFact => ({
            timestamp: action.timestamp,
            assessment: action.assessment,
            targetAttemptIndex: actionAttemptIndex(action, targetStatus),
            source: action.source,
            directionEvidence: action.directionEvidence,
          }));
          const lastProgressAt = this.stageLastProgressMs[assessment.targetStage];
          const idleMs = lastProgressAt === undefined ? -1 : Date.now() - lastProgressAt;
          const persistence = verifyRepeatedWrongDirection({
            stageId: assessment.targetStage,
            attemptIndex: targetAttemptIndex,
            assessment,
            currentEvidence: observedDirectionEvidence?.get(assessment.targetStage),
            guidance,
            deliveryEvents: readRunEvents(this.projectDir, this.runId),
            assessmentTimestamp: assessment.assessedAt ?? new Date().toISOString(),
            accusedEvidence: comparisonStageEvidence?.get(assessment.targetStage),
            siblingEvidence: [...(comparisonStageEvidence?.values() ?? [])].filter((projection) => (
              projection.stageId !== assessment.targetStage
            )),
          });
          const basis: AbortBasis = idleMs >= this.config.stuckThresholdMs
            ? { kind: 'idle', stalledMs: idleMs }
            : { kind: 'repeated_guidance', persistence };
          if (
            source === 'operator'
            && basis.kind === 'repeated_guidance'
            && persistence.guideCount >= 2
          ) {
            return {
              verdict: 'WAIT', targetStage: assessment.targetStage, guidance: null,
              reason: `Direction ABORT deferred for ${assessment.targetStage}: this assessment was triggered by newly supplied operator guidance; ${persistence.guideCount} prior supervisor GUIDE decision(s) remain available to a later supervisor-triggered assessment after the stage can act on that guidance.`,
            };
          }
          const abort = this.writeVerifiedAbort(
            assessment.targetStage,
            'supervisor',
            basis,
            assessment.reason,
            progressSinceMs,
          );
          if (!abort.written) {
            return {
              verdict: 'WAIT', targetStage: assessment.targetStage, guidance: null,
              reason: abort.reason,
            };
          }
          this.lastActionTime = Date.now();
          return { ...assessment, reason: abort.reason };
        }

      case 'REPLAN':
        if (source === 'supervisor') {
          const evidence = citedActionEvidence();
          if (!evidence.verified || !evidence.attempt || !assessment.targetStage || !assessment.assessmentId) {
            return {
              ...assessment,
              verdict: 'WAIT',
              guidance: null,
              reason: `REPLAN suppressed${assessment.targetStage ? ` for ${assessment.targetStage}` : ''}: ${evidence.reason}.`,
            };
          }
          writeFileSync(join(signalDir, 'replan.json'), JSON.stringify({
            version: 2,
            assessmentId: assessment.assessmentId,
            targetStage: assessment.targetStage,
            attemptIndex: evidence.attempt.index,
            attemptStartedAt: evidence.attempt.startedAt,
            evidenceIds: assessment.evidenceIds,
            reason: assessment.reason,
            timestamp: assessment.assessedAt ?? new Date().toISOString(),
          }, null, 2), 'utf-8');
        } else {
          writeFileSync(join(signalDir, 'replan.json'),
            JSON.stringify({ reason: assessment.reason, timestamp: new Date().toISOString() }), 'utf-8');
        }
        this.lastActionTime = Date.now();
        return assessment;

      case 'REJECT':
        // Reject an emitted deliverable that does not meet its declared work.
        // The scheduler-side consumer re-pends the target stage so the work is
        // re-done rather than accepted. Bounded there by a max reject count.
        if (assessment.targetStage) {
          let current: SupervisorEvidenceBinding | undefined;
          try {
            const state = readRunState(this.projectDir, this.runId);
            const status = state.stages[assessment.targetStage];
            if (status) current = computeSupervisorEvidenceBinding(this.runDir(), assessment.targetStage, this.authoritativeStageStatus(assessment.targetStage, status));
          } catch { /* fail closed below */ }
          // Production assessments supply the generation captured immediately
          // before the model call. Direct unit callers retain the historical
          // immediate-check behavior by omitting the map.
          const observed = observedEvidenceBindings
            ? observedEvidenceBindings.get(assessment.targetStage)
            : current;
          if (!observed?.emittedDeliverable) {
            return {
              verdict: 'WAIT',
              targetStage: assessment.targetStage,
              guidance: null,
              reason: `REJECT suppressed for ${assessment.targetStage}: no emitted deliverable was bound to the evidence assessed for the current execution.`,
            };
          }
          if (
            !current?.emittedDeliverable
            || current.stageId !== observed.stageId
            || current.attemptIndex !== observed.attemptIndex
            || current.attemptStartedAt !== observed.attemptStartedAt
            || current.generation !== observed.generation
          ) {
            return {
              verdict: 'WAIT',
              targetStage: assessment.targetStage,
              guidance: null,
              reason: `REJECT suppressed for ${assessment.targetStage}: its attempt evidence changed while the assessment was running.`,
            };
          }
          const timestamp = new Date().toISOString();
          writeFileSync(join(signalDir, `reject_${assessment.targetStage}.json`),
            JSON.stringify({ version: 2, stage: assessment.targetStage, reason: assessment.reason, timestamp, evidence: observed }), 'utf-8');
          recordRunEvent(this.projectDir, this.runId, {
            type: 'supervisor_reject_requested', runId: this.runId, timestamp,
            stageId: assessment.targetStage, attemptIndex: observed.attemptIndex,
            attemptStartedAt: observed.attemptStartedAt, evidenceGeneration: observed.generation,
            detail: assessment.reason, source: 'supervisor', level: 'warning',
          });
        } else {
          return {
            verdict: 'WAIT', targetStage: null, guidance: null,
            reason: 'REJECT suppressed: the assessment named no target stage, so no attempt-bound evidence can be identified.',
          };
        }
        this.lastActionTime = Date.now();
        return assessment;

      case 'DONE':
        writeFileSync(join(signalDir, 'goal_met.json'),
          JSON.stringify({ reason: assessment.reason, timestamp: new Date().toISOString() }), 'utf-8');
        this.lastActionTime = Date.now();
        return assessment;
    }
  }

  private appendLog(action: SupervisorAction): void {
    const entry = [
      `## Tick ${action.tick} — ${action.timestamp}`,
      `Running: ${action.runningStages.join(', ')}`,
      `Source: ${action.source ?? 'supervisor (legacy)'}${action.targetAttemptIndex === undefined ? '' : ` · execution ${action.targetAttemptIndex}`}`,
      `Trigger: ${action.trigger.type} · ${action.trigger.eventId}`,
      `Trigger quantities: ${JSON.stringify(action.trigger.quantities)}`,
      `Verdict: **${action.assessment.verdict}**${action.assessment.targetStage ? ` → ${action.assessment.targetStage}` : ''}`,
      `Reason: ${action.assessment.reason}`,
    ];
    if (action.assessment.assessmentId) entry.push(`Assessment id: ${action.assessment.assessmentId}`);
    if (action.assessment.evidenceIds?.length) entry.push(`Cited evidence: ${action.assessment.evidenceIds.join(', ')}`);
    if (action.assessment.supersedesAssessmentId) entry.push(`Supersedes: ${action.assessment.supersedesAssessmentId}`);
    if (action.assessment.guidanceId) entry.push(`Guidance envelope: ${action.assessment.guidanceId}`);
    if (action.assessment.directionKey) {
      entry.push(`Direction key: ${action.assessment.directionKey}`);
    }
    if (action.directionEvidence) {
      entry.push(`Direction evidence: attempt ${action.directionEvidence.attemptIndex} · ${action.directionEvidence.generation}`);
    }
    if (action.assessment.guidance) {
      entry.push(`Guidance: ${action.assessment.guidance}`);
    }
    entry.push('');
    appendFileSync(this.logPath(), entry.join('\n') + '\n');
  }
}
