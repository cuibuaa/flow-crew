import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ProjectValidationBaseline,
  ValidationCommand,
  ValidationCommandResult,
  ValidationGateCriterion,
  ValidationRole,
} from './project-validation.js';
import { fcGlobalDir } from './store.js';

const VALIDATION_ROLES = new Set<ValidationRole>(['build', 'test', 'lint']);
const RESULT_STATES = new Set<ValidationCommandResult['state']>([
  'passed', 'failed', 'launch_error', 'not_configured', 'unresolved',
]);
const FAILURE_IDENTITIES = new Set<ValidationCommandResult['failureIdentity']>(['known', 'unknown', 'none']);
const GATE_RULES = new Set<ValidationGateCriterion['rule']>([
  'must_remain_green', 'no_regression_from_baseline', 'baseline_unresolved', 'not_configured',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function role(value: unknown): value is ValidationRole {
  return typeof value === 'string' && VALIDATION_ROLES.has(value as ValidationRole);
}

function sameResolvedPath(value: unknown, expected: string): value is string {
  return typeof value === 'string' && value.length > 0 && resolve(value) === expected;
}

function validCommand(value: unknown): value is ValidationCommand {
  const item = record(value);
  return Boolean(item
    && role(item.role)
    && typeof item.command === 'string'
    && item.command.length > 0
    && stringArray(item.args)
    && typeof item.display === 'string'
    && item.display.length > 0);
}

function validResult(value: unknown): value is ValidationCommandResult {
  const item = record(value);
  return Boolean(item
    && role(item.role)
    && typeof item.state === 'string'
    && RESULT_STATES.has(item.state as ValidationCommandResult['state'])
    && typeof item.durationMs === 'number'
    && Number.isFinite(item.durationMs)
    && typeof item.output === 'string'
    && stringArray(item.failureIdentifiers)
    && typeof item.failureIdentity === 'string'
    && FAILURE_IDENTITIES.has(item.failureIdentity as ValidationCommandResult['failureIdentity'])
    && (item.failureCount === undefined
      || (Number.isSafeInteger(item.failureCount) && (item.failureCount as number) >= 0))
    && (item.exitCode === undefined || Number.isInteger(item.exitCode))
    && (item.reason === undefined || typeof item.reason === 'string'));
}

function validCriterion(value: unknown): value is ValidationGateCriterion {
  const item = record(value);
  return Boolean(item
    && role(item.role)
    && typeof item.rule === 'string'
    && GATE_RULES.has(item.rule as ValidationGateCriterion['rule'])
    && stringArray(item.baselineFailureIdentifiers)
    && typeof item.description === 'string'
    && (item.baselineFailureCount === undefined
      || (Number.isSafeInteger(item.baselineFailureCount) && (item.baselineFailureCount as number) >= 0)));
}

function validBaseline(value: unknown, canonicalTarget: string): value is ProjectValidationBaseline {
  const baseline = record(value);
  const discovery = record(baseline?.discovery);
  if (!baseline || baseline.version !== 1 || !sameResolvedPath(baseline.projectDir, canonicalTarget)) return false;
  if (!discovery
      || !['configured', 'partial', 'unknown'].includes(String(discovery.state))
      || typeof discovery.configPath !== 'string'
      || !Array.isArray(discovery.commands)
      || !discovery.commands.every(validCommand)
      || !Array.isArray(discovery.missingRoles)
      || !discovery.missingRoles.every(role)) return false;
  return Array.isArray(baseline.results)
    && baseline.results.every(validResult)
    && Array.isArray(baseline.gateCriteria)
    && baseline.gateCriteria.every(validCriterion);
}

/** SHA-256 identity of the exact admitted brief bytes. */
export function shipSetupBriefDigest(brief: string): string {
  return createHash('sha256').update(brief, 'utf8').digest('hex');
}

/** Content-addressed FC-global path for one canonical target and measured brief. */
export function shipSetupReadyRecordPath(
  canonicalTargetDir: string,
  briefDigest: string,
  globalRoot = fcGlobalDir(),
): string {
  if (!/^[a-f0-9]{64}$/.test(briefDigest)) throw new Error('brief digest must be a lowercase SHA-256');
  const identity = createHash('sha256')
    .update(resolve(canonicalTargetDir))
    .update('\0')
    .update(briefDigest)
    .digest('hex');
  return join(resolve(globalRoot), 'ship-setups', `${identity}.json`);
}

/**
 * Read the one ship-setup baseline bound to the canonical target and exact brief.
 * Every read/parse/identity/shape failure is an unknown baseline, never a guessed
 * nearby record and never a synthesized green result.
 */
export function readShipSetupReadyValidationBaseline(
  targetDir: string,
  exactBrief: string,
  globalRoot = fcGlobalDir(),
): ProjectValidationBaseline | undefined {
  try {
    const canonicalTarget = realpathSync.native(resolve(targetDir));
    const briefDigest = shipSetupBriefDigest(exactBrief);
    const expectedPath = shipSetupReadyRecordPath(canonicalTarget, briefDigest, globalRoot);
    const parsed = record(JSON.parse(readFileSync(expectedPath, 'utf-8')) as unknown);
    if (!parsed
        || parsed.version !== 1
        || parsed.state !== 'ready'
        || parsed.ready !== true
        || parsed.briefDigest !== briefDigest
        || !sameResolvedPath(parsed.targetCanonicalDir, canonicalTarget)
        || !sameResolvedPath(parsed.readyRecordPath, expectedPath)
        || !validBaseline(parsed.validationBaseline, canonicalTarget)) return undefined;
    return parsed.validationBaseline;
  } catch {
    return undefined;
  }
}
