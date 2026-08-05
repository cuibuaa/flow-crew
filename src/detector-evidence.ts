import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { z } from 'zod';
import { parseSingleProbeValue } from './probe-result.js';

export const DETECTOR_EVIDENCE_SCHEMA = 'flowcrew.detector-evidence/v1' as const;
export const DETECTOR_OUTPUT_SCHEMA = 'flowcrew.detector-output/v1' as const;

const INPUT_ROOT_PLACEHOLDER = '{{inputRoot}}';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_INPUT_BYTES = 4_000_000;

const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be blank',
});
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 digest');
const gitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'must be a resolved git commit OID');
const repositoryPathSchema = z.string().refine(isRepositoryPath, {
  message: 'must be a normalized repository-relative path',
});
const candidateValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
]);

const candidateSchema = z.object({
  id: nonBlankString,
  attributes: z.record(z.string(), candidateValueSchema),
}).strict();

const filterSchema = z.object({
  candidateId: nonBlankString,
  disposition: z.enum(['keep', 'drop']),
  reason: nonBlankString,
}).strict();

const universeValueSchema = z.object({
  definition: nonBlankString,
  members: z.array(nonBlankString),
}).strict();

export const detectorParserResultSchema = z.object({
  schema: z.literal(DETECTOR_OUTPUT_SCHEMA),
  detector: z.object({
    id: nonBlankString,
    version: nonBlankString,
  }).strict(),
  universe: universeValueSchema,
  rawCandidates: z.array(candidateSchema),
  filters: z.array(filterSchema),
}).strict();

const rawSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
}).strict();

const exitSchema = z.object({
  code: z.number().int().nullable(),
  signal: nonBlankString.nullable(),
  timedOut: z.boolean(),
}).strict();

export const detectorEvidenceManifestSchema = z.object({
  schema: z.literal(DETECTOR_EVIDENCE_SCHEMA),
  detector: z.object({
    id: nonBlankString,
    version: nonBlankString,
    argv: z.array(nonBlankString).min(1),
  }).strict(),
  input: z.object({
    ref: nonBlankString.refine((value) => !value.startsWith('-'), 'must not start with an option prefix'),
    commitOid: gitOidSchema,
    files: z.array(z.object({
      path: repositoryPathSchema,
      sha256: sha256Schema,
    }).strict()).min(1),
    digest: sha256Schema,
  }).strict(),
  universe: universeValueSchema.extend({
    digest: sha256Schema,
  }).strict(),
  rawCandidates: z.array(candidateSchema),
  raw: rawSchema,
  exit: exitSchema,
  parser: z.object({
    id: z.literal('flowcrew.detector-output-json'),
    version: z.literal('1'),
    result: detectorParserResultSchema,
  }).strict(),
  filters: z.array(filterSchema),
  independentLabels: z.array(z.object({
    candidateId: nonBlankString,
    verdict: z.enum(['true_positive', 'false_positive']),
    reviewer: nonBlankString,
    rationale: nonBlankString,
  }).strict()),
  result: z.object({
    count: z.number().int().nonnegative(),
    precision: z.number().min(0).max(1).nullable(),
    disposition: z.enum(['rankable', 'candidate_only']),
    digest: sha256Schema,
    conclusion: z.object({
      statement: nonBlankString,
    }).strict().optional(),
  }).strict(),
}).strict();

const replayEvidenceSchema = z.object({
  commitOid: gitOidSchema,
  inputDigest: sha256Schema,
  universe: universeValueSchema.extend({ digest: sha256Schema }).strict(),
  rawCandidates: z.array(candidateSchema),
  raw: rawSchema,
  exit: exitSchema,
  parser: z.object({
    id: z.literal('flowcrew.detector-output-json'),
    version: z.literal('1'),
    result: detectorParserResultSchema,
  }).strict(),
  filters: z.array(filterSchema),
  count: z.number().int().nonnegative(),
  disposition: z.enum(['rankable', 'candidate_only']),
  digest: sha256Schema,
}).strict();

