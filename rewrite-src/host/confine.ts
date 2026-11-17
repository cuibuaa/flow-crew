import { realpathSync, readdirSync, lstatSync, constants, copyFileSync, linkSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Ref, Result } from '../contract/brief.js';
import type { GrantRequest, OwnedProgram } from '../contract/runtime.js';
/** Native guarantee table for README/docs. macOS name replacement is a disclosed
 * difference pending the owner's policy decision, not a capability inferred by a test.
 * Directory grants permit unlink/recreation on both hosts; frozen/ungranted paths do not. */
export const nativeGuarantees = {
  linux:  { exactFileUnlink: false, exactFileRename: false, exactFileRecreate: false, defaultTrustHttps: true },
  darwin: { exactFileUnlink: true,  exactFileRename: true,  exactFileRecreate: true,  defaultTrustHttps: false },
} as const;
export interface EvidencePorts {
  putEvidence(bytes: Uint8Array): Promise<Result<Ref>>;
  operation<T>(request: {
    module: string;
    method: string;
    args: readonly unknown[];
  }): Promise<Result<T>>;
}
const inside = (root: string, path: string) => path === root || path.startsWith(root + '/');
const stamp = (path: string) => {
  if (!isAbsolute(path) || resolve(path) !== path ||
    realpathSync(path) !== path)
    throw Error('Nonphysical grant path');
  const s = lstatSync(path);
  if (!s.isFile() && !s.isDirectory() && !s.isCharacterDevice())
    throw Error('Unsupported grant kind');
  return { path, kind: s.isDirectory() ? 'directory' : s.isCharacterDevice() ? 'device' : 'file', dev: s.dev, ino: s.ino };
};
/** Setup records only admitted link names. Launch revalidates those facts, without a whole-tree scan. */
export interface Alias {
  readonly source: string;
  readonly destination: string;
  readonly dev: number;
  readonly ino: number;
  readonly sourceDev: number;
  readonly sourceIno: number;
  readonly nlink: number;
  readonly sourceNlink: number;
  readonly writable: boolean;
}
export function prepareAliases(links: readonly {
  source: string;
  destination: string;
  writable: boolean;
}[]): Result<readonly Alias[]> {
  try {
    for (const link of links) {
      const source = stamp(link.source);
      if (source.kind !== 'file')
        throw Error('Protected link source must be a file');
      try {
        const destination = stamp(link.destination);
        if (source.dev !== destination.dev ||
          source.ino !== destination.ino)
          throw Error('Declared link identity differs');
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
        stamp(dirname(link.destination));
        linkSync(link.source, link.destination);
      }
      if (link.writable) {
        const temporary = link.destination + '.private';
        copyFileSync(link.source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        requireRename(temporary, link.destination);
      }
    }
    return { ok: true, value: links.map(link => {
        const source = lstatSync(link.source), destination = lstatSync(link.destination);
        return {
          ...link, dev: destination.dev, ino: destination.ino, sourceDev: source.dev, sourceIno: source.ino, nlink: destination.nlink,
          sourceNlink: source.nlink
        };
      }) };
  }
  catch (error) {
    return { ok: false, kind: 'invalid', detail: String(error) };
  }
}
/** Admission only: inspect the prepopulated extent and declared protected resources once. */
export function admitAliases(protectedPaths: readonly string[], writableRoots: readonly string[], aliases: readonly Alias[]): Result<true> {
  try {
    const protectedInodes = new Set<string>();
    const visit = (path: string, fn: (path: string, info: import('node:fs').Stats) => void) => {
      const info = lstatSync(path);
      if (info.isSymbolicLink())
        return;
      if (info.isDirectory())
        for (const name of readdirSync(path))
          visit(join(path, name), fn);
      else if (info.isFile())
        fn(path, info);
    };
    for (const root of protectedPaths)
      visit(root, (_, info) => { if (info.nlink > 1)
        protectedInodes.add(`${info.dev}:${info.ino}`); });
    for (const root of writableRoots) {
      try {
        lstatSync(root);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          continue;
        throw error;
      }
      visit(root, (path, info) => {
        if (!protectedPaths.some(root => inside(root, path)) && info.nlink > 1 && protectedInodes.has(`${info.dev}:${info.ino}`) &&
          !aliases.some(alias => alias.destination === path && !alias.writable))
          throw Error('Unknown protected alias: ' + path);
      });
    }
    return { ok: true, value: true };
  }
  catch (error) {
    return { ok: false, kind: 'invalid', detail: String(error) };
  }
}
import { renameSync as requireRename } from 'node:fs';
/** Exact roots and immutable private Git authority are translated once per invocation. */
export async function prepareGrant(request: GrantRequest, program: OwnedProgram, ports: EvidencePorts): Promise<Result<{
  environment: Record<string, string>;
}>> {
  try {
    if (JSON.stringify(request.writableRoots) !== JSON.stringify(program.writableRoots))
      throw Error('Program grant differs');
    for (const alias of request.aliases ?? []) {
      const source = lstatSync(alias.source), destination = lstatSync(alias.destination);
      if (source.dev !== alias.sourceDev || source.ino !== alias.sourceIno || source.nlink !== alias.sourceNlink || destination.dev !== alias.dev ||
        destination.ino !== alias.ino || destination.nlink !== alias.nlink)
        throw Error('Protected alias authority changed');
      if (!alias.writable &&
        !request.protectedRoots.includes(alias.destination))
        throw Error('Read-only alias is not denied');
    }
    const writable = request.writableRoots.map(stamp), protectedRoots = request.protectedRoots.map(path => {
      try {
        return stamp(path);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          stamp(dirname(path));
          return { path, kind: 'absent', dev: 0, ino: 0 };
        }
        throw error;
      }
    });
    if (writable.some(root => protectedRoots.some(p => inside(p.path, root.path))))
      throw Error('Writable root is protected');
    const bytes = Buffer.from(JSON.stringify({ request, writable, protected: protectedRoots }));
    const saved = await ports.putEvidence(bytes);
    if (!saved.ok)
      return saved;
    if (saved.value.sha256 !== createHash('sha256').update(bytes).digest('hex'))
      throw Error('Unauthenticated grant evidence');
    if (writable.some(root => { const after = stamp(root.path); return after.dev !== root.dev || after.ino !== root.ino; }))
      return { ok: false,
        kind: 'conflict', detail: 'Writable root identity changed' };
    return request.git ? ports.operation<{
      environment: Record<string, string>;
    }>({ module: new URL('./process.js', import.meta.url).href,
      method: 'prepareGitTask', args: [request, { writable, protected: protectedRoots }] }) : { ok: true, value: { environment: {} } };
  }
  catch (error) {
    return { ok: false, kind: 'invalid', detail: String(error) };
  }
}
