import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDistFresh } from '../src/build-manifest.js';
import { createInvocationScratch } from '../src/invocation-scratch.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default function verifyTestRuntimeGeneration(): () => void {
  const gitOptions = {
    cwd: projectRoot, encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  } as const;
  const ignored = execFileSync('git', ['ls-files', '-ci', '--exclude-standard', '-z'], gitOptions);
  if (ignored) throw new Error(`Tracked files match Git ignore rules:\n${ignored.split('\0').filter(Boolean).join('\n')}`);

  // Match absolute paths, including file URLs and doubled backslashes in
  // source strings. Keep Unix casing so relative app/users routes stay valid.
  // Fixtures can use /workspace roots; no user-home exceptions are needed.
  const userPath = /\/(?:home|Users)\/[A-Za-z0-9_.-]+\/|\/mnt\/[a-zA-Z]\/|[a-zA-Z]:[\\/]+[Uu]sers[\\/]+[A-Za-z0-9_.-][^\\/\r\n"'<>]*[\\/]+/;
  const runId = /\b\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]{6}\b/i;
  const tracked = execFileSync('git', ['ls-files', '-z'], gitOptions);
  const violations: string[] = [];
  for (const file of tracked.split('\0').filter(Boolean)) {
    const bytes = readFileSync(resolve(projectRoot, file));
    if (bytes.includes(0)) continue; // Git's text scan also skips NUL-containing binary files.
    for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
      if (userPath.test(line) || runId.test(line)) violations.push(`${file}:${index + 1}`);
    }
  }
  if (violations.length) throw new Error(`Tracked text contains private paths or run identifiers:\n${violations.join('\n')}`);
  assertDistFresh(projectRoot);

  // A suite is a command, not another author invocation. Inheriting an author's
  // aliased .tmp-* tree makes no-follow homes and engine-carrier fixtures invalid.
  // The existing owner supplies short physical storage until all workers close.
  const scratch = createInvocationScratch();
  const names = ['TMPDIR', 'TMP', 'TEMP'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = scratch.path;
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    scratch.cleanup();
  };
}
