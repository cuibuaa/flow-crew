import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../dist-rewrite/ops/main.js';
import { resolve } from 'node:path';
vi.mock('../dist-rewrite/ops/main.js', () => ({ main: vi.fn(async () => 0), exitOf: vi.fn(() => 2) }));
vi.mock('node:os', () => ({ homedir: () => '/fixture/operator' }));
const originalArgv = process.argv;
const originalExit = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExit;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each([
  ['HOME default', undefined, undefined, undefined, '/fixture/operator/.local/state/flowcrew', '/fixture/operator/.local/state/flowcrew/store'],
  ['XDG selection', undefined, '/fixture/xdg', undefined, '/fixture/xdg/flowcrew', '/fixture/xdg/flowcrew/store'],
  ['FC_HOME precedence', '/fixture/state', '/fixture/xdg', undefined, '/fixture/state', '/fixture/state/store'],
  ['store override', '/fixture/state', undefined, '/fixture/store', '/fixture/state', '/fixture/store'],
] as const)('public executable selects literal roots before dispatch: %s', async (_label, fc, xdg, store, home, expectedStore) => {
  vi.resetModules();
  vi.stubEnv('FC_HOME', fc);
  vi.stubEnv('XDG_STATE_HOME', xdg);
  vi.stubEnv('FLOWCREW_STORE_ROOT', store);
  vi.stubEnv('FLOWCREW_RUNTIME_ROOT', undefined);
  vi.spyOn(process, 'on').mockReturnValue(process);
  process.argv = [process.execPath, '/fixture/runtime/dist-rewrite/cli.js', 'setup', 'brief.md', '--project', '/fixture/project-alias'];
  await import('../dist-rewrite/cli.js');
  expect(main).toHaveBeenCalledWith(['setup', 'brief.md', '--project', '/fixture/project-alias'], expect.objectContaining({
    home, storeRoot: expectedStore, runtimeRoot: resolve(import.meta.dirname, '..'), cwd: process.cwd(),
  }));
  expect(process.exitCode).toBe(0);
});

it('an exception that escapes the operation entry exits 2 with its message', async () => {
  vi.resetModules();
  vi.stubEnv('FLOWCREW_RUNTIME_ROOT', undefined);
  vi.mocked(main).mockRejectedValueOnce(new Error('escaped the entry'));
  vi.spyOn(process, 'on').mockReturnValue(process);
  const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.argv = [process.execPath, '/fixture/runtime/dist-rewrite/cli.js', 'status', 'run_x'];
  await import('../dist-rewrite/cli.js');
  expect(process.exitCode).toBe(2);
  expect(written).toHaveBeenCalledWith('escaped the entry\n');
});
