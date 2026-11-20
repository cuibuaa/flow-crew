import {withCurrentBoot,statusReadContract} from '../contract/status.mjs';
import {nextLifecycle} from '../contract/lifecycle.mjs';
/** @typedef {import('../contract/runtime.js').RunStatusFile} RunStatusFile */
// Read-only native birth/boot identity shared by execution and every status reader.
import {readFile, access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
const execute = promisify(execFile);
/** @type {Map<string,string>} */
const tools = new Map();
/** The one reader of the current boot id; every boot comparison and recorded owner boot comes from here.
 * @returns {Promise<string>} */
export async function currentBoot() {
  if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (process.platform !== 'darwin') throw new Error('Unsupported host');
  // Boot-session UUID identifies the boot; kern.boottime moves with calendar-clock corrections.
  return (await execute(await nativeTool('sysctl'), [ '-n', 'kern.bootsessionuuid'], { env: { PATH: '/usr/bin:/bin' } })).stdout.trim();
}
/** @param {number} pid @returns {Promise<import('../contract/runtime.js').Owner & {state:string|number}>} */
async function processIdentity(pid) {
  if (process.platform === 'linux') {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state:f[0], pid, start: f[19], boot: await currentBoot(), group: Number(f[2]), authority: '' };
  }
  if (process.platform !== 'darwin') throw new Error('Unsupported host');
  // Native birth has microsecond precision; ps lstart alone cannot distinguish same-second PID reuse.
  const [birth, boot] = await Promise.all([
    execute(await nativeTool('python3'), [ '-I', '-S', '-B', '-c',
      ("\nimport ctypes, os, sys, json\nclass Info(ctypes.Structure):\n _fields_=[(name,ctypes.c_uint" +
      "32) for name in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid'" +
      ",'svgid','reserved']]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(name,ctypes." +
      "c_uint32) for name in ['nfiles','pgid','jobc','tdev','tpgid','nice']]+[('sec',ctypes.c_uin" +
      "t64),('usec',ctypes.c_uint64)]\npid=int(sys.argv[1]);info=Info();lib=ctypes.CDLL('/usr/lib/" +
      "libproc.dylib',use_errno=True)\nif lib.proc_pidinfo(pid,3,0,ctypes.byref(info),ctypes.sizeo" +
      "f(info))!=ctypes.sizeof(info):\n print(json.dumps({'error':ctypes.get_errno()}))\nelse:print" +
      "(json.dumps({'pid':info.pid,'group':info.pgid,'state':info.status,'start':str(info.sec)+':'+str(info.usec)}))\n"), String(pid)],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }),
    currentBoot(),
  ]);
  const info = JSON.parse(birth.stdout);
  if (info.error !== undefined) throw Object.assign(new Error('Native process identity unavailable'), {
    code: info.error === 3 ? 'ESRCH' : info.error === 1 ? 'EPERM' : 'EIO' });
  if (info.pid !== pid || !info.group || !info.start) throw new Error('Native process identity unavailable');
  return { state:info.state, pid, start: info.start, boot, group: info.group, authority: '' };
}
/** @param {number} [pid] @returns {Promise<import('../contract/runtime.js').Owner>} */
export async function identity(pid = process.pid) {
  const {state:_state,...owner} = await processIdentity(pid); return owner;
}
/** A zombie retains a birth/group identity but cannot run the controller.
 * @param {number} [pid] @returns {Promise<import('../contract/runtime.js').Owner>}
 */
export async function controllerIdentity(pid = process.pid) {
  const {state,...owner} = await processIdentity(pid);
  if (state === 'Z' || state === 5) throw Object.assign(new Error('Controller exited'),{code:'ESRCH'});
  return owner;
}
export const ownIdentity = identity;
const SYSTEM_TOOL_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
/** @param {string} name @returns {Promise<string>} */
export async function nativeTool(name) {
  const known = tools.get(name); if (known) return known;
  // The operator's PATH first, then the system directories every supported platform keeps its tools in: macOS keeps
  // sysctl in /usr/sbin (sysctl(8)), which a narrowed PATH omits, and process identity must not depend on that.
  for (const directory of [...(process.env.PATH ?? '').split(':'), ...SYSTEM_TOOL_DIRECTORIES]) if (directory.startsWith('/')) {
    const candidate = join(directory, name); try { await access(candidate, 1); tools.set(name, candidate); return candidate; } catch { }
  }
  throw new Error('Missing native prerequisite: ' + name);
}

/** Controller availability is distinct from the closure of its recorded group.
 * @param {import('../contract/runtime.js').Owner|null} owner @param {string} [boot]
 * @param {typeof controllerIdentity} [probe] @returns {Promise<'active'|'inactive'|'unknown'>}
 */
export async function observeController(owner, boot, probe = controllerIdentity) {
  if (!owner) return 'unknown';
  if (boot && owner.boot !== boot) return 'inactive';
  try {
    const current = await probe(owner.pid);
    return current.start === owner.start && current.boot === owner.boot && current.group === owner.group ? 'active' : 'inactive';
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    return code === 'ENOENT' || code === 'ESRCH' ? 'inactive' : 'unknown';
  }
}
/** Read only the recorded controller birth, never helper/group presence or snapshot age.
 * @param {RunStatusFile} status @param {string} [boot]
 * @param {typeof controllerIdentity} [probe] @returns {Promise<RunStatusFile>}
 */
export async function observeStatus(status, boot, probe = controllerIdentity) {
  const observed = await statusReadContract(status).observe(status, async snapshot => {
    if (snapshot.reclaimed || nextLifecycle(/** @type {import('../contract/runtime.js').RunStatus} */ (snapshot.journalStatus ?? snapshot.status),'resume') === null) return snapshot;
    if (!boot) try { boot = (await probe()).boot; } catch { /* Unavailable native identity remains unknown. */ }
    const owner = snapshot.host.activation?.owner ?? null;
    const state = await observeController(owner,boot,probe);
    return {...snapshot,host:{...snapshot.host,activation:{owner,state,checkedAt:new Date().toISOString()}}};
  });
  return withCurrentBoot(observed,boot);
}
