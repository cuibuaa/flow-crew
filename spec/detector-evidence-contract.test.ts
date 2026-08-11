import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  admitDetectorEvidence,
  rankEligibleDetectorEvidence,
  replayDetectorEvidence,
  validateDetectorEvidenceManifest,
  type DetectorEvidenceManifest,
  type DetectorReplayEvidence,
} from '../src/detector-evidence.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const DETECTOR_INPUT_PATH = 'fixtures/detector-evidence/input.txt';
const DETECTOR_INPUT = [
  'u-1|candidate|keep|independent review confirmed this candidate',
  'u-2|candidate|drop|candidate duplicates u-1',
  'u-3|candidate|keep|independent review confirmed this candidate',
  'u-4|control|drop|control row is outside the candidate set',
  '',
].join('\n');
const DETECTOR_SCRIPT = String.raw`import{readFileSync as r}from'node:fs';const rows=r(process.argv[1],'utf8').split(/\r?\n/).filter(line=>line.length>0).map((line,index)=>{const[id,kind,disposition,reason]=line.split('|');if(!id||!kind||!disposition||!reason||!['keep','drop'].includes(disposition))throw new Error('malformed fixture row '+(index+1));return{id,kind,disposition,reason,line:index+1}});const rawCandidates=rows.filter(row=>row.kind==='candidate').map(row=>({id:row.id,attributes:{sourceLine:row.line,value:row.id}}));const candidateIds=new Set(rawCandidates.map(candidate=>candidate.id));const filters=rows.filter(row=>candidateIds.has(row.id)).map(row=>({candidateId:row.id,disposition:row.disposition,reason:row.reason}));process.stdout.write(JSON.stringify({schema:'flowcrew.detector-output/v1',detector:{id:'fixture.generic-row-detector',version:'1.0.0'},universe:{definition:'all non-empty rows in the committed fixture input',members:rows.map(row=>row.id)},rawCandidates,filters})+String.fromCharCode(10))`;
const INDEPENDENT_LABELS: DetectorEvidenceManifest['independentLabels'] = [
  {
    candidateId: 'u-1',
    verdict: 'true_positive',
    reviewer: 'independent-reviewer-a',
    rationale: 'confirmed against the committed fixture row',
  },
  {
    candidateId: 'u-2',
    verdict: 'false_positive',
    reviewer: 'independent-reviewer-a',
    rationale: 'duplicate does not support a separate conclusion',
  },
  {
    candidateId: 'u-3',
    verdict: 'true_positive',
    reviewer: 'independent-reviewer-a',
    rationale: 'confirmed against the committed fixture row',
  },
];

// Expected evidence is derived from source rows with a test-local parser and
// canonicalizer. Neither production validation nor replay participates in its
// construction; the executable detector below is a second implementation.
const completeManifest = constructManifestFromSourceRows(DETECTOR_INPUT);

// This process is isolated from user state and implements the committed-input
// oracle without importing the production runner or canonical digest helper.
const INDEPENDENT_COMMITTED_REPLAY_PROBE = String.raw`
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [temporaryRoot, committedPath, inputText, labelsJson] = process.argv.slice(1);
const repositoryPath = join(temporaryRoot, 'repository');
await mkdir(dirname(join(repositoryPath, committedPath)), { recursive: true });
await writeFile(join(repositoryPath, committedPath), inputText);
const git = (args) => execFileSync('git', args, { cwd: repositoryPath });
git(['init', '--quiet']);
git(['config', 'user.email', 'fixture@example.invalid']);
git(['config', 'user.name', 'Fixture Author']);
git(['add', committedPath]);
git(['commit', '--quiet', '-m', 'committed detector input']);
const commitOid = git(['rev-parse', 'HEAD']).toString('utf8').trim();
await writeFile(join(repositoryPath, committedPath), 'working-tree drift must be ignored\n');
const committedBytes = git(['show', commitOid + ':' + committedPath]);

const rows = committedBytes.toString('utf8')
  .split(/\r?\n/)
  .filter((line) => line.length > 0)
  .map((line, index) => {
    const [id, kind, disposition, reason] = line.split('|');
    if (!id || !kind || !disposition || !reason || !['keep', 'drop'].includes(disposition)) {
      throw new Error('malformed fixture row ' + (index + 1));
    }
    return { id, kind, disposition, reason, line: index + 1 };
  });
const candidateIds = new Set(rows.filter((row) => row.kind === 'candidate').map((row) => row.id));
const filters = rows
  .filter((row) => candidateIds.has(row.id))
  .map((row) => ({ candidateId: row.id, disposition: row.disposition, reason: row.reason }));
const count = filters.filter((filter) => filter.disposition === 'keep').length;
const labels = JSON.parse(labelsJson);
const precision = labels.length === 0
  ? null
  : labels.filter((label) => label.verdict === 'true_positive').length / labels.length;
const disposition = precision !== null && precision >= 0.5 ? 'rankable' : 'candidate_only';
const canonical = (value) => {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const inputSha256 = hash(committedBytes);
const inputDigest = hash(Buffer.from(canonical({
  files: [{ path: committedPath, sha256: inputSha256 }],
}), 'utf8'));
const digest = hash(Buffer.from(canonical({ count, disposition }), 'utf8'));
process.stdout.write(JSON.stringify({ repositoryPath, commitOid, inputSha256, inputDigest, count, disposition, digest }));
`;

