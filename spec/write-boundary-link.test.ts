import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execWithStdin } from '../src/adapters/base.js';
import { withEngineWriteBoundary } from '../src/write-boundary.js';
import * as boundary from '../src/write-boundary.js';
import { createRun, fcGlobalDir, readRunState, setFcGlobalDir, writeRunState, writeStageStatus } from '../src/store.js';
import { Supervisor } from '../src/supervisor.js';
import { recordRunEvent } from '../src/run-events.js';
import * as validation from '../src/project-validation.js';
import { recordGateValidationDelta } from '../src/scheduler/sched_settlement/gate-validation.js';

const roots: string[] = [];
const previousGlobal = fcGlobalDir();
afterEach(() => {
  setFcGlobalDir(previousGlobal);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'boundary-link-')); roots.push(root);
  const projectDir = join(root, 'project'); mkdirSync(projectDir);
  setFcGlobalDir(join(root, 'store'));
  const created = createRun(projectDir, 'link fixture', 'name: link\nstages: []\n', ['review']);
  const runDir = created.runDirPath, stageId = 'review';
  const baseline = join(runDir, 'stages/repair/evidence/baseline-project');
  const target = join(projectDir, 'node_modules');
  mkdirSync(baseline, { recursive: true }); mkdirSync(target);
  const link = join(baseline, 'node_modules'); symlinkSync(target, link, 'dir');
  const recorded = join(baseline, 'recorded.json'), linked = join(target, 'recorded.js');
  writeFileSync(recorded, 'earlier evidence'); writeFileSync(linked, 'earlier linked input');
  // A reference back to the directory must not trigger recursive traversal.
  symlinkSync(target, join(target, 'cycle'), 'dir');
  const artifactContract = { version: 1 as const, produces: [{ id: 'out', root: 'run' as const,
    path: 'stages/review/evidence', kind: 'directory' as const }], reads: [], groups: [], replays: [] };
  const input = { projectDir, runDir, stageId, attemptIndex: 1, artifactContract };
  const output = join(runDir, 'stages/review/evidence');
  const command = (code: string, abortSignal?: AbortSignal) => execWithStdin(process.execPath, ['-e', code], '',
    { cwd: projectDir, timeout_ms: 2500, abortSignal, captureStreams: true });
  const receipts = () => {
    const path = join(runDir, 'stages/review/write_boundary_attempt_1.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  return { ...input, root, runId: created.runId, input, target, link, recorded, linked, output, command, receipts };
}

describe.skipIf(process.platform !== 'linux')('earlier-stage directory links', () => {
  it('launches a later project writer without granting writes to earlier recorded inodes', async () => {
    const f = fixture(), baseline = join(f.runDir, 'stages/repair/evidence/baseline-project');
    const originalLink = lstatSync(f.link), originalFile = lstatSync(f.recorded);
    const result = await withEngineWriteBoundary({ ...f.input, projectWriteScope: ['**'] }, () => f.command(`
      const fs=require('node:fs');const denied=[];
      const recorded=${JSON.stringify(f.recorded)}, link=${JSON.stringify(f.link)}, baseline=${JSON.stringify(baseline)};
      for(const action of [
        ()=>fs.writeFileSync(recorded,'bad'),()=>fs.unlinkSync(recorded),()=>fs.renameSync(recorded,recorded+'.moved'),
        ()=>fs.unlinkSync(link),()=>fs.renameSync(link,link+'.moved'),()=>fs.symlinkSync('/replacement',link),
        ()=>fs.renameSync(baseline,baseline+'.moved'),()=>fs.writeFileSync(baseline+'/new','bad'),
        ()=>fs.linkSync(recorded,${JSON.stringify(join(f.output, 'alias'))})
      ]) {try{action();denied.push(false)}catch(e){denied.push(['EACCES','EXDEV','EEXIST'].includes(e.code))}}
      fs.writeFileSync(${JSON.stringify(f.linked)},'later writer');
      fs.writeFileSync(link+'/through-link','later writer through reference');
      fs.writeFileSync(${JSON.stringify(join(f.output, 'result'))},'writer ran');
      console.log(JSON.stringify(denied));
    `));
    expect(result.exitCode, result.output).toBe(0);
    expect(result.writeBoundary?.kind).toBe('installed');
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout!)).toEqual(Array(9).fill(true));
    expect(f.receipts().map(row => row.kind)).toEqual(['installed']);
    expect(readFileSync(f.linked, 'utf8')).toBe('later writer');
    expect(readFileSync(join(f.target, 'through-link'), 'utf8')).toBe('later writer through reference');
    expect(readFileSync(f.recorded, 'utf8')).toBe('earlier evidence');
    expect(lstatSync(f.recorded).ino).toBe(originalFile.ino);
    expect(lstatSync(f.link).ino).toBe(originalLink.ino);
    expect(readlinkSync(f.link)).toBe(f.target);
    expect(readFileSync(join(f.output, 'result'), 'utf8')).toBe('writer ran');
  });

  it.each([
    ['stages/repair', 'ENOENT'], ['stages/repair', 'ENOTDIR'],
    ['signals', 'ENOENT'], ['signals', 'ENOTDIR'],
  ] as const)('retries a listed protected member that vanishes during inspection (%s, %s)', async (tree, code) => {
    const f = fixture(), folder = join(f.runDir, tree, 'churn');
    mkdirSync(folder, { recursive: true });
    const member = join(folder, `.listed-churn-${code}`); writeFileSync(member, 'transient');
    // Change a real fixture entry exactly between listing and lstat; do not
    // depend on a timer racing the launcher's tree walk or any personal run.
    const confine = boundary.confineEngineChild;
    vi.spyOn(boundary, 'confineEngineChild').mockImplementation((...args) => {
      const launch = confine(...args);
      launch.args[4] = `
import os
_lstat = os.lstat
_churn_path = ${JSON.stringify(member)}
_churn_fired = False
def _churn_lstat(path, *args, **kwargs):
    global _churn_fired
    if path == _churn_path and not _churn_fired:
        _churn_fired = True
        os.unlink(path)
        if ${code === 'ENOTDIR' ? 'True' : 'False'}:
            os.rmdir(os.path.dirname(path))
            with open(os.path.dirname(path), 'w') as output: output.write('replaced directory')
    return _lstat(path, *args, **kwargs)
os.lstat = _churn_lstat
` + launch.args[4];
      return launch;
    });
    const result = await withEngineWriteBoundary(f.input, () => f.command(`require('node:fs').writeFileSync(${JSON.stringify(join(f.output, 'result'))},'ran after churn')`));
    expect(result.exitCode, result.output).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.writeBoundary?.kind).toBe('installed');
    expect(f.receipts().map(row => row.kind)).toEqual(['waiting', 'installed']);
    expect(f.receipts()[0].message).toContain(member);
    expect(readFileSync(join(f.output, 'result'), 'utf8')).toBe('ran after churn');
    expect(existsSync(member)).toBe(false);
  });

  it('launches later read-only stages and denies every route to recorded files', async () => {
    const f = fixture();
    const result = await withEngineWriteBoundary(f.input, () => f.command(`
      const fs=require('node:fs');const denied=[];
      for(const p of ${JSON.stringify([f.recorded, f.linked, join(f.link, 'recorded.js')])}) {
        for(const action of [()=>fs.writeFileSync(p,'bad'),()=>fs.unlinkSync(p),()=>fs.renameSync(p,p+'.moved')]) {
          try{action();denied.push(false)}catch(e){denied.push(e.code==='EACCES')}
        }
      }
      fs.writeFileSync(${JSON.stringify(join(f.output, 'result'))},'review ran');
      console.log(JSON.stringify(denied));
    `));
    expect(result.exitCode, result.output).toBe(0);
    expect(result.writeBoundary?.kind).toBe('installed');
    expect(JSON.parse(result.stdout!)).toEqual(Array(9).fill(true));
    expect(f.receipts().map(row => row.kind)).toEqual(['installed']);
    expect(readFileSync(f.recorded, 'utf8')).toBe('earlier evidence');
    expect(readFileSync(f.linked, 'utf8')).toBe('earlier linked input');
    expect(readFileSync(join(f.output, 'result'), 'utf8')).toBe('review ran');
  });

  it.each(['overlap', 'hardlink', 'symlink-hardlink', 'dangling'] as const)('ends permanent %s refusal before execution with conflicting paths', async mode => {
    const f = fixture();
    if (mode === 'dangling') rmSync(f.target, { recursive: true });
    if (mode === 'overlap') linkSync(f.recorded, join(f.target, 'alias.json'));
    const input = mode === 'overlap' ? { ...f.input, projectWriteScope: ['**'] } : f.input;
    const marker = join(f.output, 'ran');
    const result = await withEngineWriteBoundary(input, () => {
      // Insert after declaration admission to exercise the launcher's inode
      // check rather than the contract's earlier alias check.
      if (mode === 'hardlink' || mode === 'symlink-hardlink') linkSync(mode === 'hardlink' ? f.recorded : f.link, join(f.output, 'alias'));
      return f.command(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`);
    });
    expect(result.exitCode, result.output).toBe(125);
    expect(result.timedOut).toBe(false);
    expect(result.writeBoundary).toMatchObject({ kind: 'refused', message: expect.stringContaining(mode === 'dangling' || mode === 'symlink-hardlink' ? f.link : f.recorded) });
    expect(result.output).toContain(mode === 'hardlink' || mode === 'symlink-hardlink' ? f.output : f.target);
    expect(f.receipts().map(row => row.kind)).toEqual(['refused']);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(f.recorded, 'utf8')).toBe('earlier evidence');
    if (mode === 'overlap') expect(readFileSync(f.linked, 'utf8')).toBe('earlier linked input');
  });

  it('binds gate-validation waits to the reviewing attempt before launching its commands', async () => {
    const f = fixture(), startedAt = new Date().toISOString(), abort = new AbortController();
    // Recorded-inode conflicts have their own permanent-refusal tests above.
    // Here leave a self-clearing hard-link prerequisite for configured validation.
    unlinkSync(f.link);
    const member = join(f.projectDir, 'member'); writeFileSync(member, 'original'); linkSync(member, join(f.root, 'outside'));
    writeStageStatus(f.projectDir, f.runId, 'review', { status: 'running', retries: 0,
      attempts: [{ index: 3, startedAt, status: 'running' }] });
    const baseline = await validation.runProjectValidationBaseline(f.projectDir, {
      commands: [{ role: 'test', command: process.execPath, args: ['-e', ''], display: 'probe' }],
      runCommand: () => ({ exitCode: 0 }),
    });
    writeFileSync(join(f.runDir, 'validation_baseline.json'), JSON.stringify({ version: 1, source: 'ship-setup-ready-record', baseline }));
    const execution = recordGateValidationDelta(f.projectDir, f.runId, 'review', {
      abortSignal: abort.signal, remainingMs: () => 2500,
    });
    try {
      await vi.waitFor(() => {
        const events = readFileSync(join(f.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(events).toContainEqual(expect.objectContaining({ type: 'stage_environment_wait_started',
          stageId: 'review', attemptIndex: 3, attemptStartedAt: startedAt, detail: expect.stringContaining(member) }));
      }, { timeout: 2000 });
    } finally { abort.abort(); await execution; }
    const events = readFileSync(join(f.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage_environment_wait_finished',
      stageId: 'review', attemptIndex: 3, attemptStartedAt: startedAt }));
  });

  it('attributes a watchdog abort to the current pre-execution wait and drops cleared or stale waits', async () => {
    const f = fixture(), abort = new AbortController();
    mkdirSync(f.output, { recursive: true });
    const member = join(f.output, 'member'); writeFileSync(member, 'original'); linkSync(member, join(f.root, 'outside'));
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const status = { status: 'running' as const, retries: 0, startedAt,
      attempts: [{ index: 1, startedAt, status: 'running' as const }] };
    const state = readRunState(f.projectDir, f.runId); state.stages.review = status;
    writeRunState(f.projectDir, f.runId, state); writeStageStatus(f.projectDir, f.runId, 'review', status);
    const run = vi.fn();
    const supervisor = new Supervisor(f.projectDir, f.runId, { run }, {
      enabled: true, adapter: 'fake', model: 'fake', reasoningEffort: 'low', pollIntervalMs: 30_000,
      routineAssessmentIntervalMs: 180_000, cooldownAfterActionMs: 0, maxAssessmentsPerIteration: 20,
      tailBytes: 16384, minDeltaBytes: 4096, stuckThresholdMs: 1000,
    }, 'fixture') as unknown as {
      stageLastProgressMs: Record<string, number>;
      writeVerifiedAbort(stageId: string, source: 'watchdog', basis: { kind: 'idle'; stalledMs: number },
        reason: undefined, sinceMs: number): { written: boolean; reason: string };
    };
    supervisor.stageLastProgressMs = { review: Date.now() - 10_000 };
    const verify = () => supervisor.writeVerifiedAbort('review', 'watchdog', { kind: 'idle', stalledMs: 10_000 }, undefined, Date.now() + 60_000);
    const execution = withEngineWriteBoundary(f.input, () => f.command("throw new Error('must not execute')", abort.signal));
    try {
      await vi.waitFor(() => expect(f.receipts().some(row => row.kind === 'waiting')).toBe(true), { timeout: 2000 });
      const waiting = f.receipts().find(row => row.kind === 'waiting');
      const decision = verify();
      expect(decision.written).toBe(true);
      const signal = JSON.parse(readFileSync(join(f.runDir, 'signals/abort_review.json'), 'utf8'));
      expect(signal.reason).toContain('pre_execution environment wait');
      expect(signal.reason).toContain(waiting.message);
      expect(signal.reason).not.toContain('no verified live/artifact/transition progress');
      expect(run).not.toHaveBeenCalled();
    } finally { abort.abort(); await execution; }
    // Closed launchers and another attempt's wait must not label this abort.
    recordRunEvent(f.projectDir, f.runId, { type: 'stage_environment_wait_started', stageId: 'review', attemptIndex: 2, detail: 'stale other attempt' });
    const cleared = verify();
    expect(cleared.written).toBe(true);
    expect(cleared.reason).toContain('no verified live/artifact/transition progress');
    expect(cleared.reason).not.toContain('environment wait');
  });
});
