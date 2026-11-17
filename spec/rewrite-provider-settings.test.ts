import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerSettings, interpretAuthority, preparePolicy } from '../rewrite-src/exec/policy.js';
let home: string;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });
it.each(['codex', 'claude'] as const)('reads only %s model/effort at each invocation and refuses malformed settings', async backend => {
  home = await mkdtemp(join(tmpdir(), 'rewrite-settings-'));
  const role = { id: 'role', backend, model: 'default', effort: 'default', prompt: 'fixture', description: '' };
  await mkdir(join(home, '.' + backend));
  const file = join(home, '.' + backend, backend === 'codex' ? 'config.toml' : 'settings.json');
  const config = (model: string, effort: string) => backend === 'codex'
    ? `"model" = '${model}'\nmodel_reasoning_effort = "${effort}"\n[hooks]\ncommand = "must not run"\n[profiles.other]\nmodel = "wrong section"\n`
    : JSON.stringify({ model, effort, hooks: { command: 'must not run' }, permissions: { allow: ['everything'] } });
  await writeFile(file, config('fixture-model', 'high'));
  expect(await providerSettings(role, { HOME: home })).toEqual({ ok: true, value: { model: 'fixture-model', effort: 'high', source: { model: 'settings', effort: 'settings' } } });
  await writeFile(file, config('changed-model', 'low'));
  expect(await providerSettings({ ...role, effort: 'explicit' }, { HOME: home })).toEqual({ ok: true, value: { model: 'changed-model', effort: 'explicit', source: { model: 'settings', effort: 'role' } } });
  await writeFile(file, 'malformed config');
  expect(await providerSettings(role, { HOME: home })).toMatchObject({ ok: false, kind: 'invalid' });
  expect(await providerSettings({ ...role, model: 'explicit', effort: 'explicit' }, {})).toEqual({ ok: true, value: { model: 'explicit', effort: 'explicit', source: { model: 'role', effort: 'role' } } });
});

it('uses the same explicit Codex home for settings and model write roots', async () => {
  home = await mkdtemp(join(tmpdir(), 'rewrite-settings-'));
  const custom = join(home, 'custom'); await mkdir(custom); await writeFile(join(custom, 'config.toml'), 'model="custom"\nmodel_reasoning_effort="high"\n');
  const role = { id: 'role', backend: 'codex' as const, model: 'default', effort: 'default', prompt: 'fixture', description: '' };
  const environment = { HOME: home, CODEX_HOME: custom };
  const settings = await providerSettings(role, environment); expect(settings).toMatchObject({ ok: true, value: { model: 'custom', effort: 'high' } });
  const policy = interpretAuthority({ inputs: [], outputs: [], commands: [] } as any,
    { sharedCaches: [], devices: [], providerHomes: { codex: ['.codex'], claude: ['.claude'] } },
    { project: join(home, 'project'), protectedRoots: [], workRoot: join(home, 'work'), home, environment }, []);
  expect(policy).toMatchObject({ ok: true, value: { providers: { codex: [custom], claude: [join(home, '.claude')] } } });
});

it('freezes selected settings and their provenance in the prepared authority', async () => {
  home = await mkdtemp(join(tmpdir(), 'rewrite-settings-')); await mkdir(join(home, '.codex'));
  const file = join(home, '.codex', 'config.toml'); await writeFile(file, 'model="first"\nmodel_reasoning_effort="high"\n');
  const role = { id: 'role', backend: 'claude' as const, model: 'default', effort: 'default', prompt: 'fixture', description: '' };
  const brief = { inputs: [], outputs: [], commands: [] } as any;
  const config = { roles: [role], sharedCaches: [], devices: [], providerHomes: { codex: ['.codex'], claude: ['.claude'] } };
  const result = await preparePolicy(brief, config, { project: join(home, 'project'), workRoot: join(home, 'work'), protectedRoots: [], home, backend: 'codex', environment: { HOME: home } }, []);
  expect(result).toMatchObject({ ok: true, value: { preferences: [{ role: 'role', backend: 'codex', settings: { model: 'first', effort: 'high', source: { model: 'settings', effort: 'settings' } } }] } });
  await writeFile(file, 'model="later"\n');
  if (result.ok) {
    expect(result.value.preferences[0].settings.model).toBe('first');
    expect(result.value.interpretation).toContain('Role role: backend=codex, model=first (settings), effort=high (settings)');
  }
});
