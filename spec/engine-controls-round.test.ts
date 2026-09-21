import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import type { Adapter } from '../src/adapters/base.js';
import { cmdShipSetupWithDeps } from '../src/cli-ship-setup.js';
import { loadProjectDefaults } from '../src/config.js';
import {
  isLiveConstraintExemptPath,
  scopeRevisionInstruction,
  scopeRevisionPathsForViolations,
} from '../src/live-constraint-guard.js';
import { inspectRealityChecks } from '../src/reality-check-preflight.js';
import { runAllChecks } from '../src/reality-gate/index.js';
import { readRunEvents } from '../src/run-events.js';
import { scopePathDigest } from '../src/runtime-negotiation.js';
import { runWorkflow, type WorkflowConfig } from '../src/scheduler.js';
import {
  createRun,
  fcGlobalDir,
  readRunState,
  readStageStatus,
  runDir,
  setFcGlobalDir,
  writeRunState,
  writeStageStatus,
} from '../src/store.js';
import { Supervisor, type SupervisorAssessment } from '../src/supervisor.js';
import type { SupervisorConfig } from '../src/config.js';
import type { ValidationCommandRunner } from '../src/project-validation.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestCacheRoot = ['node_modules', '.vite', 'vitest'].join('/');

let sandboxRoot: string;
let isolatedStateRoot: string;
let previousStateRoot: string;

beforeEach(() => {
  sandboxRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'engine-controls-round-')));
  isolatedStateRoot = join(sandboxRoot, 'state');
  mkdirSync(isolatedStateRoot, { recursive: true });
  previousStateRoot = fcGlobalDir();
  setFcGlobalDir(isolatedStateRoot);
});

