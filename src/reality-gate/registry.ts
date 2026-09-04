import ExecScriptExitZeroCheck from './checks/exec-script-exit-zero.js';
import FileExistsNonemptyCheck from './checks/file-exists-nonempty.js';
import HttpReachabilityCheck from './checks/http-reachability.js';
import JsonSchemaMatchCheck from './checks/json-schema-match.js';
import StaticAstScanCheck from './checks/static-ast-scan.js';
import VarianceFloorCheck from './checks/variance-floor.js';
import type { RealityCheck } from './types.js';

interface RealityCheckClass {
  new(): RealityCheck;
  meta?: { description?: string; params?: string };
}

export interface RegisteredRealityCheck {
  type: string;
  check: RealityCheck;
  description: string;
  params: string;
}

const CHECK_CLASSES: ReadonlyArray<readonly [string, RealityCheckClass]> = [
  ['exec-script-exit-zero', ExecScriptExitZeroCheck],
  ['file-exists-nonempty', FileExistsNonemptyCheck],
  ['http-reachability', HttpReachabilityCheck],
  ['json-schema-match', JsonSchemaMatchCheck],
  ['static-ast-scan', StaticAstScanCheck],
  ['variance-floor', VarianceFloorCheck],
];

/**
 * Importing this module eagerly loads every built-in handler. A long-lived
 * scheduler therefore never discovers runtime modules by walking a dist tree
 * that another process may be publishing.
 */
export const REALITY_CHECK_REGISTRY: readonly RegisteredRealityCheck[] = CHECK_CLASSES
  .map(([type, Check]) => ({
    type,
    check: new Check(),
    description: Check.meta?.description ?? '',
    params: Check.meta?.params ?? '',
  }))
  .sort((left, right) => left.type.localeCompare(right.type));

