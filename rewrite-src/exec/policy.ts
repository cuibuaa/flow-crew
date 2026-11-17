import { readFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { join, resolve as normalizedPath } from 'node:path';
import type { Brief, Result } from '../contract/brief.js';
import type { GrantRequest, RuntimeConfig, Role, RunAuthority, OutputFact, CommandKey, ProviderPreferences } from '../contract/runtime.js';

// Validated literal POSIX components need only concatenation; filesystem enforceability belongs to host.
const sep = '/';
const isAbsolute = (path: string) => path.startsWith('/');
const resolve = (root: string, ...paths: string[]) => paths.reduce((parent, path) => isAbsolute(path) ? path : parent.replace(/\/$/,
  '') + '/' + path, root);
/** One owner of admission, write, baseline and delivery semantics; cost is declarations, never tree size. */
export function interpretAuthority(brief: Brief, config: Pick<RuntimeConfig,
  'sharedCaches' | 'devices' | 'providerHomes'>,
  runtime: {
    project: string; protectedRoots: readonly string[]; workRoot: string; home?: string; backend?: Role['backend'];
    environment?: Readonly<Record<string, string>>; parents?: RunAuthority['parents']
  }, facts: readonly OutputFact[]): Result<RunAuthority> {
  if (facts.length !== brief.outputs.length) return { ok: false, kind: 'invalid', detail: 'Output observation count mismatch' };
  const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
  const unique = (paths: readonly string[]) => [...new Set(paths)];
  if (Object.values(config.providerHomes).flat().some(root => !isAbsolute(root)) && !runtime.home)
    return { ok: false, kind: 'invalid', detail: 'Relative provider homes require explicit HOME' };
  const providers = {
    codex: config.providerHomes.codex.map(root => root === '.codex' &&
      runtime.environment?.CODEX_HOME ? runtime.environment.CODEX_HOME : resolve(runtime.home ?? '/', root)),
    claude: config.providerHomes.claude.map(root => resolve(runtime.home ?? '/', root))
  };
  const outputs: RunAuthority['outputs'][number][] = [];
  for (const [index, output] of brief.outputs.entries()) {
    const absolute = resolve(runtime.project, output.path), original = facts[index];
    const admission = output.existing === 'create' ? 'absent' : output.existing === 'replace' ? 'either' : 'present';
    if ((admission === 'absent' && original !== 'absent') || (admission === 'present' && original === 'absent')
      || (original !== 'absent' && original !== output.kind))
      return { ok: false, kind: 'invalid',
        detail: `Output ${output.path}: ${output.existing} ${output.kind} requires ${admission}; observed ${original}` };
    const write = within(runtime.project, absolute) ? 'project' : 'exact';
    if ([...runtime.protectedRoots, ...providers.codex, ...providers.claude].some(root => within(root, absolute) || within(absolute, root)))
      return { ok: false, kind: 'invalid', detail: `Output ${output.path}: overlaps a protected root` };
    const provision = write === 'exact' && original === 'absent';
    outputs.push({
      path: output.path, absolute, kind: output.kind, admission, original, write, provision, baseline: 'original-manifest',
        mutation: write === 'exact' && output.kind === 'file' ? 'in-place' : 'tree',
      delivery: { original: admission, append: output.existing === 'append', nonempty: false }
    });
  }
  for (const parent of runtime.parents ?? []) {
    if (parent.original === 'other' || (parent.original === 'absent' && !within(runtime.project, parent.path)
      && !outputs.some(output => output.kind === 'directory' && within(output.absolute, parent.path))))
      return { ok: false, kind: 'invalid',
        detail: `Output parent ${parent.path}: missing or non-directory authority; declare its containing directory` };
  }
  if (runtime.environment && ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'].some(key => key in runtime.environment!))
    return { ok: false, kind: 'invalid', detail: 'Private Git environment conflicts with the supplied model environment' };
  const external = outputs.filter(output => output.write === 'exact').map(output => output.absolute);
  const resources: RunAuthority['resources'] = [
    ...unique([runtime.project, ...external]).map(path => ({ path, access: 'exclusive-write' as const })),
    ...unique([...config.sharedCaches, ...config.devices]).map(path => ({ path, access: 'shared-write' as const })),
    ...unique([...runtime.protectedRoots, ...brief.inputs.filter(input => input.frozen).map(input => resolve(runtime.project,
      input.path))]).map(path => ({ path, access: 'stable-read' as const })),
  ];
  const shared = resources.filter(resource => resource.access === 'shared-write').map(resource => resource.path);
  const protectedRoots = unique([...runtime.protectedRoots, ...brief.inputs.filter(input => input.frozen).map(input => resolve(runtime.project,
    input.path))]);
  const author = { writableRoots: unique([...shared, runtime.project, ...external]), protectedRoots };
  const observer = { writableRoots: shared, protectedRoots: unique([...protectedRoots, runtime.project, ...external]) };
  const commands = brief.commands.map(command => {
    const scratch = resolve(runtime.workRoot, 'commands', command.id);
    return {
      id: command.id, scratch, grant: {
        ...author,
        protectedRoots: unique([...author.protectedRoots, ...providers.codex, ...providers.claude])
      }, env: { TMPDIR: scratch, ...command.env }
    };
  });
  for (const [index, command] of commands.entries()) if (brief.commands[index].env.TMPDIR !== undefined
    && (!isAbsolute(command.env.TMPDIR) || !command.grant.writableRoots.some(root => within(root, normalizedPath(command.env.TMPDIR)))))
    return { ok: false, kind: 'invalid',
      detail: `Command ${command.id}: declared TMPDIR ${command.env.TMPDIR} lacks writable authority; select an explicit cache or output declaration` };
  const interpretation = [
    ("No operational action, run-duration or input-size budget. C2 parks at gate suffix 3 or" +
    " failure suffix 4. Provider-internal loops re" +
    "quire manual cancellation."),
    ...outputs.filter(output => output.mutation === 'in-place').map(output => `External file ${output.path}: in-place write, truncate and append only; ` +
      'atomic replace, delete or recreate requires declaring the containing directory'),
    ...brief.commands.map(command => `Command ${command.id}: deferred; required=${command.required}; criteria remain applicable`),
  ];
  return {
    ok: true, value: {
      project: runtime.project, backend: runtime.backend, preferences: [], interpretation, parents: runtime.parents ?? [], resources, outputs,
        providers,
      purposes: {
        plan: observer, gate: observer, work: author, command: {
          ...author, protectedRoots: unique([...author.protectedRoots, ...providers.codex, ...providers.claude]),
        }
      }, commands
    }
  };
}
/** Bind invocation-local scratch and private Git to the persisted row; never rereads declarations. */
export function authorityGrant(table: RunAuthority, purpose: keyof RunAuthority['purposes'], scratch: string,
  backend?: Role['backend'], git?: GrantRequest['git'], commandId?: string): GrantRequest {
  const row = purpose === 'command' ? table.commands.find(command => command.id === commandId)!.grant : table.purposes[purpose];
  const others = backend ? Object.entries(table.providers).filter(([name]) => name !== backend).flatMap(([, roots]) => roots) : [];
  return {
    aliases: table.aliases, writableRoots: [...new Set([scratch, ...row.writableRoots, ...(backend ? table.providers[backend] : [])])],
    protectedRoots: [...new Set([...row.protectedRoots,
      ...(table.aliases ?? []).filter(alias => !alias.writable).map(alias => alias.destination), ...others])],
    ...(git ? { git: { ...git, privateDir: resolve(scratch, 'git') } } : {})
  };
}

/** Freeze model/effort and their provenance in the same resource interpretation before provisioning. */
export async function preparePolicy(brief: Brief, config: RuntimeConfig,
  runtime: Parameters<typeof interpretAuthority>[2] & { backend: Role['backend']; environment: Readonly<Record<string, string>> },
  facts: readonly OutputFact[]): Promise<Result<RunAuthority>> {
  const interpreted = interpretAuthority(brief, config, runtime, facts);
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
  return { id, scratch, env: { TMPDIR: scratch, ...command.env } };
}
