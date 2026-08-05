import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';

export const IDENTITY_WITNESS_FIELDS = [
  'pid',
  'linuxStartTimeTicks',
  'args',
] as const;

export type IdentityWitnessField = (typeof IDENTITY_WITNESS_FIELDS)[number];

export interface ProcessIdentityWitness {
  pid: number;
  linuxStartTimeTicks: string;
  args: readonly string[];
}

export type IdentityUnknownReason =
  | 'unsupported_platform'
  | 'invalid_probe_pid'
  | 'incomplete_expected_witness'
  | 'unreadable_start_time'
  | 'unreadable_args'
  | 'identity_changed_during_probe';

export interface IdentityMatch {
  status: 'match';
  live: true;
}

export interface IdentityMismatch {
  status: 'mismatch';
  live: false;
  mismatchFields: readonly IdentityWitnessField[];
}

export interface IdentityUnknown {
  status: 'unknown';
  live: null;
  reason: IdentityUnknownReason;
}

export type IdentityProbeResult = IdentityMatch | IdentityMismatch | IdentityUnknown;

export type ProcessIdentityCapture =
  | { status: 'captured'; witness: ProcessIdentityWitness }
  | IdentityUnknown;

export interface IdentityProbeOptions {
  platform?: string;
  readLinuxStartTimeTicks?: (pid: number) => string | undefined;
  readArgs?: (pid: number) => readonly string[] | undefined;
}

export const IDENTITY_PROBE_EXIT = Object.freeze({
  match: 0,
  mismatch: 1,
  unknown: 2,
} as const);

function unknown(reason: IdentityUnknownReason): IdentityUnknown {
  return { status: 'unknown', live: null, reason };
}

function isPositivePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isStartTimeTicks(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function isCompleteArgs(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((argument) => typeof argument === 'string' && !argument.includes('\0'));
}

function isCompleteWitness(value: unknown): value is ProcessIdentityWitness {
  if (!value || typeof value !== 'object') return false;
  const witness = value as Partial<ProcessIdentityWitness>;
  return isPositivePid(witness.pid)
    && isStartTimeTicks(witness.linuxStartTimeTicks)
    && isCompleteArgs(witness.args);
}

function readLinuxStartTimeTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return undefined;
    const fieldsFromState = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTimeTicks = fieldsFromState[19];
    return isStartTimeTicks(startTimeTicks) ? startTimeTicks : undefined;
  } catch {
    return undefined;
  }
}

function readLinuxArgs(pid: number): readonly string[] | undefined {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`);
    if (cmdline.length === 0 || cmdline[cmdline.length - 1] !== 0) return undefined;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(cmdline.subarray(0, -1));
    const args = decoded.split('\0');
    return isCompleteArgs(args) ? args : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture the Linux PID/start/argv witness without consulting legacy liveness
 * fallbacks. Reading start time on both sides of argv closes the PID-reuse race.
 */
export function captureProcessIdentityWitness(
  pid: number,
  options: IdentityProbeOptions = {},
): ProcessIdentityCapture {
  if ((options.platform ?? process.platform) !== 'linux') {
    return unknown('unsupported_platform');
  }
  if (!isPositivePid(pid)) return unknown('invalid_probe_pid');

  const readStartTime = options.readLinuxStartTimeTicks ?? readLinuxStartTimeTicks;
  const readArgs = options.readArgs ?? readLinuxArgs;

  let startBefore: string | undefined;
  let args: readonly string[] | undefined;
  let startAfter: string | undefined;
  try {
    startBefore = readStartTime(pid);
  } catch {
    return unknown('unreadable_start_time');
  }
  if (!isStartTimeTicks(startBefore)) return unknown('unreadable_start_time');

  try {
    args = readArgs(pid);
  } catch {
    return unknown('unreadable_args');
  }
  if (!isCompleteArgs(args)) return unknown('unreadable_args');

  try {
    startAfter = readStartTime(pid);
  } catch {
    return unknown('unreadable_start_time');
  }
  if (!isStartTimeTicks(startAfter)) return unknown('unreadable_start_time');
  if (startBefore !== startAfter) return unknown('identity_changed_during_probe');

  return {
    status: 'captured',
    witness: { pid, linuxStartTimeTicks: startBefore, args: [...args] },
  };
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((argument, index) => argument === right[index]);
}

/** Observe identity only; this function neither signals nor authorizes a process. */
export function probeProcessIdentity(
  pid: number,
  expected: unknown,
  options: IdentityProbeOptions = {},
): IdentityProbeResult {
  if (!isCompleteWitness(expected)) return unknown('incomplete_expected_witness');

  const captured = captureProcessIdentityWitness(pid, options);
  if (captured.status === 'unknown') return captured;

  const actual = captured.witness;
  const mismatchFields: IdentityWitnessField[] = [];
  if (actual.pid !== expected.pid) mismatchFields.push('pid');
  if (actual.linuxStartTimeTicks !== expected.linuxStartTimeTicks) {
    mismatchFields.push('linuxStartTimeTicks');
  }
  if (!sameArgs(actual.args, expected.args)) mismatchFields.push('args');

  return mismatchFields.length === 0
    ? { status: 'match', live: true }
    : { status: 'mismatch', live: false, mismatchFields };
}

export function identityProbeExitCode(result: IdentityProbeResult): 0 | 1 | 2 {
  return IDENTITY_PROBE_EXIT[result.status];
}
