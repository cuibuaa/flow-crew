import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const procStat = (() => {
  try { readFileSync('/proc/self/stat'); return true; } catch { return false; }
})();
// Probe kernel behavior in a disposable parent that reaps its own child. Changing
// child-subreaper must never change the test worker's reaping duties.
// The supplied Mac reproduction was killed at 10s; this is a hang backstop,
// not the SIGCHLD fix. SIGKILL also bounds an unresponsive probe.
const probe = spawnSync('nice', ['-n', '19', 'python3', '-I', '-S', '-B', '-c', `
import ctypes, json, os, signal
libc = ctypes.CDLL(None, use_errno=True)
try:
    subreaper = libc.prctl(36, 1, 0, 0, 0) == 0 # PR_SET_CHILD_SUBREAPER
except AttributeError:
    subreaper = False
# A default-ignored SIGCHLD is discarded on Darwin, even when blocked.
# Install its disposition before fork so sigwait always has an exit notification.
signal.signal(signal.SIGCHLD, lambda s, f: None)
signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})
pid = os.fork()
if pid == 0:
    os.setsid()
    os._exit(0)
zombie_group = 'absent'
try:
    signal.sigwait({signal.SIGCHLD})
    try:
        os.killpg(pid, 0)
        zombie_group = 'present'
    except ProcessLookupError:
        pass
    except PermissionError:
        zombie_group = 'EPERM'
finally:
    os.waitpid(pid, 0)
print(json.dumps(dict(childSubreaper=subreaper, zombieGroup=zombie_group)))
`], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
if (probe.error) throw new Error('Native fixture capability probe failed (10s backstop): ' + probe.error.message);
if (probe.status !== 0) throw new Error('Native fixture capability probe failed: ' + (probe.stderr || probe.signal));
export const kernelCapabilities = { procStat, ...JSON.parse(probe.stdout) as {
  childSubreaper: boolean; zombieGroup: 'present' | 'absent' | 'EPERM';
} };
process.stderr.write('Native fixture capabilities ' + JSON.stringify(kernelCapabilities) + '\n');
