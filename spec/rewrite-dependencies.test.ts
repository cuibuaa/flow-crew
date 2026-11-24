import config from '../vitest.config.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'rewrite-src');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packages = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
]);
// Later units may import themselves and units to their left, never to their right.
const order = ['contract', 'host', 'records', 'exec', 'core', 'ops'];
const boundaries = order.map((unit, index) => ({ unit, units: order.slice(0, index + 1),
  node: unit !== 'contract',
  external: unit === 'ops' ? ['dist-monitor/rewrite-monitor/server.js'] : [],
}));
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]s$/.test(path) ? [path] : [];
  });
}
function moduleReferences(source: ts.SourceFile): Array<string | null> {
  const references: Array<string | null> = [];
  const add = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      references.push(ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null);
    }
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      references.push(expression && ts.isStringLiteral(expression) ? expression.text : null);
    }
    else if (ts.isImportTypeNode(node)) {
      references.push(ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
        ? node.argument.literal.text : null);
    }
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) references.push(argument.text);
      else {
        // A URL based on this module is static only when both arguments are literal syntax.
        const url = argument && ts.isPropertyAccessExpression(argument) && argument.name.text === 'href'
          ? argument.expression : argument;
        const args = url && ts.isNewExpression(url) && ts.isIdentifier(url.expression)
          && url.expression.text === 'URL' ? url.arguments : undefined;
        const base = args?.[1];
        references.push(args?.length === 2 && ts.isStringLiteral(args[0])
          && base && ts.isPropertyAccessExpression(base) && base.name.text === 'url'
          && ts.isMetaProperty(base.expression) && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
          && base.expression.name.text === 'meta' ? args[0].text : null);
      }
    }
    ts.forEachChild(node, add);
    // JSDoc is attached to declarations rather than included in forEachChild's syntax walk.
    for (const doc of (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []) add(doc);
  };
  add(source);
  // Triple-slash references also form dependencies.
  source.referencedFiles.forEach(reference => references.push(reference.fileName));
  source.typeReferenceDirectives.forEach(reference => references.push(reference.fileName));
  return references;
}
it.each(boundaries)('$unit follows its declared import boundary', boundary => {
  const violations: string[] = [];
  expect(existsSync(join(sourceRoot, boundary.unit)), `Missing required unit ${boundary.unit}`).toBe(true);
  for (const file of sourceFiles(join(sourceRoot, boundary.unit))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const reference of moduleReferences(source)) {
      let allowed = false;
      if (reference !== null && reference.startsWith('.')) {
        const target = relative(sourceRoot, resolve(dirname(file), reference)).split(/[\\/]/);
        const path = resolve(dirname(file), reference);
        const physical = existsSync(path) ? path : path.replace(/\.([cm]?)js$/, '.$1ts');
        allowed = (boundary.units.includes(target[0]) && !target.includes('..') && existsSync(physical))
          || boundary.external.includes(relative(root, path));
      }
      else if (reference !== null) {
        const packageName = reference.startsWith('@') ? reference.split('/').slice(0, 2).join('/')
          : reference.split('/')[0];
        allowed = packages.has(packageName) || (boundary.node && isBuiltin(reference));
      }
      if (reference === null && relative(sourceRoot, file) === 'host/process.ts')
        allowed = true; // Recorded trusted operation/entry capability.
      if (!allowed)
        violations.push(`${relative(root, file)}: ${reference ?? 'nonliteral dependency'}`);
    }
  }
  expect(violations).toEqual([]);
});

it('keeps private host imports behind the public host ports', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    if (relative(sourceRoot, file).startsWith('host/'))
      continue;
    const text = readFileSync(file, 'utf8'), source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const ref of moduleReferences(source))
      if (ref && /host\//.test(ref) && !ref.endsWith('/process.js'))
        violations.push(file + ': ' + ref);
  }
  expect(violations).toEqual([]);
});
import { parse as yaml } from 'yaml';
it('native CI selects matching Linux/macOS contracts; evidence travels with test output', () => {
  const workflow = yaml(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  // These are the declared native host jobs. Case roots are temporary; their
  // diagnostics travel in Vitest output, rather than a repository artifact tree.
  const hosts = [workflow.jobs['native-linux'], workflow.jobs['native-macos']];
  expect(hosts.some(job => job['runs-on'] === 'macos-15')).toBe(true);
  expect(hosts.some(job => job['runs-on'].startsWith('ubuntu-'))).toBe(true);
  const native = config.test!.projects!.find((project: any) => project.test?.name === 'native') as any;
  expect(native.test.include).toEqual(['spec/native/**/*.test.ts']);
  for (const job of hosts) {
    const version = job.steps.find((step: any) => step.uses?.startsWith('actions/setup-node@')).with['node-version'];
    const minimum = manifest.engines.node.replace('>=', '').split('.').map(Number);
    const actual = version.split('.').map(Number);
    expect(actual[0] > minimum[0] || actual[0] === minimum[0] && actual[1] >= minimum[1]).toBe(true);
  }
});
