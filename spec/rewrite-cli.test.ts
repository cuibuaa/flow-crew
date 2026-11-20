import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../dist-rewrite/ops/main.js';
vi.mock('../dist-rewrite/ops/main.js', () => ({ main: vi.fn(async () => 0) }));
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
  vi.stubEnv('FLOWCREW_RUNTIME_ROOT', '/fixture/runtime');
  vi.spyOn(process, 'on').mockReturnValue(process);
  process.argv = [process.execPath, '/fixture/runtime/dist-rewrite/cli.js', 'setup', 'brief.md', '--project', '/fixture/project-alias'];
  await import('../dist-rewrite/cli.js');
  expect(main).toHaveBeenCalledExactlyOnceWith(['setup', 'brief.md', '--project', '/fixture/project-alias'], expect.objectContaining({
    home, storeRoot: expectedStore, runtimeRoot: '/fixture/runtime', cwd: process.cwd(),
  }));
  expect(process.exitCode).toBe(0);
});