export type DetectorEvidenceManifest = z.infer<typeof detectorEvidenceManifestSchema>;
export type DetectorCandidate = z.infer<typeof candidateSchema>;
export type DetectorReplayEvidence = z.infer<typeof replayEvidenceSchema>;

interface DerivedEvidence {
  count: number;
  precision: number | null;
  disposition: 'rankable' | 'candidate_only';
  digest: string;
}

export type DetectorEvidenceValidation =
  | { ok: true; manifest: DetectorEvidenceManifest; derived: DerivedEvidence }
  | { ok: false; errors: string[] };

const RANKABLE_EVIDENCE = Symbol('rankable-detector-evidence');
const COMMITTED_REPLAY_EVIDENCE = Symbol('committed-detector-replay-evidence');

type CommittedDetectorReplayEvidence = DetectorReplayEvidence & {
  readonly [COMMITTED_REPLAY_EVIDENCE]: true;
};

export interface RankableDetectorAdmission {
  readonly [RANKABLE_EVIDENCE]: true;
  readonly status: 'rankable';
  readonly schedulingEligible: true;
  readonly detectorId: string;
  readonly commitOid: string;
  readonly evidenceDigest: string;
  readonly count: number;
  readonly precision: number;
  readonly candidates: DetectorCandidate[];
  readonly conclusion: { statement: string };
}

export interface CandidateOnlyDetectorAdmission {
  status: 'candidate_only';
  schedulingEligible: false;
  detectorId: string;
  commitOid: string;
  evidenceDigest: string;
  precision: number | null;
  candidates: DetectorCandidate[];
  reasons: string[];
}

export interface RejectedDetectorAdmission {
  status: 'rejected';
  schedulingEligible: false;
  errors: string[];
}

export type DetectorAdmission =
  | RankableDetectorAdmission
  | CandidateOnlyDetectorAdmission
  | RejectedDetectorAdmission;

export interface DetectorReplayOptions {
  repositoryPath: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
}

export interface DetectorSchedulingEntry {
  readonly detectorId: string;
  readonly count: number;
  readonly evidenceDigest: string;
  readonly commitOid: string;
}

const RANKABLE_ADMISSION_ENTRIES = new WeakMap<object, Readonly<DetectorSchedulingEntry>>();

/**
 * Strictly validates both the manifest shape and every relationship needed to
 * interpret its count. It never fills defaults or coerces evidence values.
 */
