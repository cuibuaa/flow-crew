import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { extractBriefCriteria } from '../../src/brief-criteria.js';
import { inspectRealityCheckReachability, parseDispatchedStageConfig } from '../../src/scheduler.js';

describe('collected contract audit', () => {
  it('retains a criterion containing an illustrative example', () => {
    const artifact = extractBriefCriteria("---\ncriteria: [{\"id\":\"fixture_1\",\"text\":\"Preserve every output property; for example, reject occupied create-only paths.\"}]\n---\n# Task\n## Acceptance criteria\n1. Preserve every output property; for example, reject occupied create-only paths.");
    assert.equal(artifact.criteria.length, 1);
  });

  it('requires declared hard reads and refuses a missing declared producer', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-contract-audit-'));
    try {
      const stages = [parseDispatchedStageConfig({
        id: 'work', role: 'coder', scope: ['docs/owned.json'], depends_on: [],
        dependency_reasons: {}, prompt_template: 'produce the admitted artifact', skills: [],
        is_gate: false, criterion_refs: [],
        artifact_contract: { version: 1, produces: [{ id: 'owned', root: 'project', path: 'docs/owned.json' }], reads: [] },
      })];
      const check = (reads: string) => `## Reality checks\n\`\`\`yaml\nchecks:\n  - name: future file\n    type: exec-script-exit-zero\n${reads}    params:\n      script: test -s docs/not_owned.json\n\`\`\`\n`;
      assert.match(inspectRealityCheckReachability({ markdown: check(''), projectDir, stages }).join('\n'), /REALITY_READ_DECLARATION_REQUIRED.*future file/);
      const reads = '    reads: [{id: missing, root: project, path: docs/not_owned.json, source: {kind: stage, stage: work, artifact: missing}}]\n';
      assert.match(inspectRealityCheckReachability({ markdown: check(reads), projectDir, stages }).join('\n'), /ARTIFACT_READ_UNBOUND.*missing/);
    } finally { rmSync(projectDir, { recursive: true, force: true }); }
  });
});
