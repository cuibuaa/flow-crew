/** A declared, finite reporter fixture. IDs are data supplied by the test,
 * never extracted from logs. Pending tests are excluded from testsRun. */
export function validationReport(ids: string[], options: { complete?: boolean; passed?: number; file?: string } = {}): string {
  const passed = options.passed ?? 0;
  return JSON.stringify({ complete: options.complete ?? true, numTotalTests: ids.length + passed,
    numFailedTests: ids.length, numPassedTests: passed, testResults: [{ name: options.file ?? 'case.test',
      assertionResults: [...ids.map(fullName => ({ fullName, status: 'failed' })),
        ...Array.from({ length: passed }, (_, index) => ({ fullName: `passing ${index}`, status: 'passed' }))] }] });
}
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidationReport, ValidationRole } from '../../src/project-validation.js';

/** Literal fixture declarations, never command discovery from project files. */
export function declareValidation(projectDir: string, commands: Partial<Record<ValidationRole, { command: string; args: string[]; report?: ValidationReport }>>): void {
  mkdirSync(join(projectDir, 'config'), { recursive: true });
  writeFileSync(join(projectDir, 'config/validation.json'), JSON.stringify({ commands }));
}

