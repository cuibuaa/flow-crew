import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Adapter } from './adapters/base.js';
import { projectRunStageHistory } from './run-state-view.js';
import { HANDOFF_SCHEMA, parseStageRecord, stageRecordSchema } from './handoff.js';
import { PLAN_SCHEMA } from './plan-interface.js';
import type { ValidationCommandResult } from './project-validation.js';
import {
  resolveRunStatus,
  readRunState,
  RUN_STATUS,
  STAGE_STATUS,
  runsRoot,
  TERMINAL_STATUSES as STORE_TERMINAL_STATUSES,
} from './store.js';
import type { RunStatus, StageStatus, StoreState } from './store.js';
import type { ResearchEvaluation, ResearchRound } from './research-policy.js';
import { readRunEvents } from './run-events.js';
import { archivedGateRejections } from './scheduler/sched_settlement/gate-archives.js';
// Re-exported for back-compat + the unit test. The codex adapter now applies this
// at the source (output.md/handoff/summary all get clean text); re-applying it
// here is idempotent.
import { extractFinalMessage } from './adapters/transcript.js';
export { extractFinalMessage };
import { createLogger } from './logging.js';

const log = createLogger({ name: 'run-summary' });

// Statuses for which a human-readable summary is worth generating. Note this
// now includes the research terminal states (`shipped`, `ceiling_hit`) — those
// runs previously produced no summary at all.
// Derived from the engine's single source of truth — this set was hand-copied
// and had already drifted (missing phase_complete / stopped / incomplete).
// A paused ('parked') run is deliberately absent: it has no verdict to narrate.
const TERMINAL_STATUSES = new Set<string>(STORE_TERMINAL_STATUSES);

/** Research-summary spelling is a separate operator consequence, so it is total here. */
export const RESEARCH_SUMMARY_DECISION_LABELS = {
  [RUN_STATUS.PENDING]: RUN_STATUS.PENDING,
  [RUN_STATUS.RUNNING]: RUN_STATUS.RUNNING,
  [RUN_STATUS.PARKED]: RUN_STATUS.PARKED,
  [RUN_STATUS.COMPLETE]: RUN_STATUS.COMPLETE,
  [RUN_STATUS.FAILED]: RUN_STATUS.FAILED,
  [RUN_STATUS.AWAITING_APPROVAL]: RUN_STATUS.AWAITING_APPROVAL,
  [RUN_STATUS.SHIPPED]: 'ship',
  [RUN_STATUS.CEILING_HIT]: 'stop_ceiling',
  [RUN_STATUS.ESCALATED]: RUN_STATUS.ESCALATED,
  [RUN_STATUS.REALITY_GATE_FAILED]: RUN_STATUS.REALITY_GATE_FAILED,
  [RUN_STATUS.PHASE_COMPLETE]: RUN_STATUS.PHASE_COMPLETE,
  [RUN_STATUS.STOPPED]: RUN_STATUS.STOPPED,
  [RUN_STATUS.INCOMPLETE]: RUN_STATUS.INCOMPLETE,
} as const satisfies Record<RunStatus, string>;

// ---------------------------------------------------------------------------
// Git: compute the REAL set of changed files since the run started.
// ---------------------------------------------------------------------------

interface ChangedFile {
  path: string;
  added: number | null;
  deleted: number | null;
}

interface GitChanges {
  hasGit: boolean;
  files: ChangedFile[];
  commits: string[];
  truncated: boolean;
}

const NO_GIT: GitChanges = { hasGit: false, files: [], commits: [], truncated: false };
const MAX_FILES = 40;

function runGit(projectDir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch { /* not a git repo, bad ref, or git unavailable */
    return null;
  }
}

/**
 * Diff the working tree against the commit recorded at run start. Captures both
 * committed and uncommitted changes plus untracked files, so the summary reflects
 * exactly what the run touched. Returns hasGit:false (→ labelled unavailable measurement) when there
 * is no base commit or the project is not a git repo.
 */
