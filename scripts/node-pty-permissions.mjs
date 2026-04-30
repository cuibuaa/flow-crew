import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const EXECUTABLE_BITS = 0o111;
const EXECUTABLE_MODE = 0o755;

function nodePtyRoot() {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('node-pty/package.json'));
}

export function repairNodePtySpawnHelpers({ log = false } = {}) {
  if (process.platform !== 'darwin') return { checked: 0, repaired: 0 };

  let root;
  try {
    root = nodePtyRoot();
  } catch (err) {
    if (log) console.warn(`[flowcrew] node-pty not found; skipping macOS spawn-helper permission repair: ${err}`);
    return { checked: 0, repaired: 0 };
  }

  const helpers = [
    join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    join(root, 'prebuilds', 'darwin-x64', 'spawn-helper'),
  ];

  let checked = 0;
  let repaired = 0;
  for (const helper of helpers) {
    if (!existsSync(helper)) continue;
    checked++;
    const stat = statSync(helper);
    if ((stat.mode & EXECUTABLE_BITS) === EXECUTABLE_BITS) continue;
    chmodSync(helper, stat.mode | EXECUTABLE_MODE);
    repaired++;
    if (log) console.log(`[flowcrew] repaired executable permissions for ${helper}`);
  }

  if (log && checked > 0 && repaired === 0) {
    console.log('[flowcrew] node-pty macOS spawn-helper permissions are already executable');
  }

  return { checked, repaired };
}
