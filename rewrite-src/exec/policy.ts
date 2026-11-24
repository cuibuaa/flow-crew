import { readFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { join } from 'node:path';
import { type Brief, type Result } from '../contract/brief.js';
import type { RuntimeConfig, Role, RunAuthority, OutputFact, CommandKey, ProviderPreferences } from '../contract/runtime.js';

// Validated literal POSIX components need only concatenation; filesystem observations belong to records.
const sep = '/';
const isAbsolute = (path: string) => path.startsWith('/');
const resolve = (root: string, ...paths: string[]) => paths.reduce((parent, path) => isAbsolute(path) ? path : parent.replace(/\/$/,
  '') + '/' + path, root);
/** Presence required by an output's declared existing mode, shared by operand checks and copy admission. */
export const outputAdmission = (existing: Brief['outputs'][number]['existing']) =>
  existing === 'create' ? 'absent' : existing === 'replace' ? 'either' : 'present';

/** One owner of admission, write, baseline and delivery semantics; cost is declarations, never tree size. */
export function interpretAuthority(brief: Brief,
  runtime: {
    project: string; protectedRoots: readonly string[]; workRoot: string; backend?: Role['backend'];
    environment?: Readonly<Record<string, string>>; parents?: RunAuthority['parents']
  }, facts: readonly OutputFact[]): Result<RunAuthority> {
  if (facts.length !== brief.outputs.length) return { ok: false, kind: 'invalid', detail: 'Output observation count mismatch' };
  const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
  const unique = (paths: readonly string[]) => [...new Set(paths)];
  const outputs: RunAuthority['outputs'][number][] = [];
  for (const [index, output] of brief.outputs.entries()) {
    const absolute = resolve(runtime.project, output.path), original = facts[index];
    const admission = outputAdmission(output.existing);
    if ((admission === 'absent' && original !== 'absent') || (admission === 'present' && original === 'absent')
      || (original !== 'absent' && original !== output.kind))
      return { ok: false, kind: 'invalid',
        detail: `Output ${output.path}: ${output.existing} ${output.kind} requires ${admission}; observed ${original}` };
    const write = within(runtime.project, absolute) ? 'project' : 'exact';
    if (runtime.protectedRoots.some(root => within(root, absolute) || within(absolute, root)))
      return { ok: false, kind: 'invalid', detail: `Output ${output.path}: overlaps a protected root` };
    outputs.push({
      path: output.path, absolute, kind: output.kind, admission, original, write, baseline: 'original-manifest',
      delivery: { original: admission, append: output.existing === 'append', nonempty: false }
    });
  }
  for (const parent of runtime.parents ?? []) {
    if (parent.original === 'other')
      return { ok: false, kind: 'invalid',
        detail: `Output parent ${parent.path}: non-directory parent` };
  }
  if (runtime.environment && ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'].some(key => key in runtime.environment!))
    return { ok: false, kind: 'invalid', detail: 'Private Git environment conflicts with the supplied model environment' };
  const external = outputs.filter(output => output.write === 'exact').map(output => output.absolute);
  const resources: RunAuthority['resources'] = [
    ...unique([runtime.project, ...external]).map(path => ({ path, access: 'exclusive-write' as const })),
    ...unique([...runtime.protectedRoots, ...brief.inputs.filter(input => input.frozen).map(input => resolve(runtime.project,
      input.path))]).map(path => ({ path, access: 'stable-read' as const })),
  ];
  const commands = brief.commands.map(command => {
    const scratch = resolve(runtime.workRoot, 'commands', command.id);
    // The operator's PATH is recorded with the run, like the rest of this row; a declared PATH or TMPDIR wins.
    return { id: command.id, scratch, env: { ...(runtime.environment?.PATH === undefined ? {} : { PATH: runtime.environment.PATH }),
      ...command.env } };
  });
  const interpretation = [
    ("No operational action, run-duration or input-size budget. C2 parks at gate suffix 3 or" +
    " failure suffix 4. Provider-internal loops re" +
    "quire manual cancellation."),
    ...brief.commands.map(command => `Command ${command.id}: deferred; required=${command.required}; criteria remain applicable`),
  ];
  return {
    ok: true, value: {
      project: runtime.project, backend: runtime.backend, preferences: [], interpretation, parents: runtime.parents ?? [], resources, outputs, commands
    }
  };
}

/** Freeze model/effort and their provenance in the same resource interpretation before execution. */
export async function preparePolicy(brief: Brief, config: RuntimeConfig,
  runtime: Parameters<typeof interpretAuthority>[1] & { backend: Role['backend']; environment: Readonly<Record<string, string>> },
  facts: readonly OutputFact[]): Promise<Result<RunAuthority>> {
  const interpreted = interpretAuthority(brief, runtime, facts);
  if (!interpreted.ok) return interpreted;
  const preferences: RunAuthority['preferences'][number][] = [];
  const interpretation = [...interpreted.value.interpretation];
  for (const role of config.roles) {
    const selected = { ...role, backend: runtime.backend };
    const settings = await providerSettings(selected, runtime.environment);
    if (!settings.ok) return settings;
    preferences.push({ role: role.id, backend: runtime.backend, settings: settings.value });
    interpretation.push(`Role ${role.id}: backend=${runtime.backend}, ` +
      `model=${settings.value.model ?? 'provider default'} (${settings.value.source.model}), ` +
      `effort=${settings.value.effort ?? 'provider default'} (${settings.value.source.effort})`);
  }
  return { ok: true, value: { ...interpreted.value, preferences, interpretation } };
}

/** Read only the two selected provider preferences; never inherit hooks, tools or other settings. */
export async function providerSettings(role: Role, environment: Readonly<Record<string, string>>): Promise<Result<ProviderPreferences>> {
  let values: Record<string, unknown> = {};
  try {
    if (role.model === 'default' || role.effort === 'default') {
      if (!environment.HOME && !(role.backend === 'codex' && environment.CODEX_HOME)) return { ok: false, kind: 'invalid',
        detail: 'Provider settings require explicit HOME' };
      if (role.backend === 'claude') {
        const raw = JSON.parse(await readFile(join(environment.HOME!, '.claude', 'settings.json'), 'utf8'));
        values = { model: raw.model, effort: raw.effort };
      } else {
        const raw = parseToml(await readFile(join(environment.CODEX_HOME ?? join(environment.HOME!, '.codex'), 'config.toml'), 'utf8'));
        values = { model: raw.model, effort: raw.model_reasoning_effort };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, kind: 'invalid', detail: 'Invalid provider model/effort settings' };
  }
  const selected = (key: 'model' | 'effort') => role[key] !== 'default' ? role[key] : values[key];
  const model = selected('model'), effort = selected('effort');
  if ([model, effort].some(value => value !== undefined && value !== null && (typeof value !== 'string' || !value.length)))
    return { ok: false, kind: 'invalid', detail: 'Provider model/effort must be nonempty strings' };
  return {
    ok: true, value: {
      ...(typeof model === 'string' ? { model } : {}), ...(typeof effort === 'string' ? { effort } : {}),
      source: {
        model: role.model !== 'default' ? 'role' : typeof model === 'string' ? 'settings' : 'builtin',
        effort: role.effort !== 'default' ? 'role' : typeof effort === 'string' ? 'settings' : 'builtin'
      }
    }
  };
}

/** Resolve effective command scratch before identity. A committed reservation carries this exact context. */
export function commandContext(table: RunAuthority, command: Brief['commands'][number], id: string): NonNullable<CommandKey['execution']> {
  const row = table.commands.find(row => row.id === command.id)!;
  const scratch = resolve(row.scratch, id);
  // Absence records the execution default; any stored value is an explicit choice, even if equal to row.scratch.
  return { id, scratch, env: { ...row.env, TMPDIR: row.env.TMPDIR ?? scratch } };
}
