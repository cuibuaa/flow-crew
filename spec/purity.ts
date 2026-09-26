import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, posix, relative } from "node:path";
import ts from "typescript";

export interface PurityViolation {
  file: string;
  line: number;
  rule: string;
  description: string;
}

export interface ScanOptions {
  testOwnedEnvKeys?: ReadonlySet<string>;
}

export type ProjectScanOptions = ScanOptions;

interface PurityRule {
  id: string;
  description: string;
  patterns: RegExp[];
}

interface EnvReference {
  key: string;
  node: ts.Node;
  write: boolean;
}

const regex = (source: string, flags = "g"): RegExp => new RegExp(source, flags);
const privateNames = [
  ["trading", "_bot"].join(""),
  ["btc", "_explore"].join(""),
  ["stock", "_analysis"].join(""),
  ["da", "qing"].join(""),
  ["ai", "_fan"].join(""),
  ["frontier", "_expansion"].join(""),
];

const RULES: PurityRule[] = [
  {
    id: "absolute-home",
    description: "absolute user-home path",
    patterns: [regex("/" + "home" + "/[^/\\s]+/")],
  },
  {
    id: "wsl-mount",
    description: "WSL drive mount path",
    patterns: [regex("/" + "mnt" + "/[A-Za-z]/")],
  },
  {
    id: "windows-drive",
    description: "Windows drive path",
    patterns: [regex("(?:^|[^A-Za-z0-9_])[A-Za-z]:" + "\\\\")],
  },
  {
    id: "private-project",
    description: "private project identifier",
    patterns: [regex("\\b(?:" + privateNames.join("|") + ")\\b", "gi")],
  },
  {
    id: "user-home-state",
    description: "direct access to machine user-home state",
    patterns: [regex("\\b" + "home" + "dir\\s*\\(")],
  },
  {
    id: "network-client",
    description: "real network client",
    patterns: [
      regex("\\b" + "fet" + "ch\\s*\\("),
      regex("\\b" + ["axi", "os"].join("") + "\\b", "gi"),
      regex("\\b" + ["node", "-", "fetch"].join("") + "\\b", "gi"),
    ],
  },
  {
    id: "real-history",
    description: "author-specific task or run history",
    patterns: [
      regex("\\btask\\s*#\\d{3,}", "gi"),
      regex(
        "\\b" + ["20", "26"].join("")
          + "-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-[A-Za-z0-9][A-Za-z0-9_-]*\\b",
      ),
    ],
  },
];

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function normalizedFile(file: string): string {
  return file.replaceAll("\\", "/");
}

