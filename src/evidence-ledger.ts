import { runRecordPath } from './run-layout.js';
import { createHash } from 'node:crypto';
import { gitResultSync, rethrowGitNotAnswered } from './git-facts.js';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { safeEvidencePath } from './engine-owned-carriers.js';
export { safeEvidencePath } from './engine-owned-carriers.js';
import { fcGlobalDir, type StoreState } from './store.js';
import { readRunSnapshot } from './run-lifecycle.js';
import { appendFileSync, mkdirSync, writeFileSync } from './engine-fs.js';
import { readContentIdentity, type ContentIdentity } from './content-identity.js';
import { listProjectFiles, listProjectFilesAt } from './scheduler/sched_scope/path-capabilities.js';
import { extractBriefOutputDeclarations, parseBriefInputs, readAdmittedBriefContract } from './ship-inputs.js';
import { evaluateValidationDelta, projectValidationResult, type ValidationCommandResult, type ValidationDeltaResult } from './project-validation.js';
import type { CommandContext } from './adapters/base.js';

export const EVIDENCE_LEDGER = 'evidence-ledger.jsonl';
export const VALIDATION_FACT_VERSION = 4;
export interface TreeFile { path: string; mode: number; content: ContentIdentity; targetContent?: ContentIdentity }
export interface ProjectTree { hash: string | null; files: TreeFile[]; reason?: string }
export interface ValidationExecution {
  /** Same declared rerun, executed without another validation command. */
  rerun?: true;
  target: 'attempt' | 'base';
  cwd: string;
  commit?: string;
  treeHash: string | null;
  treeAfterHash: string | null;
  commands: Array<ValidationCommandResult & { command: string; args: string[]; env?: NodeJS.ProcessEnv; outputPath?: string }>;
}
export interface ValidationFact {
  kind: 'validation';
  resourceState?: 'complete' | 'unfinished';
  recordPath?: string;
  /** Missing/unsupported versions remain readable, but cannot authorize gates. */
  validationVersion?: number;
  stageId: string;
  attemptIndex: number;
  attemptStartedAt: string;
  treeHash: string | null;
  executions: ValidationExecution[];
  delta: ValidationDeltaResult[];
  failures: Array<{ role: string; display?: string; identifier: string | null; classification: 'pre-existing' | 'introduced' | 'unknown' }>;
  pass: boolean;
  /** Existing confirmed findings/command records feed repair and closure. */
  regressions?: import('./scoped-audit-repair.js').FindingAssessment['confirmed'];
  baseRequest?: { commands: Array<{ role: string; display: string }>; error?: string };
  baseInputSnapshot?: { manifestSha256: string; files: number; bytes: number; durationMs: number; error?: string };
}
/** Legacy confirmations are subsets, not replacement batches. Resource retries
 * in v4 each contain a complete declared batch and use the latest execution. */
export function validationBatch<T extends Pick<ValidationFact, 'validationVersion' | 'executions'>>(fact: T): T['executions'][number] | undefined {
  const attempts = fact.executions.filter(execution => execution.target === 'attempt');
  return fact.validationVersion === VALIDATION_FACT_VERSION ? attempts.at(-1) : attempts.find(execution => !execution.rerun);
}
/** Readers project raw receipts without rewriting the append-only ledger.
 * Tree binding remains a separate fact from command outcome/measurement. */
export function projectValidationFact<T extends ValidationFact>(fact: T) {
  const executions = fact.executions.map(execution => ({ ...execution,
    commands: execution.commands.map(raw => {
      const bound = typeof execution.treeHash === 'string' && execution.treeHash === execution.treeAfterHash
        && (execution.target !== 'attempt' || execution.treeHash === fact.treeHash);
      const result = { ...raw, ...(!bound ? { sourceBound: false } : {}) };
      const projected = projectValidationResult(result);
      // Preserve legacy/reclassified labels without changing an already-owned,
      // current fact's shape for decision-stage consumers.
      const provenance = result.identityOwner === undefined || result.state !== projected.state
        ? { storedState: result.storedState ?? result.state } : {};
      return { ...result, ...provenance, ...projected };
    }) }));
  const current = validationBatch({ ...fact, executions })?.commands ?? [];
  const delta = evaluateValidationDelta(undefined, current, undefined, fact.delta);
  // Historical classification/pass labels are provenance only, never inputs
  // to a present judgment. A red-to-red result cannot become verified.
  return { ...fact, executions, delta, failures: [], pass: delta.length > 0 && delta.every(entry => entry.state === 'verified') };
}

