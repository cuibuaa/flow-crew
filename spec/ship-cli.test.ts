import './test-support/policy-runtime.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { commandUsage, parseCommandArgs } from '../src/cli-args.js';
import { landUsage, parseLandArgs } from '../src/cli-land.js';
import { parseShipSetupArgs, shipSetupUsage } from '../src/cli-ship-setup.js';
import { parseWatchArgs, watchUsage } from '../src/cli-watch.js';

const repositoryRoot = join(import.meta.dirname, '..');
const cliSource = readFileSync(join(repositoryRoot, 'src', 'cli.ts'), 'utf-8');

interface LazyDispatchContract {
  command: string;
  module: string;
  handler: string;
  invokesHandler: boolean;
  returnsExitCode: boolean;
  propagatesExitCode: boolean;
}

function lazyDispatchContracts(source: string): { contracts: LazyDispatchContract[]; unrecognized: string[] } {
  const cliFile = ts.createSourceFile('cli.ts', source, ts.ScriptTarget.Latest, true);
  const contracts: LazyDispatchContract[] = [];
  const unrecognized: string[] = [];

  function functionReturnsExitCode(moduleSpecifier: string, handler: string): boolean {
    const modulePath = join(
      repositoryRoot,
      'src',
      moduleSpecifier.replace(/^\.\//, '').replace(/\.js$/, '.ts'),
    );
    const moduleSource = readFileSync(modulePath, 'utf-8');
    const moduleFile = ts.createSourceFile(modulePath, moduleSource, ts.ScriptTarget.Latest, true);
    let returnsExitCode = false;
    function isExitCodeType(type: ts.TypeNode): boolean {
      return type.kind === ts.SyntaxKind.NumberKeyword
        || (
          ts.isTypeReferenceNode(type)
          && type.typeName.getText(moduleFile) === 'Promise'
          && type.typeArguments?.length === 1
          && type.typeArguments[0].kind === ts.SyntaxKind.NumberKeyword
        );
    }
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name?.text === handler && node.type) {
        returnsExitCode = isExitCodeType(node.type);
      }
      ts.forEachChild(node, visit);
    }
    visit(moduleFile);
    return returnsExitCode;
  }

  function visit(node: ts.Node): void {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      const command = node.expression.text;
      let importCall: ts.CallExpression | undefined;
      let importCount = 0;
      function findImport(part: ts.Node): void {
        if (
          ts.isCallExpression(part)
          && part.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          importCount += 1;
          importCall ??= part;
        }
        ts.forEachChild(part, findImport);
      }
      findImport(node);

      if (importCount > 1 || (importCall && (importCall.arguments.length !== 1 || !ts.isStringLiteral(importCall.arguments[0])))) {
        unrecognized.push(command);
      } else if (importCall) {
        const moduleSpecifier = (importCall.arguments[0] as ts.StringLiteral).text;
        let handler = '';
        let invokesHandler = false;
        let propagatesExitCode = false;
        function contains(root: ts.Node, target: ts.Node): boolean {
          if (root === target) return true;
          return ts.forEachChild(root, child => contains(child, target) ? true : undefined) ?? false;
        }
        function inspect(part: ts.Node): void {
          if (ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression)
            && contains(part.expression.expression, importCall!)) {
            handler = part.expression.name.text;
            invokesHandler = true;
            let parent: ts.Node = part.parent;
            while (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) parent = parent.parent;
            propagatesExitCode = ts.isBinaryExpression(parent)
              && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
              && parent.left.getText(cliFile) === 'process.exitCode';
          }
          ts.forEachChild(part, inspect);
        }
        inspect(node);
        if (!invokesHandler) unrecognized.push(command);
        else contracts.push({ command, module: moduleSpecifier, handler,
          invokesHandler, returnsExitCode: functionReturnsExitCode(moduleSpecifier, handler), propagatesExitCode });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(cliFile);
  return { contracts, unrecognized };
}