function sourceFileFor(source: string, file: string): ts.SourceFile {
  const extension = extname(file).toLowerCase();
  const kind = extension === ".tsx" || extension === ".jsx"
    ? ts.ScriptKind.TSX
    : extension === ".js" || extension === ".mjs" || extension === ".cjs"
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function lineFor(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isProcessEnv(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "process"
    && node.name.text === "env";
}

function envKey(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
    const argument = node.argumentExpression;
    if (argument && ts.isStringLiteralLike(argument)) return argument.text;
    return "<dynamic>";
  }
  return undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isEnvWrite(node: ts.Node): boolean {
  const parent = node.parent;
  return (ts.isBinaryExpression(parent)
      && parent.left === node
      && isAssignmentOperator(parent.operatorToken.kind))
    || (ts.isDeleteExpression(parent) && parent.expression === node);
}

function envReferences(sourceFile: ts.SourceFile): EnvReference[] {
  const references: EnvReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && isProcessEnv(node.initializer)) {
      for (const element of node.name.elements) {
        const keyNode = element.propertyName ?? element.name;
        const key = ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode)
          ? keyNode.text
          : "<dynamic>";
        references.push({ key, node: element, write: false });
      }
    }
    const key = envKey(node);
    if (key) references.push({ key, node, write: isEnvWrite(node) });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function keysInside(
  node: ts.Node,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const keys = new Set<string>();
  const visit = (current: ts.Node): void => {
    const key = envKey(current);
    if (key) keys.add(key);
    if (ts.isIdentifier(current)) {
      for (const aliasKey of aliases.get(current.text) ?? []) keys.add(aliasKey);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return keys;
}

function explicitlyFails(node: ts.Node): boolean {
  let found = false;
  const inspect = (current: ts.Node): void => {
    if (ts.isThrowStatement(current)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if ((ts.isIdentifier(callee) && callee.text === "fail")
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === "fail")) {
        found = true;
        return;
      }
    }
    if (!found) ts.forEachChild(current, inspect);
  };
  inspect(node);
  return found;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function aliasInitializerKeys(
  initializer: ts.Expression,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  return keysInside(unwrapExpression(initializer), aliases);
}

function envAliases(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  const declarations: Array<{ name: string; initializer: ts.Expression }> = [];
  const aliases = new Map<string, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push({ name: node.name.text, initializer: node.initializer });
    }
    if (ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && isProcessEnv(node.initializer)) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const keyNode = element.propertyName ?? element.name;
        const key = ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode)
          ? keyNode.text
          : "<dynamic>";
        aliases.set(element.name.text, new Set([key]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const keys = aliasInitializerKeys(declaration.initializer, aliases);
      if (keys.size === 0) continue;
      const previous = aliases.get(declaration.name) ?? new Set<string>();
      const before = previous.size;
      for (const key of keys) previous.add(key);
      aliases.set(declaration.name, previous);
      if (previous.size !== before) changed = true;
    }
  }
  return aliases;
}

function containsSkip(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (ts.isPropertyAccessExpression(current)
      && ["skip", "skipIf", "runIf"].includes(current.name.text)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

interface MissingEnvCondition {
  keys: Set<string>;
  /** Which branch the condition takes when the referenced env key is absent. */
  whenMissing: boolean;
}

interface ConditionOperand {
  keys: Set<string>;
  missingValue: undefined | string;
}

function conditionOperand(
  node: ts.Expression,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
): ConditionOperand | undefined {
  const expression = unwrapExpression(node);
  if (ts.isTypeOfExpression(expression)) {
    const keys = keysInside(expression.expression, aliases);
    return keys.size > 0 ? { keys, missingValue: "undefined" } : undefined;
  }
  const directKey = envKey(expression);
  if (directKey) return { keys: new Set([directKey]), missingValue: undefined };
  if (ts.isIdentifier(expression)) {
    const keys = aliases.get(expression.text);
    if (keys?.size) return { keys: new Set(keys), missingValue: undefined };
  }
  return undefined;
}

function staticComparisonValue(node: ts.Expression): { known: boolean; value?: string | number | boolean | null } {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression) && expression.text === "undefined") return { known: true, value: undefined };
  if (ts.isVoidExpression(expression)) return { known: true, value: undefined };
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { known: true, value: null };
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { known: true, value: true };
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { known: true, value: false };
  if (ts.isStringLiteralLike(expression)) return { known: true, value: expression.text };
  if (ts.isNumericLiteral(expression)) return { known: true, value: Number(expression.text) };
  return { known: false };
}

function equalityWhenMissing(
  operand: ConditionOperand,
  other: ts.Expression,
  operator: ts.SyntaxKind,
): boolean | undefined {
  const compared = staticComparisonValue(other);
  if (!compared.known) return undefined;
  const strict = operator === ts.SyntaxKind.EqualsEqualsEqualsToken
    || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const equal = strict
    ? operand.missingValue === compared.value
    : operand.missingValue === compared.value
      || ((operand.missingValue === undefined || operand.missingValue === null)
        && (compared.value === undefined || compared.value === null));
  return operator === ts.SyntaxKind.EqualsEqualsToken
      || operator === ts.SyntaxKind.EqualsEqualsEqualsToken
    ? equal
    : !equal;
}

function conditionWhenEnvMissing(
  node: ts.Expression,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
): MissingEnvCondition | undefined {
  if (ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node)) {
    return conditionWhenEnvMissing(node.expression, aliases);
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const nested = conditionWhenEnvMissing(node.operand, aliases);
    return nested ? { keys: nested.keys, whenMissing: !nested.whenMissing } : undefined;
  }
  if (ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "Boolean"
    && node.arguments.length === 1) {
    return conditionWhenEnvMissing(node.arguments[0], aliases);
  }

  if (ts.isBinaryExpression(node)
    && [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(node.operatorToken.kind)) {
    const left = conditionOperand(node.left, aliases);
    const right = conditionOperand(node.right, aliases);
    if (left && !right) {
      const whenMissing = equalityWhenMissing(left, node.right, node.operatorToken.kind);
      if (whenMissing !== undefined) return { keys: left.keys, whenMissing };
    }
    if (right && !left) {
      const whenMissing = equalityWhenMissing(right, node.left, node.operatorToken.kind);
      if (whenMissing !== undefined) return { keys: right.keys, whenMissing };
    }
  }

  const directKey = envKey(node);
  if (directKey) return { keys: new Set([directKey]), whenMissing: false };
  if (ts.isIdentifier(node)) {
    const keys = aliases.get(node.text);
    if (keys?.size) return { keys: new Set(keys), whenMissing: false };
  }

  return undefined;
}

function modifierCondition(call: ts.CallExpression): {
  method: "skipIf" | "runIf";
  condition: ts.Expression;
} | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)
    || !["skipIf", "runIf"].includes(call.expression.name.text)
    || !call.arguments[0]) return undefined;
  return {
    method: call.expression.name.text as "skipIf" | "runIf",
    condition: call.arguments[0],
  };
}

