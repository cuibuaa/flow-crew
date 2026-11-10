import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { registerStorageRoot, storageRegistryDirectory, storageRoots } from '../src/engine-owned-carriers.js';

let root: string, previousRegistry: string | undefined;
const moduleUrl = new URL('../src/engine-owned-carriers.ts', import.meta.url).href;
const childArgs = (code: string) => ['--import', 'tsx', '--input-type=module', '-e', code];
const directory = (name: string) => { const path = join(root, name); mkdirSync(path); return path; };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-store-identity-'));
  previousRegistry = process.env.FC_STORE_REGISTRY;
  process.env.FC_STORE_REGISTRY = join(root, 'registry');
});
afterEach(() => {
  if (previousRegistry === undefined) delete process.env.FC_STORE_REGISTRY;
  else process.env.FC_STORE_REGISTRY = previousRegistry;
  rmSync(root, { recursive: true, force: true });
});

it('discovers a separately registered store in a fresh process with a different FC_HOME', () => {
  const store = directory('store');
  execFileSync(process.execPath, childArgs(`
    import { registerStorageRoot } from ${JSON.stringify(moduleUrl)};
    registerStorageRoot(${JSON.stringify(store)}, 'store');
  `), { cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: join(root, 'creator-home') }, timeout: 15000 });
  const found = JSON.parse(execFileSync(process.execPath, childArgs(`
    import { storageRoots } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(storageRoots()));
  `), { cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: join(root, 'reader-home') }, encoding: 'utf8', timeout: 15000 }));
  const identity = statSync(store, { bigint: true });
  expect(found).toEqual([{ path: store, kind: 'store', dev: String(identity.dev), ino: String(identity.ino) }]);
});

it('canonicalizes a symlink spelling without duplicating its store identity', () => {
  const store = directory('store'), alias = join(root, 'alias');
  symlinkSync(store, alias, 'dir');
  registerStorageRoot(store, 'store');
  registerStorageRoot(alias, 'store');
  expect(storageRoots().map(entry => entry.path)).toEqual([store]);
});

it('does not transfer ownership to a replacement at the registered pathname', () => {
  const store = directory('store');
  registerStorageRoot(store, 'store');
  renameSync(store, join(root, 'retained-old-inode'));
  mkdirSync(store);
  expect(storageRoots()).toEqual([]);
  registerStorageRoot(store, 'store');
  expect(storageRoots().map(entry => entry.path)).toEqual([store]);
});

it('ignores a removed registered root without making neighboring data engine-owned', () => {
  const store = directory('store'), ordinary = directory('ordinary');
  registerStorageRoot(store, 'store');
  rmSync(store, { recursive: true });
  writeFileSync(join(ordinary, 'run.json'), JSON.stringify({ storageLayout: 2, runId: 'ordinary' }));
  expect(storageRoots()).toEqual([]);
});

it('keeps all concurrently registered roots and exposes only complete records', async () => {
  const stores = Array.from({ length: 4 }, (_, index) => directory(`store-${index}`));
  const readErrors: unknown[] = [];
  const reader = setInterval(() => { try { storageRoots(); } catch (error) { readErrors.push(error); } }, 5);
  try {
    await Promise.all(stores.map(store => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, childArgs(`
        import { registerStorageRoot } from ${JSON.stringify(moduleUrl)};
        registerStorageRoot(${JSON.stringify(store)}, 'store');
      `), { cwd: process.cwd(), env: { ...process.env, HOME: root, FC_HOME: join(store, 'home') }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`child exit ${code}/${signal}: ${stderr}`)));
    })));
  } finally { clearInterval(reader); }
  expect(readErrors).toEqual([]);
  expect(storageRoots().map(entry => entry.path).sort()).toEqual([...stores].sort());
});

it('does not grant ownership from a copied registry record inside a candidate directory', () => {
  const store = directory('store'), candidate = directory('candidate');
  registerStorageRoot(store, 'store');
  const [record] = readdirSync(storageRegistryDirectory());
  writeFileSync(join(candidate, record), readFileSync(join(storageRegistryDirectory(), record)));
  writeFileSync(join(candidate, 'run.json'), JSON.stringify({ storageLayout: 2, runId: 'candidate' }));
  expect(storageRoots().map(entry => entry.path)).toEqual([store]);
});

it('fails closed if the engine registry contains a malformed record', () => {
  const store = directory('store');
  registerStorageRoot(store, 'store');
  const [record] = readdirSync(storageRegistryDirectory());
  writeFileSync(join(storageRegistryDirectory(), record), '{');
  expect(() => storageRoots()).toThrow();
});


it.each(['root', 'parent'] as const)('ignores an old store identity when its %s is replaced by a regular file', replaced => {
  const parent = directory('parent'), store = join(parent, 'store'); mkdirSync(store);
  registerStorageRoot(store, 'store');
  const path = replaced === 'root' ? store : parent;
  renameSync(path, join(root, 'retained-old-directory'));
  writeFileSync(path, 'ordinary replacement file');
  expect(storageRoots()).toEqual([]);
});
