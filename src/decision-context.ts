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

/** Complete legacy facts, or bounded counts. Any unreadable piece makes the whole diff unavailable. */
export function reviewFacts(projectDir: string, directory: string, state: StoreState, room: number) {
  const validation = readEvidence(directory).filter(entry => entry.kind === 'validation').at(-1)
    ?? { status: 'No configured validation facts have been recorded.' };
  let diff = '', files: string[] = [], pathsComplete = false;
  const counts = () => ({ files: pathsComplete ? files.length : null, diffChars: diff.length,
    encodedDiffChars: escapedLength(diff), nonDiffChars: JSON.stringify({ files, diff: '', validation }).length });
  try {
    const base = state.baseCommit ?? 'HEAD';
    const tracked = git(projectDir, ['diff', '--name-only', '-z', base, '--']).split('\0').filter(Boolean);
    const untracked = git(projectDir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    files = [...new Set([...tracked, ...untracked])];
    pathsComplete = true;
    diff = git(projectDir, ['diff', '--no-ext-diff', '--no-textconv', base, '--']);
    for (const file of untracked) {
      if (escapedLength(diff) + counts().nonDiffChars > room) break;
      // Git no-index exits 1 for a complete added-file diff. Every other failure is unavailable.
      try { diff += git(projectDir, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file]); }
      catch (error) {
        const failure = error as { status?: number; code?: string; signal?: string; stdout?: string };
        if (failure.status !== 1 || failure.code || failure.signal || typeof failure.stdout !== 'string') throw error;
        diff += failure.stdout;
      }
    }
  } catch { return { ...counts(), unavailable: true as const }; }
  const measured = counts();
  return measured.encodedDiffChars + measured.nonDiffChars > room ? measured : { files, diff, validation };
}
/** This adapter owns input capture: no native call means no invocation input or model attribution. */
const decidedBy = (output: string): Adapter => ({ capturesInvocationInput: true,
  run: async () => ({ output, exitCode: 0, duration_ms: 0 }) });

/** The assessor receives the complete legacy input or code routes to the full independent review. */
export function decisionInput(stage: StageConfig, projectDir: string, directory: string, state: StoreState, inputLimit = adapterInputLimit()): { system: string; user: string; adapter?: Adapter } {
  const predecessor = stagePredecessor(readEvidence(directory), stage.id, state.stages[stage.id]?.attempts?.at(-1));
  if (stage.decision?.kind === 'shape') return { system: CHOOSER_PROMPT,
    user: JSON.stringify({ task: state.taskDescription, research: state.research ?? null, predecessor }) };
  const room = inputLimit - INPUT_RESERVE_CHARS - JSON.stringify({ task: state.taskDescription, predecessor }).length;
  const facts = reviewFacts(projectDir, directory, state, room);
  const system = POST_AUTHOR_PROMPT.replaceAll('review_full', stage.decision!.successors[1]).replaceAll('Select review (', `Select ${stage.decision!.successors[0]} (`);
  if ('diff' in facts) return { system, user: JSON.stringify({ task: state.taskDescription, ...facts, predecessor }) };
  const code = 'unavailable' in facts ? 'diff_unavailable' : 'diff_exceeds_inline_bound';
  return { system, user: JSON.stringify({ task: state.taskDescription, ...facts, inline_bound: room }),
    adapter: decidedBy(JSON.stringify({ successor: stage.decision!.successors[1], risk_areas: [],
      reason: `${code}: code decided review routing; measured at least ${facts.diffChars} diff characters (${facts.encodedDiffChars} JSON-encoded diff characters) and ${facts.nonDiffChars} non-diff JSON characters; ${facts.files === null ? 'changed-file count unavailable' : `${facts.files} changed files including untracked`}; inline bound ${room} against adapter limit ${inputLimit}. ${code === 'diff_unavailable' ? 'A diff piece or path list could not be read completely.' : 'The measured JSON exceeds the inline bound.'} The full independent review reads the worktree.` })) };
}
export function focusedReviewInput(projectDir: string, directory: string, state: StoreState, assessmentId?: string, _reviewer?: StageConfig): string {
  const risk = state.decisionGraph?.records.filter(record => assessmentId ? record.stageId === assessmentId : record.risk_areas).at(-1);
  return `# Independent review facts\n${JSON.stringify({ assessment: risk })}\nRun your own targeted experiments for these risks. Evaluate every assigned criterion. The risks guide exploration; they do not prove correctness or narrow the brief. Do not read author transcripts or adopt author self-assessment.`;
}