/** Every historical receipt uses the same raw-exit projection, including
 * unversioned inline and older ledger-backed receipts. */
export function projectValidationDelta<T extends { current: ValidationCommandResult[]; delta: ValidationDeltaResult[]; pass: boolean; ledgerSequence?: number }>(base: string, value: T): T | undefined {
  if (value.ledgerSequence !== undefined) {
    const fact = readEvidence(base).find(entry => entry.sequence === value.ledgerSequence);
    if (fact?.kind !== 'validation') return undefined;
    value.current = validationBatch(projectValidationFact(fact))?.commands ?? [];
  }
  if (!Array.isArray(value.current)) return undefined;
  const current = value.current.filter(Boolean).map(raw => {
    // Inline legacy receipts lack execution hashes. An unresolved coverage
    // marker covers its role unless it names a command. Neither its reason nor a causal label is parsed.
    const unresolved = value.ledgerSequence === undefined && value.delta.some(entry => entry
      && (entry.state as string) === 'unresolved' && entry.role === raw.role
      && (entry.display === undefined || entry.display === raw.display));
    const result = { ...raw, ...(unresolved ? { sourceBound: false } : {}) };
    return { ...result, storedState: result.storedState ?? result.state, ...projectValidationResult(result) };
  });
  const delta = evaluateValidationDelta(undefined, current, undefined, value.delta.filter(Boolean));
  return { ...value, current, delta, pass: !value.current.some(result => !result) && delta.length > 0 && delta.every(entry => entry.state === 'verified') };
}

export type EvidenceFact = ValidationFact | {
  kind: 'attempt'; stageId: string; attemptIndex: number; attemptStartedAt: string;
  exitCode: number; status: string; treeHash: string | null;
  files: TreeFile[];
  remainingWork?: string[] | null; continuation?: boolean; endingCause?: import('./attempt-ending.js').EndingCause;
  environmentGap?: { reason: string; blocks: { criterion_ids: string[]; paths: string[] } | null; unknownCriterionIds?: string[] };
  finalRecord?: Record<string, unknown>; guidanceIds?: string[];
  measurements: { inputTokens: number | null; outputTokens: number | null; durationMs: number; provenance: 'adapter-reported' };
} | {
  kind: 'declaration'; stageId: string; attemptIndex: number; status: 'blocked'; reason: string;
  caveats: string[]; owner: 'declaration';
} | {
  kind: 'command'; stageId: string; attemptIndex: number; invocationIndex?: number; commandId: string; command: string | null;
  unfinished?: boolean;
  exitCode: number | null; owner: 'adapter-event' | 'declaration' | 'code'; evidence?: string;
  context?: CommandContext;
  outputDigest?: string; treeHash?: string | null; treeAfterHash?: string | null;
  /** A repair replay cites the original failed command, using the same ledger primitive. */
  reproductionOf?: number;
  /** Declared reproduction allowance; omission waits for completion or cancellation. */
  timeoutMs?: number;
  validationRecord?: number;
} | {
  kind: 'decision'; stageId: string; attemptIndex: number; verdict: Record<string, unknown>; owner: 'closed-schema-model';

};
export type EvidenceEntry = EvidenceFact & { version: 1; sequence: number; at: string; owner?: string };

/** All publications pass through the existing engine filesystem/integrity owner.
 * This single channel replaces predecessor output and native session history. */
