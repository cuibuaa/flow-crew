import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fcGlobalDir,
  readArchivedRunState,
  runDir,
  RUN_STATUS,
  setFcGlobalDir,
  type StoreState,
  UnknownRunStatusError,
  writeRunState,
} from '../src/store.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOT = join(PROJECT_ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

function isRunStatusMember(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'RUN_STATUS';
}

interface PartialSetDecision {
  file: string;
  line: number;
  name: string;
}

function partialRunStatusSetDecisions(filePath: string): PartialSetDecision[] {
  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const partialSets = new Map<string, ts.VariableDeclaration>();
  const usedSets = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isNewExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'Set') {
      const values = node.initializer.arguments?.[0];
      if (values && ts.isArrayLiteralExpression(values)
        && values.elements.some(isRunStatusMember)) {
        partialSets.set(node.name.text, node);
      }
    }

    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'has'
      && ts.isIdentifier(node.expression.expression)) {
      usedSets.add(node.expression.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return [...partialSets.entries()].flatMap(([name, node]) => {
    if (!usedSets.has(name)) return [];
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return [{
      file: relative(PROJECT_ROOT, filePath).replaceAll('\\', '/'),
      line: line + 1,
      name,
    }];
  });
}

describe('verification-stage run-status totality probes', () => {
  it('has no partial RUN_STATUS Set decision that can silently absorb a new state', () => {
    const decisions = sourceFiles(SOURCE_ROOT).flatMap(partialRunStatusSetDecisions);
    expect(
      decisions,
      'A RUN_STATUS subset used with Set.has assigns every omitted/new state an implicit false consequence; use an exhaustive typed decision instead',
    ).toEqual([]);
  });
});

describe('verification-stage malformed archive boundary probe', () => {
  const previousStateDir = fcGlobalDir();
  const root = mkdtempSync(join(tmpdir(), 'flowcrew-totality-qa-'));
  const projectDir = join(root, 'project');
  const runId = 'synthetic-non-string-status';

  afterEach(() => {
    setFcGlobalDir(previousStateDir);
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves a non-string archived status and refuses to overwrite it', () => {
    setFcGlobalDir(join(root, 'state'));
    const path = join(runDir(projectDir, runId), 'run.json');
    mkdirSync(runDir(projectDir, runId), { recursive: true });
    writeFileSync(path, JSON.stringify({
      runId,
      workflowName: 'synthetic-malformed-archive',
      projectDir,
      status: { future: 'shape' },
      stages: {},
      startedAt: '2030-01-01T00:00:00.000Z',
    }));

    const archived = readArchivedRunState(projectDir, runId);
    expect(archived.status).toMatchObject({
      kind: 'unknown',
      raw: { future: 'shape' },
    });

    const proposed = {
      ...archived.state,
      status: RUN_STATUS.COMPLETE,
      completedAt: '2030-01-01T00:01:00.000Z',
    } as StoreState;
    expect(() => writeRunState(projectDir, runId, proposed)).toThrow(UnknownRunStatusError);
    expect(JSON.parse(readFileSync(path, 'utf8')).status).toEqual({ future: 'shape' });
  });
});
