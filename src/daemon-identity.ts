import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

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
  build: DaemonBuildFingerprint;
}

export interface SocketOwnerLookupOptions {
  procRoot?: string;
  netUnixPath?: string;
  platform?: NodeJS.Platform;
}

/**
 * Fingerprint every runtime JavaScript module, not a hand-maintained subset.
 * Paths are included so moving/replacing a module changes the loaded identity.
 * mtimes are deliberately diagnostic-only: identical rebuilds remain fresh.
 */
export function computeBuildFingerprint(distDir: string): DaemonBuildFingerprint {
  const root = resolve(distDir);
  const files = collectJavaScriptFiles(root).sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    throw new Error(`Cannot fingerprint daemon build: no JavaScript files found under ${root}`);
  }

  const hash = createHash('sha256');
  let newestMtimeMs = 0;
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join('/');
    const content = readFileSync(path);
    const stat = statSync(path);
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    hash.update(`${Buffer.byteLength(relativePath)}:`);
    hash.update(relativePath);
    hash.update(`:${content.byteLength}:`);
    hash.update(content);
  }

  return {
    algorithm: 'sha256',
    hash: hash.digest('hex'),
    files: files.length,
    newestMtimeMs,
  };
}

export function createDaemonIdentity(input: {
  socketPath: string;
  distDir: string;
  pid?: number;
  startedAt?: string;
}): DaemonIdentity {
  return {
    pid: input.pid ?? process.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
    socketPath: resolve(input.socketPath),
    build: computeBuildFingerprint(input.distDir),
  };
}

export function daemonMetadataPath(socketPath: string): string {
  return join(dirname(resolve(socketPath)), DAEMON_METADATA_FILENAME);
}

export function writeDaemonIdentity(socketPath: string, identity: DaemonIdentity): string {
  const metadataPath = daemonMetadataPath(socketPath);
  const tempPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(metadataPath), { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify(identity, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, metadataPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
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
  if (opts.procRoot !== undefined || opts.netUnixPath !== undefined) return undefined;
  let identity: DaemonIdentity | undefined;
  try {
    identity = readDaemonIdentity(socketPath);
  } catch {
    return undefined;
  }
  const pid = identity?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM: the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM' ? pid : undefined;
  }
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
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') {
    return recordedDaemonPidIfAlive(socketPath, opts);
  }
  const procRoot = opts.procRoot ?? '/proc';
  const netUnixPath = opts.netUnixPath ?? join(procRoot, 'net', 'unix');
  const normalizedSocketPath = resolve(socketPath);
  const inodes = new Set<string>();

  for (const line of readFileSync(netUnixPath, 'utf-8').split(/\r?\n/).slice(1)) {
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

function collectJavaScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

function isDaemonIdentity(value: unknown): value is DaemonIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<DaemonIdentity>;
  const build = identity.build as Partial<DaemonBuildFingerprint> | undefined;
  return Number.isInteger(identity.pid) && (identity.pid ?? 0) > 0
    && typeof identity.startedAt === 'string' && Number.isFinite(Date.parse(identity.startedAt))
    && typeof identity.socketPath === 'string'
    && build?.algorithm === 'sha256'
    && typeof build.hash === 'string' && /^[a-f0-9]{64}$/.test(build.hash)
    && Number.isInteger(build.files) && (build.files ?? -1) >= 0
    && typeof build.newestMtimeMs === 'number' && Number.isFinite(build.newestMtimeMs);
}
