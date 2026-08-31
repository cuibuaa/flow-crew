// Condition evaluation module
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStageStatus, runDir } from './store.js';
import { createLogger } from './logging.js';

const log = createLogger({ name: 'condition' });

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
  // Conditions are typed fact comparisons. In particular, a malformed gate
  // verdict containing `"pass": "true"` must not satisfy `pass == true`.
  if (typeof actual !== typeof expected) return false;
  switch (op) {
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    case '>': case '<': case '>=': case '<=': {
      // Numeric comparators: if either operand isn't a finite number, a Number()
      // coercion yields NaN and every comparison is silently false (a misleading
      // "condition unmet"). Bail explicitly so a non-numeric operand is an obvious
      // false rather than a NaN trap.
      const a = Number(actual); const b = Number(expected);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (op === '>') return a > b;
      if (op === '<') return a < b;
      if (op === '>=') return a >= b;
      return a <= b;
    }
    default: return false;
  }
}

function hasOwnField(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

/**
 * Resolve a condition fact from the producing stage's own evidence. Process
 * fields (status, retries, exitCode, and so on) live in status.json. Gate facts
 * such as pass, score, metric, and threshold live in verdict_<stageId>.json.
 * The stage-specific verdict is the only fallback; a shared or sibling verdict
 * must never supply a fact for this stage.
 */
function readConditionFact(
  projectDir: string,
  runId: string,
  stageId: string,
  field: string,
): unknown {
  // Framework-owned research policy facts are exposed through one reserved
  // pseudo-stage. This lets a terminal owner remain ineligible while the
  // campaign decision is `continue`, then run in the same iteration after the
  // settled gates produce `ship` or `stop_ceiling`.
  if (stageId === 'research') {
    const decisionPath = join(runDir(projectDir, runId), 'research_decision.json');
    if (!existsSync(decisionPath)) return undefined;
    const parsed = JSON.parse(readFileSync(decisionPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const decision = parsed as Record<string, unknown>;
    return hasOwnField(decision, field) ? decision[field] : undefined;
  }
  const status = readStageStatus(projectDir, runId, stageId) as unknown as Record<string, unknown>;
  if (hasOwnField(status, field)) return status[field];

  const verdictPath = join(runDir(projectDir, runId), `verdict_${stageId}.json`);
  const parsed = JSON.parse(readFileSync(verdictPath, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const verdict = parsed as Record<string, unknown>;
  return hasOwnField(verdict, field) ? verdict[field] : undefined;
}

/**
 * Evaluates a condition expression against the producing stage's stored facts,
 * returning true if the condition is met. Status fields take precedence; a
 * missing status field falls back to that stage's specific gate verdict.
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
    const actual = readConditionFact(projectDir, runId, stageId, field);
    return compare(actual, op, value);
  } catch (err) {
    log.warn({ expr, err }, 'condition evaluation failed');
    return false;
  }
}
