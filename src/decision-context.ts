/** Review routing receives facts from engine/git authorities, never author narrative. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from './engine-fs.js';
import { hashRollbackFileSync } from './rollback-content-store.js';
import { join } from 'node:path';
import type { StoreState } from './store.js';
import { POST_AUTHOR_PROMPT, CHOOSER_PROMPT } from './decision-graph.js';
import type { StageConfig } from './scheduler/sched_admission/configuration.js';
import { readEvidence, stagePredecessor } from './evidence-ledger.js';
import { adapterInputLimit } from './config.js';

/** Characters kept free for JSON keys, the manifest note and the result contract the worker appends after this input. */
const INPUT_RESERVE_CHARS = 65_536;

export interface ManifestEntry { path: string; tracked: boolean; status: string; size: number | null; sha256: string | null; inlined: boolean }
interface Change { path: string; tracked: boolean; status: string }
/** One piece of diff text: a tracked file's section, an untracked file's added-file diff, or (when git's sections cannot be matched to files) all tracked changes. */
interface Unit { changes: Change[]; size: number; text?: string; load?: (maxChars: number) => string | undefined }

const git = (projectDir: string, args: string[], maxBuffer = 8_000_000) =>
  execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', timeout: 15_000, maxBuffer });
const escapedLength = (text: string) => JSON.stringify(text).length - 2;

/** Tracked changes against the base, then untracked files, as git reports them. */
function listChanges(projectDir: string, state: StoreState): Change[] {
  const base = state.baseCommit ?? 'HEAD';
  const tokens = git(projectDir, ['diff', '--name-status', '-z', base, '--'], 64 * 1024 * 1024).split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i++], names = /^[RC]/.test(status) ? 2 : 1;
    changes.push({ path: tokens[i + names - 1], tracked: true, status });
    i += names;
  }
  for (const path of git(projectDir, ['ls-files', '--others', '--exclude-standard', '-z'], 64 * 1024 * 1024).split('\0').filter(Boolean)) changes.push({ path, tracked: false, status: '??' });
  return changes;
}
/** Every changed path, whatever the size of the change. */
export function changedPaths(projectDir: string, state: StoreState): string[] {
  try { return [...new Set(listChanges(projectDir, state).map(change => change.path))]; } catch { return []; }
}

function digest(path: string): { size: number | null; sha256: string | null } {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { size: stat.size, sha256: createHash('sha256').update(readlinkSync(path)).digest('hex') };
    if (!stat.isFile()) return { size: null, sha256: null };
    return { size: stat.size, sha256: hashRollbackFileSync(path).sha256 };
  } catch { return { size: null, sha256: null }; }
}
/** Git's own test for binary content: a NUL byte in the first 8000 bytes. Binary files diff to one short line whatever their size. */
function hasNul(path: string): boolean {
  try {
    const buffer = Buffer.alloc(8000), fd = openSync(path, 'r');
    try { return buffer.subarray(0, readSync(fd, buffer, 0, 8000, 0)).includes(0); } finally { closeSync(fd); }
  } catch { return false; }
}

/**
 * Review routing's facts. `room` is the number of characters of JSON this call may add to the input: the manifest
 * (every changed file with its hash) takes what it needs up to half of it, diff text takes the rest. Sections are chosen
 * by tracked status, then size, then path; the chosen ones are emitted in git's order, so a change that fits yields
 * exactly the text git prints.
 */
