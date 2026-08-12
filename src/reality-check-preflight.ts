import { posix } from 'node:path';
import { parseDocument } from 'yaml';
import { parseChecksFromMarkdown, type CheckDecl } from './reality-gate/index.js';

export type RealityCheckPreflightCode =
  | 'presentation_proxy_heading_literal'
  | 'contract_exception_conflict'
  | 'undeclared_artifact_existence'
  | 'copy_byte_equivalence'
  | 'hard_check_cannot_fail'
  | 'invalid_reality_check_declaration';

export type RealityCheckPreflightTier = 'blocking' | 'advisory' | 'structural';

export interface RealityCheckPreflightFinding {
  code: RealityCheckPreflightCode;
  checkIndex: number;
  checkName: string;
  checkType: string;
  message: string;
  tier: RealityCheckPreflightTier;
  blocking: boolean;
  evidence?: string;
}

export interface RealityCheckPreflightReport {
  version: 1;
  checksInspected: number;
  findings: RealityCheckPreflightFinding[];
  /**
   * Backward-compatible name for findings emitted from planner-authored hard
   * declarations. Use the tier-specific collections for admission decisions.
   * @deprecated Use blockingTierFindings, advisoryFindings, or structuralFindings.
   */
  blockingFindings: RealityCheckPreflightFinding[];
  blockingTierFindings: RealityCheckPreflightFinding[];
  advisoryFindings: RealityCheckPreflightFinding[];
  structuralFindings: RealityCheckPreflightFinding[];
  refusingFindings: RealityCheckPreflightFinding[];
}

export interface RealityCheckAdvisoryRewrite {
  markdown: string;
  demotedCheckIndexes: number[];
}

interface ExceptionStatement {
  line: number;
  text: string;
  paths: string[];
}

interface BriefContractModel {
  requiredArtifacts: string[];
  artifactDeclarationsComplete: boolean;
  requiredHeadingLiterals: string[];
  exceptions: ExceptionStatement[];
  requiresByteEquivalence: boolean;
}

const PATH_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|sh|bash|ya?ml|json|jsonl|toml|md|txt|csv|tsv|parquet|db|sqlite|html|css|svg|png|jpe?g|webp|pdf|arrow)$/i;
const OUTPUT_KEY = /^(?:output|outputs|deliverable|deliverables|artifact|artifacts|result_file|output_file|report_file|report_path|report_dir|writable_paths)$/i;
const PRODUCTION_DIRECTIVE = /(?:\b(?:must|shall|required|will)\b.{0,120}\b(?:write|create|produce|generate|emit|save|deliver|implement|update|append|move|relocate|contain|include|exist)\b)|(?:\b(?:write|create|produce|generate|emit|save|deliver|implement|update|append|move|relocate)\b.{0,120}\b(?:must|shall|required)\b)|(?:^|[:.;]\s*|[-*+]\s+)(?:write|create|produce|generate|emit|save|deliver|implement|update|append|move|relocate)\b|(?:\b(?:deliverables?|outputs?|artifacts?|result[_ -]?files?)\b\s*(?:\([^\n)]*\)\s*)?(?::|\bare\b|\bis\b|\bmust\b|\brequired\b))|\bwhere\s+to\s+write\b|\bonly\s+(?:create|write|modify)\b|(?:必须|须|要求|交付物|产出|输出|写入|写到|写明|新建|新增|创建|实现|迁移|移动|更新|修改|追加|包含|含有|存在|放在|位于|补齐)/i;
const NEGATED_PRODUCTION_DIRECTIVE = /\b(?:must|shall|should|will|do|does)\s+not\s+(?:write|create|produce|generate|emit|save|deliver|implement|update|append|move|relocate|edit|modify|change|delete)|\bnever\s+(?:write|create|produce|generate|emit|save|deliver|implement|update|append|move|relocate|edit|modify|change|delete)|\bno\s+[^.\n]{0,60}\b(?:may|must|should|will)\s+(?:write|create|produce|generate|emit|save|deliver|implement|update|append|move|relocate|edit|modify|change|delete)|(?:不得|不要|禁止|不可).{0,40}(?:写入|写到|新建|新增|创建|实现|迁移|移动|更新|修改|追加|删除)/i;
const ILLUSTRATIVE_DIRECTIVE = /\b(?:for example|e\.g\.|illustrative|example only|not a criterion)\b|(?:参考实现|不必照抄|仅供说明)/i;
const ARTIFACT_SECTION_HEADING = /\b(?:deliverables?|outputs?|artifacts?|terminal\s+(?:states?|artifacts?)|required\s+files?|files?\s+required)\b|(?:交付物|产出|输出|验收文件)/i;
const OUTPUT_LIST_HEADING = /\b(?:files?\s+to\s+(?:create|write|move|migrate)|items?\s+to\s+(?:create|move|migrate))\b|(?:必须补齐|须补齐|迁移哪些|需要迁移|新增哪些)/i;
const FIGURE_OUTPUT_HEADING = /^(?:fig(?:ure)?|图)\s*\d+\b/i;
const OUTPUT_ASSIGNMENT = /^(?:[-*+]\s*)?(?:result_file|output_file|report_file|report_path|report_dir|writable_paths)\s*:/i;
const OBLIGATION_LIST_INTRO = /\b(?:required|deliverables?|outputs?|artifacts?|files?\s+to\s+(?:write|create|produce))\b.{0,80}(?::|\bfollow(?:s|ing)\b)|(?:交付物|产出|输出|验收文件|必须生成|必须写入|须写入).{0,50}[：:]?$/i;
const EXCEPTION_DIRECTIVE = /\b(?:must|shall|required(?:\s+to)?)\s+(?:be\s+)?(?:preserved|retained|kept|left unchanged)|\b(?:must|shall)\s+not\s+(?:be\s+)?(?:removed|deleted|edited|changed|rewritten)|\b(?:explicit(?:ly)?\s+)?(?:except|exception|exempt|allowed|permitted)\b|\bpreserve\b.{0,50}\b(?:history|historical|existing|legacy)\b/i;
const REVOKED_EXCEPTION_DIRECTIVE = /\b(?:delete|remove|eliminate|drop|retire)\b.{0,80}\b(?:exception|exemption|allowance|permission)\b|\b(?:exception|exemption|allowance|permission)\b.{0,80}\b(?:must|shall|should|will)\s+(?:be\s+)?(?:deleted|removed|eliminated|dropped|retired)\b/i;
const BYTE_EQUIVALENCE_CONTRACT = /\b(?:must|shall|required)\b.{0,120}\b(?:byte[- ](?:equal|equality|identical)|bytes?\s+(?:unchanged|preserved|identical)|bit[- ]for[- ]bit|exact byte (?:copy|identity))\b|\b(?:byte[- ](?:equal|equality|identical)|bytes?\s+(?:unchanged|preserved|identical)|preserve(?:d)?\s+bytes?|bit[- ]for[- ]bit|exact byte (?:copy|identity))\b.{0,120}\b(?:must|shall|required|contract)\b/i;
const EXACT_HEADING_CONTRACT = /\b(?:must|shall|required)\b.{0,100}\bexact\b.{0,60}\b(?:markdown\s+)?heading\b|\bexact\b.{0,60}\b(?:markdown\s+)?heading\b.{0,100}\b(?:must|shall|required|violat(?:e|es|ion))\b/i;
const CEILING_DELIVERABLE = /\b(?:ceiling|rigorous\s+negative)\b.{0,140}\b(?:valid|real|accepted|acceptable)\s+(?:terminal\s+)?deliverable\b|\b(?:valid|real|accepted|acceptable)\s+(?:terminal\s+)?deliverable\b.{0,140}\b(?:ceiling|rigorous\s+negative)\b/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function leadingFrontmatter(brief: string): {
  parsed?: Record<string, unknown>;
  body: string;
  bodyLineOffset: number;
  declarationsComplete: boolean;
} {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(brief);
  if (!match) return { body: brief, bodyLineOffset: 0, declarationsComplete: true };
  let parsed: Record<string, unknown> | undefined;
  let declarationsComplete = false;
  try {
    const document = parseDocument(match[1]);
    parsed = record(document.toJS());
    declarationsComplete = document.errors.length === 0 && parsed !== undefined;
  } catch {
    // The scheduler reports malformed task frontmatter separately. Keep this
    // lint total, and leave the declaration population unknown rather than
    // converting a parse failure into a known-empty contract.
  }
  return {
    parsed,
    body: brief.slice(match[0].length),
    bodyLineOffset: match[0].split(/\r?\n/).length - 1,
    declarationsComplete,
  };
}

