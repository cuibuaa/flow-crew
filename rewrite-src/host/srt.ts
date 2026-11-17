import { SandboxManager, getDefaultWritePaths } from '@anthropic-ai/sandbox-runtime';
import { realpathSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { GrantRequest, OwnedProgram } from '../contract/runtime.js';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
let context: string | undefined;
let original: {
  cwd: string;
  scratch: string | undefined;
} | undefined;
/** One controller owns the package lifecycle; invocation overrides only translate admitted filesystem grants. */
export async function wrap(request: GrantRequest, program: OwnedProgram, scratch: string, resolveTool: (name: string) => Promise<string>) {
  const helpers = { env: await resolveTool('env'), sh: await resolveTool('sh') };
  if (!scratch || !isAbsolute(scratch) || realpathSync(scratch) !== scratch || !statSync(scratch).isDirectory()
    || !request.writableRoots.some(root => { const r = relative(root, scratch); return r === '' || !r.startsWith('..') && !isAbsolute(r); }))
    throw new Error('Existing private scratch inside an admitted writable root is required');
  const key = JSON.stringify([program.cwd, scratch]);
  if (context && context !== key)
    throw new Error('Sandbox controller context conflict');
  original ??= { cwd: process.cwd(), scratch: process.env.CLAUDE_CODE_TMPDIR };
  process.chdir(program.cwd);
  process.env.CLAUDE_CODE_TMPDIR = scratch;
  if (!context) {
    await SandboxManager.initialize({
      ...(process.platform === 'linux' ? { bwrapPath: await resolveTool('bwrap'), socatPath: await resolveTool('socat') } : {}),
      network: { allowedDomains: [], deniedDomains: [], allowAllUnixSockets: false },
      filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
      enableWeakerNestedSandbox: false, allowNestedUserNamespaces: false,
      ripgrep: { command: await resolveTool('rg'), args: [] },
    }, async () => true);
    context = key;
  }
  process.chdir(program.cwd);
  const wrapped = await SandboxManager.wrapWithSandboxArgv([helpers.env, '-u', 'PATH', ...Object.entries(program.env).map(([key, value]) => key + '=' + value),
    ...program.argv].map(quote).join(' '), helpers.sh, {
    filesystem: { allowWrite: [...request.writableRoots], denyWrite: [...request.protectedRoots], denyRead: [], allowRead: [] },
  }, undefined, program.cwd);
  // The package returns sh -c ENV=... bwrap. exec removes the orphanable intermediary (native crash probe).
  if (process.platform === 'linux')
    wrapped.argv[2] = 'exec ' + quote(helpers.env) + ' ' + wrapped.argv[2];
  // SRT's macOS launcher resolves its own env through PATH. Bootstrap with the
  // host tool path; the absolute inner env applies every declared value last.
  return { argv: wrapped.argv, env: { ...program.env, PATH: process.env.PATH ?? '/usr/bin:/bin' }, defaults: getDefaultWritePaths() };
}
export const cleanup = () => SandboxManager.cleanupAfterCommand();
export async function reset() {
  try {
    await SandboxManager.reset();
  }
  finally {
    context = undefined;
    if (original) {
      process.chdir(original.cwd);
      if (original.scratch === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = original.scratch;
      original = undefined;
    }
  }
}
export function diagnosis(reason: string): string {
  return `Cannot start confined work: ${reason}. No provider or declared command was started. No unconfined fallback. Status and inspection remain available. ` +
    (process.platform === 'linux'
      ? `Host prerequisite checklist: bubblewrap, socat and ripgrep. Ubuntu 23.10+ may need administrator setup (tested 24.04/26.04).
Inspect existing local policy first. If /etc/apparmor.d/bwrap-userns-restrict exists, unload it with
nice -n 19 sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict and create its /etc/apparmor.d/disable/ symlink.
The /etc/apparmor.d/bwrap profile is:
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, include if exists <local/bwrap> }
Load with nice -n 19 sudo apparmor_parser -r /etc/apparmor.d/bwrap, inspect nice -n 19 sudo aa-status, then repeat the real launch.
This restores unprivileged namespaces for bwrap and affects other users. Reboot persistence is untested.
FlowCrew never applies these administrator changes.`
      : 'Host prerequisite checklist: working native sandbox launcher and Node >=22.22.2. ' +
        'Closure covers the recorded process group; a child creating a new session can escape.');
}
export function disclosure(request: GrantRequest, scratch: string): string {
  const defaults = getDefaultWritePaths();
  return JSON.stringify({ writableUnion: [...new Set([...request.writableRoots, scratch, ...defaults])], implicitDefaults: defaults,
    existingDefaults: defaults.filter(existsSync), denials: request.protectedRoots,
    scope: process.platform === 'linux' ? 'contained_descendants' : 'group', virtualSurfaces: process.platform === 'linux' ? ['private /dev',
      'fresh /proc', 'proxy IPC sockets', 'controller temporary stores'] : ['character-device writes', 'proxy IPC sockets',
      'controller temporary stores'],
    limitations: process.platform === 'darwin'
      ? 'Closure covers the recorded process group; setsid/double-fork may escape.'
      : 'Stage descendants close in the PID namespace; internal trusted operations close their recorded group.',
    environment: 'Declared environment applies last, including proxy and CA variables. ' +
      'Replacing these can break networking; the outer sandbox still applies.' });
}
