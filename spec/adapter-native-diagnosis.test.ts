import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execWithStdin } from '../src/adapters/base.js';
import {
  AdapterParameterRepair, applyFix, CLI_BUILTIN_DEFAULT, diagnoseAdapterFailure, readAdapterCapabilityMemory,
  rememberUnsupportedEffort, resolveAdapterCapabilityIdentity,
} from '../src/adapters/diagnose.js';

let root: string;
const role = { model: 'fixture-model', reasoning_effort: 'high' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-native-diagnosis-'));
  mkdirSync(join(root, 'bin'));
  vi.stubEnv('PATH', join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'claude'), `#!${process.execPath}\n` + String.raw`
process.stdin.resume();
process.stdin.on('end', () => {
  if (process.argv.includes('--rejected')) {
    console.log(JSON.stringify({ type: 'result', is_error: true,
      error: { type: 'invalid_request_error', param: process.argv.at(-1), message: 'fixture rejection' } }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, TMPDIR: process.env.TMPDIR }));
  }
});
`, { mode: 0o700 });
});

afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('shared native diagnosis and capability memory', () => {
  it.each(['model', 'effort', 'reasoning_effort'])('repairs only the native rejected %s parameter', async parameter => {
    const result = await execWithStdin('claude', ['--rejected', parameter], 'fixture', {
      cwd: root, timeout_ms: 5_000, captureStreams: true,
    });
    const error = JSON.parse(result.stdout!.trim()).error;
    const diagnosis = diagnoseAdapterFailure(error.message, result.exitCode, { parameter: error.param });
    expect(diagnosis.fix).toBe(parameter === 'model' ? 'drop_model' : 'drop_effort');
    const fixed = applyFix(role, diagnosis.fix);
    expect(fixed).toEqual(parameter === 'model'
      ? { model: CLI_BUILTIN_DEFAULT, reasoning_effort: 'high' }
      : { model: 'fixture-model', reasoning_effort: CLI_BUILTIN_DEFAULT });
    expect(role).toEqual({ model: 'fixture-model', reasoning_effort: 'high' });
    expect(diagnoseAdapterFailure(`Agent report: ${parameter} rejected`, 1).fix).toBe('none');
    expect(diagnoseAdapterFailure(error.message, 1, { parameter: 'tools' }).fix).toBe('none');
    for (const controlExit of [0, 124, 137]) {
      expect(diagnoseAdapterFailure(error.message, controlExit, { parameter: error.param }).fix).toBe('none');
    }
  });

  it('retains rejected effort only for the same native executable, provider, model and effort', () => {
    const identity = resolveAdapterCapabilityIdentity(role, { executable: 'claude', cwd: root });
    expect(identity.version).toMatch(/^fingerprint:/);
    expect(readAdapterCapabilityMemory(root, identity)).toBeUndefined();
    rememberUnsupportedEffort(root, identity);
    expect(readAdapterCapabilityMemory(root, identity)?.identity).toEqual(identity);
    for (const changed of [{ provider: 'another-provider' }, { model: 'another-model' }, { reasoningEffort: 'low' }]) {
      expect(readAdapterCapabilityMemory(root, { ...identity, ...changed })).toBeUndefined();
    }
    writeFileSync(join(root, 'bin', 'claude'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
    const changedCli = resolveAdapterCapabilityIdentity(role, { executable: 'claude', cwd: root });
    expect(changedCli.version).not.toBe(identity.version);
    expect(readAdapterCapabilityMemory(root, changedCli)).toBeUndefined();
  });

  it('bounds distinct repairs and suppresses a rejected effort in the next role invocation', () => {
    const identity = resolveAdapterCapabilityIdentity(role, { executable: 'claude', cwd: root });
    const repair = new AdapterParameterRepair(role, root, identity);
    expect(repair.apply(diagnoseAdapterFailure('', 1, { parameter: 'effort' }))).toBe(true);
    expect(repair.role).toEqual({ model: 'fixture-model', reasoning_effort: CLI_BUILTIN_DEFAULT });
    expect(repair.apply(diagnoseAdapterFailure('', 1, { parameter: 'effort' }))).toBe(false);
    expect(repair.apply(diagnoseAdapterFailure('', 1, { parameter: 'model' }))).toBe(true);
    expect(repair.apply({ fix: 'fresh_session', friendly: '', matched: 'fixture' })).toBe(false);
    const next = new AdapterParameterRepair(role, root, identity);
    expect(next.role.reasoning_effort).toBe(CLI_BUILTIN_DEFAULT);
    expect(next.apply(diagnoseAdapterFailure('', 1, { parameter: 'effort' }))).toBe(false);
  });

  it('keeps explicit provider pins and leaves the ambient default unresolved', () => {
    const explicit = resolveAdapterCapabilityIdentity(role, { executable: 'claude', cwd: root });
    expect(explicit).toMatchObject({ model: 'fixture-model', reasoningEffort: 'high' });
    const defaults = resolveAdapterCapabilityIdentity({ model: 'default', reasoning_effort: 'default' }, { executable: 'claude', cwd: root });
    expect(defaults).toMatchObject({ model: 'cli_builtin_default', reasoningEffort: 'cli_builtin_default' });
  });

  it('removes requested nesting markers while retaining synthetic auth and home values', async () => {
    const ambientHome = join(root, 'ambient-home');
    const configHome = join(root, 'ambient-config');
    const ambientScratch = join(root, 'ambient-scratch');
    mkdirSync(ambientScratch);
    vi.stubEnv('TMPDIR', ambientScratch);
    vi.stubEnv('HOME', ambientHome);
    vi.stubEnv('CLAUDE_CONFIG_DIR', configHome);
    vi.stubEnv('CLAUDECODE', 'fixture-nested');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'fixture-entrypoint');
    vi.stubEnv('ANTHROPIC_API_KEY', 'invalid-fixture-value');
    const result = await execWithStdin('claude', [], 'fixture', {
      cwd: root, timeout_ms: 5_000, captureStreams: true,
      unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
    });
    expect(result.exitCode).toBe(0);
    const child = JSON.parse(result.stdout!.trim());
    expect(child).toMatchObject({ HOME: ambientHome, CLAUDE_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: 'invalid-fixture-value' });
    expect(child).not.toHaveProperty('CLAUDECODE');
    expect(child).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(child.TMPDIR).not.toBe(ambientScratch);
  });
});