function normalizeArtifactPath(raw: string): string | undefined {
  let value = raw.trim()
    .replace(/^[`'"(\u005b]+/, '')
    .replace(/[`'")\],.;:]+$/, '')
    .replace(/<[A-Za-z][A-Za-z0-9_-]*>/g, '*')
    .replace(/^\.\//, '')
    .replaceAll('\\', '/');
  if (value.endsWith('/')) value = value.slice(0, -1);
  if (!value || value.startsWith('~')) return undefined;
  if (value.includes('://') || /[$<>]/.test(value) || /\s/.test(value)) return undefined;
  if (!value.includes('/') && !PATH_EXTENSION.test(value) && !/[?*{}[\]]/.test(value)) return undefined;
  return posix.normalize(value);
}

function extractPathTokens(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/`([^`\r\n]+)`/g)) candidates.push(match[1]);
  for (const match of text.matchAll(/(?:^|[\s('"\u005b])(\.?[A-Za-z0-9_*?{}[\].-]+(?:\/[A-Za-z0-9_*?{}[\].-]+)+(?:\/)?|[A-Za-z0-9_*?{}[\].-]+\.[A-Za-z0-9_.-]+)/g)) {
    candidates.push(match[1]);
  }
  return [...new Set(candidates.map(normalizeArtifactPath).filter((path): path is string => path !== undefined))];
}

function terminalPaths(raw: unknown): string[] {
  const terminal = record(raw);
  if (!terminal) return [];
  const paths: string[] = [];
  for (const value of Object.values(terminal)) {
    if (typeof value === 'string') paths.push(value);
    else if (Array.isArray(value)) paths.push(...value.filter((item): item is string => typeof item === 'string'));
    else {
      const entry = record(value);
      if (!entry) continue;
      if (typeof entry.path === 'string') paths.push(entry.path);
      if (Array.isArray(entry.paths)) paths.push(...entry.paths.filter((item): item is string => typeof item === 'string'));
    }
  }
  return paths;
}

function collectOutputValues(value: unknown, key: string | undefined, output: string[]): void {
  if (typeof value === 'string') {
    if (key && OUTPUT_KEY.test(key)) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOutputValues(item, key, output);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [childKey, childValue] of Object.entries(object)) {
    if (childKey === 'inputs' || childKey === 'input') continue;
    collectOutputValues(childValue, childKey, output);
  }
}

function explicitBodyArtifacts(body: string): string[] {
  const artifacts: string[] = [];
  let artifactSectionLevel: number | undefined;
  let obligationListActive = false;
  let pendingListArtifacts: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r\n|\n|\r/)) {
    const trimmed = line.trim();
    if (/^```|^~~~/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      if ((ARTIFACT_SECTION_HEADING.test(title) || OUTPUT_LIST_HEADING.test(title))
          && !ILLUSTRATIVE_DIRECTIVE.test(title)) {
        artifactSectionLevel = level;
      } else if (artifactSectionLevel !== undefined && level <= artifactSectionLevel) {
        artifactSectionLevel = undefined;
      }
      const affirmativeHeading = !ILLUSTRATIVE_DIRECTIVE.test(title)
        && !NEGATED_PRODUCTION_DIRECTIVE.test(title)
        && (artifactSectionLevel !== undefined
          || PRODUCTION_DIRECTIVE.test(title)
          || OUTPUT_ASSIGNMENT.test(title)
          || FIGURE_OUTPUT_HEADING.test(title));
      if (affirmativeHeading && (artifactSectionLevel === undefined || level > artifactSectionLevel)) {
        artifacts.push(...extractPathTokens(title));
      }
      obligationListActive = artifactSectionLevel !== undefined
        || OBLIGATION_LIST_INTRO.test(title)
        || PRODUCTION_DIRECTIVE.test(title);
      pendingListArtifacts = [];
      continue;
    }
    if (!trimmed) {
      obligationListActive = artifactSectionLevel !== undefined;
      pendingListArtifacts = [];
      continue;
    }
    if (ILLUSTRATIVE_DIRECTIVE.test(trimmed) || NEGATED_PRODUCTION_DIRECTIVE.test(trimmed)) {
      obligationListActive = false;
      continue;
    }
    const isListEntry = /^(?:[-*+]\s+|\d+[.)]\s+)/.test(trimmed);
    const listedOutput = artifactSectionLevel !== undefined && isListEntry;
    const lineArtifacts = extractPathTokens(trimmed);
    const continuedObligation = obligationListActive
      && (isListEntry || lineArtifacts.length > 0);
    const declaresOutput = PRODUCTION_DIRECTIVE.test(trimmed) || OUTPUT_ASSIGNMENT.test(trimmed);
    if (listedOutput || continuedObligation || declaresOutput) {
      if (isListEntry && pendingListArtifacts.length > 0) artifacts.push(...pendingListArtifacts);
      artifacts.push(...lineArtifacts);
      pendingListArtifacts = [];
    } else if (isListEntry) {
      pendingListArtifacts.push(...lineArtifacts);
    } else {
      pendingListArtifacts = [];
    }
    obligationListActive = artifactSectionLevel !== undefined
      || OBLIGATION_LIST_INTRO.test(trimmed)
      || (obligationListActive && isListEntry)
      || (declaresOutput && !/[.!?。！？]\s*$/.test(trimmed))
      || ((obligationListActive || declaresOutput) && /[：:]\s*$/.test(trimmed));
  }
  return artifacts;
}

