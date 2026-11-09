import { VALIDATION_REVIEW_JSON_SCHEMA, ValidationReviewSchema, ValidationSelectionSchema } from './project-validation.js';
// Module: handoff
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceContext } from './evidence-ledger.js';
import { readGuidanceForStage, renderGuidanceDelivery } from './guidance.js';
import { validate, type Schema } from './reality-gate/checks/json-schema-match.js';
import { captureResearchGateCandidate, researchGateCandidateFile } from './research-candidate.js';

export const MAX_PREDECESSOR_CONTEXT_BYTES = 8_000;
const SKILLS_DIR = 'config/skills';

export type HandoffVisibility = 'full' | 'minimal' | 'none';

interface HandoffOpts {
  dependsOn: string[];
  promptTemplate: string;
  projectDir: string;
  runId: string;
  runDir: string;
  skills?: string;
  skillNames?: string[];
  handoffVisibility?: HandoffVisibility;
  role?: string;
  availableRoles?: string;
  availableSkills?: string;
  taskDescription?: string;
  isGate?: boolean;
  /** True only for a gate whose dependency closure owns the current research
   * outcome slot. Other gates must not be made responsible for producing it. */
  researchOutcomeGate?: boolean;
  stageId?: string;
  criterionRefs?: string[];
}

const text: Schema = { type: 'string', minLength: 1, pattern: '\\S' };
const strings: Schema = { type: 'array', items: text };
const object = (properties: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema => ({
  type: 'object', properties: { ...properties, ...optional }, required: Object.keys(properties), additionalProperties: false,
});
// An explicit empty list certifies no work remains at wrap-up.
const completion = { remaining_work: strings };
export const HANDOFF_SCHEMA = object({
  status: { type: 'string', enum: ['delivered', 'blocked', 'environment_gap'] }, summary: text,
  caveats: strings, ...completion,
});

// Old results carry an author-reported file list. Deleting the read field would
// hide those records; new generation uses the engine's existing write ledger.
export const RECORDED_HANDOFF_SCHEMA: Schema = { ...HANDOFF_SCHEMA,
  required: HANDOFF_SCHEMA.required!.filter(key => key !== 'remaining_work'), properties: {
  ...HANDOFF_SCHEMA.properties, files_modified: strings,
  checks: { type: 'array', items: object({ command: text, exit_code: { type: 'integer' }, evidence: text }) },
} };

/** Ordinary verdicts are closed record variants. Optional legacy
 * campaign/control metadata stays in the same JSON Schema dialect at return;
 * its cross-field authority is still checked by the scheduler. */
export function stageRecordSchema(opts: Pick<HandoffOpts, 'isGate' | 'criterionRefs'> & { extendedVerdict?: boolean }): Schema {
  if (!opts.isGate) return HANDOFF_SCHEMA;
  const entry: Schema = object({ status: { type: 'string', enum: ['pass', 'fail', 'judgement'] }, evidence: text });
  if (opts.extendedVerdict) entry.additionalProperties = true;
  const criteria = (pass: boolean): Schema => {
    const allowed = pass ? { ...entry, properties: { ...entry.properties, status: { type: 'string', enum: ['pass', 'judgement'] } } } : entry;
    const map = object(Object.fromEntries((opts.criterionRefs ?? []).map(id => [id, allowed])));
    if (opts.extendedVerdict) map.additionalProperties = entry;
    return map;
  };
  const audit_findings = object({ version: { type: 'integer', enum: [1] }, findings: { type: 'array', items: object({
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' },
    paths: { type: 'array', minItems: 1, items: text }, reason: text,
    reproduction: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    criterion_ids: strings, invalidates_plan: { type: 'boolean' }, repair_role: text,
  }) } });
  const findingSchema = audit_findings.properties!.findings.items as Schema;
  findingSchema.required = findingSchema.required!.filter(key => key !== 'reproduction');
  const pass = object({ reason: text, criteria: criteria(true), audit_findings: { ...audit_findings,
    properties: { ...audit_findings.properties, findings: { ...audit_findings.properties!.findings, maxItems: 0 } },
  }, pass: { type: 'boolean', enum: [true] } }, completion);
  const fail = object({ reason: text, criteria: criteria(false), audit_findings, pass: { type: 'boolean', enum: [false] }, repairability: object({
    version: { type: 'integer', enum: [1] }, disposition: { type: 'string', enum: ['repairable', 'irreparable'] }, evidence: text,
  }) }, completion);
  for (const variant of [pass, fail]) variant.properties!.validation_review = VALIDATION_REVIEW_JSON_SCHEMA;
  if (opts.extendedVerdict) pass.additionalProperties = fail.additionalProperties = true;
  return { type: 'object', anyOf: [pass, fail] };
}

export function parseStageRecord(output: string, schema: Schema): Record<string, unknown> {
  const record: unknown = JSON.parse(output);
  // Optional model judgments confer authority only through their own fixed
  // schema. Bad judgment output stays unknown; it cannot void the independent
  // verdict or the completed author work around it. Keep the raw record for audit.
  const checked = record && typeof record === 'object' && !Array.isArray(record) ? { ...record } as Record<string, unknown> : record;
  const optional = (schema: Schema, key: string): boolean => Boolean(schema.properties?.[key] && !schema.required?.includes(key)
    || schema.anyOf?.some(variant => optional(variant, key)));
  if (checked && typeof checked === 'object' && !Array.isArray(checked)) {
    for (const [key, contract] of [['validation', ValidationSelectionSchema], ['validation_review', ValidationReviewSchema]] as const) {
      if (optional(schema, key) && !contract.safeParse((checked as Record<string, unknown>)[key]).success) delete (checked as Record<string, unknown>)[key];
    }
  }
  const errors = validate(checked, schema, '$');
  if (errors.length) throw new Error(`STAGE_RECORD_INVALID: ${errors.join('; ')}`);
  return record as Record<string, unknown>;
}

/** Kept as an API for callers; verbosity never grants transcript access. */
export function buildDependencyContext(opts: Pick<HandoffOpts, 'dependsOn' | 'handoffVisibility' | 'projectDir' | 'runId' | 'runDir'>): string {
  return evidenceContext(opts.projectDir, opts.runDir);
}

function substituteTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => key in vars ? vars[key] : match);
}

