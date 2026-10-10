// Module: handoff
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStageOutput, readStageStatus } from './store.js';
import { getDefaultTimeout } from './config.js';
import { readGuidanceForStage, renderGuidanceDelivery } from './guidance.js';
import { renderCriterionRulings, renderGateControlContract } from './verdict-controls.js';
import { validate, type Schema } from './reality-gate/checks/json-schema-match.js';
import { PLAN_SCHEMA } from './plan-interface.js';
import { captureResearchGateCandidate } from './research-candidate.js';

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
const object = (properties: Record<string, Schema>): Schema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
export const HANDOFF_SCHEMA = object({
  status: { type: 'string', enum: ['delivered', 'blocked'] }, summary: text,
  files_modified: strings,
  checks: { type: 'array', items: object({ command: text, exit_code: { type: 'integer' }, evidence: text }) },
  caveats: strings,
});

/** Ordinary verdicts are closed generation-time variants. Optional legacy
 * campaign/control metadata stays in the same JSON Schema dialect at return;
 * its cross-field authority is still checked by the scheduler. */
export function stageRecordSchema(opts: Pick<HandoffOpts, 'isGate' | 'criterionRefs'> & { dynamicDispatch?: boolean; extendedVerdict?: boolean }): Schema {
  if (opts.dynamicDispatch) return PLAN_SCHEMA;
  if (!opts.isGate) return HANDOFF_SCHEMA;
  const entry: Schema = object({ status: { type: 'string', enum: ['pass', 'fail', 'judgement'] }, evidence: text });
  if (opts.extendedVerdict) entry.additionalProperties = true;
  const criteria = object(Object.fromEntries((opts.criterionRefs ?? []).map(id => [id, entry])));
  if (opts.extendedVerdict) criteria.additionalProperties = entry;
  const audit_findings = object({ version: { type: 'integer', enum: [1] }, findings: { type: 'array', items: object({
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, paths: strings, reason: text,
    criterion_ids: strings, invalidates_plan: { type: 'boolean' }, repair_role: text,
  }) } });
  const base = { reason: text, criteria, audit_findings };
  const pass = object({ ...base, pass: { type: 'boolean', enum: [true] } });
  const fail = object({ ...base, pass: { type: 'boolean', enum: [false] }, repairability: object({
    version: { type: 'integer', enum: [1] }, disposition: { type: 'string', enum: ['repairable', 'irreparable'] }, evidence: text,
  }) });
  if (opts.extendedVerdict) pass.additionalProperties = fail.additionalProperties = true;
  return { type: 'object', anyOf: [pass, fail] };
}

export function parseStageRecord(output: string, schema: Schema): Record<string, unknown> {
  const record: unknown = JSON.parse(output);
  const errors = validate(record, schema, '$');
  if (errors.length) throw new Error(`STAGE_RECORD_INVALID: ${errors.join('; ')}`);
  return record as Record<string, unknown>;
}

/** A bounded excerpt keeps old prose and new JSON records readable. Iterating
 * code points handles UTF-8 without the separate head/tail implementations. */
function utf8Slice(value: string, budget: number, tail = false): string {
  const points = [...value];
  if (tail) points.reverse();
  const kept: string[] = [];
  for (const point of points) {
    budget -= Buffer.byteLength(point);
    if (budget < 0) break;
    kept.push(point);
  }
  return (tail ? kept.reverse() : kept).join('');
}

