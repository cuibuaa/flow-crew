import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureProjectDefaultsFile, loadProjectDefaults, loadProjectDefaultsLocally, loadSupervisorConfig } from '../src/config.js';

let projectDir: string | undefined;

afterEach(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  projectDir = undefined;
});

describe('public project initialization', () => {
  it('reports failed explicit initialization rather than returning the package template for writing', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-public-blocked-'));
    writeFileSync(join(projectDir, 'config'), 'User file');
    expect(() => ensureProjectDefaultsFile(projectDir)).toThrow();
    expect(readFileSync(join(projectDir, 'config'), 'utf8')).toBe('User file');
  });

  it('does not copy this repository operator campaign into a stranger project', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-public-init-'));
    const defaultsPath = ensureProjectDefaultsFile(projectDir);
    const defaults = parseYaml(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown>;

    expect(defaults.adapter).toBe('auto');
    expect(defaults.paths).toMatchObject({ agents: 'config/agents', workflows: 'config/workflows' });
    expect(defaults).not.toHaveProperty('campaign');
  });

  it('consumes existing project defaults without changing user content', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-public-own-'));
    mkdirSync(join(projectDir, 'config'));
    const path = join(projectDir, 'config', 'defaults.yaml');
    const content = '# User choices\nadapter: mock\ncampaign: authored\nsupervisor:\n  poll_interval_ms: 1234\n';
    writeFileSync(path, content);
    expect(loadProjectDefaults(projectDir)).toMatchObject({ adapter: 'mock', campaign: 'authored' });
    expect(loadSupervisorConfig(projectDir).pollIntervalMs).toBe(1234);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('reads a stranger project with the packaged defaults and writes nothing into it', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-public-read-'));
    const defaults = loadProjectDefaults(projectDir);

    expect(existsSync(join(projectDir, 'config'))).toBe(false);
    expect(loadProjectDefaultsLocally(projectDir)).toEqual(defaults);
    expect(loadSupervisorConfig(projectDir).pollIntervalMs).toBeGreaterThan(0);
    expect(readdirSync(projectDir)).toEqual([]);
    expect(defaults.adapter).toBe('auto');
    expect(defaults.campaign).toBeUndefined();
    expect(defaults.planner_policies).toEqual([]);
  });
});