/**
 * Assembles the full prompt for a stage by substituting template variables,
 * prepending dependency context, appending skills and handoff suffix,
 * and injecting verdict instructions for gate stages.
 *
 * @param opts - The handoff configuration options.
 * @returns The assembled prompt string.
 */
export function buildStagePrompt(opts: HandoffOpts, context = evidenceContext(opts.projectDir, opts.runDir, opts.stageId)): string {
  const vars: Record<string, string> = {
    project: opts.projectDir,
    run_dir: opts.runDir,
    skills: opts.skills ?? '',
    available_roles: opts.availableRoles ?? '',
    available_skills: opts.availableSkills ?? '',
    task_description: existsSync(join(opts.runDir, 'task_brief.md'))
      ? join(opts.runDir, 'task_brief.md') : opts.taskDescription ?? '',
  };
  const body = substituteTemplate(opts.promptTemplate, vars);
  const criterionBlock = (() => {
    if (!opts.criterionRefs?.length) return '';
    return `## Canonical brief criteria assigned to this stage\n${JSON.stringify({ criterion_refs: opts.criterionRefs,
      path: join(opts.runDir, 'brief_criteria.json') })}\nRead the assigned criteria at this path; the system brief owns their full context.`;
  })();
  const skillsContent = loadSkills(opts.skillNames || [], opts.projectDir);
  const anchor = skillsContent
    ? '\n\n---\nThe skill below provides methodology guidance for HOW to approach your task. Do NOT let it change WHAT you are doing — the task above takes absolute priority.\n'
    : '';
  // Delivery is stage-addressed. The run-level file remains an audit ledger,
  // but entries for another stage never enter this prompt.
  const guidanceDelivery = opts.stageId
    ? renderGuidanceDelivery(readGuidanceForStage(opts.runDir, opts.stageId))
    : '';
  const researchCandidateBlock = (() => {
    if (!opts.isGate || !opts.researchOutcomeGate || !opts.stageId) return '';
    const candidate = captureResearchGateCandidate(opts.projectDir, opts.runDir, opts.stageId);
    if (candidate.kind === 'absent' && candidate.reason === 'run is not in research mode') return '';
    return `## Framework-captured research round outcome\n${JSON.stringify({
      version: candidate.version, kind: candidate.kind,
      path: join(opts.runDir, researchGateCandidateFile(opts.stageId)),
      ...(candidate.sha256 ? { sha256: candidate.sha256 } : {}),
    })}\nRead the captured structured outcome at this path. A no_candidate round is not a measured candidate and must not be rejected merely for lacking a numeric candidate measurement.`;
  })();

  const parts = [
    guidanceDelivery,
    context,
    body,
    criterionBlock,
    researchCandidateBlock,
    '## Environment gaps\nIf your active result schema offers the environment_gap status and this environment cannot supply a capability or resource needed for the work, report status: "environment_gap", with summary stating what is missing, what you observed, and what remains. This is a structured declaration, not a work failure. The engine sends it to the independent gate without retrying it. Only the gate decides acceptance under its criteria. Do not use it merely because work is unfinished.',
    opts.isGate ? '## Reproduced findings and validation\nA finding to be repaired must cite its reproduction record: set reproduction to the integer sequence in evidence-ledger.jsonl. Run a targeted command with exit 0 meaning the defect is absent and a positive exit meaning it is present. Use the injected engine-recorded command endpoint through your native shell tool, supplying command, absolute cwd and shell as JSON; the engine executes and records it and returns record.sequence. This works even when a native transport omits cwd and shell. Native commands are also eligible when their structured events include explicit absolute cwd and shell, exit and output. The recorded command is replayed with that shell (-c) in that cwd and the same engine command environment. Include any required shell options in an explicit executable invocation in the command. The engine records the complete command, context, structured exit code, output digest and tree hash; read the ledger after the command completes and cite its sequence. Missing execution context, a missing citation, a passing command or a changed tree is an unconfirmed observation and opens no repair. Do not run configured validation inside the gate. For each failed, unfinished or unrun command, return validation_review.commands with its exact role/display, disposition caused_by_change|already_failing|environment|unknown and reason. You alone judge causation from logs, diff and optional base evidence. To settle a failure needing base, return validation_review.request_base with exact role/display; the engine obtains one bounded base batch and returns the facts for your final verdict in this attempt. Otherwise return request_base: []. Missing or invalid dispositions stay unknown and unverified. A caused_by_change disposition prevents acceptance; repair still needs the independent confirmed reproduction above. Host load is telemetry only. Failed, unfinished and unrun commands remain unverified even on acceptance. Keep independent read-only scope [] and run your own experiments.' : '',
    anchor,
    skillsContent,
  ].filter(Boolean);
  return parts.join('\n\n');
}

function loadSkills(skillNames: string[], projectDir: string): string {
  if (!skillNames.length) return '';
  const blocks: string[] = [];
  for (const name of skillNames) {
    // Check project-local skills first, then global
    const localPath = join(projectDir, SKILLS_DIR, `${name}.md`);
    const globalPath = join(process.cwd(), SKILLS_DIR, `${name}.md`);
    const path = existsSync(localPath) ? localPath : existsSync(globalPath) ? globalPath : null;
    if (path) {
      // Strip optional YAML front-matter (the self-description used by the planner
      // registry) so only the skill body is injected into the stage prompt.
      const content = readFileSync(path, 'utf-8').replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
      blocks.push(`## Skill: ${name}\n\n${content}`);
    }
  }
  return blocks.join('\n\n');
}
