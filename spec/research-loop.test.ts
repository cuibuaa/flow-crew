import { renderRunSummary } from '../src/run-summary.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify, parse } from 'yaml';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { loadWorkflow, runWorkflow } from '../src/scheduler.js';
import { fcGlobalDir, setFcGlobalDir, runDir, readRunState, writeRunState, writeStageStatus, writeStageOutput } from '../src/store.js';
import { runRecordPath } from '../src/run-layout.js';
import { parseBriefFrontmatter, entryWorkflow } from '../src/scheduler/sched_admission/brief-contract.js';
import { inspectBrief } from '../src/brief-preflight.js';
import { calibrateResearchNoise, decideResearchComparison as researchComparison, meanResearchBaseline, researchMeasurementState, type Observation, initializeResearchMeasurements } from '../src/research-measurement.js';
import { runResearchLoop, RESEARCH_REVIEW_CONTRACT, researchStages, admitResearchStages, researchStopReason } from '../src/scheduler/sched_policy/research.js';
import { resolveCampaignStorageKey } from '../src/campaigns.js';
import { extractBriefCriteria } from '../src/brief-criteria.js';
import { rehearseBrief } from '../src/rehearse.js';
import * as researchOwner from '../src/scheduler/sched_policy/research.js';
import * as engineFiles from '../src/engine-fs.js';
import * as storeOwner from '../src/store.js';
import { stageScopeOwnsPath } from '../src/scheduler/sched_admission/dispatch.js';
import { cancelRunStateAtPath, concludeRun, projectResearchConclusion } from '../src/scheduler/sched_policy/run-completion.js';
import { scheduleDeadline, stageWrapUpTiming, type AttemptDeadlineClock } from '../src/attempt-deadline.js';
import { type Adapter } from '../src/adapters/base.js';
import { createRun } from './test-support/create-run.js';
import { readRunEvents } from '../src/run-events.js';
import * as eventOwner from '../src/run-events.js';
import { reconcileHostInterruptedRun } from '../src/restart-recovery.js';
import { createDaemonReconciler } from '../src/daemon-reconciliation.js';
import { TaskRegistry } from '../src/task-registry.js';
import * as commandOwner from '../src/adapters/base.js';
import { setEngineDefaults } from './test-support/engine-defaults-fixture.js';
import { isolatedProjectCommand } from './test-support/isolated-project-command.js';

const agents = join(import.meta.dirname, '../config/agents');
const fixture = readFileSync(new URL('./fixtures/research-measurement.brief.md', import.meta.url), 'utf8');
const metrics = { cost: { direction: 'min', scale: 'fraction' } } as const;
const obs = (factor: number): Observation => ({ status: 'measured', fingerprint: 'frozen', candidate: 'same-tree', items: Array.from({ length: 100 }, (_, n) => ({ id: `item-${n}`, metrics: { cost: (n + 1) * factor } })) });
const notes = { hypothesis: 'Reduce general cost.', files_changed: ['src/cost.json'], property_evidence: 'The candidate respects scope and retains checks.' };
const delivered = JSON.stringify({ status: 'delivered', summary: 'Submitted candidate.', caveats: [], remaining_work: [], blocks: null, notes });
const criteria = extractBriefCriteria(RESEARCH_REVIEW_CONTRACT).criteria;
function verdict(pass = true) { return JSON.stringify({ pass, reason: pass ? 'Candidate properties hold.' : 'Candidate weakens a required check.', remaining_work: [],
  criteria: Object.fromEntries(criteria.map(c => [c.id, { status: pass ? 'pass' : 'fail', evidence: 'Independent inspection of candidate diff and brief properties.' }])),
  audit_findings: { version: 1, findings: [] }, ...(pass ? {} : { repairability: { version: 1, disposition: 'repairable', evidence: 'Use another candidate preserving checks.' } }) }); }
let root: string, project: string, previousStore: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'research-loop-')); project = join(root, 'project'); mkdirSync(project);
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  setEngineDefaults({ max_iterations: 1, max_retries: 0, stage_technical_retries: 0, gate_retry_loops: 0 });
  isolatedProjectCommand('git', ['init', '-q'], project, root);
  isolatedProjectCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline'], project, root);
});
afterEach(() => { vi.restoreAllMocks(); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });
function put(path: string, value: string) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), value); }
function brief(edit: (raw: any) => void = () => {}) {
  const raw = parse(fixture.split('---')[1]);
  raw.research.measurement.development.command = process.execPath;
  raw.research.measurement.guards[0].command = process.execPath;
  raw.research.stop.max_rounds = 1;
  for (const path of raw.research.measurement.candidate) {
    if (path.includes('.') && !path.endsWith('/src')) put(path, '{}'); else mkdirSync(join(project, path), { recursive: true });
  }
  put('src/cost.json', '100');
  put('bench/stage-tokens-fast-cal-1.json', '{}');
  put('bench/instrument/evaluate.cjs', `const fs=require('node:fs'); const cost=Number(fs.readFileSync(process.env.FC_RESEARCH_CANDIDATE+'/src/cost.json'));\nif(process.argv.includes('guard')) console.log(JSON.stringify({passes:true}));\nelse {console.log(JSON.stringify({items:[{id:'a',metrics:{cost:Number(process.env.BASELINE_DRAW || cost)}}]})); if(process.argv.includes('bad-argument')) process.exit(2);}\n`);
  edit(raw);
  return `---\n${stringify(raw)}---\n# Improve ordinary engine cost\n\n## Report criteria\n1. Show engine baseline, noise, per-round decisions and notes.\n`;
}
async function run(text: string, adapter: ScriptedAdapter, campaignId?: string) {
  const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
  const state = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, undefined, text, true, campaignId);
  return { state, directory: runDir(project, state.runId) };
}
const proposal = (cost?: number, pass = true) => new ScriptedAdapter({ produce: { output: delivered, ...(cost === undefined ? {} : { projectFiles: { 'src/cost.json': String(cost) } }) }, review: { output: verdict(pass) } });

