import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrateResearchNoise, captureMeasuredCandidate, decideResearchComparison, initializeResearchMeasurements, measureResearchCandidate, researchMeasurementState, ResearchMeasurementSchema, restoreResearchBest, type Metric, type Observation, type ResearchMeasurement } from '../src/research-measurement.js';
import { createDispatchAdmission } from '../src/scheduler/sched_admission/dispatch.js';
import { parseDispatchedStageConfig } from '../src/scheduler/sched_admission/configuration.js';
import { isResearchOutcomeGate } from '../src/scheduler/sched_settlement/gate-recovery.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import { runRecordPath } from '../src/run-layout.js';
import { producesEngineOwnedArtifact } from '../src/artifact-declarations.js';
import * as commandOwner from '../src/adapters/base.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';

const metrics: Record<string, Metric> = { cost: { direction: 'min', scale: 'fraction' } };
const observation = (values = [50, 50], ids = ['a', 'b']): Observation => ({ status: 'measured', fingerprint: 'instrument', candidate: 'candidate', items: values.map((cost, n) => ({ id: ids[n], metrics: { cost } })) });
const decide = (candidate: Observation, sigma = .05, guards: Parameters<typeof decideResearchComparison>[5] = []) => decideResearchComparison(observation(), candidate, metrics, ['cost'], { fingerprint: 'instrument', items: ['a', 'b'], metrics: { cost: sigma } }, guards);

describe('paired numeric keep rule', () => {
  it.each([[90, false], [90.00001, false], [89.99999, true], [100, false], [101, false]])('uses strict > twice calibrated noise: %s', (cost, keep) => {
    expect(decide(observation([cost / 2, cost / 2])).keep).toBe(keep);
  });
  it('does not turn a decimal equality at the noise boundary into a keep', () => {
    const compare = (value: number) => decideResearchComparison(observation([1.1], ['a']), observation([value], ['a']), metrics, ['cost'], { fingerprint: 'instrument', items: ['a'], metrics: { cost: .05 } }, []);
    expect(compare(.99).keep).toBe(false);
    expect(compare(.98999999).keep).toBe(true);
  });
  it.each(['different', 'duplicate', 'missing', 'instrument', 'unmeasured'] as const)('refuses %s observation identities', mutation => {
    const c = observation([1, 1]);
    if (mutation === 'different') c.items![0].id = 'another';
    if (mutation === 'duplicate') c.items![0].id = 'b';
    if (mutation === 'missing') c.items!.pop();
    if (mutation === 'instrument') c.fingerprint = 'changed';
    if (mutation === 'unmeasured') c.status = 'unmeasured';
    expect(decide(c)).toMatchObject({ keep: false, reason: 'input_invalid' });
  });
  it('pairs by item identity regardless of ordering and refuses a false guard', () => {
    expect(decide(observation([1, 1], ['b', 'a'])).keep).toBe(true);
    expect(decide(observation([1, 1]), .05, [{ passes: false }])).toMatchObject({ keep: false, reason: 'guard_worse' });
  });
  it('measures task variation even when no-op pooled totals cancel', () => {
    const a = observation([10, 20]), b = observation([20, 10]);
    expect(calibrateResearchNoise([a, b], metrics).cost).toBeGreaterThan(.1);
    expect(calibrateResearchNoise([a, b], metrics)).toEqual(calibrateResearchNoise([a, b], metrics));
    expect(() => calibrateResearchNoise([a, { ...b, candidate: 'changed' }], metrics)).toThrow('unchanged-baseline');
  });
  it('calibrates the magnitude of nonbinary count variation instead of keeping a no-op replicate', () => {
    const count: Record<string, Metric> = { cost: { direction: 'max', scale: 'count' } };
    const a = observation([0, 0]), b = observation([10, 10]);
    const noise = calibrateResearchNoise([a, b], count);
    expect(decideResearchComparison(a, b, count, ['cost'], { fingerprint: 'instrument', items: ['a', 'b'], metrics: noise }, []).keep).toBe(false);
    expect(() => calibrateResearchNoise([a, observation([1e200, 1e200])], count)).toThrow('finite calibration noise');
  });
  it('uses count noise with a one-count floor and strict count boundaries', () => {
    const count: Record<string, Metric> = { cost: { direction: 'max', scale: 'count' } };
    expect(calibrateResearchNoise([observation([1, 1]), observation([1, 1])], count)).toEqual({ cost: 1 });
    const compare = (value: number) => decideResearchComparison(observation([1, 1]), observation([value, 1]), count, ['cost'], { fingerprint: 'instrument', items: ['a', 'b'], metrics: { cost: 1 } }, []);
    expect(compare(3).keep).toBe(false); expect(compare(4).keep).toBe(true);
  });
});