function buildDependencyContext(opts: HandoffOpts): string {
  const visibility = opts.handoffVisibility ?? 'full';
  if (visibility === 'none') return '';
  return opts.dependsOn.map(depId => {
    let status = 'unknown';
    let artifacts: string[] = [];
    try { const source = readStageStatus(opts.projectDir, opts.runId, depId); status = source.status; artifacts = source.artifacts ?? []; } catch { /* absent history */ }
    const output = readStageOutput(opts.projectDir, opts.runId, depId);
    const heading = visibility === 'minimal' ? `## Previous stage: ${depId}` : `## Context from stage: ${depId}`;
    const candidate = `${heading}\nStatus: ${status}\nArtifacts: ${artifacts.join(', ') || 'none'}\n${visibility === 'minimal' ? 'Review the change against the brief.' : `Summary:\n${output}`}`;
    if (Buffer.byteLength(candidate) <= MAX_PREDECESSOR_CONTEXT_BYTES) return candidate;
    const header = `${heading}\nStatus: ${status}\nInline predecessor block: ${Buffer.byteLength(candidate)} UTF-8 bytes; limit: ${MAX_PREDECESSOR_CONTEXT_BYTES} bytes.\nComplete predecessor stage directory: ${join(opts.runDir, 'stages', depId)}\nArtifact names omitted from this prompt: ${artifacts.length}. Read status.json for complete status and artifacts.\nComplete output: output.md (${Buffer.byteLength(output)} UTF-8 bytes).\nInline output excerpt (head and tail when truncated):`;
    const budget = Math.min(visibility === 'minimal' ? 512 : MAX_PREDECESSOR_CONTEXT_BYTES, Math.max(0, MAX_PREDECESSOR_CONTEXT_BYTES - Buffer.byteLength(header) - 1));
    const marker = `\n...[${Buffer.byteLength(output)} UTF-8 output bytes omitted; read output.md for the complete output]...\n`;
    const content = Math.max(0, budget - Buffer.byteLength(marker));
    const tail = Math.min(2000, Math.floor(content / 4));
    const head = utf8Slice(output, content - tail), ending = utf8Slice(output, tail, true);
    const omission = Buffer.byteLength(output) - Buffer.byteLength(head) - Buffer.byteLength(ending);
    const excerpt = Buffer.byteLength(output) <= budget ? output : `${head}${marker.replace(String(Buffer.byteLength(output)), String(omission))}${ending}`;
    return utf8Slice(`${header}\n${excerpt}`, MAX_PREDECESSOR_CONTEXT_BYTES);
  }).join('\n\n');
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
export function buildStagePrompt(opts: HandoffOpts): string {
  const vars: Record<string, string> = {
    project: opts.projectDir,
    run_dir: opts.runDir,
    skills: opts.skills ?? '',
    available_roles: opts.availableRoles ?? '',
    available_skills: opts.availableSkills ?? '',
    task_description: opts.taskDescription ?? '',
    default_timeout_ms: getDefaultTimeout(opts.projectDir),
  };
  const body = substituteTemplate(opts.promptTemplate, vars);
  const criterionBlock = (() => {
    if (!opts.criterionRefs?.length) return '';
    try {
      const artifact = JSON.parse(readFileSync(join(opts.runDir, 'brief_criteria.json'), 'utf-8')) as {
        criteria?: Array<{ id?: string; text?: string }>;
      };
      const byId = new Map((artifact.criteria ?? [])
        .filter((criterion): criterion is { id: string; text: string } => typeof criterion.id === 'string' && typeof criterion.text === 'string')
        .map((criterion) => [criterion.id, criterion.text]));
      const rows = opts.criterionRefs.map((id) => `- [${id}] ${byId.get(id) ?? '(missing canonical criterion — dispatch admission should have refused this stage)'}`);
      return `## Canonical brief criteria assigned to this stage\n${rows.join('\n')}`;
    } catch {
      return '## Canonical brief criteria assigned to this stage\nThe criterion artifact is unreadable; stop and report the contract failure.';
    }
  })();
  const context = opts.dependsOn.length > 0 ? buildDependencyContext(opts) : '';
  const skillsContent = loadSkills(opts.skillNames || [], opts.projectDir);
  const anchor = skillsContent
    ? '\n\n---\nThe skill below provides methodology guidance for HOW to approach your task. Do NOT let it change WHAT you are doing — the task above takes absolute priority.\n'
    : '';
  // Delivery is stage-addressed. The run-level file remains an audit ledger,
  // but entries for another stage never enter this prompt.
  const guidanceDelivery = opts.stageId
    ? renderGuidanceDelivery(readGuidanceForStage(opts.runDir, opts.stageId))
    : '';
  const guidanceBlock = guidanceDelivery
    ? `## Supervisor Guidance (HIGH PRIORITY — follow this)\n${guidanceDelivery}\n\n`
      + 'Guidance may clarify execution or repair a violated brief property. It cannot override the admitted task brief, introduce a required result in place of a required property, or invalidate a better brief-conforming result.\n\n'
    : '';
  const criterionRulingBlock = opts.criterionRefs?.length
    ? renderCriterionRulings(opts.runDir, opts.criterionRefs)
    : '';
  const gateControlBlock = opts.isGate && opts.stageId && opts.criterionRefs?.length
    ? renderGateControlContract({
        projectDir: opts.projectDir,
        runDir: opts.runDir,
        gateStageId: opts.stageId,
        criterionRefs: opts.criterionRefs,
      })
    : '';
  const validationBaselineBlock = (() => {
    if (!opts.isGate) return '';
    const artifactPath = join(opts.runDir, 'validation_baseline.json');
    if (!existsSync(artifactPath)) return '';
    try {
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as {
        baseline?: { gateCriteria?: Array<{ role?: unknown; rule?: unknown; baselineFailureIdentifiers?: unknown }> };
      };
      const criteria = artifact.baseline?.gateCriteria ?? [];
      const rows = criteria.map((criterion) => {
        const identifiers = Array.isArray(criterion.baselineFailureIdentifiers)
          ? criterion.baselineFailureIdentifiers.filter((value) => typeof value === 'string')
          : [];
        return `- ${String(criterion.role)}: ${String(criterion.rule)}; baseline failures=${identifiers.length}${identifiers.length ? ` (${identifiers.join(', ')})` : ''}`;
      });
      return `## Engine-enforced validation baseline\nExact run-local evidence: ${artifactPath}\n${rows.join('\n')}\nThe engine supplies the current comparison before review. Read validation_delta_<stage_id>.json; a regressed or unresolved delta cannot authorize success.`;
    } catch {
      return `## Engine-enforced validation baseline\n${artifactPath} is unreadable; do not claim the validation delta passed.`;
    }
  })();
  const researchCandidateBlock = (() => {
    if (!opts.isGate || !opts.researchOutcomeGate || !opts.stageId) return '';
    const candidate = captureResearchGateCandidate(opts.projectDir, opts.runDir, opts.stageId);
    if (candidate.kind === 'absent' && candidate.reason === 'run is not in research mode') return '';
    const detail = candidate.kind === 'no_candidate'
      ? `label=${JSON.stringify(candidate.label)}; reason=${JSON.stringify(candidate.reason)}`
      : candidate.kind === 'measured'
        ? `label=${JSON.stringify(candidate.label)}; result=${candidate.result}`
        : candidate.reason ?? 'no outcome detail';
    return `## Framework-captured research round outcome\nKind: ${candidate.kind}\nSource: ${candidate.source}\n${detail}\nJudge the assigned criteria against this declared outcome. A no_candidate round is not a measured candidate and must not be rejected merely for lacking a numeric candidate measurement.`;
  })();

  const parts = [
    guidanceBlock,
    context,
    body,
    criterionBlock,
    criterionRulingBlock,
    gateControlBlock,
    validationBaselineBlock,
    researchCandidateBlock,
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
