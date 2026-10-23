import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidationCommand, ValidationFileSystem, ValidationRole } from '../../src/project-validation.js';

const nodeValidationFs: ValidationFileSystem = {
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf-8'),
};

export interface ValidationPathImpact {
  path: string;
  role: ValidationRole;
  command: string;
  evidence: string;
}

function validationGlobRegex(pattern: string): RegExp | undefined {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return undefined;
  let source = '^';
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      index++;
      if (normalized[index + 1] === '/') {
        index++;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  try { return new RegExp(`${source}$`); } catch { return undefined; }
}

interface LiteralConfigToken {
  kind: 'word' | 'string' | 'punctuation';
  value: string;
}

/** Tokenize only the syntax needed to prove a literal config binding. Comments
 * and template expressions are deliberately invisible so prose cannot create
 * an operator warning. */
function literalConfigTokens(source: string): LiteralConfigToken[] {
  const tokens: LiteralConfigToken[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (char === '`') {
      index++;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index++] === '`') break;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      index++;
      while (index < source.length) {
        const current = source[index++];
        if (current === quote) break;
        if (current === '\\' && index < source.length) value += source[index++];
        else value += current;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
    if (word) {
      tokens.push({ kind: 'word', value: word[0] });
      index += word[0].length;
      continue;
    }
    if ('{}[]():,'.includes(char)) tokens.push({ kind: 'punctuation', value: char });
    index++;
  }
  return tokens;
}

function literalTestIncludePatterns(source: string): string[] {
  const tokens = literalConfigTokens(source);
  const patterns: string[] = [];
  const named = (index: number, value: string): boolean => (
    (tokens[index]?.kind === 'word' || tokens[index]?.kind === 'string')
    && tokens[index]?.value === value
  );
  for (let index = 0; index < tokens.length - 2; index++) {
    if (!named(index, 'test') || tokens[index + 1]?.value !== ':' || tokens[index + 2]?.value !== '{') continue;
    if (index > 0 && !['{', ','].includes(tokens[index - 1]?.value ?? '')) continue;
    let objectDepth = 1;
    for (let cursor = index + 3; cursor < tokens.length && objectDepth > 0; cursor++) {
      const token = tokens[cursor];
      if (token.value === '{') {
        objectDepth++;
        continue;
      }
      if (token.value === '}') {
        objectDepth--;
        continue;
      }
      if (objectDepth !== 1 || !named(cursor, 'include')
          || tokens[cursor + 1]?.value !== ':' || tokens[cursor + 2]?.value !== '[') continue;
      let arrayDepth = 1;
      for (cursor += 3; cursor < tokens.length && arrayDepth > 0; cursor++) {
        const member = tokens[cursor];
        if (member.value === '[') arrayDepth++;
        else if (member.value === ']') arrayDepth--;
        else if (arrayDepth === 1 && member.kind === 'string') patterns.push(member.value);
      }
      cursor--;
    }
  }
  return patterns;
}

function literalVitestIncludes(
  projectDir: string,
  fs: ValidationFileSystem,
): Array<{ pattern: string; evidencePath: string }> {
  const configNames = [
    'vitest.config.ts', 'vitest.config.tsx', 'vitest.config.mts', 'vitest.config.cts',
    'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  ];
  const includes: Array<{ pattern: string; evidencePath: string }> = [];
  for (const configName of configNames) {
    const configPath = join(projectDir, configName);
    if (!fs.exists(configPath)) continue;
    let source: string;
    try { source = fs.readText(configPath); } catch { continue; }
    for (const pattern of literalTestIncludePatterns(source)) {
      if (pattern) includes.push({ pattern, evidencePath: configName });
    }
  }
  return includes;
}

/** Return only path/command intersections supported by a literal project
 * configuration binding. Unknown runner semantics stay silent. */
export function validationPathImpacts(
  projectDir: string,
  commands: readonly ValidationCommand[],
  paths: readonly string[],
  fs: ValidationFileSystem = nodeValidationFs,
): ValidationPathImpact[] {
  const normalizedPaths = [...new Set(paths.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '')))];
  const impacts: ValidationPathImpact[] = [];
  for (const command of commands) {
    const patterns = command.args
      .filter((arg) => !arg.startsWith('-') && (arg.includes('/') || /[*?]/.test(arg)))
      .map((pattern) => ({ pattern, evidencePath: command.evidencePath ?? command.display }));
    if (command.role === 'test') patterns.push(...literalVitestIncludes(projectDir, fs));
    for (const { pattern, evidencePath } of patterns) {
      const matcher = validationGlobRegex(pattern);
      if (!matcher) continue;
      for (const path of normalizedPaths) {
        if (!matcher.test(path)) continue;
        impacts.push({
          path,
          role: command.role,
          command: command.display,
          evidence: `${evidencePath} literal input ${pattern}`,
        });
      }
    }
  }
  return impacts.filter((impact, index, all) => all.findIndex((candidate) => (
    candidate.path === impact.path && candidate.role === impact.role && candidate.command === impact.command
  )) === index);
}
