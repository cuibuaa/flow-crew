#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = process.argv[3] ?? '';
const evidenceRun1 = process.argv[4] ?? '';
const stageRoot = join(runRoot, 'stages');
const mode = process.argv[2] ?? 'artifacts';

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function closeEnough(left, right) {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-12);
}
function summarize(samples, reportedValue) {
  const ordered = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
  const below = ordered.filter((value) => value < reportedValue).length;
  const equal = ordered.filter((value) => value === reportedValue).length;
  return {
    count: samples.length,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    median,
    rank: below,
    percentile: ((below + equal / 2) / samples.length) * 100,
  };
}
function visitDistributions(value, label, found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitDistributions(entry, `${label}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value.samples) && value.samples.length > 0
      && value.samples.every((sample) => typeof sample === 'number')) {
    found.push({ label, value });
  }
  for (const [key, entry] of Object.entries(value)) {
    visitDistributions(entry, label ? `${label}.${key}` : key, found);
  }
  return found;
}

function verifyAnchor(anchor) {
  const bytes = readFileSync(anchor.sourcePath);
  const slice = bytes.subarray(anchor.byteStart, anchor.byteEndExclusive);
  return slice.length === anchor.byteLength
    && sha256(slice) === anchor.sha256
    && (anchor.utf8 === undefined || slice.equals(Buffer.from(anchor.utf8, 'utf8')));
}

function addEvent(candidateEvents, event) {
  if (!event.timestamp || !Number.isFinite(Date.parse(event.timestamp))) return;
  const eventId = sha256(JSON.stringify([
    event.type,
    event.timestamp,
    event.source,
    event.stageId ?? null,
  ])).slice(0, 20);
  candidateEvents.push({ eventId, ...event });
}

function independentlyReplaySupervisor() {
  const run = json(join(evidenceRun1, 'run.json'));
  const trace = readFileSync(join(evidenceRun1, 'stages', '_supervisor', 'trace.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse).slice(0, 120);
  const candidates = [];
  for (const [stageId, state] of Object.entries(run.stages ?? {})) {
    for (const attempt of state.attempts ?? []) {
      addEvent(candidates, {
        type: 'stage_transition',
        timestamp: attempt.startedAt,
        source: `run.json#stages.${stageId}.attempts.${attempt.index}.startedAt`,
        stageId,
        quantities: { attemptIndex: attempt.index, transition: 'running' },
      });
      if ((attempt.exitCode ?? 0) !== 0 || attempt.status === 'failed') {
        addEvent(candidates, {
          type: 'adapter_failure',
          timestamp: attempt.completedAt ?? attempt.timeout?.childClosedAt,
          source: `run.json#stages.${stageId}.attempts.${attempt.index}`,
          stageId,
          quantities: {
            attemptIndex: attempt.index,
            exitCode: attempt.exitCode,
            terminationCause: attempt.timeout?.terminationCause,
          },
        });
      }
    }
  }
  const durable = readFileSync(join(evidenceRun1, 'events.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  for (const [index, event] of durable.entries()) {
    if (event.type === 'stage_complete' || event.type === 'stage_skipped') {
      addEvent(candidates, {
        type: 'stage_transition', timestamp: event.timestamp,
        source: `events.jsonl:${index + 1}`, stageId: event.stageId,
        quantities: { transition: event.status ?? event.type },
      });
      if (/^(?:audit|verify)/.test(event.stageId ?? '')) {
        addEvent(candidates, {
          type: 'gate_verdict', timestamp: event.timestamp,
          source: `events.jsonl:${index + 1}`, stageId: event.stageId,
          quantities: { durableEvent: event.type },
        });
      }
    } else if (event.type === 'plan_dispatch_retry' || event.type === 'supervisor_reject') {
      addEvent(candidates, {
        type: 'gate_verdict', timestamp: event.timestamp,
        source: `events.jsonl:${index + 1}`, stageId: event.stageId,
        quantities: { durableEvent: event.type },
      });
    }
  }
  for (const name of readdirSync(join(evidenceRun1, 'guidance_history')).sort()) {
    const body = readFileSync(join(evidenceRun1, 'guidance_history', name), 'utf8');
    for (const match of body.matchAll(/<!-- flowcrew-guidance (\{[^\n]+\}) -->/g)) {
      const envelope = JSON.parse(match[1]);
      addEvent(candidates, {
        type: 'guidance_arrival', timestamp: envelope.createdAt,
        source: `guidance_history/${name}#${envelope.id}`, stageId: envelope.target,
        quantities: { guidanceId: envelope.id, guidanceSource: envelope.source },
      });
    }
  }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^scope_revision_decision_.*\.json$/.test(entry.name)) {
        const decision = json(path);
        addEvent(candidates, {
          type: 'scope_request', timestamp: decision.decidedAt,
          source: path.slice(evidenceRun1.length + 1), stageId: decision.stageId,
          quantities: {
            requestId: decision.requestId,
            decision: decision.decision,
            requestedPathCount: decision.requestedPaths?.length ?? 0,
          },
        });
      }
    }
  };
  walk(join(evidenceRun1, 'stages'));
  candidates.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.eventId.localeCompare(right.eventId));

  let priorStart = Number.NEGATIVE_INFINITY;
  const calls = trace.map((entry, index) => {
    const startedAt = run.supervisor.attempts[index]?.startedAt ?? entry.timestamp;
    const at = Date.parse(startedAt);
    const triggeringEvents = candidates.filter((event) => {
      const eventAt = Date.parse(event.timestamp);
      return eventAt > priorStart && eventAt <= at;
    });
    priorStart = at;
    return {
      index: index + 1,
      triggeringEvents,
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
    };
  });
  const retained = calls.filter((call) => call.triggeringEvents.length > 0);
  return {
    calls: trace.length,
    retainedCalls: retained.length,
    retainedTokensIn: retained.reduce((sum, call) => sum + call.tokensIn, 0),
    retainedTokensOut: retained.reduce((sum, call) => sum + call.tokensOut, 0),
    call21EventCount: calls[20].triggeringEvents.length,
    call22EventCount: calls[21].triggeringEvents.length,
  };
}