function collectGitChanges(projectDir: string, baseCommit?: string): GitChanges {
  if (!baseCommit) return NO_GIT;
  const numstat = runGit(projectDir, ['diff', '--numstat', baseCommit]);
  if (numstat === null) return NO_GIT;

  const fileMap = new Map<string, ChangedFile>();
  for (const line of numstat.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? null : Number(parts[0]);
    const deleted = parts[1] === '-' ? null : Number(parts[1]);
    const path = parts.slice(2).join('\t');
    fileMap.set(path, {
      path,
      added: Number.isFinite(added as number) ? (added as number) : null,
      deleted: Number.isFinite(deleted as number) ? (deleted as number) : null,
    });
  }

  // Untracked new files don't show up in `git diff`; pull them from status.
  const porcelain = runGit(projectDir, ['status', '--porcelain']);
  if (porcelain) {
    for (const line of porcelain.split('\n').filter(Boolean)) {
      const status = line.slice(0, 2);
      const path = line.slice(3);
      if (status.includes('?') && path && !fileMap.has(path)) {
        fileMap.set(path, { path, added: null, deleted: null });
      }
    }
  }

  const commitsRaw = runGit(projectDir, ['log', '--format=%h %s', `${baseCommit}..HEAD`]);
  const commits = commitsRaw ? commitsRaw.split('\n').filter(Boolean) : [];

  const files = [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    hasGit: true,
    files: files.slice(0, MAX_FILES),
    commits: commits.slice(0, 20),
    truncated: files.length > MAX_FILES,
  };
}

function renderFilesSection(g: GitChanges): string {
  if (!g.hasGit) return '## Files changed\n\nGit measurement unavailable; stage-reported paths appear in the results.';
  if (g.files.length === 0) {
    return '## Files changed\n_No file changes since run start._';
  }
  const lines = g.files.map((f) => {
    const counts = f.added != null || f.deleted != null ? ` (+${f.added ?? 0}/-${f.deleted ?? 0})` : '';
    return `- \`${f.path}\`${counts}`;
  });
  let out = `## Files changed (${g.files.length}${g.truncated ? '+' : ''})\n${lines.join('\n')}`;
  if (g.truncated) out += `\n- …and more`;
  if (g.commits.length) {
    out += `\n\n**Commits (${g.commits.length}):**\n` + g.commits.map((c) => `- ${c}`).join('\n');
  }
  return out;
}

function renderStagesSection(state: StoreState): string {
  const ids = Object.keys(state.stages);
  const diagnostics: string[] = [];
  const historical = projectRunStageHistory(state, diagnostic => diagnostics.push(
    `- ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.detail}`,
  ));
  if (ids.length === 0 && historical.length === 0 && !state.supervisor && diagnostics.length === 0) return '';
  const lines = ids.map((id) => {
    const st = state.stages[id];
    const attempts = st?.attempts?.length ?? 0;
    const dur = Math.round((st?.duration_ms ?? 0) / 1000);
    const history = attempts > 0
      ? ` — ran ${attempts} ${attempts === 1 ? 'time' : 'times'}, ${dur}s cumulative`
      : (st?.duration_ms ? ` (${dur}s)` : '');
    return `- ${id}: ${st?.status ?? 'unknown'}${history}`;
  });
  for (const evidence of historical) {
    const attempts = evidence.status.attempts?.length ?? 0;
    const dur = Math.round((evidence.status.duration_ms ?? 0) / 1000);
    const history = attempts > 0
      ? ` — ran ${attempts} ${attempts === 1 ? 'time' : 'times'}, ${dur}s cumulative`
      : (evidence.status.duration_ms ? ` (${dur}s)` : '');
    lines.push(`- ${evidence.stageId} [iteration ${evidence.iteration}, archived]: ${evidence.status.status}${history}`);
  }
  if (state.supervisor) {
    const tokensTotal = state.supervisor.tokens_in + state.supervisor.tokens_out;
    lines.push(`- _supervisor: ${state.supervisor.calls} calls, ${Math.round(state.supervisor.duration_ms / 1000)}s cumulative, ${tokensTotal} tokens total (${state.supervisor.tokens_in} in + ${state.supervisor.tokens_out} out)`);
  }
  return `## Stages\n${[...lines, ...diagnostics].join('\n')}`;
}