describe('declaration-owned research loop', () => {
  it('dispatches a producer in round 1 for the archived measurement declaration shape', async () => {
    const text = brief(); const adapter = proposal(50);
    const { state, directory } = await run(text, adapter);
    expect(state.status, state.failureReason).toBe('ceiling_hit');
    expect(adapter.calls.map(c => c.stageId)).toEqual(['produce', 'review']);
    expect(state.currentIteration).toBe(1);
    expect(researchMeasurementState(directory).rounds).toMatchObject([{ label: 'round-1', comparison: { keep: true }, notes }]);
    const report = readFileSync(runRecordPath(directory, 'research_report.md'), 'utf8');
    expect(report).toContain('Producer notes (advisory; no numeric authority)'); expect(report).toContain('"baseline": 100');
    expect(readFileSync(join(project, 'bench/REPORT.md'), 'utf8')).toBe(report);
    expect(existsSync(runRecordPath(directory, 'research_journal.json'))).toBe(false);
  });
  it('does not measure or keep unchanged candidate content and counts stagnation', async () => {
    const text = brief(raw => { raw.research.stop = { max_rounds: 3, halt_after_no_improvement: 1 }; });
    const spawn = commandOwner.spawnOwnedCommand; let draws = 0;
    const launch = vi.spyOn(commandOwner, 'spawnOwnedCommand').mockImplementation((command, args, options) => spawn(command, args, {
      ...options, env: { ...options.env, BASELINE_DRAW: ++draws <= 2 ? '100' : '1' },
    }));
    const adapter = proposal();
    const { state, directory } = await run(text, adapter);
    expect(state.status, state.failureReason).toBe('ceiling_hit');
    expect(launch).toHaveBeenCalledTimes(2); // baseline replicates only
    const measured = researchMeasurementState(directory);
    expect(measured.rounds).toMatchObject([{ outcome: 'no_candidate' }]);
    expect(measured.rounds?.[0].measurement).toBeUndefined(); expect(measured.best).toEqual(measured.baseline);
    expect(measured.revision).toBe(0); expect(state.currentIteration).toBe(1);
  });
  it('never measures or keeps a review-rejected candidate and journals the reason', async () => {
    const text = brief(); const launch = vi.spyOn(commandOwner, 'spawnOwnedCommand');
    const { state, directory } = await run(text, proposal(1, false));
    expect(state.status, state.failureReason).toBe('ceiling_hit');
    const measured = researchMeasurementState(directory);
    expect(renderRunSummary(project, directory, state)).toContain('review rejected');
    expect(measured.rounds).toMatchObject([{ outcome: 'review_rejected', reason: 'Candidate weakens a required check.', review: { pass: false } }]);
    expect(measured.best).toEqual(measured.baseline); expect(measured.revision).toBe(0); expect(launch).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(project, 'src/cost.json'), 'utf8')).toBe('100');
  });
  it('refuses an undispatchable producer shape without measuring any fallback tree', async () => {
    const shape = researchOwner.researchStages;
    vi.spyOn(researchOwner, 'researchStages').mockImplementation(rc => shape(rc).map((stage, index) => index === 0 ? { ...stage, role: 'missing_producer_role' } : stage));
    const adapter = proposal(1);
    const { state, directory } = await run(brief(), adapter);
    expect(state.status).toBe('failed'); expect(adapter.calls).toEqual([]);
    expect(researchMeasurementState(directory).revision).toBe(0);
    expect(researchMeasurementState(directory).rounds ?? []).toEqual([]);
  });
  it('reviews candidate properties without applying a campaign numeric gate or requiring terminal prose', async () => {
    const campaignId = 'candidate-properties';
    const storage = resolveCampaignStorageKey({ campaignId, projectDir: project });
    put(`.fc/campaigns/${storage}/contract.json`, JSON.stringify({ metric: 'performance', threshold: 999 }));
    const adapter = proposal(50); const execute = adapter.run.bind(adapter);
    adapter.run = async (prompt, role, opts) => {
      if (opts.stageId === 'review') {
        expect(prompt).toContain('Do not judge measured numbers');
        expect(existsSync(join(project, 'bench/REPORT.md'))).toBe(false);
      }
      return execute(prompt, role, opts);
    };
    const { state, directory } = await run(brief(), adapter, campaignId);
    expect(state.status, state.failureReason).toBe('ceiling_hit');
    expect(researchMeasurementState(directory).rounds?.[0].comparison?.keep).toBe(true);
  });
  it('refuses numeric review metadata instead of letting the reviewer judge performance', async () => {
    const text = brief(); const adapter = new ScriptedAdapter({
      produce: { output: delivered, projectFiles: { 'src/cost.json': '1' } },
      review: { output: JSON.stringify({ ...JSON.parse(verdict()), score: 999, threshold: 1 }) },
    });
    const { state, directory } = await run(text, adapter);
    expect(state.status).toBe('failed'); expect(researchMeasurementState(directory).revision).toBe(0);
    expect(researchMeasurementState(directory).best).toEqual(researchMeasurementState(directory).baseline);
  });
  it('fails a producer failure without measuring a fallback candidate', async () => {
    const text = brief(); const adapter = new ScriptedAdapter({ produce: { exitCode: 1 } });
    const { state, directory } = await run(text, adapter);
    expect(state.status).toBe('failed'); expect(state.reasonCode).toBe('stage_failed');
    expect(adapter.calls.map(c => c.stageId)).toEqual(['produce']);
    expect(researchMeasurementState(directory).revision).toBe(0);
  });
  it('fails calibration exit 2 closed before any producer, even with valid numeric stdout', async () => {
    const text = brief(raw => { raw.research.measurement.development.args.push('bad-argument'); });
    const adapter = proposal(1); const { state, directory } = await run(text, adapter);
    expect(state.status).toBe('failed'); expect(state.failureReason).toContain('Research baseline is unmeasured');
    expect(state.failureReason).toContain('exit 2'); expect(adapter.calls).toEqual([]);
    expect(researchMeasurementState(directory).best.status).toBe('unmeasured');
  });
  it('uses per-item mean of every baseline replicate as the calibration incumbent', async () => {
    const spawn = commandOwner.spawnOwnedCommand; let draws = 0;
    vi.spyOn(commandOwner, 'spawnOwnedCommand').mockImplementation((cmd, args, options) => spawn(cmd, args, {
      ...options, env: { ...options.env, BASELINE_DRAW: String(++draws * 100) },
    }));
    const { state, directory } = await run(brief(), proposal());
    expect(state.status, state.failureReason).toBe('ceiling_hit');
    const measured = researchMeasurementState(directory);
    expect(measured.replicates.map(r => r.items![0].metrics.cost)).toEqual([100, 200]);
    expect(measured.baseline.items![0].metrics.cost).toBe(150);
    expect(measured.best.items![0].metrics.cost).toBe(150);
  });
  it('spends the declared round budget beyond the engineering iteration bound', async () => {
    const text = brief(raw => { raw.research.stop = { max_rounds: 3 }; });
    const adapter = new ScriptedAdapter({ produce: [80, 60, 40].map(cost => ({ output: delivered, projectFiles: { 'src/cost.json': String(cost) } })), review: { output: verdict() } });
    const { state, directory } = await run(text, adapter);
    expect(state.status, state.failureReason).toBe('ceiling_hit'); expect(state.currentIteration).toBe(3);
    expect(researchMeasurementState(directory).rounds?.map(r => r.comparison?.keep)).toEqual([true, true, true]);
    expect(readFileSync(join(project, 'src/cost.json'), 'utf8')).toBe('40');
  });
  it('bounds a long authored measurement timeout by the remaining run wall allowance', async () => {
    const text = brief(raw => { raw.research.measurement.timeout_seconds = 7200; raw.research.stop.max_wall_hours = .000001; });
    const launch = vi.spyOn(commandOwner, 'spawnOwnedCommand');
    const start = Date.now(); const adapter = proposal(1); const { state } = await run(text, adapter);
    expect(parseBriefFrontmatter(text).research?.measurement.timeout_seconds).toBe(7200);
    expect(state.status).toBe('failed'); expect(state.failureReason).toContain('Research baseline is unmeasured');
    expect(adapter.calls).toEqual([]); expect(launch).not.toHaveBeenCalled(); expect(Date.now() - start).toBeLessThan(15000);
  });
  it('refuses an aliased terminal destination without modifying frozen instrument inputs', async () => {
    const text = brief(raw => { raw.terminal_states.ceiling_hit.paths = ['report-alias/new-report.md']; });
    symlinkSync('bench/instrument', join(project, 'report-alias'));
    const before = readFileSync(join(project, 'bench/instrument/evaluate.cjs'), 'utf8');
    const { state, directory } = await run(text, proposal(50));
    expect(state.status).toBe('failed'); expect(state.failureReason).toContain('report publication refused');
    expect(readFileSync(join(project, 'bench/instrument/evaluate.cjs'), 'utf8')).toBe(before);
    expect(existsSync(join(project, 'bench/instrument/new-report.md'))).toBe(false);
    expect(readFileSync(runRecordPath(directory, 'research_report.md'), 'utf8')).toContain('Status: failed');
  });
  it('constructs an admissible independent property review with no terminal owner', () => {
    const rc = parseBriefFrontmatter(brief()).research!; const stages = researchStages(rc);
    expect(admitResearchStages(rc, stages, project, root)).toMatchObject({ pass: true });
    expect(stages.map(s => ({ role: s.role, gate: s.is_gate, dynamic: s.dynamic_dispatch, condition: s.condition })))
      .toEqual([{ role: 'coder', gate: false, dynamic: false, condition: undefined }, { role: 'qa', gate: true, dynamic: false, condition: undefined }]);
  });
});

