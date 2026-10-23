import { atomicWrite } from '../src/engine-fs.js';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as engineFs from '../src/engine-fs.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { createRun } from './test-support/create-run.js';
import { fcGlobalDir, readRunState, setFcGlobalDir, updateRunState } from '../src/store.js';
import { StageWatchdog } from '../src/stage-watchdog.js';

import { runStage } from '../src/worker.js';
import { execWithStdin, type Adapter, type AgentConfig } from '../src/adapters/base.js';
import { runWorkflow } from '../src/scheduler.js';

let root: string, project: string, run: string, runId: string, previous: string;
const contract = { version: 1 as const, produces: [], reads: [], groups: [] };
const role: AgentConfig = { name: 'fixture', description: '', model: 'default', reasoning_effort: 'low', tools: [], prompt: '' };
const input = () => ({ projectDir: project, runDir: run, stageId: 'work', artifactContract: contract });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-carrier-writers-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'state')); ({ runId, runDirPath: run } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']));
});
afterEach(() => { setFcGlobalDir(previous); rmSync(root, { recursive: true, force: true }); });

describe('engine carrier writers', () => {
  it('keeps watchdog progress consistent through a real stage', async () => {
    const watchdog = new StageWatchdog(project, runId, { idleThresholdMs: 600_000 });
    const progress = join(run, 'stage_watchdog.json');
    const adapter: Adapter = { async run() {
      await watchdog.tick();
      return { exitCode: 0, output: 'completed', duration_ms: 0 };
    } };
    const result = await runStage(adapter, { stageId: 'work', projectDir: project, runDir: run, runId,
      role, dependsOn: [], promptTemplate: 'Complete work', timeout_ms: 10000, retries: 0, artifactContract: contract });
    expect(result.exitCode).toBe(0);
    expect(readRunState(project, runId).stages.work.status).toBe('complete');
    expect(JSON.parse(readFileSync(progress, 'utf8')).stageProgress.work.attemptIndex).toBe(1);
  });

  it.each(['delete', 'directory'])('rejects child tampering before a parent rename is acknowledged (%s)', async mode => {
    const carrier = join(run, 'stage_watchdog.json');
    writeFileSync(carrier, 'trusted');
    const rename = fs.renameSync;
    let armed = true;
    // Hold the native rename's return until the real child acknowledges its
    // mutation: this selects the publication race without clocks or polling.
    fs.renameSync = (source, destination) => {
      rename(source, destination);
      if (armed && String(destination) === carrier) {
        armed = false;
        execFileSync(process.execPath, ['-e', `const fs=require('node:fs');fs.rmSync(${JSON.stringify(carrier)});${mode === 'directory' ? `fs.mkdirSync(${JSON.stringify(carrier)});fs.symlinkSync(${JSON.stringify(join(project, 'ordinary'))},${JSON.stringify(carrier + '.integrity-restore')});` : ''}`],
          { cwd: project, env: { HOME: root, FC_HOME: join(root, 'state') }, timeout: 5000, stdio: 'ignore' });
      }
    };
    syncBuiltinESMExports();
    try {
      await expect(withEngineIntegrity(input(), async () => { atomicWrite(carrier, 'parent replacement'); }))
        .rejects.toThrow('ENGINE_STATE_TAMPERED');
      expect(readFileSync(carrier, 'utf8')).toBe('parent replacement');
      expect(existsSync(join(project, 'ordinary'))).toBe(false);
    } finally {
      fs.renameSync = rename;
      syncBuiltinESMExports();
    }
  });

  it('does not adopt child tampering after a failed parent publication', async () => {
    const carrier = join(run, 'verdict_previous.json');
    writeFileSync(carrier, 'trusted');
    await expect(withEngineIntegrity(input(), async () => {
      expect(() => engineFs.publishEngineFiles([carrier], () => {
        execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(carrier)}, 'counterfeit');process.exit(1)`],
          { cwd: project, env: { ...process.env, HOME: root, FC_HOME: join(root, 'state') }, timeout: 5000, stdio: 'ignore' });
      })).toThrow();
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(readFileSync(carrier, 'utf8')).toBe('trusted');
  });

  it('protects parent cancellation records beneath the signals directory', async () => {
    const signals = join(run, 'signals'), cancellation = join(signals, 'abort_work.json');
    await expect(withEngineIntegrity(input(), async () => {
      engineFs.mkdirSync(signals, { recursive: true });
      engineFs.writeFileSync(cancellation, 'trusted cancellation');
      writeFileSync(cancellation, 'counterfeit cancellation');
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(readFileSync(cancellation, 'utf8')).toBe('trusted cancellation');
  });

  it('keeps the trusted record when a child writes between post-publication stat and retention', async () => {
    const carrier = join(run, 'stage_watchdog.json'); writeFileSync(carrier, 'trusted');
    const lstat = fs.lstatSync;
    let armed = false;
    fs.lstatSync = ((...args: Parameters<typeof lstat>) => {
      const value = lstat(...args);
      if (armed && String(args[0]) === carrier) { armed = false; writeFileSync(carrier, 'counterfeit'); }
      return value;
    }) as typeof lstat;
    syncBuiltinESMExports();
    try {
      await expect(withEngineIntegrity(input(), async () => {
        engineFs.publishEngineFiles([carrier], () => { writeFileSync(carrier, 'parent'); armed = true; });
      })).rejects.toThrow('ENGINE_STATE_TAMPERED');
      expect(readFileSync(carrier, 'utf8')).toBe('trusted');
    } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
  });

  it('normalizes an unacknowledged history tail while a stage is guarded', async () => {
    const history = join(run, 'run-history.jsonl');
    writeFileSync(history, 'torn unacknowledged append');
    await withEngineIntegrity(input(), async () => {
      updateRunState(project, runId, state => { state.taskDescription = 'parent update'; });
    });
    expect(readFileSync(history, 'utf8')).toBe('');
    expect(readRunState(project, runId).taskDescription).toBe('parent update');
  });

  it('publishes descriptor, URL, copy, rename and recursive deletion writes during a stage', async () => {
    const directory = join(run, 'discarded', 'original'), renamed = join(run, 'discarded', 'renamed');
    await withEngineIntegrity(input(), async () => {
      engineFs.mkdirSync(directory, { recursive: true });
      const fd = engineFs.openSync(join(directory, 'record'), 'w+');
      try { engineFs.writeFileSync(fd, 'parent'); engineFs.writeSync(fd, ' append'); engineFs.ftruncateSync(fd, 6); }
      finally { engineFs.closeSync(fd); }
      engineFs.copyFileSync(join(directory, 'record'), join(directory, 'copy'));
      engineFs.renameSync(directory, renamed);
      engineFs.cpSync(renamed, directory, { recursive: true });
      engineFs.appendFileSync(pathToFileURL(join(renamed, 'record')), ' URL');
      engineFs.rmSync(directory, { recursive: true });
    });
    expect(readFileSync(join(renamed, 'record'), 'utf8')).toBe('parent URL');
    expect(existsSync(directory)).toBe(false);
  });

  it.each([false, true])('rejects a forged journal and restores trusted bytes (defer detection by restoring size and mtime: %s)', async restoreTime => {
    const history = join(run, 'run-history.jsonl'); writeFileSync(history, 'trusted');
    if (restoreTime) fs.utimesSync(history, 1, 1);
    await expect(withEngineIntegrity(input(), async () => {
      const fd = engineFs.openSync(history, 'a');
      try {
        const before = fs.statSync(history);
        writeFileSync(history, restoreTime ? 'forgery' : 'counterfeit');
        if (restoreTime) fs.utimesSync(history, before.atime, before.mtime);
        if (restoreTime) engineFs.writeSync(fd, 'parent');
        else expect(() => engineFs.writeSync(fd, 'parent')).toThrow('ENGINE_STATE_TAMPERED');
      } finally { engineFs.closeSync(fd); }
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(readFileSync(history, 'utf8')).toBe(restoreTime ? 'trustedparent' : 'trusted');
    engineFs.appendFileSync(history, ' settlement');
    expect(readFileSync(history, 'utf8')).toBe((restoreTime ? 'trustedparent' : 'trusted') + ' settlement');
  });

  it('accepts a parent URL rename between hardlinks to the same carrier', async () => {
    const source = join(run, 'verdict_previous.json'), destination = join(run, 'verdict_alias.json');
    writeFileSync(source, 'trusted');
    fs.linkSync(source, destination);
    await withEngineIntegrity(input(), async () => {
      engineFs.renameSync(pathToFileURL(source), pathToFileURL(destination));
    });
    expect(readFileSync(source, 'utf8')).toBe('trusted');
    expect(readFileSync(destination, 'utf8')).toBe('trusted');
  });

  it('publishes parent writes through a protected carrier link', async () => {
    const target = join(root, 'record'); writeFileSync(target, 'original');
    const carrier = join(run, 'verdict_previous.json'); symlinkSync(target, carrier);
    await withEngineIntegrity(input(), async () => { engineFs.writeFileSync(carrier, 'parent'); });
    expect(readFileSync(carrier, 'utf8')).toBe('parent');
  });

  it('restores deleted carrier directories and their records before settlement', async () => {
    const record = join(run, 'stages', 'previous', 'status.json');
    mkdirSync(join(run, 'stages', 'previous')); writeFileSync(record, '{"status":"complete"}');
    await expect(withEngineIntegrity(input(), async () => {
      await execWithStdin(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(run)}, {recursive:true})`], '', { cwd: project, timeout_ms: 5000 });
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(readFileSync(record, 'utf8')).toBe('{"status":"complete"}');
    expect(readRunState(project, runId).runId).toBe(runId);
  });

  it('settles an unexpected admitted scheduler error as failed with a reason', async () => {
    mkdirSync(join(project, 'agents')); writeFileSync(join(project, 'agents', '_base.md'), 'Base prompt');
    const brokenRole = { ...role, get prompt(): string { throw new Error('fixture setup failure'); } };
    const state = await runWorkflow({ name: 'fixture', description: '', defaults: {}, stages: [] },
      'name: fixture\nstages: []\n', project, { async run() { throw new Error('must not launch'); } },
      new Map([['fixture', brokenRole]]), undefined, join(project, 'agents'), runId);
    expect(state.status).toBe('failed');
    expect(state.failureReason).toContain('fixture setup failure');
    expect(readRunState(project, runId).status).toBe('failed');
  });

  it('refuses child truncation before a parent append returns and restores the trusted journal', async () => {
    const carrier = join(run, 'run-history.jsonl'); writeFileSync(carrier, 'trusted prefix');
    const append = fs.appendFileSync;
    fs.appendFileSync = ((target, ...args) => {
      append(target, ...args);
      if (String(target) === carrier) {
        execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(carrier)}, 'forged')`],
          { cwd: project, env: { ...process.env, HOME: root, FC_HOME: join(root, 'state') }, timeout: 5000, stdio: 'ignore' });
      }
    }) as typeof append;
    syncBuiltinESMExports();
    try {
      await expect(withEngineIntegrity(input(), async () => { engineFs.appendFileSync(carrier, 'parent tail'); }))
        .rejects.toThrow('ENGINE_STATE_TAMPERED');
      expect(readFileSync(carrier, 'utf8')).toBe('trusted prefix');
    } finally { fs.appendFileSync = append; syncBuiltinESMExports(); }
    engineFs.appendFileSync(carrier, ' settlement');
    expect(readFileSync(carrier, 'utf8')).toBe('trusted prefix settlement');
  });

  it('rejects matching forged carrier and recovery bytes without adopting the backup identity', async () => {
    const carrier = join(run, 'stage_watchdog.json'); writeFileSync(carrier, 'trusted');
    const copy = fs.copyFileSync;
    let recovery: string | undefined;
    fs.copyFileSync = ((source, destination, ...options) => {
      copy(source, destination, ...options);
      if (String(source) === carrier) recovery = String(destination);
    }) as typeof copy;
    syncBuiltinESMExports();
    try {
      await expect(withEngineIntegrity(input(), async () => {
        expect(recovery).toBeDefined();
        writeFileSync(carrier, 'forgery');
        writeFileSync(recovery!, 'forgery');
      })).rejects.toThrow('ENGINE_STATE_TAMPERED');
      // Destroyed recovery bytes cannot be presented as restored trusted state.
      expect(readFileSync(carrier, 'utf8')).toBe('forgery');
    } finally { fs.copyFileSync = copy; syncBuiltinESMExports(); }
  });

  it('enforces the filesystem boundary for new raw imports and dynamic access', async () => {
    const eslint = new ESLint();
    for (const code of [
      "import { writeFileSync } from 'node:fs'; writeFileSync('run.json', 'x');",
      "import { openSync, writeSync } from 'node:fs'; writeSync(openSync('run.json', 'a'), 'x');",
      "import * as fs from 'node:fs'; fs.rmSync('run.json');",
      "import { writeFile } from 'node:fs/promises'; await writeFile('run.json', 'x');",
      "const fs = await import('node:fs'); fs.mkdirSync('stages');",
      "const fs = require('node:fs'); fs.copyFileSync('x', 'run.json');",
      "import { DatabaseSync } from 'node:sqlite'; new DatabaseSync('run-index.sqlite');",
      "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync('run-index.sqlite');",
    ]) {
      const [result] = await eslint.lintText(code, { filePath: 'src/carrier-boundary-probe.ts' });
      expect(result.messages.some(message => message.ruleId?.startsWith('no-restricted-')), code).toBe(true);
    }
    const [allowed] = await eslint.lintText("import { writeFileSync } from './engine-fs.js'; writeFileSync('run.json', 'x');",
      { filePath: 'src/carrier-boundary-probe.ts' });
    expect(allowed.errorCount).toBe(0);
  });
});