function renderOrchestrationEvents(projectDir: string, runId: string): string {
  const events = readRunEvents(projectDir, runId).filter((event) =>
    event.type === 'parallel_scope_serialized' || event.type === 'parallel_write_conflict',
  );
  if (events.length === 0) return '';
  const lines = events.map((event) => {
    const label = event.type === 'parallel_write_conflict' ? 'WARNING write conflict' : 'scope serialization';
    return `- ${label}: ${event.detail ?? event.stageIds?.join(' ↔ ') ?? 'no detail'}`;
  });
  return `## Orchestration notes\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Research: deterministic outcome + rounds from the framework-owned journal.
// ---------------------------------------------------------------------------

interface ResearchData {
  rounds: ResearchRound[];
  decision: ResearchEvaluation | null;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch { /* missing or malformed */
    return null;
  }
}

function renderRealityGateChecks(runDir: string): string {
  const report = readJson<{ results?: Array<{ name?: string; type?: string; pass?: boolean;
    advisory?: boolean; details?: string; evidence?: { command?: string; exit?: { code?: number | null } } }> }>(join(runDir, '.reality-gate.json'));
  if (!Array.isArray(report?.results)) return '';
  const render = (items: NonNullable<typeof report>['results']): string => (items ?? []).map(item => {
    const command = typeof item.evidence?.command === 'string' ? `; command: \`${item.evidence.command}\`` : '';
    const exit = item.evidence?.exit;
    return `- ${item.name ?? 'unnamed check'} (${item.type ?? 'unknown type'}): ${item.pass === true ? 'PASS' : item.pass === false ? 'FAIL' : 'unknown'} — ${item.details ?? 'no details'}${command}${exit ? `; direct exit ${exit.code ?? 'unknown'}` : ''}`;
  }).join('\n');
  const hard = report.results.filter(item => item && item.advisory !== true);
  const advisory = report.results.filter(item => item && item.advisory === true && item.pass === false);
  return [hard.length ? `## Reality-Gate checks\n\nReceipt: \`.reality-gate.json\`\n\n${render(hard)}` : '',
    advisory.length ? `## Reality-Gate advisories\n\n${render(advisory)}` : ''].filter(Boolean).join('\n\n');
}

