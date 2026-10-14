/** Discover configured validation output capabilities; no arbitrary command execution. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative, posix, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listProjectFiles } from '../sched_scope/path-capabilities.js';
import { parseDeclaredScope } from './frontier.js';
import { literalTreeCapabilityRoot, normalizedProjectPath } from './scope-services.js';
import { type StageConfig } from './configuration.js';

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
  } catch { return undefined; }
}

/** Both validation and output capabilities use project-owned manifests rather
 * than guessing package roots from command spelling. Git excludes installed
 * packages and generated copies; non-Git projects use the existing inventory. */
export function discoverConfiguredPackages(projectDir: string): Array<{ root: string; manifest: Record<string, unknown> }> {
  const projectRoot = resolve(projectDir);
  const inventory = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'package.json', '**/package.json'], {
    cwd: projectRoot, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
  });
  const paths = inventory.status === 0 ? inventory.stdout.split('\0') : listProjectFiles(projectRoot, {
    skipDirectory: path => path.split('/').includes('node_modules'),
  });
  return [...new Set(['package.json', ...paths])].flatMap(path => {
    if (path.split('/').includes('node_modules') || !/(?:^|\/)package\.json$/.test(path)) return [];
    const manifest = readPackageManifest(join(projectRoot, path));
    return manifest ? [{ root: dirname(join(projectRoot, path)), manifest }] : [];
  });
}

/** Derive the generated-output capability set from target-owned tool
 * configuration, never from capabilities a submitted plan happened to claim. */
export function discoverConfiguredCommandScopes(projectDir: string): string[] {
  const projectRoot = resolve(projectDir);
  const packages = discoverConfiguredPackages(projectDir);

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

function commandAliases(display: string): string[] {
  const aliases = [display];
  if (display === 'npm run test') aliases.push('npm test');
  const packageScript = /^(pnpm|yarn|bun) run (\S+)$/.exec(display);
  if (packageScript) aliases.push(`${packageScript[1]} ${packageScript[2]}`);
  return aliases;
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