function skipsWhenMissing(
  method: "skipIf" | "runIf",
  condition: ts.Expression,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
): MissingEnvCondition | undefined {
  const missing = conditionWhenEnvMissing(condition, aliases);
  if (!missing) return undefined;
  const skips = method === "skipIf" ? missing.whenMissing : !missing.whenMissing;
  return skips ? missing : undefined;
}

function missingSkipSelectors(
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const selectors = new Map<string, Set<string>>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isConditionalExpression(unwrapExpression(node.initializer))) {
      const conditional = unwrapExpression(node.initializer) as ts.ConditionalExpression;
      const missing = conditionWhenEnvMissing(conditional.condition, aliases);
      if (missing) {
        const selected = missing.whenMissing ? conditional.whenTrue : conditional.whenFalse;
        if (containsSkip(selected)) selectors.set(node.name.text, new Set(missing.keys));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return selectors;
}

function protectedEnvRegions(
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
  selectors: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, ts.Node[]> {
  const regions = new Map<string, ts.Node[]>();
  const protect = (keys: ReadonlySet<string>, node: ts.Node | undefined): void => {
    if (!node) return;
    for (const key of keys) {
      const existing = regions.get(key) ?? [];
      existing.push(node);
      regions.set(key, existing);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node)) {
      const missing = conditionWhenEnvMissing(node.condition, aliases);
      if (missing) protect(missing.keys, missing.whenMissing ? node.whenFalse : node.whenTrue);
    }
    if (ts.isIfStatement(node)) {
      const missing = conditionWhenEnvMissing(node.expression, aliases);
      if (missing) protect(missing.keys, missing.whenMissing ? node.elseStatement : node.thenStatement);
    }
    if (ts.isCallExpression(node) && ts.isCallExpression(node.expression)) {
      const modifier = modifierCondition(node.expression);
      if (modifier) {
        const missing = skipsWhenMissing(modifier.method, modifier.condition, aliases);
        if (missing) node.arguments.forEach((argument) => protect(missing.keys, argument));
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const keys = selectors.get(node.expression.text);
      if (keys) node.arguments.forEach((argument) => protect(keys, argument));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return regions;
}

function nodeInside(node: ts.Node, container: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

function conditionUseSafety(
  node: ts.Node,
  key: string,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
): boolean | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isConditionalExpression(current) && nodeInside(node, current.condition)) {
      const missing = conditionWhenEnvMissing(current.condition, aliases);
      if (!missing?.keys.has(key)) continue;
      const missingBranch = missing.whenMissing ? current.whenTrue : current.whenFalse;
      if (containsSkip(current.whenTrue) || containsSkip(current.whenFalse)) return containsSkip(missingBranch);
      return !explicitlyFails(missingBranch);
    }
    if (ts.isIfStatement(current) && nodeInside(node, current.expression)) {
      const missing = conditionWhenEnvMissing(current.expression, aliases);
      if (!missing?.keys.has(key)) continue;
      const missingBranch = missing.whenMissing ? current.thenStatement : current.elseStatement;
      const otherBranch = missing.whenMissing ? current.elseStatement : current.thenStatement;
      if ((missingBranch && containsSkip(missingBranch)) || (otherBranch && containsSkip(otherBranch))) {
        return !!missingBranch && containsSkip(missingBranch);
      }
      return !missingBranch || !explicitlyFails(missingBranch);
    }
    if (ts.isCallExpression(current)) {
      const modifier = modifierCondition(current);
      if (modifier && nodeInside(node, modifier.condition)) {
        const missing = conditionWhenEnvMissing(modifier.condition, aliases);
        if (!missing?.keys.has(key)) continue;
        return Boolean(skipsWhenMissing(modifier.method, modifier.condition, aliases));
      }
    }
  }
  return undefined;
}

function isDefinitionOrTransparentAliasUse(node: ts.Node): boolean {
  if (ts.isBindingElement(node)) return true;
  if (ts.isIdentifier(node)) {
    if ((ts.isVariableDeclaration(node.parent) || ts.isBindingElement(node.parent))
      && node.parent.name === node) return true;
  }
  let current = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent))) {
    current = current.parent;
  }
  return !!current.parent
    && ts.isVariableDeclaration(current.parent)
    && current.parent.initializer === current;
}

