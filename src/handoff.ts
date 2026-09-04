// Module: handoff
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStageOutput } from './store.js';
import { readStageStatus } from './store.js';
import { getDefaultTimeout } from './config.js';
import { readGuidanceForStage, renderGuidanceDelivery } from './guidance.js';

export const MAX_PREDECESSOR_CONTEXT_BYTES = 8_000;
const SKILLS_DIR = 'config/skills';

function readDefaultTimeout(projectDir: string): string {
  return getDefaultTimeout(projectDir);
}

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
  stageId?: string;
  criterionRefs?: string[];
}

/**
 * Handoff prompt suffix — appended to every stage so the agent writes
 * a natural handoff note for downstream stages.
 */
const HANDOFF_SUFFIX = `

---
Before finishing, write a brief handoff note for the next stage:
- What did you do?
- What key decisions did you make and why?
- What should the next person know before starting?
- Any risks or caveats?

Knowledge graph continuity:
- If this stage produced reusable goals, approaches, findings, results, dead ends, user hints, source references, or candidate metrics, update the task-local knowledge graph at {kg_path}.
- If the file does not exist, create it with this shape: {"nodes":[],"edges":[],"metadata":{"createdAt":"<iso>","updatedAt":"<iso>"}}.
- Keep entries concise and evidence-backed. Do not invent sources, scores, or results.
- Use node types: goal, approach, finding, result, insight, dead_end, user_hint, source.
- A "source" node is an external reference you cite (paper / doc / repo): {"type":"source","label":"<title>","source":"<URL>"}. Link the finding it backs with a "sourced_from" edge.
- Use edge types: explored_by, found_that, measured_as, sourced_from, supports, contradicts, combines_with, depends_on.`;

function resolveVisibility(opts: HandoffOpts): HandoffVisibility {
  // Visibility is a role atom: each agent self-declares handoff_visibility in its config; the
  // worker passes it through as opts.handoffVisibility. No engine-side role→visibility map.
  return opts.handoffVisibility ?? 'full';
}

