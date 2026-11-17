import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, known } from '../fixtures/rewrite-host.js';
import * as host from '../../dist-rewrite/host/process.js';
import * as state from '../../dist-rewrite/records/state.js';
it('P8 20-launch bare, adapter, public-port, operation-worker and growing-history arms retain timings, versions and failures', async () => {
  const f = await fixture();
  const spawnDone = (argv: string[], cwd = f.work, env: any = { PATH: process.env.PATH!, HOME: f.home }) => new Promise<any>((resolve,
   reject) => { const started = performance.now(), child = spawn('/usr/bin/nice', ['-n', '19', ...argv], { cwd, env, stdio: 'ignore' });
   child.once('error', reject); child.once('exit', (exit, signal) => resolve({ ms: performance.now() - started, exit, signal })); });
const arms: any = { bare: [], adapter: [], publicPort: [], operationWorker: [], growingHistory: [] };
  try {
    const { nativeTool } = await import('../../dist-rewrite/host/process.js');
    const { wrap, cleanup } = await import('../../dist-rewrite/host/srt.js');
    for (let i = 0; i < 20; i++)
      arms.bare.push(await spawnDone(['/usr/bin/true']));
    // Initialize outside the timed adapter arm, as in the approved library probe.
    const first = await f.launch('process.exit(0)');
    expect(first.exit).toBe(0);
    for (let i = 0; i < 20; i++) {
      const started = performance.now(), descriptor = await wrap(f.grant, { argv: ['/usr/bin/true'], cwd: f.work, env: {
       PATH: process.env.PATH!, HOME: f.home, CLAUDE_CODE_TMPDIR: f.scratch }, writableRoots: f.grant.writableRoots }, f.scratch, nativeTool);
      const result = await spawnDone(descriptor.argv, f.work, descriptor.env);
      cleanup();
      arms.adapter.push({ ...result, ms: performance.now() - started });
    }
    const launch = async () => { const started = performance.now(), receipt = await f.launch('', { program: {
     argv: ['/usr/bin/true'] } }); return { ms: performance.now() - started, exit: receipt.exit, signal: receipt.signal,
     durationMs: receipt.durationMs }; };
    for (let i = 0; i < 20; i++)
      arms.publicPort.push(await launch());
    const module = new URL('../native/fixtures/rewrite-native-operation.mjs', import.meta.url).href;
    for (let i = 0; i < 20; i++) {
      const started = performance.now(), result = await state.recordOperation(f.journal, 'construct', { module, method: 'touch',
       args: [join(f.work, 'internal')] });
      known(result);
      arms.operationWorker.push({ ms: performance.now() - started, ok: result.ok });
    }
    const history = join(f.records, 'history');
    await mkdir(history);
    for (let i = 0; i < 2000; i++)
      await writeFile(join(history, String(i)), 'protected-history');
    for (let i = 0; i < 20; i++)
      arms.growingHistory.push(await launch());
    for (const name of ['bare', 'adapter', 'publicPort', 'growingHistory']) {
      expect(arms[name]).toHaveLength(20);
      expect(arms[name].every((s: any) => s.exit === 0 && s.signal === null), name).toBe(true);
    }
    const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8')),
     runtime = JSON.parse(await readFile(new URL('../../node_modules/@anthropic-ai/sandbox-runtime/package.json', import.meta.url), 'utf8'));
    expect(lock.packages['node_modules/@anthropic-ai/sandbox-runtime'].version).toBe('0.0.83');
    expect(runtime.version).toBe('0.0.83');
    const version = await f.launch('', { program: { argv: process.platform === 'linux' ? ['bwrap', '--version'] : ['sw_vers'] } });
    expect(version.exit).toBe(0);
    const nativeTools = Object.fromEntries(await Promise.all(['git', 'python3', 'rsync'].map(async (name) => {
     const path = await host.nativeTool(name); return [name, { path, ...await host.nativeExec([path, '--version'], { env: {
     PATH: process.env.PATH! } }) }]; })));
    await f.evidence('P8', { arms, nativeTools, versions: { node: process.version, lock: '0.0.83', runtime: runtime.version,
     native: await f.text(version.stdout) }, parentPeakRSSKiB: process.resourceUsage().maxRSS,
     scope: ("Adapter arm excludes initialization and evidence; public arms include real SQL/Git " +
        "stream persistence. History grows by 2000 files; admitted alias facts unchanged. No " +
        "absolute timing threshold.") });
  }
  catch (error) {
    await f.evidence('P8-failure', { arms, error: String(error) });
    throw error;
  }
  finally {
    await f.close();
  }
});