function declaredAliasName(node: ts.Node): string | undefined {
  if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) return node.name.text;
  let current = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent))) {
    current = current.parent;
  }
  return current.parent
      && ts.isVariableDeclaration(current.parent)
      && current.parent.initializer === current
      && ts.isIdentifier(current.parent.name)
    ? current.parent.name.text
    : undefined;
}

function isSafeFallbackUse(node: ts.Node): boolean {
  let current = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent))) {
    current = current.parent;
  }
  if (!current.parent
    || !ts.isBinaryExpression(current.parent)
    || current.parent.left !== current
    || ![ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
      .includes(current.parent.operatorToken.kind)
    || explicitlyFails(current.parent.right)) return false;
  return isVariableInitializerExpression(current.parent);
}

function isVariableInitializerExpression(node: ts.Expression): boolean {
  let current: ts.Node = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent))) {
    current = current.parent;
  }
  return !!current.parent
    && ts.isVariableDeclaration(current.parent)
    && current.parent.initializer === current;
}

function totalizedAliasNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      const totalized = ts.isTypeOfExpression(initializer)
        || (ts.isPrefixUnaryExpression(initializer)
          && initializer.operator === ts.SyntaxKind.ExclamationToken)
        || (ts.isCallExpression(initializer)
          && ts.isIdentifier(initializer.expression)
          && initializer.expression.text === "Boolean")
        || (ts.isBinaryExpression(initializer)
          && ([
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ].includes(initializer.operatorToken.kind)
            || ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
              .includes(initializer.operatorToken.kind) && !explicitlyFails(initializer.right))));
      if (totalized) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function isTotalizingUse(node: ts.Node, totalizedAliases: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)
    && totalizedAliases.has(node.text)
    && ts.isTypeOfExpression(node.parent)
    && node.parent.expression === node) return true;

  let current = node;
  while (current.parent && (ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent))) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) return false;
  if (ts.isTypeOfExpression(parent) && parent.expression === current) {
    return isVariableInitializerExpression(parent);
  }
  if (ts.isPrefixUnaryExpression(parent)
    && parent.operand === current
    && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return isVariableInitializerExpression(parent);
  }
  if (ts.isCallExpression(parent)
    && ts.isIdentifier(parent.expression)
    && parent.expression.text === "Boolean"
    && parent.arguments[0] === current) {
    return isVariableInitializerExpression(parent);
  }
  return ts.isBinaryExpression(parent)
    && (parent.left === current || parent.right === current)
    && [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(parent.operatorToken.kind)
    && isVariableInitializerExpression(parent);
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  return true;
}

function environmentUseIsSafe(
  node: ts.Node,
  key: string,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
  selectors: ReadonlyMap<string, ReadonlySet<string>>,
  regions: ReadonlyMap<string, readonly ts.Node[]>,
  totalizedAliases: ReadonlySet<string>,
): boolean {
  if (isDefinitionOrTransparentAliasUse(node)) return true;
  if ((regions.get(key) ?? []).some((region) => nodeInside(node, region))) return true;
  const conditionSafety = conditionUseSafety(node, key, aliases);
  if (conditionSafety !== undefined) return conditionSafety;
  if (isSafeFallbackUse(node) || isTotalizingUse(node, totalizedAliases)) return true;
  return ts.isIdentifier(node)
    && ts.isCallExpression(node.parent)
    && node.parent.expression === node
    && selectors.get(node.text)?.has(key) === true;
}

