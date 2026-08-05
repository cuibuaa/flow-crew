import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../ui");
const SOURCE_ROOT = join(UI_ROOT, "src");
const CODE_EXTENSIONS = [".ts", ".tsx"];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return CODE_EXTENSIONS.includes(extname(path)) && !path.endsWith(".d.ts") ? [normalize(path)] : [];
  });
}

function resolveLocalImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    ...CODE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...CODE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function dependencyGraph(files: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const dependencies = new Set<string>();
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const target = resolveLocalImport(file, node.moduleSpecifier.text);
        if (target) dependencies.add(normalize(target));
      }
      if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])) {
        const target = resolveLocalImport(file, node.arguments[0].text);
        if (target) dependencies.add(normalize(target));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    graph.set(normalize(file), [...dependencies]);
  }
  return graph;
}

function reachableFrom(entry: string, graph: Map<string, string[]>): Set<string> {
  const reachable = new Set<string>();
  const pending = [normalize(entry)];
  while (pending.length) {
    const file = pending.pop();
    if (!file || reachable.has(file)) continue;
    reachable.add(file);
    pending.push(...(graph.get(file) ?? []));
  }
  return reachable;
}

function exportedNames(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) names.push(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return names;
}

function importedApiNames(files: Iterable<string>, apiFile: string): Set<string> {
  const imported = new Set<string>();
  const apiBase = apiFile.slice(0, -extname(apiFile).length);
  for (const file of files) {
    if (file === apiFile) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      if (resolve(dirname(file), statement.moduleSpecifier.text) !== apiBase) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) imported.add((element.propertyName ?? element.name).text);
    }
  }
  return imported;
}

describe("production UI graph", () => {
  const files = sourceFiles(SOURCE_ROOT);
  const graph = dependencyGraph(files);
  const reachable = reachableFrom(join(SOURCE_ROOT, "main.tsx"), graph);

  it("has no source modules unreachable from main.tsx", () => {
    const unreachable = files
      .filter((file) => !reachable.has(file))
      .map((file) => relative(SOURCE_ROOT, file).replaceAll("\\", "/"))
      .sort();
    expect(unreachable, `unreachable UI modules:\n${unreachable.join("\n")}`).toEqual([]);
  });

  it("gives every api.ts export a production caller", () => {
    const apiFile = normalize(join(SOURCE_ROOT, "api.ts"));
    const imports = importedApiNames(reachable, apiFile);
    const unused = exportedNames(apiFile).filter((name) => !imports.has(name)).sort();
    expect(unused, `api.ts exports without callers:\n${unused.join("\n")}`).toEqual([]);
  });
});
