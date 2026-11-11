/** Required protection checks on one disposable checkout. Each mutant is built
 * before its test, so stale dist, compiler/import errors and fixture failures
 * cannot be reported as killed mutations. Receipts go to stdout only. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'research-mutations-'));
const checkout = join(scratch, 'checkout');
const temp = join(scratch, 'tmp');
mkdirSync(checkout); mkdirSync(temp);
const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp,
  HOME: join(scratch, 'home'), FC_HOME: join(scratch, 'store'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete env[key as keyof typeof env];
mkdirSync(env.HOME); mkdirSync(env.FC_HOME);
const shellQuote = (argument: string) => "'" + argument.replaceAll("'", "'\\''") + "'";
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function command(executable: string, args: string[], cwd = checkout, timeout = 240000) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return { exit: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`, error: result.error?.message, signal: result.signal };
}
function assertSuccess(result: ReturnType<typeof command>, label: string) {
  if (result.exit !== 0) throw new Error(`${label}: exit ${result.exit}; ${result.error ?? result.signal ?? ''}\n${result.output.slice(-5000)}`);
}
// Real directories own tool caches. Only package entries are linked to installed dependencies.
function dependencies(source: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.bin') continue;
    symlinkSync(realpathSync(join(source, entry.name)), join(destination, entry.name), entry.isDirectory() ? 'dir' : 'file');
  }
}
interface Mutation { id: string; file: string; edits: Array<[string, string]>; test: string; spec: string }
const loop = 'src/scheduler/sched_policy/research.ts';
const instrument = 'src/research-measurement.ts';
const mutations: Mutation[] = [
  { id: 'terminal-commit-projection', file: 'src/scheduler/sched_loop/run-workflow.ts', edits: [[
    'else projectResearchConclusion(current, persist);', 'else void current;',
  ]], spec: 'spec/research-loop.test.ts', test: 'reprojects a visible terminal commit after its acknowledgement fails' },
  { id: 'pointer-commit-projection', file: 'src/scheduler/sched_loop/run-workflow.ts', edits: [[
    'else projectResearchConclusion(current, persist);', 'else void current;',
  ]], spec: 'spec/research-loop.test.ts', test: 'reprojects a visible pointer commit after its acknowledgement fails' },
  { id: 'terminal-recovery', file: 'src/restart-recovery.ts', edits: [[
    'return state.researchReportPaths ? reconcileResearchConclusion(projectDir, runId) : state;', 'return state;',
  ]], spec: 'spec/research-loop.test.ts', test: 'recovers missing projections of committed shipped state idempotently' },
  { id: 'terminal-startup', file: 'src/daemon-reconciliation.ts', edits: [[
    "import { listRunIdsFromIndex }", "import { listRunningRunIdsFromIndex }",
  ], [
    "const ids = listRunIdsFromIndex('')", "const ids = listRunningRunIdsFromIndex('')",
  ]], spec: 'spec/research-loop.test.ts', test: 'startup re-derives missing all from a terminal journal' },
  { id: 'projection-reentry', file: 'src/store.ts', edits: [[
    '    afterCommit?.(state, persist);', '    if (!unchanged) afterCommit?.(state, persist);',
  ]], spec: 'spec/research-loop.test.ts', test: 'recovers missing projections of committed shipped state idempotently' },
  { id: 'projection-idempotence', file: instrument, edits: [[
    "if (!existsSync(path) || readFileSync(path, 'utf8') !== body) atomicWrite(path, body);", 'atomicWrite(path, body);',
  ]], spec: 'spec/research-loop.test.ts', test: 'recovers missing projections of committed shipped state idempotently' },
  { id: 'completion-idempotence', file: 'src/scheduler/sched_policy/run-completion.ts', edits: [[
    'if (!hasResearchCompletion(state))', 'if (Boolean(1) || !hasResearchCompletion(state))',
  ]], spec: 'spec/research-loop.test.ts', test: 'recovers missing projections of committed shipped state idempotently' },
  { id: 'historical-projection', file: 'src/scheduler/sched_policy/run-completion.ts', edits: [[
    "&& hasResearchCompletion(state)) return;", "&& hasResearchCompletion(state) && Boolean(0)) return;",
  ]], spec: 'spec/research-loop.test.ts', test: 'startup leaves complete historical projections and a later shared project report unchanged' },
  { id: 'rehearsal-stop', file: 'src/rehearse.ts', edits: [['if (precluded) throw', 'if (precluded && Boolean(0)) throw']],
    spec: 'spec/research-loop.test.ts', test: 'fails rehearsal when its declared budget prevents any producer dispatch' },
  { id: 'ledger-rounds', file: 'src/campaign-ledger.ts', edits: [['tried.slice(0, cap)', 'tried.filter((round, index, all) => all.findIndex(other => other.label === round.label) === index).slice(0, cap)']],
    spec: 'spec/campaign-context.test.ts', test: 'keeps distinct trial rounds when engine display labels repeat across runs' },
  { id: 'campaign-keep', file: 'src/campaign-page.ts', edits: [[' || rawRound.comparison?.keep === false', '']],
    spec: 'spec/campaign-page-read-model.test.ts', test: 'projects only engine-kept measurement rounds into the accepted campaign best' },

  { id: 'property-review-schema', file: 'src/scheduler/sched_settlement/stage-execution.ts', edits: [['extendedVerdict: !state.research?.measurement && Boolean(', 'extendedVerdict: Boolean(']],
    spec: 'spec/research-loop.test.ts', test: 'refuses numeric review metadata instead of letting the reviewer judge performance' },
  { id: 'raw-counts', file: instrument, edits: [[' || !rawCounts(candidate, metrics)', '']],
    spec: 'spec/research-loop.test.ts', test: 'permits a fractional count baseline mean while refusing fractional raw candidate counts' },
  { id: 'journal-transaction', file: instrument, edits: [['if (submission) state.rounds =', 'if (submission && Boolean(0)) state.rounds =']],
    spec: 'spec/research-measurement.test.ts', test: 'replays the original measured candidate when a later capture reuses its label' },
  { id: 'report-destination', file: instrument, edits: [['if (artifactRootContains(input, destination) || artifactRootContains(destination, input))', 'if ((artifactRootContains(input, destination) || artifactRootContains(destination, input)) && Boolean(0))']],
    spec: 'spec/research-loop.test.ts', test: 'refuses an aliased terminal destination without modifying frozen instrument inputs' },

  { id: 'declaration-shape', file: 'src/scheduler/sched_loop/run-workflow.ts', edits: [['stages: researchStages(declared.research)', 'stages: workflow.stages']],
    spec: 'spec/research-loop.test.ts', test: 'dispatches a producer in round 1 for the archived measurement declaration shape' },
  { id: 'engineering-declaration', file: 'src/decision-graph.ts', edits: [["assumptions: { type: 'array', items: text },", "assumptions: { type: 'array', items: text }, metric_search: { type: 'boolean' }, missing_author_facts: { type: 'array', items: text },"]],
    spec: 'spec/no-approvals.test.ts', test: 'keeps a metric-oriented brief engineering by declaration without demanding research fields' },

  { id: 'submission-digest', file: loop, edits: [['if (candidate.sha256 === measured.best.candidate)', 'if (false)']],
    spec: 'spec/research-loop.test.ts', test: 'does not measure or keep unchanged candidate content and counts stagnation' },
  { id: 'independent-review', file: loop, edits: [['if (!entry.review.pass)', 'if (!entry.review.pass && Boolean(0))']],
    spec: 'spec/research-loop.test.ts', test: 'never measures or keeps a review-rejected candidate and journals the reason' },
  { id: 'whole-run-noise', file: instrument, edits: [[
    '      const a = Math.floor(random() * replicates.length), b = (a + 1 + Math.floor(random() * (replicates.length - 1))) % replicates.length;\n      for (let j = 0; j < rows.length; j++) {',
    '      for (let j = 0; j < rows.length; j++) {\n        const a = Math.floor(random() * replicates.length), b = (a + 1 + Math.floor(random() * (replicates.length - 1))) % replicates.length;',
  ]], spec: 'spec/research-loop.test.ts', test: 'preserves a whole-run shared factor with negligible item noise' },
  { id: 'archived-noise', file: instrument, edits: [[
    '      const a = Math.floor(random() * replicates.length), b = (a + 1 + Math.floor(random() * (replicates.length - 1))) % replicates.length;\n      for (let j = 0; j < rows.length; j++) {',
    '      for (let j = 0; j < rows.length; j++) {\n        const a = Math.floor(random() * replicates.length), b = (a + 1 + Math.floor(random() * (replicates.length - 1))) % replicates.length;',
  ]], spec: 'spec/research-loop.test.ts', test: 'evaluates the scrubbed four unchanged-tree runs beside observed run-pair SD' },
  { id: 'count-run-shift', file: instrument, edits: [[
    'rows.reduce((n, row) => n + row[a].metrics[name] - row[b].metrics[name], 0) ** 2',
    'rows.reduce((n, row) => n + (row[a].metrics[name] - row[b].metrics[name]) ** 2, 0)',
  ]], spec: 'spec/research-loop.test.ts', test: 'preserves a whole-run shared factor with negligible item noise' },
  { id: 'baseline-mean', file: instrument, edits: [['state.baseline = state.best = meanResearchBaseline(state.replicates, parsed.metrics);', 'state.baseline = state.best = state.replicates[0];']],
    spec: 'spec/research-loop.test.ts', test: 'uses per-item mean of every baseline replicate as the calibration incumbent' },
  { id: 'calibration-exit', file: instrument, edits: [['if (receipt.reason || receipt.exitCode !== 0 || !parsed.success)', 'if (receipt.reason || !parsed.success)']],
    spec: 'spec/research-loop.test.ts', test: 'fails calibration exit 2 closed before any producer, even with valid numeric stdout' },
  { id: 'frozen-roots', file: instrument, edits: [[
    "    if (digest(inventory(instrument.projectDir, instrument.config.frozen)) !== digest(instrument.files)) throw new Error('frozen_source_fingerprint_mismatch');\n", '',
  ], [
    "    if (digest(inventory(instrument.projectDir, instrument.config.frozen)) !== digest(instrument.files)) result.reason = 'frozen_source_fingerprint_mismatch';\n", '',
  ]], spec: 'spec/research-measurement.test.ts', test: 'refuses edited frozen dependencies even when evaluator code embeds the original absolute path' },
  { id: 'guard-selection', file: instrument, edits: [['result.keep = guards.every(g => g.passes) && primary.some', 'result.keep = primary.some']],
    spec: 'spec/research-measurement.test.ts', test: 'does not use held-out until strict development improvement and guards pass' },
  { id: 'held-out-allowance', file: instrument, edits: [['const exhausted = !!config.held_out && state.heldOutUses.length >= config.held_out.allowance;', 'const exhausted = false;']],
    spec: 'spec/research-measurement.test.ts', test: 'never exceeds the held-out allowance across distinct improving submissions' },
  { id: 'legacy-migration', file: 'src/scheduler/sched_admission/brief-contract.ts', edits: [['r.measurement === undefined || unknown.length || retired.length', 'r.measurement === undefined || retired.length']],
    spec: 'spec/research-loop.test.ts', test: 'refuses legacy result_file with the migration diagnostic' },
  { id: 'measurement-deadline', file: instrument, edits: [
    ['Math.min(Date.now() + parsed.timeout_seconds * 1000, deadline)', 'Date.now() + parsed.timeout_seconds * 1000'],
    ['Math.min(Date.now() + config.timeout_seconds * 1000, deadline)', 'Date.now() + config.timeout_seconds * 1000'],
  ], spec: 'spec/research-loop.test.ts', test: 'bounds a long authored measurement timeout by the remaining run wall allowance' },
  { id: 'literal-scope', file: loop, edits: [['research.measurement.candidate.map(literalProjectScope)', 'research.measurement.candidate']],
    spec: 'spec/research-loop.test.ts', test: 'preserves literal root membership through construction and admission' },
  { id: 'root-domain', file: instrument, edits: [['normalizedProjectContentPath(p) === p', 'p.trim() === p']],
    spec: 'spec/research-loop.test.ts', test: 'refuses roots outside the common portable project-relative path domain at parse' },
  { id: 'continuation-resume', file: loop, edits: [
    ['if (Object.values(state.stages).some(isContinuingStage))', 'if (false)'],
    [' || isContinuingStage(state.stages[stages[0].id])', ''],
  ], spec: 'spec/research-loop.test.ts', test: 'resumes a continuing producer rather than measuring unfinished bytes' },
  { id: 'continuation-handoff', file: loop, edits: [['if (isContinuingStage(state.stages[stages[0].id])) continue;', 'if (false) continue;']],
    spec: 'spec/research-loop.test.ts', test: 'continuing research producer completes the same submission before review and measurement' },
  { id: 'review-continuation', file: loop, edits: [
    ['if (Object.values(state.stages).some(isContinuingStage))', 'if (false)'],
    [' || isContinuingStage(state.stages[stages[1].id])', ''],
  ], spec: 'spec/research-loop.test.ts', test: 'finishes a retained independent review before accepting the submission' },
  { id: 'timer-overflow', file: instrument, edits: [[
    "const cancelDeadline = scheduleDeadline(() => { reason = 'measurement_timeout'; stop(); }, () => deadline - Date.now());",
    "const rawTimer = setTimeout(() => { reason = 'measurement_timeout'; stop(); }, deadline - Date.now()); const cancelDeadline = () => clearTimeout(rawTimer);",
  ]], spec: 'spec/research-loop.test.ts', test: 'a long accepted timeout bounded by a long finite wall budget permits calibration' },
  { id: 'report-finalization', file: 'src/scheduler/sched_policy/run-completion.ts', edits: [['if (gate.realityGate?.pass === false)', 'if (gate.realityGate?.pass === false && Boolean(0))']],
    spec: 'spec/research-loop.test.ts', test: 'rejects a candidate after reality failure without leaving a shipped-labelled project report' },
  { id: 'partial-report', file: instrument, edits: [['new Set([...(state.researchReportPaths ?? []), ...desired])', 'new Set(desired)']],
    spec: 'spec/research-loop.test.ts', test: 'partial report publication does not leave a success report or success pointer' },
  { id: 'report-cancellation', file: 'src/scheduler/sched_policy/run-completion.ts', edits: [[
    'if (outcome.status !== RUN_STATUS.CANCELLED) throw cancelledRunPublicationError(current.runId);',
    'if (current.research?.measurement) writeResearchTerminalReport({ ...current, status: outcome.status }); if (outcome.status !== RUN_STATUS.CANCELLED) throw cancelledRunPublicationError(current.runId);',
  ]], spec: 'spec/research-loop.test.ts', test: 'publishes only committed cancellation reports when cancellation wins during reality verification' },
  { id: 'publication-acknowledgement', file: 'src/scheduler/sched_policy/run-completion.ts', edits: [[
    '...(current.terminalStates?.[current.status]?.paths ?? [])', '...[]',
  ]], spec: 'spec/research-loop.test.ts', test: 'finalizes a report published before its durability acknowledgement fails incomplete' },
  { id: 'publication-intent', file: 'src/scheduler/sched_policy/run-completion.ts', edits: [[
    '...(current.terminalStates?.[current.status]?.paths ?? [])', '...[]',
  ]], spec: 'spec/research-loop.test.ts', test: 'partial report publication does not leave a success report or success pointer' },
  { id: 'commit-before-report', file: 'src/scheduler/sched_policy/run-completion.ts', edits: [[
    '      current.completedAt = outcome.completedAt ?? new Date().toISOString();',
    '      current.completedAt = outcome.completedAt ?? new Date().toISOString(); if (current.research?.measurement) writeResearchTerminalReport(current);',
  ]], spec: 'spec/research-loop.test.ts', test: 'publishes each normal report once and only from durably committed terminal state' },
  { id: 'drive-domain', file: 'src/scheduler/sched_admission/scope-services.ts', edits: [[
    '|| /^[A-Za-z]:/.test(normalized)', '|| /^[A-Za-z]:\\//.test(normalized)',
  ]], spec: 'spec/research-loop.test.ts', test: 'refuses roots outside the common portable project-relative path domain at parse' },

];
try {
  const listed = command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  assertSuccess(listed, 'inventory');
  const files = [...new Set(listed.output.split('\n')[0].split('\0').filter(Boolean))].filter(file => existsSync(join(root, file)));
  for (const file of files) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true }); copyFileSync(join(root, file), join(checkout, file));
  }
  dependencies(join(root, 'node_modules'), join(checkout, 'node_modules'));
  dependencies(join(root, 'ui/node_modules'), join(checkout, 'ui/node_modules'));
  assertSuccess(command('git', ['init', '-q']), 'private Git setup');
  assertSuccess(command('git', ['add', '.']), 'private Git inventory');
  assertSuccess(command('git', ['-c', 'user.name=Mutation', '-c', 'user.email=mutation@example.invalid', 'commit', '-qm', 'fixture']), 'private Git baseline');
  const originals = new Map([...new Set(mutations.map(m => m.file))].map(file => [file, readFileSync(join(root, file), 'utf8')]));
  const selected = ['spec/research-loop.test.ts', 'spec/research-measurement.test.ts', 'spec/no-approvals.test.ts', 'spec/campaign-context.test.ts', 'spec/campaign-page-read-model.test.ts'];
  const build = () => command('npm', ['run', 'build']);
  assertSuccess(build(), 'control build');
  const control = command('npm', ['run', 'test', '--', ...selected, '--no-file-parallelism', '--no-cache'], checkout, 600000);
  assertSuccess(control, 'unmutated controls');
  console.log(JSON.stringify({ control: { buildExit: 0, testExit: control.exit }, specs: selected }));
  let killed = 0;
  for (const mutation of mutations) {
    const original = originals.get(mutation.file)!;
    let altered = original;
    for (const [before, after] of mutation.edits) {
      if (!altered.includes(before)) throw new Error(`${mutation.id}: exact mutation target is missing`);
      altered = altered.replace(before, after);
    }
    writeFileSync(join(checkout, mutation.file), altered);
    const compiled = build(); assertSuccess(compiled, mutation.id + ' mutant build');
    const output = join(scratch, mutation.id + '.json');
    const args = ['run', 'test', '--', mutation.spec, '-t', mutation.test, '--no-file-parallelism', '--no-cache', '--reporter=json', '--outputFile=' + output];
    const checked = command('npm', args, checkout, 180000);
    const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : undefined;
    const failures = (report?.testResults ?? []).flatMap((file: any) => file.assertionResults ?? []).filter((test: any) => test.status === 'failed');
    const matched = failures.find((test: any) => test.fullName.includes(mutation.test) && test.failureMessages.some((text: string) => /AssertionError|expected .* to|expected .*\n/i.test(text)));
    if (checked.exit !== 1 || !matched || report.numFailedTests !== 1 || failures.length !== 1) throw new Error(`${mutation.id}: not a substantive assertion kill; exit ${checked.exit}\n${checked.output.slice(-5000)}`);
    killed++;
    console.log(JSON.stringify({ mutant: mutation.id, source: mutation.file, originalSha256: hash(original), mutantSha256: hash(altered),
      buildCommand: 'npm run build', buildExit: compiled.exit, testCommand: ['npm', ...args].map(shellQuote).join(' '), testExit: checked.exit,
      assertion: matched.fullName, failure: matched.failureMessages[0].split('\n').slice(0, 3).join('\n'), killed: true }));
    writeFileSync(join(checkout, mutation.file), original);
  }
  for (const [file, original] of originals) if (readFileSync(join(root, file), 'utf8') !== original) throw new Error('Reviewed source changed during mutations: ' + file);
  console.log(JSON.stringify({ killed, total: mutations.length, reviewedSourcesUnchanged: true }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