export function environmentKeysWrittenBy(source: string, file = "fixture.ts"): Set<string> {
  return new Set(
    envReferences(sourceFileFor(source, file))
      .filter(({ write, key }) => write && key !== "<dynamic>")
      .map(({ key }) => key),
  );
}

function semanticEnvironmentViolations(
  sourceFile: ts.SourceFile,
  file: string,
  testOwnedEnvKeys: ReadonlySet<string>,
): PurityViolation[] {
  const references = envReferences(sourceFile);
  const mutated = new Set(references.filter(({ write }) => write).map(({ key }) => key));
  const aliases = envAliases(sourceFile);
  const totalizedAliases = totalizedAliasNames(sourceFile);
  const selectors = missingSkipSelectors(sourceFile, aliases);
  const regions = protectedEnvRegions(sourceFile, aliases, selectors);
  const unsafeKeys = new Set<string>();
  const consumedAliases = new Set<string>();
  const violations: PurityViolation[] = [];

  for (const reference of references) {
    if (reference.write
      || mutated.has(reference.key)
      || testOwnedEnvKeys.has(reference.key)) continue;
    if (!environmentUseIsSafe(
      reference.node,
      reference.key,
      aliases,
      selectors,
      regions,
      totalizedAliases,
    )) {
      unsafeKeys.add(reference.key);
    }
  }

  const visitAliases = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      if (!isDefinitionOrTransparentAliasUse(node)) consumedAliases.add(node.text);
      for (const key of aliases.get(node.text) ?? []) {
        if (mutated.has(key) || testOwnedEnvKeys.has(key)) continue;
        if (!environmentUseIsSafe(node, key, aliases, selectors, regions, totalizedAliases)) {
          unsafeKeys.add(key);
        }
      }
    }
    ts.forEachChild(node, visitAliases);
  };
  visitAliases(sourceFile);

  for (const reference of references) {
    if (reference.write || mutated.has(reference.key) || testOwnedEnvKeys.has(reference.key)) continue;
    const alias = declaredAliasName(reference.node);
    if (alias && !consumedAliases.has(alias)) unsafeKeys.add(reference.key);
  }

  for (const key of unsafeKeys) {
    const reference = references.find((candidate) => !candidate.write && candidate.key === key);
    if (!reference) continue;

    const line = lineFor(sourceFile, reference.node);
    violations.push({
      file,
      line,
      rule: "required-env-without-skip",
      description: `environment variable ${key} is externally required; missing input must skip instead of fail`,
    });
    if (key === "HOME" || key === "USERPROFILE") {
      violations.push({
        file,
        line,
        rule: "user-home-state",
        description: "direct access to machine user-home state",
      });
    }
  }
  return violations;
}

