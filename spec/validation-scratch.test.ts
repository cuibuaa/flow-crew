import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'linux')('runs protected fixtures from an aliased author temporary directory and retires only suite scratch', () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-owner-'));
  try {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { createServer } from 'node:net';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import setup from ${JSON.stringify(new URL('../scripts/vitest-global-setup.ts', import.meta.url).href)};
      import { createInvocationScratch, retireRunScratch } from ${JSON.stringify(new URL('../src/invocation-scratch.ts', import.meta.url).href)};
      import { prepareAdapterHome } from ${JSON.stringify(new URL('../src/adapter-home.ts', import.meta.url).href)};
      import { withEngineIntegrity } from ${JSON.stringify(new URL('../src/engine-integrity.ts', import.meta.url).href)};
      import { setFcGlobalDir } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
      const root = process.argv[1];
      const authorRun = join(root, 'author-run');
      const author = createInvocationScratch(authorRun);
      const retained = join(author.path, 'evidence.txt');
      writeFileSync(retained, 'keep author evidence');
      for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = author.path;
      let teardown;
      try {
        teardown = setup();
        const suite = tmpdir();
        const project = join(suite, 'project');
        const store = join(suite, 'control');
        const run = join(store, 'runs', 'fixture');
        mkdirSync(project, { recursive: true });
        mkdirSync(run, { recursive: true });
        setFcGlobalDir(store);
        prepareAdapterHome({ home: join(suite, 'adapter'), config: 'fixture = true\\n' });
        const homePrepared = readFileSync(join(suite, 'adapter/config.toml'), 'utf8') === 'fixture = true\\n';
        const server = createServer();
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(join(suite, 'service.sock'), () => server.close(error => error ? reject(error) : resolve()));
        });
        const carrier = join(run, 'verdict_previous.json');
        writeFileSync(carrier, 'authentic');
        let tamperRefused = false;
        try {
          await withEngineIntegrity({ projectDir: project, runDir: run, stageId: 'work' }, async () => {
            writeFileSync(carrier, 'counterfeit');
          });
        } catch (error) { tamperRefused = String(error).includes('ENGINE_STATE_TAMPERED'); }
        const restored = readFileSync(carrier, 'utf8') === 'authentic';
        teardown(); teardown = undefined;
        console.log(JSON.stringify({ homePrepared, socketClosed: !server.listening, tamperRefused, restored,
          suiteRetired: !existsSync(suite), callerRetained: readFileSync(retained, 'utf8') === 'keep author evidence',
          environmentRestored: ['TMPDIR', 'TMP', 'TEMP'].every(name => process.env[name] === author.path) }));
      } finally {
        teardown?.();
        retireRunScratch(authorRun);
      }
    `, root], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HOME: join(root, 'home'), FC_HOME: join(root, 'store') },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      homePrepared: true, socketClosed: true, tamperRefused: true, restored: true,
      suiteRetired: true, callerRetained: true, environmentRestored: true,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
