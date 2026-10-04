/** Offline decision replay. Stored scripts and prompts are data, never commands. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as yaml, stringify } from 'yaml';
import { classifyDeclarationAdmissionChange, classifyRealityDeclarationChange, type ReplayDecision } from '../src/recorded-replay-policy.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node --import tsx scripts/engine-principles-replay.ts --census <frozen-census> --baseline-dist <copied-dist> --candidate-dist <dist> --private-root <os.tmpdir child> --out <evidence> [--old-dist <historical-runtime>]');
  process.exit(0);
}
function option(flag: string): string { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`); return resolve(args[index + 1]); }
const census = option('--census'), baseline = option('--baseline-dist'), candidate = option('--candidate-dist'), scratch = option('--private-root'), output = option('--out');
const rel = relative(tmpdir(), scratch);
if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Replay requires a fresh owned os.tmpdir child');
mkdirSync(scratch, { recursive: true }); mkdirSync(output, { recursive: true });
process.env.FC_HOME = join(scratch, 'private-store');
process.env.FLOWCREW_DAEMON_SOCKET = join(scratch, 'unavailable.sock');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (name: string) => JSON.parse(readFileSync(join(census, name), 'utf8'));
const frozen = json('corpus.json').files as Array<Record<string, any>>;
const verdictCarriers = frozen.filter((row) => row.readable && /(?:^|\/)(?:rejected_)?verdict(?:_[^/]+)?\.json$/.test(row.relative_path));
const admissionCarriers = frozen.filter((row) => row.readable && /(?:^|\/)(?:(?:proposed|effective)_)?dispatch_admission\.json$/.test(row.relative_path));
const sources: Record<string, { bytes: number; sha256: string }> = {};
for (const name of ['corpus.json', 'dispatch_records.json', 'native_planner_records.json', 'dispatch_documents.json', 'native_planner_documents.json', 'replay_templates_unique_context.json', 'checks_replay_selection.json', 'recovery_occurrences.json']) {
  const data = readFileSync(join(census, name)); sources[name] = { bytes: data.length, sha256: hash(data) };
}
const expected = {
  rawStages: json('dispatch_records.json').length + json('native_planner_records.json').length,
  templateContexts: json('replay_templates_unique_context.json').length,
  templateOccurrences: json('replay_templates_unique_context.json').reduce((total: number, row: any) => total + row.occurrences.length, 0),
  checkCarriers: json('checks_replay_selection.json').members.length,
  yamlDocuments: json('dispatch_documents.json').documents.length,
  nativeStageDocuments: json('native_planner_documents.json').documents.filter((row: any) => row.status === 'stage_document').length,
  verdictCarriers: verdictCarriers.length,
  admissionErrorCarriers: admissionCarriers.length,
};
writeFileSync(join(output, 'replay_selection_before.json'), JSON.stringify({ version: 2, at: new Date().toISOString(), expected, sources, rule: 'Every selected readable member, including refused and partial inputs. Compatibility helpers must stay equal. New admission may add only the predicted missing-contract errors, preserving every other error, warning and owner. New reality admission replaces undeclared script references with the exact predicted missing-reads refusal, retaining declared-read errors. All other changes block the replay. Earlier-source differences are inherited and individually retained, not retroactively approved.' }, null, 2));
const byPath = new Map(frozen.map((row) => [row.path, row]));
const readFrozen = (path: string): string => {
  const row = byPath.get(path); if (!row) throw new Error(`Unselected carrier ${path}`);
  const raw = readFileSync(row.snapshot ?? path).subarray(0, row.captured_size);
  if (raw.length !== row.captured_size || hash(raw) !== row.sha256) throw new Error(`Frozen-prefix mismatch ${path}`);
  return raw.toString('utf8');
};
async function runtime(dist: string, label: string) {
  const load = (file: string) => import(pathToFileURL(join(dist, file)).href);
  return { label, scheduler: await load('scheduler.js'), contract: await load('stage-artifact-contract.js'), checks: await load('reality-gate/index.js'), retry:await load('plan-retry-monotone.js') };
}
const current = await runtime(baseline, 'copied_deployed'), after = await runtime(candidate, 'candidate');
const oldIndex = args.indexOf('--old-dist');
const before = oldIndex >= 0 ? await runtime(resolve(args[oldIndex + 1]), 'historic_before') : current;
const runtimes = [before, current, after];
function decision(fn: () => unknown): ReplayDecision { try { return { status: 'returned', value: fn() }; } catch (error) { return { status: 'refused', error: error instanceof Error ? error.message : String(error) }; } }
const key = (value: unknown) => JSON.stringify(value);
const classified = (decisions: object[]) => ({ candidate_classification: key(decisions[1]) === key(decisions[2]) ? 'unchanged' : 'ambiguous_unpredicted', historical_classification: key(decisions[0]) === key(decisions[1]) ? 'unchanged' : 'inherited_prior_release_difference' });
const rawStages = [...json('dispatch_records.json'), ...json('native_planner_records.json')];
const schemaCache = new Map<string, ReplayDecision[]>();
const schemaRows = rawStages.map((row: any) => {
  const digest = hash(JSON.stringify(row.stage)); let decisions = schemaCache.get(digest);
  if (!decisions) { decisions = runtimes.map((runtime) => decision(() => runtime.scheduler.parseDispatchedStageConfig(row.stage))); schemaCache.set(digest, decisions); }
  return { source: row.source_path, runId: row.run_id, stageId: row.stage_id, line: row.line, phase: row.phase, digest, partial: !row.recorded_prompt_field, decisions, ...classified(decisions) };
});
if (schemaRows.length !== expected.rawStages) throw new Error(`Stage population mismatch ${schemaRows.length}`);
writeFileSync(join(output, 'replay_stage_schema.json'), JSON.stringify(schemaRows));
const project = join(scratch, 'empty-project'), run = join(scratch, 'empty-run'); mkdirSync(project, { recursive: true }); mkdirSync(run, { recursive: true });
const templates = json('replay_templates_unique_context.json');
const artifactRows = templates.map((row: any, index: number) => {
  let template = row.template; if (row.project_dir) template = template.replaceAll(row.project_dir, project); if (row.run_dir) template = template.replaceAll(row.run_dir, run);
  const decisions = runtimes.map((runtime) => decision(() => {
    const input = { stageId: 'recorded', template, projectDir: project, runDir: run, writes: [] };
    const audit = runtime.contract.inspectStageArtifactContract({ ...input, preimages: runtime.contract.captureStageArtifactContractPreimages(input) });
    if (audit.replayExecutions.length) throw new Error('REPLAY_FORBIDDEN: no recorded report command may execute');
    return { obligations: audit.obligations.map((entry: any) => ({ kind: entry.kind, path: relative(scratch, entry.path), source: entry.source })), violations: audit.violations.map((entry: any) => ({ kind: entry.kind, path: relative(scratch, entry.path), reason: entry.reason.replaceAll(project, '<project>').replaceAll(run, '<run>') })) };
  }));
  return { index, templateHash: row.raw_sha256, occurrenceCount: row.occurrences.length, decisions, ...classified(decisions) };
});
if (artifactRows.length !== expected.templateContexts || artifactRows.reduce((n: number, row: any) => n + row.occurrenceCount, 0) !== expected.templateOccurrences) throw new Error('Artifact population mismatch');
writeFileSync(join(output, 'replay_artifact_contracts.json'), JSON.stringify(artifactRows));
const selectedChecks = json('checks_replay_selection.json').members;
const checkRows = selectedChecks.map((row: any) => { const text = readFrozen(row.path); const decisions = runtimes.map((runtime) => decision(() => runtime.checks.parseChecksFromMarkdown(text))); return { source: row.path, runId: row.run_id, sha256: hash(text), decisions, ...classified(decisions) }; });
if (checkRows.length !== expected.checkCarriers) throw new Error('Check population mismatch');
writeFileSync(join(output, 'replay_check_declarations.json'), JSON.stringify(checkRows));
const documents = json('dispatch_documents.json').documents;
function admissionDecision(runtime: typeof after, raw: any, strict: boolean): ReplayDecision {
  return decision(() => {
    const items = Array.isArray(raw) ? raw : raw?.stages;
    if (!Array.isArray(items)) throw new Error('No stage list in selected carrier');
    const stages = items.map((item: any) => runtime.scheduler.StageConfigSchema.parse(item));
    const report = runtime.scheduler.inspectDispatchAdmission({ dispatched: stages, baseStages: [], dispatchStageId: stages.find((stage: any) => stage.dynamic_dispatch)?.id ?? 'plan', requireArtifactContracts: strict });
    return { pass: report.pass, errors: report.errors, warnings: report.warnings, terminalOwners: report.terminalOwners };
  });
}
function admissionRow(row: any, raw: any) {
  const decisions = runtimes.map((runtime) => admissionDecision(runtime, raw, false));
  const strict = admissionDecision(after, raw, true);
  const requiredErrors: string[] = [];
  if (decisions[2].status === 'returned') {
    const items = Array.isArray(raw) ? raw : raw?.stages;
    for (const item of items) if (!item.artifact_contract) requiredErrors.push(`ARTIFACT_DECLARATION_REQUIRED: ${item.id}.artifact_contract: declare {version:1, produces:[], reads:[], groups:[]} explicitly; prose cannot supply this contract`);
  }
  return { source: row.path ?? row.source_path, runId: row.run_id, line: row.line, context: 'general_core_only; absent original criteria/terminal/input/role provenance is not manufactured', decisions, ...classified(decisions), new_admission: { decision: strict, requiredErrors, classification: classifyDeclarationAdmissionChange({ baseline: decisions[1], candidate: strict, compatibility: decisions[2], requiredErrors }), explanation: 'New submitted legacy format requires explicit artifact_contract; every existing core verdict is retained.' } };
}
const admissionRows = documents.map((row: any) => admissionRow(row, yaml(readFrozen(row.path))));
if (admissionRows.length !== expected.yamlDocuments) throw new Error('YAML population mismatch');
writeFileSync(join(output, 'replay_general_admission.json'), JSON.stringify(admissionRows));
const nativeCarriers = new Map<string, string[]>();
const nativeAdmissionRows = json('native_planner_documents.json').documents.filter((row: any) => row.status === 'stage_document').map((row: any) => {
  let lines = nativeCarriers.get(row.source_path); if (!lines) { lines = readFrozen(row.source_path).split(/\r?\n/); nativeCarriers.set(row.source_path, lines); }
  const event = JSON.parse(lines[row.line - 1]);
  const stdout = event.item?.aggregated_output;
  if (typeof stdout !== 'string' || hash(stdout) !== row.stdout_sha256) throw new Error(`Native stdout binding mismatch ${row.source_path}:${row.line}`);
  return admissionRow(row, yaml(stdout));
});
if (nativeAdmissionRows.length !== expected.nativeStageDocuments) throw new Error('Native document population mismatch');
writeFileSync(join(output, 'replay_native_admission.json'), JSON.stringify(nativeAdmissionRows));
const realityRows = selectedChecks.map((row: any) => {
  const markdown = readFrozen(row.path);
  const inspect = (runtime: typeof after, text: string, strict: boolean) => decision(() => runtime.scheduler.inspectRealityCheckReachability({markdown:text, projectDir:project, runDir:run, stages:[], requireDeclaredReads:strict}));
  const decisions = runtimes.map((runtime) => inspect(runtime, markdown, false));
  const strict = inspect(after, markdown, true);
  const checks = after.checks.parseChecksFromMarkdown(markdown);
  const requiredErrors = checks.filter((check: any) => check.kind !== 'invalid' && check.advisory !== true && check.reads === undefined).map((check: any) => `REALITY_READ_DECLARATION_REQUIRED: reality check ${JSON.stringify(check.name)}.reads: declare exact rooted inputs and sources, or reads: [] explicitly; script/prose paths cannot supply this declaration`);
  const declaredMarkdown = '## Reality checks\n```yaml\n' + stringify({checks:checks.filter((check: any) => check.reads !== undefined)}) + '```\n';
  const declaredOnly = inspect(after, declaredMarkdown, false);
  return {source:row.path, runId:row.run_id, context:'empty-project/read-format-boundary; original producer graph is unavailable', decisions, ...classified(decisions), new_admission:{decision:strict, requiredErrors, classification:classifyRealityDeclarationChange({baseline:decisions[1], candidate:strict, compatibility:decisions[2], declaredOnly, requiredErrors}), explanation:'New hard checks require explicit reads; undeclared prose references no longer create a failing obligation.'}};
});
writeFileSync(join(output, 'replay_reality_admission.json'), JSON.stringify(realityRows));
const requirementRows = admissionCarriers.map((row) => {
  const text = readFrozen(row.path);
  const decisions = runtimes.map((runtime) => decision(() => {
    const report = JSON.parse(text);
    if (!Array.isArray(report.errors)) throw new Error('Admission carrier has no errors array');
    return report.errors.map((error: unknown) => {
      if (typeof error !== 'string') throw new Error('Admission error is not a string');
      return runtime.retry.planRetryRequirement(error);
    });
  }));
  return {source:row.path,runId:row.run_id,context:'admission errors to retry component identities; archived unsatisfied/satisfied state is not rewritten',decisions,...classified(decisions)};
});
writeFileSync(join(output, 'replay_retry_requirements.json'), JSON.stringify(requirementRows));
const verdictProject = join(scratch,'verdict-project'), verdictDirectory = join(verdictProject,'docs');mkdirSync(verdictDirectory,{recursive:true});
const verdictRows = verdictCarriers.map((row) => {
  const text = readFrozen(row.path);writeFileSync(join(verdictDirectory,'verdict_recorded.json'),text);
  const decisions = runtimes.map((runtime) => decision(() => runtime.scheduler.readGateVerdict(verdictProject,'recorded',undefined,null,false,false)));
  return {source:row.path,runId:row.run_id,sha256:hash(text),context:'raw verdict only; original metric/criteria/validation/research/plan provenance is unavailable',decisions,...classified(decisions)};
});
writeFileSync(join(output, 'replay_gate_verdicts.json'), JSON.stringify(verdictRows));
if (verdictRows.length !== expected.verdictCarriers || requirementRows.length !== expected.admissionErrorCarriers) throw new Error('Verdict/requirement carrier population mismatch');
const facets: Record<string, any[]> = { stage_schema: schemaRows, artifact_contracts: artifactRows, check_declarations: checkRows, general_admission: admissionRows, native_admission:nativeAdmissionRows, reality_admission:realityRows, retry_requirements:requirementRows, gate_verdicts:verdictRows };
const newAdmissions = [...admissionRows,...nativeAdmissionRows,...realityRows].map((row) => ({source:row.source,runId:row.runId,line:row.line,...row.new_admission}));
writeFileSync(join(output, 'replay_new_admission_decisions.json'), JSON.stringify(newAdmissions));
const summary = { version: 2, at: new Date().toISOString(), selections: sources,
  populations: Object.fromEntries(Object.entries(facets).map(([name, rows]) => [name, { expected: rows.length, processed: rows.length, feasibility_floor: rows.length, candidate_differences: rows.filter((row) => row.candidate_classification !== 'unchanged').length, inherited_differences: rows.filter((row) => row.historical_classification !== 'unchanged').length, new_admission_intended:rows.filter((row)=>row.new_admission?.classification==='intended').length, new_admission_unpredicted:rows.filter((row)=>row.new_admission?.classification==='ambiguous_unpredicted').length }])),
  limits: ['New proposals must declare contracts and hard-check reads or receive a precise format refusal. Already-admitted legacy work and compatibility helpers retain their old inference.', 'General-core replay covers all YAML and projected native stage-document carriers but does not authenticate complete original plan/criteria/terminal/research/input/role combinations. It is not whole safety admission proof.', 'Native projected stdout and mutable aliases retain their censored/partial status.', 'No historical script, replay command, model, daemon or GPU operation executed.', 'State/leases/revision/restart need their separate recorded/protection/private-daemon receipts.'],
  differences: Object.fromEntries(Object.entries(facets).map(([name, rows]) => [name, rows.filter((row) => row.candidate_classification !== 'unchanged')])),
};
writeFileSync(join(output, 'replay.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ populations: summary.populations, unpredicted: Object.values(summary.populations).reduce((n, value) => n + value.candidate_differences + value.new_admission_unpredicted, 0) }));
process.exitCode = Object.values(summary.populations).some((value) => value.candidate_differences > 0 || value.new_admission_unpredicted > 0) ? 2 : 0;
