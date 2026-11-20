import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

it('isolates file homes inside invocation-owned temporary storage before loading tests', () => {
  const root = process.env.FLOWCREW_VITEST_ROOT!;
  expect(process.env.HOME).toBe(join(root, 'home'));
  expect(process.env.FC_HOME).toBe(join(root, 'home', '.fc'));
  expect(process.env.TMPDIR).toBe(dirname(root));
  expect(existsSync(process.env.FC_HOME!)).toBe(true);
});
