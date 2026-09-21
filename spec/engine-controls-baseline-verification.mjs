import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { cmdShipSetupWithDeps } from '../src/cli-ship-setup.js';
import { loadProjectDefaults } from '../src/config.js';
import {
  isLiveConstraintExemptPath,
} from '../src/live-constraint-guard.js';
import { inspectRealityChecks } from '../src/reality-check-preflight.js';
import { runAllChecks } from '../src/reality-gate/index.js';
import { readRunEvents } from '../src/run-events.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { runWorkflow } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  runDir,
  setFcGlobalDir,
  writeRunState,
} from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const stageDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
const phase = process.argv[3] ?? 'before';
const baseCommit = process.argv[4] ?? '';

if (!stageDir || !/^[a-z][a-z0-9_-]*$/u.test(phase) || !/^[0-9a-f]{40}$/u.test(baseCommit)) {
  process.stderr.write(
    'usage: node --import tsx spec/engine-controls-baseline-verification.mjs '
      + '<task-stage-dir> <phase> <40-character-base-commit>\n',
  );
  process.exit(2);
}

const evidencePath = join(stageDir, `${phase}-engine-controls-replay.json`);
if (existsSync(evidencePath)) {
  process.stderr.write(`refusing to replace immutable replay evidence: ${evidencePath}\n`);
  process.exit(3);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (path) => readFileSync(path, 'utf8');
const json = (path) => JSON.parse(text(path));
const relativePath = (...segments) => segments.join('/');
const now = () => new Date().toISOString();

function listFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      return entry.isFile() ? [path] : [];
    })
    .sort();
}

function listDirectories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function selectEvent(event) {
  return {
    type: event.type,
    timestamp: event.timestamp,
    stageId: event.stageId,
    attemptIndex: event.attemptIndex,
    invocationIndex: event.invocationIndex,
    files: event.files,
    exemptedCount: event.exemptedCount,
    requestId: event.requestId,
    decision: event.decision,
    detail: event.detail,
    source: event.source,
    level: event.level,
  };
}

function selectStageStatus(status) {
  return {
    status: status.status,
    retries: status.retries,
    error: status.error,
    attempts: (status.attempts ?? []).map((attempt) => ({
      index: attempt.index,
      status: attempt.status,
      exitCode: attempt.exitCode,
      error: attempt.error,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    })),
    constraintAudit: status.constraintAudit,
  };
}

function measuredPopulation(members, sentinelId) {
  const measure = (input) => {
    const sentinelSeen = input.some((member) => member.id === sentinelId);
    const runnable = input.filter((member) => member.runnable === true);
    const dispositions = Object.fromEntries(
      [...new Set(input.map((member) => member.disposition))]
        .sort()
        .map((disposition) => [
          disposition,
          input.filter((member) => member.disposition === disposition).length,
        ]),
    );
    return {
      accepted: sentinelSeen,
      observedMembers: input.length,
      runnableMembers: runnable.length,
      dispositions,
      ...(sentinelSeen ? {} : { error: `sentinel ${sentinelId} was absent` }),
    };
  };
  const calibrated = measure(members);
  const broken = measure([]);
  assert.equal(calibrated.accepted, true, `population sentinel ${sentinelId}`);
  assert.equal(calibrated.observedMembers, members.length);
  assert.equal(calibrated.runnableMembers, members.length);
  assert.deepEqual(
    broken,
    {
      accepted: false,
      observedMembers: 0,
      runnableMembers: 0,
      dispositions: {},
      error: `sentinel ${sentinelId} was absent`,
    },
  );
  return {
    memberCount: members.length,
    allRunnable: calibrated.runnableMembers === members.length,
    counts: calibrated.dispositions,
    members,
    calibration: {
      knownPositive: calibrated,
      brokenEmptyChannel: broken,
      conclusion: 'A zero from a channel missing its sentinel is invalid, not a measured zero.',
    },
  };
}

function disposition(report) {
  if (report.refusingFindings.length > 0) return 'refused';
  if (report.advisoryFindings.length > 0) return 'admitted_with_advisories';
  return 'admitted';
}

function checkMarkdown(script, name = 'manifest fields exist') {
  return [
    '## Reality checks',
    '```yaml',
    'checks:',
    `  - name: ${name}`,
    '    type: exec-script-exit-zero',
    '    params:',
    '      script: |',
    ...script.trimEnd().split('\n').map((line) => `        ${line}`),
    '```',
    '',
  ].join('\n');
}

function inlineManifestCheck(options = {}) {
  const artifactPath = options.path ?? relativePath('output', 'manifest.json');
  return [
    "node <<'NODE'",
    "const fs = require('fs');",
    `const dataPath = '${artifactPath}';`,
    "const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));",
    'function fail(message) { console.error(message); process.exit(1); }',
    ...(options.prelude ?? []),
    ...(options.guards ?? [
      "if (!data.expected_one) fail('expected_one is absent');",
      "if (!data.expected_two || !Array.isArray(data.expected_two.rows)) fail('expected_two.rows is absent');",
    ]),
    'NODE',
    '',
  ].join('\n');
}

function seedEngineProject(projectDir, role = 'coder') {
  write(join(projectDir, 'config', 'defaults.yaml'), text(join(projectRoot, 'config', 'defaults.yaml')));
  write(join(projectDir, 'config', 'agents', `${role}.yaml`), [
    `name: ${role}`,
    'description: isolated engine-control replay role',
    'model: default',
    'reasoning_effort: low',
    'tools: []',
    'prompt: execute the deterministic replay',
    '',
  ].join('\n'));
  return join(projectDir, 'config', 'agents');
}

