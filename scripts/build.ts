import { spawnSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');

// One build owns all source-built runtime outputs. No generations or pinning.
for (const output of ['dist-rewrite', 'dist-monitor']) rmSync(join(root, output), { recursive: true, force: true });
for (const config of ['tsconfig.rewrite.json', 'tsconfig.rewrite-build.json', 'rewrite-monitor/tsconfig.json']) {
  const result = spawnSync('nice', ['-n', '19', process.execPath, compiler, '-p', config], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Keep the hook bundle as a separate final operation for the canonical-decoder merge.
await build({ entryPoints: [join(root, 'integrations/claude/flowcrew-session.mjs')],
  outfile: join(root, 'dist-rewrite/flowcrew-session.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' });
chmodSync(join(root, 'dist-rewrite/cli.js'), 0o755);
writeFileSync(join(root, 'dist-rewrite/.built'), '');
