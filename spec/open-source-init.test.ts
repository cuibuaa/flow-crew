import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureProjectDefaultsFile } from '../src/config.js';

let projectDir: string | undefined;

afterEach(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  projectDir = undefined;
});

describe('public project initialization', () => {
  it('does not copy this repository operator campaign into a stranger project', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-public-init-'));
    const defaultsPath = ensureProjectDefaultsFile(projectDir);
    const defaults = parseYaml(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown>;

    expect(defaults.adapter).toBe('auto');
    expect(defaults.paths).toMatchObject({ agents: 'config/agents', workflows: 'config/workflows' });
    expect(defaults).not.toHaveProperty('campaign');
  });
});
