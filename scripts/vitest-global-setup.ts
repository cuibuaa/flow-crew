import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createTestEnvironment } from './test-environment.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default function verifyTestRuntime(): () => void {
  // Reuse vitest.config.ts's history-derived hang backstop for synchronous children;
  // a worker/test timer cannot interrupt a synchronous native call.
  const gitOptions = {
    cwd: projectRoot, encoding: 'utf8', timeout: 26 * 60_000, killSignal: 'SIGKILL',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  } as const;
  const ignored = execFileSync('nice', ['-n', '19', 'git', 'ls-files', '-ci', '--exclude-standard', '-z'], gitOptions);
  if (ignored) throw new Error(`Tracked files match Git ignore rules:\n${ignored.split('\0').filter(Boolean).join('\n')}`);

  // Match absolute paths, including file URLs and doubled backslashes in
  // source strings. Keep Unix casing so relative app/users routes stay valid.
  // Fixtures can use /workspace roots; no user-home exceptions are needed.
  const userPath = /\/(?:home|Users)\/[A-Za-z0-9_.-]+\/|\/mnt\/[a-zA-Z]\/|[a-zA-Z]:[\\/]+[Uu]sers[\\/]+[A-Za-z0-9_.-][^\\/\r\n"'<>]*[\\/]+/;
  const runId = /\b\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]{6}\b/i;
  const tracked = execFileSync('nice', ['-n', '19', 'git', 'ls-files', '-z'], gitOptions);
  const violations: string[] = [];
  for (const file of tracked.split('\0').filter(Boolean)) {
    // Deleted tracked files belong to the index, not the tree being tested.
    if (!existsSync(resolve(projectRoot, file))) continue;
    const bytes = readFileSync(resolve(projectRoot, file));
    if (bytes.includes(0)) continue; // Git's text scan also skips NUL-containing binary files.
    for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
      if (userPath.test(line) || runId.test(line)) violations.push(`${file}:${index + 1}`);
    }
  }
  if (violations.length) throw new Error(`Tracked text contains private paths or run identifiers:\n${violations.join('\n')}`);
  // Freshness belongs to the explicit build; tests never compile another generation.
  const stamp = join(projectRoot, 'dist-rewrite/.built');
  const inputs = new Set<string>([join(projectRoot, 'scripts/build.ts'), join(projectRoot, 'package.json')]);
  for (const config of ['tsconfig.rewrite.json', 'tsconfig.rewrite-build.json', 'rewrite-monitor/tsconfig.json']) {
    const configPath = join(projectRoot, config);
    inputs.add(configPath);
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
    if (!parsed) throw new Error(`Cannot read ${config}`);
    for (const file of parsed.fileNames) inputs.add(file);
  }
  inputs.add(join(projectRoot, 'tsconfig.json'));
  if (!existsSync(stamp) || [...inputs].some(file => statSync(file).mtimeMs > statSync(stamp).mtimeMs)) {
    throw new Error('Build is missing or stale; run npm run build before testing.');
  }
  const isolation = createTestEnvironment();
  process.env.TMPDIR = isolation.root;
  process.env.TMP = isolation.root;
  process.env.TEMP = isolation.root;
  return () => isolation.restore();
}
