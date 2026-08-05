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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeCodexConfig } from '../src/adapters/codex.js';
import type { AgentConfig } from '../src/adapters/base.js';

let globalHome: string;
let stageHome: string;
let savedEnv: string | undefined;

beforeEach(() => {
  globalHome = mkdtempSync(join(tmpdir(), `codex-global-${randomBytes(4).toString('hex')}-`));
  stageHome = mkdtempSync(join(tmpdir(), `codex-stage-${randomBytes(4).toString('hex')}-`));
  savedEnv = process.env.CODEX_HOME;
  process.env.CODEX_HOME = globalHome;   // userCodexHome() resolves here
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedEnv;
  rmSync(globalHome, { recursive: true, force: true });
  rmSync(stageHome, { recursive: true, force: true });
});

const role = (model?: string, effort?: string): AgentConfig =>
  ({ model, reasoning_effort: effort, prompt: 'p' } as AgentConfig);

describe('codex config inheritance from the global config', () => {
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
});