function cloneManifest(): DetectorEvidenceManifest {
  return structuredClone(completeManifest);
}

function constructManifestFromSourceRows(input: string): DetectorEvidenceManifest {
  const rows = input
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const [id, kind, disposition, reason] = line.split('|');
      if (!id || !kind || !reason || (disposition !== 'keep' && disposition !== 'drop')) {
        throw new Error(`malformed source row ${index + 1}`);
      }
      return { id, kind, disposition, reason, line: index + 1 };
    });
  const rawCandidates: DetectorEvidenceManifest['rawCandidates'] = rows
    .filter((row) => row.kind === 'candidate')
    .map((row) => ({
      id: row.id,
      attributes: { sourceLine: row.line, value: row.id },
    }));
  const candidateIds = new Set(rawCandidates.map(({ id }) => id));
  const filters: DetectorEvidenceManifest['filters'] = rows
    .filter(({ id }) => candidateIds.has(id))
    .map(({ id, disposition, reason }) => ({ candidateId: id, disposition, reason }));
  const universeValue = {
    definition: 'all non-empty rows in the committed fixture input',
    members: rows.map(({ id }) => id),
  };
  const parserResult: DetectorEvidenceManifest['parser']['result'] = {
    schema: 'flowcrew.detector-output/v1',
    detector: { id: 'fixture.generic-row-detector', version: '1.0.0' },
    universe: universeValue,
    rawCandidates,
    filters,
  };
  const fileSha256 = independentSha256(Buffer.from(input, 'utf8'));
  const files = [{ path: DETECTOR_INPUT_PATH, sha256: fileSha256 }];
  const count = filters.filter(({ disposition }) => disposition === 'keep').length;
  const truePositiveCount = INDEPENDENT_LABELS
    .filter(({ verdict }) => verdict === 'true_positive').length;
  const precision = INDEPENDENT_LABELS.length === 0
    ? null
    : truePositiveCount / INDEPENDENT_LABELS.length;
  const disposition = precision !== null && precision >= 0.5 ? 'rankable' : 'candidate_only';

  return {
    schema: 'flowcrew.detector-evidence/v1',
    detector: {
      id: 'fixture.generic-row-detector',
      version: '1.0.0',
      argv: ['node', '--input-type=module', '--eval', DETECTOR_SCRIPT, `{{inputRoot}}/${DETECTOR_INPUT_PATH}`],
    },
    input: {
      ref: 'HEAD',
      commitOid: '0'.repeat(40),
      files,
      digest: independentDigest({ files }),
    },
    universe: {
      ...universeValue,
      digest: independentDigest({
        definition: universeValue.definition,
        members: [...universeValue.members].sort((left, right) => left.localeCompare(right)),
      }),
    },
    rawCandidates,
    raw: { stdout: `${JSON.stringify(parserResult)}\n`, stderr: '' },
    exit: { code: 0, signal: null, timedOut: false },
    parser: { id: 'flowcrew.detector-output-json', version: '1', result: parserResult },
    filters,
    independentLabels: structuredClone(INDEPENDENT_LABELS),
    result: {
      count,
      precision,
      disposition,
      digest: independentDigest({ count, disposition }),
      ...(disposition === 'rankable'
        ? { conclusion: { statement: 'Kept candidates are backed by independently constructed evidence.' } }
        : {}),
    },
  };
}

function replayFrom(manifest: DetectorEvidenceManifest): DetectorReplayEvidence {
  return {
    commitOid: manifest.input.commitOid,
    inputDigest: manifest.input.digest,
    universe: manifest.universe,
    rawCandidates: manifest.rawCandidates,
    raw: manifest.raw,
    exit: manifest.exit,
    parser: manifest.parser,
    filters: manifest.filters,
    count: manifest.result.count,
    disposition: manifest.result.disposition,
    digest: manifest.result.digest,
  };
}

