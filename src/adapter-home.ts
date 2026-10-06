import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

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
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError('publication slot must be one regular, unaliased file: ' + name)
    except FileNotFoundError: pass
    temporary = '.flowcrew-' + uuid.uuid4().hex
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as output: output.write(data)
        # renameat replaces an entry, never follows a newly substituted link.
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass

def copy_cache(source, target):
    for name in os.listdir(source):
        info = os.stat(name, dir_fd=source, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            src = directory(source, name, False, True)
            try:
                dst = directory(target, name)
                try: copy_cache(src, dst)
                finally: os.close(dst)
            finally: os.close(src)
        elif stat.S_ISREG(info.st_mode):
            src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=source)
            with os.fdopen(src, 'rb') as stream: publish(target, name, stream.read())
        elif stat.S_ISLNK(info.st_mode):
            # Copy the link entry, never write through its target.
            os.symlink(os.readlink(name, dir_fd=source), name, dir_fd=target)
        else: raise RuntimeError('cache member is not a file, directory or link: ' + name)

def cache(parent, name, source, private):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode):
            if not private: return
            os.unlink(name, dir_fd=parent)
        elif stat.S_ISDIR(info.st_mode): return
        else: raise RuntimeError('cache slot is not a directory: ' + name)
    except FileNotFoundError: pass
    if not private:
        if not os.path.isdir(source):
            shared = home(source)
            os.close(shared)
        os.symlink(source, name, dir_fd=parent)
        return
    dst = directory(parent, name)
    try:
        try: src = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        except FileNotFoundError: return
        try: copy_cache(src, dst)
        finally: os.close(src)
    finally: os.close(dst)

try:
    config = json.load(sys.stdin)
    fd = home(config['home'])
    try:
        if config['sourceHome'] != config['home']:
            for name in ['auth.json', 'credentials.json', 'installation_id']:
                try:
                    with open(os.path.join(config['sourceHome'], name), 'rb') as stream: data = stream.read()
                except (OSError, IsADirectoryError): continue
                publish(fd, name, data)
        tmp = directory(fd, '.tmp')
        try: cache(tmp, 'plugins', config['plugins'], config['private'])
        finally: os.close(tmp)
        cache(fd, 'skills', config['skills'], config['private'])
        publish(fd, 'config.toml', config['config'].encode())
    finally: os.close(fd)
except Exception as error:
    # Do not emit file contents or source credentials.
    print('ADAPTER_HOME_REFUSED: ' + str(error), file=sys.stderr)
    sys.exit(125)
`;

export function prepareAdapterHome(input: {
  home: string; sourceHome: string; plugins: string; skills: string;
  private: boolean; config: string;
}): void {
  if (process.platform !== 'linux' || !isAbsolute(input.home)) {
    throw new Error('ADAPTER_HOME_REFUSED: an absolute Linux adapter home is required for anchored publication');
  }
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', PREPARE_HOME], {
    input: JSON.stringify({ ...input, sourceHome: resolve(input.sourceHome),
      plugins: resolve(input.plugins), skills: resolve(input.skills) }),
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr.trim() || `ADAPTER_HOME_REFUSED: home preparation did not complete (${result.error?.message ?? result.status})`);
  }
}
