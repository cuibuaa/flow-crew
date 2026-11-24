import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Brief, Result } from '../contract/brief.js';
import type { OutputFact, Role, RunAuthority, RuntimeConfig } from '../contract/runtime.js';
import { fileHash } from '../records/content.js';
import { preparePolicy } from '../exec/policy.js';

const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
export async function prospective(path: string): Promise<string> {
  try { return await fs.realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await prospective(dirname(resolve(path))), resolve(path).slice(dirname(resolve(path)).length + 1)); }
}

/** Resolve lifecycle roots without writes; admission observes the imported copy later. */
export async function preparationPaths(paths: { project: string; storeRoot: string; home: string }, run: string): Promise<Result<typeof paths & { target: string }>> {
  const resolved = { project: await prospective(paths.project), storeRoot: await prospective(paths.storeRoot), home: await prospective(paths.home) };
  const target = join(resolved.storeRoot, 'work', run, 'project');
  if (within(resolved.project, target) || within(target, resolved.project)) return { ok: false, kind: 'invalid', detail: 'Source and target overlap' };
  return { ok: true, value: { ...resolved, target } };
}

/** The sole declared-input admission, on the completed copy. */
export async function admitInputs(brief: Brief, source: string): Promise<Result<true>> {
  for (const input of brief.inputs) {
    const path = isAbsolute(input.path) ? input.path : resolve(source, input.path), info = await fs.lstat(path);
    if (info.isSymbolicLink() || (input.kind === 'file' ? !info.isFile() : !info.isDirectory()))
      throw Error('Declared path kind mismatch or symlink');
    if (input.sha256 !== undefined && await fileHash(path) !== input.sha256)
      return { ok: false, kind: 'invalid', detail: 'Declared input hash mismatch' };
    if (!isAbsolute(input.path) && !within(source, await fs.realpath(path)))
      return { ok: false, kind: 'invalid', detail: 'Input escapes source' };
  }
  return { ok: true, value: true };
}

/** Decide preparation once on the imported project, before baselines or workload execution. */
export async function admitPreparation(brief: Brief, configuration: RuntimeConfig, runtime: {
  source: string; project: string; protectedRoots: readonly string[]; workRoot: string;
  backend: Role['backend']; environment: Readonly<Record<string, string>>;
}): Promise<Result<RunAuthority>> {
  try {
    runtime = { ...runtime, project: await prospective(runtime.project), source: await fs.realpath(runtime.source),
      workRoot: await prospective(runtime.workRoot), protectedRoots: await Promise.all(runtime.protectedRoots.map(prospective)) };
    const { project, source } = runtime;
    if (!(await fs.lstat(source)).isDirectory()) throw Error('Source is not a directory');
    // Capture walks every project entry (including ignored files), but never follows symlinks.
    for (const command of brief.commands) for (const dependency of command.dependsOn ?? []) {
      let path = source;
      for (const component of dependency.split('/')) {
        path = join(path, component);
        try {
          if ((await fs.lstat(path)).isSymbolicLink()) return { ok: false, kind: 'invalid',
            detail: `Command ${command.id} dependsOn ${dependency}: checkpoint trees record symlinks, not their targets` };
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
      }
    }
    const inputs = await admitInputs(brief, source);
    if (!inputs.ok) return inputs;
    const fact = async (path: string): Promise<OutputFact> => {
      try { const info = await fs.lstat(path);
        return info.isSymbolicLink() ? 'other' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return 'absent'; }
    };
    const facts = await Promise.all(brief.outputs.map(output => fact(resolve(project, output.path))));
    const parents: { path: string; original: OutputFact; mode: number }[] = [];
    for (const output of brief.outputs) {
      let path = dirname(resolve(project, output.path));
      while (!parents.some(parent => parent.path === path)) {
        const original = await fact(path);
        parents.push({ path, original: original === 'directory' || original === 'absent' ? original : 'other', mode: original === 'absent' ? 0 : (await fs.lstat(path)).mode & 0o7777 });
        if (original !== 'absent') break;
        path = dirname(path);
      }
    }
    const authority = await preparePolicy(brief, configuration, { ...runtime, project, parents }, facts);
    if (!authority.ok) return authority;
    // These destinations are used by engine import/restore/publication; they are not permission grants.
    for (const root of [project, runtime.workRoot, ...runtime.protectedRoots, ...authority.value.outputs.map(output => output.absolute)])
      if (!isAbsolute(root) || resolve(root) !== root || await prospective(root) !== root)
        throw Error('Noncanonical or aliased destination');
    for (const root of runtime.protectedRoots)
      if (within(project, root) || within(root, project))
        return { ok: false, kind: 'conflict', detail: 'Record and project roots overlap' };
    return authority;
  } catch (error) { return { ok: false, kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'invalid',
    detail: error instanceof Error ? error.message : String(error) }; }
}
