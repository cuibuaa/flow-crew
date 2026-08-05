import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  parseSingleProbeValue,
  type ProbeResultEnvelope,
} from '../src/probe-result.js';

const finiteNumber = z.number().finite();

function successfulEnvelope(stdout: string): ProbeResultEnvelope {
  return {
    raw: { stdout, stderr: 'diagnostic retained\n' },
    exit: { code: 0, signal: null, timedOut: false },
  };
}

describe('single typed probe contract', () => {
  it.each([0, 7])('accepts the sole finite number %s without truthiness coercion', (value) => {
    const envelope = successfulEnvelope(`${value}\n`);
    const result = parseSingleProbeValue(envelope, finiteNumber);

    expect(result.ok).toBe(true);
    expect(result.envelope).toBe(envelope);
    expect(result.envelope.raw).toEqual({ stdout: `${value}\n`, stderr: 'diagnostic retained\n' });
    expect(result.envelope.exit).toEqual({ code: 0, signal: null, timedOut: false });
    if (!result.ok) throw new Error('the single finite number was rejected');
    expect(result.value).toBe(value);
  });

  it('fails closed on extra values, fallback text, and a JSON value of the wrong type', () => {
    expect(parseSingleProbeValue(successfulEnvelope(''), finiteNumber)).toMatchObject({
      ok: false,
      kind: 'shape',
    });
    expect(parseSingleProbeValue(successfulEnvelope('0\n0\n'), finiteNumber)).toMatchObject({
      ok: false,
      kind: 'shape',
    });
    expect(parseSingleProbeValue(successfulEnvelope('0\nfallback\n'), finiteNumber)).toMatchObject({
      ok: false,
      kind: 'shape',
    });
    expect(parseSingleProbeValue(successfulEnvelope('"0"\n'), finiteNumber)).toMatchObject({
      ok: false,
      kind: 'type',
    });
  });

  it('classifies process failure before inspecting otherwise valid or malformed stdout', () => {
    const validZero = successfulEnvelope('0\n');
    validZero.exit.code = 9;
    expect(parseSingleProbeValue(validZero, finiteNumber)).toMatchObject({
      ok: false,
      kind: 'process',
      envelope: validZero,
    });

    const malformed = successfulEnvelope('fallback\n');
    malformed.exit.timedOut = true;
    expect(parseSingleProbeValue(malformed, finiteNumber)).toMatchObject({
      ok: false,
      kind: 'process',
      envelope: malformed,
    });

    process.stdout.write('H-M4=green mechanism=single-typed-probe\n');
    process.stdout.write('C-M4-oracle-stock=0 family=P2.5-single-typed-probe\n');
  });
});
