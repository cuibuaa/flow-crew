import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureMeasuredCandidate, finalizeResearchInstrument, initializeResearchInstrument, invokeResearchInstrument,
  recordResearchSubmission, researchAuthorContext, researchDirectory, researchInstrumentState, restoreResearchBest } from '../src/research-measurement.js';
import { ResearchInstrumentSchema, type ResearchConfig } from '../src/research-instrument.js';
import { makeInstrument, instrumentProgram } from './test-support/research-instrument-fixture.js';
import { controlResearchTime } from './test-support/research-clock.js';
import { runRecordPath } from '../src/run-layout.js';
import { producesEngineOwnedArtifact } from '../src/artifact-declarations.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { parseBriefFrontmatter } from '../src/scheduler/sched_admission/brief-contract.js';
import * as commands from '../src/adapters/base.js';
import * as files from '../src/engine-fs.js';
import { fcGlobalDir, setFcGlobalDir } from '../src/store.js';

let root: string, project: string, run: string, previousStore: string;
let time: ReturnType<typeof controlResearchTime>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'research-instrument-')); project = join(root, 'project'); run = join(root, 'run');
  previousStore = fcGlobalDir(); setFcGlobalDir(join(root, 'store'));
  mkdirSync(project); mkdirSync(run); writeFileSync(join(run, 'run.json'), JSON.stringify({ storageLayout: 2, runId: 'controlled-run' }));
  time = controlResearchTime();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setFcGlobalDir(previousStore); rmSync(root, { recursive: true, force: true }); });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
async function setup(edit: (config: ResearchConfig) => void = () => {}) {
  const config = makeInstrument(project); edit(config);
  await initializeResearchInstrument(project, run, config); return config;
}
function candidate(value: Record<string, unknown>, label = 'round-1') {
  writeFileSync(join(project, 'candidate.json'), JSON.stringify({ value: 50, ...value }));
  return captureMeasuredCandidate(project, run, label);
}
const evaluate = (value: Record<string, unknown> = {}, round = 1) => invokeResearchInstrument(run, 'evaluate', candidate(value, `round-${round}`), round);