describe('measurement stop owner', () => {
  it('consumes each retained stop field and held-out spending without inventing a keep', () => {
    const config = parseBriefFrontmatter(brief()).research!;
    const recent = new Date().toISOString();
    const kept = [{ label: 'engine-round', comparison: { keep: true, reason: 'kept', metrics: {} } }];
    expect(researchStopReason({ ...config, stop: { beat: 50, maxRounds: 3 } }, kept, recent, 50)).toBe('target_reached');
    expect(researchStopReason({ ...config, stop: { beat: 50, maxRounds: 3 } }, [], recent, 50)).toBeUndefined();
    expect(researchStopReason({ ...config, stop: { maxRounds: 3, maxWallHours: 1 } }, [], new Date(0).toISOString(), 100)).toBe('wall_budget_exhausted');
    expect(researchStopReason(config, [{ label: 'engine-round', outcome: 'no_candidate' }], recent, 100)).toBe('round_budget_exhausted');
    expect(researchStopReason({ ...config, stop: { maxRounds: 3, haltAfterNoImprovement: 1 } }, [{ label: 'engine-round', outcome: 'review_rejected' }], recent, 100)).toBe('no_improvement_budget_exhausted');
    config.measurement.held_out = { ...config.measurement.development, allowance: 0, pass: { exit_code: 0 } };
    expect(researchStopReason(config, [], recent, 100)).toBe('held_out_allowance_exhausted');
  });
});

describe('honest calibration', () => {
  it('preserves a whole-run shared factor with negligible item noise', () => {
    const noise = calibrateResearchNoise([obs(1), obs(1.2)], metrics).cost;
    // Ordered run-pair ratios are 1.2 and 1/1.2; SD is 0.18333.
    expect(noise).toBeCloseTo((1.2 - 1 / 1.2) / 2, 2);
    expect(noise).toBeGreaterThan(.18);
    const countNoise = calibrateResearchNoise([obs(1), obs(2)], { cost: { direction: 'max', scale: 'count' } }).cost;
    expect(countNoise).toBe(5050); // a shared count shift adds before squaring
  });
  it('permits a fractional count baseline mean while refusing fractional raw candidate counts', () => {
    const config = { cost: { direction: 'max', scale: 'count' } } as const;
    const mean = meanResearchBaseline([{ ...obs(1), items: [{ id: 'a', metrics: { cost: 1 } }] }, { ...obs(1), items: [{ id: 'a', metrics: { cost: 2 } }] }], config);
    expect(mean.items![0].metrics.cost).toBe(1.5);
    const compare = (cost: number) => researchComparison(mean, { ...mean, items: [{ id: 'a', metrics: { cost } }] }, config, ['cost'], { fingerprint: mean.fingerprint, items: ['a'], metrics: { cost: 1 } }, []);
    expect(compare(4).keep).toBe(true); expect(compare(4.25)).toMatchObject({ keep: false, reason: 'input_invalid' });
  });
  it('evaluates the scrubbed four unchanged-tree runs beside observed run-pair SD', () => {
    const rows = JSON.parse(readFileSync(new URL('./fixtures/research-noise-runs.json', import.meta.url), 'utf8'));
    const replicates: Observation[] = rows.map((items: Observation['items']) => ({ status: 'measured', fingerprint: 'instrument', candidate: 'same-tree', items }));
    const totals = replicates.map(r => r.items!.reduce((sum, i) => sum + i.metrics.cost, 0));
    expect(totals).toEqual([113093, 109404, 118014, 103131]);
    const ratios = totals.flatMap((a, n) => totals.filter((_, m) => m !== n).map(b => b / a));
    const mean = ratios.reduce((a, b) => a + b) / ratios.length;
    const observed = Math.sqrt(ratios.reduce((s, n) => s + (n - mean) ** 2, 0) / ratios.length);
    const noise = calibrateResearchNoise(replicates, metrics).cost;
    expect(observed).toBeCloseTo(.0806, 4); expect(noise).toBeGreaterThan(.08); expect(noise).toBeLessThan(.10);
    expect(meanResearchBaseline(replicates.slice(0, 2), metrics).items!.reduce((s, i) => s + i.metrics.cost, 0)).toBe(111248.5);
  });
});

describe('measurement-only migration and rehearsal', () => {
  it.each(['result_file', 'result_schema', 'report_dir', 'integrity', 'confirm', 'min_improvement', 'improvement_se_multiple', 'no_candidate', 'feasibility'])('refuses legacy %s with the migration diagnostic', field => {
    const raw = parse(brief().split('---')[1]); raw.research[field] = field.endsWith('file') ? 'result.json' : {};
    const text = `---\n${stringify(raw)}---\nTask`;
    expect(parseBriefFrontmatter(text).research).toBeUndefined();
    expect(entryWorkflow(parseBriefFrontmatter(text)).error).toContain('declare research.measurement');
    expect(inspectBrief(text).contractReady).toBe(false);
  });
  it('refuses nonliteral roots and report paths overlapping measurement inputs before constructing a shape', () => {
    for (const root of [' ', '../outside', 'src//nested', 'src/./nested']) {
      const text = brief(raw => { raw.research.measurement.candidate = [root]; });
      expect(entryWorkflow(parseBriefFrontmatter(text)).error).toBeDefined();
    }
    const text = brief(raw => { raw.terminal_states.ceiling_hit.paths = ['bench/instrument/result.md']; });
    expect(entryWorkflow(parseBriefFrontmatter(text)).error).toContain('outside frozen and candidate roots');
  });
  it('refuses shadow legacy fields in a duplicate objective declaration', () => {
    const text = brief(raw => { raw.objective = { result_file: 'retired.json' }; });
    expect(entryWorkflow(parseBriefFrontmatter(text)).error).toContain('declare research.measurement');
    expect(parseBriefFrontmatter(text).research).toBeUndefined();
  });
  it('refuses a research block without measurement and nested legacy margins', () => {
    for (const research of [null, { baseline: 1 }, {}, { stop: { max_rounds: 1 } }]) {
      const parsed = parseBriefFrontmatter(`---\n${stringify({ research })}---\nTask`);
      expect(parsed.workflowError).toContain('declare research.measurement');
    }
    const text = brief(raw => { raw.research.stop.min_improvement = .01; });
    expect(parseBriefFrontmatter(text).workflowError).toContain('declare research.measurement');
  });
  it.each(['tracked example', 'archived shape'])('rehearses the constructed producer/reviewer shape: %s', async which => {
    const text = which === 'tracked example' ? readFileSync(new URL('../examples/research-instrument.brief.md', import.meta.url), 'utf8') : brief();
    const result = await rehearseBrief(['fixture.md'], { briefText: text, render: false, projectDir: project });
    expect(result.exitCode, JSON.stringify(result.findings)).toBe(0); expect(result.simulated).toBe(true);
    expect(result.findings.some(f => f.text.includes('produce → review'))).toBe(true);
  });
  it('fails rehearsal when the constructed shape cannot dispatch a producer', async () => {
    const original = researchOwner.researchStages;
    vi.spyOn(researchOwner, 'researchStages').mockImplementation(rc => original(rc).map(s => ({ ...s, depends_on: [s.id] })));
    const result = await rehearseBrief(['fixture.md'], { briefText: brief(), render: false, projectDir: project });
    expect(result.exitCode).toBe(1); expect(result.simulated).toBe(false);
    expect(result.findings.some(f => f.level === 'fail' && f.text.includes('real research shape'))).toBe(true);
  });
  it('fails rehearsal when its declared budget prevents any producer dispatch', async () => {
    const text = brief(raw => { raw.research.measurement.held_out = { ...raw.research.measurement.development, allowance: 0, pass: { exit_code: 0 } }; });
    const result = await rehearseBrief(['fixture.md'], { briefText: text, render: false, projectDir: project });
    expect(result.exitCode).toBe(1); expect(result.simulated).toBe(false);
    expect(result.findings.some(f => f.level === 'fail' && f.text.includes('held_out_allowance_exhausted'))).toBe(true);
  });

});