async function verifyArtifacts() {
  if (!runRoot || !evidenceRun1) {
    throw new Error('artifacts mode requires the task run root and historical evidence run root as arguments');
  }
  const catalogPath = join(stageRoot, 'capture_baseline', 'anchor_catalog.json');
  const catalog = json(catalogPath);
  record('anchor catalog identity', sha256(readFileSync(catalogPath)) === '0a3fa856064d713ef972458abcf798b3a8f3dff37cee06ec6e0075a31a197b0a');
  record('anchor catalog population', catalog.files.length === 51 && catalog.anchors.length === 47,
    `${catalog.files.length} whole files, ${catalog.anchors.length} slices`);
  const badFiles = catalog.files.filter((entry) => {
    if (!existsSync(entry.resolvedPath)) return true;
    const bytes = readFileSync(entry.resolvedPath);
    return bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256;
  }).map((entry) => entry.path);
  record('all catalog whole-file hashes', badFiles.length === 0, badFiles.join(', '));
  const badAnchors = catalog.anchors.filter((anchor) => !verifyAnchor(anchor)).map((anchor) => anchor.label);
  record('all catalog byte-slice hashes and bytes', badAnchors.length === 0, badAnchors.join(', '));

  const baseline = json(join(stageRoot, 'capture_baseline', 'baseline_measurements.json'));
  const protectedPaths = [
    'config/defaults.yaml',
    ...Object.keys(baseline.protectedInputs.rolePromptSha256).map((name) => `config/agents/${name}`),
  ];
  const protectedMismatches = [];
  for (const path of protectedPaths) {
    const current = readFileSync(join(projectRoot, path));
    const expected = path === 'config/defaults.yaml'
      ? baseline.protectedInputs.defaultsSha256
      : baseline.protectedInputs.rolePromptSha256[path.slice('config/agents/'.length)];
    if (sha256(current) !== expected) protectedMismatches.push(path);
  }
  record('defaults and role prompts retain their captured base hashes', protectedMismatches.length === 0,
    protectedMismatches.join(', '));
  const dependencyDirectory = ['node', '_modules'].join('');
  record('physical dependency trees', [dependencyDirectory, join('ui', dependencyDirectory)].every((path) => {
    const target = join(projectRoot, path);
    return existsSync(target) && lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink();
  }));

  const artifactPaths = [
    join(stageRoot, 'capture_baseline', 'baseline_measurements.json'),
    join(stageRoot, 'live_loop_guard', 'measurements.json'),
    join(stageRoot, 'surface_drift', 'measurements.json'),
    join(stageRoot, 'campaign_successor', 'campaign_successor_replay.json'),
  ];
  let distributionCount = 0;
  const distributionFailures = [];
  for (const path of artifactPaths) {
    for (const { label, value } of visitDistributions(json(path), '')) {
      distributionCount += 1;
      const calculated = summarize(value.samples, value.reportedValue);
      if ((value.sampleCount !== undefined && value.sampleCount !== calculated.count)
          || !closeEnough(value.mean, calculated.mean)
          || !closeEnough(value.median, calculated.median)
          || value.reportedRank !== calculated.rank
          || !closeEnough(value.reportedPercentile, calculated.percentile)) {
        distributionFailures.push(`${path}:${label}`);
      }
    }
  }
  record('all distribution summaries independently recomputed', distributionFailures.length === 0,
    `${distributionCount} distributions; bad=${distributionFailures.join(', ')}`);

  const live = json(join(stageRoot, 'live_loop_guard', 'measurements.json'));
  const campaign = json(join(stageRoot, 'campaign_successor', 'campaign_successor_replay.json'));
  const expectationChecks = [
    live.behavior1.distributions[0].within_expected_range
      === live.behavior1.beforeTrials.every((trial) => trial.correctivePromptSeenInSameAttempt === true),
    live.behavior1.distributions[1].within_expected_range
      === (live.behavior1.distributions[1].reportedValue === 192),
    live.behavior1.distributions[2].within_expected_range
      === live.behavior1.distributions[2].samples.every((sample) => sample <= 30_000),
    baseline.behavior3.dose.within_expected_range
      === (baseline.behavior3.dose.reportedValue >= baseline.behavior4.hardFloorMinutes),
    baseline.behavior3.attemptOverhead.within_expected_range
      === (baseline.behavior3.attemptOverhead.reportedValue <= baseline.behavior3.warningThresholdsForImplementation.overheadMs),
    campaign.derivation.expectation.within_expected_range
      === (campaign.derivation.expectation.latestObservedValue >= campaign.derivation.expectation.expectedFloor),
  ];
  record('operator expectation booleans independently recomputed', expectationChecks.every(Boolean),
    `${expectationChecks.filter(Boolean).length}/${expectationChecks.length}`);
  record('expectation methods declared unchanged', artifactPaths.flatMap((path) => visitDistributions(json(path), ''))
    .filter(({ value }) => Object.hasOwn(value, 'expectation'))
    .every(({ value }) => typeof value.within_expected_range === 'boolean'
      && value.method_was_not_adjusted_to_match_expectation === true));

  const independent = independentlyReplaySupervisor();
  record('supervisor timeline independently reconstructed',
    independent.calls === 120 && independent.retainedCalls === 37
      && independent.retainedTokensIn === 653_704 && independent.retainedTokensOut === 3_427,
    JSON.stringify(independent));
  record('false ABORT event classification independently reconstructed',
    independent.call21EventCount > 0 && independent.call22EventCount === 0,
    `call21=${independent.call21EventCount}, call22=${independent.call22EventCount}`);

  const fixtureChecks = [];
  const campaignFixture = json(join(projectRoot, 'spec', 'fixtures', 'closed-loop-campaign-evidence.json'));
  for (const anchor of campaignFixture.anchors) {
    const bytes = readFileSync(anchor.sourcePath).subarray(anchor.byteStart, anchor.byteEndExclusive);
    fixtureChecks.push(sha256(bytes) === anchor.sha256 && bytes.equals(Buffer.from(anchor.utf8, 'utf8')));
  }
  const driftFixture = json(join(projectRoot, 'spec', 'fixtures', 'closed-loop-drift-evidence.json'));
  for (const anchor of driftFixture.anchors) {
    const bytes = readFileSync(anchor.sourcePath);
    fixtureChecks.push(anchor.byteStart === undefined
      ? bytes.length === anchor.bytes && sha256(bytes) === anchor.sha256
      : sha256(bytes.subarray(anchor.byteStart, anchor.byteEndExclusive)) === anchor.sha256);
  }
  const engineFixture = json(join(projectRoot, 'spec', 'fixtures', 'closed-loop-engine-evidence.json'));
  const engineAnchors = [
    engineFixture.anchors.historicalConstraintAudit.slice,
    engineFixture.anchors.falseAbort1,
    engineFixture.anchors.falseAbort2,
    engineFixture.anchors.effectiveAbortSuppression,
  ];
  for (const anchor of engineAnchors) {
    const sourcePath = join(evidenceRun1, anchor.sourcePath ?? engineFixture.anchors.historicalConstraintAudit.sourcePath);
    fixtureChecks.push(sha256(readFileSync(sourcePath).subarray(anchor.byteStart, anchor.byteEndExclusive)) === anchor.sha256);
  }
  record('repository fixtures match read-only originals byte-for-byte', fixtureChecks.every(Boolean),
    `${fixtureChecks.filter(Boolean).length}/${fixtureChecks.length}`);

  record('campaign replay has derived floor and reasoned diff',
    campaign.derivation.hardFloor.operator === '>='
      && campaign.derivation.hardFloor.value === 20
      && campaign.derivation.hardFloor.unit === 'minutes'
      && campaign.derivation.promotedGuidanceIds.length === 5
      && ['promoted_guidance', 'converted_criterion'].every((reason) => campaign.derivation.structuredDiffReasons.includes(reason))
      && campaign.rehearsal.exitCode === 0
      && campaign.rehearsal.preflight.contractReady === true);

  const inspectedTestPaths = [
    'spec/closed-loop-drift.test.ts',
    'spec/campaign-successor.replay.test.ts',
    'spec/test-support/closed-loop-drift-evidence.ts',
    'spec/test-support/closed-loop-campaign-evidence.ts',
  ];
  const dangerousLines = inspectedTestPaths.flatMap((path) => readFileSync(join(projectRoot, path), 'utf8')
    .split('\n').map((line, index) => `${path}:${index + 1}:${line}`))
    .filter((line) => /round_result|latest[-_ ]round|no[-_ ]candidate.*sidecar/u.test(line))
    .filter((line) => line
    && !line.includes("not.toContain('2137')")
    && !line.includes('not.toMatch(/round_result')
    && !line.includes('never parse')
    && !line.includes('mutable latest'));
  record('research tests avoid mutable latest-round evidence', dangerousLines.length === 0,
    dangerousLines.join(' | '));
}

