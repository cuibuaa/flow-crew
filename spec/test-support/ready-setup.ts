import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  shipSetupBriefDigest,
  shipSetupReadyRecordPath,
} from '../../src/ship-setup-record.js';

/** Seed the smallest internally valid setup fact for CLI tests whose subject is
 * downstream of launch admission. The command is real and portable if a test
 * proceeds far enough to replay the captured validation baseline. */
export function writeReadySetupRecord(
  projectDir: string,
  exactBrief: string,
  globalRoot: string,
): string {
  const targetCanonicalDir = realpathSync.native(resolve(projectDir));
  const briefDigest = shipSetupBriefDigest(exactBrief);
  const readyRecordPath = shipSetupReadyRecordPath(targetCanonicalDir, briefDigest, globalRoot);
  const command = {
    role: 'build' as const,
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    display: 'node -e process.exit(0)',
  };
  const validationBaseline = {
    version: 1 as const,
    projectDir: targetCanonicalDir,
    discovery: {
      state: 'partial' as const,
      configPath: 'fixture-ready-setup',
      commands: [command],
      missingRoles: ['test', 'lint'] as const,
    },
    results: [{
      role: 'build' as const,
      state: 'passed' as const,
      exitCode: 0,
      durationMs: 1,
      output: '',
      failureIdentifiers: [],
      failureIdentity: 'none' as const,
    }],
    gateCriteria: [{
      role: 'build' as const,
      rule: 'must_remain_green' as const,
      baselineFailureIdentifiers: [],
      description: 'Fixture build must remain green',
    }],
  };
  mkdirSync(dirname(readyRecordPath), { recursive: true });
  writeFileSync(readyRecordPath, `${JSON.stringify({
    version: 1,
    state: 'ready',
    ready: true,
    createdAt: new Date().toISOString(),
    briefDigest,
    targetCanonicalDir,
    readyRecordPath,
    validationBaseline,
  }, null, 2)}\n`, 'utf-8');
  return readyRecordPath;
}
