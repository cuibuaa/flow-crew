import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDashboard } from '../src/cli-dashboard.js';
import { startDashboard } from '../src/dashboard.js';
import { createRun, fcGlobalDir, readRunState, setFcGlobalDir, writeRunState } from '../src/store.js';

let originalFcRoot: string;
let root: string;
let projectDir: string;
let distDir: string;
let app: FastifyInstance | undefined;

beforeAll(() => {
  originalFcRoot = fcGlobalDir();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowcrew-dashboard-truth-'));
  projectDir = join(root, 'project');
  distDir = join(root, 'dist');
  setFcGlobalDir(join(root, 'fc-home'));
  mkdirSync(join(projectDir, 'config', 'workflows'), { recursive: true });
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'dashboard.js'), 'export const build = "loaded";\n', 'utf-8');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  setFcGlobalDir(originalFcRoot);
});

function outputCapture() {
  let value = '';
  return {
    writer: { write(chunk: string) { value += chunk; } },
    read: () => value,
  };
}

function listeningPort(instance: FastifyInstance): number {
  const address = instance.server.address();
  if (!address || typeof address === 'string') throw new Error('dashboard did not bind a TCP port');
  return address.port;
}

describe('dashboard build freshness', () => {
  it('reports matching fingerprints as FRESH, then a newer dist fingerprint as STALE with a non-zero CLI code', async () => {
    app = await startDashboard(projectDir, 0, { distDir });
    const port = listeningPort(app);

    const freshResponse = await app.inject({ method: 'GET', url: '/api/dashboard/status' });
    expect(freshResponse.statusCode).toBe(200);
    expect(freshResponse.headers['cache-control']).toBe('no-store');
    expect(freshResponse.json()).toMatchObject({
      freshness: 'fresh',
      pid: process.pid,
      loadedBuild: { algorithm: 'sha256', files: 1 },
      diskBuild: { algorithm: 'sha256', files: 1 },
    });
    expect(freshResponse.json().loadedBuild.hash).toBe(freshResponse.json().diskBuild.hash);

    const freshOutput = outputCapture();
    expect(await cmdDashboard(['dashboard', 'status', '--port', String(port)], { stdout: freshOutput.writer })).toBe(0);
    expect(freshOutput.read()).toContain('FRESH:');

    const changedPath = join(distDir, 'dashboard.js');
    writeFileSync(changedPath, 'export const build = "newer-on-disk";\n', 'utf-8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(changedPath, future, future);

    const staleResponse = await app.inject({ method: 'GET', url: '/api/dashboard/status' });
    expect(staleResponse.json()).toMatchObject({ freshness: 'stale', diskIsNewer: true });
    expect(staleResponse.json().loadedBuild.hash).not.toBe(staleResponse.json().diskBuild.hash);

    const staleOutput = outputCapture();
    expect(await cmdDashboard(['dashboard', 'status', '--port', String(port)], { stdout: staleOutput.writer })).toBe(2);
    expect(staleOutput.read()).toContain('STALE:');
  });
});

describe('reality-gate run-detail API', () => {
  it('exposes the named hard failure and advisory diagnostics already persisted in run.json', async () => {
    const created = createRun(projectDir, 'default', 'name: default\nstages:\n  - id: verify\n    role: qa\n', ['verify']);
    const state = readRunState(projectDir, created.runId);
    state.status = 'reality_gate_failed';
    state.failureReason = 'Reality gate blocked terminal status complete; failed checks: required-build-proof';
    state.realityGate = {
      pass: false,
      checkedAt: '2026-08-01T20:00:00.000Z',
      checksRun: 2,
      results: [
        {
          name: 'required-build-proof',
          type: 'exec-script-exit-zero',
          pass: false,
          advisory: false,
          details: 'script exited 3',
          stderr: { tail: 'artifact checksum mismatch', sourceChars: 26, capturedChars: 26, truncated: false },
        },
        {
          name: 'optional-tool',
          type: 'exec-script-exit-zero',
          pass: false,
          advisory: true,
          details: 'script exited 6',
        },
      ],
    };
    writeRunState(projectDir, created.runId, state);
    app = await startDashboard(projectDir, 0, { distDir });

    const response = await app.inject({ method: 'GET', url: `/api/runs/${created.runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'reality_gate_failed',
      failureReason: expect.stringContaining('required-build-proof'),
      realityGate: {
        checksRun: 2,
        results: [
          { name: 'required-build-proof', pass: false, advisory: false, stderr: { tail: 'artifact checksum mismatch' } },
          { name: 'optional-tool', pass: false, advisory: true },
        ],
      },
    });
  });
});
