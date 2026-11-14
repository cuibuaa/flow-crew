import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ProjectValidationBaseline,
  ValidationCommand,
  ValidationCommandResult,
  ValidationRole,
} from './project-validation.js';
import { canonicalJson } from './canonical-json.js';
import type { BriefAdmissionRecord } from './brief-admission.js';
import { fcGlobalDir } from './store.js';

const VALIDATION_ROLES = new Set<ValidationRole>(['build', 'test', 'lint']);
const RESULT_STATES = new Set<string>([
  'passed', 'failed', 'unverified', 'launch_error', 'not_configured', 'unresolved', 'not_measured',
]);
const FAILURE_IDENTITIES = new Set<ValidationCommandResult['failureIdentity']>(['known', 'unknown', 'none']);
const FAILURE_EVIDENCE = new Set<NonNullable<ValidationCommandResult['failureEvidence']>>(['complete', 'partial']);

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
    && (item.env === undefined || Boolean(record(item.env) && Object.values(item.env as object).every(value => typeof value === 'string')))
    && typeof item.display === 'string'
    && item.display.length > 0);
}

function validResult(value: unknown): value is ValidationCommandResult {
  const item = record(value);
  const shapeValid = Boolean(item
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
    && (item.exitCode === undefined || item.exitCode === null || Number.isInteger(item.exitCode))
    && (item.reason === undefined || typeof item.reason === 'string'));
  if (!shapeValid || !item) return false;
  if (item.failureEvidence === undefined) return true;
  if (typeof item.failureEvidence !== 'string'
      || !FAILURE_EVIDENCE.has(item.failureEvidence as NonNullable<ValidationCommandResult['failureEvidence']>)
      || item.state !== 'failed'
      || item.failureIdentity !== 'known') return false;
  if (item.failureEvidence !== 'partial') return true;
  const hasFailureFacts = (item.failureIdentifiers as string[]).length > 0
    || item.failureCount !== undefined;
  return hasFailureFacts && typeof item.reason === 'string' && item.reason.trim().length > 0;
}

function validBaseline(value: unknown, canonicalTarget: string): value is ProjectValidationBaseline {
  const baseline = record(value);
  const discovery = record(baseline?.discovery);
  if (!baseline || baseline.version !== 1 || !sameResolvedPath(baseline.projectDir, canonicalTarget)) return false;
  if (!discovery
      || typeof discovery.state !== 'string'
      || !['configured', 'partial', 'unknown'].includes(discovery.state)
      || typeof discovery.configPath !== 'string'
      || !Array.isArray(discovery.commands)
      || !discovery.commands.every(validCommand)
      || !Array.isArray(discovery.missingRoles)
      || !discovery.missingRoles.every(role)) return false;
  const rawResults = baseline.results;
  // Records from older versions may still carry a causal-criteria list; it decides nothing and is ignored.
  return Array.isArray(rawResults) && rawResults.every(validResult);
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
  const inspection = inspectShipSetupRecord(targetDir, exactBrief, globalRoot);
  return inspection.state === 'ready' ? inspection.validationBaseline : undefined;
}

export type ShipSetupRecordInspection =
  | { state: 'missing'; recordPath: string }
  | { state: 'invalid'; recordPath?: string; reason: string }
  | { state: 'refused'; recordPath: string; reason: string }
  | { state: 'ready'; recordPath: string; validationBaseline: ProjectValidationBaseline; record: Record<string, unknown> };

