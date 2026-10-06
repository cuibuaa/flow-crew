/** Discover configured validation output capabilities and recognize their command provenance; no arbitrary command execution. */
import { readFileSync, existsSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, join, relative, posix, isAbsolute, sep, dirname, basename } from 'node:path';
import { runDir } from '../../store.js';
import { type ValidationCommand } from '../../project-validation.js';
import { parseDeclaredScope } from './frontier.js';
import { literalTreeCapabilityRoot, normalizedProjectPath } from './scope-services.js';
import { type StageConfig } from './configuration.js';
import type { DeclaredInputScopeServices } from './scope-services.js';

function generatedOutputScope(rawScope: string): boolean {
  const parsed = parseDeclaredScope(rawScope);
  const root = literalTreeCapabilityRoot(parsed);
  if (!root) return false;
  const segments = root.split('/');
  if (segments.includes('.cache')) return true;
  if (segments.at(-1) === 'dist') return true;
  const modules = segments.lastIndexOf('node_modules');
  return modules >= 0 && ['.vite', '.vite-temp'].includes(segments[modules + 1] ?? '');
}

function readPackageManifest(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function packageScriptDirectories(packageRoot: string, manifest: Record<string, unknown>): string[] {
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
    ? Object.values(manifest.scripts as Record<string, unknown>).filter((value): value is string => typeof value === 'string')
    : [];
  const directories = new Set<string>();
  for (const script of scripts) {
    for (const match of script.matchAll(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))\s*(?:&&|;)/g)) {
      const relativeDirectory = match[1] ?? match[2] ?? match[3];
      const candidate = resolve(packageRoot, relativeDirectory);
      if (existsSync(join(candidate, 'package.json'))) directories.add(candidate);
    }
  }
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces && typeof manifest.workspaces === 'object' && !Array.isArray(manifest.workspaces)
      ? (manifest.workspaces as { packages?: unknown }).packages
      : undefined;
  for (const rawPattern of Array.isArray(workspaces) ? workspaces : []) {
    if (typeof rawPattern !== 'string') continue;
    const normalized = normalizedProjectPath(rawPattern);
    if (!normalized) continue;
    if (!normalized.includes('*')) {
      const candidate = resolve(packageRoot, normalized);
      if (existsSync(join(candidate, 'package.json'))) directories.add(candidate);
      continue;
    }
    const match = /^(.*)\/\*$/.exec(normalized);
    if (!match || /[*?{}[\]]/.test(match[1])) continue;
    const parent = resolve(packageRoot, match[1]);
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(parent, entry.name, 'package.json'))) {
          directories.add(join(parent, entry.name));
        }
      }
    } catch { /* an absent workspace root contributes no package */ }
  }
  return [...directories];
}

/** Derive the generated-output capability set from target-owned tool
 * configuration, never from capabilities a submitted plan happened to claim. */
