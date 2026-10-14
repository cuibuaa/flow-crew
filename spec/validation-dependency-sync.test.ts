import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProjectValidationBaseline, runValidationCommand, type ProjectValidationBaseline } from '../src/project-validation.js';
import {
  gateValidationRefusal,
  recordGateValidationDelta,
  settleGateValidationEvidence,
} from '../src/scheduler/sched_settlement/gate-validation.js';
import { createRun, fcGlobalDir, setFcGlobalDir, writeStageStatus } from '../src/store.js';

const repository = resolve(import.meta.dirname, '..');
const temporary: string[] = [];
const previousStore = fcGlobalDir();
const roles = ['build', 'test', 'lint'] as const;

afterEach(() => {
  setFcGlobalDir(previousStore);
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(mode: 'root' | 'shell' | 'child-process' = 'root') {
  const root = mkdtempSync(join(repository, '.validation-dependencies-'));
  temporary.push(root);
  const project = join(root, 'project');
  const nested = mode !== 'root';
  const packageDir = nested ? join(project, 'ui') : project;
  const home = join(root, 'home');
  const cache = join(root, 'cache');
  const userConfig = join(root, 'npmrc');
  for (const directory of [project, packageDir, home, cache, join(packageDir, 'vendor', 'fixture-value')]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(userConfig, '');
  const npmConfig = `offline=true\nignore-scripts=true\naudit=false\nfund=false\ncache=${cache}\n`;
  for (const directory of new Set([project, packageDir])) writeFileSync(join(directory, '.npmrc'), npmConfig);
  const scripts = Object.fromEntries(roles.map(role => [role, 'node --test --test-reporter=tap verify.mjs']));
  const manifest = { name: 'validation-fixture', version: '1.0.0', private: true, scripts };
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest));
  if (nested) {
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      ...manifest, scripts: Object.fromEntries(roles.map(role => [role, mode === 'shell'
        ? `cd ui && npm run ${role}` : `node validation.mjs ${role}`])),
    }));
    if (mode === 'child-process') writeFileSync(join(project, 'validation.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      "const result = spawnSync('npm', ['run', process.argv[2]], { cwd: 'ui', stdio: 'inherit' });",
      'process.exit(result.status ?? 1);',
    ].join('\n'));
  }
  writeFileSync(join(packageDir, 'verify.mjs'), "console.log('configured validation passed');\n");
  writeFileSync(join(packageDir, 'vendor', 'fixture-value', 'package.json'), JSON.stringify({
    name: 'fixture-value', version: '1.0.0', type: 'module', exports: './index.mjs',
  }));
  writeFileSync(join(packageDir, 'vendor', 'fixture-value', 'index.mjs'), 'export const value = 42;\n');
  const npm = async (args: string[], directory = packageDir) => {
    const result = await runValidationCommand({ role: 'build', command: 'npm', args,
      display: `fixture npm ${args.join(' ')}`, cwd: directory, prepareDependencies: false,
      env: { ...process.env, HOME: home, npm_config_cache: cache, npm_config_userconfig: userConfig } });
    expect(result.exitCode, result.error ?? result.stderr).toBe(0);
  };
  const lock = async (directory = packageDir) => {
    await npm(['install', '--package-lock-only', '--ignore-scripts', '--offline'], directory);
    return readFileSync(join(directory, 'package-lock.json'), 'utf8');
  };
  const originalLock = await lock();
  if (nested) await lock(project);
  setFcGlobalDir(join(root, 'state'));
  return {
    project,
    packageDir,
    originalLock,
    install: () => npm(['ci', '--ignore-scripts', '--offline']),
    async addDependency() {
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        ...manifest, dependencies: { 'fixture-value': 'file:vendor/fixture-value' },
      }));
      await lock();
      writeFileSync(join(packageDir, 'verify.mjs'), [
        "import assert from 'node:assert/strict';",
        "import { value } from 'fixture-value';",
        'assert.equal(value, 42);',
        "console.log('locked dependency validation passed');",
      ].join('\n'));
    },
  };
}

