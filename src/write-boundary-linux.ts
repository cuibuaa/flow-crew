/** Single-threaded, stdlib-only syscall bridge. No stage code runs before the
 * policy is installed. File descriptors opened here are closed before exec. */
export const LINUX_ENGINE_WRITE_BOUNDARY = String.raw`
import ctypes, errno, json, os, platform, stat, sys

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
    for entry in config['protected']:
        path = entry['path']
        if not os.path.lexists(path):
            continue
        pending = [path]
        seen = set()
        while pending:
            current = pending.pop()
            info = os.stat(current)
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
        for path in config['directories'] + config['files']:
            info = os.stat(path)
            if identity(info) in protected:
                raise RuntimeError('writable identity aliases an engine carrier or ancestor: ' + path)
            if os.path.islink(path):
                raise RuntimeError('writable capability is a symbolic link: ' + path)
            pending = [path]
            while pending:
                current = pending.pop()
                info = os.lstat(current)
                if stat.S_ISLNK(info.st_mode):
                    # Links confer no rights on their target. Landlock resolves
                    # the actual object on every open, including future links.
                    continue
                key = identity(info)
                if key in protected:
                    raise RuntimeError('writable member aliases an engine carrier or ancestor: ' + current)
                if stat.S_ISDIR(info.st_mode):
                    if key not in visited:
                        visited.add(key)
                        with os.scandir(current) as members:
                            pending.extend(member.path for member in members)
                elif stat.S_ISREG(info.st_mode):
                    # Count actual entries once, even with overlapping grants.
                    aliases.setdefault(key, set()).add(os.path.realpath(current))
                    links[key] = info.st_nlink
                else:
                    raise RuntimeError('writable member is not a regular file/directory: ' + current)
        for key, names in aliases.items():
            if links[key] != len(names):
                raise RuntimeError('writable hard-link closure is unknown: ' + next(iter(names)))

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
