/** Review routing receives facts from engine/git authorities, never author narrative. */
import { execFileSync } from 'node:child_process';
import type { StoreState } from './store.js';
import { POST_AUTHOR_PROMPT, CHOOSER_PROMPT } from './decision-graph.js';
import type { StageConfig } from './scheduler/sched_admission/configuration.js';
import { readEvidence, stagePredecessor } from './evidence-ledger.js';
import { adapterInputLimit, INPUT_RESERVE_CHARS } from './config.js';
import type { Adapter } from './adapters/base.js';

const MAX_BUFFER = 8_000_000;
const git = (projectDir: string, args: string[]) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_BUFFER });
const escapedLength = (text: string) => JSON.stringify(text).length - 2;

/** Every changed path, whatever the size of the change. */
export function changedPaths(projectDir: string, state: StoreState): string[] {
  try {
    return [...new Set([...git(projectDir, ['diff', '--name-only', '-z', state.baseCommit ?? 'HEAD', '--']).split('\0'),
      ...git(projectDir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))];
  } catch { return []; }
}

/**
 * Today's facts when their JSON fits in `room` characters. The diff is all or nothing: one file past the bound and
 * no diff text is built, only how many files changed and how far the count got ("atLeast"). Nothing here ranks files.
 */
export function reviewFacts(projectDir: string, directory: string, state: StoreState, room: number): { files: string[]; diff: string; validation: unknown } | { files: number; atLeast: number } {
  const validation = readEvidence(directory).filter(entry => entry.kind === 'validation').at(-1)
    ?? { status: 'No configured validation facts have been recorded.' };
  let diff = '', files: string[] = [], used = JSON.stringify(validation).length;
  try {
    const base = state.baseCommit ?? 'HEAD';
    files = git(projectDir, ['diff', '--name-only', '-z', base, '--']).split('\0').filter(Boolean);
    diff = git(projectDir, ['diff', '--no-ext-diff', '--no-textconv', base, '--']);
    used += escapedLength(diff);
    const untracked = git(projectDir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    files.push(...untracked);
    for (const file of untracked) {
      if (used > room) break;
      let added: string;
      // Git no-index includes added file bytes without custom diff parsing.
      try { added = git(projectDir, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file]); }
      catch (error) {
        if ((error as { code?: string }).code === 'ENOBUFS') { used += Math.ceil(MAX_BUFFER / 3); break; } // more than MAX_BUFFER bytes: at least a third as many characters
        added = (error as { stdout?: string }).stdout ?? '';
      }
      diff += added;
      used += escapedLength(added);
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOBUFS') diff = 'Diff unavailable; choose full review and investigate independently.';
    else used += Math.ceil(MAX_BUFFER / 3);
  }
  files = [...new Set(files)];
  used += JSON.stringify(files).length;
  return used > room ? { files: files.length, atLeast: used } : { files, diff, validation };
}
/** An adapter that returns a decision the engine has already made from bounded facts: no model call. */
const decidedBy = (output: string): Adapter => ({ run: async () => ({ output, exitCode: 0, duration_ms: 0 }) });

/**
 * `inputLimit` is the adapter's declared limit in characters. The assessor gets the complete diff or none of it:
 * when the diff does not fit, `decided` is the engine's own record (`review_full`, reason code `diff_exceeds_inline_bound`),
 * `adapter` runs it without a model call, and the full independent review reads the worktree itself.
 */
export function decisionInput(stage: StageConfig, projectDir: string, directory: string, state: StoreState, inputLimit = adapterInputLimit()): { system: string; user: string; adapter?: Adapter } {
  const predecessor = stagePredecessor(readEvidence(directory), stage.id, state.stages[stage.id]?.attempts?.at(-1));
  if (stage.decision?.kind === 'shape') return { system: CHOOSER_PROMPT,
    user: JSON.stringify({ task: state.taskDescription, research: state.research ?? null, predecessor }) };
  const room = inputLimit - INPUT_RESERVE_CHARS - JSON.stringify({ task: state.taskDescription, predecessor }).length;
  const facts = reviewFacts(projectDir, directory, state, room);
  const system = POST_AUTHOR_PROMPT.replaceAll('review_full', stage.decision!.successors[1]).replaceAll('Select review (', `Select ${stage.decision!.successors[0]} (`);
  if (!('atLeast' in facts)) return { system, user: JSON.stringify({ task: state.taskDescription, ...facts, predecessor }) };
  return { system, user: JSON.stringify({ task: state.taskDescription, changed_files: facts.files, diff_chars_at_least: facts.atLeast, inline_bound: room }),
    adapter: decidedBy(JSON.stringify({ successor: stage.decision!.successors[1], risk_areas: [],
      reason: `diff_exceeds_inline_bound: the diff is at least ${facts.atLeast} characters across ${facts.files} changed files, over the ${room} characters that fit the adapter's input limit of ${inputLimit}; the full independent review reads the worktree.` })) };
}
export function focusedReviewInput(projectDir: string, directory: string, state: StoreState, assessmentId?: string, _reviewer?: StageConfig): string {
  const risk = state.decisionGraph?.records.filter(record => assessmentId ? record.stageId === assessmentId : record.risk_areas).at(-1);
  return `# Independent review facts\n${JSON.stringify({ assessment: risk })}\nRun your own targeted experiments for these risks. Evaluate every assigned criterion. The risks guide exploration; they do not prove correctness or narrow the brief. Do not read author transcripts or adopt author self-assessment.`;
}