describe('frozen project instrument execution', () => {
  it('initializes once and leaves project policy and payloads opaque', async () => {
    const config = await setup(); const state = researchInstrumentState(run);
    expect(state.history).toHaveLength(1); expect(state.history[0].outcome).toBe('baseline');
    expect(state.history[0].response?.observations).toMatchObject({ value: 100, extra: { arbitrary: null } });
    const launch = vi.spyOn(commands, 'spawnOwnedCommand');
    await initializeResearchInstrument(project, run, config);
    expect(launch).not.toHaveBeenCalled(); expect(researchInstrumentState(run)).toEqual(state);
  });
  it('refuses declaration drift on replay rather than changing the frozen run or resetting its budget', async () => {
    const config = await setup(); config.budget.max_rounds++;
    const spawn = vi.spyOn(commands, 'spawnOwnedCommand');
    await expect(initializeResearchInstrument(project, run, config)).rejects.toThrow('frozen_instrument_declaration_mismatch');
    expect(spawn).not.toHaveBeenCalled(); expect(researchInstrumentState(run).config.budget.max_rounds).toBe(3);
  });
  it.each(['source', 'snapshot', 'candidate', 'request'])('denies transient %s edits before baseline100 can become forged1', async attack => {
    await setup(); const result = await evaluate({ attack });
    expect(result.outcome).toBe('execution_error'); expect(result.response).toBeUndefined();
    expect(read(result.raw!.path).stderr).toContain('EACCES');
    expect(read(join(researchInstrumentState(run).incumbent.path, 'candidate.json')).value).toBe(100);
    expect(readFileSync(join(researchDirectory(run), 'instrument/instrument/run.cjs'), 'utf8')).toBe(instrumentProgram);
    expect(read(join(project, 'instrument/config.json')).value).toBe(100);
  });
  it('refuses temporary permission edits even after the original mode is restored', async () => {
    await setup(); expect(await evaluate({ metadata: true })).toMatchObject({ outcome: 'execution_error', reason: 'instrument_input_changed_during_execution' });
  });
  it('confines truncation, renaming and hardlinks while scratch stays writable', async () => {
    await setup(); expect((await evaluate({ operations: true })).outcome).toBe('keep');
  });
  it.each(['source', 'snapshot', 'mode'])('binds the submitted candidate %s to its digest', async target => {
    await setup(); const captured = candidate({});
    if (target === 'mode') chmodSync(join(captured.path, 'candidate.json'), 0o700);
    else writeFileSync(join(target === 'source' ? project : captured.path, 'candidate.json'), '{"value":1}');
    const result = await invokeResearchInstrument(run, 'evaluate', captured, 1);
    expect(result.outcome).toBe('execution_error'); expect(result.reason).toContain(target === 'source' ? 'candidate_source_fingerprint_mismatch' : 'candidate_fingerprint_mismatch');
    expect(researchInstrumentState(run).incumbent.sha256).not.toBe(captured.sha256);
  });
  it.each(['source', 'snapshot'])('refuses changed %s frozen config', async target => {
    await setup();
    writeFileSync(join(target === 'source' ? project : join(researchDirectory(run), 'instrument'), 'instrument/config.json'), '{}');
    const result = await evaluate(); expect(result.outcome).toBe('execution_error');
    expect(result.reason).toContain(target === 'source' ? 'frozen_source_fingerprint_mismatch' : 'instrument_fingerprint_mismatch');
  });
  it('retains empty roots and rejects later membership changes', async () => {
    await setup(config => { config.frozen.push('empty'); mkdirSync(join(project, 'empty')); });
    expect(existsSync(join(researchDirectory(run), 'instrument/empty'))).toBe(true);
    mkdirSync(join(project, 'empty/added'));
    expect((await evaluate()).reason).toContain('frozen_source_fingerprint_mismatch');
  });
  it('freezes executable bytes and permissions', async () => {
    const config = makeInstrument(project), executable = join(project, 'node');
    copyFileSync(process.execPath, executable); chmodSync(executable, 0o755); config.argv[0] = executable;
    await initializeResearchInstrument(project, run, config);
    writeFileSync(executable, 'changed live executable');
    expect((await evaluate()).outcome).toBe('keep');
    chmodSync(join(researchDirectory(run), 'executables/command'), 0o700);
    expect((await evaluate({ value: 25 }, 2)).reason).toContain('instrument_fingerprint_mismatch');
  });
  it.each(['invalid', 'fail', 'badVerdict'])('treats %s as an execution error, never a reject', async fault => {
    await setup(); const result = await evaluate({ [fault]: fault === 'badVerdict' ? 'baseline' : true });
    expect(result.outcome).toBe('execution_error'); expect(result.response).toBeUndefined();
    expect(read(result.raw!.path).stdout).toBeDefined();
    if (fault === 'fail') expect(read(result.raw!.path)).toMatchObject({ started: true, exitCode: 2, stderr: 'controlled executable failure\n' });
  });
  it.each(['run_id', 'invocation_id', 'phase', 'round', 'instrument_sha256', 'candidate_sha256', 'protocol'])('rejects mismatched %s as an execution error', async mismatch => {
    await setup(); const result = await evaluate({ mismatch });
    expect(result.outcome).toBe('execution_error'); expect(researchInstrumentState(run).history.at(-1)?.outcome).not.toBe('reject');
  });
  it('distinguishes a valid project reject and project unavailability from execution errors', async () => {
    await setup(); expect((await evaluate({ value: 200 })).outcome).toBe('reject');
    const unavailable = await evaluate({ unavailable: true }, 2);
    expect(unavailable.outcome).toBe('unavailable'); expect(unavailable.response?.next_state).toEqual(researchInstrumentState(run).instrumentState);
    expect(researchInstrumentState(run).error).toBeUndefined();
  });
  it('requires successful executable start and retains failed launch stderr', async () => {
    const executable = join(project, 'broken'); writeFileSync(executable, '#!/no/such/interpreter\n'); chmodSync(executable, 0o755);
    await setup(config => { config.argv[0] = executable; });
    const result = researchInstrumentState(run).history[0];
    expect(result).toMatchObject({ outcome: 'execution_error', reason: 'instrument_executable_start_failed' });
    expect(read(result.raw!.path)).toMatchObject({ started: false, exitCode: 1 });
    expect(read(result.raw!.path).stderr).toContain('FileNotFoundError');
  });
  it('retains a missing executable as an explicit baseline execution error', async () => {
    await setup(config => { config.argv[0] = join(root, 'missing'); });
    expect(researchInstrumentState(run).history[0]).toMatchObject({ outcome: 'execution_error', reason: expect.stringContaining('ENOENT') });
  });
  it('refuses success when process confinement did not start', async () => {
    const spawn = commands.spawnOwnedCommand;
    vi.spyOn(commands, 'spawnOwnedCommand').mockImplementation((_cmd, _args, opts) => spawn('/bin/sh', ['-c', 'exit 0'], opts));
    await setup(); expect(researchInstrumentState(run).history[0]).toMatchObject({ outcome: 'execution_error', reason: 'instrument_write_confinement_unavailable' });
  });
  it('retains invalid UTF-8 raw process bytes losslessly while refusing the envelope', async () => {
    await setup(); const result = await evaluate({ binary: true });
    expect(result.outcome).toBe('execution_error');
    expect(read(result.raw!.path).stdout_base64).toBe(Buffer.from([255, 0, 254]).toString('base64'));
    expect(Buffer.from(read(result.raw!.path).stdout_base64, 'base64')).toEqual(Buffer.from([255, 0, 254]));
  });
  it.each([true, false])('validates UTF-8 before verdict authority (embedded invalid byte=%s)', async invalid => {
    await setup(() => writeFileSync(join(project, 'instrument/run.cjs'), `
      const fs = require('node:fs');
      const r = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
      const response = { protocol: r.protocol, run_id: r.run_id, invocation_id: r.invocation_id,
        phase: r.phase, round: r.round, instrument_sha256: r.instrument_sha256,
        candidate_sha256: r.candidate.sha256, status: 'ok',
        verdict: r.phase === 'initialize' ? 'baseline' : 'keep', reason: 'valid fields',
        observations: { text: '�' }, diagnostics: { nested: true }, artifacts: [], next_state: null };
      const text = JSON.stringify(response), i = text.indexOf('�');
      process.stdout.write(${invalid} && r.phase === 'evaluate'
        ? Buffer.concat([Buffer.from(text.slice(0, i)), Buffer.from([255]), Buffer.from(text.slice(i + 1))])
        : Buffer.from(text));
    `));
    expect(researchInstrumentState(run).history[0].outcome).toBe('baseline');
    const result = await evaluate();
    // Both streams decode to the same string. Only the actual wire bytes may
    // authorize a verdict; a literal valid replacement character stays opaque.
    const raw = read(result.raw!.path);
    expect(JSON.parse(raw.stdout).observations.text).toBe('�');
    expect(result.outcome).toBe(invalid ? 'execution_error' : 'keep');
    if (invalid) {
      expect(result.reason).toBe('instrument_stdout_invalid_utf8');
      expect(result.response).toBeUndefined();
      expect(Buffer.from(raw.stdout_base64, 'base64')).toContain(255);
      expect(researchInstrumentState(run).incumbent.label).toBe('baseline');
    } else {
      expect(raw.stdout_base64).toBeUndefined();
      expect(result.response?.observations).toEqual({ text: '�' });
      expect(researchInstrumentState(run).incumbent.label).toBe('round-1');
    }
  });
  it('bounds response and raw output without accepting a partial envelope', async () => {
    await setup(); const result = await evaluate({ overflow: true });
    expect(result).toMatchObject({ outcome: 'execution_error', reason: 'instrument_output_limit' });
    expect(read(result.raw!.path).stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe('lossless settlement, replay and best restoration', () => {
  it('delivers nested diagnostics, extra observation fields and opaque state byte-equal to author and next request', async () => {
    await setup(); const first = await evaluate({ artifact: true });
    expect(first.outcome, first.reason).toBe('keep');
    const context = researchAuthorContext(run);
    const next = await evaluate({ value: 200, stop: true }, 2);
    const request = read(next.request!.path);
    const emitted = JSON.parse(read(first.raw!.path).stdout);
    for (const key of ['diagnostics', 'observations', 'next_state']) {
      const bytes = JSON.stringify(emitted[key]);
      expect(JSON.stringify(first.response![key as keyof typeof first.response])).toBe(bytes);
      expect(JSON.stringify(context.history.at(-1)?.response?.[key as keyof typeof first.response])).toBe(bytes);
      expect(JSON.stringify(request.history.at(-1).response[key])).toBe(bytes);
    }
    expect(JSON.stringify(request.previous_state)).toBe(JSON.stringify(emitted.next_state));
    expect(request.history.map((h: any) => h.outcome)).toEqual(['baseline', 'keep']);
    expect(read(first.result.path).artifacts).toHaveLength(1);
    const artifact = read(first.result.path).artifacts[0];
    expect(readFileSync(artifact.path, 'utf8')).toBe('opaque artifact\n');
    const manifest = await finalizeResearchInstrument(run, 'instrument_stop');
    expect(manifest.incumbent.sha256).toBe(first.candidate.sha256);
    expect(read(manifest.finalizer!.request!.path).history.map((h: any) => h.outcome)).toEqual(['baseline', 'keep', 'reject']);
    expect(readFileSync(manifest.report!.path, 'utf8')).toContain('History 3');
    expect(read(join(project, 'candidate.json')).value).toBe(50);
  });
  it('preserves opaque numeric wire values beyond JavaScript precision and range', async () => {
    await setup(); const first = await evaluate({ exact: true }); expect(first.outcome, first.reason).toBe('keep');
    const next = await evaluate({ value: 200 }, 2);
    const request = readFileSync(next.request!.path, 'utf8');
    for (const lexeme of ['9007199254740993', '0.123456789012345678901', '1e999']) {
      expect(JSON.stringify(first.response?.observations)).toContain(lexeme);
      expect(JSON.stringify(researchAuthorContext(run).history[1].response?.diagnostics)).toContain(lexeme);
      expect(request).toContain(lexeme);
      expect(JSON.stringify(researchAuthorContext(run).history[1].response?.next_state)).toContain(lexeme);
    }
  });
  it('replays a committed result after projection failure without remeasurement or reauthoring best identity', async () => {
    const spawn = vi.spyOn(commands, 'spawnOwnedCommand');
    await setup(); const submitted = candidate({ value: 80 });
    expect(spawn).toHaveBeenCalledTimes(1);
    const write = files.atomicWrite;
    const failure = vi.spyOn(files, 'atomicWrite').mockImplementation((path, ...args) => {
      if (path === join(researchDirectory(run), 'state.json')) throw new Error('controlled projection crash');
      return write(path, ...args);
    });
    await expect(invokeResearchInstrument(run, 'evaluate', submitted, 1, { summary: 'forged -999999 keep' })).rejects.toThrow('controlled projection crash');
    failure.mockRestore();
    expect(spawn).toHaveBeenCalledTimes(2);
    const later = candidate({ value: 1 }, 'later-capture');
    let replay: Awaited<ReturnType<typeof invokeResearchInstrument>> | undefined, replayError: unknown;
    try { replay = await invokeResearchInstrument(run, 'evaluate', later, 1); } catch (error) { replayError = error; }
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(replayError, 'A committed evaluation must replay successfully').toBeUndefined();
    expect(replay?.candidate).toEqual(submitted);
    expect(researchInstrumentState(run).incumbent).toEqual(submitted);
    expect(researchInstrumentState(run).history).toHaveLength(2);
  });
  it('never starts a new evaluation after finalization has been reserved', async () => {
    await setup(); await finalizeResearchInstrument(run, 'instrument_stop');
    const submitted = candidate({ value: 1 }); const spawn = vi.spyOn(commands, 'spawnOwnedCommand');
    await expect(invokeResearchInstrument(run, 'evaluate', submitted, 1)).rejects.toThrow('research_already_finalizing');
    expect(spawn).not.toHaveBeenCalled(); expect(researchInstrumentState(run).history.map(h => h.phase)).toEqual(['initialize', 'finalize']);
  });
  it('never rolls the state or best pointer back when an older committed invocation is replayed', async () => {
    await setup(); const first = await evaluate(); const second = await evaluate({ value: 25 }, 2);
    await invokeResearchInstrument(run, 'evaluate', first.candidate, 1);
    expect(researchInstrumentState(run).incumbent).toEqual(second.candidate); expect(researchInstrumentState(run).revision).toBe(3);
  });
  it('reserves a started invocation conservatively across an uncertain crash', async () => {
    await setup(); const submitted = candidate({});
    const write = files.atomicWrite;
    const failure = vi.spyOn(files, 'atomicWrite').mockImplementation((path, ...args) => {
      if (path.endsWith('/raw.json')) throw new Error('controlled receipt crash');
      return write(path, ...args);
    });
    await expect(invokeResearchInstrument(run, 'evaluate', submitted, 1)).rejects.toThrow('controlled receipt crash'); failure.mockRestore();
    const spawn = vi.spyOn(commands, 'spawnOwnedCommand');
    expect(await invokeResearchInstrument(run, 'evaluate', submitted, 1)).toMatchObject({ outcome: 'execution_error', reason: 'instrument_invocation_uncertain' });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('passes failures, rejects, no-candidate and review outcomes to finalize without fabricating observations', async () => {
    await setup(); const same = captureMeasuredCandidate(project, run, 'unchanged');
    recordResearchSubmission(run, same, 1, 'no_candidate', { summary: 'keep -999999' });
    const next = candidate({ value: 80 }, 'review');
    recordResearchSubmission(run, next, 2, 'review_rejected', {}, { pass: false, reason: 'Project criterion failed' });
    await evaluate({ fail: true }, 3);
    const manifest = await finalizeResearchInstrument(run, 'instrument_execution_error');
    expect(read(manifest.finalizer!.request!.path).history.map((h: any) => h.outcome)).toEqual(['baseline', 'no_candidate', 'review_rejected', 'execution_error']);
    expect(manifest.history[1].response).toBeUndefined(); expect(manifest.history[2].response).toBeUndefined();
  });
  it.each(['internal', 'external'])('refuses hostile %s ancestor aliases before touching unrelated777', async location => {
    await setup(config => {
      config.candidate.push('tree/input.json'); mkdirSync(join(project, 'tree')); writeFileSync(join(project, 'tree/input.json'), '100');
    });
    const evidence = join(location === 'internal' ? project : root, 'unrelated'); mkdirSync(evidence); writeFileSync(join(evidence, 'input.json'), '777');
    const submitted = candidate({ value: 1 });
    rmSync(join(project, 'tree'), { recursive: true }); symlinkSync(evidence, join(project, 'tree'));
    let refusal: unknown;
    try { restoreResearchBest(project, run); } catch (error) { refusal = error; }
    expect(readFileSync(join(evidence, 'input.json'), 'utf8')).toBe('777');
    expect(readFileSync(join(project, 'candidate.json'), 'utf8')).toBe(readFileSync(join(submitted.path, 'candidate.json'), 'utf8'));
    expect(refusal).toBeInstanceOf(Error);
  });
  it('restores missing parents and unlinks leaf aliases without modifying their targets', async () => {
    await setup(config => { config.candidate.push('tree/input.json'); mkdirSync(join(project, 'tree')); writeFileSync(join(project, 'tree/input.json'), '100'); });
    const unrelated = join(project, 'unrelated.json'); writeFileSync(unrelated, '777');
    rmSync(join(project, 'tree'), { recursive: true }); rmSync(join(project, 'candidate.json')); symlinkSync(unrelated, join(project, 'candidate.json'));
    restoreResearchBest(project, run);
    expect(readFileSync(unrelated, 'utf8')).toBe('777'); expect(read(join(project, 'candidate.json')).value).toBe(100);
    expect(readFileSync(join(project, 'tree/input.json'), 'utf8')).toBe('100');
  });
  it('refuses altered best snapshot bytes during restoration', async () => {
    await setup(); writeFileSync(join(researchInstrumentState(run).incumbent.path, 'candidate.json'), '{"value":1}');
    expect(() => restoreResearchBest(project, run)).toThrow('best candidate fingerprint mismatch');
    expect(read(join(project, 'candidate.json')).value).toBe(100);
  });
  it('refuses altered prior request/result/raw evidence', async () => {
    await setup(); const first = researchInstrumentState(run).history[0];
    writeFileSync(first.raw!.path, '{}'); expect(() => researchInstrumentState(run)).toThrow('research_record_digest_mismatch');
  });
});

describe('hard budgets and cancellation', () => {
  it('does not launch after a hard round budget is spent', async () => {
    await setup(config => { config.budget.max_rounds = 1; }); await evaluate();
    const spawn = vi.spyOn(commands, 'spawnOwnedCommand');
    expect((await evaluate({ value: 25 }, 2)).reason).toBe('research_round_budget_exhausted'); expect(spawn).not.toHaveBeenCalled();
  });
  it('does not launch when the wall budget is exhausted', async () => {
    const config = makeInstrument(project, { budget: { max_rounds: 2, wall_seconds: .001 } });
    const spawn = vi.spyOn(commands, 'spawnOwnedCommand');
    await initializeResearchInstrument(project, run, config, new Date(Date.now() - 1000).toISOString());
    expect(researchInstrumentState(run).history[0].reason).toContain('research_wall_budget_exhausted'); expect(spawn).not.toHaveBeenCalled();
  });
  it('times out and retires an owned process', async () => {
    await setup(config => { config.budget.invocation_seconds = 5; });
    const spawn = commands.spawnOwnedCommand, events: string[] = [];
    vi.spyOn(commands, 'spawnOwnedCommand').mockImplementation((cmd, args, options) => {
      const owned = spawn(cmd, args, options);
      owned.child.stderr?.on('data', data => {
        if (!String(data).includes('PID=')) return;
        events.push('ready');
        time.advanceTo(4999);
        expect(events).toEqual(['ready']);
        time.advanceTo(5000);
      });
      owned.child.once('close', () => { events.push('closed'); });
      return { ...owned, stop: () => { events.push('stop'); return owned.stop(); } };
    });
    const result = await evaluate({ sleep: true }); expect(result).toMatchObject({ outcome: 'execution_error', reason: 'instrument_timeout' });
    expect(events).toEqual(['ready', 'stop', 'closed']);
    const pid = Number(read(result.raw!.path).stderr.match(/PID=(\d+)/)?.[1]); expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('native cancellation fences settlement even when a successful response arrives late', async () => {
    await setup();
    const spawn = commands.spawnOwnedCommand;
    vi.spyOn(commands, 'spawnOwnedCommand').mockImplementation((cmd, args, options) => {
      const owned = spawn(cmd, args, options);
      owned.child.on('close', () => files.atomicWrite(join(run, 'run.json'), JSON.stringify({ storageLayout: 2, runId: 'controlled-run', status: 'cancelled' })));
      return owned;
    });
    const result = await evaluate();
    expect(result).toMatchObject({ outcome: 'execution_error', reason: 'research_cancelled' });
    expect(result.response?.verdict).toBe('keep'); // retained evidence, no authority
    expect(researchInstrumentState(run).incumbent).toEqual(researchInstrumentState(run).initial);
    expect(researchInstrumentState(run).instrumentState).toEqual(researchInstrumentState(run).history[0].response?.next_state);
  });
  it('cancellation retires an owned process and cannot bank a late verdict', async () => {
    await setup(); const controller = new AbortController(); vi.spyOn(commands, 'runProcessAbortSignal').mockReturnValue(controller.signal);
    const spawn = commands.spawnOwnedCommand, events: string[] = [];
    vi.spyOn(commands, 'spawnOwnedCommand').mockImplementation((cmd, args, options) => {
      const owned = spawn(cmd, args, options);
      owned.child.stderr?.on('data', data => { if (String(data).includes('PID=')) { events.push('ready'); controller.abort(); } });
      owned.child.once('close', () => { events.push('closed'); });
      return { ...owned, stop: () => { events.push('stop'); return owned.stop(); } };
    });
    controller.signal.addEventListener('abort', () => { events.push('abort'); }, { once: true });
    const result = await evaluate({ sleep: true }); expect(result).toMatchObject({ outcome: 'execution_error', reason: 'research_cancelled' });
    expect(events).toEqual(['ready', 'abort', 'stop', 'closed']);
    const pid = Number(read(result.raw!.path).stderr.match(/PID=(\d+)/)?.[1]); expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(); expect(read(join(researchInstrumentState(run).incumbent.path, 'candidate.json')).value).toBe(100);
  });
});

it('uses the existing engine carrier protection for new requests, records and future files', async () => {
  await setup();
  for (const path of ['research_measurement/state.json', 'research_measurement/invocations/evaluate-1/request.json', 'research_manifest.json']) {
    expect(producesEngineOwnedArtifact({ id: 'forged', root: 'run', path: 'engine/' + path, kind: 'file' }, { id: 'author', depends_on: [] }, run, project)).toBe(true);
  }
  await expect(withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'author' }, async () => {
    writeFileSync(join(researchDirectory(run), 'instrument/instrument/config.json'), '{}');
  })).rejects.toThrow('ENGINE_STATE_TAMPERED');
  expect(read(join(researchDirectory(run), 'instrument/instrument/config.json')).value).toBe(100);
});
it('refuses active protocol execution in a historical layout without changing its records', async () => {
  run = join(root, 'legacy-layout'); mkdirSync(run);
  const record = JSON.stringify({ runId: 'historical-run', research: { baseline: 100 } });
  writeFileSync(join(run, 'run.json'), record);
  const spawn = vi.spyOn(commands, 'spawnOwnedCommand');
  await expect(initializeResearchInstrument(project, run, makeInstrument(project))).rejects.toThrow('RUN_LAYOUT_INCOMPATIBLE');
  expect(spawn).not.toHaveBeenCalled(); expect(readFileSync(join(run, 'run.json'), 'utf8')).toBe(record);
  expect(existsSync(join(run, 'research_measurement'))).toBe(false);
});
it('requires the explicit protocol and refuses scientific legacy declarations', () => {
  expect(parseBriefFrontmatter('---\nresearch: {measurement: {replicates: 2}, stop: {max_rounds: 3}}\n---\nTry candidates.').researchPolicyError).toContain('research-instrument/v1');
  const config = makeInstrument(project);
  expect(ResearchInstrumentSchema.safeParse({ ...config, threshold: 2 }).success).toBe(false);
});
