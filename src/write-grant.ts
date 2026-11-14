import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { closeSync, mkdirSync, openSync, publishEngineFiles, writeFileSync } from './engine-fs.js';
import { stageWorkPath } from './run-layout.js';
import { resolveArtifactLocation } from './artifact-location.js';
import { gitSync } from './git-facts.js';
import { prospectivePhysicalPath } from './engine-owned-carriers.js';
import type { ArtifactContract } from './artifact-declarations.js';

export const WriteGrantCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('landlock'), abi: z.number().int().min(3) }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['platform', 'kernel_unavailable', 'kernel_disabled', 'abi_too_old']), abi: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('legacy_ungranted') }).strict(),
]);
export type WriteGrantCapability = z.infer<typeof WriteGrantCapabilitySchema>;
export const WriteGrantContractSchema = z.object({
  version: z.literal(1), capability: WriteGrantCapabilitySchema, sharedCaches: z.array(z.string().refine(isAbsolute)),
  git: z.object({ commonDir: z.string().refine(isAbsolute), worktree: z.string().refine(isAbsolute), baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable() }).strict().optional(),
}).strict();
export type WriteGrantContract = z.infer<typeof WriteGrantContractSchema>;
export const legacyWriteGrant = (): WriteGrantContract => ({ version: 1, capability: { kind: 'legacy_ungranted' }, sharedCaches: [] });

export type WriteGrantFailure =
  | { kind: 'linked_files'; count: number }
  | { kind: 'application_failed'; errno: number | null }
  | { kind: 'exec_failed'; errno: number; path: string }
  | { kind: 'capability_query_failed' }
  | { kind: 'unrepresentable_scope'; path: string }
  | { kind: 'unsafe_path'; path: string }
  | { kind: 'git_preparation_failed'; path: string };
export class WriteGrantError extends Error {
  constructor(readonly outcome: WriteGrantFailure, options?: ErrorOptions) {
    super(`WRITE_GRANT_REFUSED: ${JSON.stringify(outcome)}`, options);
    this.name = 'WriteGrantError';
  }
}

/** The existing research syscall bridge, shared by measurement and stage exec.
 * No read, network, signal or syscall policy is installed. */
export const landlockPython = `
import ctypes, os, platform, stat
libc = ctypes.CDLL(None, use_errno=True)
def checked(value):
    if value < 0:
        raise OSError(ctypes.get_errno(), 'Landlock syscall failed')
    return value
def landlock_abi():
    return checked(libc.syscall(444, 0, 0, 1))
def open_grant_root(path, root=None):
    parent = os.dup(root) if root is not None else os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        parts = [part for part in path.split('/') if part]
        for index, part in enumerate(parts):
            if part in ('.', '..'): raise OSError(22, 'non-canonical grant root')
            flags = os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW
            if index < len(parts) - 1: flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=parent)
            os.close(parent)
            parent = child
        return parent
    except:
        os.close(parent)
        raise
def apply_write_grant(paths, abi, opened=None, no_refer=()):
    if abi < 3:
        raise OSError(95, 'Landlock ABI does not protect truncate')
    writes = (1 << 1) | sum(1 << n for n in range(4, 15))
    if abi >= 5:
        writes |= 1 << 15 # IOCTL_DEV
    class Ruleset(ctypes.Structure):
        _fields_ = [('access', ctypes.c_uint64)]
    class Beneath(ctypes.Structure):
        _pack_ = 1
        _layout_ = 'ms' # the kernel struct is packed; newer Python requires the layout to be stated
        _fields_ = [('access', ctypes.c_uint64), ('parent', ctypes.c_int)]
    rules = Ruleset(writes)
    fd = checked(libc.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0))
    try:
        for path in sorted(set(paths)):
            parent = os.dup(opened[path]) if opened is not None else open_grant_root(path)
            try:
                mode = os.fstat(parent).st_mode
                if stat.S_ISLNK(mode):
                    raise OSError(40, 'grant root is a symbolic link')
                allowed = writes if stat.S_ISDIR(mode) else (1 << 1) | (1 << 14)
                # Shared roots must never carry an inode from a private root.
                # Same-directory atomic replacement still works; reparenting
                # (link/rename) involving a shared directory is denied.
                if path in no_refer: allowed &= ~(1 << 13)
                if abi >= 5 and (stat.S_ISCHR(mode) or stat.S_ISBLK(mode)):
                    allowed |= 1 << 15
                rule = Beneath(allowed, parent)
                checked(libc.syscall(445, fd, 1, ctypes.byref(rule), 0))
            finally:
                os.close(parent)
        checked(libc.prctl(38, 1, 0, 0, 0))
        checked(libc.syscall(446, fd, 0))
    finally:
        os.close(fd)
`;