function oneStageWorkflow(name, role = 'coder') {
  return {
    yaml: [
      `name: ${name}`,
      'defaults:',
      '  max_iterations: 1',
      '  max_retries: 0',
      'stages:',
      '  - id: subject',
      `    role: ${role}`,
      '    scope: []',
      '    prompt_template: exercise the engine control',
      '',
    ].join('\n'),
    config: {
      name,
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'subject',
        role,
        depends_on: [],
        scope: [],
        prompt_template: 'exercise the engine control',
        skills: [],
        dynamic_dispatch: false,
        is_gate: false,
      }],
    },
  };
}

function prepareRun(projectDir, declared) {
  const created = createRun(
    projectDir,
    declared.config.name,
    declared.yaml,
    declared.config.stages.map((stage) => stage.id),
  );
  write(join(created.runDirPath, 'scheduler.pid'), `${process.pid}\n`);
  const state = readRunState(projectDir, created.runId);
  state.autoApprove = true;
  state.maxRetries = 0;
  writeRunState(projectDir, created.runId, state);
  return created;
}

async function waitUntil(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`condition was not reached within ${timeoutMs}ms`);
}

async function waitForScopeDecision(directory, requestId) {
  return waitUntil(() => {
    const name = readdirSync(directory).find((candidate) => (
      candidate.startsWith('scope_revision_decision_') && candidate.endsWith('.json')
    ));
    if (!name) return undefined;
    const decision = json(join(directory, name));
    return decision.requestId === requestId ? decision : undefined;
  });
}

const sourceEvidence = Object.fromEntries([
  relativePath('src', 'reality-check-preflight.ts'),
  relativePath('src', 'reality-gate', 'versioned-json-admission.ts'),
  relativePath('src', 'live-constraint-guard.ts'),
  relativePath('src', 'scheduler.ts'),
  relativePath('src', 'worker.ts'),
  relativePath('src', 'supervisor.ts'),
  relativePath('src', 'cli-ship-setup.ts'),
  relativePath('src', 'project-validation.ts'),
  relativePath('config', 'defaults.yaml'),
  'package.json',
  'vitest.config.ts',
].map((path) => [path, {
  bytes: readFileSync(join(projectRoot, path)).length,
  sha256: sha256(readFileSync(join(projectRoot, path))),
}]));

const startedAt = now();
const dependencyAuditRecordedAt = now();
const evidence = {
  version: 1,
  kind: 'engine_controls_frozen_replay',
  phase,
  baseCommit,
  startedAt,
  dependencyAuditRecordedAt,
  script: {
    path: relative(projectRoot, scriptPath).replaceAll('\\', '/'),
    bytes: readFileSync(scriptPath).length,
    sha256: sha256(readFileSync(scriptPath)),
  },
  sourceEvidence,
  evidenceBoundary: {
    operatorRunDirectoriesListed: false,
    operatorRunDirectoriesRead: false,
    daemonRestarted: false,
    persistentWrites: [relative(projectRoot, scriptPath).replaceAll('\\', '/'), evidencePath],
    temporaryRootOnly: true,
  },
  dependencyAudit: [
    {
      supplied: 'The checkout is based on a named main-line commit and uses an ext4 workspace.',
      dependsOn: 'The current HEAD identity and filesystem type still matching those supplied facts.',
      worth: 'High for pinning the baseline; measured locally before replay and recorded without changing behavior.',
    },
    {
      supplied: 'The malformed manifest check was authored after an unchanged emitter and asserted many unwritten fields.',
      dependsOn: 'The original emitter bytes, artifact bytes, field names, and timestamps, none of which are authorized inputs here.',
      worth: 'Strong evidence for the class, but not reproducible provenance; the replay measures the smallest engine-equivalent shape only.',
    },
    {
      supplied: 'Admission had no findings and did not read the produced artifact.',
      dependsOn: 'The planner check having a statically understood literal JSON load and the artifact already existing at admission time.',
      worth: 'High for early advisory detection; insufficient by itself to reject a later producer that legitimately owns the artifact.',
    },
    {
      supplied: 'A generated cache exemption was active while a Vitest cache member violated scope.',
      dependsOn: 'Both paths being untracked, default patterns being loaded, and the writes being attributable to the guarded invocation.',
      worth: 'High when replayed with one recognized cache sentinel and one Vitest member in the same scheduler invocation.',
    },
    {
      supplied: 'The test command creates a content-hashed Vitest tree with more than one file.',
      dependsOn: 'The configured Vitest version, cache mode, current content hash, and successful dependency availability.',
      worth: 'High for choosing the stable family; the current on-disk tree is enumerated read-only and frozen below.',
    },
    {
      supplied: 'A prior build produced a content-hashed generation tree.',
      dependsOn: 'The current build publisher and retained generation tree having the same content-addressed shape.',
      worth: 'Useful corroboration for a second family, not permission to generalize every hexadecimal directory.',
    },
    {
      supplied: 'An exact-file scope correction lost the next sibling write.',
      dependsOn: 'The first violation being restored before approval and a later sibling being written during the same attempt.',
      worth: 'High; both transitions are replayed through the scheduler for each observed hash family.',
    },
    {
      supplied: 'Operator guidance arrived after two supervisor GUIDE decisions and the stage ended two seconds later.',
      dependsOn: 'The source of the triggering assessment, prior actions belonging to the same attempt, and the original timestamps.',
      worth: 'High for source attribution, but the supplied two-second latency is not re-estimated without the original run.',
    },
    {
      supplied: 'Projects configured with a Make test target have unverified population parity when output is opaque.',
      dependsOn: 'The recipe exposing neither an exact collector nor complete TAP and having no explicit population declaration.',
      worth: 'High for the constructed project shape; recognizing the command text alone cannot prove identities.',
    },
    {
      supplied: 'The reach of the Make shape should be counted across recorded projects.',
      dependsOn: 'A bounded, authorized historical-project inventory with stable project identities.',
      worth: 'Currently unavailable: the same brief forbids listing or reading other run directories, so a synthetic count cannot be called prevalence.',
    },
    {
      supplied: 'The published suite has one real suffix family and an ignored alternate test directory.',
      dependsOn: 'The active Vitest include configuration, ignore rules, and current tracked spec filenames.',
      worth: 'High for test placement; both configured patterns and physical filename counts are measured below.',
    },
    {
      supplied: 'Build, test, and lint were green in the target ship-setup baseline.',
      dependsOn: 'The identity-bound ready record from this target.',
      worth: 'Accepted as the task baseline but not independently read from the operator store in this stage; later validation compares against the supplied empty failure set.',
    },
    {
      supplied: 'Another project may be active and the daemon must not be restarted.',
      dependsOn: 'Avoiding global process inspection and every daemon lifecycle command.',
      worth: 'A hard safety boundary; all mutable stores and projects in this replay are sandboxed.',
    },
  ],
  environmentMeasurements: {},
  items: {},
  failures: [],
};

const sandboxRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'engine-controls-baseline-')));
const isolatedStateRoot = join(sandboxRoot, 'state');
mkdirSync(isolatedStateRoot, { recursive: true });
const previousStateRoot = fcGlobalDir();
setFcGlobalDir(isolatedStateRoot);

async function capture(name, body) {
  const capturedAt = now();
  try {
    const value = await body();
    evidence.items[name] = { capturedAt, completedAt: now(), ...value };
  } catch (error) {
    const failure = {
      item: name,
      capturedAt,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    evidence.failures.push(failure);
    evidence.items[name] = { capturedAt, completedAt: now(), failure };
  }
}

try {
  const specFiles = listFiles(join(projectRoot, 'spec'))
    .map((path) => relative(projectRoot, path).replaceAll('\\', '/'));
  const suiteConfig = text(join(projectRoot, 'vitest.config.ts'));
  const ignoreConfig = text(join(projectRoot, '.gitignore'));
  const filesystemType = Number(statfsSync(projectRoot).type);
  evidence.environmentMeasurements = {
    capturedAt: now(),
    projectRootIsDirectory: lstatSync(projectRoot).isDirectory(),
    filesystemType,
    filesystemTypeHex: `0x${filesystemType.toString(16)}`,
    ext4Magic: filesystemType === 0xef53,
    configuredValidationCommands: json(join(projectRoot, 'package.json')).scripts,
    publishedSuite: {
      configuredTestTs: suiteConfig.includes('spec/**/*.test.ts'),
      configuredTestTsx: suiteConfig.includes('spec/**/*.test.tsx'),
      configuredReplayTs: suiteConfig.includes('spec/ux-perf-*.replay.ts'),
      configuredReplayTsx: suiteConfig.includes('spec/ux-perf-*.replay.tsx'),
      testTsFiles: specFiles.filter((path) => path.endsWith('.test.ts')).length,
      testTsxFiles: specFiles.filter((path) => path.endsWith('.test.tsx')).length,
      plausibleSpecTsFiles: specFiles.filter((path) => path.endsWith('.spec.ts')).length,
      plausibleSpecTsxFiles: specFiles.filter((path) => path.endsWith('.spec.tsx')).length,
      ignoredAlternateDirectory: /^tests\/$/mu.test(ignoreConfig),
    },
    storeIsolation: {
      configuredRoot: isolatedStateRoot,
      helperRunPath: runDir(join(sandboxRoot, 'isolation-probe-project'), 'probe-run'),
    },
  };
  assert.equal(evidence.environmentMeasurements.ext4Magic, true);
  assert.equal(evidence.environmentMeasurements.publishedSuite.configuredTestTs, true);
  assert.ok(evidence.environmentMeasurements.publishedSuite.testTsFiles > 0);
  assert.equal(evidence.environmentMeasurements.publishedSuite.plausibleSpecTsFiles, 0);
  assert.equal(evidence.environmentMeasurements.publishedSuite.plausibleSpecTsxFiles, 0);
  assert.equal(evidence.environmentMeasurements.publishedSuite.ignoredAlternateDirectory, true);
  assert.ok(
    evidence.environmentMeasurements.storeIsolation.helperRunPath.startsWith(`${isolatedStateRoot}/`),
    'runDir must honor the sandboxed state root',
  );

  await capture('problem1_admission_without_artifact_evidence', async () => {
    const brief = [
      '# Admission replay',
      'The worker may inspect the already-present versioned manifest before completing.',
      '',
    ].join('\n');
    const variants = [
      {
        id: 'unbound-versioned-multi-shape',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck(),
        expectedTerminal: 'advisory',
      },
      {
        id: 'discriminator-bound-multi-shape',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({
          prelude: ["if (data.artifact !== 'generic.summary.v2') fail('unexpected format');"],
        }),
        expectedTerminal: 'hard',
      },
      {
        id: 'single-incompatible-guard',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({
          guards: ["if (!data.expected_one) fail('expected_one is absent');"],
        }),
        expectedTerminal: 'hard',
      },
      {
        id: 'unversioned-artifact',
        artifact: { artifact: 'generic.summary', records: [] },
        script: inlineManifestCheck(),
        expectedTerminal: 'hard',
      },
      {
        id: 'computed-property-access',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({
          guards: [
            "if (!data['expected_one']) fail('expected_one is absent');",
            "if (!data['expected_two']) fail('expected_two is absent');",
          ],
        }),
        expectedTerminal: 'hard',
      },
      {
        id: 'malformed-json',
        artifactBytes: '{ malformed json\n',
        script: inlineManifestCheck(),
        expectedTerminal: 'hard',
      },
      {
        id: 'escaping-artifact-path',
        outsideArtifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({ path: '../outside.json' }),
        expectedTerminal: 'hard',
      },
      {
        id: 'absent-artifact',
        script: inlineManifestCheck(),
        expectedTerminal: 'hard',
      },
    ];

    const members = [];
    for (const variant of variants) {
      const fixtureRoot = join(sandboxRoot, 'problem-1', variant.id);
      const projectDir = join(fixtureRoot, 'project');
      mkdirSync(projectDir, { recursive: true });
      if (variant.artifact) {
        writeJson(join(projectDir, 'output', 'manifest.json'), variant.artifact);
      } else if (variant.artifactBytes) {
        write(join(projectDir, 'output', 'manifest.json'), variant.artifactBytes);
      }
      if (variant.outsideArtifact) writeJson(join(fixtureRoot, 'outside.json'), variant.outsideArtifact);
      const markdown = checkMarkdown(variant.script);
      const preflight = inspectRealityChecks(brief, markdown, { projectDir });
      const terminal = await runAllChecks(
        [{ name: 'manifest fields exist', type: 'exec-script-exit-zero', params: { script: variant.script } }],
        { projectDir, taskDir: join(fixtureRoot, 'task') },
      );
      const result = terminal.results[0];
      assert.equal(result.evidence?.code, 1, variant.id);
      assert.equal(result.advisory === true ? 'advisory' : 'hard', variant.expectedTerminal, variant.id);
      assert.deepEqual(preflight.blockingTierFindings, [], variant.id);
      assert.deepEqual(preflight.structuralFindings, [], variant.id);
      assert.deepEqual(preflight.advisoryFindings, [], variant.id);
      members.push({
        id: variant.id,
        runnable: true,
        disposition: disposition(preflight),
        construction: {
          artifactBytes: variant.artifact
            ? `${JSON.stringify(variant.artifact, null, 2)}\n`
            : variant.artifactBytes,
          outsideArtifactBytes: variant.outsideArtifact
            ? `${JSON.stringify(variant.outsideArtifact, null, 2)}\n`
            : undefined,
          checkMarkdown: markdown,
          script: variant.script,
        },
        preflight: {
          checksInspected: preflight.checksInspected,
          disposition: disposition(preflight),
          blockingTierFindings: preflight.blockingTierFindings,
          structuralFindings: preflight.structuralFindings,
          advisoryFindings: preflight.advisoryFindings,
        },
        terminal: {
          reportPass: terminal.pass,
          resultPass: result.pass,
          advisory: result.advisory === true,
          code: result.evidence?.code,
          signal: result.evidence?.signal,
          timedOut: result.evidence?.timedOut,
          stderr: result.evidence?.stderr,
          classification: result.evidence?.terminalAdmission?.classification,
        },
      });
    }

    const workflowProject = join(sandboxRoot, 'problem-1', 'full-workflow', 'project');
    mkdirSync(workflowProject, { recursive: true });
    seedEngineProject(workflowProject, 'coder');
    writeJson(join(workflowProject, 'output', 'manifest.json'), variants[0].artifact);
    const workflowYaml = [
      'name: admission-full-replay',
      'defaults:',
      '  max_iterations: 1',
      '  max_retries: 0',
      'stages:',
      '  - id: plan',
      '    role: planner',
      '    scope: []',
      '    dynamic_dispatch: true',
      '    prompt_template: write the deterministic dispatch and check',
      '',
    ].join('\n');
    const workflow = {
      name: 'admission-full-replay',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'plan',
        role: 'planner',
        depends_on: [],
        scope: [],
        prompt_template: 'write the deterministic dispatch and check',
        dynamic_dispatch: true,
        is_gate: false,
        skills: [],
      }],
    };
    const dispatch = [
      '- id: work',
      '  role: coder',
      '  depends_on: [plan]',
      '  dependency_reasons: {plan: "execute the admitted construction"}',
      '  scope: []',
      '  prompt_template: Complete without changing the pre-existing artifact.',
      '',
    ].join('\n');
    const adapter = new ScriptedAdapter({
      plan: {
        output: 'planned',
        runFiles: {
          'dispatch.yaml': dispatch,
          'reality_checks.md': checkMarkdown(variants[0].script),
        },
      },
      work: { output: 'work complete' },
      _summary: { output: 'summary' },
    });
    const final = await runWorkflow(
      workflow,
      workflowYaml,
      workflowProject,
      adapter,
      new Map(),
      undefined,
      join(projectRoot, 'config', 'agents'),
      undefined,
      brief,
      true,
      false,
    );
    const recordedRunDir = runDir(workflowProject, final.runId);
    assert.ok(recordedRunDir.startsWith(`${isolatedStateRoot}/`));
    const recordedPreflight = json(join(recordedRunDir, 'reality_check_preflight.json'));
    const terminalReport = json(join(recordedRunDir, '.reality-gate.json'));
    assert.equal(recordedPreflight.disposition, 'admitted');
    assert.deepEqual(recordedPreflight.blockingTierFindings, []);
    assert.deepEqual(recordedPreflight.structuralFindings, []);
    assert.deepEqual(recordedPreflight.advisoryFindings, []);
    assert.equal(terminalReport.results[0].evidence.code, 1);
    assert.equal(terminalReport.results[0].advisory, true);
    assert.equal(final.status, 'complete');

    return {
      classification: 'defect reproduced',
      smallestRecordedConstruction: members[0].construction,
      engineRecordedOutput: {
        runId: final.runId,
        finalStatus: final.status,
        preflight: recordedPreflight,
        terminalResult: terminalReport.results[0],
        events: readRunEvents(workflowProject, final.runId)
          .filter((event) => event.type === 'reality_gate_advisory')
          .map(selectEvent),
        stageExits: {
          plan: selectStageStatus(readStageStatus(workflowProject, final.runId, 'plan')),
          work: selectStageStatus(readStageStatus(workflowProject, final.runId, 'work')),
        },
      },
      population: measuredPopulation(members, 'unbound-versioned-multi-shape'),
      enumeration: 'Eight terminal-rescue boundary members named by the published guide and spec were constructed explicitly; every member executed through both admission inspection and the terminal reality-check runner.',
    };
  });

  await capture('problem2_vitest_cache_not_exempt', async () => {
    const defaults = loadProjectDefaults(projectRoot);
    const dependencyCacheRoot = join(projectRoot, 'node_modules', '.vite', 'vitest');
    const physicalMembers = listFiles(dependencyCacheRoot)
      .map((path) => relative(projectRoot, path).replaceAll('\\', '/'));
    assert.ok(physicalMembers.some((path) => path.endsWith('/results.json')));
    assert.ok(physicalMembers.some((path) => path.endsWith('/_metadata.json')));
    const members = physicalMembers.map((path) => {
      const exempt = isLiveConstraintExemptPath(path, defaults.live_constraint_exempt_patterns, new Set());
      assert.equal(exempt, false, path);
      return {
        id: path,
        runnable: true,
        disposition: exempt ? 'exempt' : 'violation',
        tracked: false,
      };
    });

    const projectDir = join(sandboxRoot, 'problem-2', 'project');
    const agentsDir = seedEngineProject(projectDir, 'coder');
    const declared = oneStageWorkflow('vitest-cache-baseline');
    const created = prepareRun(projectDir, declared);
    const cachePath = relativePath('node_modules', '.vite', 'vitest', '0123456789abcdef0123456789abcdef01234567', 'results.json');
    const knownExemptPath = relativePath('pkg', '__pycache__', 'module.cpython-312.pyc');
    let invocationCount = 0;
    const adapter = {
      async run(_prompt, _role, options) {
        if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        invocationCount += 1;
        if (invocationCount === 1) {
          write(join(projectDir, cachePath), '{"files":[]}\n');
          write(join(projectDir, knownExemptPath), 'generated bytecode\n');
          await waitUntil(() => !existsSync(join(projectDir, cachePath)));
          return {
            output: 'configured test command generated both cache paths',
            exitCode: 0,
            duration_ms: 1,
            writes: [cachePath, knownExemptPath],
            writeAttribution: 'structured',
          };
        }
        return {
          output: 'continued after live correction without further writes',
          exitCode: 0,
          duration_ms: 1,
          writes: [],
          writeAttribution: 'structured',
        };
      },
    };
    const final = await runWorkflow(
      declared.config,
      declared.yaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      agentsDir,
      created.runId,
      'Vitest cache exemption replay',
      true,
      false,
    );
    const events = readRunEvents(projectDir, created.runId);
    const exemptions = events.filter((event) => event.type === 'live_constraint_exemptions');
    const violations = events.filter((event) => event.type === 'live_constraint_violation');
    assert.equal(final.status, 'complete');
    assert.equal(invocationCount, 2);
    assert.equal(exemptions.length, 1);
    assert.equal(exemptions[0].exemptedCount, 1);
    assert.ok(violations.some((event) => event.files?.includes(cachePath)));
    assert.equal(existsSync(join(projectDir, cachePath)), false);
    assert.equal(existsSync(join(projectDir, knownExemptPath)), true);

    const trackedDecision = isLiveConstraintExemptPath(
      physicalMembers[0],
      defaults.live_constraint_exempt_patterns,
      new Set([physicalMembers[0]]),
    );
    const ordinaryPath = relativePath('src', 'ordinary.ts');
    const ordinaryDecision = isLiveConstraintExemptPath(
      ordinaryPath,
      defaults.live_constraint_exempt_patterns,
      new Set(),
    );
    const knownExemptDecision = isLiveConstraintExemptPath(
      knownExemptPath,
      defaults.live_constraint_exempt_patterns,
      new Set(),
    );
    assert.equal(trackedDecision, false);
    assert.equal(ordinaryDecision, false);
    assert.equal(knownExemptDecision, true);

    return {
      classification: 'defect reproduced',
      construction: {
        declaredScope: [],
        writes: [cachePath, knownExemptPath],
        defaultPatterns: defaults.live_constraint_exempt_patterns,
      },
      engineRecordedOutput: {
        runId: created.runId,
        finalStatus: final.status,
        invocationCount,
        events: [...exemptions, ...violations].map(selectEvent),
        stage: selectStageStatus(readStageStatus(projectDir, created.runId, 'subject')),
        resultingFiles: {
          vitestMemberExists: existsSync(join(projectDir, cachePath)),
          knownExemptMemberExists: existsSync(join(projectDir, knownExemptPath)),
        },
      },
      population: measuredPopulation(members, physicalMembers.find((path) => path.endsWith('/results.json'))),
      enumeration: `The current configured Vitest cache tree was enumerated read-only at baseline; ${physicalMembers.length} physical files were present and each was evaluated by the engine matcher.`,
      oldWayControls: [
        { id: 'tracked-member', runnable: true, disposition: trackedDecision ? 'exempt' : 'violation' },
        { id: ordinaryPath, runnable: true, disposition: ordinaryDecision ? 'exempt' : 'violation' },
        { id: knownExemptPath, runnable: true, disposition: knownExemptDecision ? 'exempt' : 'violation' },
      ],
    };
  });

  await capture('problem3_exact_scope_for_content_hash_tree', async () => {
    const vitestRoots = listDirectories(join(projectRoot, 'node_modules', '.vite', 'vitest'))
      .filter((path) => /^[0-9a-f]{40}$/u.test(basename(path)));
    const generationRoots = listDirectories(join(projectRoot, '.cache', 'build-generations'))
      .filter((path) => /^[0-9a-f]{64}$/u.test(basename(path)));
    assert.ok(vitestRoots.length > 0);
    assert.ok(generationRoots.length > 0);
    const families = [
      {
        id: 'vitest-content-hash',
        hash: basename(vitestRoots[0]),
        exactPath: relativePath('node_modules', '.vite', 'vitest', basename(vitestRoots[0]), 'results.json'),
        siblingPath: relativePath(
          'node_modules', '.vite', 'vitest', basename(vitestRoots[0]),
          'deps___vitest_vm__', '_metadata.json',
        ),
      },
      {
        id: 'build-generation-content-hash',
        hash: basename(generationRoots[0]),
        exactPath: relativePath(
          '.cache', 'build-generations', basename(generationRoots[0]), '.flowcrew-build-manifest.json',
        ),
        siblingPath: relativePath('.cache', 'build-generations', basename(generationRoots[0]), 'index.js'),
      },
    ];

    const members = [];
    for (const family of families) {
      const projectDir = join(sandboxRoot, 'problem-3', family.id, 'project');
      const agentsDir = seedEngineProject(projectDir, 'coder');
      const declared = oneStageWorkflow(`exact-scope-${family.id}`);
      const created = prepareRun(projectDir, declared);
      let invocationCount = 0;
      let decision;
      const requestId = `exact-${family.id}`;
      const adapter = {
        async run(prompt, _role, options) {
          if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
          invocationCount += 1;
          if (invocationCount === 1) {
            write(join(projectDir, family.exactPath), 'first refused write\n');
            await waitUntil(() => !existsSync(join(projectDir, family.exactPath)));
            return {
              output: 'first content-hash member was restored',
              exitCode: 0,
              duration_ms: 1,
              writes: [family.exactPath],
              writeAttribution: 'structured',
            };
          }
          if (invocationCount === 2) {
            assert.match(prompt, /Live constraint correction/u);
            const directory = join(options.runDir, 'stages', options.stageId);
            const requestedPaths = [family.exactPath];
            writeJson(join(directory, 'scope_revision_request.json'), {
              version: 1,
              kind: 'scope_revision',
              requestId,
              runId: created.runId,
              stageId: options.stageId,
              attemptIndex: options.attemptIndex,
              requestedPaths,
              pathDigest: scopePathDigest(requestedPaths),
              reason: 'the generated command needs the refused path',
            });
            decision = await waitForScopeDecision(directory, requestId);
            assert.equal(decision.accepted, true);
            return {
              output: 'exact scope accepted; stop at control boundary',
              exitCode: 0,
              duration_ms: 1,
              writes: [],
              writeAttribution: 'structured',
            };
          }
          if (invocationCount === 3) {
            assert.ok(prompt.includes(`Scope revision ${requestId} was accepted`));
            write(join(projectDir, family.exactPath), 'authorized exact member\n');
            write(join(projectDir, family.siblingPath), 'next generated sibling\n');
            await waitUntil(() => !existsSync(join(projectDir, family.siblingPath)));
            return {
              output: 'same command wrote the next sibling',
              exitCode: 0,
              duration_ms: 1,
              writes: [family.exactPath, family.siblingPath],
              writeAttribution: 'structured',
            };
          }
          if (invocationCount === 4) {
            assert.match(prompt, /Live constraint correction/u);
            write(join(projectDir, family.siblingPath), 'same command regenerated the sibling\n');
            await waitUntil(() => !existsSync(join(projectDir, family.siblingPath)));
            return {
              output: 'same command repeated the sibling write after live correction',
              exitCode: 0,
              duration_ms: 1,
              writes: [family.siblingPath],
              writeAttribution: 'structured',
            };
          }
          return { output: 'unexpected extra invocation', exitCode: 1, duration_ms: 1 };
        },
      };

      const final = await runWorkflow(
        declared.config,
        declared.yaml,
        projectDir,
        adapter,
        new Map(),
        undefined,
        agentsDir,
        created.runId,
        `Exact generated scope replay for ${family.id}`,
        true,
        false,
      );
      const status = readStageStatus(projectDir, created.runId, 'subject');
      const events = readRunEvents(projectDir, created.runId)
        .filter((event) => [
          'live_constraint_violation',
          'scope_revision_requested',
          'scope_revision_decided',
        ].includes(event.type));
      assert.equal(invocationCount, 4);
      assert.equal(decision.accepted, true);
      assert.deepEqual(decision.authorizedPaths, [family.exactPath]);
      assert.deepEqual(decision.effectiveScope, [family.exactPath]);
      assert.equal(status.status, 'failed');
      assert.match(status.error ?? '', /scope_violation: repeated live constraint violation after same-attempt correction/u);
      assert.equal(existsSync(join(projectDir, family.exactPath)), true);
      assert.equal(existsSync(join(projectDir, family.siblingPath)), false);
      assert.equal(events.filter((event) => event.type === 'live_constraint_violation').length, 3);
      assert.equal(events.filter((event) => event.type === 'scope_revision_decided').length, 1);
      members.push({
        id: family.id,
        runnable: true,
        disposition: 'exact-path-accepted-then-sibling-violation',
        construction: family,
        engineRecordedOutput: {
          runId: created.runId,
          finalStatus: final.status,
          invocationCount,
          decision,
          events: events.map(selectEvent),
          stage: selectStageStatus(status),
          exactPathExists: existsSync(join(projectDir, family.exactPath)),
          siblingPathExists: existsSync(join(projectDir, family.siblingPath)),
        },
      });
    }
    return {
      classification: 'defect reproduced',
      population: measuredPopulation(members, 'vitest-content-hash'),
      enumeration: 'The two content-addressed generator families named by the observation were required to exist on disk, identified by their 40- and 64-hex directory contracts, and each was replayed through scheduler negotiation plus a later sibling write.',
    };
  });

  await capture('problem4_operator_guidance_triggers_convergence_abort', async () => {
    const supervisorConfig = {
      enabled: true,
      adapter: 'scripted',
      model: 'test',
      reasoningEffort: 'low',
      pollIntervalMs: 30_000,
      routineAssessmentIntervalMs: 180_000,
      cooldownAfterActionMs: 0,
      maxAssessmentsPerIteration: 20,
      tailBytes: 16_384,
      minDeltaBytes: 4_096,
      stuckThresholdMs: 600_000,
    };
    const variants = [
      {
        id: 'operator-trigger-after-two-supervisor-guides',
        priorSources: ['supervisor', 'supervisor'],
        triggerSource: 'operator',
        expected: 'ABORT',
      },
      {
        id: 'supervisor-trigger-after-two-supervisor-guides',
        priorSources: ['supervisor', 'supervisor'],
        triggerSource: 'supervisor',
        expected: 'ABORT',
      },
      {
        id: 'operator-trigger-after-one-supervisor-guide',
        priorSources: ['supervisor'],
        triggerSource: 'operator',
        expected: 'WAIT',
      },
      {
        id: 'operator-trigger-after-two-operator-guides',
        priorSources: ['operator', 'operator'],
        triggerSource: 'operator',
        expected: 'WAIT',
      },
    ];
    const members = [];
    for (const variant of variants) {
      const projectDir = join(sandboxRoot, 'problem-4', variant.id, 'project');
      mkdirSync(projectDir, { recursive: true });
      const stageId = 'subject';
      const created = createRun(
        projectDir,
        `guidance-${variant.id}`,
        `name: guidance-${variant.id}\nstages:\n  - id: ${stageId}\n    role: coder\n`,
        [stageId],
      );
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const state = readRunState(projectDir, created.runId);
      state.stages[stageId] = {
        status: 'running',
        retries: 0,
        startedAt,
        attempts: [{ index: 1, startedAt, status: 'running' }],
      };
      writeRunState(projectDir, created.runId, state);
      const consumedPath = join(created.runDirPath, 'stages', stageId, 'guidance_consumed.md');
      write(consumedPath, 'Operator fact consumed for the current attempt.\n');
      const consumedAt = statfsSync(dirname(consumedPath)) && now();
      const supervisor = new Supervisor(
        projectDir,
        created.runId,
        { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) },
        supervisorConfig,
        'guidance attribution replay',
      );
      const guideAssessment = {
        verdict: 'GUIDE',
        targetStage: stageId,
        reason: 'the same implementation direction is wrong',
        guidance: 'use the required direction',
      };
      supervisor.actions = variant.priorSources.map((source, index) => ({
        timestamp: new Date(Date.now() - (variant.priorSources.length - index) * 1_000).toISOString(),
        tick: index + 1,
        assessment: guideAssessment,
        runningStages: [stageId],
        targetAttemptIndex: 1,
        source,
      }));
      supervisor.stageLastProgressMs = { [stageId]: Date.now() };
      const result = await supervisor.act(
        {
          verdict: 'ABORT',
          targetStage: stageId,
          reason: 'assessment made when operator supplied a missing fact',
          guidance: null,
        },
        Date.now() + 1_000,
        variant.triggerSource,
      );
      const signalPath = join(created.runDirPath, 'signals', `abort_${stageId}.json`);
      const signal = existsSync(signalPath) ? json(signalPath) : undefined;
      assert.equal(result.verdict, variant.expected, variant.id);
      assert.equal(Boolean(signal), variant.expected === 'ABORT', variant.id);
      if (variant.id === 'operator-trigger-after-two-supervisor-guides') {
        assert.match(signal.reason, /2 prior GUIDE decisions observed for the same running stage/u);
        assert.equal(signal.source, 'supervisor');
      }
      members.push({
        id: variant.id,
        runnable: true,
        disposition: result.verdict,
        construction: {
          priorGuideSources: variant.priorSources,
          triggerSource: variant.triggerSource,
          attemptIndex: 1,
          operatorFactConsumed: true,
        },
        engineRecordedOutput: {
          consumedAt,
          result,
          signal,
        },
      });
    }
    return {
      classification: 'defect reproduced',
      population: measuredPopulation(members, 'operator-trigger-after-two-supervisor-guides'),
      enumeration: 'The source/threshold cross-product relevant to the observed rule was bounded to the recorded two-supervisor-GUIDE case, its supervisor-triggered control, one-guide boundary, and two-operator-GUIDE boundary; every member called the engine abort authority against an active sandboxed attempt.',
    };
  });

  await capture('problem5_make_population_unverified', async () => {
    const root = join(sandboxRoot, 'problem-5');
    const sourceDir = join(root, 'source');
    const targetDir = join(root, 'target');
    const stateDir = join(root, 'state');
    mkdirSync(sourceDir, { recursive: true });
    write(join(sourceDir, 'Makefile'), [
      '.PHONY: test',
      'test:',
      "\t@printf '1 passed\\n'",
      '',
    ].join('\n'));
    const briefPath = join(sourceDir, 'brief.md');
    write(briefPath, '# Population replay\nRun the configured test population.\n');
    class CaptureWriter {
      value = '';
      writer = { write: (chunk) => { this.value += chunk; } };
    }
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    const runnerCalls = [];
    const code = await cmdShipSetupWithDeps([
      'ship-setup',
      '--brief', briefPath,
      '--project', sourceDir,
      '--target', targetDir,
      '--base', 'fixture-base',
      '--branch', 'fixture-branch',
    ], {
      createWorktree: (request) => {
        mkdirSync(request.targetDir, { recursive: true });
        copyFileSync(join(sourceDir, 'Makefile'), join(request.targetDir, 'Makefile'));
        return { exitCode: 0 };
      },
      runValidationCommand: (request) => {
        runnerCalls.push({
          role: request.role,
          command: request.command,
          args: request.args,
          display: request.display,
          side: request.cwd === sourceDir ? 'source' : 'target',
        });
        return { exitCode: 0, stdout: '1 passed\n', stderr: '', durationMs: 1 };
      },
      globalDir: () => stateDir,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });
    const records = listFiles(join(stateDir, 'ship-setups'));
    assert.equal(code, 0);
    assert.equal(stderr.value, '');
    assert.equal(records.length, 1);
    const record = json(records[0]);
    assert.equal(record.state, 'ready');
    assert.equal(record.testPopulation.state, 'unverified');
    assert.match(record.testPopulation.reason, /Configured test runner "make test"/u);
    assert.match(record.testPopulation.reason, /output is not complete TAP \(version line missing\)/u);
    assert.deepEqual(runnerCalls.map((call) => [call.side, call.role, call.display]), [
      ['source', 'test', 'make test'],
      ['target', 'test', 'make test'],
    ]);
    const members = [{
      id: 'make-test-with-opaque-non-tap-output',
      runnable: true,
      disposition: 'unverified',
      construction: {
        config: 'Makefile target named test',
        configuredCommand: 'make test',
        sourceOutput: '1 passed\n',
        targetOutput: '1 passed\n',
        explicitPopulationDeclaration: false,
      },
      engineRecordedOutput: {
        cliExitCode: code,
        stdout: stdout.value,
        stderr: stderr.value,
        reportState: record.state,
        testPopulation: record.testPopulation,
        validationBaseline: record.validationBaseline,
        runnerCalls,
      },
    }];
    const repositoryMakefiles = listFiles(join(projectRoot, 'spec', 'fixtures'))
      .filter((path) => basename(path) === 'Makefile')
      .map((path) => relative(projectRoot, path).replaceAll('\\', '/'));
    return {
      classification: 'defect reproduced for the functional shape; historical reach blocked by evidence boundary',
      population: measuredPopulation(members, 'make-test-with-opaque-non-tap-output'),
      enumeration: 'The functional set has one member because the supplied observation fixes all relevant axes: Makefile discovery, the make test command, no exact collector declaration, and opaque non-TAP output. The engine ran that member end to end.',
      historicalPrevalence: {
        requestedCorpus: 'projects recorded across the operator run store',
        state: 'not_measured',
        numerator: null,
        denominator: null,
        inspectedOtherRunDirectories: 0,
        reason: 'The brief both requests this prevalence and forbids listing or reading other run directories or using the operator home run store as input.',
        clearingCondition: 'Provide a task-local, immutable project inventory or explicitly authorize a bounded set of run records for read-only counting.',
        repositoryFixtureMakefiles: repositoryMakefiles,
        repositoryFixtureCount: repositoryMakefiles.length,
        warning: 'The repository fixture count is not substituted for historical prevalence.',
      },
    };
  });
} finally {
  setFcGlobalDir(previousStateRoot);
  rmSync(sandboxRoot, { recursive: true, force: true });
}

evidence.completedAt = now();
evidence.durationMs = Date.parse(evidence.completedAt) - Date.parse(evidence.startedAt);
evidence.pass = evidence.failures.length === 0;
mkdirSync(stageDir, { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

const summary = {
  pass: evidence.pass,
  phase,
  baseCommit,
  evidencePath,
  durationMs: evidence.durationMs,
  failures: evidence.failures.map(({ item, error }) => ({ item, error })),
  itemClassifications: Object.fromEntries(
    Object.entries(evidence.items).map(([name, value]) => [name, value.classification ?? 'capture failed']),
  ),
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = evidence.pass ? 0 : 1;
