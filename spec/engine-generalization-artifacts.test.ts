import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactContractSchema } from '../src/artifact-declarations.js';
import { captureStageArtifactContractPreimages, inspectStageArtifactContract, verifyStageArtifactContract } from '../src/stage-artifact-contract.js';
import { artifacts, inputFile } from './spec_contracts/declared-fixtures.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-declared-artifact-'));
  roots.push(root);
  const projectDir = join(root, 'project'), runDir = join(root, 'run');
  mkdirSync(projectDir); mkdirSync(runDir);
  return { projectDir, runDir };
}
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
}
async function auditReport(projectDir: string, runDir: string, target: string, argv: string[] = []) {
  const artifactContract = artifacts(
    [{ id: 'report', root: 'project', path: 'reports/audit.md' }],
    [inputFile('test', target)],
    [{ id: 'evidence', runner: 'node_test', targets: ['test'], argv, expected: { exit_code: 0, failures: [] } }],
  );
  const input = { stageId: 'audit', template: 'Write reports/audit.md.', projectDir, runDir, artifactContract };
  const preimages = captureStageArtifactContractPreimages(input);
  write(join(projectDir, 'reports/audit.md'), '# Evidence is declared separately.\n');
  return verifyStageArtifactContract({ ...input, preimages }, { remainingMs: () => 30_000 });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('declared replay execution and collection', () => {
  it('refuses a selector that exercises no test even though the direct exit is zero', async () => {
    const { projectDir, runDir } = fixture(), target = 'spec/existing.test.cjs';
    const marker = join(projectDir, 'executed.marker');
    write(join(projectDir, target), `const { test } = require('node:test'); const { writeFileSync } = require('node:fs'); test('must execute', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); throw new Error('selected failure'); });\n`);
    const audit = await auditReport(projectDir, runDir, target, ['--test-name-pattern', 'never-selected']);
    expect(existsSync(marker)).toBe(false);
    expect(audit.replayExecutions[0]).toMatchObject({ runner: 'node_test', status: 'failed', exitCode: 0, executedTests: 0, timedOut: false });
    expect(audit.violations[0].reason).toContain('DECLARED_REPLAY_REFUSED');
  });
  it('executes genuine evidence and still refuses an absent exact target', async () => {
    const { projectDir, runDir } = fixture(), target = 'spec/genuine.test.cjs';
    const marker = join(projectDir, 'genuine.marker');
    write(join(projectDir, target), `const { test } = require('node:test'); const { writeFileSync } = require('node:fs'); test('genuine run', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`);
    const passing = await auditReport(projectDir, runDir, target);
    expect(existsSync(marker)).toBe(true);
    expect(passing.replayExecutions[0]).toMatchObject({ status: 'passed', exitCode: 0, collectedTests: 1, executedTests: 1 });
    expect(passing.violations).toEqual([]);
    const missing = await auditReport(projectDir, runDir, 'spec/missing.test.cjs');
    expect(missing.replayExecutions[0]).toMatchObject({ status: 'not_run', exitCode: null });
    expect(missing.violations.some((entry) => entry.reason.includes('absent') || entry.reason.includes('unavailable') || entry.reason.includes('readable'))).toBe(true);
  });
  it('refuses a declared target whose symlink resolves outside its exact root', async () => {
    const { projectDir, runDir } = fixture(), target = 'spec/link.test.cjs';
    const outside = join(dirname(projectDir), 'outside.test.cjs'), marker = join(dirname(projectDir), 'outside.marker');
    write(outside, `const { test } = require('node:test'); test('outside', () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`);
    mkdirSync(join(projectDir, 'spec')); symlinkSync(outside, join(projectDir, target));
    const contract = artifacts([], [inputFile('test', target)], [{ id: 'escape', runner: 'node_test', targets: ['test'], argv: [], expected: { exit_code: 0, failures: [] } }]);
    await expect(verifyStageArtifactContract({ stageId: 'audit', template: '', projectDir, runDir, artifactContract: contract }, { remainingMs: () => 30_000 })).rejects.toThrow('ARTIFACT_PATH_ESCAPE');
    expect(existsSync(marker)).toBe(false);
  });
  it('refuses shell operators and unsupported argv in a structured replay', () => {
    const replay = { id: 'shell', runner: 'node_test', targets: ['test'], argv: ['&&', 'touch escaped.marker'], expected: { exit_code: 0, failures: [] } };
    expect(() => ArtifactContractSchema.parse({ version: 1, produces: [], reads: [inputFile('test', 'spec/input.test.cjs')], replays: [replay] })).toThrow(/argv/);
  });
  it('executes exact dotfile and nested paths through declarations', async () => {
    const { projectDir, runDir } = fixture();
    for (const path of ['.hidden.test.cjs', 'spec/relative.test.cjs']) {
      write(join(projectDir, path), "const { test } = require('node:test'); test('runs', () => {});\n");
      expect((await auditReport(projectDir, runDir, path)).replayExecutions[0]).toMatchObject({ status: 'passed', executedTests: 1 });
    }
    expect(() => artifacts([], [inputFile('test', './spec/relative.test.cjs')])).toThrow(/exact/);
  });
});

describe('declared output freshness and inert report prose', () => {
  it('settles a run directory from complete member content without an asserted write list', () => {
    const { projectDir, runDir } = fixture();
    const input = { stageId: 'writer', template: '', projectDir, runDir,
      artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'tree', root: 'run', path: 'evidence', kind: 'directory', nonempty: true }], reads: [], replays: [] }) };
    const preimages = captureStageArtifactContractPreimages(input);
    write(join(runDir, 'evidence/deep/member.txt'), 'first');
    expect(inspectStageArtifactContract({ ...input, preimages }).violations).toEqual([]);
    const settled = captureStageArtifactContractPreimages(input);
    expect(inspectStageArtifactContract({ ...input, preimages: settled }).violations[0].reason).toContain('STALE');
    write(join(runDir, 'evidence/deep/member.txt'), 'other');
    utimesSync(join(runDir, 'evidence/deep/member.txt'), new Date(0), new Date(0));
    expect(inspectStageArtifactContract({ ...input, preimages: settled }).violations).toEqual([]);
    const renamed = captureStageArtifactContractPreimages(input);
    renameSync(join(runDir, 'evidence/deep/member.txt'), join(runDir, 'evidence/deep/renamed.txt'));
    expect(inspectStageArtifactContract({ ...input, preimages: renamed }).violations).toEqual([]);
    const removed = captureStageArtifactContractPreimages(input);
    rmSync(join(runDir, 'evidence/deep/renamed.txt'));
    expect(inspectStageArtifactContract({ ...input, preimages: removed }).violations).toEqual([]);
  });
  it('refuses unreadable directory content identities even with an asserted write or prior output', () => {
    const { projectDir, runDir } = fixture();
    const path = join(runDir, 'evidence');
    const input = { stageId: 'writer', template: '', projectDir, runDir,
      artifactContract: ArtifactContractSchema.parse({ version: 1, produces: [{ id: 'tree', root: 'run', path: 'evidence', kind: 'directory', nonempty: true }], reads: [], replays: [] }) };
    const preimages = captureStageArtifactContractPreimages(input);
    mkdirSync(path);
    symlinkSync('missing', join(path, 'link'));
    const audit = inspectStageArtifactContract({ ...input, preimages, writes: [path], priorProducedPromptArtifacts: [path] });
    expect(audit.violations[0].reason).toContain('declare link referents as file outputs');
    rmSync(join(path, 'link'));
    expect(inspectStageArtifactContract({ ...input, preimages }).violations[0].reason).toContain('STALE');
  });
  it('creates no duties or replay from prompt syntax, regexes, suffixes or inline command results', () => {
    const { projectDir, runDir } = fixture();
    const artifactContract = artifacts([{ id: 'report', root: 'project', path: 'reports/suffixes.md' }]);
    const input = { stageId: 'report', template: 'Write X/a.json and b.md; examples: input\\.md, docs/report.md.', projectDir, runDir, artifactContract };
    const preimages = captureStageArtifactContractPreimages(input);
    write(join(projectDir, 'reports/suffixes.md'), 'The suite uses `.test.ts` (189 files). Replay command: node --test missing.test.cjs: 0 tests passed.\n');
    const audit = inspectStageArtifactContract({ ...input, preimages });
    expect(audit.obligations).toEqual([expect.objectContaining({ kind: 'declared_artifact', source: 'declaration', mention: 'project:reports/suffixes.md' })]);
    expect(audit.replayExecutions).toEqual([]); expect(audit.violations).toEqual([]); expect(audit.advisories).toBeUndefined();
  });
  it.each(['reports/comparing.md', 'reports/comparing-results.md', 'comparing.md', 'reports/using.md'])(
    'requires declared %s independently of its prose spelling', (path) => {
      const { projectDir, runDir } = fixture();
      for (const quoted of [false, true]) {
        const input = { stageId: 'report', template: `Write ${quoted ? `\`${path}\`` : path}.`, projectDir, runDir, artifactContract: artifacts([{ id: 'report', root: 'project', path }]) };
        const audit = inspectStageArtifactContract(input);
        expect(audit.violations[0]).toMatchObject({ mention: `project:${path}`, reason: expect.stringContaining('ARTIFACT_OUTPUT_ABSENT_OR_STALE') });
      }
    },
  );
  it('declares a run baseline as an input independently of a produced report', () => {
    const { projectDir, runDir } = fixture();
    write(join(runDir, 'validation_baseline.json'), '{}\n');
    const input = { stageId: 'report', template: 'Write reports/result.v1.md; compare validation_baseline.json.', projectDir, runDir,
      artifactContract: artifacts([{ id: 'report', root: 'project', path: 'reports/result.v1.md' }], [inputFile('baseline', 'validation_baseline.json', 'run')]) };
    const preimages = captureStageArtifactContractPreimages(input); write(join(projectDir, 'reports/result.v1.md'), '# Result\n');
    expect(inspectStageArtifactContract({ ...input, preimages }).violations).toEqual([]);
  });
  it('refuses every later declared output even when another output is fresh', () => {
    const { projectDir, runDir } = fixture();
    const paths = ['reports/result.v1.md', 'reports/summary.v1.json', 'reports/second.v1.md'];
    const input = { stageId: 'report', template: 'Write the three declared outputs.', projectDir, runDir,
      artifactContract: artifacts(paths.map((path, index) => ({ id: `output_${index}`, root: 'project', path }))) };
    const preimages = captureStageArtifactContractPreimages(input); write(join(projectDir, paths[0]), '# Result\n');
    expect(inspectStageArtifactContract({ ...input, preimages }).violations.map((entry) => entry.mention)).toEqual(paths.slice(1).map((path) => `project:${path}`));
  });
  it('still refuses a declared preexisting output without a new attributable write', () => {
    const { projectDir, runDir } = fixture(); write(join(projectDir, 'reports/existing.md'), '# Old report\n');
    const input = { stageId: 'report', template: 'Write reports/existing.md.', projectDir, runDir,
      artifactContract: artifacts([{ id: 'report', root: 'project', path: 'reports/existing.md' }]) };
    const preimages = captureStageArtifactContractPreimages(input);
    expect(inspectStageArtifactContract({ ...input, preimages }).violations[0].reason).toContain('ARTIFACT_OUTPUT_ABSENT_OR_STALE');
  });
});
