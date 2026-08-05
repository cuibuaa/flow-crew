import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function waitForDashboard(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`flowcrew start did not become ready within 10s: ${output.slice(-2_000)}`));
    }, 10_000);
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Dashboard running at http:\/\/localhost:(\d+)\//.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`flowcrew start exited before readiness (code=${code}, signal=${signal}): ${output.slice(-2_000)}`));
    });
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function portCanBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

describe('flowcrew start signal lifecycle', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'exits zero and releases the port after the first %s',
    { timeout: 20_000 },
    async (signal) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'flowcrew-e10-signal-'));
      const isolatedHome = join(fixtureRoot, 'home');
      const isolatedFcHome = join(fixtureRoot, 'state');
      const projectDir = join(fixtureRoot, 'project');
      for (const directory of [isolatedHome, isolatedFcHome, projectDir]) {
        mkdirSync(directory, { recursive: true });
      }
      mkdirSync(join(projectDir, 'config'), { recursive: true });
      writeFileSync(join(projectDir, 'config', 'defaults.yaml'), 'adapter: mock\n', 'utf-8');
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', join(process.cwd(), 'src', 'cli.ts'), 'start'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: isolatedHome,
            FC_HOME: isolatedFcHome,
            PROJECT_DIR: projectDir,
            PORT: '0',
            FLOWCREW_STARTUP_RECOVERY_LIMIT: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      try {
        const port = await waitForDashboard(child);
        expect(child.kill(signal)).toBe(true);
        const exit = await waitForExit(child, 3_000);

        expect(exit).toEqual({ code: 0, signal: null });
        expect(await portCanBind(port)).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await waitForExit(child, 2_000);
        }
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
});