function readResearchData(runDir: string): ResearchData {
  const journal = readJson<{ rounds?: ResearchRound[] }>(join(runDir, 'research_journal.json'));
  const decision = readJson<ResearchEvaluation>(join(runDir, 'research_decision.json'));
  return { rounds: Array.isArray(journal?.rounds) ? journal!.rounds! : [], decision };
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function renderResearchOutcome(state: StoreState, data: ResearchData): string {
  const rc = state.research;
  const higherIsBetter = rc?.higherIsBetter ?? true;
  const baseline = rc?.baseline;
  const best = data.decision?.runningBest;
  const lines: string[] = [];
  // FIX C — the Decision label must derive from the TERMINAL run.json status, not the
  // research_decision.json snapshot, which can be STALE: rounds integrity-rejected after the
  // last decision write never refresh it, so a snapshot reading `continue`/`ship` can contradict
  // a true terminal `ceiling_hit`/`incomplete`. When the run is terminal, the run.json status is
  // authoritative; the snapshot `reason` is only used as supplementary text and only when the
  // snapshot is consistent with the terminal status (else it would echo a stale rationale).
  const statusResolution = resolveRunStatus(state.status);
  const isTerminal = statusResolution.kind === 'known'
    && TERMINAL_STATUSES.has(statusResolution.status);
  // Map the terminal status to the policy-decision vocabulary used in the summary.
  const terminalDecisionLabel = statusResolution.kind === 'known'
    ? RESEARCH_SUMMARY_DECISION_LABELS[statusResolution.status]
    : `unrecognized ${statusResolution.display}`;
  // The snapshot is "consistent" with the terminal only when it agrees (e.g. a real ship snapshot
  // on a shipped run, or a stop_ceiling snapshot on a ceiling_hit run). A `continue` snapshot on a
  // terminal run is by definition stale.
  const snapshotConsistent = isTerminal && data.decision?.decision === terminalDecisionLabel;
  const decisionLabel = isTerminal ? terminalDecisionLabel : (data.decision?.decision ?? state.status);
  const reasonSuffix = snapshotConsistent && data.decision?.reason ? ` — ${data.decision.reason}`
    : (!isTerminal && data.decision?.reason ? ` — ${data.decision.reason}` : '');
  lines.push(`- **Decision:** ${decisionLabel}${reasonSuffix}`);
  if (typeof baseline === 'number' && typeof best === 'number') {
    const delta = best - baseline;
    const improved = higherIsBetter ? delta > 0 : delta < 0;
    const pct = baseline !== 0 ? ` (${delta >= 0 ? '+' : ''}${((delta / Math.abs(baseline)) * 100).toFixed(2)}%)` : '';
    lines.push(`- **Metric:** baseline ${fmtNum(baseline)} → best ${fmtNum(best)}${pct} ${improved ? '↑ improved' : '→ no improvement'}`);
  } else if (typeof best === 'number') {
    lines.push(`- **Running-best:** ${fmtNum(best)}`);
  }
  lines.push(`- **Rounds:** ${data.rounds.length}${data.decision ? ` | kept: ${data.decision.keptLabels.length} | no-improvement streak: ${data.decision.consecutiveNoImprovement}` : ''}`);
  const wall = data.rounds.at(-1)?.wallHoursCumulative;
  if (typeof wall === 'number') lines.push(`- **Wall time:** ${wall.toFixed(1)}h`);
  return `## Outcome\n${lines.join('\n')}`;
}

function renderRoundsSection(data: ResearchData): string {
  if (data.rounds.length === 0) return '';
  const kept = new Set(data.decision?.keptLabels ?? []);
  const MAX = 25;
  const shown = data.rounds.slice(-MAX);
  const lines = shown.map((r) => r.outcome === 'no_candidate'
    ? `- ${r.label}: no candidate${r.reason ? ` — ${r.reason}` : ''}`
    : `- ${r.label}: ${typeof r.result === 'number' ? fmtNum(r.result) : 'invalid measurement'}${kept.has(r.label) ? ' ✓ kept' : ''}`);
  let out = `## Rounds (${data.rounds.length})\n${lines.join('\n')}`;
  if (data.rounds.length > MAX) out = `## Rounds (${data.rounds.length}, showing last ${MAX})\n${lines.join('\n')}`;
  return out;
}

// Records retain their execution identity: a rejected review or failed check
// stays visible even when a later repair succeeds. Legacy prose is linked, never
// mined for guessed commands, exits or test counts.
function renderStageRecords(runDir: string, state: StoreState): { details: string; conclusions: string } {
  const sections: string[] = [];
  const conclusions: string[] = [];
  const append = (id: string, status: StageStatus, outputPath: string | undefined,
    attemptPaths: Array<{ attemptIndex: number; path: string }>, archived = ''): void => {
    const attempts = status.attempts ?? [];
    const records = attempts.length ? attempts.map((attempt, index) => ({
      label: `${id}${archived}, execution ${attempt.index} (${attempt.status}, exit ${attempt.exitCode ?? 'unknown'})`,
      path: attemptPaths.find(entry => entry.attemptIndex === attempt.index && existsSync(join(runDir, entry.path)))?.path
        ?? (index === attempts.length - 1 ? outputPath : undefined),
      error: attempt.error, latest: index === attempts.length - 1,
    })) : [{ label: `${id}${archived} (${status.status}, exit ${status.exitCode ?? 'unknown'})`, path: outputPath, error: status.error, latest: true }];
    for (const entry of records) {
      const lines = [`### ${entry.label}`];
      if (entry.error) lines.push(`Failure: ${entry.error}`);
      if (!entry.path || !existsSync(join(runDir, entry.path))) {
        lines.push('Result unavailable; no checks inferred.');
        sections.push(lines.join('\n\n'));
        continue;
      }
      lines.push(`Record: \`${entry.path}\``);
      try {
        const output = readFileSync(join(runDir, entry.path), 'utf8');
        const value = JSON.parse(output) as Record<string, unknown>;
        if (Array.isArray(value.stages)) {
          const plan = parseStageRecord(output, PLAN_SCHEMA);
          lines.push(`Plan: ${(plan.stages as Array<{ id: string }>).map(stage => stage.id).join(', ')}.`);
        } else if (typeof value.pass === 'boolean') {
          const record = parseStageRecord(output, stageRecordSchema({ isGate: true,
            criterionRefs: Object.keys(value.criteria ?? {}), extendedVerdict: true }));
          lines.push(`Independent verdict: ${record.pass ? 'PASS' : 'FAIL'} — ${record.reason}`);
          const criteria = record.criteria as Record<string, { status: string; evidence: string }>;
          for (const [id, criterion] of Object.entries(criteria)) lines.push(`- ${id}: ${criterion.status} — ${criterion.evidence}`);
          const findings = record.audit_findings as { findings: Array<{ id: string; reason: string; paths: string[] }> };
          for (const finding of findings.findings) lines.push(`- Finding ${finding.id}: ${finding.reason} (${finding.paths.join(', ')})`);
          if (record.repairability) {
            const repair = record.repairability as { disposition: string; evidence: string };
            lines.push(`Repairability: ${repair.disposition} — ${repair.evidence}`);
          }
        } else {
          const record = parseStageRecord(output, HANDOFF_SCHEMA);
          const conclusion = `${id}${archived}: ${record.status} — ${record.summary}`;
          if (entry.latest) conclusions.push(`- ${conclusion}`);
          else lines.push(conclusion);
          const files = record.files_modified as string[];
          if (files.length) lines.push(`Reported files: ${files.map(file => `\`${file}\``).join(', ')}`);
          const checks = record.checks as Array<{ command: string; exit_code: number; evidence: string }>;
          if (checks.length) lines.push('Stage-reported checks:\n' + checks.map(check =>
            `- \`${check.command}\` — exit ${check.exit_code}; evidence: ${check.evidence}`).join('\n'));
          else lines.push('No stage-reported checks.');
          const caveats = record.caveats as string[];
          if (caveats.length) lines.push('Caveats / open work:\n' + caveats.map(caveat => `- ${caveat}`).join('\n'));
        }
      } catch {
        lines.push('Typed result unavailable or invalid; read the record for legacy output or diagnostics. No checks inferred.');
      }
      sections.push(lines.join('\n\n'));
    }
  };
  for (const evidence of state.stageEvidence ?? []) append(evidence.stageId, evidence.status,
    evidence.outputPath, evidence.attemptOutputPaths, ` [iteration ${evidence.iteration}, archived]`);
  for (const [id, status] of Object.entries(state.stages)) {
    if (status.status === STAGE_STATUS.SKIPPED || status.status === STAGE_STATUS.PENDING) continue;
    const directory = `stages/${id}`;
    append(id, status, `${directory}/output.md`, (status.attempts ?? []).map(attempt =>
      ({ attemptIndex: attempt.index, path: `${directory}/output_attempt_${attempt.index}.md` }))
      .filter(entry => existsSync(join(runDir, entry.path))));
  }
  return { details: '## Stage results\n\n' + (sections.join('\n\n') || 'No stage results recorded.'),
    conclusions: '## What was done\n\n' + (conclusions.join('\n') || 'No typed work summaries recorded; see stage results.') };
}