interface PredecessorContextSource {
  statusText: string;
  artifactNames: string[];
  output: string;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function takeUtf8Head(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8Bytes(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

function takeUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let bytes = 0;
  let start = value.length;
  while (start > 0) {
    let codePointStart = start - 1;
    const trailing = value.charCodeAt(codePointStart);
    if (trailing >= 0xdc00 && trailing <= 0xdfff && codePointStart > 0) {
      const leading = value.charCodeAt(codePointStart - 1);
      if (leading >= 0xd800 && leading <= 0xdbff) codePointStart--;
    }
    const codePoint = value.slice(codePointStart, start);
    const codePointBytes = utf8Bytes(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    start = codePointStart;
  }
  return value.slice(start);
}

function renderOutputExcerpt(output: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const outputBytes = utf8Bytes(output);
  if (outputBytes === 0) return takeUtf8Head('(output.md is empty)', maxBytes);
  if (outputBytes <= maxBytes) return output;

  // Reserve for the largest possible omission count first. The exact marker
  // below can only be the same size or smaller, keeping the complete excerpt
  // inside maxBytes without ever splitting a UTF-8 code point.
  const reservedMarker = `\n...[${outputBytes} UTF-8 output bytes omitted; read output.md for the complete output]...\n`;
  const contentBudget = Math.max(0, maxBytes - utf8Bytes(reservedMarker));
  const tailBudget = Math.min(2_000, Math.floor(contentBudget / 4));
  const head = takeUtf8Head(output, contentBudget - tailBudget);
  const tail = takeUtf8Tail(output, tailBudget);
  const omittedBytes = outputBytes - utf8Bytes(head) - utf8Bytes(tail);
  const marker = `\n...[${omittedBytes} UTF-8 output bytes omitted; read output.md for the complete output]...\n`;
  return takeUtf8Head(`${head}${marker}${tail}`, maxBytes);
}

function readPredecessorContext(depId: string, opts: HandoffOpts): PredecessorContextSource {
  let statusText = 'unknown';
  let artifactNames: string[] = [];
  try {
    const st = readStageStatus(opts.projectDir, opts.runId, depId);
    statusText = st.status;
    artifactNames = Array.isArray(st.artifacts)
      ? st.artifacts.filter((artifact): artifact is string => typeof artifact === 'string')
      : [];
  } catch { /* missing stage data */ }
  return {
    statusText,
    artifactNames,
    output: readStageOutput(opts.projectDir, opts.runId, depId),
  };
}

function boundPredecessorContext(
  candidate: string,
  depId: string,
  opts: HandoffOpts,
  visibility: Exclude<HandoffVisibility, 'none'>,
  source: PredecessorContextSource,
): string {
  const candidateBytes = utf8Bytes(candidate);
  if (candidateBytes <= MAX_PREDECESSOR_CONTEXT_BYTES) return candidate;

  const stageDirectory = join(opts.runDir, 'stages', depId);
  const heading = visibility === 'minimal'
    ? `## Previous stage: ${depId}`
    : `## Context from stage: ${depId}`;
  const outputBytes = utf8Bytes(source.output);
  const header = `${heading}
Status: ${source.statusText}
Inline predecessor block: ${candidateBytes} UTF-8 bytes; limit: ${MAX_PREDECESSOR_CONTEXT_BYTES} bytes.
Complete predecessor stage directory: ${stageDirectory}
Artifact names omitted from this prompt: ${source.artifactNames.length}. Read status.json for complete status and artifacts.
Complete output: output.md (${outputBytes} UTF-8 bytes).
Inline output excerpt (head and tail when truncated):`;
  const headerBytes = utf8Bytes(header);
  if (headerBytes >= MAX_PREDECESSOR_CONTEXT_BYTES) {
    return takeUtf8Head(header, MAX_PREDECESSOR_CONTEXT_BYTES);
  }

  const remainingBytes = MAX_PREDECESSOR_CONTEXT_BYTES - headerBytes - 1;
  const excerptBudget = visibility === 'minimal'
    ? Math.min(512, remainingBytes)
    : remainingBytes;
  const excerpt = renderOutputExcerpt(source.output, excerptBudget);
  const bounded = excerpt ? `${header}\n${excerpt}` : header;
  return takeUtf8Head(bounded, MAX_PREDECESSOR_CONTEXT_BYTES);
}

function buildFullContext(depId: string, opts: HandoffOpts): string {
  const source = readPredecessorContext(depId, opts);
  const artifacts = source.artifactNames.join(', ') || 'none';
  const candidate = `## Context from stage: ${depId}\nStatus: ${source.statusText}\nArtifacts: ${artifacts}\nSummary:\n${source.output}`;
  return boundPredecessorContext(candidate, depId, opts, 'full', source);
}

function buildMinimalContext(depId: string, opts: HandoffOpts): string {
  const source = readPredecessorContext(depId, opts);
  const artifacts = source.artifactNames.join(', ') || 'none';
  const candidate = `## Previous stage: ${depId}\nStatus: ${source.statusText}\nFiles changed: ${artifacts}\nVerify the changes are correct.`;
  return boundPredecessorContext(candidate, depId, opts, 'minimal', source);
}

function buildDependencyContext(opts: HandoffOpts): string {
  const visibility = resolveVisibility(opts);
  if (visibility === 'none') return '';

  const blocks: string[] = [];
  for (const depId of opts.dependsOn) {
    if (visibility === 'minimal') {
      blocks.push(buildMinimalContext(depId, opts));
    } else {
      blocks.push(buildFullContext(depId, opts));
    }
  }
  return blocks.join('\n\n');
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
    kg_path: join(opts.runDir, 'knowledge_graph.json'),
    skills: opts.skills ?? '',
    available_roles: opts.availableRoles ?? '',
    available_skills: opts.availableSkills ?? '',
    task_description: opts.taskDescription ?? '',
    default_timeout_ms: readDefaultTimeout(opts.projectDir),
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

  const parts = [guidanceBlock, context, body, criterionBlock, anchor, skillsContent].filter(Boolean);
  const prompt = parts.join('\n\n');
  const handoffSuffix = substituteTemplate(HANDOFF_SUFFIX, vars);

  // For gate stages: inject the verdict file path
  if (opts.isGate && opts.stageId) {
    const verdictPath = `${opts.runDir}/verdict_${opts.stageId}.json`;
    const criterionEvidence = opts.criterionRefs?.length
      ? `\nFor every assigned criterion ID, include a "criteria" map entry with {"status":"pass"|"fail"|"judgement","evidence":"non-empty checked evidence or why it is not mechanically decidable"}. Missing entries are an effective gate rejection.`
      : '';
    const verdictInstruction = `\n\nIMPORTANT: After your review, write your verdict to ${verdictPath}:\n{"pass": true} or {"pass": false, "reason": "specific reason"}\nThis file determines whether the workflow proceeds or retries.${criterionEvidence}`;
    return prompt + verdictInstruction + handoffSuffix;
  }

  return prompt + handoffSuffix;
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