function semanticPathViolations(sourceFile: ts.SourceFile, file: string): PurityViolation[] {
  const violations: PurityViolation[] = [];
  const fileDirectory = posix.dirname(normalizedFile(file));
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const candidate = node.text.replaceAll("\\", "/");
      const segments = candidate.split("/");
      if (candidate.includes("/") && segments.includes("node_modules")) {
        violations.push({
          file,
          line: lineFor(sourceFile, node),
          rule: "direct-node-modules",
          description: "direct path into node_modules instead of a declared package dependency",
        });
      }
      if (candidate.startsWith("../")) {
        const target = posix.normalize(posix.join(fileDirectory, candidate));
        if (target === ".." || target.startsWith("../")) {
          violations.push({
            file,
            line: lineFor(sourceFile, node),
            rule: "parent-traversal",
            description: "relative path escapes the repository",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

type StaticPathValue = string | string[];

const FILESYSTEM_PATH_READS = new Set([
  "access", "accessSync", "createReadStream", "existsSync", "lstat", "lstatSync",
  "open", "openSync", "readFile", "readFileSync", "readdir", "readdirSync", "realpath",
  "realpathSync", "stat", "statSync",
]);

interface StaticPathEvaluator {
  evaluate(expression: ts.Expression): StaticPathValue | undefined;
}

interface StaticPathBinding {
  initializer?: ts.Expression;
}

function lexicalPathScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isSourceFile(current)
      || ts.isBlock(current)
      || ts.isCaseBlock(current)
      || ts.isModuleBlock(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

/** Resolve const values by declaration identity and lexical scope. Identifier
 * spelling alone is insufficient: an inner binding must shadow an outer one in
 * both directions, including when the inner initializer is not foldable. */
function staticPathEvaluator(sourceFile: ts.SourceFile): StaticPathEvaluator {
  const declarations = new Map<ts.Node, Map<string, StaticPathBinding>>();
  const values = new Map<StaticPathBinding, StaticPathValue | undefined>();
  const evaluated = new Set<StaticPathBinding>();
  const evaluating = new Set<StaticPathBinding>();
  const register = (scope: ts.Node, name: string, binding: StaticPathBinding): void => {
    const scoped = declarations.get(scope) ?? new Map<string, StaticPathBinding>();
    // Duplicate lexical declarations are invalid TypeScript. Retaining the
    // first keeps malformed input fail-closed without inventing a binding.
    if (!scoped.has(name)) scoped.set(name, binding);
    declarations.set(scope, scoped);
  };
  const registerBindingName = (
    scope: ts.Node,
    name: ts.BindingName,
    initializer?: ts.Expression,
    allowNestedInitializers = true,
  ): void => {
    if (ts.isIdentifier(name)) {
      register(scope, name.text, { initializer });
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      registerBindingName(
        scope,
        element.name,
        allowNestedInitializers ? element.initializer : undefined,
        allowNestedInitializers,
      );
    }
  };
  const mutableVariableScope = (node: ts.VariableDeclaration): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current;
      current = current.parent;
    }
    return sourceFile;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
      const immutable = (node.parent.flags & ts.NodeFlags.Const) !== 0;
      const blockScoped = (node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0;
      registerBindingName(
        blockScoped ? lexicalPathScope(node) : mutableVariableScope(node),
        node.name,
        immutable && ts.isIdentifier(node.name) ? node.initializer : undefined,
        immutable,
      );
    }
    if (ts.isParameter(node)) {
      // Parameters live on the function-like node, which is encountered while
      // walking outward from both its body and its default initializers. An
      // initializer is optional: an unknown parameter still shadows an outer
      // foldable constant, while a default remains statically evaluable.
      registerBindingName(node.parent, node.name, node.initializer);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      registerBindingName(node.block, node.variableDeclaration.name, undefined, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const declarationFor = (identifier: ts.Identifier): StaticPathBinding | undefined => {
    let current: ts.Node | undefined = identifier;
    while (current) {
      const declaration = declarations.get(current)?.get(identifier.text);
      if (declaration) return declaration;
      current = current.parent;
    }
    return undefined;
  };

  const evaluateDeclaration = (binding: StaticPathBinding): StaticPathValue | undefined => {
    if (evaluated.has(binding)) return values.get(binding);
    if (evaluating.has(binding)) return undefined;
    if (!binding.initializer) {
      evaluated.add(binding);
      values.set(binding, undefined);
      return undefined;
    }
    evaluating.add(binding);
    const value = evaluate(binding.initializer);
    evaluating.delete(binding);
    evaluated.add(binding);
    values.set(binding, value);
    return value;
  };

  const evaluate = (raw: ts.Expression): StaticPathValue | undefined => {
    const node = unwrapExpression(raw);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) {
      const declaration = declarationFor(node);
      return declaration ? evaluateDeclaration(declaration) : undefined;
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const value = evaluate(span.expression);
        if (typeof value !== "string") return undefined;
        result += value + span.literal.text;
      }
      return result;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const items = node.elements.map((element) => (
        ts.isSpreadElement(element) ? undefined : evaluate(element as ts.Expression)
      ));
      return items.every((item): item is string => typeof item === "string") ? items : undefined;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      return typeof left === "string" && typeof right === "string" ? left + right : undefined;
    }
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "join") {
      const receiver = evaluate(node.expression.expression);
      const separator = node.arguments[0] ? evaluate(node.arguments[0]) : ",";
      return Array.isArray(receiver) && typeof separator === "string"
        ? receiver.join(separator)
        : undefined;
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (callee !== "join" && callee !== "resolve") return undefined;
      const parts = node.arguments.map((argument) => evaluate(argument));
      if (!parts.every((part): part is string => typeof part === "string")) return undefined;
      if (callee === "join") return posix.join(...parts.map((part) => part.replaceAll("\\", "/")));
      const firstAbsolute = parts.findIndex((part) => part.startsWith("/"));
      return firstAbsolute >= 0
        ? posix.resolve(...parts.slice(firstAbsolute).map((part) => part.replaceAll("\\", "/")))
        : undefined;
    }
    return undefined;
  };
  return { evaluate };
}

function semanticConstructedFilesystemPathViolations(
  sourceFile: ts.SourceFile,
  file: string,
): PurityViolation[] {
  const staticPaths = staticPathEvaluator(sourceFile);
  const fsBindings = new Map<string, string>();
  const fsNamespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || !["node:fs", "fs", "node:fs/promises", "fs/promises"].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) fsNamespaces.add(bindings.name.text);
    else for (const element of bindings.elements) {
      fsBindings.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }

  const evaluate = (raw: ts.Expression): string | undefined => {
    const node = unwrapExpression(raw);
    const value = staticPaths.evaluate(node);
    return typeof value === "string" ? value : undefined;
  };
  const violations: PurityViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const importedName = ts.isIdentifier(node.expression)
        ? fsBindings.get(node.expression.text)
        : ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && fsNamespaces.has(node.expression.expression.text)
          ? node.expression.name.text
          : undefined;
      if (importedName && FILESYSTEM_PATH_READS.has(importedName)) {
        const candidate = evaluate(node.arguments[0]);
        if (candidate !== undefined && !ts.isStringLiteralLike(unwrapExpression(node.arguments[0]))) {
          for (const rule of RULES) {
            if (!rule.patterns.some((pattern) => {
              pattern.lastIndex = 0;
              return pattern.test(candidate);
            })) continue;
            violations.push({ file, line: lineFor(sourceFile, node.arguments[0]), rule: rule.id, description: rule.description });
          }
          if (candidate.startsWith("../")) {
            const target = posix.normalize(posix.join(posix.dirname(normalizedFile(file)), candidate));
            if (target === ".." || target.startsWith("../")) {
              violations.push({ file, line: lineFor(sourceFile, node.arguments[0]), rule: "parent-traversal", description: "relative path escapes the repository" });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
      ? property.name.text
      : undefined;
    if (propertyName === name) return property.initializer;
  }
  return undefined;
}

function hasProperty(object: ts.ObjectLiteralExpression, name: string): boolean {
  return object.properties.some((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    return (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
      && property.name.text === name;
  });
}

function safeGitLsFiles(call: ts.CallExpression): boolean {
  const [command, argv, options] = call.arguments;
  if (!command || !ts.isStringLiteralLike(command) || command.text !== "git") return false;
  if (!argv || !ts.isArrayLiteralExpression(argv)) return false;
  const args = argv.elements
    .filter(ts.isStringLiteralLike)
    .map((argument) => argument.text);
  return args[0] === "ls-files"
    && args.includes("-z")
    && args.includes("--")
    && !!options
    && ts.isObjectLiteralExpression(options)
    && hasProperty(options, "cwd");
}

function safeProjectNodeProbe(call: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  const command = call.arguments[0];
  const options = call.arguments.at(-1);
  if (!command || command.getText(sourceFile).replaceAll(/\s/g, "") !== "process.execPath") return false;
  if (!options || !ts.isObjectLiteralExpression(options) || !hasProperty(options, "cwd")) return false;
  const env = propertyInitializer(options, "env");
  return !!env
    && ts.isObjectLiteralExpression(env)
    && hasProperty(env, "HOME")
    && hasProperty(env, "FC_HOME");
}

function semanticChildProcessViolations(sourceFile: ts.SourceFile, file: string): PurityViolation[] {
  const bindings = new Map<string, { importNode: ts.ImportDeclaration; used: boolean }>();
  const violations: PurityViolation[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && ["node:child_process", "child_process"].includes(statement.moduleSpecifier.text)) {
      violations.push({
        file,
        line: lineFor(sourceFile, statement),
        rule: "child-process",
        description: "host child-process dependency is not an isolated project-local probe",
      });
    }
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || !["node:child_process", "child_process"].includes(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, { importNode: statement, used: false });
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, { importNode: statement, used: false });
    } else {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) {
          bindings.set(element.name.text, { importNode: statement, used: false });
        }
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const moduleArgument = node.arguments[0];
      const dynamicallyLoadsChildProcess = !!moduleArgument
        && ts.isStringLiteralLike(moduleArgument)
        && ["node:child_process", "child_process"].includes(moduleArgument.text)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"));
      if (dynamicallyLoadsChildProcess) {
        violations.push({
          file,
          line: lineFor(sourceFile, node),
          rule: "child-process",
          description: "host child-process dependency is not an isolated project-local probe",
        });
      }
      const bindingName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
          ? node.expression.expression.text
          : undefined;
      const binding = bindingName ? bindings.get(bindingName) : undefined;
      if (binding) {
        binding.used = true;
        if (!safeGitLsFiles(node) && !safeProjectNodeProbe(node, sourceFile)) {
          violations.push({
            file,
            line: lineFor(sourceFile, node),
            rule: "child-process",
            description: "host child-process dependency is not an isolated project-local probe",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const binding of bindings.values()) {
    if (!binding.used) {
      violations.push({
        file,
        line: lineFor(sourceFile, binding.importNode),
        rule: "child-process",
        description: "host child-process dependency is not an isolated project-local probe",
      });
    }
  }
  return violations;
}

export function maskComments(source: string): string {
  const masked = source.split("");
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia
      && token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) continue;

    for (let index = scanner.getTokenPos(); index < scanner.getTextPos(); index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  }

  return masked.join("");
}

export function scanSource(
  source: string,
  file: string,
  options: ScanOptions = {},
): PurityViolation[] {
  const normalized = normalizedFile(file);
  const violations: PurityViolation[] = [];
  const lines = maskComments(source).split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (!rule.patterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(line);
      })) continue;

      violations.push({
        file: normalized,
        line: index + 1,
        rule: rule.id,
        description: rule.description,
      });
    }
  });

  const sourceFile = sourceFileFor(source, normalized);
  violations.push(
    ...semanticPathViolations(sourceFile, normalized),
    ...semanticConstructedFilesystemPathViolations(sourceFile, normalized),
    ...semanticEnvironmentViolations(sourceFile, normalized, options.testOwnedEnvKeys ?? new Set()),
    ...semanticChildProcessViolations(sourceFile, normalized),
  );

  const unique = new Map<string, PurityViolation>();
  for (const violation of violations) {
    unique.set(`${violation.file}:${violation.line}:${violation.rule}`, violation);
  }
  return [...unique.values()].sort((left, right) => (
    left.file.localeCompare(right.file)
      || left.line - right.line
      || left.rule.localeCompare(right.rule)
  ));
}

export function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    })
    .sort();
}

