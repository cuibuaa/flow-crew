import { runRecordPath } from './run-layout.js';
import { parseBriefDeclarations, type BriefDeclarations } from './brief-declarations.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from './engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';


export interface BriefCriterion {
  id: string;
  text: string;
  line: number;
  section: string;
}

export interface BriefCriteriaArtifact {
  version: 1;
  briefDigest: string;
  criteria: BriefCriterion[];
  /** New records snapshot declarations; archives need no active re-admission. */
  declarations?: BriefDeclarations;
  excluded?: Array<{ line: number; text: string; reason: 'explicitly_illustrative' }>;
}

/** Identities are authored declarations. Body prose has no engine meaning. */
export function extractBriefCriteria(brief: string): BriefCriteriaArtifact {
  const criteria = (parseBriefDeclarations(brief).criteria ?? []).map(criterion => ({
    ...criterion, line: 1, section: 'criteria',
  }));
  return { version: 1, briefDigest: createHash('sha256').update(brief, 'utf8').digest('hex'), criteria };
}

export function writeBriefCriteriaArtifact(runDir: string, brief: string): BriefCriteriaArtifact {
  const artifact = { ...extractBriefCriteria(brief), declarations: parseBriefDeclarations(brief) };
  writeFileSync(runRecordPath(runDir, 'brief_criteria.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
  return artifact;
}

/** Read admitted identities, including legacy IDs, without parsing old prose. */
export function readBriefCriteriaArtifact(runDir: string): BriefCriteriaArtifact | undefined {
  const path = runRecordPath(runDir, 'brief_criteria.json');
  if (!existsSync(path)) return;
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as BriefCriteriaArtifact;
  if (artifact.version !== 1 || typeof artifact.briefDigest !== 'string' || !Array.isArray(artifact.criteria)
    || artifact.criteria.some(c => typeof c.id !== 'string' || typeof c.text !== 'string')) {
    throw new Error('brief_criteria.json has an invalid shape');
  }
  return artifact;
}
