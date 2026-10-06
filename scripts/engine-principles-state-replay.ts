/** Read-only recorded-state comparison. No recovery or run repair is performed. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FrozenReplayCorpus, parseReplayArguments, sha256 } from './engine-principles-inputs.js';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: node --import tsx scripts/engine-principles-state-replay.ts --census <frozen census> --store <read-only store> --baseline-dist <copied dist> --candidate-dist <copied dist> --out <evidence directory> [--reconstruct <comma-separated run IDs>]'); process.exit(0); }
const options = parseReplayArguments(args, ['--census', '--store', '--baseline-dist', '--candidate-dist', '--out'], ['--reconstruct']);
const census = resolve(options['--census']), store = resolve(options['--store']), baseline = resolve(options['--baseline-dist']);
const candidate = resolve(options['--candidate-dist']), out = resolve(options['--out']);
const reconstruct = new Set((options['--reconstruct'] ?? '').split(',').filter(Boolean));
if ([...reconstruct].some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) throw new Error('Invalid --reconstruct run ID');
mkdirSync(out, { recursive: true });
const corpus = new FrozenReplayCorpus(census);
const population = corpus.files.filter(entry => entry.readable && entry.relative_path === 'run.json');
writeFileSync(join(out, 'state_replay_selection_before.json'), JSON.stringify({ at: new Date().toISOString(), corpusSha256: corpus.sources['corpus.json'].sha256, expected: population.length, rule: 'Every frozen readable run.json identity, queried read-only at the recorded observation below. Mutable original carriers are not claimed frozen. Original raw projection is read before and after the view; changed observations are explicitly ambiguous.' }, null, 2));
process.env.FC_HOME = store;
const load = (dist: string, file: string) => import(pathToFileURL(join(dist, file)).href);
const beforeStore = await load(baseline, 'store.js'), afterStore = await load(candidate, 'store.js'), { readRunStateView } = await load(candidate, 'run-state-view.js');
beforeStore.setFcGlobalDir(store); afterStore.setFcGlobalDir(store);
const rows: any[] = [];
const stablePart = (state: any) => JSON.stringify({ runId: state.runId, projectDir: state.projectDir, status: state.status, currentIteration: state.currentIteration, stages: state.stages, retiredStageUsage: state.retiredStageUsage, stageEvidence: state.stageEvidence, supervisor: state.supervisor });
for (const member of population) {
  const row: any = { runId: member.run_id, frozenSha256: member.sha256, observedAt: new Date().toISOString() };
  try {
    if (typeof member.run_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(member.run_id)) {
      throw new Error(`Invalid frozen run identity ${JSON.stringify(member.run_id)}`);
    }
    const before = beforeStore.readArchivedRunState('', member.run_id).state;
    row.before = { status: before.status, stages: Object.keys(before.stages ?? {}).length, digest: sha256(stablePart(before)) };
    const view = readRunStateView(before.projectDir, member.run_id, { observedAt: row.observedAt });
    const after = afterStore.readArchivedRunState('', member.run_id).state;
    row.after = { status: view.run.status, stages: Object.keys(view.stages).length, digest: sha256(stablePart(after)), projectionSha256: view.snapshot.runStateSha256 };
    row.classification = row.before.digest !== row.after.digest ? 'ambiguous_concurrent_carrier_change' : view.run.status !== before.status || JSON.stringify(view.stages) !== JSON.stringify(before.stages) ? 'regression' : 'unchanged';
    row.prompts = { coverage: view.prompts.coverage, completeness: view.prompts.completeness, invocations: view.prompts.invocations.length, aliases: view.prompts.legacyInputs.length, missingAttemptInputs: view.prompts.missingAttemptInputs.length };
    row.diagnostics = view.diagnostics.map((entry: any) => entry.code);
    row.budget = view.budget;
    row.findings = view.audits.openFindings.length;
    row.resourceStatus = view.resources.status;
    // A bounded, deterministically selected reconstruction retains metadata and
    // hashes. Historical mutable prompt aliases are never relabeled exact.
    if (reconstruct.has(member.run_id) && /^[a-zA-Z0-9_-]+$/.test(member.run_id)) writeFileSync(join(out, `recorded_state_${member.run_id}.json`), `${JSON.stringify(view, null, 2)}\n`);
  } catch (error) { row.classification = 'ambiguous_unreadable_carrier'; row.error = error instanceof Error ? error.message : String(error); }
  rows.push(row);
}
writeFileSync(join(out, 'state_replay_rows.json'), JSON.stringify(rows));
const classifications = rows.reduce((counts: Record<string, number>, row) => { counts[row.classification] = (counts[row.classification] ?? 0) + 1; return counts; }, {});
writeFileSync(join(out, 'state_replay.json'), JSON.stringify({ version: 1, at: new Date().toISOString(), expected: population.length, processed: rows.length, classifications, limits: ['This is a present read observation of the complete frozen identity population; original mutable carrier bytes are not claimed unchanged since census.', 'Legacy exact invocation bytes are absent and remain unknown.', 'No state, index, task, lease, process or guidance mutation is invoked.'] }, null, 2));
console.log(JSON.stringify({ expected: population.length, processed: rows.length, classifications }));
process.exitCode = classifications.regression ? 2 : 0;
