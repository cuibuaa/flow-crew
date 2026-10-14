import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as engineFs from '../src/engine-fs.js';
import { withEngineIntegrity } from '../src/engine-integrity.js';
import { createRun, fcGlobalDir, readRunState, setFcGlobalDir, updateRunState } from '../src/store.js';
import { StageWatchdog } from '../src/stage-watchdog.js';
import { resetConfigCache } from '../src/config.js';
import { runStage } from '../src/worker.js';
import { execWithStdin, type Adapter, type AgentConfig } from '../src/adapters/base.js';
import { runWorkflow } from '../src/scheduler.js';

let root: string, project: string, run: string, runId: string, previous: string;
const contract = { version: 1 as const, produces: [], reads: [], groups: [], replays: [] };
const role: AgentConfig = { name: 'fixture', description: '', model: 'default', reasoning_effort: 'low', tools: [], prompt: '' };
const input = () => ({ projectDir: project, runDir: run, stageId: 'work', artifactContract: contract });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-carrier-writers-'));
  project = join(root, 'project'); mkdirSync(project);
  previous = fcGlobalDir(); setFcGlobalDir(join(root, 'state')); resetConfigCache();
  ({ runId, runDirPath: run } = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['work']));
});
afterEach(() => { setFcGlobalDir(previous); resetConfigCache(); rmSync(root, { recursive: true, force: true }); });

describe('engine carrier writers', () => {
  it.each(['none', 'delete', 'directory'])('keeps watchdog progress consistent through a real stage (tamper=%s)', async mode => {
    const tamper = mode !== 'none';
    const watchdog = new StageWatchdog(project, runId, { idleThresholdMs: 600_000, pollIntervalMs: 50 });
    const progress = join(run, 'stage_watchdog.json');
    const adapter: Adapter = { async run() {
      const deadline = Date.now() + 5000;
      while (!existsSync(progress)) {
        if (Date.now() > deadline) throw new Error('Watchdog never observed the held stage');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return execWithStdin(process.execPath, ['-e', tamper
        ? `const fs=require('node:fs');fs.rmSync(${JSON.stringify(progress)});${mode === 'directory' ? `fs.mkdirSync(${JSON.stringify(progress)});fs.symlinkSync(${JSON.stringify(join(project, 'ordinary'))},${JSON.stringify(progress + '.integrity-restore')});` : ''}console.log('completed')`
        : "console.log('completed')"], '', { cwd: project, timeout_ms: 5000 });
    } };
    watchdog.start();
    try {
      const result = await runStage(adapter, { stageId: 'work', projectDir: project, runDir: run, runId,
        role, dependsOn: [], promptTemplate: 'Complete work', timeout_ms: 10000, retries: 0, artifactContract: contract });
      expect(result.exitCode).toBe(tamper ? 125 : 0);
      if (tamper) expect(result.output).toContain('ENGINE_STATE_TAMPERED');
      expect(readRunState(project, runId).stages.work.status).toBe(tamper ? 'failed' : 'complete');
      expect(JSON.parse(readFileSync(progress, 'utf8')).stageProgress.work.attemptIndex).toBe(1);
      expect(existsSync(join(project, 'ordinary'))).toBe(false);
    } finally { watchdog.stop(); }
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

  it('checks a carrier before a descriptor append can hide child tampering', async () => {
    const history = join(run, 'run-history.jsonl'); writeFileSync(history, 'trusted');
    await expect(withEngineIntegrity(input(), async () => {
      const fd = engineFs.openSync(history, 'a');
      try {
        writeFileSync(history, 'counterfeit');
        expect(() => engineFs.writeSync(fd, 'parent')).toThrow('ENGINE_STATE_TAMPERED');
      } finally { engineFs.closeSync(fd); }
    })).rejects.toThrow('ENGINE_STATE_TAMPERED');
    expect(readFileSync(history, 'utf8')).toBe('trusted');
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
