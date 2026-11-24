import { describe, expect, it } from 'vitest';
import { commandContext, interpretAuthority } from '../dist-rewrite/exec/policy.js';
import type { Brief } from '../dist-rewrite/contract/brief.js';

const command = (env: Record<string, string>) => ({ id: 'check', argv: ['/bin/sh', '-c', 'true'], env, inputs: [], required: true });
const brief = (env: Record<string, string> = {}): Brief => ({ criteria: [{ id: 'c', text: 'x' }], inputs: [], outputs: [], commands: [command(env)],
  results: [], allowBlocked: false, body: '' });
const authority = (declared: Record<string, string>, environment?: Record<string, string>) => {
  const result = interpretAuthority(brief(declared), { project: '/p/project', protectedRoots: ['/p/records'], workRoot: '/p/work', environment }, []);
  if (!result.ok) throw new Error(result.detail);
  return result.value;
};

describe('a declared command runs with the operator PATH recorded with the run', () => {
  it('records PATH, the scratch directory and the declared env in the authority row, and reads them back from it', () => {
    const recorded = authority({ ONLY: 'declared' }, { PATH: '/operator/bin:/usr/bin', HOME: '/operator', SECRET: 'x' });
    expect(recorded.commands[0].env).toEqual({ PATH: '/operator/bin:/usr/bin', ONLY: 'declared' });
    // No other operator variable reaches a command: only PATH is carried.
    expect(commandContext(recorded, brief({ ONLY: 'declared' }).commands[0], 'exec_1')).toEqual({ id: 'exec_1',
      scratch: '/p/work/commands/check/exec_1', env: { PATH: '/operator/bin:/usr/bin', TMPDIR: '/p/work/commands/check/exec_1', ONLY: 'declared' } });
  });
  it('a resume in another environment still sees the recorded PATH: the row, not the invoking shell, is the source', () => {
    const recorded = authority({}, { PATH: '/recorded' });
    const later = authority({}, { PATH: '/a/different/shell' });
    expect(commandContext(recorded, brief().commands[0], 'e').env.PATH).toBe('/recorded');
    expect(commandContext(later, brief().commands[0], 'e').env.PATH).toBe('/a/different/shell');
  });
  it('a declared PATH or TMPDIR wins; an operator without PATH adds none', () => {
    expect(commandContext(authority({ PATH: '/declared' }, { PATH: '/operator' }), brief({ PATH: '/declared' }).commands[0], 'e').env.PATH).toBe('/declared');
    expect(commandContext(authority({ TMPDIR: '/declared/tmp' }, { PATH: '/operator' }), brief({ TMPDIR: '/declared/tmp' }).commands[0], 'e').env)
      .toEqual({ PATH: '/operator', TMPDIR: '/declared/tmp' });
    const bare = authority({}, {});
    expect(Object.keys(bare.commands[0].env)).toEqual([]);
    expect(Object.keys(commandContext(bare, brief().commands[0], 'e').env)).toEqual(['TMPDIR']);
  });
  it('the authority row alone decides which TMPDIR wins: the brief is not consulted again when a command runs', () => {
    const defaulted = authority({}, { PATH: '/operator' });
    expect(commandContext(defaulted, brief({ TMPDIR: '/declared/elsewhere' }).commands[0], 'e').env.TMPDIR).toBe('/p/work/commands/check/e');
    const declared = authority({ TMPDIR: '/declared/tmp' }, { PATH: '/operator' });
    expect(commandContext(declared, brief().commands[0], 'e').env.TMPDIR).toBe('/declared/tmp');
  });
});

it('stores an explicit TMPDIR equal to command scratch as declared, without comparing paths later', () => {
  const recorded = authority({ TMPDIR: '/p/work/commands/check' });
  expect(recorded.commands[0].env.TMPDIR).toBe('/p/work/commands/check');
  expect(commandContext(recorded, brief().commands[0], 'e').env.TMPDIR).toBe('/p/work/commands/check');
});