afterEach(() => {
  setFcGlobalDir(previousStateRoot);
  rmSync(sandboxRoot, { recursive: true, force: true });
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function afterEvidence(item: number, value: unknown): void {
  process.stdout.write(`[engine-controls-after:${item}] ${JSON.stringify({
    capturedAt: new Date().toISOString(),
    ...value as object,
  })}\n`);
}

interface PopulationMember {
  id: string;
  disposition: string;
  runnable: boolean;
  [key: string]: unknown;
}

function measuredPopulation(members: PopulationMember[], sentinelId: string): Record<string, unknown> {
  const measure = (input: PopulationMember[]) => ({
    accepted: input.some((member) => member.id === sentinelId),
    observedMembers: input.length,
    runnableMembers: input.filter((member) => member.runnable).length,
    dispositions: Object.fromEntries([...new Set(input.map((member) => member.disposition))]
      .sort()
      .map((disposition) => [
        disposition,
        input.filter((member) => member.disposition === disposition).length,
      ])),
  });
  const knownPositive = measure(members);
  const brokenEmptyChannel = measure([]);
  expect(knownPositive).toMatchObject({
    accepted: true,
    observedMembers: members.length,
    runnableMembers: members.length,
  });
  expect(brokenEmptyChannel).toEqual({
    accepted: false,
    observedMembers: 0,
    runnableMembers: 0,
    dispositions: {},
  });
  return {
    memberCount: members.length,
    allRunnable: true,
    counts: knownPositive.dispositions,
    members,
    calibration: {
      knownPositive,
      brokenEmptyChannel: {
        ...brokenEmptyChannel,
        error: `sentinel ${sentinelId} was absent`,
      },
    },
  };
}

function inlineManifestCheck(options: {
  path?: string;
  prelude?: string[];
  guards?: string[];
} = {}): string {
  return [
    "node <<'NODE'",
    "const fs = require('fs');",
    `const dataPath = '${options.path ?? 'output/manifest.json'}';`,
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

function checkMarkdown(script: string): string {
  return [
    '## Reality checks',
    '```yaml',
    'checks:',
    '  - name: manifest fields exist',
    '    type: exec-script-exit-zero',
    '    params:',
    '      script: |',
    ...script.trimEnd().split('\n').map((line) => `        ${line}`),
    '```',
    '',
  ].join('\n');
}

function seedEngineProject(projectDir: string, disableVitestExemption = false): string {
  let defaults = readFileSync(join(repositoryRoot, 'config', 'defaults.yaml'), 'utf8');
  if (disableVitestExemption) {
    defaults = defaults.split(/\r?\n/)
      .filter((line) => !line.includes(`${vitestCacheRoot}/**`))
      .join('\n');
  }
  write(join(projectDir, 'config', 'defaults.yaml'), defaults);
  const agentsDir = join(projectDir, 'config', 'agents');
  for (const role of ['coder', 'planner']) {
    write(join(agentsDir, `${role}.yaml`), [
      `name: ${role}`,
      'description: isolated engine-control replay role',
      'model: default',
      'reasoning_effort: low',
      'tools: []',
      'prompt: deterministic fixture',
      '',
    ].join('\n'));
  }
  return agentsDir;
}

function oneStageWorkflow(name: string): { config: WorkflowConfig; yaml: string } {
  return {
    yaml: [
      `name: ${name}`,
      'defaults:',
      '  max_iterations: 1',
      '  max_retries: 0',
      'stages:',
      '  - id: subject',
      '    role: coder',
      '    scope: []',
      '    prompt_template: exercise the engine control',
      '',
    ].join('\n'),
    config: {
      name,
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'subject', role: 'coder', depends_on: [], scope: [],
        prompt_template: 'exercise the engine control', skills: [],
        dynamic_dispatch: false, is_gate: false,
      }],
    },
  };
}

function prepareRun(projectDir: string, declared: { config: WorkflowConfig; yaml: string }) {
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

async function waitUntil<T>(read: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`condition was not reached within ${timeoutMs}ms`);
}

async function waitForScopeDecision(directory: string, requestId: string): Promise<Record<string, any>> {
  return waitUntil(() => {
    const name = readdirSync(directory).find((candidate) => (
      candidate.startsWith('scope_revision_decision_') && candidate.endsWith('.json')
    ));
    if (!name) return undefined;
    const decision = readJson(join(directory, name));
    return decision.requestId === requestId ? decision : undefined;
  });
}

describe('engine controls round replays', () => {
  it('1 detects only the frozen unbound multi-shape member before dispatch', { timeout: 30_000 }, async () => {
    const brief = '# Admission replay\nThe worker may inspect the already-present versioned manifest before completing.\n';
    const variants: Array<{
      id: string;
      artifact?: unknown;
      artifactBytes?: string;
      outsideArtifact?: unknown;
      script: string;
      expectedPreflight: 'admitted' | 'admitted_with_advisories';
      expectedTerminal: 'advisory' | 'hard';
    }> = [
      {
        id: 'unbound-versioned-multi-shape',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck(),
        expectedPreflight: 'admitted_with_advisories',
        expectedTerminal: 'advisory',
      },
      {
        id: 'discriminator-bound-multi-shape',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({
          prelude: ["if (data.artifact !== 'generic.summary.v2') fail('unexpected format');"],
        }),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'single-incompatible-guard',
        artifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({ guards: ["if (!data.expected_one) fail('expected_one is absent');"] }),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'unversioned-artifact',
        artifact: { artifact: 'generic.summary', records: [] },
        script: inlineManifestCheck(),
        expectedPreflight: 'admitted',
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
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'malformed-json',
        artifactBytes: '{ malformed json\n',
        script: inlineManifestCheck(),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'escaping-artifact-path',
        outsideArtifact: { artifact: 'generic.summary.v2', records: [] },
        script: inlineManifestCheck({ path: '../outside.json' }),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
      {
        id: 'absent-artifact',
        script: inlineManifestCheck(),
        expectedPreflight: 'admitted',
        expectedTerminal: 'hard',
      },
    ];

    const members: PopulationMember[] = [];
    for (const variant of variants) {
      const fixtureRoot = join(sandboxRoot, 'problem-1', variant.id);
      const projectDir = join(fixtureRoot, 'project');
      mkdirSync(projectDir, { recursive: true });
      if (variant.artifact !== undefined) writeJson(join(projectDir, 'output', 'manifest.json'), variant.artifact);
      if (variant.artifactBytes !== undefined) write(join(projectDir, 'output', 'manifest.json'), variant.artifactBytes);
      if (variant.outsideArtifact !== undefined) writeJson(join(fixtureRoot, 'outside.json'), variant.outsideArtifact);
      const preflight = inspectRealityChecks(brief, checkMarkdown(variant.script), { projectDir });
      const disposition = preflight.advisoryFindings.length > 0
        ? 'admitted_with_advisories'
        : 'admitted';
      const terminal = await runAllChecks(
        [{ name: 'manifest fields exist', type: 'exec-script-exit-zero', params: { script: variant.script } }],
        { projectDir, taskDir: join(fixtureRoot, 'task') },
      );
      const result = terminal.results[0];
      expect(disposition).toBe(variant.expectedPreflight);
      expect(result.advisory === true ? 'advisory' : 'hard').toBe(variant.expectedTerminal);
      expect(preflight.blockingTierFindings).toEqual([]);
      expect(preflight.structuralFindings).toEqual([]);
      members.push({
        id: variant.id,
        runnable: true,
        disposition,
        preflight: {
          disposition,
          advisoryFindings: preflight.advisoryFindings,
          blockingTierFindings: preflight.blockingTierFindings,
          structuralFindings: preflight.structuralFindings,
        },
        terminal: {
          pass: result.pass,
          advisory: result.advisory === true,
          evidence: result.evidence,
        },
      });
    }

    const projectDir = join(sandboxRoot, 'problem-1', 'workflow');
    seedEngineProject(projectDir);
    writeJson(join(projectDir, 'output', 'manifest.json'), { artifact: 'generic.summary.v2', records: [] });
    const workflow: WorkflowConfig = {
      name: 'admission-after-replay',
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'plan', role: 'planner', depends_on: [], scope: [],
        prompt_template: 'write the deterministic dispatch and check', skills: [],
        dynamic_dispatch: true, is_gate: false,
      }],
    };
    const workflowYaml = [
      'name: admission-after-replay', 'defaults:', '  max_iterations: 1', '  max_retries: 0',
      'stages:', '  - id: plan', '    role: planner', '    scope: []',
      '    dynamic_dispatch: true', '    prompt_template: write the deterministic dispatch and check',
    ].join('\n');
    const adapter = new ScriptedAdapter({
      plan: {
        output: 'planned',
        runFiles: {
          'dispatch.yaml': [
            '- id: work', '  role: coder', '  depends_on: [plan]',
            '  dependency_reasons: {plan: "execute the admitted construction"}',
            '  scope: []', '  prompt_template: Complete without changing the pre-existing artifact.',
          ].join('\n'),
          'reality_checks.md': checkMarkdown(variants[0].script),
        },
      },
      work: { output: 'work complete' },
      _summary: { output: 'summary' },
    });
    const final = await runWorkflow(
      workflow,
      workflowYaml,
      projectDir,
      adapter,
      new Map(),
      undefined,
      join(projectDir, 'config', 'agents'),
      undefined,
      brief,
      true,
      false,
    );
    const replayDir = runDir(projectDir, final.runId);
    const recordedPreflight = readJson(join(replayDir, 'reality_check_preflight.json'));
    const terminalReport = readJson(join(replayDir, '.reality-gate.json'));
    expect(recordedPreflight).toMatchObject({
      disposition: 'admitted_with_advisories',
      demotedCheckIndexes: [1],
      advisoryFindings: [{ code: 'versioned_json_shape_mismatch', tier: 'advisory' }],
      blockingTierFindings: [],
      structuralFindings: [],
    });
    expect(terminalReport.results[0]).toMatchObject({
      pass: false,
      advisory: true,
      evidence: { code: 1 },
    });
    expect(final.status).toBe('complete');
    const population = measuredPopulation(members, 'unbound-versioned-multi-shape');
    expect(population).toMatchObject({
      counts: { admitted: 7, admitted_with_advisories: 1 },
    });
    afterEvidence(1, {
      classification: 'changed',
      engineRecordedOutput: {
        finalStatus: final.status,
        preflight: recordedPreflight,
        terminalResult: terminalReport.results[0],
        events: readRunEvents(projectDir, final.runId)
          .filter((event) => event.type === 'reality_gate_advisory'),
      },
      population,
    });
  });

  it('2 exempts every frozen untracked Vitest member and preserves old-way controls', { timeout: 20_000 }, async () => {
    const defaults = loadProjectDefaults(repositoryRoot);
    const frozenMembers = [
      `${vitestCacheRoot}/da39a3ee5e6b4b0d3255bfef95601890afd80709/deps___vitest_vm__/_metadata.json`,
      `${vitestCacheRoot}/da39a3ee5e6b4b0d3255bfef95601890afd80709/deps___vitest_vm__/package.json`,
      `${vitestCacheRoot}/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`,
    ];
    const members = frozenMembers.map((path): PopulationMember => ({
      id: path,
      runnable: true,
      disposition: isLiveConstraintExemptPath(path, defaults.live_constraint_exempt_patterns, new Set())
        ? 'exempt'
        : 'violation',
    }));
    expect(members.map((member) => member.disposition)).toEqual(['exempt', 'exempt', 'exempt']);

    const projectDir = join(sandboxRoot, 'problem-2', 'project');
    const agentsDir = seedEngineProject(projectDir);
    const declared = oneStageWorkflow('vitest-cache-after');
    const created = prepareRun(projectDir, declared);
    const cachePath = `${vitestCacheRoot}/0123456789abcdef0123456789abcdef01234567/results.json`;
    const knownExemptPath = 'pkg/__pycache__/module.cpython-312.pyc';
    let invocationCount = 0;
    const adapter: Adapter = {
      async run(_prompt, _role, options) {
        if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        invocationCount += 1;
        write(join(projectDir, cachePath), '{"files":[]}\n');
        write(join(projectDir, knownExemptPath), 'generated bytecode\n');
        return {
          output: 'configured test command generated both cache paths',
          exitCode: 0,
          duration_ms: 1,
          writes: [cachePath, knownExemptPath],
          writeAttribution: 'structured',
        };
      },
    };
    const final = await runWorkflow(
      declared.config, declared.yaml, projectDir, adapter, new Map(), undefined,
      agentsDir, created.runId, 'Vitest cache exemption replay', true, false,
    );
    const events = readRunEvents(projectDir, created.runId);
    const exemptions = events.filter((event) => event.type === 'live_constraint_exemptions');
    const violations = events.filter((event) => event.type === 'live_constraint_violation');
    expect(final.status).toBe('complete');
    expect(invocationCount).toBe(1);
    expect(exemptions).toEqual([expect.objectContaining({ exemptedCount: 2 })]);
    expect(violations).toEqual([]);
    expect(existsSync(join(projectDir, cachePath))).toBe(true);

    const oldWayControls = [
      {
        id: 'tracked-vitest-member',
        disposition: isLiveConstraintExemptPath(
          frozenMembers[0], defaults.live_constraint_exempt_patterns, new Set([frozenMembers[0]]),
        ) ? 'exempt' : 'violation',
      },
      {
        id: 'ordinary-source-write',
        disposition: isLiveConstraintExemptPath(
          'src/ordinary.ts', defaults.live_constraint_exempt_patterns, new Set(),
        ) ? 'exempt' : 'violation',
      },
      {
        id: 'existing-python-cache-family',
        disposition: isLiveConstraintExemptPath(
          knownExemptPath, defaults.live_constraint_exempt_patterns, new Set(),
        ) ? 'exempt' : 'violation',
      },
    ];
    expect(oldWayControls).toEqual([
      { id: 'tracked-vitest-member', disposition: 'violation' },
      { id: 'ordinary-source-write', disposition: 'violation' },
      { id: 'existing-python-cache-family', disposition: 'exempt' },
    ]);

    const oldProjectDir = join(sandboxRoot, 'problem-2', 'ordinary-source-control', 'project');
    const oldAgentsDir = seedEngineProject(oldProjectDir);
    const oldDeclared = oneStageWorkflow('ordinary-source-control');
    const oldCreated = prepareRun(oldProjectDir, oldDeclared);
    const ordinaryPath = 'src/ordinary.ts';
    let oldInvocationCount = 0;
    const oldAdapter: Adapter = {
      async run(_prompt, _role, options) {
        if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        oldInvocationCount += 1;
        write(join(oldProjectDir, ordinaryPath), `export const invocation = ${oldInvocationCount};\n`);
        await waitUntil(() => !existsSync(join(oldProjectDir, ordinaryPath)));
        return {
          output: 'ordinary source write was restored by the live guard',
          exitCode: 0,
          duration_ms: 1,
          writes: [ordinaryPath],
          writeAttribution: 'structured',
        };
      },
    };
    const oldFinal = await runWorkflow(
      oldDeclared.config, oldDeclared.yaml, oldProjectDir, oldAdapter, new Map(), undefined,
      oldAgentsDir, oldCreated.runId, 'Ordinary source violation control', true, false,
    );
    const oldEvents = readRunEvents(oldProjectDir, oldCreated.runId)
      .filter((event) => event.type === 'live_constraint_violation');
    const oldStatus = readStageStatus(oldProjectDir, oldCreated.runId, 'subject');
    expect(oldFinal.status).toBe('failed');
    expect(oldInvocationCount).toBe(2);
    expect(oldEvents).toHaveLength(2);
    expect(oldEvents.every((event) => event.files?.includes(ordinaryPath))).toBe(true);
    expect(oldStatus).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(oldStatus.error).toMatch(/repeated live constraint violation/u);
    expect(existsSync(join(oldProjectDir, ordinaryPath))).toBe(false);

    const population = measuredPopulation(members, frozenMembers[2]);
    expect(population).toMatchObject({ counts: { exempt: 3 } });
    afterEvidence(2, {
      classification: 'changed',
      engineRecordedOutput: {
        finalStatus: final.status,
        invocationCount,
        events: [...exemptions, ...violations],
        stage: readStageStatus(projectDir, created.runId, 'subject'),
      },
      population,
      oldWayControls,
      oldWayEngineControl: {
        id: 'ordinary-source-write-repeated',
        disposition: 'violation-then-failed-on-repeat',
        engineRecordedOutput: {
          finalStatus: oldFinal.status,
          invocationCount: oldInvocationCount,
          events: oldEvents,
          stage: oldStatus,
        },
      },
    });
  });

  it('3 proposes stable generated parents and keeps an ordinary hashed source path exact', { timeout: 60_000 }, async () => {
    const hash40 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    const futureHash40 = '0123456789abcdef0123456789abcdef01234567';
    const hash64 = '91eab29af73fd32d46edecf7f6a7eb3a053caa027801886b7b3259894ccb020f';
    const futureHash64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const families = [
      {
        id: 'vitest-content-hash',
        exactPath: `${vitestCacheRoot}/${hash40}/results.json`,
        siblingPath: `${vitestCacheRoot}/${hash40}/deps___vitest_vm__/_metadata.json`,
        futurePath: `${vitestCacheRoot}/${futureHash40}/results.json`,
        expectedScope: `${vitestCacheRoot}/**`,
        disableVitestExemption: true,
      },
      {
        id: 'build-generation-content-hash',
        exactPath: `.cache/build-generations/${hash64}/.flowcrew-build-manifest.json`,
        siblingPath: `.cache/build-generations/${hash64}/index.js`,
        futurePath: `.cache/build-generations/${futureHash64}/index.js`,
        expectedScope: '.cache/build-generations/**',
        disableVitestExemption: false,
      },
    ];

    const runFamily = async (family: typeof families[number]) => {
      const projectDir = join(sandboxRoot, 'problem-3', family.id, 'project');
      const agentsDir = seedEngineProject(projectDir, family.disableVitestExemption);
      const declared = oneStageWorkflow(`stable-scope-${family.id}`);
      const created = prepareRun(projectDir, declared);
      const requestId = `stable-${family.id}`;
      let invocationCount = 0;
      let decision: Record<string, any> | undefined;
      const adapter: Adapter = {
        async run(prompt, _role, options) {
          if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
          invocationCount += 1;
          if (invocationCount === 1) {
            const directory = join(options.runDir, 'stages', options.stageId);
            writeJson(join(directory, 'scope_revision_request.json'), {
              version: 1,
              kind: 'scope_revision',
              requestId,
              runId: created.runId,
              stageId: options.stageId,
              attemptIndex: options.attemptIndex,
              requestedPaths: [family.expectedScope],
              pathDigest: scopePathDigest([family.expectedScope]),
              reason: 'the generated command owns the complete content-addressed tree',
            });
            decision = await waitForScopeDecision(directory, requestId);
            return {
              output: 'stable generated parent requested before invoking the generator',
              exitCode: 0, duration_ms: 1, writes: [], writeAttribution: 'structured',
            };
          }
          expect(prompt).toContain(`Scope revision ${requestId} was accepted`);
          for (const path of [family.exactPath, family.siblingPath, family.futurePath]) {
            write(join(projectDir, path), `${path}\n`);
          }
          return {
            output: 'same generator wrote a sibling and a future content hash',
            exitCode: 0,
            duration_ms: 1,
            writes: [family.exactPath, family.siblingPath, family.futurePath],
            writeAttribution: 'structured',
          };
        },
      };
      const final = await runWorkflow(
        declared.config, declared.yaml, projectDir, adapter, new Map(), undefined,
        agentsDir, created.runId, `Stable generated scope replay for ${family.id}`, true, false,
      );
      const events = readRunEvents(projectDir, created.runId);
      expect(final.status).toBe('complete');
      expect(invocationCount).toBe(2);
      expect(decision).toMatchObject({
        accepted: true,
        requestedPaths: [family.expectedScope],
        authorizedPaths: [family.expectedScope],
        effectiveScope: [family.expectedScope],
        pathDigest: scopePathDigest([family.expectedScope]),
      });
      expect([family.exactPath, family.siblingPath, family.futurePath]
        .every((path) => existsSync(join(projectDir, path)))).toBe(true);
      expect(events.filter((event) => event.type === 'live_constraint_violation')).toHaveLength(0);
      return {
        id: family.id,
        runnable: true,
        disposition: 'parent-scope-planned-before-generator-and-siblings-authorized',
        construction: family,
        engineRecordedOutput: {
          finalStatus: final.status,
          invocationCount,
          decision,
          events: events.filter((event) => [
            'live_constraint_violation', 'scope_revision_requested', 'scope_revision_decided',
          ].includes(event.type)),
          stage: readStageStatus(projectDir, created.runId, 'subject'),
        },
      } satisfies PopulationMember;
    };

    const members = [] as PopulationMember[];
    for (const family of families) members.push(await runFamily(family));

    const ordinaryExact = `src/generated/${hash40}/result.json`;
    const ordinarySibling = `src/generated/${hash40}/metadata.json`;
    expect(scopeRevisionPathsForViolations([ordinaryExact])).toEqual([ordinaryExact]);
    const ordinaryInstruction = scopeRevisionInstruction({
      runDir: join(sandboxRoot, 'ordinary-run'),
      runId: 'ordinary-run',
      stageId: 'subject',
      attemptIndex: 1,
      scope: [],
      scopePresence: 'present',
      gate: false,
      violatingPaths: [ordinaryExact],
    });
    expect(ordinaryInstruction).toContain(`"requestedPaths":["${ordinaryExact}"]`);
    expect(ordinaryInstruction).not.toContain('src/generated/**');
    expect(scopeRevisionPathsForViolations(families.map((family) => family.exactPath))).toEqual([
      '.cache/build-generations/**',
      `${vitestCacheRoot}/**`,
    ]);

    const oldProjectDir = join(sandboxRoot, 'problem-3', 'ordinary-hash-source', 'project');
    const oldAgentsDir = seedEngineProject(oldProjectDir);
    const oldDeclared = oneStageWorkflow('ordinary-hash-source');
    const oldCreated = prepareRun(oldProjectDir, oldDeclared);
    const oldRequestId = 'ordinary-exact-path';
    let oldInvocationCount = 0;
    let oldDecision: Record<string, any> | undefined;
    const oldAdapter: Adapter = {
      async run(prompt, _role, options) {
        if (options.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
        oldInvocationCount += 1;
        if (oldInvocationCount === 1) {
          write(join(oldProjectDir, ordinaryExact), 'first exact write\n');
          await waitUntil(() => !existsSync(join(oldProjectDir, ordinaryExact)));
          return {
            output: 'ordinary path restored', exitCode: 0, duration_ms: 1,
            writes: [ordinaryExact], writeAttribution: 'structured',
          };
        }
        if (oldInvocationCount === 2) {
          expect(prompt).toContain(`"requestedPaths":["${ordinaryExact}"]`);
          const directory = join(options.runDir, 'stages', options.stageId);
          writeJson(join(directory, 'scope_revision_request.json'), {
            version: 1, kind: 'scope_revision', requestId: oldRequestId,
            runId: oldCreated.runId, stageId: options.stageId, attemptIndex: options.attemptIndex,
            requestedPaths: [ordinaryExact], pathDigest: scopePathDigest([ordinaryExact]),
            reason: 'ordinary source generation requires only the named file',
          });
          oldDecision = await waitForScopeDecision(directory, oldRequestId);
          return {
            output: 'exact path accepted', exitCode: 0, duration_ms: 1,
            writes: [], writeAttribution: 'structured',
          };
        }
        write(join(oldProjectDir, ordinaryExact), 'authorized exact member\n');
        write(join(oldProjectDir, ordinarySibling), 'unauthorized sibling\n');
        await waitUntil(() => !existsSync(join(oldProjectDir, ordinarySibling)));
        return {
          output: 'ordinary sibling remains outside exact scope', exitCode: 0, duration_ms: 1,
          writes: [ordinaryExact, ordinarySibling], writeAttribution: 'structured',
        };
      },
    };
    const oldFinal = await runWorkflow(
      oldDeclared.config, oldDeclared.yaml, oldProjectDir, oldAdapter, new Map(), undefined,
      oldAgentsDir, oldCreated.runId, 'Ordinary hash-like source control', true, false,
    );
    const oldStatus = readStageStatus(oldProjectDir, oldCreated.runId, 'subject');
    expect(oldDecision).toMatchObject({
      accepted: true,
      requestedPaths: [ordinaryExact],
      effectiveScope: [ordinaryExact],
    });
    expect(oldFinal.status).toBe('failed');
    expect(oldStatus.error).toMatch(/repeated live constraint violation/u);
    expect(existsSync(join(oldProjectDir, ordinaryExact))).toBe(true);
    expect(existsSync(join(oldProjectDir, ordinarySibling))).toBe(false);

    const population = measuredPopulation(members, 'vitest-content-hash');
    expect(population).toMatchObject({ counts: { 'parent-scope-planned-before-generator-and-siblings-authorized': 2 } });
    afterEvidence(3, {
      classification: 'changed',
      population,
      oldWayControl: {
        id: 'ordinary-hash-source',
        construction: { exactPath: ordinaryExact, siblingPath: ordinarySibling },
        disposition: 'exact-path-accepted-then-sibling-violation',
        engineRecordedOutput: {
          finalStatus: oldFinal.status,
          invocationCount: oldInvocationCount,
          decision: oldDecision,
          stage: oldStatus,
        },
      },
    });
  });

  it('4 defers an operator-triggered direction abort but preserves the supervisor control', async () => {
    const supervisorConfig: SupervisorConfig = {
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
        priorSources: ['supervisor', 'supervisor'] as const,
        triggerSource: 'operator' as const,
        expected: 'WAIT',
      },
      {
        id: 'supervisor-trigger-after-two-supervisor-guides',
        priorSources: ['supervisor', 'supervisor'] as const,
        triggerSource: 'supervisor' as const,
        expected: 'ABORT',
      },
      {
        id: 'operator-trigger-after-one-supervisor-guide',
        priorSources: ['supervisor'] as const,
        triggerSource: 'operator' as const,
        expected: 'WAIT',
      },
      {
        id: 'operator-trigger-after-two-operator-guides',
        priorSources: ['operator', 'operator'] as const,
        triggerSource: 'operator' as const,
        expected: 'WAIT',
      },
    ];
    const members: PopulationMember[] = [];
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
      const status = {
        status: 'running' as const,
        retries: 0,
        startedAt,
        attempts: [{ index: 1, startedAt, status: 'running' as const }],
      };
      const state = readRunState(projectDir, created.runId);
      state.status = 'running';
      state.stages[stageId] = status;
      writeRunState(projectDir, created.runId, state);
      writeStageStatus(projectDir, created.runId, stageId, status);
      const consumedPath = join(created.runDirPath, 'stages', stageId, 'guidance_consumed.md');
      write(consumedPath, 'Operator fact consumed for the current attempt.\n');
      const supervisor = new Supervisor(
        projectDir,
        created.runId,
        { run: async () => ({ output: '', exitCode: 0, duration_ms: 1 }) },
        supervisorConfig,
        'guidance attribution replay',
      );
      const guideAssessment: SupervisorAssessment = {
        verdict: 'GUIDE',
        targetStage: stageId,
        reason: 'the same implementation direction is wrong',
        guidance: 'use the required direction',
      };
      const internals = supervisor as unknown as {
        actions: Array<{
          timestamp: string;
          tick: number;
          assessment: SupervisorAssessment;
          runningStages: string[];
          targetAttemptIndex: number;
          source: 'supervisor' | 'operator';
        }>;
        stageLastProgressMs: Record<string, number>;
        act(
          assessment: SupervisorAssessment,
          progressSinceMs: number,
          source: 'supervisor' | 'operator',
        ): Promise<SupervisorAssessment>;
      };
      internals.actions = variant.priorSources.map((source, index) => ({
        timestamp: new Date(Date.now() - (variant.priorSources.length - index) * 1_000).toISOString(),
        tick: index + 1,
        assessment: guideAssessment,
        runningStages: [stageId],
        targetAttemptIndex: 1,
        source,
      }));
      internals.stageLastProgressMs = { [stageId]: Date.now() };
      const result = await internals.act({
        verdict: 'ABORT',
        targetStage: stageId,
        reason: 'assessment made when operator supplied a missing fact',
        guidance: null,
      }, Date.now() + 1_000, variant.triggerSource);
      const signalPath = join(created.runDirPath, 'signals', `abort_${stageId}.json`);
      const signal = existsSync(signalPath) ? readJson(signalPath) : undefined;
      expect(result.verdict).toBe(variant.expected);
      expect(Boolean(signal)).toBe(variant.expected === 'ABORT');
      expect(readFileSync(consumedPath, 'utf8')).toContain('Operator fact consumed');
      if (variant.id === 'operator-trigger-after-two-supervisor-guides') {
        expect(result.reason).toContain('triggered by newly supplied operator guidance');
        expect(result.reason).toContain('later supervisor-triggered assessment');
      }
      members.push({
        id: variant.id,
        runnable: true,
        disposition: result.verdict,
        construction: {
          priorGuideSources: variant.priorSources,
          triggerSource: variant.triggerSource,
          operatorFactConsumed: true,
        },
        engineRecordedOutput: { result, signal },
      });
    }
    const population = measuredPopulation(members, 'operator-trigger-after-two-supervisor-guides');
    expect(population).toMatchObject({ counts: { ABORT: 1, WAIT: 3 } });
    afterEvidence(4, { classification: 'changed', population });
  });

  it('5 keeps the frozen opaque Make target unverified because it exposes no identities', async () => {
    const sourceDir = join(sandboxRoot, 'problem-5', 'source');
    const targetDir = join(sandboxRoot, 'problem-5', 'target');
    const stateDir = join(sandboxRoot, 'problem-5', 'state');
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
      writer = { write: (chunk: string) => { this.value += chunk; } };
    }
    const stdout = new CaptureWriter();
    const stderr = new CaptureWriter();
    const runnerCalls: Array<{ side: string; display: string; role: string }> = [];
    const runner = vi.fn<ValidationCommandRunner>((request) => {
      runnerCalls.push({
        side: request.cwd === sourceDir ? 'source' : 'target',
        display: request.display,
        role: request.role,
      });
      return { exitCode: 0, stdout: '1 passed\n', stderr: '', durationMs: 1 };
    });
    const code = await cmdShipSetupWithDeps([
      'ship-setup', '--brief', briefPath, '--project', sourceDir,
      '--target', targetDir, '--base', 'fixture-base', '--branch', 'fixture-branch',
    ], {
      createWorktree: (request) => {
        mkdirSync(request.targetDir, { recursive: true });
        copyFileSync(join(sourceDir, 'Makefile'), join(request.targetDir, 'Makefile'));
        return { exitCode: 0 };
      },
      runValidationCommand: runner,
      globalDir: () => stateDir,
      stdout: stdout.writer,
      stderr: stderr.writer,
    });
    const recordNames = readdirSync(join(stateDir, 'ship-setups'));
    expect(code).toBe(0);
    expect(stderr.value).toBe('');
    expect(recordNames).toHaveLength(1);
    const record = readJson(join(stateDir, 'ship-setups', recordNames[0]));
    expect(record).toMatchObject({
      state: 'ready',
      testPopulation: {
        state: 'unverified',
        missingFromTarget: [],
        extraInTarget: [],
      },
    });
    expect(record.testPopulation.reason).toContain('Configured test runner "make test"');
    expect(record.testPopulation.reason).toContain('output is not complete TAP (version line missing)');
    expect(runnerCalls).toEqual([
      { side: 'source', role: 'test', display: 'make -n test' },
      { side: 'target', role: 'test', display: 'make -n test' },
      { side: 'source', role: 'test', display: 'make test' },
      { side: 'target', role: 'test', display: 'make test' },
    ]);
    const members: PopulationMember[] = [{
      id: 'make-test-with-opaque-non-tap-output',
      runnable: true,
      disposition: 'unverified',
      construction: {
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
        runnerCalls,
      },
    }];
    const population = measuredPopulation(members, 'make-test-with-opaque-non-tap-output');
    expect(population).toMatchObject({ counts: { unverified: 1 } });
    afterEvidence(5, {
      classification: 'unresolved',
      reason: 'The configured target and opaque output expose no exact test identities.',
      population,
    });
  });
});
