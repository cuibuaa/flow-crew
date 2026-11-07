/** Review routing receives facts from engine/git authorities, never author narrative. */
import { execFileSync } from 'node:child_process';
import type { StoreState } from './store.js';
import { POST_AUTHOR_PROMPT, CHOOSER_PROMPT } from './decision-graph.js';
import type { StageConfig } from './scheduler/sched_admission/configuration.js';
import { readEvidence, stagePredecessor } from './evidence-ledger.js';

export function reviewFacts(projectDir: string, directory: string, state: StoreState): { files: string[]; diff: string; validation: unknown } {
  const git = (args: string[]) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', timeout: 15_000, maxBuffer: 8_000_000 });
  let diff = '', files: string[] = [];
  try {
    const base = state.baseCommit ?? 'HEAD';
    files = git(['diff', '--name-only', '-z', base, '--']).split('\0').filter(Boolean);
    diff = git(['diff', '--no-ext-diff', '--no-textconv', base, '--']);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    for (const file of untracked) {
      files.push(file);
      // Git no-index includes added file bytes without custom diff parsing.
      try { diff += git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file]); }
      catch (error) { diff += (error as { stdout?: string }).stdout ?? ''; }
    }
  } catch { diff = 'Diff unavailable; choose full review and investigate independently.'; }
  const validation = readEvidence(directory).filter(entry => entry.kind === 'validation').at(-1)
    ?? { status: 'No configured validation facts have been recorded.' };
  return { files: [...new Set(files)], diff, validation };
}
export function decisionInput(stage: StageConfig, projectDir: string, directory: string, state: StoreState): { system: string; user: string } {
  const predecessor = stagePredecessor(readEvidence(directory), stage.id, state.stages[stage.id]?.attempts?.at(-1));
  if (stage.decision?.kind === 'shape') return { system: CHOOSER_PROMPT,
    user: JSON.stringify({ task: state.taskDescription, research: state.research ?? null, predecessor }) };
  const facts = reviewFacts(projectDir, directory, state);
  const system = POST_AUTHOR_PROMPT.replaceAll('review_full', stage.decision!.successors[1]).replaceAll('Select review (', `Select ${stage.decision!.successors[0]} (`);
  return { system, user: JSON.stringify({ task: state.taskDescription, ...facts, predecessor }) };
}
export function focusedReviewInput(projectDir: string, directory: string, state: StoreState, assessmentId?: string, _reviewer?: StageConfig): string {
  const risk = state.decisionGraph?.records.filter(record => assessmentId ? record.stageId === assessmentId : record.risk_areas).at(-1);
  return `# Independent review facts\n${JSON.stringify({ assessment: risk })}\nRun your own targeted experiments for these risks. Evaluate every assigned criterion. The risks guide exploration; they do not prove correctness or narrow the brief. Do not read author transcripts or adopt author self-assessment.`;
}