/** Preserve absence, refusal, corruption, and readiness as distinct launch facts. */
export function inspectShipSetupRecord(
  targetDir: string,
  exactBrief: string,
  globalRoot = fcGlobalDir(),
): ShipSetupRecordInspection {
  let canonicalTarget: string;
  try { canonicalTarget = realpathSync.native(resolve(targetDir)); }
  catch (error) {
    return { state: 'invalid', reason: `target cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}` };
  }
  const briefDigest = shipSetupBriefDigest(exactBrief);
  const expectedPath = shipSetupReadyRecordPath(canonicalTarget, briefDigest, globalRoot);
  if (!existsSync(expectedPath)) return { state: 'missing', recordPath: expectedPath };
  let parsed: Record<string, unknown> | undefined;
  try { parsed = record(JSON.parse(readFileSync(expectedPath, 'utf-8')) as unknown); }
  catch (error) {
    return { state: 'invalid', recordPath: expectedPath, reason: `record is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed
      || parsed.version !== 1
      || parsed.briefDigest !== briefDigest
      || !sameResolvedPath(parsed.targetCanonicalDir, canonicalTarget)
      || !sameResolvedPath(parsed.readyRecordPath, expectedPath)) {
    return { state: 'invalid', recordPath: expectedPath, reason: 'record identity does not match the exact canonical target and brief' };
  }
  if (parsed.state === 'refused' && parsed.ready === false) {
    const blockers = Array.isArray(parsed.blockers) ? parsed.blockers : [];
    const reason = blockers.map((item) => record(item)?.reason).filter((item): item is string => typeof item === 'string').join('; ');
    return { state: 'refused', recordPath: expectedPath, reason: reason || 'ship-setup refused this target and brief' };
  }
  if (parsed.state !== 'ready' || parsed.ready !== true || !validBaseline(parsed.validationBaseline, canonicalTarget)) {
    return { state: 'invalid', recordPath: expectedPath, reason: 'record is neither a valid ready record nor a valid refused record' };
  }
  return { state: 'ready', recordPath: expectedPath, validationBaseline: parsed.validationBaseline, record: parsed };
}

/** Launch permission depends only on measured command identities and completed exits. */
export function measuredSetupFacts(baseline: ProjectValidationBaseline) {
  if (baseline.execution !== 'executed') throw new SetupLaunchRefusal('setup_unmeasured',
    'Setup baseline is unmeasured. Rerun flowcrew ship-setup for this target and exact brief.');
  const identity = (command: Pick<ValidationCommandResult, 'role' | 'command' | 'args' | 'env'>) =>
    canonicalJson({ role: command.role, command: command.command, args: command.args, env: command.env ?? {} });
  const commands = baseline.discovery.commands.map(command => ({ command: identity(command),
    results: baseline.results.filter(result => identity(result) === identity(command)).map(result => ({
      exitCode: result.exitCode ?? null, unfinished: Boolean(result.unfinished),
    })),
  }));
  const acknowledgementRequired = commands.some(command => !command.results.some(result => result.exitCode === 0 && !result.unfinished));
  return { identity: createHash('sha256').update(canonicalJson({ projectDir: baseline.projectDir, commands })).digest('hex'), acknowledgementRequired };
}

export class SetupLaunchRefusal extends Error {
  constructor(readonly code: 'setup_not_ready' | 'setup_unmeasured' | 'setup_acknowledgement_required', message: string) {
    super(`${code}: ${message}`); this.name = 'SetupLaunchRefusal';
  }
}

/** Shared by every first-launch route; initialized runs retain their historical baseline. */
export function assertMeasuredSetupLaunch(targetDir: string, brief: string, admission?: BriefAdmissionRecord) {
  const setup = inspectShipSetupRecord(targetDir, brief);
  if (setup.state !== 'ready') throw new SetupLaunchRefusal('setup_not_ready',
    `Setup is ${setup.state}. Run flowcrew ship-setup for this target and exact brief.`);
  const facts = measuredSetupFacts(setup.validationBaseline);
  const acknowledgement = admission?.acknowledgement;
  if (facts.acknowledgementRequired && (acknowledgement?.kind !== 'explicit'
    || acknowledgement.measuredSetupIdentity !== facts.identity)) {
    throw new SetupLaunchRefusal('setup_acknowledgement_required',
      'Some declared validation command has no completed exit 0. Review the measured setup results, then launch with --acknowledge-brief-warnings.');
  }
  return facts;
}

/** Show the same command facts wherever the launching operator reviews them. */
export function measuredSetupSummary(baseline: ProjectValidationBaseline): string {
  const facts = measuredSetupFacts(baseline);
  return baseline.discovery.commands.map(command => {
    const result = baseline.results.find(result => result.role === command.role && result.command === command.command
      && canonicalJson(result.args) === canonicalJson(command.args) && canonicalJson(result.env ?? {}) === canonicalJson(command.env ?? {}));
    return `  ${command.role}: ${command.display} exit=${result?.exitCode ?? 'missing'}${result?.unfinished ? ' unfinished' : ''}\n`;
  }).join('') + `Setup acknowledgement: ${facts.acknowledgementRequired ? 'REQUIRED' : 'not required'}\n`;
}
