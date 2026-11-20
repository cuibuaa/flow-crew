import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** One owner for physical, disposable test homes and temporary storage. */
export function createTestEnvironment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fc-')));
  const home = join(root, 'home');
  const fcHome = join(home, '.fc');
  mkdirSync(fcHome, { recursive: true });
  // Standalone fixtures choose their own module format and Git repository.
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, '.git'), 'gitdir: absent\n');
  const previous = { ...process.env };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  process.once('exit', cleanup);
  return { root, home, fcHome, temp: dirname(root), restore() {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    process.off('exit', cleanup);
    cleanup();
  } };
}