let root: string, project: string, run: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rsi-instrument-')); project = join(root, 'project'); run = join(root, 'run'); mkdirSync(project); mkdirSync(run); writeFileSync(join(run, 'run.json'), JSON.stringify({ storageLayout: 2 })); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const evaluator = `const fs = require('node:fs');
const c = JSON.parse(fs.readFileSync(process.env.FC_RESEARCH_CANDIDATE + '/candidate.json'));
if (process.argv[2] === 'guard') { if(c.crash) process.exit(7); console.log(JSON.stringify({ok:c.ok})); }
else if (process.argv[2] === 'exit-guard') process.exit(c.ok ? 3 : 2);
else if (process.argv[2] === 'held') console.log(JSON.stringify({ok:c.held}));
else if (c.invalid) console.log('{}');
else if (c.attack) { fs.writeFileSync(__filename, 'overwritten'); console.log(JSON.stringify({items:[{id:'a',metrics:{cost:1}}]})); }
else if (c.sleep) setTimeout(() => console.log('{}'), 10000);
else console.log(JSON.stringify({items:[{id:c.id || 'a',metrics:{cost:c.cost}}]}));
`;
async function setup(change: (config: ResearchMeasurement) => void = () => {}) {
  writeFileSync(join(project, 'evaluate.cjs'), evaluator);
  writeFileSync(join(project, 'candidate.json'), JSON.stringify({ cost: 100, ok: true, held: true }));
  const config = ResearchMeasurementSchema.parse({ frozen: ['evaluate.cjs'], candidate: ['candidate.json'], replicates: 2, metrics, primary: ['cost'], development: { command: process.execPath, args: ['evaluate.cjs'] }, guards: [{ name: 'guard', command: process.execPath, args: ['evaluate.cjs', 'guard'], pass: { field: 'ok', equals: true } }], held_out: { command: process.execPath, args: ['evaluate.cjs', 'held'], allowance: 2, pass: { field: 'ok', equals: true } }, timeout_seconds: 2 });
  change(config);
  await initializeResearchMeasurements(project, run, config);
  return config;
}
const candidate = (label: string, value: Record<string, unknown>) => { writeFileSync(join(project, 'candidate.json'), JSON.stringify({ cost: 50, ok: true, held: true, ...value })); return captureMeasuredCandidate(project, run, label); };

describe('engine measurement lifecycle', { timeout: 300000 }, () => {
  it('records failed development as unmeasured and does not consume held-out', async () => {
    await setup(); const result = await measureResearchCandidate(run, candidate('invalid', { invalid: true }));
    expect(result.observation).toMatchObject({ status: 'unmeasured', detail: 'invalid item output' });
    expect(result.comparison.keep).toBe(false); expect(researchMeasurementState(run).heldOutUses).toHaveLength(0);
  });
  it('relocates an absolute evaluator argument into its frozen copy', async () => {
    await setup(c => {
      c.development.args[0] = join(project, 'evaluate.cjs');
      writeFileSync(join(project, 'evaluate.cjs'), `if (__filename === ${JSON.stringify(join(project, 'evaluate.cjs'))}) process.exit(9);\n` + evaluator);
    });
    const result = await measureResearchCandidate(run, candidate('absolute-input', {}));
    expect(result.observation.items![0].metrics.cost).toBe(50);
    expect(result.comparison.keep).toBe(true);
  });
  it('refuses edited frozen dependencies even when evaluator code embeds the original absolute path', async () => {
    writeFileSync(join(project, 'answers.json'), '{"multiplier":1}');
    writeFileSync(join(project, 'evaluate.cjs'), `const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.env.FC_RESEARCH_CANDIDATE+'/candidate.json'));const a=JSON.parse(fs.readFileSync(${JSON.stringify(join(project, 'answers.json'))}));console.log(JSON.stringify({items:[{id:'a',metrics:{cost:c.cost*a.multiplier}}]}));`);
    writeFileSync(join(project, 'candidate.json'), '{"cost":100}');
    await initializeResearchMeasurements(project, run, ResearchMeasurementSchema.parse({ frozen: ['evaluate.cjs', 'answers.json'], candidate: ['candidate.json'], replicates: 2, metrics, primary: ['cost'], development: { command: process.execPath, args: ['evaluate.cjs'] } }));
    expect(researchMeasurementState(run).noise).toEqual({ cost: 0 });
    writeFileSync(join(project, 'answers.json'), '{"multiplier":0}');
    const result = await measureResearchCandidate(run, candidate('embedded-original-input', {}));
    expect(result.observation).toMatchObject({ status: 'unmeasured', detail: expect.stringContaining('frozen_source_fingerprint_mismatch') });
    expect(result.comparison.keep).toBe(false);
  });
  it('refuses a changed original candidate even when evaluator code embeds that project path', async () => {
    await setup(() => {
      writeFileSync(join(project, 'evaluate.cjs'), evaluator.replace("process.env.FC_RESEARCH_CANDIDATE + '/candidate.json'", JSON.stringify(join(project, 'candidate.json'))));
    });
    const captured = candidate('embedded-original-candidate', {});
    writeFileSync(join(project, 'candidate.json'), '{"cost":1,"ok":true,"held":true}');
    const result = await measureResearchCandidate(run, captured);
    expect(result.observation).toMatchObject({ status: 'unmeasured', detail: expect.stringContaining('candidate_source_fingerprint_mismatch') });
    expect(result.comparison.keep).toBe(false);
  });
  it('retains empty candidate directories and refuses an added directory after capture', async () => {
    await setup(c => {
      c.candidate = ['candidate-tree'];
      mkdirSync(join(project, 'candidate-tree/empty'), { recursive: true });
      writeFileSync(join(project, 'candidate-tree/input.json'), '{"cost":100,"ok":true,"held":true}');
      writeFileSync(join(project, 'evaluate.cjs'), evaluator.replaceAll("'/candidate.json'", "'/candidate-tree/input.json'"));
    });
    expect(researchMeasurementState(run).noise).toEqual({ cost: 0 });
    expect(existsSync(runRecordPath(run, 'research_measurement/baseline/candidate-tree/empty'))).toBe(true);
    writeFileSync(join(project, 'candidate-tree/input.json'), '{"cost":50,"ok":true,"held":true}');
    const captured = captureMeasuredCandidate(project, run, 'empty-directory');
    mkdirSync(join(project, 'candidate-tree/added'));
    const result = await measureResearchCandidate(run, captured);
    expect(result.observation.detail).toContain('candidate_source_fingerprint_mismatch');
    expect(result.comparison.keep).toBe(false);
  });
  it('freezes empty dependency roots as well as their later directory membership', async () => {
    await setup(c => { c.frozen.push('answers'); mkdirSync(join(project, 'answers')); });
    expect(researchMeasurementState(run).noise).toEqual({ cost: 0 });
    mkdirSync(join(project, 'answers/added'));
    const result = await measureResearchCandidate(run, candidate('empty-frozen-root', {}));
    expect(result.observation.detail).toContain('frozen_source_fingerprint_mismatch');
    expect(result.comparison.keep).toBe(false);
  });
  it('records changed engine-owned instrument bytes as unmeasured', async () => {
    await setup(); writeFileSync(runRecordPath(run, 'research_measurement/instrument/evaluate.cjs'), 'console.log("tampered")');
    const result = await measureResearchCandidate(run, candidate('tamper', {}));
    expect(result.observation.status).toBe('unmeasured'); expect(result.observation.detail).toContain('instrument_fingerprint_mismatch'); expect(result.comparison.keep).toBe(false);
  });
  it('prevents a write to the frozen instrument during command execution', async () => {
    await setup(); const result = await measureResearchCandidate(run, candidate('command-tamper', { attack: true }));
    expect(result.observation.status).toBe('unmeasured');
    expect(result.observation.detail).toBe('exit 1');
    expect((result as unknown as { development: { stderr: string } }).development.stderr).toContain('EACCES');
    expect(result.comparison.keep).toBe(false);
    expect(readFileSync(runRecordPath(run, 'research_measurement/instrument/evaluate.cjs'), 'utf8')).toBe(evaluator);
  });
  it('refreshes a repaired gate candidate while retaining immutable prior snapshots', async () => {
    await setup(); const old = candidate('repair', { cost: 80 });
    writeFileSync(join(project, 'candidate.json'), JSON.stringify({ cost: 50, ok: true, held: true }));
    const repaired = captureMeasuredCandidate(project, run, 'repair', true);
    expect(repaired.sha256).not.toBe(old.sha256);
    expect(JSON.parse(readFileSync(join(old.path, 'candidate.json'), 'utf8')).cost).toBe(80);
    const result = await measureResearchCandidate(run, repaired);
    expect(result.observation.candidate).toBe(repaired.sha256);
    expect(result.observation.items![0].metrics.cost).toBe(50);
  });
  it('binds a measurement to the captured candidate and detects altered snapshot bytes', async () => {
    await setup(); const captured = candidate('tamper', {});
    writeFileSync(join(captured.path, 'candidate.json'), '{"cost":1}');
    const result = await measureResearchCandidate(run, captured);
    expect(result.observation.detail).toContain('candidate_fingerprint_mismatch'); expect(result.comparison.keep).toBe(false);
  });
  it('binds candidate executable permissions as well as file bytes', async () => {
    await setup(); const captured = candidate('mode-tamper', {});
    chmodSync(join(captured.path, 'candidate.json'), 0o700);
    const result = await measureResearchCandidate(run, captured);
    expect(result.observation.detail).toContain('candidate_fingerprint_mismatch');
    expect(result.comparison.keep).toBe(false);
  });
  it('records failed guards with their exit and never uses held-out', async () => {
    await setup(); const result = await measureResearchCandidate(run, candidate('guard-error', { crash: true }));
    expect(result.comparison.keep).toBe(false); expect(result.guards[0]).toMatchObject({ passes: false });
    expect(result.guards[0].detail).toContain('7'); expect(researchMeasurementState(run).heldOutUses).toHaveLength(0);
  });
  it('records a missing guard executable as failed without skipping development calibration', async () => {
    await setup(c => { c.guards.push({ ...c.guards[0], name: 'second-guard', command: join(root, 'missing-guard') }); });
    expect(researchMeasurementState(run).noise).toEqual({ cost: 0 });
    const result = await measureResearchCandidate(run, candidate('missing-guard', {}));
    expect(result.guards[0].passes).toBe(true);
    expect(result.guards[1]).toMatchObject({ passes: false, reason: 'guard_error', detail: expect.stringContaining('ENOENT') });
    expect(result.comparison.keep).toBe(false);
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(0);
  });
  it('accepts declared nonzero exit-code guards', async () => {
    await setup(c => { c.guards[0].args = ['evaluate.cjs', 'exit-guard']; c.guards[0].pass = { exit_code: 3 }; });
    expect((await measureResearchCandidate(run, candidate('exit-guard', {}))).comparison.keep).toBe(true);
  });
  it('does not use held-out until strict development improvement and guards pass', async () => {
    await setup();
    expect((await measureResearchCandidate(run, candidate('no-improvement', { cost: 100 }))).comparison.reason).toBe('no_improvement_above_noise');
    expect((await measureResearchCandidate(run, candidate('guard-refusal', { ok: false }))).comparison.reason).toBe('guard_worse');
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(0);
    expect((await measureResearchCandidate(run, candidate('held-refusal', { held: false }))).comparison.keep).toBe(false);
    expect(researchMeasurementState(run).heldOutUses).toMatchObject([{ round: 'held-refusal', passes: false }]);
  });
  it('preserves baseline, noise, best and allowance when initialization is reentered', async () => {
    const config = await setup(); const captured = candidate('kept', {});
    expect((await measureResearchCandidate(run, captured)).comparison.keep).toBe(true);
    const before = researchMeasurementState(run);
    writeFileSync(join(project, 'evaluate.cjs'), 'invalid');
    const after = await initializeResearchMeasurements(project, run, config);
    expect(after).toEqual(before);
    expect(await measureResearchCandidate(run, captured)).toMatchObject({ comparison: { keep: true } });
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(1);
    candidate('rejected', { cost: 200 }); restoreResearchBest(project, run);
    expect(JSON.parse(readFileSync(join(project, 'candidate.json'), 'utf8')).cost).toBe(50);
  });
  it('replays the original measured candidate when a later capture reuses its label', async () => {
    await setup(); const original = candidate('same-round', { cost: 80 });
    const first = await measureResearchCandidate(run, original);
    writeFileSync(join(project, 'candidate.json'), '{"cost":1,"ok":true,"held":true}');
    const later = captureMeasuredCandidate(project, run, 'same-round', true);
    expect(later.sha256).not.toBe(original.sha256);
    const replay = await measureResearchCandidate(run, later);
    expect(replay.candidate).toEqual(original);
    expect(replay.observation).toEqual(first.observation);
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(1);
  });
  it('never rolls allowance accounting back when an older rejected result is replayed', async () => {
    await setup(); const first = candidate('first-refusal', { held: false });
    await measureResearchCandidate(run, first);
    await measureResearchCandidate(run, candidate('second-refusal', { held: false }));
    await measureResearchCandidate(run, first);
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(2);
    expect(researchMeasurementState(run).revision).toBe(2);
  });
  it('refuses to repeat a spent held-out use after interruption', async () => {
    await setup(); const captured = candidate('interrupted', {});
    const path = runRecordPath(run, 'research_measurement/state.json'), state = researchMeasurementState(run);
    state.heldOutUses.push({ round: 'interrupted', status: 'started' }); writeFileSync(path, JSON.stringify(state));
    const result = await measureResearchCandidate(run, captured);
    expect(result.comparison).toMatchObject({ keep: false, reason: 'held_out_interrupted' });
    expect(result.heldOutExhausted).toBe(false);
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(1);
    const next = await measureResearchCandidate(run, candidate('next-after-interruption', {}));
    expect(next.comparison.keep).toBe(true);
    expect(next.heldOutExhausted).toBe(true);
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(2);
  });
  it('honors an exhausted wall budget without launching development', async () => {
    await setup(); const result = await measureResearchCandidate(run, candidate('wall', {}), 0);
    expect(result.observation.status).toBe('unmeasured'); expect(result.observation.detail).toContain('research_wall_budget_exhausted');
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(0);
  });
  it('times out and retires an owned measurement command', async () => {
    await setup(c => { c.timeout_seconds = .05; });
    const result = await measureResearchCandidate(run, candidate('timeout', { sleep: true }));
    expect(result.observation.status).toBe('unmeasured'); expect(result.observation.detail).toContain('measurement_timeout');
  });
  it('preserves an unavailable executable as an explicit unmeasured baseline', async () => {
    await setup(c => { c.development.command = join(root, 'missing-executable'); });
    expect(researchMeasurementState(run)).toMatchObject({ baseline: { status: 'unmeasured' }, error: expect.stringContaining('ENOENT') });
    expect((await measureResearchCandidate(run, candidate('missing', {}))).comparison.keep).toBe(false);
  });
  it('freezes executable bytes as well as evaluator dependencies', async () => {
    const executable = join(project, 'node');
    const { copyFileSync } = await import('node:fs'); copyFileSync(process.execPath, executable); chmodSync(executable, 0o755);
    await setup(c => { c.development.command = executable; });
    writeFileSync(executable, 'invalid');
    expect((await measureResearchCandidate(run, candidate('executable', {}))).comparison.keep).toBe(true);
  });
  it('refuses changed retained executable permissions without trusting a successful command', async () => {
    await setup();
    const executables = runRecordPath(run, 'research_measurement/executables');
    chmodSync(join(executables, readdirSync(executables)[0]), 0o700);
    const result = await measureResearchCandidate(run, candidate('executable-mode-tamper', {}));
    expect(result.observation.detail).toContain('instrument_fingerprint_mismatch');
    expect(result.comparison.keep).toBe(false);
  });
  it('refuses temporary permission edits even when the original mode is restored', async () => {
    await setup(() => {
      writeFileSync(join(project, 'evaluate.cjs'), evaluator.replace("if (process.argv[2]", `if (c.metadata) {
        const p = __filename, mode = fs.statSync(p).mode;
        fs.chmodSync(p, mode ^ 0o100); fs.chmodSync(p, mode);
      }
      if (process.argv[2]`));
    });
    const result = await measureResearchCandidate(run, candidate('metadata', { metadata: true }));
    expect(result.observation).toMatchObject({ status: 'unmeasured', detail: 'measurement_input_changed_during_execution' });
    expect(result.comparison.keep).toBe(false);
    expect(researchMeasurementState(run).heldOutUses).toHaveLength(0);
  });
  it('fails an exit-code guard when write confinement could not be installed', async () => {
    await setup(c => { c.guards[0].args = ['evaluate.cjs', 'exit-guard']; c.guards[0].pass = { exit_code: 3 }; });
    const spawn = commandOwner.spawnOwnedCommand;
    const launcher = vi.spyOn(commandOwner, 'spawnOwnedCommand').mockImplementation((cmd, args, opts) =>
      args.includes('exit-guard') ? spawn('/bin/sh', ['-c', 'exit 3'], opts) : spawn(cmd, args, opts));
    try {
      const result = await measureResearchCandidate(run, candidate('no-confinement', {}));
      expect(result.observation.status).toBe('measured');
      expect(result.guards[0]).toMatchObject({ passes: false, reason: 'guard_error', detail: 'measurement_write_confinement_unavailable' });
      expect(result.comparison.keep).toBe(false);
      expect(researchMeasurementState(run).heldOutUses).toHaveLength(0);
    } finally { launcher.mockRestore(); }
  });
  it.each(['source', 'snapshot'] as const)('confines truncation and renaming of %s frozen inputs while allowing scratch writes', async target => {
    await setup(() => {
      writeFileSync(join(project, 'evaluate.cjs'), evaluator.replace("if (process.argv[2]", `if (c.operations) {
        const path = ${target === 'source' ? JSON.stringify(join(project, 'evaluate.cjs')) : '__filename'};
        const scratch = process.env.TMPDIR + '/result';
        fs.writeFileSync(scratch, 'scratch is writable');
        if (fs.readFileSync(scratch, 'utf8') !== 'scratch is writable') process.exit(9);
        for (const op of [() => fs.truncateSync(path, 0), () => fs.renameSync(path, scratch), () => fs.linkSync(path, scratch + '-link')]) {
          let refused = false;
          try { op(); } catch (error) { refused = ['EACCES', 'EXDEV'].includes(error.code); }
          if (!refused) process.exit(10);
        }
      }
      if (process.argv[2]`));
    });
    const result = await measureResearchCandidate(run, candidate('confined-operations', { operations: true }));
    expect(result.observation.status).toBe('measured');
    expect(result.comparison.keep).toBe(true);
  });
  it.each(['internal', 'external'] as const)('validates all restore destinations before mutation with an %s ancestor alias', async location => {
    await setup(c => {
      c.candidate.push('tree/input.json'); mkdirSync(join(project, 'tree'));
      writeFileSync(join(project, 'tree/input.json'), 'baseline evidence');
    });
    const evidence = join(location === 'internal' ? project : root, 'unrelated');
    mkdirSync(evidence); writeFileSync(join(evidence, 'input.json'), 'unrelated evidence');
    const submitted = candidate('aliased', {});
    rmSync(join(project, 'tree'), { recursive: true }); symlinkSync(evidence, join(project, 'tree'));
    expect(() => restoreResearchBest(project, run)).toThrow('unsafe research restore ancestor');
    expect(readFileSync(join(evidence, 'input.json'), 'utf8')).toBe('unrelated evidence');
    // The first valid destination must also remain untouched after preflight fails.
    expect(readFileSync(join(project, 'candidate.json'), 'utf8')).toBe(readFileSync(join(submitted.path, 'candidate.json'), 'utf8'));
  });
  it('restores missing candidate parents and unlinks a leaf alias without touching its target', async () => {
    await setup(c => {
      c.candidate.push('tree/input.json'); mkdirSync(join(project, 'tree'));
      writeFileSync(join(project, 'tree/input.json'), 'baseline evidence');
    });
    rmSync(join(project, 'tree'), { recursive: true });
    const evidence = join(project, 'unrelated.json'); writeFileSync(evidence, 'unrelated evidence');
    rmSync(join(project, 'candidate.json')); symlinkSync(evidence, join(project, 'candidate.json'));
    restoreResearchBest(project, run);
    expect(readFileSync(evidence, 'utf8')).toBe('unrelated evidence');
    expect(JSON.parse(readFileSync(join(project, 'candidate.json'), 'utf8')).cost).toBe(100);
    expect(readFileSync(join(project, 'tree/input.json'), 'utf8')).toBe('baseline evidence');
  });
  it('reserves all instrument, journal and decision records from stage capabilities', async () => {
    for (const path of ['research_measurement/state.json', 'research_measurement/instrument/evaluate.cjs', 'research_journal.json', 'research_decision.json']) expect(producesEngineOwnedArtifact({ id: 'forged', root: 'run', path: 'engine/' + path, kind: 'file' }, { id: 'producer', depends_on: [] }, run, project)).toBe(true);
    await setup();
    await expect(withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'producer' }, async () => {
      writeFileSync(runRecordPath(run, 'research_measurement/instrument/evaluate.cjs'), 'stage overwrite');
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(readFileSync(runRecordPath(run, 'research_measurement/instrument/evaluate.cjs'), 'utf8')).toBe(evaluator);
  });
});

describe.each([1, 2])('measurement ownership in storage layout %s', layout => {
  beforeEach(() => {
    // Use a fresh path: a run's storage layout is immutable once observed.
    run = join(root, `layout-${layout}`);
    mkdirSync(run);
    writeFileSync(join(run, 'run.json'), JSON.stringify({ ...(layout === 2 ? { storageLayout: 2 } : {}) }));
  });
  it('routes records through the run envelope and refuses stage output grants', async () => {
    const launch = vi.spyOn(commandOwner, 'spawnOwnedCommand');
    await setup();
    const local = layout === 2 ? 'engine/research_measurement' : 'research_measurement';
    expect(runRecordPath(run, 'research_measurement')).toBe(join(run, local));
    expect(existsSync(join(run, local, 'state.json'))).toBe(true);
    expect(existsSync(join(run, layout === 2 ? 'research_measurement' : 'engine/research_measurement'))).toBe(false);
    for (const suffix of ['', '/state.json', '/instrument/evaluate.cjs', '/future-record.json']) {
      expect(producesEngineOwnedArtifact({ id: 'forged', root: 'run', path: local + suffix, kind: suffix ? 'file' : 'directory' }, { id: 'producer', depends_on: [] }, run, project)).toBe(true);
    }
    if (layout === 1) {
      expect(launch).not.toHaveBeenCalled();
      expect(researchMeasurementState(run).baseline).toMatchObject({ status: 'unmeasured', detail: expect.stringContaining('RUN_LAYOUT_INCOMPATIBLE') });
    } else {
      expect(launch).toHaveBeenCalledTimes(2);
      expect(researchMeasurementState(run).baseline.status).toBe('measured');
    }
  });
  it('voids stage writes or refuses legacy execution before the action', async () => {
    await setup();
    const path = runRecordPath(run, 'research_measurement/instrument/evaluate.cjs');
    const action = vi.fn(async () => { writeFileSync(path, 'stage overwrite'); });
    await expect(withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'producer' }, action))
      .rejects.toThrow(layout === 2 ? 'ENGINE_STATE_TAMPERED' : 'RUN_LAYOUT_INCOMPATIBLE');
    expect(action).toHaveBeenCalledTimes(layout === 2 ? 1 : 0);
    expect(readFileSync(path, 'utf8')).toBe(evaluator);
  });
  it('records tampered retained inputs as unmeasured and never keeps them', async () => {
    await setup();
    writeFileSync(runRecordPath(run, 'research_measurement/instrument/evaluate.cjs'), 'tampered instrument');
    const result = await measureResearchCandidate(run, candidate('layout-tamper', {}));
    expect(result.observation).toMatchObject({ status: 'unmeasured', detail: expect.stringContaining('instrument_fingerprint_mismatch') });
    expect(result.comparison.keep).toBe(false);
    expect(researchMeasurementState(run).heldOutUses).toEqual([]);
  });
});

it('rejects malformed instrument declarations instead of falling back to producer numbers', () => {
  const brief = '---\nresearch:\n  baseline: 100\n  measurement: {replicates: 1}\n  stop: {max_rounds: 3}\n---\nTry candidates.';
  expect(parseBriefFrontmatter(brief).researchPolicyError).toContain('measurement');
});

it.each(['candidate/data.json', 'candidate/*.json', 'candidate/**'])('keeps terminal writers out of measured candidate trees (%s)', scope => {
  const measurement = ResearchMeasurementSchema.parse({ frozen: ['evaluate.cjs'], candidate: ['candidate'], replicates: 2, metrics, primary: ['cost'], development: { command: process.execPath, args: ['evaluate.cjs'] } });
  const owner = parseDispatchedStageConfig({ id: 'report', role: 'doc_writer', scope: [scope, 'report.md'], depends_on: [], dependency_reasons: {}, condition: 'research.decision != continue', is_gate: false, skills: [], criterion_refs: [], prompt_template: 'Report the engine decision.', artifact_contract: { version: 1, produces: [{ id: 'report', root: 'project', path: 'report.md', kind: 'file' }], reads: [], groups: [] } });
  const research = { baseline: 100, policy: 'greedy_stack' as const, measurement, stop: { maxRounds: 3 } };
  const report = createDispatchAdmission()({ dispatched: [owner], baseStages: [], dispatchStageId: 'plan', terminalStates: { ceiling_hit: { paths: ['report.md'] } }, research });
  expect(report.errors.some(error => error.code === 'terminal_owner_scope')).toBe(true);
  const disjoint = { ...owner, scope: ['other/*.json', 'report.md'] };
  expect(createDispatchAdmission()({ dispatched: [disjoint], baseStages: [], dispatchStageId: 'plan', terminalStates: { ceiling_hit: { paths: ['report.md'] } }, research }).pass).toBe(true);
  const gate = { ...owner, id: 'review', is_gate: true, scope: [], depends_on: [owner.id] };
  expect(isResearchOutcomeGate(gate, [owner, gate], research)).toBe(true);
});
