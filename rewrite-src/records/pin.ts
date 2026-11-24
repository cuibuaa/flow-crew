import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { idSchema, refSchema, type Ref, type Result } from '../contract/brief.js';

type Entry = { path: string; sha256: string; executable: boolean };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function inventory(root: string, directory = root, sealed = false): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const path = join(directory, name), stat = await fs.lstat(path);
    if (stat.isDirectory()) entries.push(...await inventory(root, path, sealed));
    else if (stat.isFile()) {
      if (sealed && stat.mode & 0o222) throw Error('Runtime carrier is mutable');
      if (relative(root, path) !== '.pin') entries.push({ path: relative(root, path), sha256: hash(await fs.readFile(path)),
        executable: !!(stat.mode & 0o111) });
    } else throw Error('Runtime copy contains a non-file carrier');
  }
  return entries;
}
/** One run owns one real copy, including the package's installed production dependency closure. */
export async function pinRuntime(packageRoot: string, storeRoot: string, run: string, configuration?: unknown): Promise<Result<Ref>> {
  if (!idSchema.safeParse(run).success) return { ok: false, kind: 'invalid', detail: 'Invalid run id' };
  const root = resolve(storeRoot, 'pins', run);
  try {
    await fs.mkdir(dirname(root), { recursive: true });
    await fs.mkdir(root); // Never overwrite a pin or reinterpret an older run.
    const copy = async (source: string, target: string) => fs.cp(source, target, { recursive: true,
      mode: constants.COPYFILE_FICLONE, filter: path => !path.endsWith('/node_modules') && !path.endsWith('/.bin'),
      dereference: true });
    await copy(join(packageRoot, 'dist-rewrite'), root);
    for (const name of ['config', 'skills', 'package.json']) await copy(join(packageRoot, name), join(root, name));
    if (configuration) await fs.writeFile(join(root, 'config', 'runtime.json'), JSON.stringify(configuration));
    const dependencies = async (source: string, target: string, ancestors: readonly string[]) => {
      const metadata = JSON.parse(await fs.readFile(join(source, 'package.json'), 'utf8'));
      const require = createRequire(join(source, 'package.json'));
      for (const name of Object.keys(metadata.dependencies ?? {})) {
        let resolved = dirname(require.resolve(name));
        while (JSON.parse(await fs.readFile(join(resolved, 'package.json'), 'utf8').catch(() => '{}')).name !== name) {
          if (dirname(resolved) === resolved) throw Error('Cannot locate installed dependency ' + name);
          resolved = dirname(resolved);
        }
        // Node resolves an ancestor dependency without a duplicate nested copy.
        if (ancestors.includes(resolved)) continue;
        const destination = join(target, 'node_modules', name);
        await copy(resolved, destination);
        await dependencies(resolved, destination, [...ancestors, resolved]);
      }
    };
    await dependencies(packageRoot, root, []);
    const entries = await inventory(root), bytes = Buffer.from(JSON.stringify(entries));
    await fs.writeFile(join(root, '.pin'), bytes, { flag: 'wx', mode: 0o444 });
    for (const entry of entries) await fs.chmod(join(root, entry.path), entry.executable ? 0o555 : 0o444);
    for (const entry of [...entries.map(entry => entry.path), '.pin']) {
      const file = await fs.open(join(root, entry), 'r'); try { await file.sync(); } finally { await file.close(); }
    }
    const sync = async (path: string): Promise<void> => {
      for (const entry of await fs.readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await sync(join(path, entry.name));
      const directory = await fs.open(path, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    };
    await sync(root);
    const parent = await fs.open(dirname(root), 'r'); try { await parent.sync(); } finally { await parent.close(); }
    return { ok: true, value: { path: relative(resolve(storeRoot), join(root, '.pin')), sha256: hash(bytes) } };
  } catch (error) { return { ok: false, kind: 'unknown', detail: 'Runtime pin was not completed; use a fresh run: ' + String(error) }; }
}
/** Authenticate both inventory and actual directory; added, removed or modified bytes refuse resume. */
export async function verifyRuntime(storeRoot: string, runtime: Ref): Promise<Result<Ref>> {
  try {
    if (!refSchema.safeParse(runtime).success) throw Error('Invalid runtime reference');
    const marker = resolve(storeRoot, runtime.path), root = dirname(marker);
    if (await fs.realpath(marker) !== marker || !marker.startsWith(resolve(storeRoot) + '/')) throw Error('Aliased runtime reference');
    const bytes = await fs.readFile(marker);
    if (!Array.isArray(JSON.parse(bytes.toString()))) return { ok: false, kind: 'invalid',
      detail: 'Unsupported runtime inventory format. Status and cancel remain available; start a new run with the installed package.' };
    if (hash(bytes) !== runtime.sha256 || JSON.stringify(await inventory(root, root, true)) !== bytes.toString()) throw Error('Runtime digest differs');
    return { ok: true, value: runtime };
  } catch (error) { return { ok: false, kind: 'unavailable', detail: 'Pinned runtime missing or changed. Restore the original run pin from backup; '
    + 'otherwise start a new run with the installed package. ' + String(error) }; }
}
