// Condition evaluation module
import pino from 'pino';
import { readStageStatus } from './store.js';

const log = pino({ name: 'condition' });

const OPS = ['>=', '<=', '!=', '==', '>', '<'] as const;

interface Parsed {
  stageId: string;
  field: string;
  op: typeof OPS[number];
  value: string | number | boolean;
}

/**
 * Parses a condition expression like `stage.field == value` into its components.
 *
 * @param expr - The condition string to parse (e.g. `"build.status == success"`).
 * @returns A {@link Parsed} object containing the extracted `stageId`, `field`, `op`, and `value`.
 * @throws When no supported operator is found in the expression.
 * @throws When the left side of the operator does not contain a dot-separated stage and field.
 */
export function parseCondition(expr: string): Parsed {
  // Find operator outside of quoted strings
  for (const op of OPS) {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i <= expr.length - op.length; i++) {
      if (expr[i] === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (expr[i] === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (inSingle || inDouble) continue;
      if (expr.slice(i, i + op.length) === op) {
        const left = expr.slice(0, i).trim();
        const right = expr.slice(i + op.length).trim();
        const dotIdx = left.indexOf('.');
        if (dotIdx === -1) throw new Error(`Invalid condition left side: ${left}`);
        const stageId = left.slice(0, dotIdx);
        const field = left.slice(dotIdx + 1);
        const unquoted = right.replace(/^['"]|['"]$/g, '');
        let value: string | number | boolean;
        if (right.startsWith("'") || right.startsWith('"')) {
          value = unquoted;
        } else if (unquoted === 'true') {
          value = true;
        } else if (unquoted === 'false') {
          value = false;
        } else {
          const num = Number(unquoted);
          value = Number.isNaN(num) && unquoted !== 'NaN' ? unquoted : num;
        }
        return { stageId, field, op, value };
      }
    }
  }
  throw new Error(`No operator found in condition: ${expr}`);
}

function compare(actual: unknown, op: typeof OPS[number], expected: string | number | boolean): boolean {
  if (actual === undefined || actual === null) return false;
  switch (op) {
    case '==': return String(actual) === String(expected);
    case '!=': return String(actual) !== String(expected);
    case '>':  return Number(actual) > Number(expected);
    case '<':  return Number(actual) < Number(expected);
    case '>=': return Number(actual) >= Number(expected);
    case '<=': return Number(actual) <= Number(expected);
    default: return false;
  }
}

/**
 * Evaluates a condition expression against stored stage status, returning true if the condition is met.
 *
 * @param expr - The condition string to evaluate (e.g. `"build.status == success"`).
 * @param projectDir - Absolute path to the project directory used to locate stage status files.
 * @param runId - The identifier of the current run whose stage statuses are read.
 * @returns `true` if the condition is satisfied, `false` otherwise (including on parse/evaluation errors).
 */
export function evaluateCondition(expr: string, projectDir: string, runId: string): boolean {
  log.debug({ expr }, 'evaluating condition');
  try {
    const { stageId, field, op, value } = parseCondition(expr);
    const status = readStageStatus(projectDir, runId, stageId);
    const actual = (status as unknown as Record<string, unknown>)[field];
    return compare(actual, op, value);
  } catch (err) {
    log.warn({ expr, err }, 'condition evaluation failed');
    return false;
  }
}
