import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Adapter, AgentConfig } from './adapters/base.js';
import {
  resolveRunStatus,
  RUN_STATUS,
  runsRoot,
  TERMINAL_STATUSES as STORE_TERMINAL_STATUSES,
} from './store.js';
import type { RunStatus, StoreState } from './store.js';
import type { ResearchEvaluation, ResearchRound } from './research-policy.js';
import { readRunEvents } from './run-events.js';
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

const CODE_NARRATIVE_PROMPT = `You are summarizing a multi-agent coding run for the operator who launched it.
Write ONLY the following markdown sections, in this order, and nothing else:

## What was done
- 2-5 bullets describing WHAT changed and WHY (not the process). One line each.

## Key decisions
- notable choices the agents made (e.g. "used a lock instead of async", "split into 3 stages"). Omit this whole section if there were none worth noting.

## Risks / Notes
- anything the operator should verify or be aware of. Omit this whole section if none.

Hard rules:
- Do NOT write "Files changed", "Tests", or "Stages" sections — those are appended automatically from real data. Don't repeat file lists or test counts.
- Be concise, one line per bullet. Output ONLY the markdown sections above, no preamble, no closing remarks.`;

const RESEARCH_NARRATIVE_PROMPT = `You are summarizing a research / optimization run for the operator who launched it.
The metric outcome, per-round results, ship/ceiling decision, and changed files are appended automatically — do NOT repeat any of those numbers.
Write ONLY the following markdown sections, in this order, and nothing else:

## What was tried & learned
- 2-5 bullets: the directions/ideas explored across rounds and what the results imply. One line each.

## Next steps
- 1-3 bullets: what the operator should do next given the decision. One line each.

Be concise. Output ONLY the markdown sections above, no preamble.`;

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
 * exactly what the run touched. Returns hasGit:false (→ LLM fallback) when there
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
  if (!g.hasGit) return '';
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

// ---------------------------------------------------------------------------
// Tests: best-effort detection of test-result lines in stage outputs.
// ---------------------------------------------------------------------------

const TEST_LINE_RE = /(\d+\s+(passed|failed|passing|failing|skipped|errors?))|(=+\s*\d+\s+(passed|failed))|(\btest files?\b.*\d)/i;

