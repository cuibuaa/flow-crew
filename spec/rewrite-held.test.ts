import { expect, it } from 'vitest';
import { reclaimTargets } from '../dist-rewrite/records/held.js';

it('reclaim names only the addressed project, runtime pin and private work root', () => {
  expect(reclaimTargets('/workspace/store', 'Run', { project: '/workspace/project', runtime: { path: 'pins/Run/.pin' } } as never))
    .toEqual({ project: '/workspace/project', pin: '/workspace/store/pins/Run', work: '/workspace/store/work/Run' });
});