export function reviewFacts(projectDir: string, directory: string, state: StoreState, room: number): { manifest: ManifestEntry[]; diff: string; validation: unknown; note?: string } {
  const validation = readEvidence(directory).filter(entry => entry.kind === 'validation').at(-1)
    ?? { status: 'No configured validation facts have been recorded.' };
  room -= JSON.stringify(validation).length;
  let changes: Change[];
  try { changes = listChanges(projectDir, state); }
  catch { return { manifest: [], diff: 'Diff unavailable; choose full review and investigate independently.', validation }; }
  const top = (() => { try { return git(projectDir, ['rev-parse', '--show-toplevel']).trim(); } catch { return projectDir; } })();
  const rows = changes.map(change => ({ change, ...digest(join(change.tracked ? top : projectDir, change.path)) }));

  // The manifest is sized with every file marked not inlined, the longest spelling, so the diff budget never shrinks after it is chosen.
  const entry = (row: typeof rows[number], inlined: boolean): ManifestEntry => ({ path: row.change.path, tracked: row.change.tracked, status: row.change.status, size: row.size, sha256: row.sha256, inlined });
  const manifestBudget = Math.max(0, Math.floor(room / 2));
  let manifestChars = 2, kept = 0;
  for (const row of rows) {
    const next = JSON.stringify(entry(row, false)).length + 1;
    if (manifestChars + next > manifestBudget) break;
    manifestChars += next; kept++;
  }
  let remaining = room - manifestChars;

  const tracked = changes.filter(change => change.tracked);
  const units: Unit[] = [];
  try {
    const text = tracked.length ? git(projectDir, ['diff', '--no-ext-diff', '--no-textconv', state.baseCommit ?? 'HEAD', '--'], 64 * 1024 * 1024) : '';
    const sections = text.split(/(?=^diff --git )/m).filter(Boolean);
    if (sections.length === tracked.length) tracked.forEach((change, i) => units.push({ changes: [change], size: escapedLength(sections[i]), text: sections[i] }));
    else units.push({ changes: tracked, size: escapedLength(text), text });
  } catch { units.push({ changes: tracked, size: Infinity }); }
  for (const row of rows) if (!row.change.tracked) {
    const file = row.change.path, size = row.size ?? 0;
    units.push({ changes: [row.change], size, load: maxChars => {
      // Git no-index includes added file bytes without custom diff parsing.
      try { return git(projectDir, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file], Math.max(4096, maxChars * 3)); }
      catch (error) {
        const failure = error as { code?: string; stdout?: string };
        return failure.code === 'ENOBUFS' ? undefined : failure.stdout ?? '';
      }
    } });
  }
  const inlined = new Map<Unit, string>();
  const order = [...units].sort((a, b) => Number(!a.changes[0]?.tracked) - Number(!b.changes[0]?.tracked) || a.size - b.size || Number(a.changes[0].path > b.changes[0].path) - Number(a.changes[0].path < b.changes[0].path));
  for (const unit of order) {
    // Text is at least a third as many characters as the file has bytes, unless git reduces binary content to one line.
    if (unit.text === undefined && (!unit.load || (unit.size / 3 > remaining && !hasNul(join(projectDir, unit.changes[0].path))))) continue;
    const text = unit.text ?? unit.load!(remaining);
    if (text === undefined) continue;
    const cost = unit.text === undefined ? escapedLength(text) : unit.size;
    if (cost > remaining) continue;
    remaining -= cost;
    inlined.set(unit, text);
  }
  const shown = new Set([...inlined.keys()].flatMap(unit => unit.changes));
  const diff = units.map(unit => inlined.get(unit) ?? '').join('');
  const manifest = rows.slice(0, kept).map(row => entry(row, shown.has(row.change)));
  const manifestOmitted = rows.length - kept, omitted = rows.filter(row => !shown.has(row.change)).length;
  const note = omitted || manifestOmitted
    ? `Diff text for files with "inlined": false is omitted so this input fits the adapter limit (${omitted} of ${rows.length} files).${manifestOmitted ? ` ${manifestOmitted} further changed files are beyond the manifest; list them with git status.` : ''} Their path, size and sha256 are in the manifest: read them from the worktree instead of guessing, and treat every manifest path as part of the diff.`
    : undefined;
  return { manifest, diff, validation, ...(note ? { note } : {}) };
}
/** `inputLimit` is the adapter's declared limit in characters; the user input stays within it, whatever the size of the change. */
export function decisionInput(stage: StageConfig, projectDir: string, directory: string, state: StoreState, inputLimit = adapterInputLimit()): { system: string; user: string } {
  const predecessor = stagePredecessor(readEvidence(directory), stage.id, state.stages[stage.id]?.attempts?.at(-1));
  if (stage.decision?.kind === 'shape') return { system: CHOOSER_PROMPT,
    user: JSON.stringify({ task: state.taskDescription, research: state.research ?? null, predecessor }) };
  const room = inputLimit - INPUT_RESERVE_CHARS - JSON.stringify({ task: state.taskDescription, predecessor }).length;
  const facts = reviewFacts(projectDir, directory, state, room);
  const system = POST_AUTHOR_PROMPT.replaceAll('review_full', stage.decision!.successors[1]).replaceAll('Select review (', `Select ${stage.decision!.successors[0]} (`)
    + (facts.note ? ' The supplied diff omits some files (see note): read those listed files in the worktree, read-only, before choosing.' : '');
  return { system, user: JSON.stringify({ task: state.taskDescription, ...facts, predecessor }) };
}
export function focusedReviewInput(projectDir: string, directory: string, state: StoreState, assessmentId?: string, _reviewer?: StageConfig): string {
  const risk = state.decisionGraph?.records.filter(record => assessmentId ? record.stageId === assessmentId : record.risk_areas).at(-1);
  return `# Independent review facts\n${JSON.stringify({ assessment: risk })}\nRun your own targeted experiments for these risks. Evaluate every assigned criterion. The risks guide exploration; they do not prove correctness or narrow the brief. Do not read author transcripts or adopt author self-assessment.`;
}