function gate(project: string, baseline: ProjectValidationBaseline) {
  const created = createRun(project, 'fixture', 'name: fixture\nstages: []\n', ['review']);
  writeFileSync(join(created.runDirPath, 'validation_baseline.json'), JSON.stringify({
    version: 1, source: 'ship-setup-ready-record', baseline,
  }));
  const status = (complete: boolean) => writeStageStatus(project, created.runId, 'review', {
    status: complete ? 'complete' : 'running', retries: 0,
    attempts: [{ index: 1, status: complete ? 'complete' : 'running', startedAt: 'fixture-start',
      ...(complete ? { completedAt: 'fixture-end' } : {}), writes: [], writeAttribution: 'structured' }],
  });
  status(false);
  return { ...created, complete: () => status(true) };
}

function expectConfiguredPass(baseline: ProjectValidationBaseline) {
  expect(baseline.results.map(result => ({ role: result.role, state: result.state, exitCode: result.exitCode })),
    JSON.stringify(baseline.results))
    .toEqual(roles.map(role => ({ role, state: 'passed', exitCode: 0 })));
}

describe('validation dependencies follow the current lockfile', () => {
  it.each(['root', 'shell', 'child-process'] as const)('installs an added local dependency for live validation and settlement (%s)', { timeout: 60_000 }, async mode => {
    const project = await fixture(mode);
    const baseline = await runProjectValidationBaseline(project.project);
    expectConfiguredPass(baseline);
    const run = gate(project.project, baseline);
    await project.addDependency();

    const live = await recordGateValidationDelta(project.project, run.runId, 'review');
    expect(live?.pass, JSON.stringify(live?.current)).toBe(true);
    expect(live?.current.every(result => result.output.includes('locked dependency validation passed'))).toBe(true);

    rmSync(join(project.packageDir, 'node_modules'), { recursive: true, force: true });
    run.complete();
    expect(await settleGateValidationEvidence(project.project, run.runId, 'review')).toEqual({ kind: 'replayed' });
    expect(gateValidationRefusal(project.project, run.runId, 'review')).toBeUndefined();
  });

  it('installs dependencies before capturing the setup baseline', async () => {
    const project = await fixture();
    await project.addDependency();
    expectConfiguredPass(await runProjectValidationBaseline(project.project));
  });

  it('still rejects an import absent from the lockfile', async () => {
    const project = await fixture();
    const baseline = await runProjectValidationBaseline(project.project);
    expectConfiguredPass(baseline);
    const run = gate(project.project, baseline);
    writeFileSync(join(project.packageDir, 'verify.mjs'), "import { value } from 'fixture-value';\nconsole.log(value);\n");
    run.complete();

    const live = await recordGateValidationDelta(project.project, run.runId, 'review');
    expect(live?.pass).toBe(false);
    expect(live?.current.every(result => result.state === 'failed'), JSON.stringify(live?.current)).toBe(true);
    expect(gateValidationRefusal(project.project, run.runId, 'review')?.reason).toContain('recorded regressions');
  });

  it('refuses an inconsistent manifest and lockfile despite a previously installed dependency', async () => {
    const project = await fixture();
    await project.addDependency();
    await project.install();
    const baseline = await runProjectValidationBaseline(project.project);
    expectConfiguredPass(baseline);
    const run = gate(project.project, baseline);
    writeFileSync(join(project.packageDir, 'package-lock.json'), project.originalLock);
    run.complete();

    const live = await recordGateValidationDelta(project.project, run.runId, 'review');
    expect(live?.pass).toBe(false);
    expect(live?.current.every(result => result.state !== 'passed')).toBe(true);
    expect(live?.current.some(result => result.output.includes('locked dependency validation passed'))).toBe(false);
  });
});
