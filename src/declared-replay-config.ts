import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { discoverProjectValidation } from './project-validation.js';

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function configuredWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  const push = (): void => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    word += character;
    started = true;
  }
  if (escaped || quote) return undefined;
  push();
  return words;
}

function packageTestCommand(projectDir: string): string[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8')) as {
      scripts?: { test?: unknown };
    };
    const script = parsed.scripts?.test;
    return typeof script === 'string' ? configuredWords(script) : undefined;
  } catch {
    return undefined;
  }
}

interface ConfiguredPytest {
  pythonExecutable: string;
  environment: Record<string, string>;
  /** True when the interpreter was proven from a Makefile recipe rather than a bare discovered default. */
  fromMakefile: boolean;
}

/** Resolve only a single, statically inspectable Makefile pytest recipe. */
export function configuredPytest(projectDir: string): ConfiguredPytest | undefined {
  const test = discoverProjectValidation(projectDir).commands.find((command) => command.role === 'test');
  if (!test) return undefined;
  if ((test.command === 'python' || test.command === 'python3')
    && test.args[0] === '-m' && test.args[1] === 'pytest') {
    return { pythonExecutable: test.command, environment: {}, fromMakefile: false };
  }
  if (test.command !== 'make' || test.args[0] !== 'test') return undefined;
  try {
    // GNU Make chooses these names before Makefile when present.
    if (existsSync(join(projectDir, 'GNUmakefile')) || existsSync(join(projectDir, 'makefile'))) return undefined;
    // These can inject makefiles, command-line variables, or make -e without
    // changing the Makefile inspected below.
    if (['MAKEFLAGS', 'MFLAGS', 'GNUMAKEFLAGS', 'MAKEFILES', 'MAKEOVERRIDES']
      .some((name) => process.env[name])) return undefined;
    const lines = readFileSync(join(projectDir, 'Makefile'), 'utf-8').split(/\r?\n/);
    const variables = new Map<string, string>();
    const recipes: string[] = [];
    let testTargets = 0;
    let inTestRecipe = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || (!line.startsWith('\t') && trimmed.startsWith('#'))) continue;
      if (line.startsWith('\t')) {
        if (!inTestRecipe) return undefined;
        if (!/^\t\s*#/.test(line)) recipes.push(line.slice(1).trim());
        continue;
      }
      inTestRecipe = false;
      const variable = line.match(/^(PY|PYTHON)\s*(\?=|:=|=)\s*(\S+)\s*$/);
      if (variable) {
        if (variables.has(variable[1])
          || (variable[2] === '?=' && Object.hasOwn(process.env, variable[1]))) return undefined;
        variables.set(variable[1], variable[3]);
      } else if (/^\.PHONY\s*:\s*test\s*(?:#.*)?$/.test(line)) {
        continue;
      } else if (/^test\s*:\s*(?:#.*)?$/.test(line)) {
        testTargets += 1;
        inTestRecipe = true;
      } else {
        // Includes, conditionals, target-specific variables, alternate recipes,
        // and other make directives can change what `make test` executes.
        return undefined;
      }
    }
    if (testTargets !== 1 || recipes.length !== 1) return undefined;
    const words = configuredWords(recipes[0]);
    if (!words) return undefined;
    const environment: Record<string, string> = {};
    while (words.length > 0 && /^[A-Z][A-Z0-9_]*=/.test(words[0])) {
      const assignment = words.shift()!;
      const separator = assignment.indexOf('=');
      const name = assignment.slice(0, separator);
      const value = assignment.slice(separator + 1);
      if (name === 'PYTHONPATH' && value === '.') environment.PYTHONPATH = '.';
      else if (name === 'PYTEST_ADDOPTS' && value === '-p no:cacheprovider') {
        environment.PYTEST_ADDOPTS = value;
      } else return undefined;
    }
    // Targeted replay clears inherited addopts; a make recipe without its own
    // assignment would otherwise run a different pytest selection.
    if (process.env.PYTEST_ADDOPTS && environment.PYTEST_ADDOPTS === undefined) return undefined;
    const configuredWord = words.shift();
    const variable = configuredWord?.match(/^\$\((PY|PYTHON)\)$/)?.[1];
    const pythonExecutable = variable ? variables.get(variable) : configuredWord;
    if (!pythonExecutable) return undefined;
    if (isAbsolute(pythonExecutable)) {
      if (!/^python(?:3(?:\.\d+)?)?$/.test(pythonExecutable.split(/[\\/]/).at(-1) ?? '')
        || !existsSync(pythonExecutable) || !statSync(pythonExecutable).isFile()) return undefined;
    } else if (!/^python(?:3(?:\.\d+)?)?$/.test(pythonExecutable)) return undefined;
    if (words.shift() !== '-m' || words.shift() !== 'pytest') return undefined;
    let collectionRoot = false;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (['-q', '-qq', '-v', '--quiet', '--verbose'].includes(word)) continue;
      if (word === '-p' && words[index + 1] === 'no:cacheprovider') { index += 1; continue; }
      const path = resolve(projectDir, word);
      if (within(projectDir, path) && existsSync(path)
        && within(projectDir, realpathSync(path))
        && ((word.endsWith('/') && statSync(path).isDirectory())
          || (/(?:^test_.+|.+_test)\.py$/i.test(word.split(/[\\/]/).at(-1) ?? '')
            && statSync(path).isFile()))) {
        collectionRoot = true;
        continue;
      }
      return undefined;
    }
    return collectionRoot ? { pythonExecutable, environment, fromMakefile: true } : undefined;
  } catch { /* unreadable configuration is not authorization */ }
  return undefined;
}


/** Only the project recipe can authorize the Vitest runner. */
export function configuredVitest(projectDir: string): boolean {
  const words = packageTestCommand(projectDir);
  return !!words && (words[0] === 'vitest' && words.slice(1).every((word) => word === 'run' || word === '--run')
    || words[0] === 'node' && /^(?:\.\/)?node_modules\/vitest\/vitest\.mjs$/.test(words[1] ?? '') && words.slice(2).every((word) => word === 'run' || word === '--run'));
}