export function discoverConfiguredCommandScopes(projectDir: string): string[] {
  const projectRoot = resolve(projectDir);
  const packageRoots: string[] = [projectRoot];
  const visited = new Set<string>();
  const packages: Array<{ root: string; manifest: Record<string, unknown> }> = [];
  while (packageRoots.length > 0) {
    const packageRoot = packageRoots.shift()!;
    if (visited.has(packageRoot)) continue;
    visited.add(packageRoot);
    const relativeRoot = relative(projectRoot, packageRoot);
    if (relativeRoot === '..' || relativeRoot.startsWith(`..${posix.sep}`) || isAbsolute(relativeRoot)) continue;
    const manifest = readPackageManifest(join(packageRoot, 'package.json'));
    if (!manifest) continue;
    packages.push({ root: packageRoot, manifest });
    packageRoots.push(...packageScriptDirectories(packageRoot, manifest));
  }

  const scopes = new Set<string>();
  const addTree = (packageRoot: string, rawPath: string, filePath = false): void => {
    const normalized = normalizedProjectPath(rawPath);
    if (!normalized || /[$`{}]/.test(normalized)) return;
    const packagePrefix = relative(projectRoot, packageRoot).split(sep).join('/');
    const localRoot = filePath ? posix.dirname(normalized) : normalized.replace(/\/$/, '');
    if (!localRoot || localRoot === '.') return;
    const projectPath = packagePrefix && packagePrefix !== '.' ? `${packagePrefix}/${localRoot}` : localRoot;
    const scope = `${projectPath}/**`;
    if (generatedOutputScope(scope)) scopes.add(scope);
  };

  for (const { root: packageRoot, manifest } of packages) {
    const scripts = manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
      ? Object.values(manifest.scripts as Record<string, unknown>).filter((value): value is string => typeof value === 'string')
      : [];
    const scriptText = scripts.join('\n');
    const dependencyNames = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((field) => {
        const section = manifest[field];
        return section && typeof section === 'object' && !Array.isArray(section)
          ? Object.keys(section as Record<string, unknown>)
          : [];
      }));
    const usesVitest = /\bvitest\b/.test(scriptText) || dependencyNames.has('vitest');
    const buildsWithVite = /\bvite(?:\.cmd)?\s+build\b/.test(scriptText);
    if (usesVitest || buildsWithVite) {
      addTree(packageRoot, 'node_modules/.vite');
      addTree(packageRoot, 'node_modules/.vite-temp');
    }

    let viteOutDir: string | undefined;
    for (const script of scripts) {
      const match = /\bvite(?:\.cmd)?\s+build\b[^\n]*?--outDir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(script);
      if (match) viteOutDir = match[1] ?? match[2] ?? match[3];
    }
    for (const configName of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs']) {
      try {
        const configured = /\boutDir\s*:\s*["']([^"']+)["']/.exec(readFileSync(join(packageRoot, configName), 'utf-8'))?.[1];
        if (configured) viteOutDir = configured;
      } catch { /* this package has no config under that spelling */ }
    }
    if (buildsWithVite) addTree(packageRoot, viteOutDir ?? 'dist');

    let names: string[] = [];
    try { names = readdirSync(packageRoot); } catch { /* an unreadable package has no discoverable TypeScript outputs */ }
    for (const name of names.filter((candidate) => /^tsconfig(?:\.[^.]+)?\.json$/.test(candidate))) {
      let source: string;
      try { source = readFileSync(join(packageRoot, name), 'utf-8'); } catch { continue; }
      const outDir = /["']outDir["']\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
      const buildInfo = /["']tsBuildInfoFile["']\s*:\s*["']([^"']+)["']/.exec(source)?.[1];
      if (outDir) addTree(packageRoot, outDir);
      if (buildInfo) addTree(packageRoot, buildInfo, true);
    }
    for (const script of scripts) {
      const outDir = /--outDir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(script);
      const buildInfo = /--tsBuildInfoFile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(script);
      if (outDir) addTree(packageRoot, outDir[1] ?? outDir[2] ?? outDir[3]);
      if (buildInfo) addTree(packageRoot, buildInfo[1] ?? buildInfo[2] ?? buildInfo[3], true);
    }
  }
  return [...scopes].sort();
}

export function createTransientVitestScopeReader({ resolveDeclaredInputWriteBindings, firstDeclaredInputScopeConflict }: DeclaredInputScopeServices) {
  return (/** Vitest creates and removes these files even for a targeted invocation that
   * does not spell the configured package test command. Keep the exemption tied
   * to actual project configuration, and never exempt a declared input tree. */
  function transientVitestOutputScopes(projectDir: string, runId: string, configuredScopes: readonly string[]): string[] {
    const briefPath = join(runDir(projectDir, runId), 'task_brief.md');
    const declaredInputs = existsSync(briefPath)
      ? resolveDeclaredInputWriteBindings(projectDir, readFileSync(briefPath, 'utf-8'))
      : [];
    return configuredScopes.filter((scope) => (
      scope.endsWith('node_modules/.vite-temp/**')
      && !firstDeclaredInputScopeConflict([scope], declaredInputs, projectDir)
    ));
  });
}

function commandAliases(display: string): string[] {
  const aliases = [display];
  if (display === 'npm run test') aliases.push('npm test');
  const packageScript = /^(pnpm|yarn|bun) run (\S+)$/.exec(display);
  if (packageScript) aliases.push(`${packageScript[1]} ${packageScript[2]}`);
  return aliases;
}

function unquotedShellWord(raw: string): { value: string; length: number } | undefined {
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end < 0 ? undefined : { value: raw.slice(1, end), length: end + 1 };
  }
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    if (end < 0) return undefined;
    const value = raw.slice(1, end);
    // Expansion makes the destination unknowable without interpreting shell.
    return /[$`\\]/.test(value) ? undefined : { value, length: end + 1 };
  }
  const word = /^[^\s;&|<>()]+/.exec(raw)?.[0];
  if (!word || /[$`\\*?[\]{}]/.test(word)) return undefined;
  return { value: word, length: word.length };
}

function projectContainsResolvedPath(projectDir: string, rawPath: string): boolean {
  const projectRoot = resolve(projectDir);
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath);
  const contains = (root: string, candidate: string): boolean => {
    const rel = relative(root, candidate);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  };
  if (contains(projectRoot, target)) return true;

  const canonicalPotentialPath = (
    rawTarget: string,
    seenLinks = new Set<string>(),
  ): string | undefined => {
    let current = resolve(rawTarget);
    const suffix: string[] = [];
    for (;;) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(current);
      } catch {
        const parent = dirname(current);
        if (parent === current) return undefined;
        suffix.unshift(basename(current));
        current = parent;
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (seenLinks.has(current)) return undefined;
        seenLinks.add(current);
        let linked: string;
        try { linked = readlinkSync(current); } catch { return undefined; }
        const destination = isAbsolute(linked)
          ? resolve(linked)
          : resolve(dirname(current), linked);
        return canonicalPotentialPath(resolve(destination, ...suffix), seenLinks);
      }
      try { return resolve(realpathSync(current), ...suffix); } catch { return undefined; }
    }
  };

  const physicalRoot = canonicalPotentialPath(projectRoot);
  const physicalTarget = canonicalPotentialPath(target);
  // Unresolvable aliases do not earn configured-generator provenance.
  return !physicalRoot || !physicalTarget || contains(physicalRoot, physicalTarget);
}