function relocatedBodyArtifacts(body: string): string[] {
  const artifacts: string[] = [];
  const lines = body.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const directive = /(?:\b(?:move|migrate|relocate)\b|\bgit\s+mv\b|迁移|移动)[^\r\n]{0,180}?(?:\b(?:to|into)\b|到)\s*`([^`\r\n]+\/)`/i.exec(lines[index]);
    if (!directive || NEGATED_PRODUCTION_DIRECTIVE.test(lines[index])) continue;
    const destination = directive[1].replace(/^\.\//, '').replace(/^\/+/, '');
    if (!destination || destination.startsWith('~') || /[$<>]/.test(destination)) continue;

    let start = index;
    let sectionLevel = 7;
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const heading = /^\s*(#{1,6})\s+(.+)$/.exec(lines[cursor]);
      if (!heading) continue;
      if (/(?:\b(?:move|migrate|relocate|migration|relocation)\b|迁移|移动)/i.test(heading[2])) {
        start = cursor;
        sectionLevel = heading[1].length;
      }
      break;
    }
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const heading = /^\s*(#{1,6})\s+/.exec(lines[cursor]);
      if (heading && heading[1].length <= sectionLevel) {
        end = cursor;
        break;
      }
    }
    const section = lines.slice(start, end).join('\n');
    const wildcardSuffix = [...section.matchAll(/`[^`\r\n/]*\/\*([^`\r\n/]+)`/g)]
      .map((match) => match[1])
      .find((suffix) => /^\.[A-Za-z0-9_.-]+$/.test(suffix));
    if (wildcardSuffix) artifacts.push(`${destination}*${wildcardSuffix}`);
    const declaresWholeSet = /(?:\b(?:all|every)\b.{0,80}\b(?:files?|documents?|artifacts?|entries)\b|\b(?:existing\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:tracked\s+)?(?:reference\s+)?(?:files?|documents?|artifacts?|entries)\b|(?:全部|所有|全量).{0,40}(?:文件|文档|产物)|(?:现有|已有).{0,20}(?:\d+|[一二三四五六七八九十]+)\s*(?:篇|个|份)?[^\r\n]{0,30}(?:文件|文档|产物))/i.test(section);
    const preservesFilenames = /(?:preserv(?:e|ing).{0,50}(?:file\s*)?names?|same\s+(?:file\s*)?names?|file\s*names?.{0,30}(?:unchanged|retained)|\bgit\s+mv\b|(?:保留|保持).{0,20}(?:文件)?名)/i.test(section);
    const migratesWholeSet = declaresWholeSet && preservesFilenames;
    if (migratesWholeSet) {
      const suffixes = [...section.matchAll(/`([^`\r\n]+)`/g)]
        .map((match) => match[1].trim().replaceAll('\\', '/').split('/').pop() ?? '')
        .map((basename) => /(\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)$/.exec(basename)?.[1])
        .filter((suffix): suffix is string => suffix !== undefined);
      if (/\bmarkdown\b|文档/i.test(section)) suffixes.push('.md');
      for (const suffix of new Set(suffixes)) artifacts.push(`${destination}*${suffix}`);
    }
    for (const token of section.matchAll(/`([^`\r\n]+)`/g)) {
      const value = token[1].trim().replaceAll('\\', '/');
      if (!value || value.endsWith('/') || /\s|[$<>]/.test(value) || value.includes('://')) continue;
      const basename = value.slice(value.lastIndexOf('/') + 1);
      if (!basename || basename.includes('*')) continue;
      if (PATH_EXTENSION.test(basename)) {
        artifacts.push(`${destination}${basename}`);
      } else if (wildcardSuffix && /^[A-Za-z][A-Za-z0-9_-]+$/.test(basename)) {
        artifacts.push(`${destination}${basename}${wildcardSuffix}`);
      }
    }
  }
  return artifacts;
}

function exactRequiredHeadings(body: string): string[] {
  const headings: string[] = [];
  for (const line of body.split(/\r\n|\n|\r/)) {
    if (ILLUSTRATIVE_DIRECTIVE.test(line) || !EXACT_HEADING_CONTRACT.test(line)) continue;
    for (const match of line.matchAll(/`(#{1,6}[ \t]+[^`\r\n]+)`/g)) {
      headings.push(match[1].trim());
    }
  }
  return [...new Set(headings)];
}