/** Preserve the scheduler's archived conclusion separately from the authored
 * verdict, including after a repair or replan succeeds. */
function renderEngineGateConclusions(runDir: string, state: StoreState): string {
  const sections: string[] = [];
  const ids = new Set([...Object.keys(state.stages),
    ...(state.stageEvidence ?? []).map(entry => entry.stageId),
    ...(state.retiredStageUsage ?? []).map(entry => entry.stageId)]);
  for (const id of ids) {
    for (const archive of archivedGateRejections(runDir, id)) {
      const lines = [`### ${id} [${archive.iteration ? `iteration ${archive.iteration}` : 'legacy iteration unknown'}, round ${archive.round}]`,
        `Engine record: \`${relative(runDir, archive.effectiveVerdictPath)}\`; authored verdict: \`${relative(runDir, archive.verdictPath)}\`.`];
      const record = readJson<{ gateId: string; written_verdict_pass: boolean | null;
        engine_effective_pass: boolean; engine_rejection_reason: string | null }>(archive.effectiveVerdictPath);
      if (!record || record.gateId !== id || typeof record.engine_effective_pass !== 'boolean'
        || (record.written_verdict_pass !== null && typeof record.written_verdict_pass !== 'boolean')
        || (record.engine_rejection_reason !== null && typeof record.engine_rejection_reason !== 'string')) {
        lines.push('Engine conclusion unavailable or invalid; archived rejection remains recorded. No effective verdict inferred.');
      } else {
        lines.push(`Archived authored verdict: ${record.written_verdict_pass === null ? 'unknown' : record.written_verdict_pass ? 'PASS' : 'FAIL'}.`,
          `Engine effective verdict: ${record.engine_effective_pass ? 'PASS' : 'FAIL'} — ${record.engine_rejection_reason || 'Reason unavailable in engine record.'}`);
      }
      sections.push(lines.join('\n\n'));
    }
  }
  return sections.length ? '## Engine gate conclusions\n\n' + sections.join('\n\n') : '';
}

