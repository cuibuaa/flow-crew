/**
 * Regression tests for codex adapter config generation:
 * 1. Unpinned model/effort INHERIT the user's global ~/.codex/config.toml
 *    (the per-stage codex_home is isolated, so the CLI never reads the global
 *    config itself — without inheritance an unpinned run silently falls to the
 *    CLI built-in default, which drifts with codex releases).
 * 2. Explicit role pins override the global config.
 * 3. The effort key written is `model_reasoning_effort` — a bare
 *    `reasoning_effort` is silently ignored by the codex CLI (verified on
 *    codex-cli 0.144.3), which is why effort pins never took effect before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveCodexCapabilityIdentity, writeCodexConfig } from '../src/adapters/codex.js';
import { withEngineWriteBoundary } from '../src/write-boundary.js';
import type { AgentConfig } from '../src/adapters/base.js';

let globalHome: string;
let stageHome: string;
let savedEnv: string | undefined;
const initialCacheEnvironment = { CODEX_PLUGINS_CACHE: process.env.CODEX_PLUGINS_CACHE, CODEX_SKILLS_CACHE: process.env.CODEX_SKILLS_CACHE };

beforeEach(() => {
  globalHome = mkdtempSync(join(tmpdir(), `codex-global-${randomBytes(4).toString('hex')}-`));
  stageHome = mkdtempSync(join(tmpdir(), `codex-stage-${randomBytes(4).toString('hex')}-`));
  savedEnv = process.env.CODEX_HOME;
  process.env.CODEX_HOME = globalHome;   // userCodexHome() resolves here
  process.env.CODEX_PLUGINS_CACHE = join(globalHome, 'plugins');
  process.env.CODEX_SKILLS_CACHE = join(globalHome, 'skills');
});

describe('codex capability executable selection', () => {
  async function identity(): Promise<string> {
    return withEngineWriteBoundary({ projectDir: globalHome, runDir: stageHome, stageId: 'work',
      artifactContract: { version: 1, produces: [], reads: [], replays: [], groups: [] } },
    async () => resolveCodexCapabilityIdentity(role('fixture', 'low'), { cwd: globalHome }).version);
  }

  it.each(['', '.'])('resolves PATH member %j against the launch cwd', async (member) => {
    const executable = join(globalHome, 'codex');
    writeFileSync(executable, 'private executable identity', { mode: 0o700 });
    const saved = process.env.PATH;
    process.env.PATH = member;
    try { expect(await identity()).toContain(`fingerprint:${executable}:`); }
    finally { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; }
  });

  it('skips a non-executable candidate before a relative executable PATH member', async () => {
    const bin = join(globalHome, 'bin'); mkdirSync(bin);
    writeFileSync(join(globalHome, 'codex'), 'not executable', { mode: 0o600 });
    const executable = join(bin, 'codex');
    writeFileSync(executable, 'private executable identity', { mode: 0o700 });
    const saved = process.env.PATH;
    process.env.PATH = `${globalHome}:bin`;
    try { expect(await identity()).toContain(`fingerprint:${executable}:`); }
    finally { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; }
  });

  it('checks missing lexical PATH hops before canonicalizing the selected executable', async () => {
    const bin = join(globalHome, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), 'unreachable through missing/..', { mode: 0o700 });
    const executable = join(globalHome, 'codex');
    writeFileSync(executable, 'selected by the next PATH entry', { mode: 0o700 });
    const saved = process.env.PATH; process.env.PATH = 'missing/../bin:.';
    try { expect(await identity()).toContain(`fingerprint:${executable}:`); }
    finally { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; }
  });

  it('invalidates an in-place replacement even when size and mtime are restored', async () => {
    const executable = join(globalHome, 'codex');
    writeFileSync(executable, 'before', { mode: 0o700 });
    const timestamp = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(executable, timestamp, timestamp);
    const saved = process.env.PATH; process.env.PATH = '';
    try {
      const first = await identity(), info = statSync(executable);
      writeFileSync(executable, 'after!'); utimesSync(executable, info.atime, info.mtime);
      expect(statSync(executable).mtimeMs).toBe(info.mtimeMs);
      expect(statSync(executable).size).toBe(info.size);
      expect(await identity()).not.toBe(first);
    } finally { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; }
  });
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedEnv;
  for (const [key, value] of Object.entries(initialCacheEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(globalHome, { recursive: true, force: true });
  rmSync(stageHome, { recursive: true, force: true });
});

const role = (model?: string, effort?: string): AgentConfig =>
  ({ model, reasoning_effort: effort, prompt: 'p' } as AgentConfig);

describe('codex config inheritance from the global config', () => {
  it('privately copies caches and relocates internal absolute links without a shared writable alias', () => {
    const source = process.env.CODEX_PLUGINS_CACHE!;
    mkdirSync(source);
    writeFileSync(join(source, 'tool'), 'original tool');
    symlinkSync(join(source, 'tool'), join(source, 'tool-link'));
    writeCodexConfig(stageHome, role('first-model', 'high'));
    const other = join(globalHome, 'second-stage');
    writeCodexConfig(other, role('second-model', 'low'));
    writeFileSync(join(stageHome, '.tmp', 'plugins', 'tool-link'), 'stage edit');
    expect(readFileSync(join(source, 'tool'), 'utf8')).toBe('original tool');
    expect(readFileSync(join(other, '.tmp', 'plugins', 'tool-link'), 'utf8')).toBe('original tool');
    expect(readFileSync(join(stageHome, 'config.toml'), 'utf8')).toContain('first-model');
    expect(readFileSync(join(other, 'config.toml'), 'utf8')).toContain('second-model');
  });

  it.each(['plugins', 'skills'])('retries a refused %s copy without reusing incomplete tools', (cache) => {
    const source = process.env[cache === 'plugins' ? 'CODEX_PLUGINS_CACHE' : 'CODEX_SKILLS_CACHE']!;
    const parent = cache === 'plugins' ? join(stageHome, '.tmp') : stageHome;
    const destination = join(parent, cache);
    mkdirSync(source);
    mkdirSync(join(source, 'nested'));
    writeFileSync(join(source, 'nested', 'tool'), 'original tool');
    writeFileSync(join(globalHome, 'outside-tool'), 'outside');
    symlinkSync(join(globalHome, 'outside-tool'), join(source, 'tool-link'));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => writeCodexConfig(stageHome, role('fixture', 'low'))).toThrow('cache link leaves private copy');
      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(parent).some(name => name.startsWith('.flowcrew-'))).toBe(false);
    }
    rmSync(join(source, 'tool-link'));
    symlinkSync(join(source, 'nested', 'tool'), join(source, 'tool-link'));
    writeCodexConfig(stageHome, role('fixture', 'low'));
    expect(readFileSync(join(destination, 'tool-link'), 'utf8')).toBe('original tool');
    writeFileSync(join(destination, 'tool-link'), 'stage edit');
    writeCodexConfig(stageHome, role('retry-model', 'high'));
    expect(readFileSync(join(destination, 'nested', 'tool'), 'utf8')).toBe('stage edit');
    expect(readFileSync(join(source, 'nested', 'tool'), 'utf8')).toBe('original tool');
    expect(readFileSync(join(stageHome, 'config.toml'), 'utf8')).toContain('retry-model');
    expect(readFileSync(join(globalHome, 'outside-tool'), 'utf8')).toBe('outside');
  });

  it('unpinned (default) model and effort inherit ~/.codex/config.toml', () => {
    writeFileSync(join(globalHome, 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "max"\n');
    const cfg = readFileSync(writeCodexConfig(stageHome, role('default', 'default')), 'utf-8');
    expect(cfg).toContain('model = "gpt-5.6-sol"');
    expect(cfg).toContain('model_reasoning_effort = "max"');
  });

  it('explicit pins override the global config', () => {
    writeFileSync(join(globalHome, 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n');
    const cfg = readFileSync(writeCodexConfig(stageHome, role('gpt-5.5', 'max')), 'utf-8');
    expect(cfg).toContain('model = "gpt-5.5"');
    expect(cfg).toContain('model_reasoning_effort = "max"');
  });

  it('no global config → no model/effort lines (CLI built-in default applies)', () => {
    const cfg = readFileSync(writeCodexConfig(stageHome, role(undefined, undefined)), 'utf-8');
    expect(cfg).not.toContain('model =');
    expect(cfg).not.toContain('model_reasoning_effort');
  });

  it('never writes the ignored bare reasoning_effort key', () => {
    writeFileSync(join(globalHome, 'config.toml'), 'model_reasoning_effort = "max"\n');
    const cfg = readFileSync(writeCodexConfig(stageHome, role(undefined, 'high')), 'utf-8');
    expect(cfg).toContain('model_reasoning_effort = "high"');
    expect(cfg).not.toMatch(/^reasoning_effort/m);
  });

  it.each(['config.toml', 'auth.json', 'credentials.json', 'installation_id'])('refuses linked publication slot %s', (name) => {
    const outside = join(globalHome, 'carrier');
    writeFileSync(outside, 'engine');
    if (name !== 'config.toml') writeFileSync(join(globalHome, name), 'fixture-auth');
    for (const route of ['symlink', 'hardlink']) {
      const slot = join(stageHome, name);
      if (route === 'symlink') symlinkSync(outside, slot);
      else linkSync(outside, slot);
      expect(() => writeCodexConfig(stageHome, role('fixture', 'low'))).toThrow('ADAPTER_HOME_REFUSED');
      expect(readFileSync(outside, 'utf8')).toBe('engine');
      rmSync(slot);
    }
  });

  it.each(['root', 'parent', 'cache-parent'])('refuses a substituted %s directory before publication', (route) => {
    const outside = join(globalHome, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'config.toml'), 'engine');
    let target = stageHome;
    if (route === 'root') {
      rmSync(stageHome, { recursive: true }); symlinkSync(outside, stageHome, 'dir');
    } else if (route === 'parent') {
      symlinkSync(outside, join(stageHome, 'parent'), 'dir');
      target = join(stageHome, 'parent', 'home');
    } else symlinkSync(outside, join(stageHome, '.tmp'), 'dir');
    expect(() => writeCodexConfig(target, role('fixture', 'low'))).toThrow('ADAPTER_HOME_REFUSED');
    expect(readFileSync(join(outside, 'config.toml'), 'utf8')).toBe('engine');
  });

  it('publishes through existing search-only ancestors without requiring directory read access', () => {
    const parent = join(stageHome, 'parent'), home = join(parent, 'home');
    mkdirSync(home, { recursive: true }); chmodSync(parent, 0o111);
    try {
      expect(readFileSync(writeCodexConfig(home, role('fixture', 'low')), 'utf8')).toContain('model = "fixture"');
    } finally { chmodSync(parent, 0o700); }
  });
});