/** A shell may redirect diagnostic output outside the project without changing
 * who owns repository writes. A project-relative/inside-project destination is
 * itself authored by the shell and therefore invalidates generator provenance.
 * Every other suffix fails closed instead of being treated as command flags. */
function hasOnlyExternalOutputRedirections(raw: string, projectDir: string): boolean {
  let suffix = raw.trim();
  if (!suffix) return true;
  while (suffix) {
    const operator = /^(?:\d+|&)?(?:>>?|>\|)\s*/.exec(suffix);
    if (!operator) return false;
    suffix = suffix.slice(operator[0].length);
    const descriptor = /^&(?:\d+|-)(?=\s|$)/.exec(suffix);
    if (descriptor) {
      suffix = suffix.slice(descriptor[0].length).trimStart();
      continue;
    }
    const target = unquotedShellWord(suffix);
    if (!target || projectContainsResolvedPath(projectDir, target.value)) return false;
    suffix = suffix.slice(target.length).trimStart();
  }
  return true;
}

/** Match only a stand-alone configured validation execution. Compound shell
 * commands are deliberately refused: their other clauses can author files in
 * a generated-looking tree and therefore do not carry generator provenance. */
export function configuredValidationCommandRole(
  rawCommand: string,
  commands: readonly ValidationCommand[],
  projectDir = process.cwd(),
): ValidationCommand['role'] | undefined {
  let command = rawCommand.trim();
  const shellWrapper = /^(?:\/bin\/)?(?:ba|da|z)?sh\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command);
  if (shellWrapper) command = shellWrapper[2];
  if (/\r|\n|;|&&|\|\||[`]|\$\(/.test(command) || /(^|[^<>])\|([^|]|$)/.test(command)) return undefined;
  const grouped = /^\(\s*([\s\S]*?)\s*\)$/.exec(command);
  if (grouped) command = grouped[1];
  else if (/[()]/.test(command)) return undefined;
  // Permit the bounded wrappers emitted by stage instructions without
  // interpreting a general shell program.
  command = command.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/, '');
  command = command.replace(/^(?:\/usr\/bin\/)?timeout(?:\s+--?[A-Za-z-]+(?:=\S+|\s+\S+)?)?\s+\d+(?:\.\d+)?(?:ms|s|m|h|d)?\s+/, '');
  command = command.replace(/^command\s+/, '');
  const lower = command.toLowerCase();
  for (const configured of commands) {
    for (const alias of commandAliases(configured.display)) {
      const normalized = alias.trim().toLowerCase();
      if (lower === normalized) return configured.role;
      if (lower.startsWith(`${normalized} `)
        && hasOnlyExternalOutputRedirections(command.slice(alias.trim().length), projectDir)) {
        return configured.role;
      }
    }
  }
  return undefined;
}

/** Infer only direct imperative execution clauses. Fenced examples, block
 * quotes, negated clauses, and mere command citations are deliberately inert. */
export function configuredCommandRolesForStage(
  stage: StageConfig,
  commands: readonly { role: string; display: string }[],
): string[] {
  const action = String.raw`(?:run|re[- ]?run|execute|invoke|launch|capture|verify(?:\s+(?:with|using))?|validate(?:\s+(?:with|using))?)`;
  const roles = new Set<string>();
  let fenced = false;
  for (const rawLine of stage.prompt_template.split(/\r?\n/)) {
    if (/^\s*```/.test(rawLine)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*>/.test(rawLine)) continue;
    const line = rawLine.replace(/^\s*[-*]\s+/, '').trim();
    if (!line || new RegExp(`\\b(?:do not|don't|must not|should not|never|without)\\s+${action}\\b`, 'i').test(line)) continue;
    const intent = new RegExp(
      `(?:^|[.!?;:]\\s+|,\\s+|\\b(?:and|then|must|should|before finishing)\\s+)(?:please\\s+)?${action}\\b`,
      'i',
    ).exec(line);
    if (!intent) continue;
    const executableClause = line.slice((intent.index ?? 0) + intent[0].length);
    for (const command of commands) {
      const configuredRole = new RegExp(`\\b(?:the\\s+)?configured\\s+${command.role}\\s+command\\b`, 'i');
      if (commandAliases(command.display).some((alias) => executableClause.toLowerCase().includes(alias.toLowerCase()))
          || configuredRole.test(executableClause)) {
        roles.add(command.role);
      }
    }
  }
  return [...roles].sort();
}