/** Render command receipts, not test claims recovered from agent prose. Alias
 * receipts name their immutable version so a reader can reproduce this view.
 * Keep earlier validation failures; bound aliases of the same execution deduplicate. */
function renderValidation(runDir: string): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(runDir).filter(name => /^validation_delta_.+\.json$/.test(name)).sort()) {
    const receipt = readJson<{ stageId: string; checkedAt: string; pass: boolean;
      immutablePath?: string; current: ValidationCommandResult[];
      delta: Array<{ role: string; display?: string; state: string; reason: string }> }>(join(runDir, name));
    if (!receipt || !Array.isArray(receipt.current) || !Array.isArray(receipt.delta)) {
      sections.push(`- ${name}: validation receipt unavailable or invalid.`);
      continue;
    }
    const identity = JSON.stringify([receipt.stageId, receipt.checkedAt, receipt.current, receipt.delta]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const lines = [`### ${receipt.stageId} — comparison ${receipt.pass ? 'passed' : 'failed/unresolved'}`,
      `Checked: ${receipt.checkedAt ?? 'unknown'}; receipt: \`${receipt.immutablePath || name}\`.`];
    for (const result of receipt.current) {
      if (!result || typeof result.output !== 'string' || !Array.isArray(result.failureIdentifiers)) {
        lines.push('Command receipt unavailable or invalid; no exit or totals inferred.');
        continue;
      }
      lines.push(`- \`${result.display ?? result.role}\` — ${result.state}; direct exit ${Number.isInteger(result.exitCode) ? result.exitCode : 'unknown'}; ${result.durationMs}ms${result.reason ? `; ${result.reason}` : ''}`);
      // These are labelled raw collector excerpts, never a synthesized total.
      const totals = stripVTControlCharacters(result.output).split('\n').filter(line => /^(?:\s*(?:Test Files|Tests)\s+\d|# (?:tests|pass|fail|cancelled|skipped|todo) \d|.*\b\d+ (?:passed|failed|skipped).* in [\d.]+s)/.test(line));
      if (totals.length) lines.push('Collector test totals:\n```text\n' + totals.join('\n') + '\n```');
      else if (result.role === 'test') lines.push('Test totals unavailable in collector output; see receipt.');
      for (const failure of result.failureIdentifiers) lines.push(`  - Failure: ${failure}`);
    }
    for (const delta of receipt.delta) lines.push(delta
      ? `- ${delta.display ?? delta.role} baseline comparison: ${delta.state} — ${delta.reason}`
      : 'Baseline comparison entry unavailable or invalid.');
    sections.push(lines.join('\n\n'));
  }
  return '## Configured validation\n\n' + (sections.join('\n\n') || 'No engine validation receipts recorded; configured verification is unreported.');
}

function renderRunOutcome(state: StoreState): string {
  const lines = [`## Run outcome`, `Status: **${state.status}**`, `Run: \`${state.runId}\``];
  if (state.taskDescription) {
    const task = state.taskDescription.replace(/\s+/g, ' ').trim();
    lines.push(`Recorded task${task.length > 500 ? ' (excerpt)' : ''}: ${task.slice(0, 500)}${task.length > 500 ? '…' : ''}`);
  }
  if (state.failureReason) lines.push(`Failure / open work: ${state.failureReason}`);
  if (state.startedAt && state.completedAt) {
    const elapsed = Date.parse(state.completedAt) - Date.parse(state.startedAt);
    if (Number.isFinite(elapsed)) lines.push(`Elapsed run wall time: ${elapsed}ms. Stage durations below are cumulative execution time, not elapsed run time.`);
  }
  const unfinished = Object.entries(state.stages).filter(([, status]) => status.status === STAGE_STATUS.PENDING || status.status === STAGE_STATUS.RUNNING || status.status === STAGE_STATUS.FAILED);
  if (unfinished.length) lines.push('Unfinished / failed stages: ' + unfinished.map(([id, status]) => `${id}: ${status.status}`).join(', '));
  return lines.join('\n\n');
}

function assemble(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join('\n\n').trim() + '\n';
}

export async function generateRunSummary(
  projectDir: string,
  runId: string,
  _adapter?: Adapter,
): Promise<string | null> {
  const runDir = join(runsRoot(), runId);
  if (!existsSync(join(runDir, 'run.json'))) return null;

  try {
    const state: StoreState = readRunState(projectDir, runId);
    if (!TERMINAL_STATUSES.has(state.status)) return null;

    const records = renderStageRecords(runDir, state);
    const engineGateSection = renderEngineGateConclusions(runDir, state);
    const validationSection = renderValidation(runDir);
    const runOutcome = renderRunOutcome(state);
    const git = collectGitChanges(projectDir, state.baseCommit);
    const filesSection = renderFilesSection(git);
    const advisorySection = renderRealityGateChecks(runDir);
    const orchestrationSection = renderOrchestrationEvents(projectDir, runId);
    const stagesSection = renderStagesSection(state);
    const isResearch = !!state.research || existsSync(join(runDir, 'research_journal.json'));

    let summary: string;

    if (isResearch) {
      const research = readResearchData(runDir);
      const outcomeSection = renderResearchOutcome(state, research);
      const roundsSection = renderRoundsSection(research);
      summary = assemble([
        '# Research Summary',
        runOutcome,
        outcomeSection,
        roundsSection,
        advisorySection,
        orchestrationSection,
        records.conclusions,
        records.details,
        engineGateSection,
        validationSection,
        filesSection,
        stagesSection,
      ]);
    } else {
      summary = assemble([
        '# Run Summary',
        runOutcome,
        records.conclusions,
        records.details,
        engineGateSection,
        advisorySection,
        orchestrationSection,
        filesSection,
        validationSection,
        stagesSection,
      ]);
    }

    writeFileSync(join(runDir, 'summary.md'), summary, 'utf-8');
    log.info({ runId, isResearch, hasGit: git.hasGit, files: git.files.length }, 'Run summary generated');
    return summary;
  } catch (err) {
    log.warn({ runId, err }, 'Failed to generate run summary');
    return null;
  }
}
