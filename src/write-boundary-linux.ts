/** Single-threaded, stdlib-only syscall bridge. No stage code runs before the
 * policy is installed. File descriptors opened here are closed before exec. */
export const LINUX_ENGINE_WRITE_BOUNDARY = String.raw`
import ctypes, errno, json, os, platform, stat, sys
from collections import deque

def checked(value, operation):
    if value < 0:
        raise OSError(ctypes.get_errno(), operation)
    return value

def identity(info):
    return (info.st_dev, info.st_ino)

def within(root, path):
    return os.path.commonpath([root, path]) == root

def fail_scan(error):
    raise error

try:
    # Dedicated launcher receipt pipe; the executable cannot inherit or forge it.
    os.set_inheritable(3, False)
    config = json.loads(sys.argv[1])
    if config.get('newSession'):
        os.setsid()
    if platform.machine() not in ('x86_64', 'aarch64', 'riscv64'):
        raise RuntimeError('unsupported Linux syscall architecture')
    protected = set()

    def protected_target(path):
        # Resolve in kernel component order. Every consulted link/directory is
        # load-bearing: replacing an intermediate hop must not retarget a
        # carrier even when its current final inode lives outside the grants.
        cursor = '/'
        pending = deque(path.split('/'))
        hops = 0
        while pending:
            name = pending.popleft()
            if not name or name == '.':
                continue
            if name == '..':
                cursor = os.path.dirname(cursor)
                protected.add(identity(os.stat(cursor)))
                continue
            current = os.path.join(cursor, name)
            info = os.lstat(current)
            protected.add(identity(info))
            if stat.S_ISLNK(info.st_mode):
                hops += 1
                if hops > 40:
                    raise OSError(errno.ELOOP, 'protected symbolic link loop', path)
                protected.add(identity(os.stat(cursor)))
                target = os.readlink(current)
                if target.startswith('/'):
                    cursor = '/'
                pending.extendleft(reversed(target.split('/')))
            else:
                if pending and not stat.S_ISDIR(info.st_mode):
                    raise OSError(errno.ENOTDIR, 'protected component is not a directory', current)
                cursor = current
        return os.stat(cursor)

    for entry in config['protected']:
        path = entry['path']
        if not os.path.lexists(path):
            continue
        pending = [path]
        seen = set()
        while pending:
            current = pending.pop()
            # Ordinary entries avoid a repeated full ancestor walk. Links use
            # the component walk; broken/looped/unknown chains still refuse.
            info = os.lstat(current)
            if stat.S_ISLNK(info.st_mode):
                info = protected_target(current)
            protected.add(identity(info))
            if entry['tree'] and stat.S_ISDIR(info.st_mode) and identity(info) not in seen:
                seen.add(identity(info))
                if os.path.islink(current):
                    raise RuntimeError('protected directory alias closure is unknown: ' + current)
                with os.scandir(current) as members:
                    pending.extend(member.path for member in members)
        ancestor = os.path.dirname(os.path.realpath(path))
        while True:
            protected.add(identity(os.stat(ancestor)))
            parent = os.path.dirname(ancestor)
            if parent == ancestor:
                break
            ancestor = parent

    def inspect_writable():
        aliases = {}
        links = {}
        visited = set()

        def member(info, parent, name, label):
            key = identity(info)
            if key in protected:
                raise RuntimeError('writable member aliases an engine carrier or ancestor: ' + label)
            if stat.S_ISREG(info.st_mode):
                # A link name is a directory inode plus basename, independent
                # of path spelling, bind views or renames. No per-file realpath
                # walk is needed to count the complete inode link set.
                aliases.setdefault(key, set()).add((parent, name))
                if key in links and links[key] != info.st_nlink:
                    raise RuntimeError('writable hard-link identity changed during inspection: ' + label)
                links[key] = info.st_nlink
            elif not stat.S_ISDIR(info.st_mode):
                raise RuntimeError('writable member is not a regular file/directory: ' + label)

        for path in config['directories'] + config['files']:
            info = os.lstat(path)
            key = identity(info)
            if key in protected:
                raise RuntimeError('writable identity aliases an engine carrier or ancestor: ' + path)
            if stat.S_ISLNK(info.st_mode):
                raise RuntimeError('writable capability is a symbolic link: ' + path)
            if not stat.S_ISDIR(info.st_mode):
                parent = os.open(os.path.dirname(path), os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
                try:
                    current = os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False)
                    if identity(current) != key:
                        raise RuntimeError('writable file capability changed during inspection: ' + path)
                    member(current, identity(os.fstat(parent)), os.path.basename(path), path)
                finally: os.close(parent)
                continue
            frames = []
            def descend(parent, name, expected, label):
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                try:
                    current = os.fstat(fd)
                    if identity(current) != expected or identity(current) in protected:
                        raise RuntimeError('writable directory identity changed during inspection: ' + label)
                    if expected in visited:
                        os.close(fd)
                        return
                    visited.add(expected)
                    frames.append((fd, os.scandir(fd), label, expected))
                except:
                    os.close(fd)
                    raise
            try:
                descend(None, path, key, path)
                while frames:
                    fd, members, label, parent_key = frames[-1]
                    try: entry = next(members)
                    except StopIteration:
                        members.close()
                        os.close(fd)
                        frames.pop()
                        continue
                    current = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    if stat.S_ISLNK(current.st_mode):
                        # Links grant no rights on their targets. Never traverse
                        # mutable directory links, including during inspection.
                        continue
                    child = os.path.join(label, entry.name)
                    member(current, parent_key, entry.name, child)
                    if stat.S_ISDIR(current.st_mode):
                        descend(fd, entry.name, identity(current), child)
            finally:
                for fd, members, label, parent_key in frames:
                    members.close()
                    os.close(fd)
        for key, names in aliases.items():
            if links[key] != len(names):
                raise RuntimeError('writable hard-link closure is unknown: ' + str(next(iter(names))))

    inspect_writable()
    libc = ctypes.CDLL(None, use_errno=True)
    abi = checked(libc.syscall(444, 0, 0, 1), 'landlock_create_ruleset ABI')
    if abi < 3:
        raise RuntimeError('Landlock ABI >= 3 is required; observed ' + str(abi))
    # WRITE_FILE, REMOVE_*, MAKE_*, REFER, TRUNCATE; device ioctl when available.
    writes = (1 << 1) | sum(1 << bit for bit in range(4, 15))
    handled = writes | ((1 << 15) if abi >= 5 else 0)
    file_writes = (1 << 1) | (1 << 14)
    class Ruleset(ctypes.Structure):
        _fields_ = [('handled_access_fs', ctypes.c_uint64)]
    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]
    attr = Ruleset(handled)
    ruleset = checked(libc.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0), 'landlock_create_ruleset')
    pinned = []
    for path, rights in [(p, writes) for p in config['directories']] + [(p, file_writes) for p in config['files']] + [(os.devnull, file_writes)]:
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if path != os.devnull and (identity(info) in protected or stat.S_ISLNK(info.st_mode)):
                raise RuntimeError('capability changed to a protected identity or link: ' + path)
            pinned.append((path, identity(info), info.st_mode))
            rule = PathRule(rights, fd)
            checked(libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0), 'landlock_add_rule')
        finally:
            os.close(fd)
    checked(libc.prctl(38, 1, 0, 0, 0), 'PR_SET_NO_NEW_PRIVS')
    checked(libc.syscall(446, ruleset, 0), 'landlock_restrict_self')
    os.close(ruleset)
    for path, key, mode in pinned:
        info = os.lstat(path)
        if identity(info) != key or info.st_mode != mode:
            raise RuntimeError('capability identity changed during enforcement: ' + path)
    # A namespace/bind view cannot widen the inode policy. Check the actual
    # writable members again after enforcement, not only their lexical names.
    inspect_writable()
    scratch = config['scratch']
    os.environ.update(TMPDIR=os.path.join(scratch, 'tmp'), TMP=os.path.join(scratch, 'tmp'), TEMP=os.path.join(scratch, 'tmp'),
        XDG_CACHE_HOME=os.path.join(scratch, 'cache'), XDG_STATE_HOME=os.path.join(scratch, 'state'),
        npm_config_cache=os.path.join(scratch, 'npm'), NPM_CONFIG_CACHE=os.path.join(scratch, 'npm'))
    os.write(3, (json.dumps({'kind': 'installed', 'abi': abi, 'pid': os.getpid(), 'fileCapabilities': len(config['files']), 'directoryCapabilities': len(config['directories'])}) + '\n').encode())
except Exception as error:
    message = 'ENGINE_WRITE_BOUNDARY_REFUSED: ' + str(error) + '; declare regular output files or isolated output directories; protected parents cannot be replaced'
    os.write(3, (json.dumps({'kind': 'refused', 'message': message}) + '\n').encode())
    print(message, file=sys.stderr)
    sys.exit(125)

# Landlock survives exec, forks, nested shells and adapter-internal retries.
try:
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
except OSError as error:
    failure = {'kind': 'spawn_error', 'message': str(error), 'code': errno.errorcode.get(error.errno), 'syscall': 'execve', 'path': sys.argv[2], 'cwd': os.getcwd()}
    os.write(3, (json.dumps(failure) + '\n').encode())
    print('ENGINE_CHILD_SPAWN_FAILED: ' + str(error), file=sys.stderr)
    sys.exit(127)
`;
