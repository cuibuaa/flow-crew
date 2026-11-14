import { beforeEach, vi } from 'vitest';
import { TaskRegistry, type TaskCreateInput } from '../../src/task-registry.js';

// Policy tests use dummy executors/CLI paths and never execute engine bytes.
// Keep their ownership/budget/admission subjects independent of disk snapshots.
// Native deploy/runtime tests deliberately do not import this fixture.
vi.mock('../../src/build-manifest.js', async original => ({
  ...await original<typeof import('../../src/build-manifest.js')>(),
  selectTaskRuntime: (cliPath: string) => ({generation: 'f'.repeat(64), cliPath}),
  validateTaskRuntime: (runtime: {cliPath: string}) => runtime.cliPath,
}));
beforeEach(() => {
  const create = TaskRegistry.prototype.create;
  vi.spyOn(TaskRegistry.prototype, 'create').mockImplementation(function(this: TaskRegistry, input: TaskCreateInput) {
    return create.call(this, {runtime:{generation:'f'.repeat(64),cliPath:'/tmp/flowcrew-cli.js'}, ...input});
  });
});