export function appendEvidence(runDir: string, fact: EvidenceFact): EvidenceEntry {
  const entries = readEvidence(runDir);
  const entry = { version: 1 as const, sequence: entries.length + 1, at: new Date().toISOString(), owner: 'code', ...fact };
  appendFileSync(runRecordPath(runDir, EVIDENCE_LEDGER), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readEvidence(runDir: string): EvidenceEntry[] {
  const path = runRecordPath(runDir, EVIDENCE_LEDGER);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    const value = JSON.parse(line) as EvidenceEntry;
    if (value.version !== 1 || value.sequence !== index + 1
      || !['validation', 'attempt', 'command', 'decision', 'identity-reading', 'declaration'].includes(value.kind)) throw new Error('EVIDENCE_LEDGER_INVALID');
    return value;
  });
}


/** Same-stage context comes only from its last settled structured fact. */
export function stagePredecessor(entries: EvidenceEntry[], stageId: string, previous?: { index: number; startedAt: string }) {
  if (!previous) return undefined;
  const attempt = entries.find((entry): entry is EvidenceEntry & { kind: 'attempt' } => entry.kind === 'attempt' && entry.stageId === stageId
    && entry.attemptIndex === previous.index && entry.attemptStartedAt === previous.startedAt);
  if (!attempt) return undefined;
  return { attempt, validation: entries.find(entry => entry.kind === 'validation' && entry.stageId === stageId
    && entry.attemptIndex === attempt.attemptIndex && entry.attemptStartedAt === attempt.attemptStartedAt) };
}

/** A restored tree consumes its original receipt, not a later different tree's
 * result. Unmatched historical facts remain in the ledger, never current greens. */
export function validationForTree(entries: EvidenceEntry[], treeHash: string | null) {
  const facts = entries.filter((entry): entry is EvidenceEntry & ValidationFact => entry.kind === 'validation');
  return treeHash === null ? undefined : facts.filter(fact => fact.treeHash === treeHash).filter(fact => fact.resourceState === 'complete').at(-1) ?? facts.filter(fact => fact.treeHash === treeHash).at(-1);
}

/** Identity covers Git's source inventory plus declared outputs and products.
 * Declared inputs do not add ignored members. Unreadable members fail closed. */
