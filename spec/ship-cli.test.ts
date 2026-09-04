import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { auditReportUsage, parseAuditReportArgs } from '../src/cli-audit-report.js';
import { createBriefAdmission, inspectBrief, verifyBriefAdmission } from '../src/brief-preflight.js';
import { landUsage, parseLandArgs } from '../src/cli-land.js';
import { parseShipSetupArgs, shipSetupUsage } from '../src/cli-ship-setup.js';
import { parseWatchArgs, watchUsage } from '../src/cli-watch.js';
import { projectBriefPreflightContext } from '../src/rehearse.js';

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

function lazyDispatchContracts(source: string): LazyDispatchContract[] {
  const cliFile = ts.createSourceFile('cli.ts', source, ts.ScriptTarget.Latest, true);
  const contracts: LazyDispatchContract[] = [];

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
      function findImport(part: ts.Node): void {
        if (
          importCall === undefined
          && ts.isCallExpression(part)
          && part.expression.kind === ts.SyntaxKind.ImportKeyword
          && part.arguments.length === 1
          && ts.isStringLiteral(part.arguments[0])
        ) {
          importCall = part;
        }
        ts.forEachChild(part, findImport);
      }
      findImport(node);

      const firstThen = importCall
        && ts.isPropertyAccessExpression(importCall.parent)
        && importCall.parent.name.text === 'then'
        && ts.isCallExpression(importCall.parent.parent)
        ? importCall.parent.parent
        : undefined;
      const importer = firstThen?.arguments[0];
      if (
        importCall
        && firstThen
        && importer
        && ts.isArrowFunction(importer)
        && importer.parameters.length === 1
        && ts.isObjectBindingPattern(importer.parameters[0].name)
      ) {
        const moduleSpecifier = (importCall.arguments[0] as ts.StringLiteral).text;
        const bindings = new Map<string, string>();
        for (const binding of importer.parameters[0].name.elements) {
          if (ts.isIdentifier(binding.name)) {
            bindings.set(
              binding.name.text,
              binding.propertyName?.getText(cliFile) ?? binding.name.text,
            );
          }
        }
        let localHandler = '';
        let handler = '';
        let invokesHandler = false;
        let propagatesExitCode = false;
        function inspectImporter(part: ts.Node): void {
          if (ts.isCallExpression(part) && ts.isIdentifier(part.expression) && bindings.has(part.expression.text)) {
            localHandler = part.expression.text;
            handler = bindings.get(localHandler)!;
            invokesHandler = true;
          }
          if (
            ts.isBinaryExpression(part)
            && part.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(part.left)
            && ts.isIdentifier(part.left.expression)
            && part.left.expression.text === 'process'
            && part.left.name.text === 'exitCode'
            && ts.isCallExpression(part.right)
            && ts.isIdentifier(part.right.expression)
            && bindings.has(part.right.expression.text)
          ) {
            propagatesExitCode = true;
          }
          ts.forEachChild(part, inspectImporter);
        }
        inspectImporter(importer.body);

        const resultThen = ts.isPropertyAccessExpression(firstThen.parent)
          && firstThen.parent.name.text === 'then'
          && ts.isCallExpression(firstThen.parent.parent)
          ? firstThen.parent.parent
          : undefined;
        const resultHandler = resultThen?.arguments[0];
        if (
          resultHandler
          && ts.isArrowFunction(resultHandler)
          && resultHandler.parameters.length === 1
          && ts.isIdentifier(resultHandler.parameters[0].name)
        ) {
          const resultName = resultHandler.parameters[0].name.text;
          function inspectResultHandler(part: ts.Node): void {
            if (
              ts.isBinaryExpression(part)
              && part.operatorToken.kind === ts.SyntaxKind.EqualsToken
              && ts.isPropertyAccessExpression(part.left)
              && ts.isIdentifier(part.left.expression)
              && part.left.expression.text === 'process'
              && part.left.name.text === 'exitCode'
              && ts.isIdentifier(part.right)
              && part.right.text === resultName
            ) {
              propagatesExitCode = true;
            }
            ts.forEachChild(part, inspectResultHandler);
          }
          inspectResultHandler(resultHandler.body);
        }
        contracts.push({
          command,
          module: moduleSpecifier,
          handler,
          invokesHandler,
          returnsExitCode: functionReturnsExitCode(moduleSpecifier, handler || localHandler),
          propagatesExitCode,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(cliFile);
  return contracts;
}

describe('autonomous launch CLI integration', () => {
  it('advertises setup, wrap-up, audit, and watch commands with pasteable examples', () => {
    expect(cliSource).toContain('ship-setup  Create a launch worktree, link declared inputs, and baseline validation');
    expect(cliSource).toContain('land      Audit terminal artifacts and every unique worktree item before safe removal');
    expect(cliSource).toContain('audit-report  Re-derive supported numeric and path-bearing claims from a terminal report');
    expect(cliSource).toContain('watch     Report edge-triggered stall judgements for live runs');
    expect(cliSource).toContain('flowcrew ship-setup --brief docs/task_brief.md --target ../task-worktree --base HEAD --branch task-work');
    expect(cliSource).toContain('flowcrew land --run <run-id>');
    expect(cliSource).toContain('flowcrew audit-report --report docs/final.md --run-dir <run-dir>');
    expect(cliSource).toContain('flowcrew watch --once');
  });

  it('dispatches scoped command modules lazily and propagates their returned exit codes', () => {
    const dispatches = lazyDispatchContracts(cliSource);
    expect(dispatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'ship-setup', module: './cli-ship-setup.js', handler: 'cmdShipSetup', invokesHandler: true }),
      expect.objectContaining({ command: 'land', module: './cli-land.js', handler: 'cmdLand', invokesHandler: true }),
      expect.objectContaining({ command: 'audit-report', module: './cli-audit-report.js', handler: 'cmdAuditReport', invokesHandler: true }),
      expect.objectContaining({ command: 'watch', module: './cli-watch.js', handler: 'cmdWatch', invokesHandler: true }),
    ]));
    expect(dispatches
      .filter(({ returnsExitCode }) => returnsExitCode)
      .filter(({ propagatesExitCode }) => !propagatesExitCode)
      .map(({ command }) => command)).toEqual([]);
    expect(cliSource).not.toMatch(/^import .*cli-(?:ship-setup|land|audit-report|watch)\.js/m);
  });

  it('keeps setup identity explicit and watch polling bounded at their public parsers', () => {
    expect(shipSetupUsage()).toContain('--brief <path> --target <path> --base <ref> --branch <name>');
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
    expect(() => parseWatchArgs(['watch', '--poll', '0'])).toThrow('between 1 and 3600 seconds');
  });

  it('keeps land fail-closed and audit-report bound to an explicit report and run', () => {
    expect(landUsage()).toContain('--run <run-id> [--remove] [--json]');
    expect(parseLandArgs(['land', '--run', 'run-123', '--remove'])).toMatchObject({
      run: 'run-123', remove: true,
    });
    expect(() => parseLandArgs(['land', '--remove'])).toThrow('--run is required');

    expect(auditReportUsage()).toContain('--report <path> --run-dir <path> [--json]');
    expect(auditReportUsage()).toContain('confirmed, contradicted, or not_checkable');
    expect(parseAuditReportArgs([
      'audit-report', '--report', 'docs/final.md', '--run-dir', '/tmp/run', '--json',
    ])).toMatchObject({ report: 'docs/final.md', runDir: '/tmp/run', json: true });
    expect(() => parseAuditReportArgs(['audit-report', '--report', 'docs/final.md']))
      .toThrow('--run-dir is required');
  });

  it('binds ignored-input acknowledgement to exact project facts without host probes in the spec', () => {
    const brief = [
      '# Inputs',
      'Use `private-data/prices.csv` and `private-data/metadata.json` as source evidence.',
    ].join('\n');
    const firstContext = projectBriefPreflightContext('/fixture/project', brief, (project, paths) => {
      expect(project).toBe('/fixture/project');
      expect(paths).toEqual(['private-data/metadata.json', 'private-data/prices.csv']);
      return ['private-data/prices.csv'];
    });
    const firstReport = inspectBrief(brief, firstContext);
    expect(firstReport.findings).toContainEqual(expect.objectContaining({
      code: 'gitignored_input_undeclared',
      message: expect.stringContaining('private-data/prices.csv'),
    }));
    const record = createBriefAdmission(firstReport, {
      kind: 'explicit', source: 'cli_current_input_flag', at: '2026-08-10T00:00:00.000Z',
    });

    expect(verifyBriefAdmission(brief, record, firstContext).status).toBe('valid');
    expect(verifyBriefAdmission(brief, record).status).toBe('valid');

    const expandedContext = projectBriefPreflightContext(
      '/fixture/project', brief, (_project, paths) => paths,
    );
    expect(verifyBriefAdmission(brief, record, expandedContext).status)
      .toBe('acknowledgement_missing');
  });
});
