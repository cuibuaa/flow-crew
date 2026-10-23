import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.resetModules());
const guard = vi.hoisted(() => ({
  defaultRoot: '', mountRoot: '', fixtureRoot: '', destination: '', capacityZero: false,
  mount: vi.fn(() => ({ status: 0 })),
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: Object.assign((path: Parameters<typeof actual.realpathSync>[0], ...args: unknown[]) => {
      if (String(path) === guard.defaultRoot) return guard.destination;
      if (String(path) === guard.mountRoot) return guard.fixtureRoot;
      return Reflect.apply(actual.realpathSync, undefined, [path, ...args]);
    }, { native: actual.realpathSync.native }),
    statfsSync: (path: Parameters<typeof actual.statfsSync>[0], ...args: unknown[]) => {
      const capacity = Reflect.apply(actual.statfsSync, undefined, [path, ...args]);
      return guard.capacityZero ? { ...capacity, bavail: 0n } : capacity;
    },
  };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: guard.mount };
});

import { archiveLandOutputs, DEFAULT_LAND_ARCHIVE_ROOT, verifyLandArchive } from '../src/land-archive.js';

let root: string, project: string, run: string, destination: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'flowcrew-land-archive-guards-')));
  project = join(root, 'project'); run = join(root, 'run'); destination = join(root, 'archive');
  for (const path of [project, run, destination]) mkdirSync(path);
  writeFileSync(join(project, 'result.md'), 'unique result');
  writeFileSync(join(run, 'run.json'), '{}');
  Object.assign(guard, { defaultRoot: resolve(DEFAULT_LAND_ARCHIVE_ROOT), mountRoot: join('/mnt', 'h'), fixtureRoot: root, destination, capacityZero: false });
  guard.mount.mockReset().mockReturnValue({ status: 0 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses an unmounted default volume before creating an archive', () => {
  guard.mount.mockReturnValue({ status: 1 });
  expect(() => archiveLandOutputs(project, run, DEFAULT_LAND_ARCHIVE_ROOT, ['result.md']))
    .toThrow(/archive volume is not mounted/);
  expect(guard.mount).toHaveBeenCalledWith('findmnt', ['--mountpoint', guard.mountRoot], { encoding: 'utf8' });
  expect(readdirSync(destination)).toEqual([]);
  expect(readFileSync(join(project, 'result.md'), 'utf8')).toBe('unique result');
});

it('refuses insufficient capacity before copying or creating a proof', () => {
  guard.capacityZero = true;
  expect(() => archiveLandOutputs(project, run, destination, ['result.md']))
    .toThrow(/insufficient free space/);
  expect(readdirSync(destination)).toEqual([]);
  expect(readFileSync(join(run, 'run.json'), 'utf8')).toBe('{}');
});

it('archives to the mounted default volume when capacity and source proofs pass', () => {
  const report = archiveLandOutputs(project, run, DEFAULT_LAND_ARCHIVE_ROOT, ['result.md']);
  expect(report.files).toBe(2);
  expect(report.bytes).toBe(15);
  expect(report.manifests).toHaveLength(2);
  expect(guard.mount).toHaveBeenCalledOnce();
  expect(() => verifyLandArchive(project, run, report)).not.toThrow();
  expect(readFileSync(join(report.worktreeProofDir, 'declared_outputs', 'result.md'), 'utf8')).toBe('unique result');
});
