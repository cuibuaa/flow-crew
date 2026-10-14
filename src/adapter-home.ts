import { spawnSync } from 'node:child_process';
import { closeSync, openSync, unlinkSync, publishEngineFiles } from './engine-fs.js';
import { constants, fstatSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Node has no dirfd-relative filesystem API. The trusted parent uses a small
 * stdlib bridge so a child cannot redirect config, auth or cache publication
 * between a pathname check and a write. No adapter executable runs here. */
const PREPARE_HOME = String.raw`
import json, os, stat, sys, uuid

def directory(parent, name, create=True, read=False):
    if create:
        try: os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            try: os.mkdir(name, 0o700, dir_fd=parent)
            except FileExistsError: pass
    return os.open(name, (os.O_RDONLY if read else os.O_PATH) | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)

def home(path):
    fd = os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for name in path.split('/'):
            if not name or name == '.': continue
            if name == '..': raise RuntimeError('parent traversal in adapter home')
            child = directory(fd, name)
            os.close(fd)
            fd = child
        return fd
    except:
        os.close(fd)
        raise

def publish(parent, name, data):
    temporary = '.flowcrew-' + uuid.uuid4().hex
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as output: output.write(data)
        # renameat replaces an entry, never follows a newly substituted link.
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass

def copy_cache(source, target, root=None):
    if root is None: root = os.readlink('/proc/self/fd/' + str(source))
    for name in os.listdir(source):
        if name in ['auth.json', 'credentials.json', 'installation_id']: continue
        info = os.stat(name, dir_fd=source, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            src = directory(source, name, False, True)
            try:
                dst = directory(target, name)
                try: copy_cache(src, dst, root)
                finally: os.close(dst)
            finally: os.close(src)
        elif stat.S_ISREG(info.st_mode):
            src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=source)
            with os.fdopen(src, 'rb') as stream: publish(target, name, stream.read())
        elif stat.S_ISLNK(info.st_mode):
            # Relocate internal links; never install a writable alias to the
            # source cache, another stage, or an operator home.
            parent = os.readlink('/proc/self/fd/' + str(source))
            endpoint = os.path.normpath(os.path.join(parent, os.readlink(name, dir_fd=source)))
            if os.path.commonpath([root, endpoint]) != root:
                raise RuntimeError('cache link leaves private copy: ' + name)
            os.symlink(os.path.relpath(endpoint, parent), name, dir_fd=target)
        else: raise RuntimeError('cache member is not a file, directory or link: ' + name)

def cache(parent, name, source):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode):
            os.unlink(name, dir_fd=parent)
        elif stat.S_ISDIR(info.st_mode): return
        else: raise RuntimeError('cache slot is not a directory: ' + name)
    except FileNotFoundError: pass
    # Only a completed private copy gets the reusable name. A refused or
    # interrupted copy must never look prepared to the next invocation.
    temporary = '.flowcrew-' + uuid.uuid4().hex
    os.mkdir(temporary, 0o700, dir_fd=parent)
    try:
        dst = directory(parent, temporary, False)
        try:
            try: src = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            except FileNotFoundError: src = None
            if src is not None:
                try: copy_cache(src, dst)
                finally: os.close(src)
        finally: os.close(dst)
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    except:
        # Python 3.10's symlink-safe rmtree has no dir_fd parameter; anchor
        # its root to the already-open private parent instead.
        import shutil
        try: shutil.rmtree('/proc/self/fd/' + str(parent) + '/' + temporary)
        except FileNotFoundError: pass
        raise

try:
    config = json.load(sys.stdin)
    fd = os.dup(3) if config.get('credentials') else home(config['home'])
    try:
        if config.get('credentials'):
            for name in ['auth.json', 'credentials.json', 'installation_id']:
                try:
                    with open(os.path.join(config['sourceHome'], name), 'rb') as stream: data = stream.read()
                except (OSError, IsADirectoryError): continue
                publish(fd, name, data)
            sys.exit(0)
        # A resumed stage forks the closed predecessor's conversation into its
        # own home. Only session state is needed; tools are privately seeded
        # below and identity/config are resolved for this stage.
        if config.get('sessionHome'):
            try: src = os.open(config['sessionHome'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            except FileNotFoundError: src = None # CLI owns missing-session diagnosis/fallback.
            try:
                for name in os.listdir(src) if src is not None else []:
                    if name == config.get('sessionDirectory', 'sessions'):
                        sessions = directory(src, name, False, True)
                        try:
                            dst = directory(fd, name)
                            try: copy_cache(sessions, dst)
                            finally: os.close(dst)
                        finally: os.close(sessions)
            finally:
                if src is not None: os.close(src)
        if config.get('plugins'):
            tmp = directory(fd, '.tmp')
            try: cache(tmp, 'plugins', config['plugins'])
            finally: os.close(tmp)
        if config.get('skills'): cache(fd, 'skills', config['skills'])
        if 'config' in config: publish(fd, 'config.toml', config['config'].encode())
    finally: os.close(fd)
except Exception as error:
    # Do not emit file contents or source credentials.
    print('ADAPTER_HOME_REFUSED: ' + str(error), file=sys.stderr)
    sys.exit(125)
`;

export function prepareAdapterHome(input: {
  home: string; plugins?: string; skills?: string;
  sessionHome?: string; sessionDirectory?: string; config?: string;
}): void {
  if (process.platform !== 'linux' || !isAbsolute(input.home)) {
    throw new Error('ADAPTER_HOME_REFUSED: an absolute Linux adapter home is required for anchored publication');
  }
  // The anchored helper also creates public parent directories. Publish that
  // namespace change without replacing its no-follow traversal with mkdir -p.
  const result = publishEngineFiles([dirname(input.home)], () => spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', PREPARE_HOME], {
    input: JSON.stringify({ ...input,
      plugins: input.plugins ? resolve(input.plugins) : undefined,
      skills: input.skills ? resolve(input.skills) : undefined }),
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
  }));
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr.trim() || `ADAPTER_HOME_REFUSED: home preparation did not complete (${result.error?.message ?? result.status})`);
  }
}

/** Credentials belong to one native execution, never to retained session state.
 * Keep the home pinned until the owned process group has settled; unlink only
 * credential entries, even if the child substitutes a link or renames the home.
 * The finally also retires a partial copy or a failed launch. */
export async function withAdapterCredentials<T>(home: string, sourceHome: string, execute: () => Promise<T>): Promise<T> {
  const fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    let source;
    try { source = statSync(sourceHome); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const target = fstatSync(fd);
    if (source && source.dev === target.dev && source.ino === target.ino) {
      throw new Error('ADAPTER_HOME_REFUSED: credential source must be separate from execution home');
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let value: T;
  try {
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', PREPARE_HOME], {
      input: JSON.stringify({ credentials: true, sourceHome: resolve(sourceHome) }),
      stdio: ['pipe', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(result.stderr.trim() || 'ADAPTER_HOME_REFUSED: credential preparation did not complete');
    }
    value = await execute();
  } catch (error) {
    const cleanup = retireCredentials(fd);
    throw cleanup ? new AggregateError([error, cleanup], 'credential cleanup also failed') : error;
  }
  const cleanup = retireCredentials(fd);
  if (cleanup) throw cleanup;
  return value;
}

/** Unlinks credential entries and closes the pinned home; returns, never throws, the first failure. */
function retireCredentials(fd: number): unknown {
  let failure: unknown;
  try {
    for (const name of ['auth.json', 'credentials.json', 'installation_id']) {
      try { unlinkSync(`/proc/self/fd/${fd}/${name}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= error; }
    }
  } finally { closeSync(fd); }
  return failure;
}
