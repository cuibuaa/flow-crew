import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ArtifactContractSchema, inspectArtifactDeclarations } from '../src/artifact-declarations.js';
import { ArtifactPathSchema, resolveArtifactLocation } from '../src/artifact-location.js';
import { parseStageRecord, stageRecordSchema } from '../src/handoff.js';
import { AuditFindingsSchema } from '../src/scoped-audit-repair.js';

let root: string, project: string, run: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artifact-literal-location-'));
  project = join(root, 'project'); run = join(root, 'run');
  mkdirSync(project); mkdirSync(run);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const findings = (path: string) => ({ version: 1, findings: [{ id: 'page', paths: [path], reason: 'Correct the page.', criterion_ids: ['render'], invalidates_plan: false, repair_role: 'coder' }] });
const schema = () => stageRecordSchema({ isGate: true, criterionRefs: ['render'] });
const record = (path: string) => ({ pass: false, reason: 'The page needs repair.', criteria: { render: { status: 'fail', evidence: 'The page did not render.' } }, audit_findings: findings(path), repairability: { version: 1, disposition: 'repairable', evidence: 'Correct the page.' } });

describe('literal artifact locations have one confinement policy', () => {
  it.each(['app/(dashboard)/page.tsx', 'app/users/[id]/page.tsx'])('admits and resolves the literal framework filename %s through artifact and audit boundaries', path => {
    const artifactContract = ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'page', root: 'project', path }], reads: [] });
    expect(inspectArtifactDeclarations({ stages: [{ id: 'writer', depends_on: [], artifact_contract: artifactContract }], projectDir: project, runDir: run })).toEqual([]);
    expect(AuditFindingsSchema.parse(findings(path))).toEqual(findings(path));
    expect(parseStageRecord(JSON.stringify(record(path)), schema())).toEqual(record(path));
    expect(resolveArtifactLocation({ root: 'project', path }, project, run)).toBe(join(project, path));
  });

  it('resolves punctuation literally without selecting matching siblings', () => {
    const path = 'app/[id]/(view)/{literal}!*.tsx';
    const target = join(project, path);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, 'literal');
    mkdirSync(join(project, 'app', 'i'), { recursive: true }); writeFileSync(join(project, 'app', 'i', 'page.tsx'), 'sibling');
    expect(ArtifactPathSchema.parse(path)).toBe(path);
    expect(resolveArtifactLocation({ root: 'project', path }, project, run)).toBe(target);
  });

  it.each(['/outside/page.tsx', '../page.tsx', 'app/../page.tsx', './page.tsx', 'app//page.tsx', 'app/', 'app\\page.tsx', 'app/\0page.tsx'])('refuses an unconfined or noncanonical literal location %j at every boundary', path => {
    expect(ArtifactPathSchema.safeParse(path).success).toBe(false);
    expect(AuditFindingsSchema.safeParse(findings(path)).success).toBe(false);
    expect(() => parseStageRecord(JSON.stringify(record(path)), schema())).toThrow('STAGE_RECORD_INVALID');
    expect(() => resolveArtifactLocation({ root: 'project', path }, project, run)).toThrow();
  });

  it.each(['linked/page.tsx', '[external]/(view)/page.tsx'])('refuses the literal location %s below a symlink that leaves the declared root', path => {
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(project, path.split('/')[0]));
    expect(ArtifactPathSchema.safeParse(path).success).toBe(true);
    expect(() => resolveArtifactLocation({ root: 'project', path }, project, run)).toThrow('ARTIFACT_PATH_ESCAPE');
  });
});
