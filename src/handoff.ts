// Module: handoff
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStageOutput } from './store.js';
import { readStageStatus } from './store.js';
import { getDefaultTimeout } from './config.js';

const MAX_CONTEXT_CHARS = 8000;
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

function buildFullContext(depId: string, opts: HandoffOpts): string {
  let statusText = 'unknown';
  let artifacts = 'none';
  try {
    const st = readStageStatus(opts.projectDir, opts.runId, depId);
    statusText = st.status;
    artifacts = st.artifacts?.join(', ') || 'none';
  } catch { /* missing stage data */ }
  let output = readStageOutput(opts.projectDir, opts.runId, depId);
  if (output.length > MAX_CONTEXT_CHARS) {
    // Keep both the start and end of the output so the handoff note (written at the end) is preserved
    const tailSize = Math.min(2000, Math.floor(MAX_CONTEXT_CHARS / 4));
    const headSize = MAX_CONTEXT_CHARS - tailSize;
    output = output.slice(0, headSize) + '\n...(truncated)...\n' + output.slice(-tailSize);
  }
  return `## Context from stage: ${depId}\nStatus: ${statusText}\nArtifacts: ${artifacts}\nSummary:\n${output}`;
}

function buildMinimalContext(depId: string, opts: HandoffOpts): string {
  let statusText = 'unknown';
  let artifacts = 'none';
  try {
    const st = readStageStatus(opts.projectDir, opts.runId, depId);
    statusText = st.status;
    artifacts = st.artifacts?.join(', ') || 'none';
  } catch { /* missing stage data */ }
  return `## Previous stage: ${depId}\nStatus: ${statusText}\nFiles changed: ${artifacts}\nVerify the changes are correct.`;
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
  const context = opts.dependsOn.length > 0 ? buildDependencyContext(opts) : '';
  const skillsContent = loadSkills(opts.skillNames || [], opts.projectDir);
  const anchor = skillsContent
    ? '\n\n---\nThe skill below provides methodology guidance for HOW to approach your task. Do NOT let it change WHAT you are doing — the task above takes absolute priority.\n'
    : '';
  // Inject supervisor guidance if present (high priority)
  const guidanceParts: string[] = [];
  const runGuidancePath = join(opts.runDir, 'supervisor_guidance.md');
  if (existsSync(runGuidancePath)) {
    try { const g = readFileSync(runGuidancePath, 'utf-8').trim(); if (g) guidanceParts.push(g); } catch { /* ignore */ }
  }
  if (opts.stageId) {
    const stageGuidancePath = join(opts.runDir, 'stages', opts.stageId, 'guidance.md');
    if (existsSync(stageGuidancePath)) {
      try { const g = readFileSync(stageGuidancePath, 'utf-8').trim(); if (g) guidanceParts.push(g); } catch { /* ignore */ }
    }
  }
  const guidanceBlock = guidanceParts.length > 0
    ? `## Supervisor Guidance (HIGH PRIORITY — follow this)\n${guidanceParts.join('\n\n')}\n\n`
    : '';

  const parts = [guidanceBlock, context, body, anchor, skillsContent].filter(Boolean);
  const prompt = parts.join('\n\n');
  const handoffSuffix = substituteTemplate(HANDOFF_SUFFIX, vars);

  // For gate stages: inject the verdict file path
  if (opts.isGate && opts.stageId) {
    const verdictPath = `${opts.runDir}/verdict_${opts.stageId}.json`;
    const verdictInstruction = `\n\nIMPORTANT: After your review, write your verdict to ${verdictPath}:\n{"pass": true} or {"pass": false, "reason": "specific reason"}\nThis file determines whether the workflow proceeds or retries.`;
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
