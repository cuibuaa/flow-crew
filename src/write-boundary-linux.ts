/** Single-threaded, stdlib-only syscall bridge. No stage code runs before the
 * policy is installed. File descriptors opened here are closed before exec. */
export const LINUX_ENGINE_WRITE_BOUNDARY = String.raw`
import ctypes, errno, json, os, platform, stat, sys, time
from collections import deque

class PrerequisiteChanged(RuntimeError):
    pass

def checked(value, operation):
    if value < 0:
        raise OSError(ctypes.get_errno(), operation)
    return value

def identity(info):
    return (info.st_dev, info.st_ino)

def within(root, path):
    return os.path.commonpath([root, path]) == root

try:
    # Dedicated launcher receipt pipe; the executable cannot inherit or forge it.
    os.set_inheritable(3, False)
    config = json.loads(sys.argv[1])
    if config.get('newSession'):
        os.setsid()
    def prepare():
        ruleset = None
        try:
            if platform.machine() not in ('x86_64', 'aarch64', 'riscv64'):
                raise RuntimeError('unsupported Linux syscall architecture')
            protected = set()
            protected_paths = {}

            def protect(info, path):
                key = identity(info)
                protected.add(key)
                protected_paths.setdefault(key, path)

            def conflict(message, path, key):
                recorded = protected_paths.get(key)
                raise RuntimeError(message + path + ('; protected entry ' + recorded if recorded else ''))

            def protected_target(path, carrier):
                # Explicit carriers own every consulted component and the final
                # target. A granted intermediate hop must not retarget engine state.
                cursor = '/'
                pending = deque(path.split('/'))
                hops = 0
                while pending:
                    name = pending.popleft()
                    if not name or name == '.':
                        continue
                    if name == '..':
                        cursor = os.path.dirname(cursor)
                        protect(os.stat(cursor), carrier)
                        continue
                    current = os.path.join(cursor, name)
                    info = os.lstat(current)
                    protect(info, carrier)
                    if stat.S_ISLNK(info.st_mode):
                        hops += 1
                        if hops > 40:
                            raise OSError(errno.ELOOP, 'protected symbolic link loop', path)
                        protect(os.stat(cursor), carrier)
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
                    try:
                        info = os.lstat(current)
                        protect(info, current)
                        if stat.S_ISLNK(info.st_mode):
                            target = os.readlink(current)
                            try:
                                if current == path:
                                    info = protected_target(current, current)
                                else:
                                    # Discovered references own only their link inode;
                                    # live project grants may change targets and hops.
                                    os.stat(current)
                            except OSError as error:
                                # Broken/looped references remain a prompt refusal,
                                # distinct from a listed entry disappearing below.
                                if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                                    raise RuntimeError('cannot resolve protected link ' + current + ' -> ' + target + ': ' + str(error)) from error
                                raise
                        if entry['tree'] and stat.S_ISDIR(info.st_mode) and identity(info) not in seen:
                            seen.add(identity(info))
                            with os.scandir(current) as members:
                                pending.extend(member.path for member in members)
                    except OSError as error:
                        if error.errno in (errno.ENOENT, errno.ENOTDIR):
                            raise PrerequisiteChanged('protected tree changed during inspection: ' + current + ': ' + str(error)) from error
                        raise
                # Also protect namespace parents for ordinary entries and references.
                ancestor = os.path.dirname(os.path.abspath(path))
                while True:
                    protected.add(identity(os.stat(ancestor)))
                    parent = os.path.dirname(ancestor)
                    if parent == ancestor:
                        break
                    ancestor = parent

            def inspect_writable():
                aliases = {}
                labels = {}
                links = {}
                visited = set()

                def member(info, parent, name, label):
                    key = identity(info)
                    if key in protected:
                        conflict('writable member aliases an engine carrier or ancestor: ', label, key)
                    if stat.S_ISLNK(info.st_mode):
                        # Check the link inode, but grant no rights on its target
                        # and never traverse mutable directory links.
                        return
                    if stat.S_ISREG(info.st_mode):
                        # A link name is a directory inode plus basename, independent
                        # of path spelling, bind views or renames. No per-file realpath
                        # walk is needed to count the complete inode link set.
                        aliases.setdefault(key, set()).add((parent, name))
                        labels[key] = label
                        if key in links and links[key] != info.st_nlink:
                            raise PrerequisiteChanged('writable hard-link identity changed during inspection: ' + label)
                        links[key] = info.st_nlink
                    elif not stat.S_ISDIR(info.st_mode):
                        raise RuntimeError('writable member is not a regular file/directory: ' + label)

                for path in config['directories'] + config['files']:
                    info = os.lstat(path)
                    key = identity(info)
                    if key in protected:
                        conflict('writable identity aliases an engine carrier or ancestor: ', path, key)
                    if stat.S_ISLNK(info.st_mode):
                        raise RuntimeError('writable capability is a symbolic link: ' + path + ' -> ' + os.readlink(path))
                    if not stat.S_ISDIR(info.st_mode):
                        parent = os.open(os.path.dirname(path), os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
                        try:
                            current = os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False)
                            if identity(current) != key:
                                raise PrerequisiteChanged('writable file capability changed during inspection: ' + path)
                            member(current, identity(os.fstat(parent)), os.path.basename(path), path)
                        finally: os.close(parent)
                        continue
                    frames = []
                    def descend(parent, name, expected, label):
                        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                        try:
                            current = os.fstat(fd)
                            if identity(current) in protected:
                                conflict('writable directory aliases an engine carrier or ancestor: ', label, identity(current))
                            if identity(current) != expected:
                                raise PrerequisiteChanged('writable directory identity changed during inspection: ' + label)
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
                        raise PrerequisiteChanged('writable hard-link closure is unknown: ' + labels[key])

            inspect_writable()
            libc = ctypes.CDLL(None, use_errno=True)
            abi = checked(libc.syscall(444, 0, 0, 1), 'landlock_create_ruleset ABI')
            if abi < 3:
                raise RuntimeError('Landlock ABI >= 3 is required; observed ' + str(abi))
            # WRITE_FILE, REMOVE_*, MAKE_*, REFER, TRUNCATE; device ioctl when available.
            writes = (1 << 1) | sum(1 << bit for bit in range(4, 15))
            handled = writes | ((1 << 15) if abi >= 5 else 0)
            file_writes = (1 << 1) | (1 << 14)
            # Durable roots must never accumulate nodes that the next launch refuses.
            # IPC is useful only in the parent-owned, finally-discarded scratch tree.
            special = (1 << 6) | (1 << 9) | (1 << 10) | (1 << 11)
            durable_writes = writes & ~special
            scratch_writes = writes & ~((1 << 6) | (1 << 11))
            class Ruleset(ctypes.Structure):
                _fields_ = [('handled_access_fs', ctypes.c_uint64), ('handled_access_net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]
            class PathRule(ctypes.Structure):
                _pack_ = 1
                _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]
            # ABI 6 scopes confine signals and abstract Unix peers to this domain
            # and its descendants. Filesystem rights alone cannot express either.
            scoped = 3 if abi >= 6 else 0
            attr = Ruleset(handled, 0, scoped)
            ruleset = checked(libc.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr) if abi >= 6 else 8, 0), 'landlock_create_ruleset')
            pinned = []
            for path, rights in [(p, scratch_writes if p in config.get('scratchDirectories', [config['scratch']]) else durable_writes) for p in config['directories']] + [(p, file_writes) for p in config['files']] + [(os.devnull, file_writes)]:
                fd = os.open(path, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
                try:
                    info = os.fstat(fd)
                    if path != os.devnull and (identity(info) in protected or stat.S_ISLNK(info.st_mode)):
                        if identity(info) in protected:
                            conflict('capability changed to a protected identity: ', path, identity(info))
                        raise RuntimeError('capability changed to a symbolic link: ' + path + ' -> ' + os.readlink(path))
                    pinned.append((path, identity(info), info.st_mode))
                    rule = PathRule(rights, fd)
                    checked(libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0), 'landlock_add_rule')
                finally:
                    os.close(fd)
            return libc, ruleset, pinned, inspect_writable, abi
        except:
            if ruleset is not None:
                os.close(ruleset)
            raise

    # The trusted bridge waits before any child code or enforcement is installed.
    # The caller's unchanged absolute timeout/abort owns this process throughout.
    previous = None
    while True:
        try:
            libc, ruleset, pinned, inspect_writable, abi = prepare()
            break
        except Exception as error:
            # Policy conflicts, broken protected links and missing enforcement
            # support require an operator change. Only closure/identity churn or
            # an explicitly transient kernel condition can clear while we wait.
            if not isinstance(error, PrerequisiteChanged) and not (isinstance(error, OSError) and error.errno in (errno.EAGAIN, errno.EBUSY, errno.EINTR, errno.ESTALE)):
                raise
            message = 'ENGINE_WRITE_BOUNDARY_WAITING: ' + str(error)
            if message != previous:
                os.write(3, (json.dumps({'kind': 'waiting', 'phase': 'pre_execution', 'pid': os.getpid(), 'message': message}) + '\n').encode())
                print(message, file=sys.stderr, flush=True)
                previous = message
            time.sleep(1)

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
    scopes = {'signal': 'enforced' if abi >= 6 else 'unavailable', 'abstractUnixSocket': 'enforced' if abi >= 6 else 'unavailable'}
    if abi < 6:
        print('ENGINE_WRITE_BOUNDARY_SCOPE_UNAVAILABLE: Landlock ABI ' + str(abi) + ' does not confine signals or abstract Unix sockets', file=sys.stderr, flush=True)
    os.write(3, (json.dumps({'kind': 'installed', 'abi': abi, 'pid': os.getpid(), 'fileCapabilities': len(config['files']), 'directoryCapabilities': len(config['directories']), 'scopes': scopes}) + '\n').encode())
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
