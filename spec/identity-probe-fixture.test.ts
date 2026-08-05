import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_WITNESS_FIELDS,
  captureProcessIdentityWitness,
  identityProbeExitCode,
  probeProcessIdentity,
  type IdentityProbeResult,
} from '../src/identity-probe.js';

interface MatrixCell {
  status: IdentityProbeResult['status'];
  live: boolean | null;
  exit: 0 | 1 | 2;
}

interface SelfProbeCell extends MatrixCell {
  mismatchFields?: readonly string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const identityProbeUrl = pathToFileURL(join(projectRoot, 'src', 'identity-probe.ts')).href;

function matrixCell(result: IdentityProbeResult): MatrixCell {
  return {
    status: result.status,
    live: result.live,
    exit: identityProbeExitCode(result),
  };
}

function runSelfProbe(
  probeScript: string,
  expectedJson: string,
  temporaryHome: string,
  temporaryFcHome: string,
): SelfProbeCell {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', probeScript, expectedJson],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: temporaryHome,
        FC_HOME: temporaryFcHome,
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    },
  );
  if (child.error) throw child.error;
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe('');
  expect(child.status).toBe(1);

  const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as SelfProbeCell;
}

describe.runIf(process.platform === 'linux')('P2.6/M4 isolated process identity fixture', () => {
  it('observes stable self-match, PID-reuse, unknown, and valid-identity cells', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'flowcrew-p2-m4-identity-'));
    const probeHome = join(temporaryRoot, 'probe-home');
    const probeFcHome = join(probeHome, '.fc');
    const targetHome = join(temporaryRoot, 'target-home');
    const targetFcHome = join(targetHome, '.fc');
    for (const path of [probeHome, probeFcHome, targetHome, targetFcHome]) {
      mkdirSync(path, { recursive: true });
    }

    const probeScript = join(temporaryRoot, 'self-probe.mjs');
    writeFileSync(probeScript, `
const { identityProbeExitCode, probeProcessIdentity } = await import(${JSON.stringify(identityProbeUrl)});
const expected = JSON.parse(process.argv[2]);
const result = probeProcessIdentity(process.pid, expected);
const cell = {
  status: result.status,
  live: result.live,
  exit: identityProbeExitCode(result),
  ...(result.status === 'mismatch' ? { mismatchFields: result.mismatchFields } : {}),
};
process.stdout.write(JSON.stringify(cell) + '\\n');
process.exitCode = cell.exit;
`, 'utf8');

    const target = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: targetHome,
        FC_HOME: targetFcHome,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    await once(target, 'spawn');

    try {
      if (target.pid === undefined) throw new Error('isolated target has no pid');
      const captured = captureProcessIdentityWitness(target.pid);
      if (captured.status !== 'captured') {
        const stopped = probeProcessIdentity(target.pid, {
          pid: target.pid,
          linuxStartTimeTicks: '0',
          args: ['unavailable-strong-witness'],
        });
        expect(stopped).toMatchObject({ status: 'unknown', live: null });
        return;
      }
      const targetWitness = captured.witness;

      // The target's complete witness is deliberately embedded in the probe's
      // own argv. Exact PID/start/argv comparison must still reject the probe.
      const selfMatch = runSelfProbe(
        probeScript,
        JSON.stringify(targetWitness),
        probeHome,
        probeFcHome,
      );
      expect(selfMatch).toMatchObject({ status: 'mismatch', live: false, exit: 1 });
      expect(selfMatch.mismatchFields).toContain('pid');
      expect(selfMatch.mismatchFields).toContain('args');

      const staleWitness = {
        ...targetWitness,
        linuxStartTimeTicks: (BigInt(targetWitness.linuxStartTimeTicks) + 1n).toString(),
        args: [...targetWitness.args, 'stale-pid-reuse-witness'],
      };
      const pidReuseResult = probeProcessIdentity(target.pid, staleWitness);
      expect(pidReuseResult).toEqual({
        status: 'mismatch',
        live: false,
        mismatchFields: ['linuxStartTimeTicks', 'args'],
      });

      const unknownResult = probeProcessIdentity(target.pid, { ...targetWitness, args: [] });
      expect(unknownResult).toEqual({
        status: 'unknown',
        live: null,
        reason: 'incomplete_expected_witness',
      });

      const validIdentityResult = probeProcessIdentity(target.pid, targetWitness);
      expect(validIdentityResult).toEqual({ status: 'match', live: true });

      const matrix = {
        witnessFields: IDENTITY_WITNESS_FIELDS,
        selfMatch,
        pidReuse: matrixCell(pidReuseResult),
        unknown: matrixCell(unknownResult),
        validIdentity: matrixCell(validIdentityResult),
        pidReuseMismatchFields: pidReuseResult.status === 'mismatch'
          ? pidReuseResult.mismatchFields
          : [],
        cM4: { before: 0, after: 0 },
      };
      process.stdout.write(`M4_IDENTITY_MATRIX=${JSON.stringify(matrix)}\n`);
    } finally {
      const targetExited = once(target, 'exit');
      target.stdin.end();
      await targetExited;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
