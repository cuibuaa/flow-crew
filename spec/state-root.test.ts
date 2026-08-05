import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(import.meta.dirname, '..');

function moduleUrl(path: string): string {
  return pathToFileURL(join(repositoryRoot, path)).href;
}

describe('FC_HOME state-root isolation', () => {
  it('keeps global state under FC_HOME when HOME and projectDir are different roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-p10-state-'));
    const home = join(root, 'home');
    const fcHome = join(root, 'state');
    const projectDir = join(root, 'project');
    for (const path of [home, fcHome, projectDir]) mkdirSync(path, { recursive: true });

    const source = `
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { campaignsRoot, fcGlobalDir, runsRoot } from ${JSON.stringify(moduleUrl('src/store.ts'))};
      import { listRunIdsFromIndex, rebuildRunIndex } from ${JSON.stringify(moduleUrl('src/run-index.ts'))};
      import { campaignReviewDir } from ${JSON.stringify(moduleUrl('src/campaign-review.ts'))};
      import { ensureKGStore } from ${JSON.stringify(moduleUrl('src/cross-campaign-kg.ts'))};
      import { defaultSocketPath } from ${JSON.stringify(moduleUrl('src/orchestrator-rpc.ts'))};
      import { TaskRegistry } from ${JSON.stringify(moduleUrl('src/task-registry.ts'))};
      import { cmdAuditReality } from ${JSON.stringify(moduleUrl('src/reality-gate/audit-reality.ts'))};

      const projectDir = process.env.P10_PROJECT_DIR;
      const runId = 'isolated-run';
      const runPath = join(runsRoot(), runId);
      mkdirSync(runPath, { recursive: true });
      writeFileSync(join(runPath, 'run.json'), JSON.stringify({
        runId,
        workflowName: 'fixture',
        projectDir,
        status: 'complete',
        stages: {},
        startedAt: '2026-08-03T00:00:00.000Z',
        taskId: 123,
      }));
      const indexed = rebuildRunIndex(projectDir);
      const registry = new TaskRegistry();
      let auditOutput = '';
      await cmdAuditReality(['--task', '123'], {
        stdout: { write(value) { auditOutput += String(value); return true; } },
      });
      console.log(JSON.stringify({
        fcGlobalDir: fcGlobalDir(),
        runsRoot: runsRoot(),
        campaignsRoot: campaignsRoot(),
        reviewDir: campaignReviewDir('fixture-campaign'),
        kgRoot: ensureKGStore(),
        socketPath: defaultSocketPath(),
        registryRoot: registry.baseDir,
        indexed,
        runIds: listRunIdsFromIndex(projectDir),
        indexExists: existsSync(join(fcGlobalDir(), 'run-index.sqlite')),
        auditFoundIsolatedRun: auditOutput.includes('isolated-run'),
      }));
    `;

    try {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            HOME: home,
            FC_HOME: fcHome,
            P10_PROJECT_DIR: projectDir,
          },
          encoding: 'utf-8',
          timeout: 20_000,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr || child.stdout).toBe(0);
      const output = JSON.parse(child.stdout.trim()) as Record<string, unknown>;

      expect(output).toMatchObject({
        fcGlobalDir: fcHome,
        runsRoot: join(fcHome, 'runs'),
        campaignsRoot: join(fcHome, 'campaigns'),
        reviewDir: join(fcHome, 'campaigns', 'fixture-campaign'),
        kgRoot: join(fcHome, 'cross-campaign-kg'),
        socketPath: join(fcHome, 'daemon.sock'),
        registryRoot: fcHome,
        indexed: 1,
        runIds: ['isolated-run'],
        indexExists: true,
        auditFoundIsolatedRun: true,
      });
      expect(existsSync(join(home, '.fc'))).toBe(false);
      expect(existsSync(join(projectDir, '.fc'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps owned production resolvers free of hard-coded homedir/.fc paths', () => {
    const ownedModules = [
      'src/run-index.ts',
      'src/campaign-review.ts',
      'src/cross-campaign-kg.ts',
      'src/orchestrator-rpc.ts',
      'src/task-registry.ts',
      'src/cli-task.ts',
      'src/reality-gate/audit-reality.ts',
    ];

    for (const path of ownedModules) {
      const source = readFileSync(join(repositoryRoot, path), 'utf-8');
      expect(source, path).not.toMatch(/join\(homedir\(\),\s*['"]\.fc['"]/);
      expect(source, path).not.toMatch(/homedir\(\).*['"]\.fc['"]/);
    }
  });
});
