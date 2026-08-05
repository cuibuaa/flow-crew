import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const fixtureRelative = 'tests/fixtures/p2-m4-detector-evidence';
const fixturePath = join(projectRoot, fixtureRelative, 'complete-manifest.json');
const completeManifest = JSON.parse(readFileSync(fixturePath, 'utf8')) as DetectorEvidenceManifest;

// This process is isolated from user state and implements the committed-input
// oracle without importing the production runner or canonical digest helper.
const INDEPENDENT_COMMITTED_REPLAY_PROBE = String.raw`
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [temporaryRoot, fixtureRelative, labelsJson] = process.argv.slice(1);
const repositoryPath = join(temporaryRoot, 'repository');
const committedFixture = join(repositoryPath, fixtureRelative);
const committedPath = fixtureRelative + '/input.txt';
await mkdir(committedFixture, { recursive: true });
await copyFile(join(process.cwd(), committedPath), join(repositoryPath, committedPath));
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
    manifest.result.digest = '8dbe603a2eb0e3512754763a400b5d27ea8bdc9bab2b1d9ef1fa6a3ac3ecf1cb';
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
      fixtureRelative,
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
