import { runWorkflow as executeWorkflow } from '../../src/scheduler.js';
import { runRecordPath } from '../../src/run-layout.js';
import { fcGlobalDir, readRunReservation, runDir } from '../../src/store.js';
import { parseBriefValidationCommands, reconcileProjectValidation } from '../../src/project-validation.js';
import type { ProjectValidationBaseline } from '../../src/project-validation.js';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  inspectShipSetupRecord,
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
  measuredBaseline?: ProjectValidationBaseline,
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
    execution: 'executed',
    projectDir: targetCanonicalDir,
    discovery: {
      state: 'partial' as const,
      configPath: 'fixture-ready-setup',
      commands: [command],
      missingRoles: ['test', 'lint'] as const,
    },
    results: [{
      ...command,
      state: 'passed' as const,
      exitCode: 0,
      durationMs: 1,
      output: '',
      failureIdentifiers: [],
      failureIdentity: 'none' as const,
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
    validationBaseline: measuredBaseline ?? validationBaseline,
  }, null, 2)}\n`, 'utf-8');
  return readyRecordPath;
}

/** Downstream workflow fixtures supply measured setup without changing their clocks. */
export async function runPreparedWorkflow(...args: Parameters<typeof executeWorkflow>) {
  const project = args[2];
  const reservation = args[7] ? readRunReservation(project, args[7]) : undefined;
  const brief = args[8] ?? reservation?.briefAdmission?.contract?.brief ?? '';
  if (!(args[7] && existsSync(runRecordPath(runDir(project, args[7]), 'run.json')))
    && inspectShipSetupRecord(project, brief).state === 'missing') {
    const declared = parseBriefValidationCommands(brief);
    const discovery = reconcileProjectValidation(project, declared.commands);
    writeReadySetupRecord(project, brief, fcGlobalDir(), { version: 1, execution: 'executed', projectDir: project,
      discovery, results: discovery.commands.map(command => ({ ...command, exitCode: 0, state: 'passed',
        durationMs: 0, output: '', failureIdentifiers: [], failureIdentity: 'none' })) });
  }
  return executeWorkflow(...args);
}
