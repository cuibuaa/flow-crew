import { afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEnvironment } from '../scripts/test-environment.js';

const isolation = createTestEnvironment();
const transport = { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(),
  TMP: process.env.TMP ?? tmpdir(), TEMP: process.env.TEMP ?? tmpdir() };
for (const key of Object.keys(process.env)) delete process.env[key];
process.env.PATH = transport.PATH;
process.env.TMPDIR = transport.TMPDIR;
process.env.TMP = transport.TMP;
process.env.TEMP = transport.TEMP;
process.env.HOME = isolation.home;
process.env.USERPROFILE = isolation.home;
process.env.FC_HOME = isolation.fcHome;
process.env.CODEX_HOME = join(isolation.home, '.codex');
process.env.FLOWCREW_VITEST_ROOT = isolation.root;
afterAll(() => isolation.restore());
