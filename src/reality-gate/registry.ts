import ExecScriptExitZeroCheck from './checks/exec-script-exit-zero.js';
import FileExistsNonemptyCheck from './checks/file-exists-nonempty.js';
import JsonSchemaMatchCheck from './checks/json-schema-match.js';
import { REALITY_CHECK_TYPES, type RealityCheck, type RealityCheckType } from './types.js';

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

const CHECK_CLASSES: Record<RealityCheckType, RealityCheckClass> = {
  'exec-script-exit-zero': ExecScriptExitZeroCheck,
  'file-exists-nonempty': FileExistsNonemptyCheck,
  'json-schema-match': JsonSchemaMatchCheck,
};

/**
 * Importing this module eagerly loads every built-in handler. A long-lived
 * scheduler therefore never discovers runtime modules by walking a dist tree
 * that another process may be publishing.
 */
export const REALITY_CHECK_REGISTRY: readonly RegisteredRealityCheck[] = REALITY_CHECK_TYPES
  .map(type => {
    const Check = CHECK_CLASSES[type];
    return { type, check: new Check(), description: Check.meta?.description ?? '', params: Check.meta?.params ?? '' };
  })
  .sort((left, right) => left.type.localeCompare(right.type));

