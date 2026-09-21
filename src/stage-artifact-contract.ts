import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  compareLiveConstraintContentIdentities,
  readLiveConstraintContentIdentity,
  type LiveConstraintContentIdentity,
} from './live-constraint-guard.js';

export type StageArtifactObligationKind = 'prompt_artifact' | 'replay_command_target';

export interface StageArtifactObligation {
  kind: StageArtifactObligationKind;
  mention: string;
  path: string;
  source: 'prompt' | 'published_report';
  sourcePath?: string;
}

export interface StageArtifactContractViolation extends StageArtifactObligation {
  reason: string;
}

export interface StageArtifactContractAudit {
  version: 1;
  stageId: string;
  checkedAt: string;
  obligations: StageArtifactObligation[];
  producedPromptArtifacts: string[];
  violations: StageArtifactContractViolation[];
}

export interface StageArtifactContractPreimage {
  path: string;
  identity: LiveConstraintContentIdentity;
}

export interface StageArtifactContractInput {
  stageId: string;
  template: string;
  projectDir: string;
  runDir: string;
  writes?: readonly string[];
  preimages?: readonly StageArtifactContractPreimage[];
  priorProducedPromptArtifacts?: readonly string[];
}

const PATH_TOKEN = /`([^`\s]+)`|((?:\/|\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)|(?:^|[\s("'])(([A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+))(?=$|[\s"',.;:)])/g;
const FILE_SUFFIX = /\.(?:md|json|ya?ml|toml|txt|csv|ts|tsx|js|jsx|mjs|cjs|py|sh|html|xml)$/i;
const TEST_COMMAND = /\b(?:vitest|pytest|node\s+--test|npm\s+(?:exec\s+)?(?:vitest|test)|pnpm\s+(?:exec\s+)?(?:vitest|test)|yarn\s+(?:vitest|test))\b/i;
const NON_OBLIGATING = /\b(?:optional|illustrative|example|for example|if needed|if applicable|may write|might write)\b/i;

function substitute(template: string, projectDir: string, runDir: string): string {
  return template
    .replace(/\{project\}/g, projectDir)
    .replace(/\{run_dir\}/g, runDir);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function cleanedMention(value: string): string {
  return value.trim().replace(/^["']|["',.;:)]$/g, '');
}

function resolveMention(
  mention: string,
  projectDir: string,
  runDir: string,
): string | undefined {
  const cleaned = cleanedMention(mention);
  if (!cleaned || /[*?{}[\]]/.test(cleaned) || !FILE_SUFFIX.test(cleaned)) return undefined;
  const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(projectDir, cleaned.replace(/^\.\//, ''));
  if (!within(projectDir, absolute) && !within(runDir, absolute)) return undefined;
  return absolute;
}

function pathMentions(text: string): string[] {
  const mentions: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const value = cleanedMention(match[1] ?? match[2] ?? match[3] ?? '');
    if (value && !mentions.includes(value)) mentions.push(value);
  }
  return mentions;
}

function promptArtifactObligations(
  template: string,
  projectDir: string,
  runDir: string,
): StageArtifactObligation[] {
  const obligations: StageArtifactObligation[] = [];
  for (const line of substitute(template, projectDir, runDir).split(/\r?\n/)) {
    const imperative = line.match(/^\s*(?:[-*]\s*)?(?:write|create|produce|publish|save|emit)\b\s+(.+)$/i);
    if (!imperative || NON_OBLIGATING.test(line)) continue;
    const artifactClause = imperative[1]
      .split(/\b(?:with\s+)?replay command\s*:/i)[0]
      .split(/\b(?:selected by|described by|provided by|read from|based on|according to|using)\b/i)[0];
    for (const mention of pathMentions(artifactClause)) {
      const path = resolveMention(mention, projectDir, runDir);
      if (path) obligations.push({ kind: 'prompt_artifact', mention, path, source: 'prompt' });
    }
  }
  return obligations;
}

function commandTargetObligations(
  text: string,
  source: StageArtifactObligation['source'],
  projectDir: string,
  runDir: string,
  sourcePath?: string,
): StageArtifactObligation[] {
  const obligations: StageArtifactObligation[] = [];
  for (const line of text.split(/\r?\n/)) {
    const commandText = line.match(/replay command\s*:\s*(.+)$/i)?.[1] ?? line;
    if (!TEST_COMMAND.test(commandText) || NON_OBLIGATING.test(line)) continue;
    for (const mention of pathMentions(commandText)) {
      const path = resolveMention(mention, projectDir, runDir);
      if (!path) continue;
      obligations.push({
        kind: 'replay_command_target',
        mention,
        path,
        source,
        ...(sourcePath ? { sourcePath } : {}),
      });
    }
  }
  return obligations;
}

function readableMarkdown(path: string): string | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > 1_000_000) return undefined;
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function dedupe(obligations: readonly StageArtifactObligation[]): StageArtifactObligation[] {
  const seen = new Set<string>();
  return obligations.filter((obligation) => {
    // A replay target can be named in both the stage prompt and the report it
    // asks the stage to publish. It is one existence contract, not two errors.
    const key = `${obligation.kind}\0${obligation.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function absoluteWritePath(
  write: string,
  projectDir: string,
  runDir: string,
): string | undefined {
  if (write.startsWith('run:')) {
    const path = resolve(runDir, write.slice('run:'.length));
    return within(runDir, path) ? path : undefined;
  }
  if (isAbsolute(write)) {
    const path = resolve(write);
    return within(projectDir, path) || within(runDir, path) ? path : undefined;
  }
  const path = resolve(projectDir, write.replace(/^\.\//, ''));
  return within(projectDir, path) ? path : undefined;
}

/** Capture prompt-owned artifact identities before an attempt starts. */
export function captureStageArtifactContractPreimages(
  input: Pick<StageArtifactContractInput, 'template' | 'projectDir' | 'runDir'>,
): StageArtifactContractPreimage[] {
  return dedupe(promptArtifactObligations(input.template, input.projectDir, input.runDir))
    .map((obligation) => ({
      path: obligation.path,
      identity: readLiveConstraintContentIdentity(obligation.path),
    }));
}

/**
 * Check only attributable, unambiguous promises: imperative file paths in the
 * stage's own template and exact test-file arguments in a requested replay
 * command. Examples, optional mentions, globs and arbitrary shell text are not
 * promoted into obligations.
 */
export function inspectStageArtifactContract(input: StageArtifactContractInput): StageArtifactContractAudit {
  const promptObligations = promptArtifactObligations(
    input.template,
    input.projectDir,
    input.runDir,
  );
  const commandObligations = commandTargetObligations(
    substitute(input.template, input.projectDir, input.runDir),
    'prompt',
    input.projectDir,
    input.runDir,
  );
  const reportCandidates = new Set<string>();
  for (const obligation of promptObligations) {
    if (/\.md$/i.test(obligation.path)) reportCandidates.add(obligation.path);
  }
  for (const write of input.writes ?? []) {
    if (write.startsWith('run:')) continue;
    const path = resolveMention(write, input.projectDir, input.runDir);
    if (path && /\.md$/i.test(path)) reportCandidates.add(path);
  }
  const publishedObligations: StageArtifactObligation[] = [];
  for (const reportPath of reportCandidates) {
    const markdown = readableMarkdown(reportPath);
    if (markdown === undefined) continue;
    publishedObligations.push(...commandTargetObligations(
      markdown,
      'published_report',
      input.projectDir,
      input.runDir,
      reportPath,
    ));
  }
  const obligations = dedupe([...promptObligations, ...commandObligations, ...publishedObligations]);
  const preimages = new Map((input.preimages ?? []).map((entry) => [resolve(entry.path), entry.identity]));
  const reportedWrites = new Set((input.writes ?? [])
    .map((write) => absoluteWritePath(write, input.projectDir, input.runDir))
    .filter((path): path is string => path !== undefined)
    .map((path) => resolve(path)));
  const producedPromptArtifacts = new Set((input.priorProducedPromptArtifacts ?? []).map((path) => resolve(path)));
  for (const obligation of promptObligations) {
    const path = resolve(obligation.path);
    if (reportedWrites.has(path)) {
      producedPromptArtifacts.add(path);
      continue;
    }
    const before = preimages.get(path);
    if (before && compareLiveConstraintContentIdentities(
      before,
      readLiveConstraintContentIdentity(path),
    ) === 'different') {
      producedPromptArtifacts.add(path);
    }
  }
  const violations = obligations.flatMap((obligation): StageArtifactContractViolation[] => {
    try {
      if (existsSync(obligation.path) && statSync(obligation.path).isFile()) {
        if (obligation.kind !== 'prompt_artifact' || producedPromptArtifacts.has(resolve(obligation.path))) {
          return [];
        }
        return [{
          ...obligation,
          reason: `stage prompt required ${obligation.mention}, but that exact file predated the stage and no attributable stage write produced or updated it`,
        }];
      }
    } catch { /* report as missing/unreadable below */ }
    return [{
      ...obligation,
      reason: obligation.kind === 'prompt_artifact'
        ? `stage prompt required ${obligation.mention}, but no readable file exists at that exact path`
        : `published replay command names ${obligation.mention}, but no readable input file exists at that exact path`,
    }];
  });
  return {
    version: 1,
    stageId: input.stageId,
    checkedAt: new Date().toISOString(),
    obligations,
    producedPromptArtifacts: [...producedPromptArtifacts].sort(),
    violations,
  };
}

export function writeStageArtifactContractAudit(runDir: string, audit: StageArtifactContractAudit): string {
  const path = join(runDir, 'stages', audit.stageId, 'artifact_contract.json');
  writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`, 'utf-8');
  return path;
}