const capabilityQuery = `${landlockPython}
import errno, json
if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
    result = dict(kind='unavailable', reason='platform')
else:
    try:
        abi = landlock_abi()
        result = dict(kind='landlock', abi=abi) if abi >= 3 else dict(kind='unavailable', reason='abi_too_old', abi=abi)
    except OSError as error:
        if error.errno in (errno.ENOSYS, errno.EOPNOTSUPP):
            result = dict(kind='unavailable', reason='kernel_unavailable')
        elif error.errno in (errno.EPERM, errno.EACCES):
            result = dict(kind='unavailable', reason='kernel_disabled')
        else:
            raise
print(json.dumps(result))
`;

export function queryWriteGrantCapability(): WriteGrantCapability {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) return { kind: 'unavailable', reason: 'platform' };
  try {
    return WriteGrantCapabilitySchema.parse(JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', capabilityQuery],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })));
  } catch (cause) { throw new WriteGrantError({ kind: 'capability_query_failed' }, { cause }); }
}

/** Called only by new-run admission. The snapshot, including project cache
 * declarations, is immutable for retries, continuation and redeployment. */
export function admitWriteGrant(projectDir: string, query = queryWriteGrantCapability): WriteGrantContract {
  const config = join(projectDir, 'config', 'write-grant.json');
  const declared = existsSync(config) ? z.object({ shared_caches: z.array(z.string().refine(isAbsolute)) }).strict()
    .parse(JSON.parse(readFileSync(config, 'utf8'))).shared_caches : [];
  const capability = query();
  let repository: WriteGrantContract['git'];
  if (capability.kind === 'landlock') {
    try {
      repository = { commonDir: realpathSync(git(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
        worktree: realpathSync(git(projectDir, ['rev-parse', '--show-toplevel'])), baseCommit: gitHead(projectDir) };
    } catch (cause) {
      if (existsSync(join(projectDir, '.git'))) throw new WriteGrantError({ kind: 'git_preparation_failed', path: projectDir }, { cause });
    }
  }
  return WriteGrantContractSchema.parse({ version: 1, capability, sharedCaches: [...new Set(declared.map(path => prospectivePhysicalPath(resolve(path))))], ...(repository ? { git: repository } : {}) });
}

export interface StageWriteGrant {
  contract: WriteGrantContract;
  projectDir: string;
  runDir: string;
  stageId: string;
  home: string;
  readOnly?: boolean;
  artifacts?: ArtifactContract;
  /** Validated absolute directory outputs from the admitted brief. */
  externalDirectories?: readonly string[];
}
const stageGrant = new AsyncLocalStorage<StageWriteGrant>();
export function withStageWriteGrant<T>(grant: StageWriteGrant, action: () => T): T { return stageGrant.run(grant, action); }
export function currentStageWriteGrant(): StageWriteGrant | undefined { return stageGrant.getStore(); }

const contains = (parent: string, path: string): boolean => {
  const rel = relative(parent, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

/** Resolve only literal declarations. Never follow an authored alias into a
 * new authority, or enumerate names to turn a glob into a permission. */
function literalPath(root: string, path: string, tree: boolean): string {
  const absolute = resolve(root, path);
  if (!contains(resolve(root), absolute)) throw new WriteGrantError({ kind: 'unsafe_path', path });
  const prepare = (): string => {
    let parent = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const parts = absolute.split('/').filter(Boolean);
      for (const [index, part] of parts.entries()) {
        // Node has no mkdirat API. This is a directory-descriptor-relative
        // name, as in adapter-home's credential retirement. Never resolve a
        // checked pathname again to decide where a parent mutation goes.
        const entry = `/proc/self/fd/${parent}/${part}`;
        if (!tree && index === parts.length - 1) {
          if (lstatSync(entry).isSymbolicLink()) throw new WriteGrantError({ kind: 'unsafe_path', path });
          break;
        }
        let child: number;
        try { child = openSync(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
        catch (error) {
          if (!tree || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          try { mkdirSync(entry); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          child = openSync(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        }
        closeSync(parent); parent = child;
      }
      // Keep the declared name. The launch bridge opens every component with
      // O_NOFOLLOW again; an authored replacement can refuse, never redirect it.
      return absolute;
    } catch (cause) {
      if (cause instanceof WriteGrantError) throw cause;
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new WriteGrantError({ kind: 'unrepresentable_scope', path }, { cause });
      if (code === 'ELOOP' || code === 'ENOTDIR') throw new WriteGrantError({ kind: 'unsafe_path', path }, { cause });
      throw cause;
    } finally { closeSync(parent); }
  };
  return tree ? publishEngineFiles([absolute], prepare, false, { directory: 0o777 & ~process.umask() }) : prepare();
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return gitSync(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd, env: { ...gitEnvironment(), ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** An unborn repository has no commit yet. Git's quiet verification reports
 * that state by exit code 1; other command failures still refuse admission. */
function gitHead(projectDir: string): string | null {
  try { return git(projectDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); }
  catch (error) { if ((error as { status?: number }).status === 1) return null; throw error; }
}

/** A stage owns its Git metadata, refs and index, sharing only objects with the
 * source repository. Ref deletion (including Git's post-commit AUTO_MERGE
 * cleanup) can lock packed-refs even when the ref never existed. */
function prepareStageGit(grant: StageWriteGrant, writable: WriteGrantRoot[], shared: string[]): NodeJS.ProcessEnv {
  const repository = grant.contract.git;
  if (!repository) {
    // A stage may initialize a new repository inside its project worktree, but cannot
    // redirect the engine into a newly planted external Git directory.
    return {};
  }
  const common = literalPath(dirname(repository.commonDir), repository.commonDir, false);
  if ([...writable.map(root => root.path), ...shared].some(path => contains(path, common) || contains(common, path))) throw new WriteGrantError({ kind: 'unsafe_path', path: common });
  const namespace = createHash('sha256').update(realpathSync(grant.runDir)).digest('hex');
  const branch = `fc/${namespace}/${grant.stageId}/head`;
  const metadata = stageWorkPath(grant.runDir, 'stages', grant.stageId, 'git');
  try {
    const objects = literalPath(common, join(common, 'objects'), true);
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: metadata, GIT_COMMON_DIR: metadata, GIT_WORK_TREE: repository.worktree, GIT_INDEX_FILE: join(metadata, 'index'),
      GIT_OBJECT_DIRECTORY: objects, GIT_NAMESPACE: undefined,
      // Stages write shared objects, but must never maintain that object store.
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false',
    };
    if (!existsSync(metadata)) {
      const ref = join(metadata, 'refs', 'heads', branch);
      literalPath(grant.runDir, dirname(ref), true);
      writeFileSync(join(metadata, 'HEAD'), `ref: refs/heads/${branch}\n`, { flag: 'wx' });
      if (repository.baseCommit !== null) writeFileSync(ref, `${repository.baseCommit}\n`, { flag: 'wx' });
      // Preserve repository settings (including object format and identity)
      // without granting writes to the source configuration.
      git(grant.projectDir, ['config', 'include.path', join(common, 'config')], env);
      git(grant.projectDir, ['read-tree', repository.baseCommit ?? '--empty'], env);
    }
    shared.push(objects);
    writable.push({ path: literalPath(grant.runDir, metadata, false), kind: 'directory' });
    return env;
  } catch (cause) { throw new WriteGrantError({ kind: 'git_preparation_failed', path: metadata }, { cause }); }
}

export interface WriteGrantRoot { path: string; kind: 'file' | 'directory' | 'device' }
export interface PreparedWriteGrant { abi: number; writable: WriteGrantRoot[]; noRefer: string[]; env: NodeJS.ProcessEnv }
export function prepareWriteGrant(grant: StageWriteGrant, scratch: string, inherited: NodeJS.ProcessEnv = {}): PreparedWriteGrant | undefined {
  try {
    const contract = WriteGrantContractSchema.parse(grant.contract);
    if (contract.capability.kind !== 'landlock') return undefined;
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new WriteGrantError({ kind: 'application_failed', errno: null });
    const project = realpathSync(grant.projectDir);
    const run = realpathSync(grant.runDir), work = stageWorkPath(run), temporary = realpathSync(scratch);
    const stages = join(work, 'stages'), runScratch = join(work, 'scratch');
    const assertWritableRoot = (path: string): void => {
      if (contains(path, run) || contains(path, stages) || contains(path, runScratch)
        || contains(dirname(run), path) && !contains(work, path)
        || contains(stages, path) && !contains(join(stages, grant.stageId), path)
        || contains(runScratch, path) && !contains(temporary, path)) throw new WriteGrantError({ kind: 'unsafe_path', path });
    };
    const writable: WriteGrantRoot[] = [];
    if (!grant.readOnly) {
      assertWritableRoot(project);
      writable.push({ path: literalPath(project, '.', true), kind: 'directory' });
    }
    // Own stage work is writable regardless of project access. Peer/engine roots stay closed.
    writable.push({ path: literalPath(run, join(stages, grant.stageId), true), kind: 'directory' });
    const outputs = (grant.artifacts?.produces ?? []).filter(artifact => !grant.readOnly || artifact.root !== 'project').map(artifact => ({
      root: artifact.root === 'project' ? project : realpathSync(grant.runDir),
      absolute: resolveArtifactLocation(artifact, project, run), tree: artifact.kind === 'directory',
    }));
    for (const output of outputs) {
      assertWritableRoot(output.absolute);
      if (writable.some(root => root.kind === 'directory' && contains(root.path, output.absolute))) continue;
      // A new exact file cannot be expressed by Landlock. The producer must
      // declare its directory; never silently grant its siblings.
      const path = literalPath(output.root, output.absolute, output.tree);
      if (!output.tree && !lstatSync(path).isFile()) throw new WriteGrantError({ kind: 'unsafe_path', path });
      writable.push({ path, kind: output.tree ? 'directory' : 'file' });
    }
    if (!contains(resolve(grant.runDir), resolve(grant.home))) throw new WriteGrantError({ kind: 'unsafe_path', path: grant.home });
    const home = literalPath(run, relative(resolve(grant.runDir), resolve(grant.home)), true);
    writable.push({ path: home, kind: 'directory' }, { path: temporary, kind: 'directory' }, { path: '/dev/null', kind: 'device' });
    const shared: string[] = [];
    for (const path of [...contract.sharedCaches, ...(grant.readOnly ? [] : grant.externalDirectories ?? [])]) {
      if (!isAbsolute(path)) throw new WriteGrantError({ kind: 'unsafe_path', path });
      assertWritableRoot(path);
      if (grant.readOnly && (contains(project, path) || contains(path, project))) throw new WriteGrantError({ kind: 'unsafe_path', path });
      shared.push(literalPath('/', path, true));
    }
    const gitEnv = prepareStageGit(grant, writable, shared);
    // Landlock allow rules are additive. An overlapping grant with REFER
    // would undo the shared boundary. Include exact paths: a file can become
    // a directory before the child pins it. Never decide this boundary by type.
    for (const path of shared) {
      if (writable.some(root => contains(root.path, path) || contains(path, root.path))) throw new WriteGrantError({ kind: 'unsafe_path', path });
    }
    writable.push(...shared.map(path => ({ path, kind: 'directory' as const })));
    for (const root of writable) assertWritableRoot(root.path);
    // Undeclared tool state stays within the stage home and actual invocation
    // scratch. Explicitly declared shared caches are available by their paths;
    // ambient cache variables never grant authority.
    const cache = join(home, 'cache');
    literalPath(home, cache, true);
    const runtime = literalPath(temporary, join(temporary, 'runtime'), true);
    const env: NodeJS.ProcessEnv = {
      HOME: home, USERPROFILE: home, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
      XDG_RUNTIME_DIR: runtime, npm_config_cache: join(cache, 'npm'), NPM_CONFIG_CACHE: join(cache, 'npm'),
      PIP_CACHE_DIR: join(cache, 'pip'), UV_CACHE_DIR: join(cache, 'uv'), YARN_CACHE_FOLDER: join(cache, 'yarn'),
      PNPM_HOME: join(home, 'pnpm'), COREPACK_HOME: join(cache, 'corepack'), CARGO_HOME: join(home, 'cargo'),
      RUSTUP_HOME: join(home, 'rustup'), GOPATH: join(home, 'go'), GOCACHE: join(cache, 'go-build'),
      GRADLE_USER_HOME: join(home, 'gradle'), CCACHE_DIR: join(cache, 'ccache'), ...gitEnv,
    };
    for (const name of ['XDG_CACHE_HOME', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'YARN_CACHE_FOLDER', 'COREPACK_HOME', 'CCACHE_DIR', 'GOCACHE']) {
      const value = inherited[name];
      if (value && isAbsolute(value) && contract.sharedCaches.some(cache => contains(cache, resolve(value)))) env[name] = value;
    }
    const npmCache = env.npm_config_cache !== join(cache, 'npm') ? env.npm_config_cache : env.NPM_CONFIG_CACHE;
    env.npm_config_cache = env.NPM_CONFIG_CACHE = npmCache;
    return { abi: contract.capability.abi, writable, noRefer: [...new Set(shared)], env };
  } catch (cause) {
    if (cause instanceof WriteGrantError) throw cause;
    const errno = (cause as NodeJS.ErrnoException).errno;
    throw new WriteGrantError({ kind: 'application_failed', errno: typeof errno === 'number' ? Math.abs(errno) : null }, { cause });
  }
}

/** FD 4 is an engine-only launch receipt, closed on successful exec. Failures
 * are numeric/closed data, never recognized from agent stdout or diagnostics. */
export const writeGrantExecPython = `${landlockPython}
import json, sys
os.set_inheritable(4, False)
def refuse(outcome):
    os.write(4, (json.dumps(outcome) + '\\n').encode())
    sys.exit(125)
try:
    grant = json.loads(sys.argv[1])
    seen = set()
    linked = 0
    opened = {}
    for root in grant['writable']:
        path, kind = root['path'], root['kind']
        if path not in opened: opened[path] = open_grant_root(path)
        mode = os.fstat(opened[path]).st_mode
        # The declaration selects authority. Validate against the same pinned
        # descriptor used for counting and Landlock; never infer a tree grant
        # from a pathname's replacement inode.
        if not ((kind == 'file' and stat.S_ISREG(mode)) or
                (kind == 'directory' and stat.S_ISDIR(mode)) or
                (kind == 'device' and stat.S_ISCHR(mode))):
            refuse(dict(kind='unsafe_path', path=path))
    def count(root_path, root):
        global linked
        pending = ['']
        while pending:
            relative = pending.pop()
            path = os.path.join(root_path, relative) if relative else root_path
            if path in seen: continue
            seen.add(path)
            # Reopen beneath the pinned root, one no-follow component at a
            # time. Both Python stack depth and live descriptors stay bounded
            # independently of filesystem depth and directory width.
            descriptor = open_grant_root(relative, root)
            try:
                info = os.fstat(descriptor)
                if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                    linked += 1
                elif stat.S_ISDIR(info.st_mode):
                    directory = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, dir_fd=descriptor)
                    try:
                        with os.scandir(directory) as entries:
                            pending.extend(os.path.join(relative, entry.name) for entry in entries)
                    finally:
                        os.close(directory)
            finally:
                os.close(descriptor)
    for path, descriptor in opened.items(): count(path, descriptor)
    if linked:
        refuse(dict(kind='linked_files', count=linked))
    apply_write_grant(opened, grant['abi'], opened, grant['noRefer'])
    for descriptor in opened.values(): os.close(descriptor)
    os.write(4, (json.dumps(dict(kind='applied', abi=grant['abi'], linkedFileCount=0)) + '\\n').encode())
except OSError as error:
    refuse(dict(kind='application_failed', errno=error.errno))
except Exception:
    refuse(dict(kind='application_failed', errno=None))
# Restore the dispositions CPython ignores before replacing it with the agent.
import signal
for restored in ('SIGPIPE', 'SIGXFZ', 'SIGXFSZ'):
    if hasattr(signal, restored): signal.signal(getattr(signal, restored), signal.SIG_DFL)
try:
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
except OSError as error:
    refuse(dict(kind='exec_failed', errno=error.errno, path=sys.argv[2]))
`;
