import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stageDir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!stageDir) {
  process.stderr.write('usage: node spec/capture-baseline-verification.mjs <capture-baseline-stage-dir>\n');
  process.exit(2);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const bytes = (path) => readFileSync(path);
const text = (path) => readFileSync(path, 'utf8');
const json = (path) => JSON.parse(text(path));
const close = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
};

const baselinePath = join(stageDir, 'baseline_measurements.json');
const anchorPath = join(stageDir, 'anchor_catalog.json');
const supervisorPath = join(stageDir, 'supervisor_replay_input.json');
const campaignPath = join(stageDir, 'campaign_replay_input.json');
const technicalSolutionPath = resolve(stageDir, '..', '..', 'tech_solution.md');
const runPath = resolve(stageDir, '..', '..', 'run.json');
const baseline = json(baselinePath);
const catalog = json(anchorPath);
const supervisor = json(supervisorPath);
const campaign = json(campaignPath);
const run = json(runPath);
const results = [];

function check(name, body) {
  try {
    body();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function validateDistribution(value) {
  assert.ok(Array.isArray(value.samples) && value.samples.length > 0);
  assert.equal(value.sampleCount, value.samples.length);
  assert.ok(value.samples.every(Number.isFinite));
  const sorted = [...value.samples].sort((left, right) => left - right);
  const expectedMean = value.samples.reduce((sum, sample) => sum + sample, 0) / value.samples.length;
  const middle = Math.floor(sorted.length / 2);
  const expectedMedian = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  close(value.mean, expectedMean);
  close(value.median, expectedMedian);
  const below = value.samples.filter((sample) => sample < value.reportedValue).length;
  const tied = value.samples.filter((sample) => sample === value.reportedValue).length;
  assert.equal(value.reportedRank, below);
  close(value.reportedPercentile, ((below + tied / 2) / value.samples.length) * 100);
  assert.equal(typeof value.name, 'string');
  assert.equal(typeof value.unit, 'string');
  assert.match(value.phase, /^(before|after)$/);
  if (Object.hasOwn(value, 'expectation')) {
    assert.equal(typeof value.within_expected_range, 'boolean');
    assert.equal(value.method_was_not_adjusted_to_match_expectation, true);
  }
}

function collectDistributions(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value.samples) && Object.hasOwn(value, 'mean') && Object.hasOwn(value, 'median')) found.push(value);
  for (const child of Object.values(value)) collectDistributions(child, found);
  return found;
}

check('artifact schemas and identity are bound', () => {
  assert.equal(baseline.version, 1);
  assert.equal(baseline.kind, 'closed_loop_baseline_measurements');
  assert.equal(catalog.kind, 'closed_loop_anchor_catalog');
  assert.equal(supervisor.kind, 'closed_loop_supervisor_replay_input');
  assert.equal(campaign.kind, 'closed_loop_campaign_replay_input');
  assert.equal(baseline.runId, catalog.runId);
  assert.equal(baseline.stageId, catalog.stageId);
  assert.equal(baseline.identity.baseCommit, run.baseCommit);
});