export function validateDetectorEvidenceManifest(value: unknown): DetectorEvidenceValidation {
  const parsed = detectorEvidenceManifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
    };
  }

  const manifest = parsed.data;
  const errors: string[] = [];
  const filePaths = manifest.input.files.map((file) => file.path);
  requireUnique(filePaths, 'input.files path', errors);
  requireUnique(manifest.universe.members, 'universe member', errors);

  const expectedInputDigest = digestCanonical({
    files: [...manifest.input.files].sort((left, right) => left.path.localeCompare(right.path)),
  });
  if (manifest.input.digest !== expectedInputDigest) {
    errors.push('input.digest does not match the declared committed file digests');
  }

  const expectedUniverseDigest = universeDigest(manifest.universe);
  if (manifest.universe.digest !== expectedUniverseDigest) {
    errors.push('universe.digest does not match its definition and members');
  }

  const referencedPaths: string[] = [];
  for (const argument of manifest.detector.argv) {
    if (!argument.includes(INPUT_ROOT_PLACEHOLDER)) continue;
    if (!argument.startsWith(`${INPUT_ROOT_PLACEHOLDER}/`)
      || argument.indexOf(INPUT_ROOT_PLACEHOLDER) !== argument.lastIndexOf(INPUT_ROOT_PLACEHOLDER)) {
      errors.push(`detector argv placeholder must be one complete input-root path argument: ${JSON.stringify(argument)}`);
      continue;
    }
    const referencedPath = argument.slice(INPUT_ROOT_PLACEHOLDER.length + 1);
    if (!isRepositoryPath(referencedPath)) {
      errors.push(`detector argv references an invalid committed path: ${JSON.stringify(referencedPath)}`);
      continue;
    }
    referencedPaths.push(referencedPath);
  }
  if (referencedPaths.length === 0) {
    errors.push(`detector.argv must reference at least one committed path through ${INPUT_ROOT_PLACEHOLDER}`);
  }
  for (const referencedPath of referencedPaths) {
    if (!filePaths.includes(referencedPath)) {
      errors.push(`detector argv path is absent from input.files: ${referencedPath}`);
    }
  }

  const rawResult = parseSingleProbeValue(
    { raw: manifest.raw, exit: manifest.exit },
    detectorParserResultSchema,
  );
  if (!rawResult.ok) {
    errors.push(...rawResult.errors.map((error) => `probe result ${rawResult.kind} failure: ${error}`));
  } else if (!canonicalEqual(rawResult.value, manifest.parser.result)) {
    errors.push('parser.result does not equal the typed result parsed from raw.stdout');
  }

  if (manifest.parser.result.detector.id !== manifest.detector.id
    || manifest.parser.result.detector.version !== manifest.detector.version) {
    errors.push('parser.result detector identity/version does not match detector metadata');
  }
  if (!canonicalEqual(manifest.parser.result.universe, universeValue(manifest.universe))) {
    errors.push('parser.result universe does not match the manifest universe');
  }
  if (!canonicalEqual(manifest.parser.result.rawCandidates, manifest.rawCandidates)) {
    errors.push('parser.result rawCandidates do not match the manifest rawCandidates');
  }
  if (!canonicalEqual(manifest.parser.result.filters, manifest.filters)) {
    errors.push('parser.result filters do not match the manifest filters');
  }

  const candidateIds = manifest.rawCandidates.map((candidate) => candidate.id);
  requireUnique(candidateIds, 'raw candidate id', errors);
  const universeMembers = new Set(manifest.universe.members);
  for (const candidateId of candidateIds) {
    if (!universeMembers.has(candidateId)) {
      errors.push(`raw candidate is not a universe member: ${candidateId}`);
    }
  }

  const filterIds = manifest.filters.map((filter) => filter.candidateId);
  requireUnique(filterIds, 'filter candidateId', errors);
  const candidateIdSet = new Set(candidateIds);
  for (const filterId of filterIds) {
    if (!candidateIdSet.has(filterId)) errors.push(`filter has no raw candidate: ${filterId}`);
  }
  for (const candidateId of candidateIds) {
    if (!filterIds.includes(candidateId)) errors.push(`raw candidate has no filter reason: ${candidateId}`);
  }

  const labelIds = manifest.independentLabels.map((label) => label.candidateId);
  requireUnique(labelIds, 'independent label candidateId', errors);
  for (const labelId of labelIds) {
    if (!candidateIdSet.has(labelId)) errors.push(`independent label has no raw candidate: ${labelId}`);
  }

  const derived = deriveEvidence(manifest.filters, manifest.independentLabels);
  if (manifest.result.count !== derived.count) {
    errors.push(`result.count ${manifest.result.count} does not equal kept candidate count ${derived.count}`);
  }
  if (!sameNullableNumber(manifest.result.precision, derived.precision)) {
    errors.push('result.precision does not equal the independently labelled sample precision');
  }
  if (manifest.result.disposition !== derived.disposition) {
    errors.push(`result.disposition must be ${derived.disposition} for the supplied precision`);
  }
  if (manifest.result.digest !== derived.digest) {
    errors.push('result.digest does not match canonical {count, disposition}');
  }
  if (derived.disposition === 'rankable' && !manifest.result.conclusion) {
    errors.push('rankable evidence requires a conclusion');
  }
  if (derived.disposition === 'candidate_only' && manifest.result.conclusion !== undefined) {
    errors.push('candidate_only evidence must not carry a conclusion');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest, derived };
}