describe('detector evidence admission contract', () => {
  it('validates a complete manifest but rejects missing or caller-forged replay evidence', () => {
    const validation = validateDetectorEvidenceManifest(completeManifest);
    expect(validation).toMatchObject({ ok: true });

    const withoutReplay = admitDetectorEvidence(completeManifest);
    expect(withoutReplay).toMatchObject({ status: 'rejected', schedulingEligible: false });
    expect(rankEligibleDetectorEvidence([withoutReplay])).toEqual([]);

    const forgedReplay = admitDetectorEvidence(completeManifest, replayFrom(completeManifest));
    expect(forgedReplay).toMatchObject({ status: 'rejected', schedulingEligible: false });
    expect(rankEligibleDetectorEvidence([forgedReplay])).toEqual([]);
  });

  const deletionMutants: Array<{
    name: string;
    mutate: (manifest: Record<string, any>) => void;
  }> = [
    { name: 'raw', mutate: (manifest) => { delete manifest.raw; } },
    { name: 'exit', mutate: (manifest) => { delete manifest.exit; } },
    { name: 'parser', mutate: (manifest) => { delete manifest.parser; } },
    { name: 'universe', mutate: (manifest) => { delete manifest.universe; } },
    { name: 'rawCandidates', mutate: (manifest) => { delete manifest.rawCandidates; } },
    {
      name: 'one filter reason',
      mutate: (manifest) => { delete manifest.filters[0].reason; },
    },
  ];

  it.each(deletionMutants)('rejects a manifest missing $name and keeps its number out of ranking', ({ mutate }) => {
    const mutant = structuredClone(completeManifest) as unknown as Record<string, any>;
    mutate(mutant);

    expect(validateDetectorEvidenceManifest(mutant)).toMatchObject({ ok: false });
    const admission = admitDetectorEvidence(mutant, replayFrom(completeManifest));
    expect(admission).toMatchObject({ status: 'rejected', schedulingEligible: false });
    expect(admission).not.toHaveProperty('count');
    expect(rankEligibleDetectorEvidence([admission])).toEqual([]);
  });

  it('rejects inconsistent input metadata', () => {
    const inputMutant = cloneManifest();
    inputMutant.input.digest = 'f'.repeat(64);
    expect(validateDetectorEvidenceManifest(inputMutant)).toMatchObject({ ok: false });
  });

  it('requires candidate_only metadata below 50% precision', () => {
    const manifest = cloneManifest();
    manifest.independentLabels[0]!.verdict = 'false_positive';
    manifest.result.precision = 1 / 3;
    manifest.result.disposition = 'candidate_only';
    manifest.result.digest = independentDigest({ count: manifest.result.count, disposition: 'candidate_only' });
    delete manifest.result.conclusion;

    expect(validateDetectorEvidenceManifest(manifest)).toMatchObject({ ok: true });
  });

  it('treats exactly 50% precision as rankable', () => {
    const manifest = cloneManifest();
    manifest.independentLabels = manifest.independentLabels.slice(0, 2);
    manifest.result.precision = 0.5;

    expect(validateDetectorEvidenceManifest(manifest)).toMatchObject({ ok: true });
  });
});

describe('independent committed-input replay', () => {
  it('matches an independent count/disposition oracle while ignoring working-tree drift', async () => {
    const fixture = await createCommittedReplayFixture();
    try {
      const manifest = cloneManifest();
      manifest.input.ref = fixture.commitOid;
      manifest.input.commitOid = fixture.commitOid;

      expect(fixture.inputSha256).toBe(manifest.input.files[0]!.sha256);
      expect(fixture.inputDigest).toBe(manifest.input.digest);
      const admission = await replayDetectorEvidence(manifest, {
        repositoryPath: fixture.repositoryPath,
        timeoutMs: 10_000,
        maxOutputBytes: 64_000,
        maxInputBytes: 64_000,
      });

      expect(admission).toMatchObject({
        status: fixture.disposition,
        schedulingEligible: true,
        count: fixture.count,
        evidenceDigest: fixture.digest,
        commitOid: fixture.commitOid,
      });
      expect({ count: admission.status === 'rankable' ? admission.count : undefined, disposition: admission.status })
        .toEqual({ count: fixture.count, disposition: fixture.disposition });

      const driftedEvidence = cloneManifest();
      driftedEvidence.input.ref = fixture.commitOid;
      driftedEvidence.input.commitOid = fixture.commitOid;
      driftedEvidence.raw.stderr = 'replay drift\n';
      const driftedAdmission = await replayDetectorEvidence(driftedEvidence, {
        repositoryPath: fixture.repositoryPath,
      });
      expect(driftedAdmission).toMatchObject({ status: 'rejected', schedulingEligible: false });
      expect(rankEligibleDetectorEvidence([driftedAdmission])).toEqual([]);

      const lowPrecision = cloneManifest();
      lowPrecision.input.ref = fixture.commitOid;
      lowPrecision.input.commitOid = fixture.commitOid;
      lowPrecision.independentLabels[0]!.verdict = 'false_positive';
      lowPrecision.result.precision = 1 / 3;
      lowPrecision.result.disposition = 'candidate_only';
      lowPrecision.result.digest = independentDigest({
        count: fixture.count,
        disposition: 'candidate_only',
      });
      delete lowPrecision.result.conclusion;
      const candidateOnly = await replayDetectorEvidence(lowPrecision, {
        repositoryPath: fixture.repositoryPath,
      });
      expect(candidateOnly).toMatchObject({
        status: 'candidate_only',
        schedulingEligible: false,
        precision: 1 / 3,
        candidates: manifest.rawCandidates,
      });
      expect(candidateOnly).not.toHaveProperty('count');
      expect(candidateOnly).not.toHaveProperty('conclusion');
      expect(rankEligibleDetectorEvidence([candidateOnly])).toEqual([]);

      const threshold = cloneManifest();
      threshold.input.ref = fixture.commitOid;
      threshold.input.commitOid = fixture.commitOid;
      threshold.independentLabels = threshold.independentLabels.slice(0, 2);
      threshold.result.precision = 0.5;
      const thresholdAdmission = await replayDetectorEvidence(threshold, {
        repositoryPath: fixture.repositoryPath,
      });
      expect(thresholdAdmission).toMatchObject({
        status: 'rankable',
        schedulingEligible: true,
        precision: 0.5,
      });
    } finally {
      await fixture.dispose();
    }
  }, 20_000);
});