describe('autonomous launch CLI integration', () => {
  it('advertises setup, wrap-up, audit, and watch commands with usable argument syntax', () => {
    for (const name of ['ship-setup', 'land', 'audit-reality', 'watch']) {
      expect(commandUsage()).toContain(`Usage: flowcrew ${name}`);
    }
    for (const [name, args] of [
      ['ship-setup', ['--brief', 'docs/task_brief.md', '--target', '../task-worktree', '--base', 'HEAD', '--branch', 'task-work']],
      ['land', ['--run', 'run-123']],
      ['watch', ['--once']],
    ] as const) expect(() => parseCommandArgs(name, [...args])).not.toThrow();
  });

  it('dispatches scoped command modules lazily and propagates their returned exit codes', () => {
    const { contracts: dispatches, unrecognized } = lazyDispatchContracts(cliSource);
    expect(unrecognized, `Unrecognized lazy dispatch commands: ${unrecognized.join(', ')}`).toEqual([]);
    expect(dispatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'ship-setup', module: './cli-ship-setup.js', handler: 'cmdShipSetup', invokesHandler: true }),
      expect.objectContaining({ command: 'land', module: './cli-land.js', handler: 'cmdLand', invokesHandler: true }),
      expect.objectContaining({ command: 'watch', module: './cli-watch.js', handler: 'cmdWatch', invokesHandler: true }),
    ]));
    expect(dispatches
      .filter(({ returnsExitCode }) => returnsExitCode)
      .filter(({ propagatesExitCode }) => !propagatesExitCode)
      .map(({ command }) => command)).toEqual([]);
    expect(cliSource).not.toMatch(/^import .*cli-(?:ship-setup|land|audit-report|watch)\.js/m);
  });

  it('reports commands whose lazy dispatch shape is not recognized', () => {
    const source = `switch (command) {
      case 'changed-shape': {
        const module = await import('./cli-watch.js');
        await module.cmdWatch(args);
      }
      case 'dynamic-module':
        await (await import(modulePath)).cmdWatch(args);
      case 'multiple-imports':
        await (await import('./cli-watch.js')).cmdWatch(args);
        await import(modulePath);
    }`;
    expect(lazyDispatchContracts(source).unrecognized).toEqual(['changed-shape', 'dynamic-module', 'multiple-imports']);
  });

  it('keeps setup identity explicit and watch polling bounded at their public parsers', () => {
    for (const flag of ['brief', 'target', 'base', 'branch']) {
      expect(shipSetupUsage()).toContain(` --${flag} <value>`);
      expect(shipSetupUsage()).not.toContain(`[--${flag}`);
    }
    expect(() => parseShipSetupArgs(['ship-setup', '--brief', 'brief.md']))
      .toThrow('--target is required');
    expect(parseShipSetupArgs([
      'ship-setup',
      '--brief', 'brief.md',
      '--target', '../worktree',
      '--base', 'release',
      '--branch', 'result',
    ])).toMatchObject({ base: 'release', branch: 'result', target: '../worktree' });

    expect(watchUsage()).toContain('first-pass drift snapshot plus edge-triggered drift crossings');
    expect(parseWatchArgs(['watch', '--once', '--poll', '5'])).toMatchObject({ once: true, pollMs: 5_000 });
    expect(() => parseWatchArgs(['watch', '--poll', '0'])).toThrow(/positive.*Node timer range/);
  });

  it('keeps land fail-closed and bound to an explicit run', () => {
    expect(landUsage()).toContain(' --run <value>');
    expect(landUsage()).not.toContain('[--run');
    for (const flag of ['remove', 'json']) expect(landUsage()).toContain(`[--${flag}]`);
    expect(parseLandArgs(['land', '--run', 'run-123', '--remove'])).toMatchObject({
      run: 'run-123', remove: true,
    });
    expect(() => parseLandArgs(['land', '--remove'])).toThrow('--run is required');


  });

});