export function scanTree(
  root: string,
  displayRoot = root,
  options: ScanOptions = {},
): PurityViolation[] {
  return sourceFiles(root).flatMap((file) => (
    scanSource(readFileSync(file, "utf-8"), relative(displayRoot, file), options)
  ));
}

export function scanProjectTests(
  projectRoot: string,
  options: ProjectScanOptions = {},
): PurityViolation[] {
  const specRoot = join(projectRoot, "spec");
  const unsupportedChecks = (root: string): PurityViolation[] => {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return entry.name === "__pycache__" ? [] : unsupportedChecks(path);
      const testLike = /(?:^test_.*|\.(?:test|spec))\.[^.]+$/i.test(entry.name);
      if (!entry.isFile() || !testLike || SOURCE_EXTENSIONS.has(extname(entry.name))) return [];
      return [{
        file: normalizedFile(relative(projectRoot, path)),
        line: 1,
        rule: "uncollected-check",
        description: "test-shaped file is not supported by the configured TypeScript collector",
      }];
    });
  };
  return sourceFiles(specRoot).flatMap((file) => (
    scanSource(readFileSync(file, "utf-8"), relative(projectRoot, file), options)
  )).concat(unsupportedChecks(specRoot));
}

export function formatViolations(violations: PurityViolation[]): string {
  return violations
    .map(({ file, line, rule, description }) => `${file}:${line} [${rule}] ${description}`)
    .join("\n");
}
