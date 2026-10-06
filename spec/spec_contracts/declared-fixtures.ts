import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBriefCriteria } from '../../src/brief-criteria.js';
import { StageConfigSchema, type StageConfig } from '../../src/scheduler.js';
import type { RunOpts } from '../../src/adapters/base.js';
import { fixtureArtifactContract } from '../test-support/declared-dispatch.js';
import {
  ArtifactContractSchema,
  type ArtifactContract,
  type ArtifactContractInput,
  type ArtifactRead,
} from '../../src/artifact-declarations.js';

/** Exact fixture declarations. These helpers never inspect prompt/script text. */
export function artifacts(
  produces: ArtifactContractInput['produces'] = [],
  reads: ArtifactContractInput['reads'] = [],
  replays: ArtifactContractInput['replays'] = [],
  groups: ArtifactContractInput['groups'] = [],
): ArtifactContract {
  return ArtifactContractSchema.parse({ version: 1, produces, reads, replays, groups });
}

export function inputFile(id: string, path: string, root: 'project' | 'run' = 'project'): ArtifactRead {
  return { id, root, path, kind: 'file', source: { kind: 'input' } };
}

export function producedRead(id: string, path: string, stage: string, artifact = id, root: 'project' | 'run' = 'project'): ArtifactRead {
  return { id, root, path, kind: 'file', source: { kind: 'stage', stage, artifact } };
}

/** Preserve the shared fixture API; gate duties have one implementation. */
export const stageArtifacts = fixtureArtifactContract;

/** Authored static controls supply native criterion coverage instead of bypassing admission. */
export function coveredStages(subject: StageConfig, brief: string): StageConfig[] {
  const refs = extractBriefCriteria(brief).criteria.map((criterion) => criterion.id);
  if (!refs.length) throw new Error('Fixture coverage requires an explicit criterion');
  const fixture = StageConfigSchema.parse({
    id: subject.is_gate ? 'fixture_work' : 'fixture_audit', role: subject.role,
    prompt_template: 'Settle the mechanical fixture coverage prerequisite.', scope: [],
    depends_on: subject.is_gate ? [] : [subject.id],
    dependency_reasons: subject.is_gate ? {} : { [subject.id]: 'Verify the completed fixture subject.' },
    criterion_refs: refs, is_gate: !subject.is_gate,
    artifact_contract: { ...stageArtifacts(subject.is_gate ? 'fixture_work' : 'fixture_audit', !subject.is_gate),
      reads: subject.is_gate ? [] : [inputFile('criteria', 'brief_criteria.json', 'run')] },
  });
  return subject.is_gate
    ? [fixture, { ...subject, criterion_refs: refs, depends_on: [...subject.depends_on, fixture.id] }]
    : [{ ...subject, criterion_refs: refs }, fixture];
}

/** Only the extra mechanical fixture stages are settled; the subject adapter remains explicit. */
export function settleCoverageFixture(options: RunOpts): boolean {
  if (options.stageId === 'fixture_work') return true;
  if (options.stageId !== 'fixture_audit') return false;
  const artifact = JSON.parse(readFileSync(join(options.runDir, 'brief_criteria.json'), 'utf8')) as {
    criteria: Array<{ id: string }>;
  };
  writeFileSync(join(options.runDir, 'verdict_fixture_audit.json'), JSON.stringify({
    pass: true, reason: 'Mechanical fixture subject completed; property assertions follow in the spec.',
    criteria: Object.fromEntries(artifact.criteria.map(({ id }) => [id, { status: 'pass', evidence: 'Fixture subject settled.' }])),
  }));
  return true;
}
