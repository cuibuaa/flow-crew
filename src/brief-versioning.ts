import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface BriefVersionInfo {
  version: string;
  path: string;
  createdAt: string;
  reason?: string;
  fromVersion?: string;
}

export interface BriefRevision {
  ts: string;
  from: string;
  to: string;
  reason: string;
  diff: string;
}

const VERSION_RE = /^v([1-9][0-9]*)$/;

function assertVersion(version: string): number {
  const match = VERSION_RE.exec(version);
  if (!match) throw new Error(`Invalid brief version: ${version}`);
  return Number(match[1]);
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort cleanup */ }
    throw err;
  }
}

function listVersions(briefDir: string): string[] {
  if (!existsSync(briefDir)) return [];
  return readdirSync(briefDir)
    .map((name) => /^v([1-9][0-9]*)\.md$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => `v${match[1]}`);
}

function headFile(briefDir: string): string {
  return join(resolve(briefDir), 'HEAD');
}

function revisionsFile(briefDir: string): string {
  return join(resolve(briefDir), 'revisions.jsonl');
}

export function versionPath(briefDir: string, version: string): string {
  assertVersion(version);
  return join(resolve(briefDir), `${version}.md`);
}

export function readHead(briefDir: string): BriefVersionInfo {
  const dir = resolve(briefDir);
  const headPath = headFile(dir);
  let version: string | undefined;
  if (existsSync(headPath)) {
    const candidate = readFileSync(headPath, 'utf-8').trim();
    if (VERSION_RE.test(candidate) && existsSync(versionPath(dir, candidate))) {
      version = candidate;
    }
  }
  if (!version) {
    const versions = listVersions(dir);
    version = versions.at(-1);
  }
  if (!version) throw new Error(`No brief versions found in ${dir}`);
  return { version, path: versionPath(dir, version), createdAt: new Date().toISOString() };
}

export function ensureBriefDir(briefDir: string, seedContent = ''): BriefVersionInfo {
  const dir = resolve(briefDir);
  mkdirSync(dir, { recursive: true });
  const versions = listVersions(dir);
  if (versions.length === 0) {
    const createdAt = new Date().toISOString();
    writeFileSync(versionPath(dir, 'v1'), seedContent, { encoding: 'utf-8', flag: 'wx' });
    atomicWrite(headFile(dir), 'v1\n');
    return { version: 'v1', path: versionPath(dir, 'v1'), createdAt, reason: 'seed' };
  }
  return readHead(dir);
}

function withLock<T>(briefDir: string, fn: () => T): T {
  const dir = resolve(briefDir);
  mkdirSync(dir, { recursive: true });
  const lockDir = join(dir, '.brief-version.lock');
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() - started > 10000) throw new Error(`Timed out waiting for brief version lock: ${dir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function lcsMatrix(a: string[], b: string[]): number[][] {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function unifiedDiff(fromName: string, fromContent: string, toName: string, toContent: string): string {
  const from = splitLines(fromContent);
  const to = splitLines(toContent);
  const dp = lcsMatrix(from, to);
  const out = [`--- ${fromName}`, `+++ ${toName}`, `@@ -1,${from.length} +1,${to.length} @@`];
  let i = 0;
  let j = 0;
  while (i < from.length || j < to.length) {
    if (i < from.length && j < to.length && from[i] === to[j]) {
      out.push(` ${from[i]}`);
      i++;
      j++;
    } else if (j < to.length && (i === from.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push(`+${to[j]}`);
      j++;
    } else if (i < from.length) {
      out.push(`-${from[i]}`);
      i++;
    }
  }
  return `${out.join('\n')}\n`;
}

function appendRevision(briefDir: string, entry: BriefRevision): void {
  writeFileSync(revisionsFile(briefDir), `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', flag: 'a' });
}

export function diffVersions(briefDir: string, fromVersion: string, toVersion: string): string {
  const dir = resolve(briefDir);
  const fromPath = versionPath(dir, fromVersion);
  const toPath = versionPath(dir, toVersion);
  if (!existsSync(fromPath)) throw new Error(`Brief version not found: ${fromVersion}`);
  if (!existsSync(toPath)) throw new Error(`Brief version not found: ${toVersion}`);
  return unifiedDiff(fromVersion, readFileSync(fromPath, 'utf-8'), toVersion, readFileSync(toPath, 'utf-8'));
}

export function bumpVersion(briefDir: string, newContent: string, reason: string): BriefVersionInfo {
  const dir = resolve(briefDir);
  return withLock(dir, () => {
    const current = readHead(dir);
    const currentNumber = assertVersion(current.version);
    const nextVersion = `v${currentNumber + 1}`;
    const nextPath = versionPath(dir, nextVersion);
    const createdAt = new Date().toISOString();
    writeFileSync(nextPath, newContent, { encoding: 'utf-8', flag: 'wx' });
    const diff = diffVersions(dir, current.version, nextVersion);
    atomicWrite(headFile(dir), `${nextVersion}\n`);
    appendRevision(dir, { ts: createdAt, from: current.version, to: nextVersion, reason, diff });
    return { version: nextVersion, path: nextPath, createdAt, reason, fromVersion: current.version };
  });
}

export function rollback(briefDir: string, toVersion: string, reason: string): BriefVersionInfo {
  const dir = resolve(briefDir);
  assertVersion(toVersion);
  return withLock(dir, () => {
    const current = readHead(dir);
    const toPath = versionPath(dir, toVersion);
    if (!existsSync(toPath)) throw new Error(`Brief version not found: ${toVersion}`);
    const ts = new Date().toISOString();
    const diff = diffVersions(dir, current.version, toVersion);
    atomicWrite(headFile(dir), `${toVersion}\n`);
    appendRevision(dir, { ts, from: current.version, to: toVersion, reason, diff });
    return { version: toVersion, path: toPath, createdAt: ts, reason, fromVersion: current.version };
  });
}
