import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
it('records durable capture timings for the retained 3 GiB and 42,296-file workload', async () => {
  const root = resolve(import.meta.dirname, '../..');
  const logs = await mkdtemp(resolve(tmpdir(), 'flowcrew-content-evidence-'));
  console.info('Content benchmark evidence:', logs);
  try {
    const exit = await new Promise<number | null>((done, reject) => {
      const child = spawn('/usr/bin/nice', ['-n', '19', process.execPath, '--import', 'tsx',
        resolve(import.meta.dirname, 'fixtures/rewrite-acceptance/baseline.mts'), logs], {
        cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('error', reject);
      child.on('exit', done);
    });
    expect(exit).toBe(0);
  } finally {
    await rm(logs, { recursive: true, force: true });
  }
});
