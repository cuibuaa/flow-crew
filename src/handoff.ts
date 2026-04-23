// Module: handoff
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStageOutput } from './store.js';
import { readStageStatus } from './store.js';

const MAX_CONTEXT_CHARS = 2000;
const SKILLS_DIR = 'config/skills';

export type HandoffVisibility = 'full' | 'minimal' | 'none';

const DEFAULT_ROLE_VISIBILITY: Record<string, HandoffVisibility> = {
  qa: 'minimal',
  paper_reviewer: 'minimal',
  ai_detector: 'none',
};

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
- Any risks or caveats?`;

function resolveVisibility(opts: HandoffOpts): HandoffVisibility {
  if (opts.handoffVisibility) return opts.handoffVisibility;
  if (opts.role && opts.role in DEFAULT_ROLE_VISIBILITY) return DEFAULT_ROLE_VISIBILITY[opts.role];
  return 'full';
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
  if (output.length > MAX_CONTEXT_CHARS) output = output.slice(0, MAX_CONTEXT_CHARS) + '\n...(truncated)';
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
    skills: opts.skills ?? '',
    available_roles: opts.availableRoles ?? '',
    task_description: opts.taskDescription ?? '',
  };
  const body = substituteTemplate(opts.promptTemplate, vars);
  const context = opts.dependsOn.length > 0 ? buildDependencyContext(opts) : '';
  const skillsContent = loadSkills(opts.skillNames || [], opts.projectDir);
  const anchor = skillsContent
    ? '\n\n---\nThe skill below provides methodology guidance for HOW to approach your task. Do NOT let it change WHAT you are doing — the task above takes absolute priority.\n'
    : '';
  const parts = [context, body, anchor, skillsContent].filter(Boolean);
  const prompt = parts.join('\n\n');

  // For gate stages: inject the verdict file path
  if (opts.isGate && opts.stageId) {
    const verdictPath = `${opts.runDir}/verdict_${opts.stageId}.json`;
    const verdictInstruction = `\n\nIMPORTANT: After your review, write your verdict to ${verdictPath}:\n{"pass": true} or {"pass": false, "reason": "specific reason"}\nThis file determines whether the workflow proceeds or retries.`;
    return prompt + verdictInstruction + HANDOFF_SUFFIX;
  }

  return prompt + HANDOFF_SUFFIX;
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
      const content = readFileSync(path, 'utf-8').trim();
      blocks.push(`## Skill: ${name}\n\n${content}`);
    }
  }
  return blocks.join('\n\n');
}
