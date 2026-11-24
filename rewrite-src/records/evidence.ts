import { inOperation, runOperation, nativeSpawn, nativeTool, nativeExec } from '../host/process.js';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, rm, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { refSchema, type Ref, type Result } from '../contract/brief.js';
import type { Journal } from '../contract/runtime.js';

export const evidenceRepository = (journal: Journal) => join(journal.root, 'git-common');
const invalidEvidence = (detail: string) => Object.assign(new Error(detail), { code: 'EINVAL' });
const environment = { PATH: '/usr/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
/** Shell-free protected Git; automatic GC is never allowed during object construction. */
export async function git(journal: Journal, args: readonly string[], context: { env?: Record<string, string>; input?: Uint8Array } = {}
  ): Promise<Buffer> {
  if (!inOperation) { const { recordOperation } = await import('./state.js'); const result = await recordOperation<Buffer>(journal, 'construct',
    { module: import.meta.url, method: 'gitTask', args: [journal, args, context] }); if (!result.ok) throw new Error(result.detail);
    return Buffer.from(result.value); }

  const { child, done: closed } = await nativeSpawn([await nativeTool('git'), '--git-dir=' + evidenceRepository(journal),
    '-c', 'core.fsyncObjectFiles=true', '-c', 'gc.auto=0', ...args], { env: { ...environment, ...context.env } });
  const chunks: Buffer[] = []; let error = '';
  child.stdout.on('data', bytes => chunks.push(Buffer.from(bytes))); child.stderr.on('data', bytes => { error += bytes; });
  child.stdin.on('error', () => undefined); child.stdin.end(context.input);
  if (await closed !== 0) throw new Error('Git operation refused: ' + error);
  return Buffer.concat(chunks);
}
export async function syncPath(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
/** Recorded construction after the journal row commits; failed preparation already owns its cleanup. */
export async function initializeEvidence(journal: Journal): Promise<void> {
  if (!inOperation) {
    const { recordOperation } = await import('./state.js');
    const initialized = await recordOperation(journal, 'construct', { module: import.meta.url, method: 'initializeTask', args: [journal] });
    if (!initialized.ok) throw new Error(initialized.detail);
    return;
  }
  if (resolve(journal.root) !== journal.root || await realpath(journal.root) !== journal.root) throw new Error('Aliased evidence root');
  const repository = evidenceRepository(journal);
  await nativeExec([await nativeTool('git'), 'init', '--bare', '--template=', repository], { env: environment });
  await mkdir(join(repository, 'info'), { recursive: true });
  const attributes = await open(join(repository, 'info', 'attributes'), 'wx', 0o444);
  try { await attributes.writeFile('* -text -filter -ident -working-tree-encoding\n'); }
  finally { await attributes.close(); }
  const synchronize = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await synchronize(child); else await syncPath(child);
    }
    await syncPath(path);
  };
  await synchronize(repository); await syncPath(journal.root);
}
export async function initializeTask(journal: Journal): Promise<Result<true>> {
  try { await initializeEvidence(journal); return { ok: true, value: true }; } catch (error) { return evidenceFailure(error); }
}
/** Objects and all newly created directory entries precede a durable protected ref. */
export async function publishObject(journal: Journal, oid: string, name: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(oid) || !/^[a-z0-9/-]+$/.test(name)) throw invalidEvidence('Invalid Git publication identity');
  const repository = evidenceRepository(journal), objects = join(repository, 'objects');
  // Git fsyncs constructed object bytes. Its finite fanout and pack namespaces
  // need directory durability here; callers never assume an object is loose.
  await git(journal, ['cat-file', '-e', oid]);
  for (const name of await readdir(objects)) if (/^[a-f0-9]{2}$/.test(name) || name === 'pack') await syncPath(join(objects, name));
  await syncPath(objects);
  await git(journal, ['update-ref', 'refs/' + name, oid]);
  const ref = join(repository, 'refs', name);
  let carriers = 0;
  for (const path of [ref, join(repository, 'packed-refs')]) {
    try {
      await syncPath(path); carriers++;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!carriers) throw Object.assign(new Error('Published Git reference unavailable'), { code: 'ENOENT' });
  for (let path = dirname(ref); ; path = dirname(path)) {
    try { await syncPath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path === repository) break;
  }
  await syncPath(journal.root);
}
/** The raw evidence reference that `storeEvidence` published for these bytes' SHA-256 (`refs/evidence/<sha256>`),
 * authenticated like any other read. Lets a holder of a recorded hash recover the Ref without reading the project again. */