function exceptionStatements(body: string, bodyLineOffset: number): ExceptionStatement[] {
  const lines = body.split(/\r\n|\n|\r/);
  const statements: ExceptionStatement[] = [];
  let paragraph: string[] = [];
  let paragraphStart = 0;
  let headingContext = '';
  const flush = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    if (EXCEPTION_DIRECTIVE.test(text)
        && !REVOKED_EXCEPTION_DIRECTIVE.test(text)
        && !ILLUSTRATIVE_DIRECTIVE.test(text)) {
      const contextualText = headingContext ? `${headingContext} ${text}` : text;
      statements.push({
        line: bodyLineOffset + paragraphStart + 1,
        text: contextualText,
        paths: extractPathTokens(contextualText),
      });
    }
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      flush();
      headingContext = trimmed.replace(/^#{1,6}\s+/, '');
      continue;
    }
    if (paragraph.length === 0) paragraphStart = index;
    paragraph.push(trimmed);
    if (/[.!?](?:[*_`)\]]+)?$/.test(trimmed)) flush();
  }
  flush();
  return statements;
}

function deriveBriefContract(brief: string): BriefContractModel {
  const frontmatter = leadingFrontmatter(brief);
  const rawArtifacts: string[] = [];
  let researchReportDir: string | undefined;
  if (frontmatter.parsed) {
    rawArtifacts.push(...terminalPaths(frontmatter.parsed.terminal_states));
    collectOutputValues(frontmatter.parsed, undefined, rawArtifacts);
    const research = record(frontmatter.parsed.research ?? frontmatter.parsed.objective);
    if (research) {
      rawArtifacts.push(typeof research.result_file === 'string' ? research.result_file : 'docs/research_round_result.json');
      researchReportDir = typeof research.report_dir === 'string'
        ? normalizeArtifactPath(research.report_dir)
        : 'docs';
      if (researchReportDir) rawArtifacts.push(posix.join(researchReportDir, 'run_manifest.json'));
    }
  }
  rawArtifacts.push(...explicitBodyArtifacts(frontmatter.body));
  rawArtifacts.push(...relocatedBodyArtifacts(frontmatter.body));
  if (researchReportDir && CEILING_DELIVERABLE.test(frontmatter.body)) {
    rawArtifacts.push(posix.join(researchReportDir, 'ceiling_report.md'));
  }
  if (/(?:\b(?:update|write|record|persist)\b.{0,80}\b(?:knowledge\s+graph|KG)\b)|(?:\b(?:knowledge\s+graph|KG)\b.{0,80}\b(?:must|required|update|write|record|persist)\b)|(?:更新|写入|记录).{0,40}(?:knowledge\s+graph|知识图谱|\bKG\b)/i.test(frontmatter.body)) {
    rawArtifacts.push('**/knowledge_graph.json');
  }
  const requiredArtifacts = [...new Set(
    rawArtifacts
      .map(normalizeArtifactPath)
      .filter((path): path is string => path !== undefined),
  )];
  // The framework-owned round manifest is contractual wherever the planner
  // elects to inspect it; its directory is selected by the research contract.
  requiredArtifacts.push('**/run_manifest.json');
  return {
    requiredArtifacts: [...new Set(requiredArtifacts)],
    artifactDeclarationsComplete: frontmatter.declarationsComplete,
    requiredHeadingLiterals: exactRequiredHeadings(frontmatter.body),
    exceptions: exceptionStatements(frontmatter.body, frontmatter.bodyLineOffset),
    requiresByteEquivalence: BYTE_EQUIVALENCE_CONTRACT.test(brief),
  };
}

function globPattern(value: string): RegExp {
  let source = '^';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '*' && value[index + 1] === '*') {
      if (value[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function artifactIsRequired(path: string, contract: BriefContractModel): boolean {
  if (!contract.artifactDeclarationsComplete) return true;
  const normalized = normalizeArtifactPath(path);
  if (!normalized) return false;
  return contract.requiredArtifacts.some((pattern) => {
    if (globPattern(pattern).test(normalized)) return true;
    const checkedPathIsAbsolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
    const portablePattern = pattern.replace(/^(?:\.\.\/)+/, '').replace(/^\/+/, '');
    if (!portablePattern) return false;
    if (!checkedPathIsAbsolute && portablePattern.includes('/')) return false;
    return globPattern(`**/${portablePattern}`).test(normalized);
  });
}

interface HeadingProxy {
  evidence: string;
  literal: string;
}

function normalizeHeadingLiteral(raw: string): string {
  return raw.trim()
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\s\+?/g, ' ')
    .replace(/\\s\*/g, '')
    .replace(/\\b/g, '')
    .replace(/\\([# ])/g, '$1')
    .trim();
}

function shellSearchCanAffectExit(script: string, start: number, end: number): boolean {
  const lineStart = script.lastIndexOf('\n', start - 1) + 1;
  const nextNewline = script.indexOf('\n', end);
  const lineEnd = nextNewline < 0 ? script.length : nextNewline;
  const line = script.slice(lineStart, lineEnd);
  const localEnd = end - lineStart;
  const tail = line.slice(localEnd);
  if (/\|\|\s*(?:true|:)(?=\s*(?:;|&&|\|\||#|$))/.test(tail)) return false;
  const pipeCanPropagateFailure = /\bset\s+-o\s+pipefail\b|\bset\s+-[A-Za-z]*o[A-Za-z]*\b[^\r\n;]*\bpipefail\b/.test(script.slice(0, lineStart));
  if (/(^|[^|])\|(?!\|)/.test(tail) && !pipeCanPropagateFailure) return false;

  const conditional = /\bif\s+!?\s*(?:grep|rg)\b/i.test(line);
  if (conditional) {
    const rest = script.slice(lineStart, Math.min(script.length, lineStart + 800));
    const body = /\bthen\b([\s\S]*?)\bfi\b/i.exec(rest)?.[1];
    return body !== undefined && /\b(?:exit\s+[1-9]\d*|false)\b|\bthrow\b|process\.exit\s*\(\s*[1-9]/i.test(body);
  }

  if (/(?:&&|\|\|)\s*(?:exit\s+[1-9]\d*|false)\b/i.test(tail)) return true;
  if (/\bset\s+-[^\r\n;]*e\b/.test(script.slice(0, lineStart))) return true;
  return script.slice(lineEnd).trim().length === 0 && !/[;|&]\s*(?:true|:)?\s*$/.test(line);
}

function exactHeadingProxy(script: string): HeadingProxy | undefined {
  const searchPattern = /\b(?:grep|rg)\b[^\r\n;&|]{0,220}(['"])(\^?#{1,6}(?:\\s\+?|[ \t])+[^'"\r\n]+?\$?)\1/gi;
  for (const match of script.matchAll(searchPattern)) {
    if (match.index === undefined || !shellSearchCanAffectExit(script, match.index, match.index + match[0].length)) continue;
    return { evidence: match[0], literal: normalizeHeadingLiteral(match[2]) };
  }

  const nodeFailure = /\bif\s*\(\s*!?\s*[A-Za-z_$][\w$]*\.(?:includes|startsWith)\s*\(\s*(['"])(#{1,6}[ \t]+[^'"\r\n]+)\1\s*\)\s*\)\s*(?:\{[\s\S]{0,240}?(?:process\.exit\s*\(\s*[1-9]|throw\b)|(?:process\.exit\s*\(\s*[1-9]|throw\b))/i.exec(script);
  if (nodeFailure) return { evidence: nodeFailure[0], literal: normalizeHeadingLiteral(nodeFailure[2]) };

  const pythonMarker = /\b([A-Za-z_]\w*)\s*=\s*(['"])(#{1,6}[ \t]+[^'"\r\n]+)\2[\s\S]{0,240}\bassert\s+\1\s+in\b/m.exec(script);
  if (pythonMarker) {
    return { evidence: pythonMarker[0], literal: normalizeHeadingLiteral(pythonMarker[3]) };
  }

  const pythonList = /\b([A-Za-z_]\w*)\s*=\s*\[([\s\S]{0,600}?)\][\s\S]{0,300}\bfor\s+([A-Za-z_]\w*)\s+in\s+\1\s*:[\s\S]{0,180}\bassert\s+\3\s+in\b/m.exec(script);
  if (pythonList) {
    const literal = /(['"])(#{1,6}[ \t]+[^'"\r\n]+)\1/.exec(pythonList[2]);
    if (literal) return { evidence: pythonList[0], literal: normalizeHeadingLiteral(literal[2]) };
  }

  const exactFirstLine = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:"(#{1,6}[ \t]+[^"\r\n]+)"|'(#{1,6}[ \t]+[^'\r\n]+)')\s*;/g;
  for (const assignment of script.matchAll(exactFirstLine)) {
    if (assignment.index === undefined) continue;
    const tail = script.slice(assignment.index + assignment[0].length);
    const comparison = new RegExp(
      `\\bif\\s*\\(\\s*[A-Za-z_$][\\w$]*\\.split\\s*\\([^;\\r\\n]{1,180}\\)\\s*\\[\\s*0\\s*\\]\\s*!={1,2}\\s*${assignment[1]}\\s*\\)\\s*\\{?[\\s\\S]{0,300}?\\b([A-Za-z_$][\\w$]*)\\.push\\s*\\(`,
    ).exec(tail);
    if (!comparison) continue;
    const failure = new RegExp(
      `\\bif\\s*\\(\\s*${comparison[1]}\\.length\\s*\\)\\s*(?:\\{[\\s\\S]{0,240})?process\\.exit\\s*\\(\\s*[1-9]`,
    ).test(tail.slice(comparison.index + comparison[0].length));
    if (failure) {
      return {
        evidence: `${assignment[0]} ${comparison[0]}`,
        literal: normalizeHeadingLiteral(assignment[2] ?? assignment[3]),
      };
    }
  }

  const nodeMatchAll = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\r\n]*\.matchAll\s*\(\s*\/(\^#{1,6}[^/\r\n]+)\/[a-z]*\s*\)[^;\r\n]*;[\s\S]{0,300}\bif\s*\(\s*!\s*\1\b[^)]*\)\s*(?:\{[\s\S]{0,180})?(?:throw\b|process\.exit\s*\(\s*[1-9])/i.exec(script);
  if (nodeMatchAll) {
    return { evidence: nodeMatchAll[0], literal: normalizeHeadingLiteral(nodeMatchAll[2]) };
  }

  const nodeSearch = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\r\n]*\.search\s*\(\s*\/(\^#{1,6}[^/\r\n]+)\/[a-z]*\s*\)\s*;?[\s\S]{0,220}\bif\s*\([^)]*\b\1\s*<\s*0[^)]*\)\s*(?:\{[\s\S]{0,180})?(?:throw\b|process\.exit\s*\(\s*[1-9])/i.exec(script);
  if (nodeSearch) {
    return { evidence: nodeSearch[0], literal: normalizeHeadingLiteral(nodeSearch[2]) };
  }

  const nodeFindIndex = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\r\n]*\.findIndex\s*\([^\r\n]*\/(\^#{1,6}[^/\r\n]+)\/[a-z]*\.test\s*\([^)]*\)\s*\)\s*;?[\s\S]{0,220}\bif\s*\([^)]*\b\1\s*<\s*0[^)]*\)\s*(?:\{[\s\S]{0,180})?(?:throw\b|process\.exit\s*\(\s*[1-9])/i.exec(script);
  if (nodeFindIndex) {
    return { evidence: nodeFindIndex[0], literal: normalizeHeadingLiteral(nodeFindIndex[2]) };
  }

  const nodeRegexArray = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]{0,700}?\^#{1,6}[\s\S]{0,700}?)\]\s*;[\s\S]{0,360}\bfor\s*\([^)]*\bof\s+\1\s*\)[\s\S]{0,240}![A-Za-z_$][\w$]*\.test\s*\([^)]*\)[\s\S]{0,180}(?:throw\b|process\.exit\s*\(\s*[1-9]|\bdie\s*\()/i.exec(script);
  if (nodeRegexArray) {
    const literal = /\/(\^#{1,6}[^/\r\n]+)\/[a-z]*/i.exec(nodeRegexArray[2]);
    if (literal) return { evidence: nodeRegexArray[0], literal: normalizeHeadingLiteral(literal[1]) };
  }

  const numberedSection = /\/(\^#{1,6}(?:\\s\+|[ \t]+)[^/\r\n]{0,60}\(\[[0-9][^\]]*\]\)[^/\r\n]*)\/[a-z]*[\s\S]{0,900}\b[A-Za-z_$][\w$]*\.has\s*\([^)]*\)[\s\S]{0,180}(?:throw\b|process\.exit\s*\(\s*[1-9])/i.exec(script);
  if (numberedSection) {
    return { evidence: numberedSection[0], literal: normalizeHeadingLiteral(numberedSection[1]) };
  }

  if (/\.indexOf\s*\(\s*start\s*\)/.test(script)
      && /\.indexOf\s*\(\s*end\s*,/.test(script)
      && /(?:from|to)\s*<\s*0[\s\S]{0,180}(?:throw\b|process\.exit\s*\(\s*[1-9])/.test(script)) {
    const directSectionCall = /\b[A-Za-z_$][\w$]*\s*\(\s*(['"])(#{1,6}[ \t]+[^'"\r\n]+)\1\s*,\s*(['"])(#{1,6}[ \t]+[^'"\r\n]+)\3\s*\)/.exec(script);
    if (directSectionCall) {
      return { evidence: directSectionCall[0], literal: normalizeHeadingLiteral(directSectionCall[2]) };
    }
  }

  const dynamicHeading = /new\s+RegExp\s*\(\s*`(\^#{1,6}[^`\r\n]{0,220}\$\{[^`\r\n]+)[^`\r\n]*`[^)]*\)\.test\s*\([^)]*\)[\s\S]{0,180}(?:throw\b|process\.exit\s*\(\s*[1-9]|\bdie\s*\()/i.exec(script);
  if (dynamicHeading) {
    return { evidence: dynamicHeading[0], literal: normalizeHeadingLiteral(dynamicHeading[1]) };
  }
  return undefined;
}

function shellWords(segment: string): string[] {
  return [...segment.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)]
    .map((match) => match[0].replace(/^(['"])([\s\S]*)\1$/, '$2'));
}

function comparisonOperands(script: string, command: 'cmp' | 'diff'): string[] | undefined {
  for (const clause of script.split(/\r?\n|;/)) {
    const neutralized = new RegExp(`\\b${command}\\b[^\\r\\n;]*\\|\\|\\s*(?:true|:)(?:\\s|$)`).test(clause);
    if (neutralized) continue;
    for (const segment of clause.split(/&&|\|\||\|/)) {
      const words = shellWords(segment.trim());
      const commandIndex = words.findIndex((word) => word === command);
      if (commandIndex !== 0 && !(commandIndex === 1 && words[0] === 'command')) continue;
      const tail = words.slice(commandIndex + 1);
      if (command === 'diff' && !tail.some((word) => word === '-q' || word === '--brief' || /^-[A-Za-z]*q/.test(word))) continue;
      const operands = tail.filter((word) => !word.startsWith('-') && !/^(?:<|>|2>|1>)/.test(word));
      if (operands.length >= 2) return operands.slice(0, 2);
    }
  }
  return undefined;
}

function readFileVariables(script: string): Map<string, string> {
  const variables = new Map<string, string>();
  const assignment = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?readFileSync\s*\(\s*(['"])([^'"\r\n]+)\2(?:\s*,[^)]*)?\)/g;
  for (const match of script.matchAll(assignment)) variables.set(match[1], match[3]);
  return variables;
}

function readFileBufferVariables(script: string): Map<string, string> {
  const variables = new Map<string, string>();
  const assignment = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?readFileSync\s*\(\s*(['"])([^'"\r\n]+)\2\s*\)/g;
  for (const match of script.matchAll(assignment)) variables.set(match[1], match[3]);
  return variables;
}

function variableBufferEquivalence(script: string): string | undefined {
  const buffers = readFileBufferVariables(script);
  if (buffers.size < 2) return undefined;
  const equalityFailure = /\bif\s*\(\s*!\s*([A-Za-z_$][\w$]*)\.equals\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\)\s*(?:\{[\s\S]{0,240}?(?:process\.exit\s*\(\s*[1-9]|throw\b)|(?:process\.exit\s*\(\s*[1-9]|throw\b))/g;
  for (const match of script.matchAll(equalityFailure)) {
    if (buffers.has(match[1]) && buffers.has(match[2])) {
      return `${match[1]}.equals(${match[2]}) for ${buffers.get(match[1])} and ${buffers.get(match[2])}`;
    }
  }
  return undefined;
}

type ByteSource = 'file' | 'command';

function commandBufferEquivalence(script: string): string | undefined {
  const sources = new Map<string, ByteSource>();
  const assignment = /(?:^|[;{}]\s*|\n\s*)(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^;\r\n]+)/gm;
  for (const match of script.matchAll(assignment)) {
    const expression = match[2];
    if (/\breadFileSync\s*\(/.test(expression)) sources.set(match[1], 'file');
    else if (/\b(?:execFileSync|spawnSync)\s*\(/.test(expression)) sources.set(match[1], 'command');
  }

  const sourceOf = (operand: string): ByteSource | undefined => {
    if (/\breadFileSync\s*\(/.test(operand)) return 'file';
    const variable = /^([A-Za-z_$][\w$]*)(?:\.stdout)?$/.exec(operand)?.[1];
    return variable ? sources.get(variable) : undefined;
  };

  const equality = /((?:[A-Za-z_$][\w$]*\.)?readFileSync\s*\([^)]*\)|[A-Za-z_$][\w$]*)\.equals\s*\(\s*([A-Za-z_$][\w$]*(?:\.stdout)?)\s*\)/g;
  for (const match of script.matchAll(equality)) {
    if (match.index === undefined) continue;
    const left = sourceOf(match[1]);
    const right = sourceOf(match[2]);
    if (!left || !right || left === right) continue;
    const prefix = script.slice(Math.max(0, match.index - 240), match.index);
    const suffix = script.slice(match.index + match[0].length, match.index + match[0].length + 260);
    if (!/!\s*$/.test(prefix) || !/(?:throw\b|process\.exit\s*\(\s*[1-9])/.test(suffix)) continue;
    return `${match[1]}.equals(${match[2]}) compares file bytes with command output`;
  }
  return undefined;
}

function copyEquivalenceEvidence(script: string): string | undefined {
  const cmp = comparisonOperands(script, 'cmp');
  if (cmp) return `cmp ${cmp.join(' ')}`;
  const diff = comparisonOperands(script, 'diff');
  if (diff) return `diff --brief ${diff.join(' ')}`;
  const catEquality = script.match(/(?:test\s+)?["']?\$\(\s*cat\s+[^)]+\)["']?\s*(?:=|==)\s*["']?\$\(\s*cat\s+[^)]+\)["']?/m)?.[0];
  if (catEquality) return catEquality;
  const variableBuffers = variableBufferEquivalence(script);
  if (variableBuffers) return variableBuffers;
  const commandBuffer = commandBufferEquivalence(script);
  if (commandBuffer) return commandBuffer;
  const bufferEquality = script.match(/Buffer\.compare\s*\([^)]*readFileSync[\s\S]{0,240}readFileSync|readFileSync\s*\([^)]*\)\.equals\s*\(\s*readFileSync/m)?.[0];
  if (bufferEquality) return bufferEquality;
  const digestCommands = script.match(/\b(?:sha(?:1|224|256|384|512)sum|md5sum|cksum)\b/g) ?? [];
  if (digestCommands.length >= 2 && /(?:^|\s)(?:=|==)(?:\s|$)/m.test(script)) {
    return `${digestCommands[0]} / ${digestCommands[1]} equality`;
  }
  return undefined;
}

function literalFragments(pattern: string): string[] {
  const unescaped = pattern.replace(/\\([/._-])/g, '$1');
  const fragments = [...unescaped.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\//g)]
    .map((match) => match[0]);
  if (/^[A-Za-z0-9_./-]{3,}$/.test(unescaped)) fragments.push(unescaped);
  return [...new Set(fragments.map((fragment) => fragment.replace(/^\/+/, '').replace(/\/+$/, '')))]
    .filter((fragment) => fragment.length >= 3);
}

function scopeCoversStatement(scope: string, statement: ExceptionStatement): boolean {
  const normalizedScope = normalizeArtifactPath(scope);
  if (!normalizedScope) return false;
  if (normalizedScope === '.' || normalizedScope === '**' || normalizedScope === '**/*') return true;
  return statement.paths.some((path) =>
    globPattern(normalizedScope).test(path)
    || normalizedScope.endsWith(`/${path}`)
    || path.endsWith(`/${normalizedScope}`));
}

interface ForbiddenSearch {
  patterns: string[];
  scopes: string[];
  allowanceScopes?: string[];
}

function forbiddenSearch(command: string, scopes: string[] = extractPathTokens(command)): ForbiddenSearch {
  const quoted = [...command.matchAll(/(['"])([^'"\r\n]{3,})\1/g)].map((match) => match[2]);
  return { patterns: quoted, scopes };
}

function explicitAllowanceScopes(
  script: string,
  flow: string,
  hitVariable: string,
  patterns: readonly string[],
): string[] {
  // Recognize only the narrow, auditable shape where a negated allowance is
  // conjoined with the hit and its assignment names the exact searched literal.
  // More general JavaScript control-flow semantics remain outside this lint.
  const hitIndex = flow.indexOf(hitVariable);
  if (hitIndex < 0) return [];
  const beforeHit = flow.slice(0, hitIndex);
  const afterHit = flow.slice(hitIndex + hitVariable.length);
  const allowanceVariable = /!\s*([A-Za-z_$][\w$]*)\s*&&[\s(]*$/.exec(beforeHit)?.[1]
    ?? /^[\s)]*&&\s*!\s*([A-Za-z_$][\w$]*)\b/.exec(afterHit)?.[1];
  if (!allowanceVariable) return [];

  for (const assignment of script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\r\n]+)\s*;/g)) {
    if (assignment[1] !== allowanceVariable) continue;
    const literals = [...assignment[2].matchAll(/(['"])([^'"\r\n]{3,})\1/g)]
      .map((match) => match[2]);
    if (!patterns.some((pattern) => literals.includes(pattern))) return [];
    return [...new Set(literals
      .filter((literal) => !patterns.includes(literal))
      .map((literal) => normalizeArtifactPath(literal)
        ?? (/^\.[A-Za-z0-9_.-]+$/.test(literal) ? literal : undefined))
      .filter((scope): scope is string => scope !== undefined))];
  }
  return [];
}

function allowanceCoversStatement(scopes: readonly string[], statement: ExceptionStatement): boolean {
  return scopes.some((scope) =>
    scopeCoversStatement(scope, statement)
    || statement.text.includes(`\`${scope}\``)
    || (scope === '.gitignore' && /\b(?:gitignore|ignore file|ignore configuration)\b/i.test(statement.text)));
}

function forbiddenSearches(script: string): ForbiddenSearch[] {
  const searches: ForbiddenSearch[] = [];

  const shellIf = /\bif\s+(!\s*)?((?:grep|rg)\b[\s\S]{0,400}?)\s*;\s*then\b([\s\S]{0,400}?)\bfi\b/gi;
  for (const match of script.matchAll(shellIf)) {
    if (match[1] || !/\b(?:exit\s+[1-9]\d*|false)\b/i.test(match[3])) continue;
    searches.push(forbiddenSearch(match[2]));
  }

  const shellAndFailure = /\b((?:grep|rg)\b[^\r\n;&|]{0,300})\s*&&\s*(?:exit\s+[1-9]\d*|false)\b/gi;
  for (const match of script.matchAll(shellAndFailure)) searches.push(forbiddenSearch(match[1]));

  const fileVariables = readFileVariables(script);
  const nodeIf = /\bif\s*\(\s*(!\s*)?([A-Za-z_$][\w$]*)\.(?:includes|startsWith)\s*\(\s*(['"])([^'"\r\n]{3,})\3\s*\)\s*\)\s*(\{[\s\S]{0,300}?\}|(?:process\.)?exit\s*\(\s*[1-9][^;]*;|throw\b[^;]*;)/g;
  for (const match of script.matchAll(nodeIf)) {
    if (match[1] || !/(?:process\.)?exit\s*\(\s*[1-9]|\bthrow\b/.test(match[5])) continue;
    const path = fileVariables.get(match[2]);
    if (path) searches.push({ patterns: [match[4]], scopes: [path] });
  }

  // Planner checks also enumerate a file set and propagate a per-line literal
  // hit through a boolean and an error collection. Follow only that explicit
  // failure data flow; a standalone includes() call is not a forbidden scan.
  const enumeratedPresence = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\r\n]*\.includes\s*\(\s*(['"])([^'"\r\n]{3,})\2\s*\)\s*;/g;
  for (const match of script.matchAll(enumeratedPresence)) {
    if (match.index === undefined) continue;
    const tail = script.slice(match.index + match[0].length, match.index + match[0].length + 1_600);
    const push = new RegExp(`\\b${match[1]}\\b[\\s\\S]{0,180}\\b([A-Za-z_$][\\w$]*)\\.push\\s*\\(`).exec(tail);
    if (!push) continue;
    const failure = new RegExp(`\\bif\\s*\\(\\s*${push[1]}\\.length\\s*\\)[\\s\\S]{0,220}(?:throw\\b|process\\.exit\\s*\\(\\s*[1-9])`).test(tail);
    if (failure) {
      const prefix = tail.slice(Math.max(0, push.index - 300), push.index);
      const guardStarts = [...prefix.matchAll(/\bif\s*\(/g)];
      const guardStart = guardStarts.at(-1)?.index;
      const flow = guardStart === undefined ? push[0] : prefix.slice(guardStart) + push[0];
      searches.push({
        patterns: [match[3]],
        scopes: [],
        allowanceScopes: explicitAllowanceScopes(script, flow, match[1], [match[3]]),
      });
    }
  }

  return searches;
}

function exceptionConflict(declaration: Exclude<CheckDecl, { kind: 'invalid' }>, contract: BriefContractModel): ExceptionStatement | undefined {
  const params = record(declaration.params) ?? {};
  if (declaration.type === 'static-ast-scan'
      && typeof params.forbid_pattern === 'string'
      && typeof params.glob === 'string') {
    const fragments = literalFragments(params.forbid_pattern);
    return contract.exceptions.find((statement) =>
      fragments.some((fragment) => statement.text.includes(fragment))
      && scopeCoversStatement(params.glob as string, statement));
  }
  if (declaration.type !== 'exec-script-exit-zero' || typeof params.script !== 'string') return undefined;
  for (const search of forbiddenSearches(params.script)) {
    const fragments = search.patterns.flatMap(literalFragments);
    const conflict = contract.exceptions.find((statement) =>
      fragments.some((fragment) => statement.text.includes(fragment))
      && (search.scopes.length === 0 || search.scopes.some((scope) => scopeCoversStatement(scope, statement)))
      && !allowanceCoversStatement(search.allowanceScopes ?? [], statement));
    if (conflict) return conflict;
  }
  return undefined;
}

function infallibleHardScript(script: string): string | undefined {
  const executable = script
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/;\s*$/, '')
    .trim();
  if (/^(?:(?:true|:)(?:\s*(?:;|&&)\s*)?)+$/.test(executable)) return executable;
  if (/^exit\s+0$/.test(executable)) return executable;
  return undefined;
}

function finding(
  declaration: CheckDecl,
  checkIndex: number,
  code: RealityCheckPreflightCode,
  message: string,
  evidence?: string,
): RealityCheckPreflightFinding {
  const tier: RealityCheckPreflightTier = code === 'copy_byte_equivalence' || code === 'hard_check_cannot_fail'
    ? 'blocking'
    : code === 'invalid_reality_check_declaration'
      ? 'structural'
      : 'advisory';
  return {
    code,
    checkIndex,
    checkName: declaration.name,
    checkType: declaration.type,
    message,
    tier,
    blocking: tier !== 'advisory',
    ...(evidence ? { evidence } : {}),
  };
}

interface RealityCheckYamlRange {
  start: number;
  end: number;
  source: string;
}

function latestRealityCheckYamlRange(markdown: string): RealityCheckYamlRange | undefined {
  const headings = [...markdown.matchAll(/^## Reality checks[^\n]*(?:\n|$)/gm)];
  for (const heading of headings.reverse()) {
    if (heading.index === undefined) continue;
    const sectionStart = heading.index + heading[0].length;
    const rest = markdown.slice(sectionStart);
    const nextHeading = rest.search(/^##\s/m);
    const sectionEnd = sectionStart + (nextHeading >= 0 ? nextHeading : rest.length);
    const section = markdown.slice(sectionStart, sectionEnd);
    const leadingLength = /^\s*/.exec(section)?.[0].length ?? 0;
    const trailingLength = /\s*$/.exec(section)?.[0].length ?? 0;
    const trimmedEnd = Math.max(leadingLength, section.length - trailingLength);
    const trimmed = section.slice(leadingLength, trimmedEnd);
    const fenceOpen = /^```(?:ya?ml)?[^\S\r\n]*\r?\n/.exec(trimmed);
    const fenceClose = /\r?\n```$/.exec(trimmed);
    if (fenceOpen && fenceClose) {
      const start = sectionStart + leadingLength + fenceOpen[0].length;
      const end = sectionStart + leadingLength + trimmed.length - fenceClose[0].length;
      return { start, end, source: markdown.slice(start, end) };
    }
    if (trimmed) {
      const start = sectionStart + leadingLength;
      const end = sectionStart + trimmedEnd;
      return { start, end, source: markdown.slice(start, end) };
    }
  }
  return undefined;
}

/**
 * Preserve planner-authored checks while making intent-dependent findings
 * unable to false-block terminal success. The same YAML document parser used
 * by the inspector is used for the rewrite, including comment preservation.
 */
export function demoteRealityCheckAdvisories(
  realityChecksMarkdown: string,
  findings: readonly RealityCheckPreflightFinding[],
): RealityCheckAdvisoryRewrite {
  const indexes = [...new Set(findings
    .filter((item) => item.tier === 'advisory')
    .map((item) => item.checkIndex)
    .filter((index) => Number.isInteger(index) && index > 0))]
    .sort((left, right) => left - right);
  if (indexes.length === 0) return { markdown: realityChecksMarkdown, demotedCheckIndexes: [] };

  const range = latestRealityCheckYamlRange(realityChecksMarkdown);
  if (!range) return { markdown: realityChecksMarkdown, demotedCheckIndexes: [] };
  const document = parseDocument(range.source);
  if (document.errors.length > 0) return { markdown: realityChecksMarkdown, demotedCheckIndexes: [] };
  const parsed = record(document.toJS());
  if (!parsed || !Array.isArray(parsed.checks)) {
    return { markdown: realityChecksMarkdown, demotedCheckIndexes: [] };
  }

  const demotedCheckIndexes: number[] = [];
  for (const checkIndex of indexes) {
    const check = record(parsed.checks[checkIndex - 1]);
    if (!check || typeof check.name !== 'string' || typeof check.type !== 'string') continue;
    document.setIn(['checks', checkIndex - 1, 'advisory'], true);
    demotedCheckIndexes.push(checkIndex);
  }
  if (demotedCheckIndexes.length === 0) {
    return { markdown: realityChecksMarkdown, demotedCheckIndexes };
  }
  const rendered = document.toString().trimEnd();
  return {
    markdown: realityChecksMarkdown.slice(0, range.start) + rendered + realityChecksMarkdown.slice(range.end),
    demotedCheckIndexes,
  };
}

/**
 * Inspect exact planner-authored check markdown against the exact task brief.
 * This function is deterministic and performs no filesystem or process work.
 * It refuses only mechanically decisive relations; intent-dependent relations
 * remain visible advisory findings. Arbitrary shell semantics remain out of
 * scope.
 */
export function inspectRealityChecks(taskBrief: string, realityChecksMarkdown: string): RealityCheckPreflightReport {
  const declarations = parseChecksFromMarkdown(realityChecksMarkdown);
  const contract = deriveBriefContract(taskBrief);
  const findings: RealityCheckPreflightFinding[] = [];

  declarations.forEach((declaration, offset) => {
    const checkIndex = offset + 1;
    if (declaration.kind === 'invalid') {
      findings.push(finding(
        declaration,
        checkIndex,
        'invalid_reality_check_declaration',
        `The declaration would fail independently of any contract property: ${declaration.diagnostic}`,
      ));
      return;
    }
    if (declaration.advisory === true) return;
    const params = record(declaration.params) ?? {};

    if (declaration.type === 'exec-script-exit-zero' && typeof params.script === 'string') {
      const heading = exactHeadingProxy(params.script);
      if (heading && !contract.requiredHeadingLiterals.includes(heading.literal)) {
        findings.push(finding(
          declaration,
          checkIndex,
          'presentation_proxy_heading_literal',
          'An exact Markdown heading is decisive, so equivalent evidence under clearer wording can false-block the run.',
          heading.evidence,
        ));
      }

      const infallible = infallibleHardScript(params.script);
      if (infallible) {
        findings.push(finding(
          declaration,
          checkIndex,
          'hard_check_cannot_fail',
          'The hard script is mechanically guaranteed to exit zero, so it cannot test the property named by the check.',
          infallible,
        ));
      }
    }

    const conflict = exceptionConflict(declaration, contract);
    if (conflict) {
      findings.push(finding(
        declaration,
        checkIndex,
        'contract_exception_conflict',
        `The check forbids content that the brief explicitly preserves or permits at line ${conflict.line}.`,
        conflict.text,
      ));
    }

    if (declaration.type === 'file-exists-nonempty' && Array.isArray(params.paths)) {
      for (const path of params.paths) {
        if (typeof path !== 'string' || artifactIsRequired(path, contract)) continue;
        findings.push(finding(
          declaration,
          checkIndex,
          'undeclared_artifact_existence',
          `The hard existence check targets \`${path}\`, which no terminal, framework, or explicit production obligation requires.`,
          path,
        ));
      }
    }

    if (declaration.type === 'exec-script-exit-zero'
        && typeof params.script === 'string'
        && !contract.requiresByteEquivalence) {
      const evidence = copyEquivalenceEvidence(params.script);
      if (evidence) {
        findings.push(finding(
          declaration,
          checkIndex,
          'copy_byte_equivalence',
          'The check makes equivalence between copies decisive even though the brief does not contract for byte identity.',
          evidence,
        ));
      }
    }
  });

  return {
    version: 1,
    checksInspected: declarations.length,
    findings,
    // Kept for consumers written before the severity split. Every entry here
    // originated in a declaration the planner made hard; its disposition is
    // carried by `tier`/`blocking` and by the collections below.
    blockingFindings: findings,
    blockingTierFindings: findings.filter((item) => item.tier === 'blocking'),
    advisoryFindings: findings.filter((item) => item.tier === 'advisory'),
    structuralFindings: findings.filter((item) => item.tier === 'structural'),
    refusingFindings: findings.filter((item) => item.tier === 'blocking' || item.tier === 'structural'),
  };
}

export function formatRealityCheckPreflightFindings(findings: readonly RealityCheckPreflightFinding[]): string {
  return findings
    .map((item) => `${item.code} [${item.tier}] (check ${item.checkIndex}, ${JSON.stringify(item.checkName)}): ${item.message}`)
    .join(' | ');
}
