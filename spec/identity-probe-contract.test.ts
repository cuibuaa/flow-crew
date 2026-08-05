import { describe, expect, it } from 'vitest';
import {
  captureProcessIdentityWitness,
  identityProbeExitCode,
  probeProcessIdentity,
  type IdentityProbeOptions,
  type ProcessIdentityWitness,
} from '../src/identity-probe.js';

const TARGET: ProcessIdentityWitness = {
  pid: 4101,
  linuxStartTimeTicks: '900001',
  args: ['node', 'isolated-target.mjs', '--fixture'],
};

function stableReader(
  args: readonly string[] = TARGET.args,
  startTimeTicks = TARGET.linuxStartTimeTicks,
): IdentityProbeOptions {
  return {
    platform: 'linux',
    readLinuxStartTimeTicks: () => startTimeTicks,
    readArgs: () => args,
  };
}

describe('tri-state identity oracle', () => {
  it('reports live match only for an exact complete PID/start/argv witness', () => {
    const result = probeProcessIdentity(TARGET.pid, TARGET, stableReader());

    expect(result).toEqual({ status: 'match', live: true });
    expect(identityProbeExitCode(result)).toBe(0);
  });

  it.each([
    {
      name: 'pid',
      probePid: TARGET.pid + 1,
      expected: TARGET,
      reader: stableReader(),
      fields: ['pid'],
    },
    {
      name: 'start time',
      probePid: TARGET.pid,
      expected: { ...TARGET, linuxStartTimeTicks: '900000' },
      reader: stableReader(),
      fields: ['linuxStartTimeTicks'],
    },
    {
      name: 'ordered argv',
      probePid: TARGET.pid,
      expected: { ...TARGET, args: ['node', '--fixture', 'isolated-target.mjs'] },
      reader: stableReader(),
      fields: ['args'],
    },
    {
      name: 'same PID with stale start and argv',
      probePid: TARGET.pid,
      expected: { ...TARGET, linuxStartTimeTicks: '899999', args: ['node', 'stale-target.mjs'] },
      reader: stableReader(),
      fields: ['linuxStartTimeTicks', 'args'],
    },
  ])('reports explicit mismatch for $name inequality', ({ probePid, expected, reader, fields }) => {
    const result = probeProcessIdentity(probePid, expected, reader);

    expect(result).toEqual({ status: 'mismatch', live: false, mismatchFields: fields });
    expect(identityProbeExitCode(result)).toBe(1);
  });

  it.each([
    {
      name: 'unsupported platform',
      pid: TARGET.pid,
      expected: TARGET,
      reader: { ...stableReader(), platform: 'darwin' },
      reason: 'unsupported_platform',
    },
    {
      name: 'invalid probe PID',
      pid: 0,
      expected: TARGET,
      reader: stableReader(),
      reason: 'invalid_probe_pid',
    },
    {
      name: 'incomplete expected argv',
      pid: TARGET.pid,
      expected: { ...TARGET, args: [] },
      reader: stableReader(),
      reason: 'incomplete_expected_witness',
    },
    {
      name: 'unreadable start time',
      pid: TARGET.pid,
      expected: TARGET,
      reader: { ...stableReader(), readLinuxStartTimeTicks: () => undefined },
      reason: 'unreadable_start_time',
    },
    {
      name: 'unreadable argv',
      pid: TARGET.pid,
      expected: TARGET,
      reader: { ...stableReader(), readArgs: () => undefined },
      reason: 'unreadable_args',
    },
  ])('keeps $name evidence fail-closed as unknown', ({ pid, expected, reader, reason }) => {
    const result = probeProcessIdentity(pid, expected, reader);

    expect(result).toEqual({ status: 'unknown', live: null, reason });
    expect(identityProbeExitCode(result)).toBe(2);
  });

  it('returns unknown when start time changes around the argv read', () => {
    const startReads = ['900001', '900002'];
    const result = probeProcessIdentity(TARGET.pid, TARGET, {
      platform: 'linux',
      readLinuxStartTimeTicks: () => startReads.shift(),
      readArgs: () => TARGET.args,
    });

    expect(result).toEqual({
      status: 'unknown',
      live: null,
      reason: 'identity_changed_during_probe',
    });
    expect(identityProbeExitCode(result)).toBe(2);
  });

  it('preserves empty argv elements as part of the complete ordered witness', () => {
    const expected = { ...TARGET, args: ['node', '', '--fixture'] };
    const capture = captureProcessIdentityWitness(TARGET.pid, stableReader(expected.args));

    expect(capture).toEqual({ status: 'captured', witness: expected });
    expect(probeProcessIdentity(TARGET.pid, expected, stableReader(expected.args)))
      .toEqual({ status: 'match', live: true });
  });
});
