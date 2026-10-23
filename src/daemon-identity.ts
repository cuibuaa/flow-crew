import { createHash } from 'node:crypto';
import { updateFileHashSync } from './rollback-content-store.js';
import { atomicWrite, mkdirSync } from './engine-fs.js';
import { existsSync, readFileSync, readdirSync, realpathSync, readlinkSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { readBuildManifest, collectBuildArtifacts, assertBuildArtifactInventory } from './build-manifest.js';
import { processLiveness } from './process-liveness.js';

export const DAEMON_METADATA_FILENAME = 'daemon.json';
export const STALE_DAEMON_MESSAGE = 'STALE: dist is newer than the running daemon — its fixes are NOT loaded';

export interface DaemonBuildFingerprint {
  algorithm: 'sha256';
  hash: string;
  files: number;
  newestMtimeMs: number;
}

export interface DaemonIdentity {
  pid: number;
  startedAt: string;
  socketPath: string;
  /** Exact deployed runtime root. Optional only for legacy metadata. */
  distDir?: string;
  /** Additive control provenance; absent on older daemons. */
  homeDir?: string;
  storeDir?: string;
  build: DaemonBuildFingerprint;
}

/** Resolve existing ancestors too, so an absent socket below an alias has the
 * same authority as its eventual target. No filesystem mutation is involved. */
export function resolveControlPath(path: string): string {
  const absolute = resolve(path);
  let ancestor = absolute;
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(ancestor), ...suffix); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** The login account's home from the passwd database, or undefined when the
 * running uid has no entry there (a container started with `--user`, for one).
 * With no login account there is no operator state root to recognise, so every
 * caller treats undefined as private rather than failing. */
export function loginHomeDirectory(): string | undefined {
  try { return userInfo().homedir; } catch { return undefined; }
}

export function isOperatorStateRoot(home: string, store: string, loginHome: string | undefined = loginHomeDirectory()): boolean {
  if (loginHome === undefined) return false;
  return resolveControlPath(home) === resolveControlPath(loginHome)
    && resolveControlPath(store) === resolveControlPath(join(loginHome, '.fc'));
}

/** Node otherwise silently truncates sockaddr_un paths on some hosts. Check
 * the supplied, absolute and alias-resolved spelling before any side effect.
 * BSD reserves more bytes than Linux; Windows named pipes have another ABI. */
export function assertUnixSocketPath(socketPath: string, platform: NodeJS.Platform = process.platform): void {
  if (!socketPath || socketPath.includes('\0')) throw new Error('Invalid daemon socket path: use a nonempty filesystem path without NUL bytes.');
  if (platform === 'win32') return;
  const limit = platform === 'linux' ? 108 : 104;
  const paths = [socketPath, resolve(socketPath), resolveControlPath(socketPath)];
  if (paths.some((path) => Buffer.byteLength(path) >= limit)) {
    throw new Error(`Daemon socket path is too long (${limit - 1} bytes maximum); use a shorter state root or socket path.`);
  }
}

/** Keep deliberate custom/private fuses. A different path alone says nothing
 * about its owner. Refuse the login store from a private engine, and optional
 * daemon provenance that positively identifies a different home, without
 * connecting to the socket to learn who it is. Legacy custom sockets remain
 * unverified until their daemon publishes provenance. */
export function assertCommandSocketAuthority(socketPath: string, home: string, store: string): void {
  assertUnixSocketPath(socketPath);
  const selected = resolveControlPath(socketPath);
  const loginHome = loginHomeDirectory();
  if (loginHome !== undefined && !isOperatorStateRoot(home, store, loginHome)
      && resolveControlPath(dirname(socketPath)) === resolveControlPath(join(loginHome, '.fc'))) {
    throw new Error('Refusing the operator daemon socket from a private engine. Select a private daemon socket.');
  }
  let identity: DaemonIdentity | undefined;
  try { identity = readDaemonIdentity(socketPath); } catch { return; /* status diagnoses legacy/unreadable metadata */ }
  if (identity && resolveControlPath(identity.socketPath) === selected
      && identity.homeDir !== undefined
      && resolveControlPath(identity.homeDir) !== resolveControlPath(home)) {
    throw new Error('Refusing a daemon socket attested to another home. Select a daemon in this engine home.');
  }
  if (identity && resolveControlPath(identity.socketPath) === selected
      && identity.storeDir !== undefined
      && resolveControlPath(identity.storeDir) !== resolveControlPath(dirname(socketPath))) {
    throw new Error('Refusing a daemon socket with inconsistent store provenance. Select its recorded state root.');
  }
}

export interface SocketOwnerLookupOptions {
  procRoot?: string;
  platform?: NodeJS.Platform;
}

/**
 * Fingerprint the entire published payload, including retained resources.
 * Paths are included so moving/replacing a module changes the loaded identity.
 * mtimes are deliberately diagnostic-only: identical rebuilds remain fresh.
 */
export function computeBuildFingerprint(distDir: string): DaemonBuildFingerprint {
  const root = realpathSync(distDir);
  const uiRoot = join(root, '..', 'ui', 'dist');
  const manifest = readBuildManifest(root);
  const inventory = manifest ? assertBuildArtifactInventory(root, manifest)
    : { backend: collectBuildArtifacts(root, true), ui: collectBuildArtifacts(uiRoot) };
  const files = inventory.backend.filter((record) => record.path.endsWith('.js'));
  if (files.length === 0) {
    throw new Error(`Cannot fingerprint daemon build: no JavaScript files found under ${root}`);
  }

  const hash = createHash('sha256');
  let newestMtimeMs = 0;
  for (const record of inventory.backend) {
    const path = join(root, record.path);
    const relativePath = relative(root, path).split(sep).join('/');
    const stat = statSync(path);
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    hash.update(`${Buffer.byteLength(relativePath)}:`);
    hash.update(relativePath);
    hash.update(`:${stat.size}:`);
    if (updateFileHashSync(path, hash).byteLength !== stat.size) {
      throw new Error(`${path} changed while its build identity was hashed`);
    }
  }

  // File count remains the runtime JS/UI diagnostic; the hash covers the full
  // payload. Bare legacy backend-only packages still have no UI contribution.
  const uiFiles = inventory.ui.map((record) => join(uiRoot, record.path));
  if ((existsSync(join(root, '..', 'ui', 'package.json')) || uiFiles.length > 0) && !manifest?.ui) {
    throw new Error('Cannot fingerprint served UI without a combined build manifest');
  }
  if (manifest?.ui) {
    hash.update(`ui-generation:${manifest.generation}:`);
  }
  if (manifest?.uiPresence) hash.update(`ui-presence:${manifest.uiPresence}:`);
  for (const path of uiFiles.sort((a, b) => a.localeCompare(b))) {
    const name = `ui/dist/${relative(uiRoot, path).split(sep).join('/')}`;
    const stat = statSync(path);
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    hash.update(`${Buffer.byteLength(name)}:${name}:${stat.size}:`);
    if (updateFileHashSync(path, hash).byteLength !== stat.size) {
      throw new Error(`${path} changed while its build identity was hashed`);
    }
  }

  return {
    algorithm: 'sha256',
    hash: hash.digest('hex'),
    files: files.length + uiFiles.length,
    newestMtimeMs,
  };
}

export function createDaemonIdentity(input: {
  socketPath: string;
  distDir: string;
  pid?: number;
  startedAt?: string;
}): DaemonIdentity {
  assertUnixSocketPath(input.socketPath);
  return {
    pid: input.pid ?? process.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
    socketPath: resolve(input.socketPath),
    distDir: resolve(input.distDir),
    homeDir: resolveControlPath(homedir()),
    storeDir: resolveControlPath(dirname(input.socketPath)),
    build: computeBuildFingerprint(input.distDir),
  };
}

export function daemonMetadataPath(socketPath: string): string {
  assertUnixSocketPath(socketPath);
  return join(dirname(resolve(socketPath)), DAEMON_METADATA_FILENAME);
}

export function writeDaemonIdentity(socketPath: string, identity: DaemonIdentity): string {
  const metadataPath = daemonMetadataPath(socketPath);
  mkdirSync(dirname(metadataPath), { recursive: true });
  // Discovery metadata is valid only for the matching live process and socket.
  atomicWrite(metadataPath, `${JSON.stringify(identity, null, 2)}\n`, { durability: 'replace-only' });
  return metadataPath;
}

export function readDaemonIdentity(socketPath: string): DaemonIdentity | undefined {
  const metadataPath = daemonMetadataPath(socketPath);
  if (!existsSync(metadataPath)) return undefined;
  const parsed = JSON.parse(readFileSync(metadataPath, 'utf-8')) as unknown;
  if (!isDaemonIdentity(parsed)) {
    throw new Error(`Invalid daemon identity metadata: ${metadataPath}`);
  }
  return parsed;
}

/**
 * The off-Linux substitute for the inode scan: the pid the daemon recorded for
 * itself, reported only if that process still exists. Returns undefined when
 * there is no metadata, the metadata is unreadable, or the pid has exited — so a
 * caller can still tell "no listener" from "a listener I cannot attest to".
 */
function recordedDaemonPidIfAlive(socketPath: string, opts: SocketOwnerLookupOptions = {}): number | undefined {
  if (opts.procRoot !== undefined) return undefined;
  let identity: DaemonIdentity | undefined;
  try {
    identity = readDaemonIdentity(socketPath);
  } catch {
    return undefined;
  }
  const pid = identity?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return processLiveness(pid) === 'alive' ? pid : undefined;
}

/**
 * Locate the process that owns the listening Unix socket.
 *
 * On Linux this is answered by the kernel: the socket's inode is matched against
 * every process's open descriptors, so a stale metadata file cannot fake it.
 *
 * Without procfs there is no equivalent from Node, so we fall back to the pid the
 * daemon recorded for itself and confirm only that it is still alive. That is
 * strictly weaker — it trusts a file the daemon wrote rather than asking the
 * kernel — but it is honest about *which* pid it is reporting, and it refuses to
 * report one that has exited. Throwing here instead, as this used to, made
 * `daemon start`, `status` and `restart` all unusable off Linux.
 */
export function findUnixSocketOwnerPid(socketPath: string, opts: SocketOwnerLookupOptions = {}): number | undefined {
  assertUnixSocketPath(socketPath, opts.platform ?? process.platform);
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') {
    return recordedDaemonPidIfAlive(socketPath, opts);
  }
  const procRoot = opts.procRoot ?? '/proc';
  const normalizedSocketPath = resolve(socketPath);
  const inodes = new Set<string>();

  for (const line of readFileSync(join(procRoot, 'net', 'unix'), 'utf-8').split(/\r?\n/).slice(1)) {
    const match = /^\S+:\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)(?:\s+(.*))?$/.exec(line.trim());
    if (match?.[2] === normalizedSocketPath) inodes.add(match[1]);
  }
  if (inodes.size === 0) return undefined;

  const owners = new Set<number>();
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    const fdDir = join(procRoot, entry.name, 'fd');
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(join(fdDir, fd));
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && inodes.has(match[1])) {
          owners.add(pid);
          break;
        }
      } catch {
        // A process can exit or close an fd while /proc is being scanned.
      }
    }
  }

  if (owners.size > 1) {
    throw new Error(`Unix socket ${normalizedSocketPath} has multiple owning pids: ${[...owners].sort((a, b) => a - b).join(', ')}`);
  }
  return owners.values().next().value as number | undefined;
}

function isDaemonIdentity(value: unknown): value is DaemonIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<DaemonIdentity>;
  const build = identity.build as Partial<DaemonBuildFingerprint> | undefined;
  return Number.isInteger(identity.pid) && (identity.pid ?? 0) > 0
    && typeof identity.startedAt === 'string' && Number.isFinite(Date.parse(identity.startedAt))
    && typeof identity.socketPath === 'string'
    && (identity.distDir === undefined
      || (typeof identity.distDir === 'string' && identity.distDir.length > 0))
    && (identity.homeDir === undefined || (typeof identity.homeDir === 'string' && isAbsolute(identity.homeDir)))
    && (identity.storeDir === undefined || (typeof identity.storeDir === 'string' && isAbsolute(identity.storeDir)))
    && build?.algorithm === 'sha256'
    && typeof build.hash === 'string' && /^[a-f0-9]{64}$/.test(build.hash)
    && Number.isInteger(build.files) && (build.files ?? -1) >= 0
    && typeof build.newestMtimeMs === 'number' && Number.isFinite(build.newestMtimeMs);
}