async function waitForDecision(directory, requestId) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (const name of readdirSync(directory).filter((candidate) => candidate.startsWith('scope_revision_decision_'))) {
      const decision = json(join(directory, name));
      if (decision.requestId === requestId) return decision;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`decision ${requestId} not published`);
}

async function liveScopeProbe(scopeKind) {
  const { performance } = await import('node:perf_hooks');
  const { runWorkflow } = await import(pathToFileURL(join(projectRoot, 'src', 'scheduler.ts')));
  const store = await import(pathToFileURL(join(projectRoot, 'src', 'store.ts')));
  const { scopePathDigest } = await import(pathToFileURL(join(projectRoot, 'src', 'runtime-negotiation.ts')));
  const projectDir = mkdtempSync(join(tmpdir(), `flowcrew-qa-live-${scopeKind}-project-`));
  const stateDir = mkdtempSync(join(tmpdir(), `flowcrew-qa-live-${scopeKind}-state-`));
  const priorStateDir = store.fcGlobalDir();
  store.setFcGlobalDir(stateDir);
  try {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    mkdirSync(join(projectDir, 'spec'), { recursive: true });
    mkdirSync(join(projectDir, 'config', 'agents'), { recursive: true });
    writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'default_timeout_ms: 60000\n');
    writeFileSync(join(projectDir, 'config', 'agents', 'coder.yaml'), [
      'name: coder', 'description: qa fixture', 'model: default',
      'reasoning_effort: low', 'tools: []', 'prompt: fixture',
    ].join('\n'));
    const testPath = join(projectDir, 'spec', 'existing.test.ts');
    const preimage = 'export const invariant = "original";\n';
    writeFileSync(testPath, preimage);
    const scope = scopeKind === 'empty' ? [] : ['src/allowed.ts'];
    const config = {
      name: `qa-live-${scopeKind}`,
      defaults: { max_iterations: 1, max_retries: 0 },
      stages: [{
        id: 'writer', role: 'coder', scope, depends_on: [],
        prompt_template: 'obey the declared scope', skills: [],
        dynamic_dispatch: false, is_gate: false,
      }],
    };
    const yaml = `name: qa-live-${scopeKind}\ndefaults:\n  max_iterations: 1\n  max_retries: 0\nstages:\n  - id: writer\n    role: coder\n    scope: [${scope.join(', ')}]\n    depends_on: []\n    prompt_template: obey the declared scope\n`;
    const created = store.createRun(projectDir, config.name, yaml, ['writer']);
    const state = store.readRunState(projectDir, created.runId);
    state.autoApprove = true;
    state.maxRetries = 0;
    store.writeRunState(projectDir, created.runId, state);
    let invocationCount = 0;
    let liveRestoreLatencyMs;
    let correctionBytes;
    const adapter = { async run(prompt, _role, opts) {
      if (opts.stageId === '_summary') return { output: 'summary', exitCode: 0, duration_ms: 1 };
      invocationCount += 1;
      if (invocationCount === 1) {
        if (scope.length) writeFileSync(join(projectDir, 'src', 'allowed.ts'), 'allowed\n');
        writeFileSync(testPath, 'export const invariant = "unauthorized";\n');
        const started = performance.now();
        const deadline = started + 1_000;
        while (performance.now() < deadline && readFileSync(testPath, 'utf8') !== preimage) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        }
        if (readFileSync(testPath, 'utf8') === preimage) liveRestoreLatencyMs = performance.now() - started;
        return {
          output: 'wrote existing unlisted test', exitCode: 0,
          duration_ms: performance.now() - started,
          writes: [...(scope.length ? ['src/allowed.ts'] : []), 'spec/existing.test.ts'],
          writeAttribution: 'structured',
        };
      }
      const marker = '# Live constraint correction\n';
      const markerAt = prompt.indexOf(marker);
      if (markerAt >= 0) correctionBytes = Buffer.from(prompt.slice(markerAt + marker.length), 'utf8');
      const requestedPaths = ['spec/existing.test.ts'];
      const requestId = `qa-authorize-${scopeKind}`;
      const directory = join(opts.runDir, 'stages', opts.stageId);
      writeFileSync(join(directory, 'scope_revision_request.json'), JSON.stringify({
        version: 1, kind: 'scope_revision', requestId,
        runId: created.runId, stageId: opts.stageId, attemptIndex: opts.attemptIndex,
        requestedPaths, pathDigest: scopePathDigest(requestedPaths), reason: 'qa corrective replay',
      }));
      const decision = await waitForDecision(directory, requestId);
      if (decision.accepted) writeFileSync(testPath, 'export const invariant = "authorized";\n');
      return {
        output: 'corrected', exitCode: decision.accepted ? 0 : 1, duration_ms: 1,
        writes: decision.accepted ? requestedPaths : [], writeAttribution: 'structured',
      };
    } };
    const final = await runWorkflow(
      config, yaml, projectDir, adapter, new Map(), undefined,
      join(projectDir, 'config', 'agents'), created.runId, 'QA live-scope probe', true, false,
    );
    const status = store.readStageStatus(projectDir, created.runId, 'writer');
    const auditPath = join(created.runDirPath, 'stages', 'writer', 'constraint_audit_attempt_1.json');
    const audit = existsSync(auditPath) ? json(auditPath) : undefined;
    const canonical = audit?.scopeRevisionInstructions?.[0];
    const property = liveRestoreLatencyMs !== undefined
      && liveRestoreLatencyMs < 1_000
      && invocationCount === 2
      && status.attempts?.length === 1
      && existsSync(auditPath)
      && correctionBytes?.equals(Buffer.from(canonical ?? '', 'utf8')) === true
      && final.status === 'complete';
    record(`live scope property (${scopeKind})`, property, JSON.stringify({
      finalStatus: final.status,
      stageStatus: status.status,
      invocationCount,
      liveRestoreLatencyMs,
      auditPresent: existsSync(auditPath),
      correctionMatchesAudit: correctionBytes?.equals(Buffer.from(canonical ?? '', 'utf8')) ?? false,
      postAuditRolledBack: audit?.rolledBackWrites,
    }));
  } finally {
    store.setFcGlobalDir(priorStateDir);
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function campaignReplayProbe() {
  const campaignModule = await import(pathToFileURL(join(projectRoot, 'src', 'campaign.ts')));
  if (typeof campaignModule.advanceCampaignSuccessor !== 'function') {
    record('campaign successor public pipeline', false, 'advanceCampaignSuccessor is unavailable');
    return;
  }
  const { createFrozenCampaignContract, deriveCampaignSuccessor } = await import(pathToFileURL(join(projectRoot, 'src', 'campaign-successor.ts')));
  const { rehearseBriefIsolated } = await import(pathToFileURL(join(projectRoot, 'src', 'rehearse.ts')));
  const preflight = await import(pathToFileURL(join(projectRoot, 'src', 'brief-preflight.ts')));
  const versioning = await import(pathToFileURL(join(projectRoot, 'src', 'brief-versioning.ts')));
  const fixturePath = process.argv[3]
    ?? join(projectRoot, 'spec', 'fixtures', 'closed-loop-campaign-evidence.json');
  const fixture = json(fixturePath);
  const predecessorBrief = `${fixture.predecessorBrief}${fixture.preflightAddendum ?? ''}`;
  const goalText = 'A policy whose paired 95% interval against three fixed `HeuristicPolicyV1` opponents lies wholly above zero under the frozen evaluation, or an honest ceiling.';
  const campaignContract = createFrozenCampaignContract({
    campaignId: 'qa-campaign-replay',
    createdAt: '2026-09-04T12:00:00.000Z',
    sourceBrief: predecessorBrief,
    goalText,
    yardstickText: fixture.frozenContract.yardstickText,
    yardstick: {
      metricId: 'paired_ev_per_hand',
      direction: 'increase',
      unit: 'points/hand',
      evaluationConstruction: 'paired blocks followed by disjoint confirmation',
    },
    budget: { maxRuns: 4, usedRuns: 1 },
    noProgress: { metricId: 'paired_ev_per_hand', direction: 'increase', rounds: 2, tolerance: 0 },
  });
  const derivationInput = {
    campaignContract,
    predecessorBrief,
    terminal: fixture.terminal,
    operatorGuidance: fixture.operatorGuidance,
    declinedItems: fixture.declinedItems,
    criterion: fixture.criterion,
    metricSeries: fixture.metricSeries,
  };
  const derived = deriveCampaignSuccessor(derivationInput);
  if (derived.status !== 'derived') {
    record('campaign successor derivation', false, derived.reason);
    return;
  }
  const inspected = mkdtempSync(join(tmpdir(), 'flowcrew-qa-campaign-rehearsal-'));
  try {
    const before = readdirSync(inspected);
    const rehearsal = await rehearseBriefIsolated(derived.successorBrief, {
      projectDir: inspected,
      label: 'qa-cancelled-run-successor',
    });
    record('campaign successor derivation',
      derived.floor?.operator === '>=' && derived.floor?.value === 20 && derived.floor?.unit === 'minutes'
        && derived.promotedGuidanceIds.length === 5
        && derived.structuredDiff.entries.some((entry) => entry.reason === 'promoted_guidance')
        && derived.structuredDiff.entries.some((entry) => entry.reason === 'converted_criterion'),
      JSON.stringify({ floor: derived.floor, promoted: derived.promotedGuidanceIds.length }));
    record('campaign successor real isolated rehearsal',
      rehearsal.exitCode === 0 && rehearsal.simulated === true
        && rehearsal.preflight.contractReady === true
        && rehearsal.outputInventory.blocking === 0
        && JSON.stringify(readdirSync(inspected)) === JSON.stringify(before),
      JSON.stringify(rehearsal));

    const campaignStateDir = join(inspected, 'campaign-state');
    const briefDir = join(inspected, 'brief-versions');
    versioning.ensureBriefDir(briefDir, derivationInput.predecessorBrief);
    const parentReport = preflight.inspectBrief(derivationInput.predecessorBrief);
    const parentAdmission = preflight.createBriefAdmission(parentReport, parentReport.requiresAcknowledgement
      ? { kind: 'explicit', source: 'cli_digest_flag', at: '2026-09-04T12:00:00.000Z' }
      : { kind: 'not_required' });
    let registrations = 0;
    const advanced = await campaignModule.advanceCampaignSuccessor({
      campaignId: 'qa-campaign-replay',
      projectDir: inspected,
      campaignStateDir,
      briefDir,
      predecessorBrief: derivationInput.predecessorBrief,
      parentAdmission,
      contract: campaignContract,
      evidence: {
        terminal: {
          status: 'complete',
          goalMet: false,
          artifactId: 'qa-terminal-artifact',
          artifactBytes: '{"status":"complete","goalMet":false}\n',
        },
        operatorGuidance: fixture.operatorGuidance,
        declinedItems: fixture.declinedItems,
        criterion: fixture.criterion,
        metricSeries: fixture.metricSeries,
        campaignProgress: { usedRuns: 1, observedAt: '2026-09-04T12:00:01.000Z' },
      },
      registerAndLaunch: async (task) => {
        registrations += 1;
        return {
          id: 99,
          name: task.name ?? 'qa successor',
          kind: 'quick',
          brief_path: join(inspected, 'task-99.md'),
          brief_admission: task.brief_admission,
          projectDir: inspected,
          systemd_unit: 'qa-successor.service',
          run_id: 'qa-successor-run',
          status: 'running',
          attempt: 1,
          max_retries: 2,
          created_at: '2026-09-04T12:00:02.000Z',
          tick_log_path: join(inspected, 'tick.md'),
        };
      },
      now: '2026-09-04T12:00:01.000Z',
    });
    record('campaign successor public pipeline',
      advanced.status === 'launched'
        && registrations === 1
        && existsSync(join(campaignStateDir, 'successors', 'v2', 'structured_diff.json'))
        && existsSync(join(campaignStateDir, 'successors', 'v2', 'rehearsal.json'))
        && existsSync(join(campaignStateDir, 'successors', 'v2', 'brief_admission.json'))
        && existsSync(join(campaignStateDir, 'successors', 'v2', 'launch.json')),
      JSON.stringify({ status: advanced.status, registrations }));
  } finally {
    rmSync(inspected, { recursive: true, force: true });
  }
}

async function supervisorTriggerProbe() {
  const { selectSupervisorAssessmentTrigger } = await import(pathToFileURL(join(projectRoot, 'src', 'supervisor.ts')));
  const selected = selectSupervisorAssessmentTrigger({
    anomalySignals: [],
    runningStageCount: 1,
    accumulatedOutputBytes: 4096,
    minDeltaBytes: 4096,
    now: 180_000,
    lastRoutineAssessmentAt: 0,
    routineAssessmentIntervalMs: 180_000,
    routineAssessmentsThisIteration: 0,
    maxRoutineAssessmentsPerIteration: 20,
    cooldownUntil: 0,
  });
  record('eventless clock tick has no supervisor model-call trigger', selected === 'none', `selected=${selected}`);
}

async function driftProbe() {
  const cliEvents = await import(pathToFileURL(join(projectRoot, 'src', 'cli-events.ts')));
  const supervision = await import(pathToFileURL(join(projectRoot, 'src', 'supervision.ts')));
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-qa-drift-public-'));
  const fcHome = join(root, 'state');
  const runId = 'qa-drift-run';
  const runDirectory = join(fcHome, 'runs', runId);
  const projectDir = join(root, 'project');
  const unit = 'qa-drift.service';
  try {
    mkdirSync(runDirectory, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const state = {
      runId,
      workflowName: 'qa drift public projection',
      projectDir,
      taskDescription: 'typed drift fixture',
      status: 'complete',
      startedAt: '2026-09-04T00:00:00.000Z',
      completedAt: '2026-09-04T00:10:00.000Z',
      research: {
        resultSchema: {
          type: 'object', required: ['label', 'dose_minutes'],
          properties: { label: { type: 'string' }, dose_minutes: { type: 'number' } },
          'x-flowcrew-drift': {
            researchDose: {
              field: 'dose_minutes', metricId: 'dose_minutes', unit: 'minutes',
              threshold: { kind: 'floor', operator: '>=', value: 20, source: 'qa typed floor' },
            },
          },
        },
      },
      stages: {
        plan: {
          status: 'complete', retries: 1,
          attempts: [{
            index: 1, status: 'complete',
            startedAt: '2026-09-04T00:00:00.000Z',
            completedAt: '2026-09-04T00:01:00.000Z', duration_ms: 20_000,
          }],
        },
        work: { status: 'complete', completedAt: '2026-09-04T00:05:00.000Z' },
      },
      supervisor: {
        attempts: [{
          trigger: { quantities: { supervisorRejectBudget: { maximum: 2 } } },
        }],
      },
    };
    writeFileSync(join(runDirectory, 'run.json'), `${JSON.stringify(state)}\n`);
    writeFileSync(join(runDirectory, 'plan_retry_state.json'), `${JSON.stringify({
      version: 1, stageId: 'plan', iteration: 1, maxAttempts: 5,
      attempts: [
        { attemptIndex: 1, disposition: 'incumbent_initialized', unsatisfied: [{ id: 'qa', source: 'admission', detail: 'rejected' }] },
        { attemptIndex: 2, disposition: 'admitted', unsatisfied: [] },
      ],
      terminal: { disposition: 'admitted', reason: 'attempt 2 passed' },
    })}\n`);
    writeFileSync(join(runDirectory, 'research_journal.json'), `${JSON.stringify({
      rounds: [
        { label: 'round-one', outcome: 'no_candidate' },
        { label: 'round-two', outcome: 'no_candidate' },
      ],
    })}\n`);
    writeFileSync(join(runDirectory, 'research_round_1_no_candidate_consumed.json'), '{"label":"round-one","outcome":"no_candidate","dose_minutes":1}\n');
    writeFileSync(join(runDirectory, 'research_round_2_no_candidate_consumed.json'), '{"label":"round-two","outcome":"no_candidate","dose_minutes":2}\n');
    writeFileSync(join(runDirectory, 'events.jsonl'), [
      JSON.stringify({ type: 'supervisor_reject', timestamp: '2026-09-04T00:02:00.000Z', stageId: 'work', detail: 'reject 1/2: qa contradiction' }),
      JSON.stringify({ type: 'stage_complete', timestamp: '2026-09-04T00:05:00.000Z', stageId: 'work' }),
    ].join('\n') + '\n');
    mkdirSync(fcHome, { recursive: true });
    writeFileSync(join(fcHome, 'tasks.jsonl'), `${JSON.stringify({ id: 1, run_id: runId, systemd_unit: unit, status: 'complete' })}\n`);
    const logPath = supervision.supervisionPaths(fcHome, unit).log;
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, 'qa log bytes\n');
    const before = sha256([
      readFileSync(join(runDirectory, 'run.json')),
      readFileSync(join(runDirectory, 'events.jsonl')),
      readFileSync(join(fcHome, 'tasks.jsonl')),
      readFileSync(logPath),
    ].map((bytes) => sha256(bytes)).join(':'));
    const projection = cliEvents.readOperationalProjection(runDirectory);
    const after = sha256([
      readFileSync(join(runDirectory, 'run.json')),
      readFileSync(join(runDirectory, 'events.jsonl')),
      readFileSync(join(fcHome, 'tasks.jsonl')),
      readFileSync(logPath),
    ].map((bytes) => sha256(bytes)).join(':'));
    const rows = projection.drift?.rows ?? [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    record('six-row drift projection from immutable round evidence',
      rows.length === 6
        && ['research_dose', 'first_plan_admission', 'supervisor_rejections', 'engine_overhead', 'registry_growth', 'log_growth']
          .every((id) => byId.has(id))
        && JSON.stringify(byId.get('research_dose')?.distribution?.samples) === '[1,2]'
        && byId.get('first_plan_admission')?.value === 'rejected'
        && byId.get('supervisor_rejections')?.value === '1 total; max 1/stage; 1 overturned'
        && byId.get('supervisor_rejections')?.comparisonValue === 1,
      rows.map((row) => `${row.id}:${row.value}`).join(', '));
    record('drift projection is read-only', before === after, `${before} / ${after}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function campaignGoalMetProbe() {
  const campaign = await import(pathToFileURL(join(projectRoot, 'src', 'campaign.ts')));
  const preflight = await import(pathToFileURL(join(projectRoot, 'src', 'brief-preflight.ts')));
  const store = await import(pathToFileURL(join(projectRoot, 'src', 'store.ts')));
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-qa-goal-met-'));
  const stateDir = join(root, 'state');
  const projectDir = join(root, 'project');
  mkdirSync(projectDir, { recursive: true });
  const priorStateDir = store.fcGlobalDir();
  store.setFcGlobalDir(stateDir);
  try {
    const goalText = 'Goal: keep result inside the frozen acceptance interval.';
    const yardstickText = 'Yardstick: result is measured by the terminal run artifact.';
    const brief = `# Campaign\n\n${goalText}\n\n${yardstickText}\n`;
    const briefPath = join(projectDir, 'brief.md');
    writeFileSync(briefPath, brief);
    const report = preflight.inspectBrief(brief);
    const admission = preflight.createBriefAdmission(report, report.requiresAcknowledgement
      ? { kind: 'explicit', source: 'cli_digest_flag', at: '2026-09-04T12:00:00.000Z' }
      : { kind: 'not_required' });
    const campaignId = `qa-goal-met-${randomBytes(4).toString('hex')}`;
    let successorAvailable = false;
    let successorOption;
    let collectCalls = 0;
    try {
      const successor = await import(pathToFileURL(join(projectRoot, 'src', 'campaign-successor.ts')));
      successorAvailable = true;
      const contract = successor.createFrozenCampaignContract({
        campaignId,
        createdAt: '2026-09-04T12:00:00.000Z',
        sourceBrief: brief,
        goalText,
        yardstickText,
        yardstick: { metricId: 'result', direction: 'increase', unit: 'score', evaluationConstruction: 'terminal run result' },
        budget: { maxRuns: 1, usedRuns: 0 },
        noProgress: { metricId: 'result', direction: 'increase', rounds: 2, tolerance: 0 },
      });
      successorOption = {
        contract,
        parentAdmission: admission,
        collectEvidence() {
          collectCalls += 1;
          throw new Error('goal-met run must not derive a successor');
        },
      };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('campaign-successor')) throw error;
    }
    const runId = `qa-goal-met-run-${randomBytes(4).toString('hex')}`;
    const runPath = join(store.runsRoot(), runId);
    const launchPath = join(projectDir, 'launch.sh');
    writeFileSync(launchPath, `#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p ${JSON.stringify(runPath)}\nprintf '%s\\n' '${JSON.stringify({
      runId,
      workflowName: 'qa',
      projectDir,
      status: 'complete',
      stages: {},
      startedAt: '2026-09-04T12:00:00.000Z',
      result: 1.5,
    })}' > ${JSON.stringify(join(runPath, 'run.json'))}\n`);
    chmodSync(launchPath, 0o755);
    const cfg = {
      id: campaignId,
      briefPath,
      projectDir,
      goal: { metric: 'result', validRange: [1, 2] },
      budget: { maxRuns: 1, maxWallHours: 0.01 },
      diagnosisRules: [],
      stop: [],
      launch: { systemdUnit: 'qa-unused.service', launchScript: launchPath },
    };
    const outcome = await campaign.runCampaign(cfg, successorOption ? { successor: successorOption } : {});
    record('complete run meeting campaign goal does not derive a successor',
      successorAvailable && collectCalls === 0 && outcome.status === 'goal_met',
      JSON.stringify({ outcome, collectCalls, successorAvailable }));
  } finally {
    store.setFcGlobalDir(priorStateDir);
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  if (mode === 'artifacts') await verifyArtifacts();
  else if (mode === 'live-nonempty') await liveScopeProbe('nonempty');
  else if (mode === 'live-empty') await liveScopeProbe('empty');
  else if (mode === 'campaign-replay') await campaignReplayProbe();
  else if (mode === 'supervisor-trigger') await supervisorTriggerProbe();
  else if (mode === 'drift') await driftProbe();
  else if (mode === 'campaign-goal-met') await campaignGoalMetProbe();
  else throw new Error(`unknown mode ${mode}`);
} catch (error) {
  record(`${mode} uncaught error`, false, error instanceof Error ? `${error.stack ?? error.message}` : String(error));
}

const failures = results.filter((result) => !result.pass);
process.stdout.write(`${JSON.stringify({ mode, projectRoot, checks: results, failingChecks: failures.length }, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
