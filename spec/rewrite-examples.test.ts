import { expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBrief } from '../dist-rewrite/contract/brief.js';
import { parseRuntime } from '../dist-rewrite/contract/runtime.js';
import { admitPreparation } from '../dist-rewrite/ops/preparation.js';

const examples = new URL('../examples/', import.meta.url).pathname;
const names = (await readdir(examples)).filter(name => name.endsWith('.brief.md')).map(name => name.slice(0, -'.brief.md'.length)).sort();

it('ships at least one example brief', () => { expect(names.length).toBeGreaterThan(0); });

// Each examples/<name>.brief.md is set up against the project directory examples/<name>/.
// This runs the same decode and preparation admission as `flowcrew setup`, without a model,
// a provider or any declared command.
it.each(names)('example %s decodes and passes setup admission', async name => {
  const advisories: string[] = [];
  const parsed = parseBrief(await readFile(join(examples, name + '.brief.md')), line => advisories.push(line));
  expect(parsed).toMatchObject({ ok: true });
  expect(advisories).toEqual([]);
  if (!parsed.ok) return;
  const config = parseRuntime(JSON.parse(await readFile(new URL('../config/runtime.json', import.meta.url), 'utf8')));
  expect(config).toMatchObject({ ok: true });
  if (!config.ok) return;
  const scratch = await mkdtemp(join(tmpdir(), 'examples-spec-'));
  try {
    const admitted = await admitPreparation(parsed.value, config.value, {
      source: join(examples, name), project: join(scratch, 'work', 'project'), workRoot: join(scratch, 'work'),
      protectedRoots: [join(scratch, 'records')], backend: 'claude', environment: { HOME: join(scratch, 'home') },
    });
    expect(admitted).toMatchObject({ ok: true });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
