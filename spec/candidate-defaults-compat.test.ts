import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectDefaults, loadProjectDefaultsLocally } from '../src/config.js';

describe('candidate engine defaults', () => {
  it('accepts a candidate that retired a setting the running engine never reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowcrew-candidate-defaults-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'src', 'config.ts'), 'export {};\n');
      const defaults = { ...loadProjectDefaultsLocally(root) } as Record<string, unknown>;
      delete defaults.supervisor_max_rejects;
      const envelope = JSON.stringify({ version: 1, ok: true, defaults });
      writeFileSync(join(root, 'scripts', 'validate-project-defaults.ts'), `process.stdout.write(${JSON.stringify(envelope)});\n`);
      expect(loadProjectDefaults(root)).toMatchObject({ adapter: defaults.adapter, timeout_ms: defaults.timeout_ms });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