/**
 * Combines strict manifest validation with evidence produced by a separate
 * replay. A manifest alone can never create a scheduling-eligible result.
 */
export function admitDetectorEvidence(
  value: unknown,
  replayValue?: unknown,
): DetectorAdmission {
  const validation = validateDetectorEvidenceManifest(value);
  if (!validation.ok) return rejected(validation.errors);
  if (replayValue === undefined) return rejected(['independent replay evidence is required']);
  if (typeof replayValue !== 'object'
    || replayValue === null
    || (replayValue as Partial<CommittedDetectorReplayEvidence>)[COMMITTED_REPLAY_EVIDENCE] !== true) {
    return rejected(['independent replay evidence must come from the committed-input runner']);
  }

  const replay = replayEvidenceSchema.safeParse(replayValue);
  if (!replay.success) {
    return rejected(replay.error.issues.map((issue) => `replay.${formatPath(issue.path)}: ${issue.message}`));
  }

  const { manifest, derived } = validation;
  const evidence = replay.data;
  const mismatches: string[] = [];
  compareEvidence('commitOid', evidence.commitOid, manifest.input.commitOid, mismatches);
  compareEvidence('inputDigest', evidence.inputDigest, manifest.input.digest, mismatches);
  compareEvidence('universe', evidence.universe, manifest.universe, mismatches);
  compareEvidence('rawCandidates', evidence.rawCandidates, manifest.rawCandidates, mismatches);
  compareEvidence('raw', evidence.raw, manifest.raw, mismatches);
  compareEvidence('exit', evidence.exit, manifest.exit, mismatches);
  compareEvidence('parser', evidence.parser, manifest.parser, mismatches);
  compareEvidence('filters', evidence.filters, manifest.filters, mismatches);
  compareEvidence('count', evidence.count, derived.count, mismatches);
  compareEvidence('disposition', evidence.disposition, derived.disposition, mismatches);
  compareEvidence('digest', evidence.digest, derived.digest, mismatches);
  if (mismatches.length > 0) return rejected(mismatches);

  if (derived.disposition === 'candidate_only') {
    const reason = derived.precision === null
      ? 'independent labels are insufficient to establish precision'
      : `independent sample precision ${derived.precision} is below 0.5`;
    return {
      status: 'candidate_only',
      schedulingEligible: false,
      detectorId: manifest.detector.id,
      commitOid: manifest.input.commitOid,
      evidenceDigest: derived.digest,
      precision: derived.precision,
      candidates: manifest.rawCandidates,
      reasons: [reason],
    };
  }

  return createRankableAdmission({
    status: 'rankable',
    schedulingEligible: true,
    detectorId: manifest.detector.id,
    commitOid: manifest.input.commitOid,
    evidenceDigest: derived.digest,
    count: derived.count,
    precision: derived.precision ?? 0,
    candidates: manifest.rawCandidates,
    conclusion: manifest.result.conclusion!,
  });
}

/**
 * Resolves the input ref once, exports only those committed bytes, directly
 * executes argv without a shell, and admits only byte-for-byte replay matches.
 */