export function captureProjectTree(projectDir: string, brief = '', runDir?: string): ProjectTree {
  try {
    const stateRoot = resolve(fcGlobalDir());
    const ordinary = (path: string) => {
      const member = relative(stateRoot, resolve(projectDir, path));
      return member !== '' && (isAbsolute(member) || member === '..' || member.startsWith('../') || member.startsWith('..\\'));
    };
    const paths = new Set(listProjectFiles(projectDir, { skipDirectory: path => !ordinary(path) || !safeEvidencePath(path) }).filter(path => ordinary(path) && safeEvidencePath(path)));
    const contract = runDir ? readAdmittedBriefContract(runDir, brief)
      : { inputs: parseBriefInputs(brief).references, outputs: extractBriefOutputDeclarations(brief) };
    const declaredInputs = new Set(contract.inputs.map(input => input.path));
    // One identity inventory also covers ignored terminal and admitted stage
    // products, replacing the worker's separate scoped-content capture.
    const state = runDir ? readRunSnapshot(runDir) as unknown as StoreState : undefined;
    const products = [...Object.values(state?.terminalStates ?? {}).flatMap(entry => entry.paths),
      ...(state?.planControl?.stages ?? []).flatMap(stage => stage.artifact_contract?.produces
        .filter(output => output.root === 'project').map(output => output.path) ?? [])];
    const declaredProducts = [...contract.outputs.map(output => output.path), ...products];
    for (const path of declaredProducts) {
      if (!ordinary(path) || !safeEvidencePath(path)) continue;
      for (const member of listProjectFilesAt(projectDir, path, declaredInputs.has(path), { complete: true, skipDirectory: path => !safeEvidencePath(path) })) {
        if (safeEvidencePath(member) && !lstatSync(join(projectDir, member)).isDirectory()) paths.add(member);
      }
    }
    const files: TreeFile[] = [...paths].sort().map(path => {
      const content = readContentIdentity(join(projectDir, path));
      const file: TreeFile = { path, mode: content.state === 'present' ? lstatSync(join(projectDir, path)).mode & 0o777 : 0, content };
      if (declaredProducts.includes(path) && declaredInputs.has(path) && content.state === 'present' && content.type === 'symlink') {
        const target = realpathSync(join(projectDir, path));
        if (!safeEvidencePath(target)) throw new Error('Declared input resolves to a credential/control path');
        if (lstatSync(target).isFile()) file.targetContent = readContentIdentity(target);
      }
      return file;
    }).filter(file => file.content.state !== 'absent');
    if (files.some(file => file.content.state === 'unavailable' || file.targetContent?.state === 'unavailable')) return { hash: null, files, reason: 'Source inventory contains unavailable content' };
    return { hash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
  } catch (error) { rethrowGitNotAnswered(error); return { hash: null, files: [], reason: String(error) }; }
}

export function changedTreeFiles(before: ProjectTree, after: ProjectTree): TreeFile[] {
  const left = new Map(before.files.map(file => [file.path, file]));
  const right = new Map(after.files.map(file => [file.path, file]));
  return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap(path => {
    const current = right.get(path) ?? { path, mode: 0, content: { state: 'absent' as const } };
    return JSON.stringify(left.get(path)) === JSON.stringify(right.get(path)) ? [] : [current];
  });
}

export function projectCommit(projectDir: string): string | undefined {
  const result = gitResultSync(['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: projectDir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Diff is a separate inspectable artifact, never a summary by the author. Git
 * supplies the patch; structured file identities also include untracked writes. */
export function evidenceContext(projectDir: string, runDir: string, stageId?: string, previous?: { index: number; startedAt: string } | null, budget = Infinity): string {
  if (!existsSync(runRecordPath(runDir, EVIDENCE_LEDGER))) writeFileSync(runRecordPath(runDir, EVIDENCE_LEDGER), '', { flag: 'wx' });
  const entries = readEvidence(runDir);
  const validation = validationForTree(entries, captureProjectTree(projectDir, '', runDir).hash);
  const baselinePath = runRecordPath(runDir, 'validation_baseline.json');
  let commit: string | undefined;
  let selection: unknown;
  try { const plan = JSON.parse(readFileSync(baselinePath, 'utf8')); commit = plan.baseCommit; selection = plan.baseline?.discovery; } catch { /* no Git baseline */ }
  const diff = commit ? gitResultSync(['diff', '--no-ext-diff', '--no-textconv', '--binary', commit, '--', '.', ':(exclude)**/.env*', ':(exclude)**/auth.json', ':(exclude)**/credentials.json', ':(exclude)**/installation_id'], {
    cwd: projectDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }) : undefined;
  let patch = diff?.status === 0 ? diff.stdout : 'Git patch unavailable; inspect current files and structured changed-file identities in the ledger.\n';
  if (commit) {
    const untracked = gitResultSync(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: projectDir,
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (untracked.status !== 0) patch += '\nUntracked inventory unavailable; inspect current files.\n';
    else for (const path of untracked.stdout.split('\0').filter(path => path && safeEvidencePath(path))) {
      const added = gitResultSync(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--', '/dev/null', path], {
        cwd: projectDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      });
      patch += added.status === 0 || added.status === 1 ? added.stdout : `\nPatch unavailable for ${JSON.stringify(path)}; inspect the current file.\n`;
    }
  }
  const directory = runRecordPath(runDir, 'stage_evidence', 'diffs', createHash('sha256').update(patch).digest('hex'));
  mkdirSync(directory, { recursive: true });
  const diffPath = runRecordPath(directory, 'change.diff');
  try { writeFileSync(diffPath, patch, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(diffPath, 'utf8') !== patch) throw error;
  }
  // A field projection, not a model summary or a prose importance filter.
  // Only the same stage sees its predecessor's final answer. Other stages see
  // engine facts, decisions and unverified blocker declarations, never narratives.
  if (stageId && previous === undefined) try { previous = JSON.parse(readFileSync(runRecordPath(runDir, 'stages', stageId, 'status.json'), 'utf8')).attempts?.at(-1); } catch { /* unknown predecessor */ }
  const predecessor = stageId ? stagePredecessor(entries, stageId, previous ?? undefined) : undefined;
  const latest = new Map(entries.map(entry => [`${entry.kind}:${entry.stageId}`, entry]));
  const facts = entries.flatMap<object>(entry => {
    if (entry.kind === 'command') return [];
    if (entry.kind === 'validation' ? entry !== validation : entry.kind !== 'decision' && latest.get(`${entry.kind}:${entry.stageId}`) !== entry) return [];
    if (entry.kind === 'validation') {
      const attempt = entries.find(fact => fact.kind === 'attempt' && fact.stageId === entry.stageId && fact.attemptIndex === entry.attemptIndex && fact.attemptStartedAt === entry.attemptStartedAt);
      if (attempt?.kind !== 'attempt' || attempt.attemptIndex !== entry.attemptIndex
        || attempt.attemptStartedAt !== entry.attemptStartedAt) return [];
      return [entry.validationVersion === VALIDATION_FACT_VERSION ? entry : projectValidationFact(entry)];
    }
    if (entry.kind === 'attempt') {
      const { finalRecord: _finalRecord, guidanceIds: _guidanceIds, remainingWork: _remainingWork, ...fact } = entry;
      return [fact];
    }
    if (entry.kind === 'declaration') {
      const { reason: _reason, caveats: _caveats, ...fact } = entry;
      return [fact];
    }
    return [entry];
  });
  const ledgerText = JSON.stringify({ version: 1, sequence: entries.at(-1)?.sequence ?? 0, facts,

  });
  const selectionText = `\nValidation command selection (unconfigured roles are unmeasured): ${JSON.stringify(selection ?? { state: 'unknown', reason: 'No declaration or model selection recorded' })}`
    + (validation ? '' : '\nNo configured validation fact covers the current tree; validation unmeasured.');
  const predecessorText = predecessor ? `\n\n# Own-stage continuation evidence\n${JSON.stringify(predecessor)}` : '';
  const patchText = readFileSync(diffPath, 'utf8');
  const patchBytes = Buffer.from(patchText);
  let head = 1500, tail = patchBytes.length - 1500;
  while ((patchBytes[head] & 0xc0) === 0x80) head--;
  while ((patchBytes[tail] & 0xc0) === 0x80) tail++;
  const patchExcerpt = patchBytes.length <= 3000 ? patchText
    : `${patchBytes.subarray(0, head).toString('utf8')}\n[excerpt; read the complete artifact above]\n${patchBytes.subarray(tail).toString('utf8')}`;
  return `## Evidence ledger and diff\nRead ${runRecordPath(runDir, EVIDENCE_LEDGER)} (version 1 append-only structured facts; latest validation sequence ${validation?.sequence ?? 'none'}).\n`
    + `Inspect the diff (including untracked additions; any unavailable patch is explicitly marked): ${diffPath}\nChanged-file hashes, including untracked files, are recorded in the ledger's attempt facts.\n`
    + 'Use these facts and current artifacts for every decision. Do not read author transcripts, stage output narratives or provider session history. '
    + 'Configured validation belongs to the completed author/repair attempt; decisions consume its tree-bound results without rerunning the suite. '
    + 'Independent experiments and every assigned acceptance criterion remain required. Read the complete diff artifact when its excerpt is truncated.\n'
    + (ledgerText.length + selectionText.length + predecessorText.length <= budget ? `Ledger facts:\n${ledgerText}${selectionText}${predecessorText}`
      // All or nothing: a ledger that does not fit the adapter's input limit is named, not clipped.
      : `Ledger facts are not inlined (ledger_exceeds_inline_bound): ${facts.length} facts from ${entries.length} ledger entries, ${ledgerText.length + selectionText.length + predecessorText.length} characters against the ${Math.max(0, budget)} that fit the adapter's input limit. Read ${runRecordPath(runDir, EVIDENCE_LEDGER)} with your tools; the attempt facts carry the changed-file hashes and your own stage's latest attempt is its continuation evidence.`)
    + `\nDiff:\n${patchExcerpt}`;
}
