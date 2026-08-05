import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  isAwaitingApprovalRunStatus,
  isPausedRunStatus,
  isRunMutationBlockedStatus,
  isRunningRunStatus,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  RUN_STATUS,
} from '../src/store.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOT = join(PROJECT_ROOT, 'src');
const STORE_PATH = join(SOURCE_ROOT, 'store.ts');
const RUN_STATUS_LITERALS = new Set<string>(Object.values(RUN_STATUS));

interface Violation {
  file: string;
  line: number;
  source: string;
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function isRunStatusLiteral(node: ts.Node | undefined): boolean {
  const value = stringLiteralValue(node);
  return value !== undefined && RUN_STATUS_LITERALS.has(value);
}

function scanSource(sourceText: string, filePath: string): Violation[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = sourceText.split(/\r?\n/);
  const offendingNodes: ts.Node[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const strictComparison = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (strictComparison && (isRunStatusLiteral(node.left) || isRunStatusLiteral(node.right))) {
        offendingNodes.push(node);
      }
    } else if (ts.isCaseClause(node) && isRunStatusLiteral(node.expression)) {
      offendingNodes.push(node);
    } else if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'includes'
    ) {
      const directLiteralArgument = node.arguments.some((argument) => isRunStatusLiteral(argument));
      const receiver = node.expression.expression;
      const handCopiedLiteralSet = ts.isArrayLiteralExpression(receiver)
        && receiver.elements.some((element) => isRunStatusLiteral(element));
      if (directLiteralArgument || handCopiedLiteralSet) offendingNodes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return offendingNodes.map((node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return {
      file: relative(PROJECT_ROOT, filePath).replaceAll('\\', '/'),
      line: line + 1,
      source: lines[line] ?? '',
    };
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

function scanProjectSources(): Violation[] {
  return sourceFiles(SOURCE_ROOT)
    .filter((filePath) => filePath !== STORE_PATH)
    .flatMap((filePath) => scanSource(readFileSync(filePath, 'utf-8'), filePath));
}

describe('central run-status semantics', () => {
  it('has no direct run-status literal branches outside store.ts', () => {
    const violations = scanProjectSources();
    if (violations.length > 0) {
      const diagnostics = violations
        .map(({ file, line, source }) => `${file}:${line}: ${source}`)
        .join('\n');
      throw new Error(`Direct run-status literals must use store.ts constants or guards:\n${diagnostics}`);
    }
  });

  it('ignores comments while detecting comparison, case, and includes branches', () => {
    const commentsOnly = [
      "// if (status === 'running') work();",
      "/* case 'failed': */",
      "// ['complete', 'failed'].includes(status)",
    ].join('\n');
    expect(scanSource(commentsOnly, join(SOURCE_ROOT, '__comments_fixture.ts'))).toEqual([]);

    const executable = [
      "declare const status: string; if ('running' === status) work();",
      "switch (status) { case 'failed': break; }",
      "['complete', 'failed'].includes(status);",
    ].join('\n');
    expect(scanSource(executable, join(SOURCE_ROOT, '__executable_fixture.ts'))).toHaveLength(3);
  });

  it('classifies every declared run status into exactly one lifecycle bucket', () => {
    for (const status of Object.values(RUN_STATUS)) {
      const buckets = [
        status === RUN_STATUS.PENDING,
        isRunningRunStatus(status),
        isAwaitingApprovalRunStatus(status),
        isPausedRunStatus(status),
        isTerminalRunStatus(status),
      ];
      expect(buckets.filter(Boolean), `lifecycle classification for ${status}`).toHaveLength(1);
    }
  });

  it('preserves success, pause, and dashboard mutation boundaries', () => {
    expect(isSuccessfulRunStatus(RUN_STATUS.CEILING_HIT)).toBe(true);
    expect(isSuccessfulRunStatus(RUN_STATUS.INCOMPLETE)).toBe(false);
    expect(isTerminalRunStatus(RUN_STATUS.PARKED)).toBe(false);
    expect(isRunningRunStatus(RUN_STATUS.PARKED)).toBe(false);
    expect([
      RUN_STATUS.RUNNING,
      RUN_STATUS.PARKED,
      RUN_STATUS.AWAITING_APPROVAL,
    ].every(isRunMutationBlockedStatus)).toBe(true);
    expect(isRunMutationBlockedStatus(RUN_STATUS.PENDING)).toBe(false);
    expect(isRunMutationBlockedStatus(RUN_STATUS.COMPLETE)).toBe(false);
  });
});
