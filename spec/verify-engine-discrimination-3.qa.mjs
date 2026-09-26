import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCodexJsonl } from '../src/adapters/codex.ts';
import {
  archivedGateRejections,
  buildGateDispatchPreamble,
  configuredValidationCommandRole,
  inspectRealityCheckReachability,
} from '../src/scheduler.ts';
import {
  compareSupervisorDirectionAcrossStages,
  verifyRepeatedWrongDirection,
} from '../src/supervisor.ts';
import { classifyAdapterFailure } from '../src/worker.ts';
import { scanSource } from './purity.ts';

const temporaryRoots = [];
const results = [];

function temporaryRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `flowcrew-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function record(id, property, expected, actual) {
  let pass = false;
  try {
    assert.deepStrictEqual(actual, expected);
    pass = true;
  } catch {
    // The structured result below is the durable diagnostic.
  }
  results.push({ id, property, pass, expected, actual });
}

function repeatedDirectionFixture(directionKey, siblingEvidence) {
  const stageId = 'accused';
  const attemptIndex = 1;
  const attemptStartedAt = '2026-09-22T18:00:00.000Z';
  const at = (second) => `2026-09-22T18:00:${String(second).padStart(2, '0')}.000Z`;
  const evidence = (hex) => ({
    version: 1,
    stageId,
    attemptIndex,
    attemptStartedAt,
    generation: hex.repeat(64),
  });
  const guidance = [
    {
      timestamp: at(10),
      targetAttemptIndex: attemptIndex,
      source: 'supervisor',
      directionEvidence: evidence('a'),
      assessment: {
        verdict: 'GUIDE',
        targetStage: stageId,
        reason: 'home run store input',
        guidance: 'change direction',
        directionKey,
        guidanceId: 'guide-one',
        evidenceIds: ['ev_aaaaaaaaaaaaaaaaaaaa'],
      },
    },
    {
      timestamp: at(20),
      targetAttemptIndex: attemptIndex,
      source: 'supervisor',
      directionEvidence: evidence('b'),
      assessment: {
        verdict: 'GUIDE',
        targetStage: stageId,
        reason: 'home run store input',
        guidance: 'change direction',
        directionKey,
        guidanceId: 'guide-two',
        evidenceIds: ['ev_bbbbbbbbbbbbbbbbbbbb'],
      },
    },
  ];
  const assessment = {
    verdict: 'ABORT',
    targetStage: stageId,
    reason: 'home run store input persists',
    guidance: null,
    directionKey,
    evidenceIds: ['ev_cccccccccccccccccccc'],
  };
  const delivery = (timestamp, invocationIndex, guidanceId) => ({
    type: 'guidance_delivery_checked',
    runId: 'fixture-run',
    timestamp,
    stageId,
    attemptIndex,
    attemptStartedAt,
    boundary: 'adapter_invocation',
    invocationIndex,
    guidanceIds: [guidanceId],
    delivered: true,
    source: 'worker',
  });
  return {
    assessment,
    result: verifyRepeatedWrongDirection({
      stageId,
      attemptIndex,
      assessment,
      currentEvidence: evidence('c'),
      guidance,
      deliveryEvents: [
        delivery(at(15), 1, 'guide-one'),
        delivery(at(25), 2, 'guide-two'),
      ],
      assessmentTimestamp: at(30),
      siblingEvidence,
    }),
  };
}

try {
  const historicalShape = [
    JSON.stringify({
      type: 'thread.started',
      thread_id: '11111111-1111-4111-8111-111111111111',
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'stage was already mid-work' },
    }),
    JSON.stringify({
      type: 'error',
      message: 'Selected model is at capacity. Please try a different model.',
    }),
    JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Selected model is at capacity. Please try a different model.' },
    }),
  ].join('\n');
  const parsedHistoricalShape = parseCodexJsonl(historicalShape);
  record(
    'item3-mid-work-capacity',
    'the production Codex parse boundary must preserve the terminal adapter failure kind',
    'capacity',
    classifyAdapterFailure(parsedHistoricalShape.output) ?? null,
  );
  record(
    'item3-raw-calibration',
    'the same classifier recognizes the raw historical stream',
    'capacity',
    classifyAdapterFailure(historicalShape) ?? null,
  );

  const sibling = {
    version: 1,
    stageId: 'sibling',
    attemptIndex: 1,
    attemptStartedAt: '2026-09-22T17:00:00.000Z',
    rows: [{
      id: 'ev_dddddddddddddddddddd',
      kind: 'command_invocation',
      authority: 'action',
      text: 'npm test',
    }],
  };
  const direction = repeatedDirectionFixture(
    'using_home_run_store_as_input_unique_marker',
    [sibling],
  );
  const syntheticRunInput = ['/', 'home', 'operator', '.fc', 'runs', 'current', 'input.md']
    .join('/');
  const accusedProjection = {
    version: 1,
    stageId: 'accused',
    attemptIndex: 1,
    attemptStartedAt: '2026-09-22T18:00:00.000Z',
    rows: [{
      // Match the ABORT's cited evidence identity so the production
      // cited-action precondition is satisfied; only the full predicate fails.
      id: 'ev_cccccccccccccccccccc',
      kind: 'command_invocation',
      authority: 'action',
      text: `cp ${syntheticRunInput} /tmp/input-copy.md`,
    }],
  };
  const accusedPredicate = compareSupervisorDirectionAcrossStages({
    accusedStageId: 'comparison-sentinel',
    assessment: direction.assessment,
    stageEvidence: [accusedProjection],
  });
  record(
    'item1-accused-predicate',
    'a direction may verify only when its full comparison predicate holds for the accused stage',
    { verified: false, accusedMatches: 0 },
    {
      verified: direction.result.verified,
      accusedMatches: accusedPredicate.matchingCount,
    },
  );

  const mixedArchive = temporaryRoot('mixed-gate-archive');
  const legacyRound = join(mixedArchive, 'gate_reevaluation', 'round_1');
  const unrelatedCanonicalRound = join(
    mixedArchive,
    'gate_reevaluation',
    'iteration_2',
    'round_1',
  );
  mkdirSync(legacyRound, { recursive: true });
  mkdirSync(unrelatedCanonicalRound, { recursive: true });
  writeFileSync(
    join(legacyRound, 'rejected_verdict_verify.json'),
    '{"pass":false,"reason":"durable same-gate rejection"}\n',
  );
  writeFileSync(join(unrelatedCanonicalRound, 'namespace-marker.txt'), 'other history\n');
  const mixedRejections = archivedGateRejections(mixedArchive, 'verify');
  const mixedPreamble = buildGateDispatchPreamble({
    runDirPath: mixedArchive,
    gateId: 'verify',
    evaluationRound: 2,
    priorAttemptCount: 1,
  }).split('\n')[0];
  record(
    'item4-mixed-archive',
    'framing must derive from the existence of a durable same-gate rejection even in a mixed archive',
    { rejectionCount: 1, framing: 'RE-EVALUATION' },
    {
      rejectionCount: mixedRejections.length,
      framing: mixedPreamble.split(' ')[0],
    },
  );

  const legacyOnlyArchive = temporaryRoot('legacy-only-gate-archive');
  const legacyOnlyRound = join(legacyOnlyArchive, 'gate_reevaluation', 'round_1');
  mkdirSync(legacyOnlyRound, { recursive: true });
  writeFileSync(
    join(legacyOnlyRound, 'rejected_verdict_verify.json'),
    '{"pass":false,"reason":"durable same-gate rejection"}\n',
  );
  record(
    'item4-legacy-only-calibration',
    'the archive resolver recognizes a same-gate legacy rejection when no canonical namespace exists',
    { rejectionCount: 1, framing: 'RE-EVALUATION' },
    {
      rejectionCount: archivedGateRejections(legacyOnlyArchive, 'verify').length,
      framing: buildGateDispatchPreamble({
        runDirPath: legacyOnlyArchive,
        gateId: 'verify',
        evaluationRound: 2,
        priorAttemptCount: 1,
      }).split('\n')[0].split(' ')[0],
    },
  );

  const redirectRoot = temporaryRoot('validation-redirection');
  const redirectProject = join(redirectRoot, 'project');
  const redirectLink = join(redirectRoot, 'external-log-link');
  const externalLog = join(redirectRoot, 'external.log');
  mkdirSync(join(redirectProject, 'dist'), { recursive: true });
  symlinkSync(join(redirectProject, 'dist', 'authored.txt'), redirectLink);
  const configuredCommands = [{ role: 'build', display: 'npm run build' }];
  record(
    'item5-direct-project-redirection',
    'a direct shell-authored project redirection must not receive validation provenance',
    null,
    configuredValidationCommandRole(
      'npm run build > dist/authored.txt',
      configuredCommands,
      redirectProject,
    ) ?? null,
  );
  record(
    'item5-symlink-project-redirection',
    'an external-looking redirection resolving into the project must not receive validation provenance',
    null,
    configuredValidationCommandRole(
      `npm run build > ${redirectLink}`,
      configuredCommands,
      redirectProject,
    ) ?? null,
  );
  record(
    'item5-external-redirection-calibration',
    'a configured command redirected to a real external destination retains validation provenance',
    'build',
    configuredValidationCommandRole(
      `npm run build > ${externalLog} 2>&1`,
      configuredCommands,
      redirectProject,
    ) ?? null,
  );

  const unsafeExpression = "['/', 'home', 'operator', '.fc', 'runs', 'fixture'].join('/')";
  const simpleParameter = [
    "import { readFileSync } from 'node:fs';",
    `const evidencePath = ${unsafeExpression};`,
    'function readNested(evidencePath) {',
    "  return readFileSync(evidencePath, 'utf8');",
    '}',
  ].join('\n');
  const destructuredParameter = [
    "import { readFileSync } from 'node:fs';",
    `const evidencePath = ${unsafeExpression};`,
    'function readNested({ evidencePath }) {',
    "  return readFileSync(evidencePath, 'utf8');",
    '}',
  ].join('\n');
  const mutableShadow = [
    "import { readFileSync } from 'node:fs';",
    `const evidencePath = ${unsafeExpression};`,
    'function readNested() {',
    "  let evidencePath = 'spec/fixtures/local.json';",
    "  return readFileSync(evidencePath, 'utf8');",
    '}',
  ].join('\n');
  const unsafeDefaultParameter = [
    "import { readFileSync } from 'node:fs';",
    `function readNested(evidencePath = ${unsafeExpression}) {`,
    "  return readFileSync(evidencePath, 'utf8');",
    '}',
  ].join('\n');
  const absoluteHome = (source, file) => scanSource(source, file)
    .filter(({ rule }) => rule === 'absolute-home');
  record(
    'item6-simple-parameter-calibration',
    'a simple safe parameter shadows the unsafe outer declaration',
    [],
    absoluteHome(simpleParameter, 'spec/simple-parameter.test.ts'),
  );
  record(
    'item6-destructured-parameter',
    'a destructured safe parameter shadows the unsafe outer declaration',
    [],
    absoluteHome(destructuredParameter, 'spec/destructured-parameter.test.ts'),
  );
  record(
    'item6-mutable-shadow',
    'a mutable safe lexical binding shadows the unsafe outer declaration',
    [],
    absoluteHome(mutableShadow, 'spec/mutable-shadow.test.ts'),
  );
  record(
    'item6-unsafe-default-calibration',
    'an unsafe default parameter remains detectable after parameter bindings are modeled',
    [{
      file: 'spec/unsafe-default-parameter.test.ts',
      line: 3,
      rule: 'absolute-home',
      description: 'absolute user-home path',
    }],
    absoluteHome(unsafeDefaultParameter, 'spec/unsafe-default-parameter.test.ts'),
  );

  const researchRoot = temporaryRoot('research-order');
  const research = {
    baseline: 0,
    policy: 'greedy_stack',
    resultFile: 'docs/round_result.json',
    reportDir: 'docs',
    stop: { maxRounds: 2 },
  };
  const manifestCheck = [
    '## Reality checks',
    '```yaml',
    'checks:',
    '  - name: temporal_check',
    '    type: file-exists-nonempty',
    '    params:',
    '      paths: [docs/run_manifest.json]',
    '```',
  ].join('\n');
  const temporalErrors = inspectRealityCheckReachability({
    markdown: manifestCheck,
    projectDir: researchRoot,
    stages: [],
    research,
  });
  record(
    'item7-absent-current-manifest-control',
    'an absent post-consumption manifest is refused before confirmation dispatch',
    true,
    temporalErrors.some((error) => error.includes('writes it only after the current round')),
  );
} finally {
  for (const root of temporaryRoots.reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
}

const failures = results.filter(({ pass }) => !pass);
console.log(JSON.stringify({
  schemaVersion: 1,
  checks: results.length,
  passingChecks: results.length - failures.length,
  failingChecks: failures.length,
  failures: failures.map(({ id, property, expected, actual }) => ({
    id,
    property,
    expected,
    actual,
  })),
  results,
}, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