describe('scheduling admission remains bound to replayed evidence', () => {
  it('does not rank a count changed after committed replay admission', async () => {
    const fixture = await createRankableFixtureAdmission();
    try {
      const { admission } = fixture;
      expect(admission.status).toBe('rankable');
      if (admission.status !== 'rankable') throw new Error('fixture replay was not rankable');

      const unverifiedCount = admission.count + 1_000;
      expect(Reflect.set(admission, 'count', unverifiedCount)).toBe(false);
      expect(Object.isFrozen(admission)).toBe(true);
      expect(Object.isFrozen(admission.candidates)).toBe(true);
      const schedulingEntries = rankEligibleDetectorEvidence([admission]);
      expect(schedulingEntries)
        .not.toContainEqual(expect.objectContaining({ count: unverifiedCount }));
      expect(Object.isFrozen(schedulingEntries[0])).toBe(true);
      expect(Reflect.set(schedulingEntries[0]!, 'count', unverifiedCount)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not rank a copied admission carrying a different count', async () => {
    const fixture = await createRankableFixtureAdmission();
    try {
      const { admission } = fixture;
      expect(admission.status).toBe('rankable');
      if (admission.status !== 'rankable') throw new Error('fixture replay was not rankable');

      const unverifiedCount = admission.count + 1_000;
      const copiedAdmission = { ...admission, count: unverifiedCount };

      expect(rankEligibleDetectorEvidence([copiedAdmission]))
        .not.toContainEqual(expect.objectContaining({ count: unverifiedCount }));
      expect(rankEligibleDetectorEvidence([copiedAdmission])).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});

interface CommittedReplayFixture {
  repositoryPath: string;
  commitOid: string;
  inputSha256: string;
  inputDigest: string;
  count: number;
  disposition: 'rankable' | 'candidate_only';
  digest: string;
  dispose: () => Promise<void>;
}

async function createCommittedReplayFixture(): Promise<CommittedReplayFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'p2-m4-independent-replay-'));
  const temporaryHome = join(temporaryRoot, 'home');
  const temporaryFcHome = join(temporaryRoot, 'fc-home');
  try {
    await mkdir(temporaryHome, { recursive: true });
    await mkdir(temporaryFcHome, { recursive: true });
    const stdout = execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      INDEPENDENT_COMMITTED_REPLAY_PROBE,
      temporaryRoot,
      DETECTOR_INPUT_PATH,
      DETECTOR_INPUT,
      JSON.stringify(completeManifest.independentLabels),
    ], {
      cwd: projectRoot,
      env: { ...process.env, HOME: temporaryHome, FC_HOME: temporaryFcHome },
      encoding: 'utf8',
    });
    const oracle = JSON.parse(stdout) as Omit<CommittedReplayFixture, 'dispose'>;
    return {
      ...oracle,
      dispose: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function createRankableFixtureAdmission() {
  const fixture = await createCommittedReplayFixture();
  try {
    const manifest = cloneManifest();
    manifest.input.ref = fixture.commitOid;
    manifest.input.commitOid = fixture.commitOid;
    const admission = await replayDetectorEvidence(manifest, {
      repositoryPath: fixture.repositoryPath,
      timeoutMs: 10_000,
      maxOutputBytes: 64_000,
      maxInputBytes: 64_000,
    });
    return { admission, dispose: fixture.dispose };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

function independentDigest(value: unknown): string {
  return createHash('sha256').update(independentCanonicalJson(value)).digest('hex');
}

function independentSha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function independentCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${independentCanonicalJson(record[key])}`
  )).join(',')}}`;
}
