import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '../..');

// This is source-built payload evidence. Real independent installation is step 7.
it('packs the real rewrite entry, monitor and standalone hook', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-payload-'));
  try {
    const probe = join(root, 'pack.cjs');
    writeFileSync(probe, `const { spawnSync } = require('node:child_process');
const child = spawnSync('nice', ['-n', '19', 'npm', 'pack', '--dry-run', '--json', '--ignore-scripts', '--offline', '--cache', process.argv[2]], { encoding: 'utf8', timeout: 26 * 60_000, killSignal: 'SIGKILL' });
process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
process.exit(child.status ?? 1);`);
    const result = spawnSync(process.execPath, [probe, join(root, 'npm-cache')], {
      cwd: projectRoot, encoding: 'utf8', timeout: 26 * 60_000, killSignal: 'SIGKILL',
      env: { ...process.env, HOME: root, FC_HOME: join(root, 'fc') },
    });
    expect(result.status, result.stderr).toBe(0);
    const files = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path) as string[];
    const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    expect(manifest.main).toBe(manifest.bin.flowcrew);
    expect(files).toContain(manifest.bin.flowcrew);
    expect(files).toContain('dist-rewrite/flowcrew-session.mjs');
    expect(files).toContain('dist-monitor/rewrite-monitor/server.js');
    expect(files.some(file => /^(src|ui)\//.test(file))).toBe(false);
    expect(existsSync(join(projectRoot, manifest.bin.flowcrew))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
