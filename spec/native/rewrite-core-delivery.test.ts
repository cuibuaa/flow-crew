import { f, resetFixture, stage } from './fixtures/rewrite-core.js';

import { access,mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { runWorkflow } from '../../dist-rewrite/core/loop.js';

import * as host from '../../dist-rewrite/host/process.js';
import { land } from '../../dist-rewrite/ops/land.js';

import { appendEvents, claim, openJournal, openWriter, readEvents, release } from '../../dist-rewrite/records/state.js';
import { runServices } from '../fixtures/rewrite-run-services.js';
import { get } from '../fixtures/rewrite-state.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';

it.each(['file',
 'directory'] as const)(
  'preserves an external %s output through real delivery and reclaim; terminal extents exclude a later overlapping run', async (kind) => {
  const parent = await mkdtemp(join(tmpdir(), 'fcrw-external-delivery-')), external = join(parent, 'product');
  try {
    await resetFixture({ outputs: [{ path: external, kind, existing: 'create' }] });
    const { ports } = workflowFixture(f), native = ports.attempt;
    ports.attempt = async (request) => {
      const receipt = get(await native(request));
      if (request.stage.purpose === 'work') {
        if (kind === 'directory')
          await mkdir(external);
        else
          await writeFile(external, 'Delivered external bytes');
        return { ok: true, value: { ...receipt, after: await f.tree() } };
      }
      return { ok: true, value: receipt };
    };
    expect(get(await runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal })).status).toBe('complete');
    const location = { ...f.location, run: 'Later' }, journal = get(await openJournal(location, 'create'));
    const held = get(await claim(join(journal.root, 'control'), null, { database: f.database, holder: journal.root }));
    try {
      const writer = get(await openWriter(journal, held, 'control')), nextProject = join(f.root, 'later-project');
      await mkdir(nextProject);
      const authority = { ...f.scope.authority, project: nextProject, resources: [{ path: nextProject,
       access: 'exclusive-write' as const }, { path: external, access: 'exclusive-write' as const }] };
      expect(await appendEvents(writer, 0, [{ type: 'run_authority', authority }])).toMatchObject({ ok: false, kind: 'conflict' });
      await f.releaseClaims();
      vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: { unit: f.launch.unit, state: 'inactive', owner: null,
       evidence: [], detail: 'Model-free manager edge' } });
      expect(get(await land(f.location, runServices(f).process, f.unitContext)).state).toBe('reclaimed');
      expect(get(await appendEvents(writer, 0, [{ type: 'run_authority', authority }]))).toBe(1);
      await expect(access(f.project)).rejects.toMatchObject({ code: 'ENOENT' });
      await access(external);
      if (kind === 'file')
        expect(await readFile(external, 'utf8')).toBe('Delivered external bytes');
      expect(get(await readEvents(journal, 0)).map(event => event.payload)).toEqual([{ type: 'run_authority', authority }]);
    }
    finally {
      get(await release(held, 'retire'));
    }
  }
  finally {
    await rm(parent, { recursive: true, force: true });
  }
});
