import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Adapter, AgentConfig } from './adapters/base.js';
import { runsRoot } from './store.js';
import type { StoreState } from './store.js';
import type { ResearchEvaluation, ResearchRound } from './research-policy.js';
import pino from 'pino';

const log = pino({ name: 'run-summary' });

// Statuses for which a human-readable summary is worth generating. Note this
// now includes the research terminal states (`shipped`, `ceiling_hit`) — those
// runs previously produced no summary at all.
const TERMINAL_STATUSES = new Set([
  'complete',
  'failed',
  'shipped',
  'ceiling_hit',
  'escalated',
  'reality_gate_failed',
]);

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
  if (ids.length === 0) return '';
  const lines = ids.map((id) => {
    const st = state.stages[id];
    const dur = st?.duration_ms ? ` (${Math.round(st.duration_ms / 1000)}s)` : '';
    return `- ${id}: ${st?.status ?? 'unknown'}${dur}`;
  });
  return `## Stages\n${lines.join('\n')}`;
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
  const decisionLabel = data.decision?.decision ?? (state.status === 'shipped' ? 'ship' : state.status === 'ceiling_hit' ? 'stop_ceiling' : state.status);
  lines.push(`- **Decision:** ${decisionLabel}${data.decision?.reason ? ` — ${data.decision.reason}` : ''}`);
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
  const lines = shown.map((r) => `- ${r.label}: ${fmtNum(r.result)}${kept.has(r.label) ? ' ✓ kept' : ''}`);
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
  if (existsSync(stagesDir)) {
    for (const stageId of readdirSync(stagesDir)) {
      const outputPath = join(stagesDir, stageId, 'output.md');
      if (!existsSync(outputPath)) continue;
      let output = readFileSync(outputPath, 'utf-8');
      raw.push(output);
      if (output.length > 3000) output = output.slice(0, 1500) + '\n...(truncated)...\n' + output.slice(-1500);
      const status = state.stages[stageId]?.status ?? 'unknown';
      const duration = state.stages[stageId]?.duration_ms ? `${Math.round(state.stages[stageId].duration_ms! / 1000)}s` : '';
      blocks.push(`## Stage: ${stageId} (${status}${duration ? ', ' + duration : ''})\n${output}`);
    }
  }
  return { joined: blocks.join('\n\n'), raw };
}

// ---------------------------------------------------------------------------
// LLM narrative.
// ---------------------------------------------------------------------------

/**
 * Strip CLI transcript noise to recover just the agent's final message.
 *
 * The codex `exec` adapter returns the entire CLI session on stdout: a banner,
 * the fully echoed prompt (which itself contains prior stage transcripts), then
 * the real answer introduced by a lone `codex` line and followed by a
 * `tokens used\n<n>` footer. We keep the text after the LAST `codex` marker and
 * drop that footer (and any reprint after it). The claude adapter already returns
 * clean text — no markers — so this is a no-op there.
 */
export function extractFinalMessage(raw: string): string {
  let text = raw;
  const marker = /\n\s*codex\s*\n/g;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text)) !== null) lastEnd = m.index + m[0].length;
  if (lastEnd >= 0) text = text.slice(lastEnd);
  text = text.replace(/\n\s*tokens used\s*\n[\d,]+[\s\S]*$/i, '');
  return text.trim();
}

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
    const isResearch = !!state.research || existsSync(join(runDir, 'research_journal.json'));

    let summary: string;

    if (isResearch) {
      const research = readResearchData(runDir);
      const outcomeSection = renderResearchOutcome(state, research);
      const roundsSection = renderRoundsSection(research);
      const factsBlock = [outcomeSection, roundsSection, filesSection].filter(Boolean).join('\n\n');
      const narrative = await generateNarrative(
        projectDir, runDir, runId, state, RESEARCH_NARRATIVE_PROMPT, factsBlock, stageOutputs, adapter,
      );
      summary = assemble([
        '# Research Summary',
        outcomeSection,
        roundsSection,
        narrative ?? '## What was tried & learned\n_Summary narrative unavailable; see rounds and stage outputs above._',
        filesSection,
      ]);
    } else {
      const testsSection = renderTestsSection(rawOutputs);
      const stagesSection = renderStagesSection(state);
      const factsBlock = [filesSection, testsSection].filter(Boolean).join('\n\n');
      const narrative = await generateNarrative(
        projectDir, runDir, runId, state, CODE_NARRATIVE_PROMPT, factsBlock, stageOutputs, adapter,
      );
      summary = assemble([
        '# Run Summary',
        narrative ?? '## What was done\n_Summary narrative unavailable; see stages and files below._',
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
