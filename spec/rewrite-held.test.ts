import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { heldBytes, reclaimTargets } from '../dist-rewrite/records/held.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fc-held-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const put = (path: string, size: number) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'x'.repeat(size)); };

it('held bytes are what reclaim frees: work copy once, pin, raw evidence; never status.json, symlink targets or hard links twice', () => {
  const launch = { project: join(root, 'work', 'R', 'project'), runtime: { path: 'pins/p1/runtime' } } as never;
  put(join(root, 'work', 'R', 'project', 'a'), 100);
  put(join(root, 'work', 'R', 'tmp', 'b'), 10);
  put(join(root, 'pins', 'p1', 'runtime', 'c'), 1000);
  put(join(root, 'runs', 'R', 'evidence', 'd'), 10000);
  put(join(root, 'runs', 'R', 'status.json'), 99999);
  linkSync(join(root, 'runs', 'R', 'evidence', 'd'), join(root, 'runs', 'R', 'evidence', 'd-again'));
  put(join(root, 'elsewhere', 'big'), 77777);
  symlinkSync(join(root, 'elsewhere'), join(root, 'work', 'R', 'link'));
  expect(reclaimTargets(root, 'R', launch)).toEqual({ project: join(root, 'work', 'R', 'project'), pin: join(root, 'pins', 'p1'),
    work: join(root, 'work', 'R') });
  // project sits inside the work root and is counted once; the symlink costs its own entry, not its target.
  const link = join(root, 'elsewhere').length;
  expect(heldBytes(root, 'R', launch)).toBe(100 + 10 + 1000 + 10000 + link);
});

it('a run whose directories are already gone holds nothing', () => {
  expect(heldBytes(root, 'R', { project: join(root, 'work', 'R', 'project'), runtime: { path: 'pins/p1/runtime' } } as never)).toBe(0);
});