export async function replayDetectorEvidence(
  value: unknown,
  options: DetectorReplayOptions,
): Promise<DetectorAdmission> {
  const validation = validateDetectorEvidenceManifest(value);
  if (!validation.ok) return rejected(validation.errors);

  const { manifest, derived } = validation;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const maxInputBytes = positiveInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES);
  let exportRoot: string | undefined;

  try {
    const resolved = await runDirect(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${manifest.input.ref}^{commit}`],
      options.repositoryPath,
      timeoutMs,
      maxOutputBytes,
    );
    if (!successful(resolved)) {
      return rejected([`could not resolve committed input ref ${JSON.stringify(manifest.input.ref)}: ${executionFailure(resolved)}`]);
    }
    const commitOid = resolved.stdout.toString('utf8').trim();
    if (commitOid !== manifest.input.commitOid) {
      return rejected([`committed input ref resolved to ${commitOid || '(empty)'}, expected ${manifest.input.commitOid}`]);
    }

    exportRoot = await mkdtemp(join(tmpdir(), 'flowcrew-detector-evidence-'));
    let totalInputBytes = 0;
    const replayedFiles: Array<{ path: string; sha256: string }> = [];
    for (const inputFile of manifest.input.files) {
      const blob = await runDirect(
        'git',
        ['show', `${commitOid}:${inputFile.path}`],
        options.repositoryPath,
        timeoutMs,
        maxInputBytes,
      );
      if (!successful(blob)) {
        return rejected([`could not read ${inputFile.path} from committed input ${commitOid}: ${executionFailure(blob)}`]);
      }
      totalInputBytes += blob.stdout.byteLength;
      if (totalInputBytes > maxInputBytes) {
        return rejected([`committed input exceeds explicit ${maxInputBytes}-byte limit`]);
      }
      const fileDigest = sha256(blob.stdout);
      if (fileDigest !== inputFile.sha256) {
        return rejected([`committed input digest mismatch for ${inputFile.path}`]);
      }
      replayedFiles.push({ path: inputFile.path, sha256: fileDigest });
      const destination = join(exportRoot, ...inputFile.path.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, blob.stdout);
    }

    const inputDigest = digestCanonical({
      files: replayedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    });
    if (inputDigest !== manifest.input.digest) {
      return rejected(['committed input aggregate digest does not match manifest.input.digest']);
    }

    const argv = manifest.detector.argv.map((argument) => argument.replaceAll(INPUT_ROOT_PLACEHOLDER, exportRoot!));
    const execution = await runDirect(argv[0]!, argv.slice(1), exportRoot, timeoutMs, maxOutputBytes);
    const raw = {
      stdout: execution.stdout.toString('utf8'),
      stderr: execution.stderr.toString('utf8'),
    };
    const exit = {
      code: execution.code,
      signal: execution.signal,
      timedOut: execution.timedOut,
    };
    const parsedResult = parseSingleProbeValue({ raw, exit }, detectorParserResultSchema);
    if (execution.outputLimitExceeded) {
      return rejected([`replay process failure: detector output exceeds explicit ${maxOutputBytes}-byte limit`]);
    }
    if (execution.spawnError) {
      return rejected([`replay process failure: ${executionFailure(execution)}`]);
    }
    if (!parsedResult.ok) {
      const details = parsedResult.kind === 'process'
        ? [executionFailure(execution), ...parsedResult.errors]
        : parsedResult.errors;
      return rejected(details.map((error) => `replay ${parsedResult.kind} failure: ${error}`));
    }
    const replayUniverse = {
      ...parsedResult.value.universe,
      digest: universeDigest(parsedResult.value.universe),
    };
    const replayEvidence: CommittedDetectorReplayEvidence = {
      [COMMITTED_REPLAY_EVIDENCE]: true,
      commitOid,
      inputDigest,
      universe: replayUniverse,
      rawCandidates: parsedResult.value.rawCandidates,
      raw,
      exit,
      parser: {
        id: 'flowcrew.detector-output-json',
        version: '1',
        result: parsedResult.value,
      },
      filters: parsedResult.value.filters,
      count: parsedResult.value.filters.filter((filter) => filter.disposition === 'keep').length,
      disposition: derived.disposition,
      digest: digestCanonical({
        count: parsedResult.value.filters.filter((filter) => filter.disposition === 'keep').length,
        disposition: derived.disposition,
      }),
    };
    return admitDetectorEvidence(manifest, replayEvidence);
  } catch (error) {
    return rejected([`detector replay could not complete: ${error instanceof Error ? error.message : String(error)}`]);
  } finally {
    if (exportRoot) await rm(exportRoot, { recursive: true, force: true });
  }
}

/** Returns only entries backed by the exact immutable admission registered at replay. */
export function rankEligibleDetectorEvidence(
  admissions: readonly DetectorAdmission[],
): DetectorSchedulingEntry[] {
  return admissions
    .map((admission) => RANKABLE_ADMISSION_ENTRIES.get(admission))
    .filter((entry): entry is Readonly<DetectorSchedulingEntry> => entry !== undefined)
    .sort((left, right) => right.count - left.count || left.detectorId.localeCompare(right.detectorId));
}

function deriveEvidence(
  filters: DetectorEvidenceManifest['filters'],
  labels: DetectorEvidenceManifest['independentLabels'],
): DerivedEvidence {
  const count = filters.filter((filter) => filter.disposition === 'keep').length;
  const positiveCount = labels.filter((label) => label.verdict === 'true_positive').length;
  const precision = labels.length === 0 ? null : positiveCount / labels.length;
  const disposition = precision !== null && precision >= 0.5 ? 'rankable' : 'candidate_only';
  return {
    count,
    precision,
    disposition,
    digest: digestCanonical({ count, disposition }),
  };
}

function universeValue(universe: DetectorEvidenceManifest['universe']) {
  return { definition: universe.definition, members: universe.members };
}

function universeDigest(universe: { definition: string; members: string[] }): string {
  return digestCanonical({
    definition: universe.definition,
    members: [...universe.members].sort((left, right) => left.localeCompare(right)),
  });
}

function requireUnique(values: string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${label} must be unique: ${value}`);
    seen.add(value);
  }
}