check('unstated dependencies and their value effects were recorded before probes', () => {
  const solution = text(technicalSolutionPath);
  assert.match(solution, /## Dependencies omitted by the supplied observations/);
  assert.match(solution, /\| Supplied constraint or quantity \| Unstated dependency \| Effect on what it is worth \|/);
  for (const dependency of [
    'The scope violation cost “3.2 hours”',
    'A live write can be attributed to “the agent”',
    'Filesystem notification means prompt detection',
    '“Protected”, “existing test”, and “effective scope” identify the same violation',
    '120 supervisor assessments and about 2.2M input tokens',
    'The two `10:08:58` and `10:09:38` ABORTs were false',
    'Artifact size and deadline “margin” warrant assessment',
    'Dose was 1.2, 2.1, and 2.1 minutes and stayed flat',
    'A criterion “never failed”',
    'The successor should contain a hard numeric floor',
    'Goal and yardstick “did not move”',
    'A campaign budget or no-progress rule fires',
    'A minute of engine overhead per attempt',
    'Registry/log growth and the 168 MB warn flood',
    'First plans were rejected in five of seven campaigns',
    'Baseline build/test/lint totals',
  ]) assert.ok(solution.includes(`| ${dependency} |`), dependency);
});

check('both dependency trees are physical directories', () => {
  for (const relativePath of ['node_modules', join('ui', 'node_modules')]) {
    const stat = lstatSync(join(projectRoot, relativePath));
    assert.equal(stat.isDirectory(), true, relativePath);
    assert.equal(stat.isSymbolicLink(), false, relativePath);
  }
  assert.deepEqual(baseline.dependencyTopology.map((entry) => entry.pathType), ['directory', 'directory']);
  assert.equal(baseline.dependencyRepair.installedPackages, false);
});

check('anchor catalog has the required bounded population', () => {
  assert.equal(catalog.files.length, 51);
  assert.equal(catalog.anchors.length, 47);
  assert.equal(new Set(catalog.files.map((entry) => entry.path)).size, catalog.files.length);
  assert.equal(new Set(catalog.anchors.map((entry) => entry.label)).size, catalog.anchors.length);
  for (const label of [
    'b1-unauthorized-existing-test-and-rollback',
    'b1-attempt-time-bounds',
    'b2-false-abort-raw-1',
    'b2-false-abort-raw-2',
    'b2-false-aborts-suppressed-effective',
    'b2-plan-stage-clock-origin',
    'b2-plan-attempt3-active-clock',
    'b3-warn-flood-observation',
    'b3-registry-growth-observation',
    'b4-cancelled-run-status',
    'b4-guidance-floor-authority',
    'b4-predecessor-yardstick',
    'b4-human-successor-yardstick',
    'b4-dose-series',
  ]) assert.ok(catalog.anchors.some((entry) => entry.label === label), label);
});

check('all 51 evidence and protected files retain their bytes', () => {
  for (const entry of catalog.files) {
    const current = bytes(entry.path);
    assert.equal(current.length, entry.bytes, entry.path);
    assert.equal(sha256(current), entry.sha256, entry.path);
  }
});

check('all 47 byte slices remain exact and UTF-8 reproducible', () => {
  const filePaths = new Set(catalog.files.map((entry) => entry.path));
  for (const anchor of catalog.anchors) {
    assert.ok(filePaths.has(anchor.sourcePath), anchor.label);
    const source = bytes(anchor.sourcePath);
    const slice = source.subarray(anchor.byteStart, anchor.byteEndExclusive);
    assert.equal(slice.length, anchor.byteLength, anchor.label);
    assert.equal(sha256(slice), anchor.sha256, anchor.label);
    assert.equal(slice.toString('utf8'), anchor.utf8, anchor.label);
  }
});

check('attempt-local false-ABORT clock evidence is byte anchored', () => {
  const clock = catalog.anchors.find((entry) => entry.label === 'b2-plan-attempt3-active-clock').utf8;
  assert.match(clock, /2026-09-02T10:08:26\.124Z/);
  assert.match(clock, /2026-09-02T10:08:45\.987Z/);
  assert.match(clock, /24e73f89335da76fbc05037b5954bc03/);
});

check('defaults and all role prompt bytes are protected', () => {
  assert.equal(sha256(bytes(join(projectRoot, 'config', 'defaults.yaml'))), baseline.protectedInputs.defaultsSha256);
  assert.equal(Object.keys(baseline.protectedInputs.rolePromptSha256).length, 12);
  for (const [name, digest] of Object.entries(baseline.protectedInputs.rolePromptSha256)) {
    assert.equal(sha256(bytes(join(projectRoot, 'config', 'agents', name))), digest, name);
  }
  assert.equal(sha256(bytes(anchorPath)), baseline.protectedInputs.anchorCatalogSha256);
});

check('build baseline is green and manifest-last', () => {
  const record = baseline.commands.build;
  assert.equal(record.exitCode, 0);
  assert.equal(record.generatedFileCount, 202);
  assert.equal(sha256(bytes(record.logPath)), record.logSha256);
  assert.match(text(record.logPath), /committed [0-9a-f]+ \(202 files; manifest last\)/);
});

check('test baseline is green with exact totals', () => {
  const record = baseline.commands.test;
  assert.deepEqual(
    [record.exitCode, record.passedFiles, record.totalFiles, record.passedTests, record.skippedTests, record.totalTests],
    [0, 185, 185, 2057, 4, 2061],
  );
  assert.equal(sha256(bytes(record.logPath)), record.logSha256);
  const log = text(record.logPath);
  assert.match(log, /Test Files\s+185 passed \(185\)/);
  assert.match(log, /Tests\s+2057 passed \| 4 skipped \(2061\)/);
});

check('lint baseline is green with exact totals', () => {
  const record = baseline.commands.lint;
  assert.deepEqual([record.exitCode, record.problems, record.errors, record.warnings], [0, 17, 0, 17]);
  assert.equal(sha256(bytes(record.logPath)), record.logSha256);
  assert.match(text(record.logPath), /17 problems \(0 errors, 17 warnings\)/);
});

check('all four unchanged-base probes fail for the intended property', () => {
  assert.deepEqual(baseline.unchangedBaseProbes.map((probe) => probe.behavior), ['behavior1', 'behavior2', 'behavior3', 'behavior4']);
  assert.ok(baseline.unchangedBaseProbes.every((probe) => probe.exitCode === 1));
  for (const probe of baseline.unchangedBaseProbes) assert.equal(sha256(bytes(probe.logPath)), probe.logSha256, probe.behavior);
  assert.match(text(baseline.unchangedBaseProbes[0].logPath), /violation was not restored while the adapter invocation remained active/);
  assert.match(text(baseline.unchangedBaseProbes[1].logPath), /"selectedTrigger": "routine"/);
  assert.match(text(baseline.unchangedBaseProbes[2].logPath), /"driftRowIds": null/);
  assert.match(text(baseline.unchangedBaseProbes[3].logPath), /ERR_MODULE_NOT_FOUND/);
});

check('behavior 1 historical audit records rollback and remains the backstop', () => {
  const audit = baseline.behavior1.historicalAudit;
  assert.equal(audit.unauthorizedPath, 'tests/test_happymj_explore7_round02_verification.py');
  assert.equal(audit.postAttemptAuditPresent, true);
  assert.equal(audit.sha256, catalog.files.find((entry) => entry.path === audit.path).sha256);
  assert.equal(audit.recordedElapsedMs, 5_741_999);
  assert.equal(audit.childCloseToAuditCompleteMs, 29_023);
  assert.notEqual(audit.recordedElapsedMs, 192 * 60_000);
});

check('behavior 1 controlled trials all expose end-only detection', () => {
  const trials = baseline.behavior1.rawTrials;
  assert.equal(trials.length, 5);
  for (const trial of trials) {
    assert.equal(trial.exitCode, 1);
    assert.equal(sha256(bytes(trial.logPath)), trial.logSha256);
    assert.equal(trial.observationWindowMs, 1200);
    assert.equal(trial.observedRestoreLatencyMs, null);
    assert.ok(trial.postAttemptRestoreLatencyMs > trial.observationWindowMs);
    assert.equal(trial.pathRestoredOnlyAfterInvocation, true);
    assert.equal(trial.correctivePromptSeenInSameAttempt, false);
    assert.equal(trial.postAttemptAuditPresent, true);
    assert.deepEqual(trial.postAttemptRolledBackWrites, ['spec/existing.test.ts']);
  }
  assert.deepEqual(baseline.behavior1.unchangedBaseCost, {
    pathRestores: 1,
    adapterInvocationsDiscarded: 1,
    sameAttemptReinvocations: 0,
    wholeAttemptFailed: true,
  });
});

check('every non-count measurement has a valid distribution', () => {
  const distributions = collectDistributions(baseline);
  assert.equal(distributions.length, 10);
  for (const distribution of distributions) validateDistribution(distribution);
});

check('supervisor review cutoff and final population are not mixed', () => {
  assert.deepEqual(supervisor.before, {
    calls: 120,
    tokensIn: 2_172_792,
    tokensOut: 9_840,
    verdictCounts: { WAIT: 90, ABORT: 15, GUIDE: 11, REJECT: 2, UNKNOWN: 2 },
  });
  assert.deepEqual(supervisor.finalHistoricalStateForDisclosure, {
    calls: 121,
    tokensIn: 2_190_534,
    tokensOut: 9_892,
    verdictCounts: { WAIT: 91, ABORT: 15, GUIDE: 11, REJECT: 2, UNKNOWN: 2 },
  });
  assert.equal(supervisor.replayCalls.length, 120);
});

check('supervisor replay retains only byte-reconstructable deterministic events', () => {
  const retained = supervisor.replayCalls.filter((call) => call.selectedByReconstructableEvent);
  assert.equal(retained.length, 37);
  assert.equal(supervisor.counterfactualFromReconstructableEvents.calls, 37);
  assert.equal(supervisor.counterfactualFromReconstructableEvents.tokensInUsingHistoricalCallSizes, 653_704);
  assert.ok(retained.every((call) => call.triggeringEvents.length > 0));
  assert.ok(supervisor.replayCalls.filter((call) => !call.selectedByReconstructableEvent).every((call) => call.triggeringEvents.length === 0));
  const permitted = new Set(['stage_transition', 'gate_verdict', 'guidance_arrival', 'scope_request', 'adapter_failure']);
  for (const event of supervisor.reconstructableEvents) {
    assert.ok(permitted.has(event.type), event.type);
    assert.equal(typeof event.eventId, 'string');
    assert.ok(Number.isFinite(Date.parse(event.timestamp)));
    assert.equal(typeof event.source, 'string');
    assert.equal(typeof event.quantities, 'object');
  }
  assert.deepEqual(supervisor.eventClassesNotRecoverableFromHistoricalBytes.map((entry) => entry.type), ['artifact_change']);
});

check('the two historical false ABORTs receive distinct correct dispositions', () => {
  const [first, second] = supervisor.rawFalseAborts;
  assert.deepEqual(supervisor.rawFalseAborts.map((call) => call.index), [21, 22]);
  assert.deepEqual(supervisor.rawFalseAborts.map((call) => call.tokensIn), [18_941, 19_069]);
  assert.equal(first.selectedByReconstructableEvent, true);
  assert.ok(first.triggeringEvents.some((event) => event.type === 'stage_transition' && event.timestamp === '2026-09-02T10:08:26.124Z'));
  assert.equal(first.clockComparison.activeAttemptElapsedMs, 292);
  assert.match(first.expectedCurrentDisposition, /assessment permitted/);
  assert.equal(second.selectedByReconstructableEvent, false);
  assert.deepEqual(second.triggeringEvents, []);
  assert.match(second.expectedCurrentDisposition, /no model call/);
  assert.match(supervisor.plannerClaimCorrection.finding, /call 21 followed the start of plan attempt 3/);
});

check('drift baseline preserves dose, admission, rejection, overhead, and growth facts', () => {
  assert.deepEqual(baseline.behavior3.dose.samples, [1.19595173424691, 2.1428210997008135, 2.1175898313695143]);
  assert.deepEqual(baseline.behavior3.firstPlanAdmission, {
    attemptIndex: 1,
    admitted: false,
    rejectedRequirementCount: 1,
    laterAdmittedAttemptIndex: 2,
  });
  assert.deepEqual(baseline.behavior3.supervisorRejections, {
    count: 2,
    laterOverturned: 2,
    method: 'each target work stage and downstream verifier later completed before research advancement',
  });
  assert.equal(baseline.behavior3.attemptOverheadRaw.length, 5);
  assert.equal(baseline.behavior3.attemptOverhead.median, 40_067);
  assert.equal(baseline.behavior3.attemptOverhead.within_expected_range, true);
  assert.equal(baseline.behavior3.registrySnapshot.reportedValue, 22_500_000);
  assert.equal(baseline.behavior3.warnFloodSnapshot.reportedValue, 168_000_000);
  assert.ok(baseline.behavior3.warnFloodSnapshot.reportedValue > baseline.behavior3.warningThresholdsForImplementation.logBytes);
});

check('cancelled campaign replay freezes the goal, yardstick, and remaining budget', () => {
  assert.equal(campaign.terminal.runStatus, 'stopped');
  assert.equal(campaign.terminal.currentIteration, 4);
  assert.equal(campaign.terminal.failureReason, 'Cancelled by user');
  assert.equal(sha256(JSON.stringify(campaign.frozenContract.goal)), campaign.frozenContract.goalDigest);
  assert.equal(sha256(campaign.frozenContract.yardstickText), campaign.frozenContract.yardstickDigest);
  assert.deepEqual(campaign.frozenContract.predecessorBudget, { maxRounds: 7, haltAfterNoImprovement: 5 });
  assert.deepEqual(campaign.frozenContract.expectedRemainingBudgetInOracle, { maxRounds: 6, haltAfterNoImprovement: 4 });
  assert.equal(campaign.oracleChecks.yardstickByteIdentical, true);
  assert.equal(campaign.oracleChecks.oracleYardstickDigest, campaign.frozenContract.yardstickDigest);
});

check('all five operator guidances are promoted in the successor oracle', () => {
  assert.equal(campaign.operatorGuidance.length, 5);
  assert.ok(campaign.operatorGuidance.every((entry) => entry.source === 'operator'));
  assert.deepEqual(
    campaign.expectedDerivation.promotedGuidanceIds,
    campaign.operatorGuidance.map((entry) => entry.id),
  );
  assert.ok(campaign.operatorGuidance.some((entry) => entry.body.includes('at least 20 minutes')));
});

check('never-failed flat criterion is linked to the authoritative graded floor', () => {
  assert.equal(campaign.criterion.history.length, 3);
  assert.equal(campaign.criterion.neverRecordedFail, true);
  assert.ok(campaign.criterion.history.every((entry) => entry.criterion.status !== 'fail'));
  assert.deepEqual(campaign.metricSeries.values, [1.19595173424691, 2.1428210997008135, 2.1175898313695143]);
  assert.equal(campaign.metricSeries.unit, 'minutes of measured four-seat capacity');
  assert.equal(campaign.expectedDerivation.convertedCriterionId, campaign.criterion.id);
  assert.deepEqual(campaign.expectedDerivation.floor, {
    metricId: 'dose_minutes',
    operator: '>=',
    value: 20,
    unit: 'minutes',
  });
  assert.equal(campaign.expectation.within_expected_range, false);
  assert.equal(campaign.expectation.method_was_not_adjusted_to_match_expectation, true);
});

check('declined items and the full validation pipeline are part of derivation', () => {
  assert.equal(campaign.declinedItems.length, 3);
  assert.deepEqual(campaign.declinedItems.map((entry) => entry.source), ['admission', 'supervisor_reject', 'supervisor_reject']);
  assert.deepEqual(campaign.expectedDerivation.diffReasonsRequired, ['promoted_guidance', 'converted_criterion']);
  assert.equal(campaign.expectedDerivation.preflightRequired, true);
  assert.equal(campaign.expectedDerivation.rehearsalRequired, true);
  assert.equal(campaign.expectedDerivation.admissionRequired, true);
  assert.equal(baseline.behavior4.rehearsalOnUnchangedBase, 'not_run: successor derivation module absent; behavior-4 probe exited 1');
});

const failures = results.filter((result) => !result.pass);
const output = {
  pass: failures.length === 0,
  checks: results.length,
  failingChecks: failures.length,
  stageDir,
  artifactSha256: {
    baseline: sha256(bytes(baselinePath)),
    anchors: sha256(bytes(anchorPath)),
    supervisorReplay: sha256(bytes(supervisorPath)),
    campaignReplay: sha256(bytes(campaignPath)),
  },
  failures,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
