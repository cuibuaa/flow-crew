import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const VITEST_CLI = resolve(PROJECT_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const RETRY_TARGET = 'spec/negotiation.test.ts';
const FRESHNESS_TARGET = 'spec/terminal-freshness.test.ts';

const EXPECTED_SEMANTIC = {
  expandable: { budgets: [50, 100], terminalDecision: 'soft_timeout' },
  capped: { budgets: [50], terminalDecision: 'hard_cap_exhausted' },
};

type ShapeName = 'default_parallel' | 'single_worker' | 'cpu_load';

type ShapeEvidence = {
  exit: number;
  retryExit: number;
  freshnessExit: number;
  stdoutLines: number;
  stderrLines: number;
  semantic: typeof EXPECTED_SEMANTIC | null;
  legacyCounterexampleKilled: boolean;
  hM4: 'green' | 'red';
};

function countLines(raw: string): number {
  if (raw.length === 0) return 0;
  const normalized = raw.replaceAll('\r\n', '\n');
  return normalized.split('\n').length - (normalized.endsWith('\n') ? 1 : 0);
}

function parseSemantic(raw: string): typeof EXPECTED_SEMANTIC | null {
  const matches = [...raw.matchAll(/M4_RETRY_SEMANTICS=(\{[^\r\n]+\})/g)];
  const encoded = matches.at(-1)?.[1];
  if (!encoded) return null;
  try {
    return JSON.parse(encoded) as typeof EXPECTED_SEMANTIC;
  } catch {
    return null;
  }
}

function echoRaw(shape: ShapeName, stream: 'stdout' | 'stderr', raw: string): void {
  process.stdout.write(`M4_MATRIX_RAW_BEGIN shape=${shape} stream=${stream}\n`);
  process.stdout.write(raw);
  if (raw.length > 0 && !raw.endsWith('\n')) process.stdout.write('\n');
  process.stdout.write(`M4_MATRIX_RAW_END shape=${shape} stream=${stream}\n`);
}

function exitCode(result: ReturnType<typeof spawnSync>): number {
  return result.status
    ?? (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT' ? 124 : 1);
}

function runShape(shape: ShapeName): ShapeEvidence {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'flowcrew-m4-home-'));
  const temporaryFcHome = mkdtempSync(join(tmpdir(), 'flowcrew-m4-fc-home-'));
  try {
    const shapeArgs = ['--reporter=verbose'];
    if (shape === 'single_worker') shapeArgs.push('--maxWorkers=1');
    if (shape === 'cpu_load') {
      const setupPath = join(temporaryFcHome, 'bounded-cpu-load.mjs');
      const configPath = join(temporaryFcHome, 'vitest.config.mjs');
      writeFileSync(setupPath, [
        "import { performance } from 'node:perf_hooks';",
        'const started = performance.now();',
        'let accumulator = 0;',
        'while (performance.now() - started < 225) {',
        '  accumulator = Math.imul(accumulator + 1, 31) >>> 0;',
        '}',
        'void accumulator;',
      ].join('\n'));
      const baseConfigUrl = pathToFileURL(join(PROJECT_ROOT, 'vitest.config.ts')).href;
      const setupUrl = pathToFileURL(setupPath).href;
      writeFileSync(configPath, [
        `import baseConfig from ${JSON.stringify(baseConfigUrl)};`,
        'const baseTest = baseConfig.test ?? {};',
        'const priorSetup = Array.isArray(baseTest.setupFiles) ? baseTest.setupFiles : [];',
        `export default { ...baseConfig, test: { ...baseTest, setupFiles: [...priorSetup, ${JSON.stringify(setupUrl)}] } };`,
      ].join('\n'));
      shapeArgs.push('--config', configPath);
    }
    const runTarget = (target: string) => spawnSync(
      process.execPath,
      [VITEST_CLI, 'run', target, ...shapeArgs],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: temporaryHome,
          FC_HOME: temporaryFcHome,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );

    // Each file still runs in full for every shape. Running them as separate
    // child invocations prevents their process-global test seams from racing;
    // the retry oracle's deliberate CPU load remains inside the retry run.
    const retryResult = runTarget(RETRY_TARGET);
    const freshnessResult = runTarget(FRESHNESS_TARGET);
    const retryStdout = retryResult.stdout ?? '';
    const freshnessStdout = freshnessResult.stdout ?? '';
    const stdout = retryStdout + freshnessStdout;
    const stderr = [
      retryResult.stderr ?? '',
      retryResult.error ? `${retryResult.error.name}: ${retryResult.error.message}\n` : '',
      freshnessResult.stderr ?? '',
      freshnessResult.error ? `${freshnessResult.error.name}: ${freshnessResult.error.message}\n` : '',
    ].join('');
    const retryExit = exitCode(retryResult);
    const freshnessExit = exitCode(freshnessResult);
    const exit = retryExit === 0 ? freshnessExit : retryExit;

    echoRaw(shape, 'stdout', stdout);
    echoRaw(shape, 'stderr', stderr);

    return {
      exit,
      retryExit,
      freshnessExit,
      stdoutLines: countLines(stdout),
      stderrLines: countLines(stderr),
      semantic: parseSemantic(stdout),
      legacyCounterexampleKilled: /legacyCounterexampleKilled=true/.test(stdout),
      hM4: freshnessExit === 0 && /spec\/terminal-freshness\.test\.ts/.test(freshnessStdout) ? 'green' : 'red',
    };
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
    rmSync(temporaryFcHome, { recursive: true, force: true });
  }
}

describe('scheduling-shape retry matrix', () => {
  it('produces the same semantic sequence and terminal decision in every shape', () => {
    const evidence: Record<ShapeName, ShapeEvidence> = {
      default_parallel: runShape('default_parallel'),
      single_worker: runShape('single_worker'),
      cpu_load: runShape('cpu_load'),
    };

    process.stdout.write(`M4_MATRIX_EVIDENCE=${JSON.stringify(evidence)}\n`);
    for (const shape of Object.keys(evidence) as ShapeName[]) {
      expect(evidence[shape].exit, `${shape} exit`).toBe(0);
      expect(evidence[shape].semantic, `${shape} semantic`).toEqual(EXPECTED_SEMANTIC);
      expect(evidence[shape].legacyCounterexampleKilled, `${shape} legacy counterexample`).toBe(true);
      expect(evidence[shape].hM4, `${shape} H-M4`).toBe('green');
    }
    process.stdout.write('C-M4-oracle-stock=0 family=E9-50ms-retry\n');
  }, 600_000);
});