function compareEvidence(label: string, actual: unknown, expected: unknown, errors: string[]): void {
  if (!canonicalEqual(actual, expected)) errors.push(`independent replay ${label} does not match the manifest`);
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function rejected(errors: string[]): RejectedDetectorAdmission {
  return { status: 'rejected', schedulingEligible: false, errors };
}

function createRankableAdmission(
  value: Omit<RankableDetectorAdmission, typeof RANKABLE_EVIDENCE>,
): RankableDetectorAdmission {
  const admission = value as RankableDetectorAdmission;
  Object.defineProperty(admission, RANKABLE_EVIDENCE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  deepFreeze(admission);
  RANKABLE_ADMISSION_ENTRIES.set(admission, Object.freeze({
    detectorId: admission.detectorId,
    count: admission.count,
    evidenceDigest: admission.evidenceDigest,
    commitOid: admission.commitOid,
  }));
  return admission;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function isRepositoryPath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const normalized = posix.normalize(value);
  return normalized === value && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

function formatPath(path: PropertyKey[], suffix = false): string {
  if (path.length === 0) return suffix ? '' : '(root)';
  const formatted = path.map((part) => typeof part === 'number' ? `[${part}]` : String(part)).join('.').replace('.[', '[');
  return suffix ? `.${formatted}` : formatted;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function digestCanonical(value: unknown): string {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

interface DirectExecution {
  code: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
}

function runDirect(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<DirectExecution> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: string | undefined;

    const stopForLimit = () => {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      child.kill('SIGTERM');
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) stopForLimit();
      else stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxOutputBytes) stopForLimit();
      else stderr.push(chunk);
    });
    child.on('error', (error) => { spawnError = error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        outputLimitExceeded,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}

function successful(execution: DirectExecution): boolean {
  return execution.code === 0
    && execution.signal === null
    && !execution.timedOut
    && !execution.outputLimitExceeded
    && execution.spawnError === undefined;
}

function executionFailure(execution: DirectExecution): string {
  if (execution.spawnError) return execution.spawnError;
  if (execution.outputLimitExceeded) return 'output limit exceeded';
  if (execution.timedOut) return 'timed out';
  if (execution.signal) return `ended on signal ${execution.signal}`;
  const stderr = execution.stderr.toString('utf8').trim();
  return stderr || `exited ${execution.code ?? 'without an exit code'}`;
}
