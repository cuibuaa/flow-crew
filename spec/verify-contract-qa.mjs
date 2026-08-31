import assert from 'node:assert/strict';
import { extractBriefCriteria } from '../dist/brief-criteria.js';
import { inspectBrief } from '../dist/brief-preflight.js';
import {
  inspectRealityCheckReachability,
  parseDispatchedStageConfig,
} from '../dist/scheduler.js';

const failures = [];

function verify(name, assertion) {
  try {
    assertion();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

verify('criterion containing an illustrative example is retained', () => {
  const artifact = extractBriefCriteria([
    '# Task',
    '## Acceptance criteria',
    '1. Preserve every output property; for example, reject occupied create-only paths.',
  ].join('\n'));
  assert.equal(artifact.criteria.length, 1);
});

verify('descriptive QA-stage heading is not an assignment', () => {
  const report = inspectBrief([
    '# Historical evidence',
    '## QA stage behavior in the prior run',
    'The stage recorded evidence without changing project files.',
  ].join('\n'));
  assert.equal(
    report.findings.some((finding) => finding.code === 'stage_writable_paths_missing'),
    false,
  );
});

verify('unquoted hard-check path is statically reachable', () => {
  const stage = parseDispatchedStageConfig({
    id: 'work',
    role: 'coder',
    scope: ['docs/owned.json'],
    depends_on: [],
    dependency_reasons: {},
    prompt_template: 'produce the admitted artifact',
    skills: [],
    is_gate: false,
    criterion_refs: [],
  });
  const markdown = [
    '## Reality checks',
    '```yaml',
    'checks:',
    '  - name: unquoted future file',
    '    type: exec-script-exit-zero',
    '    params:',
    '      script: test -s docs/not_owned.json',
    '```',
  ].join('\n');
  assert.match(
    inspectRealityCheckReachability({ markdown, projectDir: process.cwd(), stages: [stage] }).join('\n'),
    /docs\/not_owned\.json/,
  );
});

verify('hard checks cannot require a result file that a no-candidate round may omit', () => {
  const stage = parseDispatchedStageConfig({
    id: 'measure',
    role: 'researcher',
    scope: ['docs/round.json'],
    depends_on: [],
    dependency_reasons: {},
    prompt_template: 'measure or emit the no-candidate sidecar',
    skills: [],
    is_gate: false,
    criterion_refs: [],
  });
  const markdown = [
    '## Reality checks',
    '```yaml',
    'checks:',
    '  - name: numeric result exists',
    '    type: exec-script-exit-zero',
    '    params:',
    '      script: test -s docs/round.json',
    '```',
  ].join('\n');
  assert.match(
    inspectRealityCheckReachability({
      markdown,
      projectDir: process.cwd(),
      stages: [stage],
      research: {
        baseline: 0,
        policy: 'best_of_n',
        resultFile: 'docs/round.json',
        reportDir: 'docs',
      },
    }).join('\n'),
    /valid no-candidate round writes only its sidecar/,
  );
});

if (failures.length > 0) {
  console.error(`${failures.length} verification check(s) failed.`);
  process.exitCode = 1;
}
