import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEngineDefaults } from '../src/config.js';

let projectDir: string | undefined;

afterEach(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  projectDir = undefined;
});

describe('public engine defaults', () => {
  it('retains deterministic idle monitoring and automatic adapter resolution', () => {
    const defaults = loadEngineDefaults();
    expect(defaults.stage_idle_timeout_ms).toBe(600000);
    expect(defaults.adapter).toBe('auto');
    expect(defaults).not.toHaveProperty('supervisor');
    expect(defaults).not.toHaveProperty('campaign');
    expect(defaults).not.toHaveProperty('planner_policies');
  });

  it('loads defaults without writing into the working project', () => {
    projectDir = mkdtempSync(join(tmpdir(), 'flowcrew-public-read-'));
    loadEngineDefaults();
    expect(existsSync(join(projectDir, 'config'))).toBe(false);
    expect(readdirSync(projectDir)).toEqual([]);
  });
});