export async function publishedEvidence(journal: Journal, sha256: string): Promise<Result<Ref>> {
  try {
    let oid: string;
    try { oid = (await git(journal, ['rev-parse', '--verify', '--quiet', 'refs/evidence/' + sha256])).toString().trim(); }
    catch { throw Object.assign(new Error('Evidence was never published'), { code: 'ENOENT' }); }
    return await validateRecordRef(journal, { path: 'git/objects/' + oid, sha256 });
  } catch (error) { return evidenceFailure(error); }
}
export function evidenceOid(ref: Ref): string {
  if (!refSchema.safeParse(ref).success || !/^git\/objects\/[a-f0-9]{40}$/.test(ref.path)) throw invalidEvidence('Not a raw Git evidence reference');
  return ref.path.slice('git/objects/'.length);
}
/** The existing evidence channel carries its read protocol as well as its refs. */
export async function evidenceReader(journal: Journal) {
  return {
    argv: [await nativeTool('git'), '--git-dir=' + evidenceRepository(journal), 'cat-file', 'blob'],
    append: 'Append the last component of Ref.path (the Git object ID).',
      rawSha256: 'Verify returned raw bytes against Ref.sha256; it is distinct from the Git object ID.'
  };
}
/** Stream a selected raw object and authenticate BOTH its Git OID and declared raw SHA-256. */
export async function* streamEvidence(journal: Journal, ref: Ref): AsyncGenerator<Buffer> {
  if (!inOperation) {
    const stream = new PassThrough();
    // Authenticated reads may race reclamation and report unavailable; they own no durable effects or reservations.
    const observed = async () => ({ ok: true as const, value: true });
    const operation = runOperation({ module: import.meta.url, method: 'streamTask', args: [journal, ref] },
      { ready: observed, updated: observed, closed: observed }, undefined,
      async source => { for await (const chunk of source) if (!stream.write(chunk)) await new Promise<void>(resolve => stream.once('drain', resolve)); });
    const completed = operation.then(value => { if (!value.ok) stream.destroy(Object.assign(new Error(value.detail), {
      code: value.kind === 'unavailable' ? 'ENOENT' : value.kind === 'invalid' ? 'EINVAL' : undefined })); else stream.end(); return value; },
      error => { stream.destroy(error); return { ok: false as const, kind: 'unknown' as const, detail: String(error) }; });
    try { for await (const chunk of stream) yield Buffer.from(chunk); const value = await completed;
      if (!value.ok) throw Object.assign(new Error(value.detail), {
      code: value.kind === 'unavailable' ? 'ENOENT' : value.kind === 'invalid' ? 'EINVAL' : undefined }); }
    finally { stream.destroy(); await completed; }
    return;
  }

  const oid = evidenceOid(ref), repository = evidenceRepository(journal);
  if (await realpath(repository) !== repository) throw invalidEvidence('Aliased evidence repository');
  let loose = false;
  try {
    const carrier = await lstat(join(repository, 'objects', oid.slice(0, 2), oid.slice(2))); loose = true;
    if (!carrier.isFile() || carrier.isSymbolicLink() || carrier.mode & 0o222) throw invalidEvidence('Mutable or aliased Git object');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let info: string;
  try { info = (await git(journal, ['cat-file', '-s', oid])).toString().trim(); }
  catch (error) { if (!loose) throw Object.assign(new Error('Selected Git object unavailable'), { code: 'ENOENT' });
    throw invalidEvidence(String(error)); }
  const sha = createHash('sha256'), objectHash = createHash('sha1').update('blob ' + info + '\0');
  const { child, done: closed } = await nativeSpawn([await nativeTool('git'), '--git-dir=' + repository, 'cat-file', 'blob', oid], {
    env: environment }); child.stdin.end();
  let error = ''; child.stderr.on('data', bytes => { error += bytes; });
  try {
    for await (const chunk of child.stdout) { const bytes = Buffer.from(chunk); sha.update(bytes); objectHash.update(bytes); yield bytes; }
    if (await closed !== 0 || sha.digest('hex') !== ref.sha256 ||
      objectHash.digest('hex') !== oid) throw invalidEvidence('Selected Git evidence authentication failed: ' + error);
  } finally { if (child.exitCode === null) child.kill(); await closed; }
}
export async function validateRecordRef(journal: Journal, ref: Ref): Promise<Result<Ref>> {
  try { for await (const _chunk of streamEvidence(journal, ref)) { /* authenticate selected object */ } return { ok: true, value: ref }; }
  catch (error) { return evidenceFailure(error); }
}
export async function readEvidence(journal: Journal, ref: Ref): Promise<Result<Uint8Array>> {
  try { const chunks: Buffer[] = []; for await (const chunk of streamEvidence(journal, ref)) chunks.push(chunk); return { ok: true,
    value: Buffer.concat(chunks) }; }
  catch (error) { return evidenceFailure(error); }
}
/** Raw byte evidence uses Git's file streaming path, including objects above 2 GiB. */
export async function storeEvidence(journal: Journal, source: () => AsyncIterable<Uint8Array>): Promise<Result<Ref>> {
  if (!inOperation) { const { storeEvidence } = await import('./state.js'); return storeEvidence(journal, source); }
  const temporary = join(evidenceRepository(journal), 'incoming-' + randomUUID());
  try {
    const hash = createHash('sha256'), file = await open(temporary, 'wx', 0o600);
    try { for await (const chunk of source()) { hash.update(chunk); await file.writeFile(chunk); } await file.sync(); }
    finally { await file.close(); }
    const sha256 = hash.digest('hex'), oid = (await git(journal, ['hash-object', '--no-filters', '-w', '--', temporary])).toString().trim();
    const ref = { path: 'git/objects/' + oid, sha256 };
    const authenticated = await validateRecordRef(journal, ref); if (!authenticated.ok) return authenticated;
    await publishObject(journal, oid, 'evidence/' + sha256);
    return { ok: true, value: ref };
  } catch (error) { return evidenceFailure(error); }
  finally { await rm(temporary, { force: true }); }
}
export function identifyEvidence(bytes: Uint8Array): Ref {
  const raw = Buffer.from(bytes);
  return {
    path: 'git/objects/' + createHash('sha1').update('blob ' + raw.length + '\0').update(raw).digest('hex'),
    sha256: createHash('sha256').update(raw).digest('hex')
  };
}
export async function putEvidence(journal: Journal, bytes: Uint8Array): Promise<Result<Ref>> {
  if (!(bytes instanceof Uint8Array)) return { ok: false, kind: 'invalid', detail: 'Evidence must be bytes' };
  const frozen = Buffer.from(bytes);
  return storeEvidence(journal, async function* () { yield frozen; });
}
/** Diagnostic envelope in ordinary evidence. Its prose never chooses execution policy. */
export function decodeRefusal(bytes: Uint8Array): Extract<Result<never>, { ok: false }> | undefined {
  try {
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    const refusal = envelope?.refusal ?? envelope?.admission; // Historical admission evidence.
    if (refusal?.ok === false && ['invalid', 'conflict', 'unavailable', 'unknown'].includes(refusal.kind)
      && typeof refusal.detail === 'string') return refusal;
  } catch { /* Binary and other evidence are opaque. */ }
  return undefined;
}
function evidenceFailure(error: unknown): Result<never> {
  const code = (error as NodeJS.ErrnoException).code;
  return { ok: false, kind: code === 'ENOENT' ? 'unavailable' : ['EINVAL', 'ELOOP'].includes(code ?? '') ? 'invalid' : 'unknown',
    detail: String(error) };
}

export async function gitTask(journal: Journal, args: readonly string[], context: { env?: Record<string, string>; input?: Uint8Array }
  ): Promise<Result<Buffer>> {
  try { return { ok: true, value: await git(journal, args, context) }; } catch (error) { return evidenceFailure(error); }
}
export function storeEvidenceInput(journal: Journal) { return storeEvidence(journal, async function* () {
  for await (const chunk of process.stdin) yield Buffer.from(chunk); }); }
export async function streamTask(journal: Journal, ref: Ref): Promise<Result<true>> {
  try { for await (const chunk of streamEvidence(journal,
    ref)) if (!process.stdout.write(chunk)) await new Promise<void>(resolve => process.stdout.once('drain', resolve)); return { ok: true,
    value: true }; } catch (error) { return evidenceFailure(error); }
}