describe('research settlement boundaries', () => {
  it.each(['shipped', 'ceiling_hit', 'failed', 'incomplete', 'cancelled'] as const)('recovers missing projections of committed %s state idempotently', async status => {
    const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
    const state = readRunState(project, created.runId);
    state.research = parseBriefFrontmatter(brief()).research;
    state.terminalStates = { [status]: { paths: ['bench/REPORT.md'] } };
    writeRunState(project, created.runId, state);
    vi.spyOn(storeOwner, 'evaluateRealityGate').mockResolvedValue(state);
    const write = engineFiles.atomicWrite;
    let interrupted = false;
    const fault = vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      const result = write(path, data, options);
      if (!interrupted && String(path).endsWith('/run.json') && JSON.parse(String(data)).status === status) {
        interrupted = true; throw new Error('Terminal commit published without acknowledgement');
      }
      return result;
    });
    await expect(Promise.resolve().then(() => concludeRun(state, { status, reasonCode: 'research_ceiling' })))
      .rejects.toThrow('Terminal commit published without acknowledgement');
    fault.mockRestore();
    expect(interrupted).toBe(true);
    const before = readRunState(project, state.runId);
    expect(before.status).toBe(status); expect(before.terminalArtifact).toBeUndefined();
    const engine = runRecordPath(created.runDirPath, 'research_report.md');
    expect(existsSync(engine)).toBe(false);
    expect(existsSync(join(project, 'bench/REPORT.md'))).toBe(false);
    expect(readRunEvents(project, state.runId).filter(event => event.type === 'run_completed')).toEqual([]);
    const recovered = reconcileHostInterruptedRun(project, state.runId);
    expect(recovered.status).toBe(status);
    expect(recovered.completedAt).toBe(before.completedAt);
    expect(recovered.terminalArtifact).toBe('bench/REPORT.md');
    const body = readFileSync(engine, 'utf8');
    expect(body).toContain('Status: ' + status);
    expect(readFileSync(join(project, recovered.terminalArtifact!), 'utf8')).toBe(body);
    const raw = readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8');
    const mtime = statSync(engine).mtimeMs;
    const publications = vi.spyOn(engineFiles, 'atomicWrite');
    reconcileHostInterruptedRun(project, state.runId);
    storeOwner.updateOperationalRunState(created.runDirPath, () => {}, undefined, projectResearchConclusion);
    expect(readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8')).toBe(raw);
    expect(statSync(engine).mtimeMs).toBe(mtime);
    expect(publications.mock.calls.some(([path]) => path === engine || path === join(project, 'bench/REPORT.md'))).toBe(false);
    expect(readRunEvents(project, state.runId).filter(event => event.type === 'run_completed'))
      .toMatchObject([{ timestamp: before.completedAt, runStatus: status }]);
    expect(readRunEvents(project, state.runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
  });
  it.each(['reports', 'pointer', 'event', 'all'])('startup re-derives missing %s from a terminal journal', async missing => {
    const { state, directory } = await run(brief(), proposal(50));
    const body = readFileSync(runRecordPath(directory, 'research_report.md'), 'utf8');
    if (missing === 'reports' || missing === 'all') {
      rmSync(runRecordPath(directory, 'research_report.md'));
      rmSync(join(project, 'bench/REPORT.md'));
    }
    if (missing === 'event' || missing === 'all') rmSync(runRecordPath(directory, 'events.jsonl'));
    if (missing === 'pointer' || missing === 'all') { delete state.terminalArtifact; writeRunState(project, state.runId, state); }
    const registry = new TaskRegistry({ baseDir: join(root, 'registry') });
    const warn = vi.fn();
    const sweep = createDaemonReconciler(registry, warn);
    sweep(); sweep();
    expect(warn).not.toHaveBeenCalled();
    expect(readRunState(project, state.runId)).toMatchObject({ status: 'ceiling_hit', terminalArtifact: 'bench/REPORT.md' });
    expect(readFileSync(runRecordPath(directory, 'research_report.md'), 'utf8')).toBe(body);
    expect(readFileSync(join(project, 'bench/REPORT.md'), 'utf8')).toBe(body);
    expect(readRunEvents(project, state.runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
  });
  it.each(['completion storage failure', 'lost terminal acknowledgement'] as const)(
    'startup preserves a later publisher after %s', async fault => {
      const text = brief();
      const research = parseBriefFrontmatter(text).research!;
      const stages = researchStages(research);
      const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/research.yaml'));
      config.stages = stages;
      const first = createRun(project, 'research', stringify(config), stages.map(stage => stage.id));
      const initial = readRunState(project, first.runId);
      initial.research = research; initial.currentIteration = 1;
      initial.terminalStates = { ceiling_hit: { paths: ['bench/REPORT.md'] } };
      writeRunState(project, first.runId, initial);
      const write = engineFiles.atomicWrite;
      const record = eventOwner.recordRunEvent;
      let interrupted = 0;
      const injection = fault === 'completion storage failure'
        ? vi.spyOn(eventOwner, 'recordRunEvent').mockImplementation((projectDir, runId, event) => {
          if (runId === first.runId && event.type === 'run_completed') {
            interrupted++; throw new Error('Temporary completion-event storage failure');
          }
          return record(projectDir, runId, event);
        })
        : vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
          const result = write(path, data, options);
          if (!interrupted && path === runRecordPath(first.runDirPath, 'run.json') && JSON.parse(String(data)).status === 'ceiling_hit') {
            interrupted++; throw new Error('Lost terminal-commit acknowledgement');
          }
          return result;
        });
      await expect(runResearchLoop(project, first.runId, first.runDirPath, config, proposal(50), new Map(), agents, undefined, text))
        .rejects.toThrow(fault === 'completion storage failure' ? 'Temporary completion-event storage failure' : 'Lost terminal-commit acknowledgement');
      injection.mockRestore();
      expect(interrupted).toBe(1);
      expect(researchMeasurementState(first.runDirPath).best.items?.[0].metrics.cost).toBe(50);
      expect(readRunEvents(project, first.runId).filter(event => event.type === 'run_completed')).toHaveLength(0);
      const second = await run(brief(), proposal(25));
      const newerBody = readFileSync(runRecordPath(second.directory, 'research_report.md'), 'utf8');
      expect(researchMeasurementState(second.directory).best.items?.[0].metrics.cost).toBe(25);
      expect(readFileSync(join(project, 'bench/REPORT.md'), 'utf8')).toBe(newerBody);
      const warn = vi.fn();
      const sweep = createDaemonReconciler(new TaskRegistry({ baseDir: join(root, 'registry') }), warn);
      sweep(); sweep();
      const after = readFileSync(join(project, 'bench/REPORT.md'), 'utf8');
      expect(after).toBe(newerBody);
      for (const [runId, directory, cost] of [[first.runId, first.runDirPath, 50], [second.state.runId, second.directory, 25]] as const) {
        const recovered = readRunState(project, runId);
        const ownBody = readFileSync(runRecordPath(directory, 'research_report.md'), 'utf8');
        expect(ownBody).toContain('"cost": ' + cost);
        expect(readFileSync(join(project, recovered.terminalArtifact!), 'utf8')).toBe(ownBody);
        expect(readRunEvents(project, runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
      }
      const skipped = readRunEvents(project, first.runId).filter(event => event.type === 'research_report_superseded');
      expect(skipped).toMatchObject([{ level: 'warning', files: ['bench/REPORT.md'], ownerRunId: second.state.runId }]);
      expect(skipped).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      const raw = readFileSync(runRecordPath(first.runDirPath, 'run.json'), 'utf8');
      reconcileHostInterruptedRun(project, first.runId);
      expect(readFileSync(runRecordPath(first.runDirPath, 'run.json'), 'utf8')).toBe(raw);
      expect(readRunEvents(project, first.runId).filter(event => event.type === 'research_report_superseded')).toHaveLength(1);
    },
  );
  it('uses committed terminal order across global addressing, clock rollback and repeated recovery', () => {
    const research = parseBriefFrontmatter(brief()).research!;
    const created = Array.from({ length: 4 }, () => createRun(project, 'research', 'name: research\nstages: []\n', []));
    const commit = (index: number, completedAt: string) => storeOwner.updateRunState('', created[index].runId, state => {
      state.research = research;
      state.status = 'ceiling_hit'; state.completedAt = completedAt; state.reasonCode = 'research_ceiling';
      state.failureReason = 'Publisher ' + index;
      const paths = index === 3 ? ['bench/OTHER.md'] : index === 1 ? ['bench/REPORT.md', 'bench/FIRST.md'] : ['bench/REPORT.md'];
      state.terminalStates = { ceiling_hit: { paths } };
      state.researchReportPaths = paths;
    });
    const first = commit(1, '2030-01-01T00:00:00.000Z');
    reconcileHostInterruptedRun(project, first.runId);
    const middle = commit(0, '2020-01-01T00:00:00.000Z');
    reconcileHostInterruptedRun(project, middle.runId);
    const latest = commit(2, '2010-01-01T00:00:00.000Z');
    reconcileHostInterruptedRun(project, latest.runId);
    expect(first.researchReportSequence).toBe(1);
    expect(middle.researchReportSequence).toBe(2);
    expect(latest.researchReportSequence).toBe(3);
    const unrelated = commit(3, '2005-01-01T00:00:00.000Z');
    reconcileHostInterruptedRun(project, unrelated.runId);
    expect(unrelated.researchReportSequence).toBe(4);
    const body = readFileSync(join(project, 'bench/REPORT.md'), 'utf8');
    rmSync(runRecordPath(created[1].runDirPath, 'research_report.md'));
    rmSync(runRecordPath(created[1].runDirPath, 'events.jsonl'));
    const recovered = reconcileHostInterruptedRun(project, first.runId);
    expect(readFileSync(join(project, 'bench/REPORT.md'), 'utf8')).toBe(body);
    expect(readFileSync(join(project, recovered.terminalArtifact!), 'utf8')).toContain('Publisher 1');
    expect(recovered.terminalArtifact).toBe('bench/FIRST.md');
    expect(readRunEvents(project, first.runId).filter(event => event.type === 'research_report_superseded'))
      .toMatchObject([{ files: ['bench/REPORT.md'], ownerRunId: latest.runId }]);
    expect(recovered.researchReportSequence).toBe(first.researchReportSequence);
    storeOwner.updateOperationalRunState(created[1].runDirPath, () => {}, undefined, projectResearchConclusion);
    expect(readRunEvents(project, first.runId).filter(event => event.type === 'research_report_superseded')).toHaveLength(1);
    expect(readRunState(project, first.runId).researchReportSequence).toBe(1);
    storeOwner.updateRunState(project, latest.runId, state => { state.status = 'running'; });
    expect(readRunState(project, latest.runId).researchReportSequence).toBeUndefined();
    const resumed = commit(2, '2000-01-01T00:00:00.000Z');
    expect(resumed.researchReportSequence).toBeGreaterThan(middle.researchReportSequence!);
  });
  it('preserves a shared historical destination when committed order is unavailable', async () => {
    const first = await run(brief(), proposal(50));
    const second = await run(brief(), proposal(25));
    const newerBody = readFileSync(join(project, 'bench/REPORT.md'), 'utf8');
    for (const run of [first, second]) {
      const path = runRecordPath(run.directory, 'run.json');
      const record = JSON.parse(readFileSync(path, 'utf8'));
      delete record.researchReportSequence; // Pre-upgrade committed records have no order.
      writeFileSync(path, JSON.stringify(record));
    }
    rmSync(runRecordPath(first.directory, 'research_report.md'));
    rmSync(runRecordPath(first.directory, 'events.jsonl'));
    const recovered = reconcileHostInterruptedRun(project, first.state.runId);
    expect(readFileSync(join(project, 'bench/REPORT.md'), 'utf8')).toBe(newerBody);
    const own = readFileSync(runRecordPath(first.directory, 'research_report.md'), 'utf8');
    expect(own).toContain('"cost": 50');
    expect(readFileSync(join(project, recovered.terminalArtifact!), 'utf8')).toBe(own);
    expect(recovered.researchReportSequence).toBeUndefined();
    const warning = readRunEvents(project, first.state.runId).find(event => event.type === 'research_report_superseded');
    expect(warning).toMatchObject({ level: 'warning', files: ['bench/REPORT.md'] });
    expect(warning?.ownerRunId).toBeUndefined();
    expect(warning?.detail).toContain(second.state.runId);
    expect(warning?.detail).toContain('unknown');
    storeOwner.updateOperationalRunState(first.directory, () => {}, undefined, projectResearchConclusion);
    expect(readRunEvents(project, first.state.runId).filter(event => event.type === 'research_report_superseded')).toHaveLength(1);
    // With no competing intent, legacy recovery still restores the shared report.
    const secondPath = runRecordPath(second.directory, 'run.json');
    const other = JSON.parse(readFileSync(secondPath, 'utf8'));
    other.researchReportPaths = [];
    writeFileSync(secondPath, JSON.stringify(other));
    storeOwner.updateOperationalRunState(first.directory, () => {}, undefined, projectResearchConclusion);
    expect(readFileSync(join(project, 'bench/REPORT.md'), 'utf8')).toBe(own);
    expect(readRunState(project, first.state.runId).terminalArtifact).toBe('bench/REPORT.md');
  });
  it('preserves a later report published through an in-project directory alias', async () => {
    const first = await run(brief(), proposal(50));
    symlinkSync('bench', join(project, 'report-alias'));
    const second = await run(brief(raw => { raw.terminal_states.ceiling_hit.paths = ['report-alias/REPORT.md']; }), proposal(25));
    const newerBody = readFileSync(runRecordPath(second.directory, 'research_report.md'), 'utf8');
    rmSync(runRecordPath(first.directory, 'events.jsonl'));
    const recovered = reconcileHostInterruptedRun(project, first.state.runId);
    expect(readFileSync(join(project, 'bench/REPORT.md'), 'utf8')).toBe(newerBody);
    expect(readFileSync(join(project, recovered.terminalArtifact!), 'utf8')).toContain('"cost": 50');
    expect(readRunEvents(project, first.state.runId).filter(event => event.type === 'research_report_superseded'))
      .toMatchObject([{ files: ['bench/REPORT.md'], ownerRunId: second.state.runId }]);
  });
  it('startup leaves complete historical projections and a later shared project report unchanged', async () => {
    const first = await run(brief(), proposal(50));
    const firstBody = readFileSync(runRecordPath(first.directory, 'research_report.md'), 'utf8');
    const second = await run(brief(), proposal(25));
    const secondBody = readFileSync(runRecordPath(second.directory, 'research_report.md'), 'utf8');
    expect(firstBody).not.toBe(secondBody);
    const firstRaw = readFileSync(runRecordPath(first.directory, 'run.json'), 'utf8');
    const secondRaw = readFileSync(runRecordPath(second.directory, 'run.json'), 'utf8');
    const sweep = createDaemonReconciler(new TaskRegistry({ baseDir: join(root, 'registry') }), vi.fn());
    const writes = vi.spyOn(engineFiles, 'atomicWrite');
    sweep(); sweep();
    expect(readFileSync(join(project, 'bench/REPORT.md'), 'utf8')).toBe(secondBody);
    expect(readFileSync(runRecordPath(first.directory, 'research_report.md'), 'utf8')).toBe(firstBody);
    expect(readFileSync(runRecordPath(first.directory, 'run.json'), 'utf8')).toBe(firstRaw);
    expect(readFileSync(runRecordPath(second.directory, 'run.json'), 'utf8')).toBe(secondRaw);
    expect(writes).not.toHaveBeenCalled();
  });
  it('reprojects a committed cancellation after its acknowledgement fails', () => {
    const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
    const state = readRunState(project, created.runId);
    state.research = parseBriefFrontmatter(brief()).research;
    state.terminalStates = { cancelled: { paths: ['cancelled.md'] } };
    writeRunState(project, created.runId, state);
    const write = engineFiles.atomicWrite;
    let interrupted = false;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      const result = write(path, data, options);
      if (!interrupted && String(path).endsWith('/run.json') && JSON.parse(String(data)).status === 'cancelled') {
        interrupted = true; throw new Error('One-shot cancellation acknowledgement refused');
      }
      return result;
    });
    expect(() => cancelRunStateAtPath(created.runDirPath, new Date().toISOString())).toThrow('One-shot cancellation acknowledgement refused');
    const result = reconcileHostInterruptedRun(project, created.runId);
    expect(interrupted).toBe(true); expect(result.status).toBe('cancelled');
    expect(readRunState(project, created.runId).terminalArtifact).toBe('cancelled.md');
    expect(readFileSync(join(project, 'cancelled.md'), 'utf8')).toContain('Status: cancelled');
    expect(readRunEvents(project, created.runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
  });
  it('propagates persistent commit acknowledgement failures without running after-commit work', () => {
    const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
    const write = engineFiles.atomicWrite;
    let writes = 0;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      const result = write(path, data, options);
      if (String(path).endsWith('/run.json')) { writes++; throw new Error('Persistent durability acknowledgement failure'); }
      return result;
    });
    const afterCommit = vi.fn();
    expect(() => storeOwner.updateRunState(project, created.runId, state => { state.status = 'incomplete'; }, afterCommit))
      .toThrow('Persistent durability acknowledgement failure');
    expect(writes).toBe(1); expect(afterCommit).not.toHaveBeenCalled();
  });
  it.each(['terminal', 'pointer'] as const)('reprojects a visible %s commit after its acknowledgement fails', async boundary => {
    const reportPath = 'bench/REPORT.md';
    const text = brief(raw => {
      raw.research.stop.beat = 75;
      raw.terminal_states = { shipped: { paths: [reportPath] }, failed: { paths: ['failed.md'] } };
    });
    const write = engineFiles.atomicWrite;
    let published = false, interrupted = false, publications = 0;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      const targeted = String(path).endsWith('/run.json') && JSON.parse(String(data)).status === 'shipped'
        && (boundary === 'terminal' ? !published : published);
      const result = write(path, data, options);
      if (path === join(project, reportPath)) { published = true; publications++; }
      if (targeted) {
        if (!interrupted) { interrupted = true; throw new Error('One-shot post-publication acknowledgement refused'); }
      }
      return result;
    });
    const { state, directory } = await run(text, proposal(50));
    const durable = readRunState(project, state.runId);
    expect(interrupted).toBe(true);
    expect(state.status, state.failureReason).toBe('shipped'); expect(durable.status).toBe('shipped');
    expect(durable.terminalArtifact).toBe(reportPath); expect(publications).toBe(1);
    const report = readFileSync(runRecordPath(directory, 'research_report.md'), 'utf8');
    expect(report).toContain('Status: shipped');
    expect(readFileSync(join(project, reportPath), 'utf8')).toBe(report);
    expect(existsSync(join(project, 'failed.md'))).toBe(false);
    expect(readRunEvents(project, state.runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
    expect(reconcileHostInterruptedRun(project, state.runId, { assertSchedulerAbsent: () => {} })).toEqual(durable);
    expect(readRunEvents(project, state.runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
  });
  it('never exposes a provisional report or saves a running publication acknowledgement', async () => {
    const reportPath = 'bench/REPORT.md';
    const text = brief(raw => {
      raw.research.stop.beat = 75;
      raw.terminal_states = { shipped: { paths: [reportPath] }, failed: { paths: ['failed.md'] } };
    });
    const write = engineFiles.atomicWrite;
    let published = false, interrupted = false;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      if (published && !interrupted && String(path).endsWith('/run.json')) {
        const record = JSON.parse(String(data));
        if (record.status === 'running' && record.researchReportPaths?.includes(reportPath)) {
          interrupted = true;
          throw new Error('One-shot run projection commit refused');
        }
      }
      const result = write(path, data, options);
      if (path === join(project, reportPath)) published = true;
      return result;
    });
    const { state, directory } = await run(text, proposal(50));
    expect(interrupted).toBe(false);
    expect(state.status).toBe('shipped');
    expect(state.terminalArtifact).toBe(reportPath);
    const report = readFileSync(runRecordPath(directory, 'research_report.md'), 'utf8');
    expect(report).toContain('Status: shipped');
    expect(readFileSync(join(project, reportPath), 'utf8')).toBe(report);
    expect(existsSync(join(project, 'failed.md'))).toBe(false);
    expect(readRunState(project, state.runId).researchReportPaths).toContain(reportPath);
  });
  it.each(['terminal', 'pointer'] as const)('keeps reports truthful across a one-shot %s state-commit failure', async boundary => {
    const reportPath = 'bench/REPORT.md';
    const text = brief(raw => {
      raw.research.stop.beat = 75;
      raw.terminal_states = { shipped: { paths: [reportPath] }, failed: { paths: ['failed.md'] } };
    });
    const write = engineFiles.atomicWrite;
    let published = false, interrupted = false;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      if (!interrupted && String(path).endsWith('/run.json')) {
        const record = JSON.parse(String(data));
        if (record.status === 'shipped' && (boundary === 'terminal' ? !published : published)) {
          interrupted = true; throw new Error('One-shot final state commit refused');
        }
      }
      const result = write(path, data, options);
      if (path === join(project, reportPath)) published = true;
      return result;
    });
    const { state, directory } = await run(text, proposal(50));
    expect(interrupted).toBe(true); expect(state.status).toBe(boundary === 'terminal' ? 'failed' : 'shipped');
    if (boundary === 'terminal') expect(state.failureReason).toContain('One-shot final state commit refused');
    expect(state.terminalArtifact).toBe(boundary === 'terminal' ? 'failed.md' : reportPath);
    const report = readFileSync(runRecordPath(directory, 'research_report.md'), 'utf8');
    expect(report).toContain('Status: ' + state.status);
    expect(readFileSync(join(project, state.terminalArtifact!), 'utf8')).toBe(report);
    if (boundary === 'pointer') expect(readFileSync(join(project, reportPath), 'utf8')).toBe(report);
    else expect(existsSync(join(project, reportPath))).toBe(false);
    expect(readRunEvents(project, state.runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
  });
  it('publishes each normal report once and only from durably committed terminal state', async () => {
    const text = brief(raw => { raw.research.stop.beat = 75; raw.terminal_states = { shipped: { paths: ['bench/REPORT.md'] } }; });
    const write = engineFiles.atomicWrite;
    let committedStatus: string | undefined;
    const publications: Array<{ status?: string; body: string }> = [];
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      const result = write(path, data, options);
      if (String(path).endsWith('/run.json')) committedStatus = JSON.parse(String(data)).status;
      if (path === join(project, 'bench/REPORT.md')) {
        publications.push({ status: committedStatus, body: String(data) });
      }
      return result;
    });
    const { state } = await run(text, proposal(50));
    expect(state.status, state.failureReason).toBe('shipped');
    expect(publications).toHaveLength(1);
    expect(publications[0].status).toBe('shipped');
    expect(publications[0].body).toContain('Status: shipped');
    expect(publications[0].body).not.toContain('pending');
  });
  it('rejects a candidate after reality failure without leaving a shipped-labelled project report', async () => {
    const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
    const state = readRunState(project, created.runId);
    state.research = parseBriefFrontmatter(brief()).research;
    state.terminalStates = { shipped: {paths:['success.md']}, reality_gate_failed: {paths:['failure.md']} };
    writeRunState(project, created.runId, state);
    vi.spyOn(storeOwner, 'evaluateRealityGate').mockResolvedValue({...state, status:'reality_gate_failed',failureReason:'Independent check rejected',realityGate:{pass:false,checks:[]} } as any);
    const result = await concludeRun(state, {status:'shipped',reasonCode:'research_shipped',detail:'target_reached'});
    expect(result.status).toBe('reality_gate_failed');
    expect(result.terminalArtifact).toBe('failure.md');
    expect(readFileSync(join(project, 'failure.md'), 'utf8')).toContain('Status: reality_gate_failed');
    expect(existsSync(join(project, 'success.md'))).toBe(false);
  });
  it('partial report publication does not leave a success report or success pointer', async () => {
    const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
    const state = readRunState(project, created.runId);
    state.research = parseBriefFrontmatter(brief()).research;
    state.terminalStates = { ceiling_hit: {paths:['ceiling.md','blocked/report.md']}, failed:{paths:['failed.md']} };
    put('blocked', 'a file blocks the parent directory');
    writeRunState(project, created.runId, state);
    vi.spyOn(storeOwner, 'evaluateRealityGate').mockResolvedValue(state);
    const result = await concludeRun(state, {status:'ceiling_hit',reasonCode:'research_ceiling',detail:'round_budget_exhausted'});
    expect(result.status).toBe('failed');
    expect(readFileSync(join(project,'ceiling.md'),'utf8')).toContain('Status: failed');
    expect(result.terminalArtifact).toBe('failed.md');
    expect(readFileSync(join(project, 'failed.md'), 'utf8')).toContain('Status: failed');
    const raw = readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8');
    const writes = vi.spyOn(engineFiles, 'atomicWrite');
    reconcileHostInterruptedRun(project, created.runId);
    expect(readFileSync(runRecordPath(created.runDirPath, 'run.json'), 'utf8')).toBe(raw);
    expect(writes).not.toHaveBeenCalled();
    expect(readRunEvents(project, created.runId).filter(event => event.type === 'run_completed')).toHaveLength(1);
  });
  it.each(['ceiling_hit', 'incomplete'] as const)('finalizes a report published before its durability acknowledgement fails %s', async status => {
    const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
    const state = readRunState(project, created.runId);
    state.research = parseBriefFrontmatter(brief()).research;
    state.terminalStates = { [status]: { paths: ['ceiling.md'] }, failed: { paths: ['failed.md'] } };
    writeRunState(project, created.runId, state);
    const write = engineFiles.atomicWrite;
    let injected = false;
    vi.spyOn(engineFiles, 'atomicWrite').mockImplementation((path, data, options) => {
      const result = write(path, data, options);
      if (path === join(project, 'ceiling.md') && !injected) { injected = true; throw new Error('Durability acknowledgement failed after publication'); }
      return result;
    });
    const result = await concludeRun(state, { status, reasonCode: 'research_ceiling' });
    expect(result.status).toBe('failed');
    expect(result.terminalArtifact).toBe('failed.md');
    expect(readFileSync(join(project, 'ceiling.md'), 'utf8')).toContain('Status: failed');
  });
  it('a long accepted timeout bounded by a long finite wall budget permits calibration', async () => {
    const text = brief(raw => { raw.research.measurement.timeout_seconds = 3000000; raw.research.stop.max_wall_hours = 1000; });
    const adapter = proposal(50); const {state,directory} = await run(text,adapter);
    expect(state.status, state.failureReason).toBe('ceiling_hit');
    expect(researchMeasurementState(directory).replicates.every(observation => observation.status === 'measured')).toBe(true);
    expect(adapter.calls.map(call => call.stageId)).toEqual(['produce', 'review']);
  });
  it('resumes a continuing producer rather than measuring unfinished bytes',async()=>{
   const text=brief();const rc=parseBriefFrontmatter(text).research!;const stages=researchStages(rc);
   const {config,raw}=loadWorkflow(join(import.meta.dirname,'../config/workflows/research.yaml'));config.stages=stages;
   const created=createRun(project,'research',stringify(config),stages.map(s=>s.id));
   await initializeResearchMeasurements(project,created.runDirPath,rc.measurement);
   const state=readRunState(project,created.runId);state.research=rc;state.currentIteration=1;
   const handoff={reason:'stage_budget' as const,forced:false,handoff:'stages/produce/output_attempt_1.md'};
   state.stages.produce={status:'complete',retries:0,continuation:handoff};
   writeStageStatus(project,created.runId,'produce',state.stages.produce);
   writeStageOutput(project,created.runId,'produce',JSON.stringify({...JSON.parse(delivered),remaining_work:['The candidate is unfinished.']}));
   writeRunState(project,created.runId,state);put('src/cost.json','50');
   const adapter=proposal(25);
   const settled=await runResearchLoop(project,created.runId,created.runDirPath,config,adapter,new Map(),agents,undefined,text);
   const measured=researchMeasurementState(created.runDirPath);
   expect(adapter.calls.map(c=>c.stageId)).toContain('produce');expect(measured.best.items?.[0].metrics.cost).toBe(25);
  });
  it('finishes a retained independent review before accepting the submission', async () => {
    const text = brief(); const research = parseBriefFrontmatter(text).research!;
    const stages = researchStages(research);
    const { config } = loadWorkflow(join(import.meta.dirname, '../config/workflows/research.yaml'));
    config.stages = stages;
    const created = createRun(project, 'research', stringify(config), stages.map(stage => stage.id));
    await initializeResearchMeasurements(project, created.runDirPath, research.measurement);
    const state = readRunState(project, created.runId);
    state.research = research; state.currentIteration = 1;
    state.stages.produce = { status: 'complete', retries: 0 };
    state.stages.review = { status: 'complete', retries: 0, continuation: { reason: 'stage_budget', forced: false, handoff: 'unfinished review' } };
    for (const stage of stages) writeStageStatus(project, created.runId, stage.id, state.stages[stage.id]);
    writeStageOutput(project, created.runId, 'produce', delivered);
    writeStageOutput(project, created.runId, 'review', verdict());
    writeFileSync(runRecordPath(created.runDirPath, 'verdict_review.json'), verdict());
    writeRunState(project, created.runId, state);
    put('src/cost.json', '50');
    const adapter = proposal(undefined, false);
    const result = await runResearchLoop(project, created.runId, created.runDirPath, config, adapter, new Map(), agents, undefined, text);
    expect(result.status).toBe('ceiling_hit');
    expect(adapter.calls.map(call => call.stageId)).toEqual(['review']);
    const measured = researchMeasurementState(created.runDirPath);
    expect(measured.rounds).toMatchObject([{ outcome: 'review_rejected', review: { pass: false } }]);
    expect(measured.best.items?.[0].metrics.cost).toBe(100);
    expect(measured.revision).toBe(0);
  });
  it('cancellation during measurement leaves a cancelled report consistent with the final journal',async()=>{
   const text=brief();const adapter=proposal(50);const perform=adapter.run.bind(adapter);let activeRun='';adapter.run=async(prompt,role,opts)=>{activeRun=opts.runDir;return perform(prompt,role,opts);};
   const launch=commandOwner.spawnOwnedCommand;let n=0;
   vi.spyOn(commandOwner,'spawnOwnedCommand').mockImplementation((cmd,args,options)=>{
     const child=launch(cmd,args,options);if(++n===3){cancelRunStateAtPath(activeRun,new Date().toISOString());child.stop();}return child;
   });
   const {state,directory}=await run(text,adapter);const report=readFileSync(runRecordPath(directory,'research_report.md'),'utf8');const measured=researchMeasurementState(directory);
   expect(state.status).toBe('cancelled');expect(report).toContain('Status: cancelled');
   expect(readRunState(project, state.runId).status).toBe('cancelled');
   expect(report).not.toContain('Status: ceiling_hit');
   if(measured.rounds?.length)expect(report).toContain('## round-1');
  });
  function manualClock() {
    let elapsed = 0;
    const started = Date.now();
    const timers = new Map<ReturnType<typeof setTimeout>, {
      at: number;
      callback: () => void;
    }>();
    const clock: AttemptDeadlineClock = { monotonicNow: () => elapsed, wallNow: () => started + elapsed,
      setTimer(callback, delay) { const timer = {} as ReturnType<typeof setTimeout>; timers.set(timer, { at: elapsed + delay, callback }); return timer; },
      clearTimer(timer) { timers.delete(timer); } };
    return { clock, timers, advanceTo(value: number) {
        elapsed = value;
        for (const [timer, entry] of [...timers])
          if (entry.at <= elapsed) {
            timers.delete(timer);
            entry.callback();
          }
      } };
  }
  it('continuing research producer completes the same submission before review and measurement', async () => {
    setEngineDefaults({ default_timeout_ms: 20000, max_iterations:3,max_retries:0,stage_technical_retries:0,gate_retry_loops:0 });
    const text = brief(raw=>{raw.research.stop = { max_rounds: 3, halt_after_no_improvement: 1 };});
    let time = manualClock(); const calls:string[]=[];
    const adapter: Adapter = {async run(prompt,role,opts) {
      calls.push(`${opts.stageId}:${opts.attemptIndex}:${prompt.includes('# Stage budget wrap-up')?'wrap':'ordinary'}`);
      if (opts.stageId==='produce' && opts.attemptIndex===1) {
        if (!prompt.includes('# Stage budget wrap-up')) {
          put('src/cost.json','80');
          time.advanceTo(stageWrapUpTiming(20000).warningAfterMs);
          return {exitCode:137,output:'Closed at warning.',duration_ms:1};
        }
        return {exitCode:0,duration_ms:1,output:JSON.stringify({...JSON.parse(delivered),remaining_work:['Complete the candidate and its checks.']})};
      }
      if (opts.stageId==='produce') put('src/cost.json','50');
      return {exitCode:0,duration_ms:1,output:opts.stageId==='review'?verdict():delivered};
    }};
    const {config,raw}=loadWorkflow(join(import.meta.dirname,'../config/workflows/entry.yaml'));
    const state=await runWorkflow(config,raw,project,adapter,new Map(),undefined,agents,undefined,text,true,undefined,true,undefined,()=>{time=manualClock();return time.clock;});
    const directory=runDir(project,state.runId);
    expect(state.status).toBe('ceiling_hit');
    expect(calls.slice(0, 4)).toEqual(['produce:1:ordinary', 'produce:1:wrap', 'produce:2:ordinary', 'review:1:ordinary']);
    expect(researchMeasurementState(directory).rounds?.[0].measurement?.items?.[0].metrics.cost).toBe(50);
    expect(researchMeasurementState(directory).rounds?.[0].comparison?.keep).toBe(true);
    expect(state.stages.produce.attempts?.[0].continuation).toBeDefined();
  });
  it('exhausts a declared continuation allowance without measuring or discarding unfinished work', async () => {
    setEngineDefaults({ default_timeout_ms: 20000, max_iterations: 3, max_retries: 0, stage_technical_retries: 0 });
    const text = brief(raw => { raw.max_continuations = 0; raw.research.stop.max_rounds = 3; });
    let time = manualClock();
    const calls: string[] = [];
    const adapter: Adapter = { async run(prompt, _role, opts) {
      calls.push(opts.stageId);
      if (!prompt.includes('# Stage budget wrap-up')) {
        put('src/cost.json', '80');
        time.advanceTo(stageWrapUpTiming(20000).warningAfterMs);
        return { exitCode: 137, output: 'warning', duration_ms: 1 };
      }
      return { exitCode: 0, duration_ms: 1, output: JSON.stringify({ ...JSON.parse(delivered), remaining_work: ['Candidate unfinished.'] }) };
    } };
    const { config, raw } = loadWorkflow(join(import.meta.dirname, '../config/workflows/entry.yaml'));
    const state = await runWorkflow(config, raw, project, adapter, new Map(), undefined, agents, undefined, text,
      true, undefined, true, undefined, () => { time = manualClock(); return time.clock; });
    expect(state.status).toBe('incomplete');
    expect(state.reasonCode).toBe('bounded_attempts');
    expect(calls).toEqual(['produce', 'produce']);
    expect(readFileSync(join(project, 'src/cost.json'), 'utf8')).toBe('80');
    expect(researchMeasurementState(runDir(project, state.runId)).rounds ?? []).toEqual([]);
  });
  it('publishes only committed cancellation reports when cancellation wins during reality verification', async () => {
    const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
    const state = readRunState(project, created.runId);
    state.research = parseBriefFrontmatter(brief()).research;
    state.terminalStates = { shipped: { paths: ['success.md', 'other-success.md'] }, cancelled: { paths: ['cancelled.md'] } };
    writeRunState(project, created.runId, state);
    vi.spyOn(storeOwner, 'evaluateRealityGate').mockImplementation(async () => {
      expect(existsSync(join(project, 'success.md'))).toBe(false);
      cancelRunStateAtPath(created.runDirPath, new Date().toISOString());
      return { realityGate: { pass: true, checks: [] } } as any;
    });
    await expect(concludeRun(state, { status: 'shipped', reasonCode: 'research_shipped' })).rejects.toThrow('RUN_CANCELLED');
    const result = readRunState(project, created.runId);
    expect(result.status).toBe('cancelled');
    for (const path of ['success.md', 'other-success.md']) expect(existsSync(join(project, path))).toBe(false);
    expect(readFileSync(join(project, 'cancelled.md'), 'utf8')).toContain('Status: cancelled');
    expect(result.terminalArtifact).toBe('cancelled.md');
  });
  it('keeps cancellation authoritative even when its declared report cannot be published', () => {
    const created = createRun(project, 'research', 'name: research\nstages: []\n', []);
    const state = readRunState(project, created.runId);
    state.research = parseBriefFrontmatter(brief()).research;
    state.terminalStates = { cancelled: { paths: ['blocked/report.md'] } };
    put('blocked', 'not a directory');
    writeRunState(project, created.runId, state);
    expect(cancelRunStateAtPath(created.runDirPath, new Date().toISOString()).state.status).toBe('cancelled');
    expect(readRunState(project, created.runId).status).toBe('cancelled');
  });
  it('uses overflow-safe timer chunks without changing the absolute deadline', () => {
    const time = manualClock();
    const expired = vi.fn();
    const duration = 3_000_000_000;
    const cancel = scheduleDeadline(expired, () => duration - time.clock.monotonicNow(), time.clock);
    expect([...time.timers.values()].map(timer => timer.at)).toEqual([2_147_483_647]);
    time.advanceTo(2_147_483_647);
    expect(expired).not.toHaveBeenCalled();
    expect([...time.timers.values()].map(timer => timer.at)).toEqual([duration]);
    time.advanceTo(duration - 1);
    expect(expired).not.toHaveBeenCalled();
    time.advanceTo(duration);
    expect(expired).toHaveBeenCalledTimes(1);
    cancel(); expect(time.timers.size).toBe(0);
});
});
describe('literal research capabilities', () => {
  it('preserves literal root membership through construction and admission', () => {
    for (const path of ['src', 'a b/file.json', 'src/[a].json', 'src/a?file.json', 'src/a*file', 'src/{one,two}', 'src/@(one|two)', 'src/[!]', 'src/[*]', 'src/one]two']) {
      const config = parseBriefFrontmatter(brief(raw => { raw.research.measurement.candidate = [path]; }));
      expect(config.workflowError).toBeUndefined();
      const stages = researchStages(config.research!);
      expect(admitResearchStages(config.research!, stages, project, root).pass).toBe(true);
      expect(stageScopeOwnsPath(stages[0], path), path).toBe(true);
      expect(stageScopeOwnsPath(stages[0], path + '/.hidden/member'), path).toBe(true);
      expect(stageScopeOwnsPath(stages[0], 'src/a.json'), path).toBe(path === 'src');
      expect(stageScopeOwnsPath(stages[0], 'unrelated.json'), path).toBe(false);
    }
  });
  it('refuses roots outside the common portable project-relative path domain at parse', () => {
    const drive = 'C:'; // Synthetic parser input; never a filesystem location.
    for (const path of [drive + '/candidate.json', drive + '\\candidate.json', drive, drive + 'candidate.json', 'src/../candidate', 'src//candidate', 'src/./candidate', 'src/.git/config', ' src/file']) {
      const config = parseBriefFrontmatter(brief(raw => { raw.research.measurement.candidate = [path]; }));
      expect(config.research, path).toBeUndefined();
      expect(config.workflowError, path).toContain('declare research.measurement');
      expect(config.workflowError, path).toContain('project-relative');
    }
  });
});
