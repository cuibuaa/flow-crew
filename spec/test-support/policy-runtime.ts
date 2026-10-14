import { vi } from 'vitest';

// Setup imports the store before fixture mocks. Reload it so its filesystem
// imports use this fixture's runtime, still inside the setup's isolated home.
vi.hoisted(() => vi.resetModules());

// These fixtures inspect real files and atomic publications, not crash
// durability. Keep native disk flushes in the storage integration specs.
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  fsyncSync: () => {},
}));

// Policy fixtures exercise the scheduler in this process. Observer-thread
// startup is a separate contract, covered by scheduler-loop-heartbeat.test.ts.
// Retain real heartbeat publication and cleanup through its existing factory.
vi.mock('../../src/scheduler-heartbeat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/scheduler-heartbeat.js')>();
  return {
    ...actual,
    startSchedulerHeartbeat: (input: Parameters<typeof actual.startSchedulerHeartbeat>[0]) => (
      actual.startSchedulerHeartbeat({ ...input, spawnObserver: false })
    ),
  };
});
