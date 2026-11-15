import { auditFindingsJsonSchema, FINDING_POLICY_TEXT } from './scoped-audit-repair.js';
import { readBriefCriteriaArtifact } from './brief-criteria.js';
import { ValidationSelectionSchema } from './project-validation.js';
import { runRecordPath, stageWorkPath } from './run-layout.js';
// Module: handoff
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceContext } from './evidence-ledger.js';
import { readGuidanceForStage, renderGuidanceDelivery } from './guidance.js';
import { validate, type Schema } from './reality-gate/checks/json-schema-match.js';
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
  outputSchema?: Schema;
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
  blocks: { anyOf: [object({ criterion_ids: strings, paths: strings }), { type: 'null' }] },
});

// Old results carry an author-reported file list. Deleting the read field would
// hide those records; new generation uses the engine's existing write ledger.
export const RECORDED_HANDOFF_SCHEMA: Schema = { ...HANDOFF_SCHEMA,
  required: HANDOFF_SCHEMA.required!.filter(key => key !== 'remaining_work' && key !== 'blocks'), properties: {
  ...HANDOFF_SCHEMA.properties, files_modified: strings,
  checks: { type: 'array', items: object({ command: text, exit_code: { type: 'integer' }, evidence: text }) },
} };

/** pass/fail encode met/not met; unassessed and carried results are explicit facts. */
export const CRITERION_ENTRY_SCHEMA: Schema = { anyOf: [
  object({ status: { type: 'string', enum: ['pass', 'fail'] }, evidence: text }),
  object({ status: { type: 'string', enum: ['not_assessed'] }, evidence: text,
    reason: { type: 'string', enum: ['capability_unavailable', 'evidence_unavailable'] } }),
  object({ status: { type: 'string', enum: ['carried'] }, evidence: text,
    from: object({ iteration: { type: 'integer', minimum: 1 }, round: { type: 'integer', minimum: 1 } }) }),
] };

/** A gate covers the entire brief even when its work assignment is narrower. */
export function gateCriterionRefs(runDir: string, fallback: string[] = []): string[] {
  return readBriefCriteriaArtifact(runDir)?.criteria.map(criterion => criterion.id) ?? fallback;
}

/** Ordinary verdicts are closed records; extended metadata never opens the criterion map. */
export function stageRecordSchema(opts: Pick<HandoffOpts, 'isGate' | 'criterionRefs'> & { extendedVerdict?: boolean; runDir?: string }): Schema {
  if (!opts.isGate) return HANDOFF_SCHEMA;
  const refs = opts.runDir ? gateCriterionRefs(opts.runDir, opts.criterionRefs) : opts.criterionRefs ?? [];
  const criteria = object(Object.fromEntries(refs.map(id => [id, CRITERION_ENTRY_SCHEMA])));
  const audit_findings = auditFindingsJsonSchema(refs);
  const pass = object({ reason: text, criteria, audit_findings: auditFindingsJsonSchema(refs, true),
    pass: { type: 'boolean', enum: [true] } }, completion);
  const fail = object({ reason: text, criteria, audit_findings, pass: { type: 'boolean', enum: [false] }, repairability: object({
    version: { type: 'integer', enum: [1] }, disposition: { type: 'string', enum: ['repairable', 'irreparable'] }, evidence: text,
  }) }, completion);
  if (opts.extendedVerdict) pass.additionalProperties = fail.additionalProperties = true;
  return { type: 'object', anyOf: [pass, fail] };
}

export function parseStageRecord(output: string, schema: Schema): Record<string, unknown> {
  let record: unknown;
  try { record = JSON.parse(output); }
  catch { throw new Error('STAGE_RECORD_INVALID: malformed JSON'); }
  // Optional model judgments confer authority only through their own fixed
  // schema. Bad judgment output stays unknown; it cannot void the independent
  // verdict or the completed author work around it. Keep the raw record for audit.
  const checked = record && typeof record === 'object' && !Array.isArray(record) ? { ...record } as Record<string, unknown> : record;
  const optional = (schema: Schema, key: string): boolean => Boolean(schema.properties?.[key] && !schema.required?.includes(key)
    || schema.anyOf?.some(variant => optional(variant, key)));
  if (checked && typeof checked === 'object' && !Array.isArray(checked)) {
    for (const [key, contract] of [['validation', ValidationSelectionSchema]] as const) {
      if (optional(schema, key) && !contract.safeParse((checked as Record<string, unknown>)[key]).success) delete (checked as Record<string, unknown>)[key];
    }
  }
  const errors = validate(checked, schema, '$');
  if (errors.length) throw new Error(`STAGE_RECORD_INVALID: ${errors.join('; ')}`);
  return record as Record<string, unknown>;
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
    run_dir: stageWorkPath(opts.runDir),
    skills: opts.skills ?? '',
    available_roles: opts.availableRoles ?? '',
    available_skills: opts.availableSkills ?? '',
    task_description: opts.taskDescription ?? '',
  };
  const body = substituteTemplate(opts.promptTemplate, vars);
  const criterionBlock = (() => {
    const refs = opts.isGate ? gateCriterionRefs(opts.runDir, opts.criterionRefs) : opts.criterionRefs;
    if (!refs?.length) return '';
    return `## Canonical brief criteria assigned to this stage\n${JSON.stringify({ criterion_refs: refs,
      path: runRecordPath(opts.runDir, 'brief_criteria.json') })}\nRead the assigned criteria at this path; the system brief owns their full context.`;
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
  const parts = [
    guidanceDelivery,
    context,
    body,
    criterionBlock,
    opts.isGate ? FINDING_POLICY_TEXT : '',
    opts.outputSchema?.properties?.status?.enum?.includes('environment_gap') ? '## Environment gaps\nIf your active result schema offers the environment_gap status and this environment cannot supply a capability or resource needed for the work, report status: "environment_gap", with summary stating what is missing, what you observed, and what remains. Set blocks to { criterion_ids: [...], paths: [...] } naming exactly the criteria and project-relative paths this gap blocks, independently of your stage responsibility mapping. Nonempty dimensions jointly constrain the blocked work; an empty dimension is unconstrained. Use null when the blocked work is unknown. Null, legacy omission or wholly empty blocks are reported as unknown to the gate. This is a structured declaration, not a work failure. The engine sends it to the independent gate without retrying it. Only the gate decides acceptance under its criteria. Do not use it merely because work is unfinished.' : '',
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
