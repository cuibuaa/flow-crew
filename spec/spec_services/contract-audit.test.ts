import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { extractBriefCriteria } from '../../src/brief-criteria.js';
import { inspectBrief } from '../../src/brief-preflight.js';
import { inspectRealityCheckReachability, parseDispatchedStageConfig } from '../../src/scheduler.js';

describe('collected contract audit', () => {
  it('retains a criterion containing an illustrative example', () => {
    const artifact = extractBriefCriteria([
      '# Task',
      '## Acceptance criteria',
      '1. Preserve every output property; for example, reject occupied create-only paths.',
    ].join('\n'));
    assert.equal(artifact.criteria.length, 1);
  });

  it('does not treat a descriptive QA-stage heading as an assignment', () => {
    const report = inspectBrief([
      '# Historical evidence',
      '## QA stage behavior in the prior run',
      'The stage recorded evidence without changing project files.',
    ].join('\n'));
    assert.equal(report.findings.some((finding) => finding.code === 'stage_writable_paths_missing'), false);
  });

  it('requires declared hard reads and refuses a missing declared producer', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-contract-audit-'));
    try {
      const stages = [parseDispatchedStageConfig({
        id: 'work', role: 'coder', scope: ['docs/owned.json'], depends_on: [],
        dependency_reasons: {}, prompt_template: 'produce the admitted artifact', skills: [],
        is_gate: false, criterion_refs: [],
        artifact_contract: { version: 1, produces: [{ id: 'owned', root: 'project', path: 'docs/owned.json' }], reads: [], replays: [] },
      })];
      const check = (reads: string) => `## Reality checks\n\`\`\`yaml\nchecks:\n  - name: future file\n    type: exec-script-exit-zero\n${reads}    params:\n      script: test -s docs/not_owned.json\n\`\`\`\n`;
      assert.match(inspectRealityCheckReachability({ markdown: check(''), projectDir, stages }).join('\n'), /REALITY_READ_DECLARATION_REQUIRED.*future file/);
      const reads = '    reads: [{id: missing, root: project, path: docs/not_owned.json, source: {kind: stage, stage: work, artifact: missing}}]\n';
      assert.match(inspectRealityCheckReachability({ markdown: check(reads), projectDir, stages }).join('\n'), /ARTIFACT_READ_UNREACHABLE.*missing/);
    } finally { rmSync(projectDir, { recursive: true, force: true }); }
  });

  it('refuses a declared hard read of the optional no-candidate result slot', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-contract-audit-'));
    try {
      mkdirSync(join(projectDir, 'docs'));
      const stages = [parseDispatchedStageConfig({
        id: 'measure', role: 'researcher', scope: ['docs/round.json'], depends_on: [],
        dependency_reasons: {}, prompt_template: 'measure or emit the no-candidate sidecar',
        skills: [], is_gate: false, criterion_refs: [],
        artifact_contract: { version: 1, produces: [{ id: 'round', root: 'project', path: 'docs/round.json' }], reads: [], replays: [] },
      })];
      const markdown = '## Reality checks\n```yaml\nchecks:\n  - name: numeric result exists\n    type: exec-script-exit-zero\n    reads: [{id: round, root: project, path: docs/round.json, source: {kind: stage, stage: measure, artifact: round}}]\n    params:\n      script: test -s docs/round.json\n```\n';
      assert.match(inspectRealityCheckReachability({ markdown, projectDir, stages,
        research: { baseline: 0, policy: 'best_of_n', resultFile: 'docs/round.json', reportDir: 'docs' },
      }).join('\n'), /valid no-candidate round writes only its sidecar/);
    } finally { rmSync(projectDir, { recursive: true, force: true }); }
  });
});