function detectTestResults(stageOutputs: string[]): string[] {
  const hits = new Set<string>();
  for (const out of stageOutputs) {
    for (const raw of out.split('\n')) {
      const line = raw.trim().replace(/^[#>*\-\s]+/, '').trim();
      if (line.length === 0 || line.length > 160) continue;
      if (/\d/.test(line) && TEST_LINE_RE.test(line)) hits.add(line);
      if (hits.size >= 8) break;
    }
    if (hits.size >= 8) break;
  }
  return [...hits];
}

function renderTestsSection(stageOutputs: string[]): string {
  const hits = detectTestResults(stageOutputs);
  if (hits.length === 0) return '## Tests\n_No test results detected in stage outputs._';
  return `## Tests\n` + hits.map((h) => `- ${h}`).join('\n');
}

function renderStagesSection(state: StoreState): string {
  const ids = Object.keys(state.stages);
  const historical = state.stageEvidence ?? [];
  if (ids.length === 0 && historical.length === 0 && !state.supervisor) return '';
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
  return `## Stages\n${lines.join('\n')}`;
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

function renderRealityGateAdvisories(runDir: string): string {
  const report = readJson<{
    results?: Array<{ name?: unknown; type?: unknown; pass?: unknown; advisory?: unknown; details?: unknown }>;
  }>(join(runDir, '.reality-gate.json'));
  const advisories = Array.isArray(report?.results)
    ? report.results.filter((item) => item.advisory === true && item.pass === false)
    : [];
  if (advisories.length === 0) return '';
  const lines = advisories.map((item) => {
    const name = typeof item.name === 'string' ? item.name : 'unnamed check';
    const type = typeof item.type === 'string' ? ` (${item.type})` : '';
    const details = typeof item.details === 'string' ? `: ${item.details}` : '';
    return `- ${name}${type}${details}`;
  });
  return `## Reality-Gate advisories\n${lines.join('\n')}`;
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

// ---------------------------------------------------------------------------
// Stage-output collection (shared by both summary types).
// ---------------------------------------------------------------------------

function collectStageOutputs(runDir: string, state: StoreState): { joined: string; raw: string[] } {
  const blocks: string[] = [];
  const raw: string[] = [];
  const stagesDir = join(runDir, 'stages');
  const appendOutput = (outputPath: string, heading: string, status: string, durationMs?: number): void => {
    if (!existsSync(outputPath)) return;
    let output = readFileSync(outputPath, 'utf-8');
    raw.push(output);
    if (output.length > 3000) output = output.slice(0, 1500) + '\n...(truncated)...\n' + output.slice(-1500);
    const duration = durationMs ? `${Math.round(durationMs / 1000)}s` : '';
    blocks.push(`## ${heading} (${status}${duration ? ', ' + duration : ''})\n${output}`);
  };

  if (state.stageEvidence?.length) {
    for (const evidence of state.stageEvidence) {
      if (!evidence.outputPath) continue;
      appendOutput(
        join(runDir, evidence.outputPath),
        `Stage: ${evidence.stageId} [iteration ${evidence.iteration}, archived]`,
        evidence.status.status,
        evidence.status.duration_ms,
      );
    }
    for (const [stageId, status] of Object.entries(state.stages)) {
      appendOutput(join(stagesDir, stageId, 'output.md'), `Stage: ${stageId}`, status.status, status.duration_ms);
    }
  } else if (existsSync(stagesDir)) {
    // Legacy runs have no iteration-addressed ledger. Preserve their historical
    // directory scan so summaries remain backward compatible.
    for (const stageId of readdirSync(stagesDir)) {
      const outputPath = join(stagesDir, stageId, 'output.md');
      if (!existsSync(outputPath)) continue;
      const status = state.stages[stageId]?.status ?? 'unknown';
      appendOutput(outputPath, `Stage: ${stageId}`, status, state.stages[stageId]?.duration_ms);
    }
  }
  return { joined: blocks.join('\n\n'), raw };
}

// ---------------------------------------------------------------------------
// LLM narrative.
// ---------------------------------------------------------------------------

async function generateNarrative(
  projectDir: string,
  runDir: string,
  runId: string,
  state: StoreState,
  systemPrompt: string,
  factsBlock: string,
  stageOutputs: string,
  adapter: Adapter,
): Promise<string | null> {
  const prompt = `Summarize this run.

# Run Info
- Run ID: ${runId}
- Project: ${state.projectDir}
- Status: ${state.status}
- Task: ${(state.taskDescription ?? '').slice(0, 500)}
- Iterations: ${state.currentIteration ?? 1}/${state.maxIterations ?? '?'}

# Already-known facts (do NOT repeat these in your output)
${factsBlock || '(none)'}

# Stage Results
${stageOutputs || '(none)'}

# Dispatch Plan
${existsSync(join(runDir, 'dispatch.yaml')) ? readFileSync(join(runDir, 'dispatch.yaml'), 'utf-8').slice(0, 2000) : '(none)'}
`;

  const summaryAgent: AgentConfig = {
    name: 'summarizer',
    description: 'Run summary generator',
    // Use the adapter's default model rather than hardcoding 'sonnet': codex on a
    // ChatGPT account rejects 'sonnet' with a 400, which silently broke every
    // summary narrative. 'default' lets each adapter use whatever its account supports.
    model: 'default',
    reasoning_effort: 'low',
    tools: [],
    prompt: systemPrompt,
  };

  try {
    const result = await adapter.run(prompt, summaryAgent, {
      timeout_ms: 30000,
      workDir: projectDir,
      runDir,
      stageId: '_summary',
    });
    if (result.exitCode !== 0 || !result.output.trim()) {
      log.warn({ runId, exitCode: result.exitCode }, 'Narrative generation failed');
      return null;
    }
    const cleaned = extractFinalMessage(result.output);
    if (!cleaned) {
      log.warn({ runId }, 'Narrative empty after cleaning transcript');
      return null;
    }
    return cleaned;
  } catch (err) {
    log.warn({ runId, err }, 'Narrative generation threw');
    return null;
  }
}

function assemble(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join('\n\n').trim() + '\n';
}

export async function generateRunSummary(
  projectDir: string,
  runId: string,
  adapter: Adapter,
): Promise<string | null> {
  const runDir = join(runsRoot(), runId);
  if (!existsSync(join(runDir, 'run.json'))) return null;

  try {
    const state: StoreState = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'));
    if (!TERMINAL_STATUSES.has(state.status)) return null;

    const { joined: stageOutputs, raw: rawOutputs } = collectStageOutputs(runDir, state);
    const git = collectGitChanges(projectDir, state.baseCommit);
    const filesSection = renderFilesSection(git);
    const advisorySection = renderRealityGateAdvisories(runDir);
    const orchestrationSection = renderOrchestrationEvents(projectDir, runId);
    const stagesSection = renderStagesSection(state);
    const isResearch = !!state.research || existsSync(join(runDir, 'research_journal.json'));

    let summary: string;

    if (isResearch) {
      const research = readResearchData(runDir);
      const outcomeSection = renderResearchOutcome(state, research);
      const roundsSection = renderRoundsSection(research);
      const factsBlock = [outcomeSection, roundsSection, advisorySection, orchestrationSection, stagesSection, filesSection].filter(Boolean).join('\n\n');
      const narrative = await generateNarrative(
        projectDir, runDir, runId, state, RESEARCH_NARRATIVE_PROMPT, factsBlock, stageOutputs, adapter,
      );
      summary = assemble([
        '# Research Summary',
        outcomeSection,
        roundsSection,
        advisorySection,
        orchestrationSection,
        narrative ?? '## What was tried & learned\n_Summary narrative unavailable; see rounds and stage outputs above._',
        filesSection,
        stagesSection,
      ]);
    } else {
      const testsSection = renderTestsSection(rawOutputs);
      const factsBlock = [advisorySection, orchestrationSection, filesSection, testsSection, stagesSection].filter(Boolean).join('\n\n');
      const narrative = await generateNarrative(
        projectDir, runDir, runId, state, CODE_NARRATIVE_PROMPT, factsBlock, stageOutputs, adapter,
      );
      summary = assemble([
        '# Run Summary',
        narrative ?? '## What was done\n_Summary narrative unavailable; see stages and files below._',
        advisorySection,
        orchestrationSection,
        filesSection,
        testsSection,
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
