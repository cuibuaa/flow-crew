import { createHash } from 'node:crypto';
import { parseBriefFrontmatter } from './scheduler.js';
import { RUN_STATUS } from './store.js';
import { hasRealityChecksHeading, parseChecksFromMarkdown } from './reality-gate/index.js';
import {
  extractBriefPathMentions,
  extractDeclaredBriefInputPaths,
  normalizeBriefInputPath,
} from './ship-inputs.js';
import { isNegatedRequirementLine } from './brief-negation.js';
import {
  evaluateResearchFeasibility,
  type ResearchFeasibilityEvaluation,
} from './research-feasibility.js';

export interface CriterionLintWarning {
  line: number;
  excerpt: string;
  risk: string;
  suggestion: string;
}

export interface BriefPreflightFinding {
  code: string;
  fingerprint: string;
  level: 'ok' | 'warn' | 'fail';
  message: string;
  acknowledgementRequired: boolean;
  line?: number;
  excerpt?: string;
  risk?: string;
  suggestion?: string;
}

export interface BriefPreflightReport {
  version: 1;
  digest: string;
  inputKind: 'brief' | 'plain_text';
  frontmatter: {
    status: 'absent' | 'valid' | 'invalid';
    error?: string;
  };
  contractReady: boolean;
  researchFeasibility?: ResearchFeasibilityEvaluation[];
  findings: BriefPreflightFinding[];
  requiresAcknowledgement: boolean;
}

export interface BriefPreflightContext {
  /** Literal ignored files or directory prefixes, supplied by the project-aware caller. */
  gitignoredPathPrefixes?: readonly string[];
}

export type BriefAdmissionAcknowledgement =
  | { kind: 'not_required' }
  | {
      kind: 'explicit';
      source: 'cli_current_input_flag' | 'cli_digest_flag' | 'dashboard_receipt';
      at: string;
    }
  | {
      kind: 'derived';
      source: 'campaign_loop';
      at: string;
      parentDigest: string;
      transformation: 'outer_loop_directive_v1';
    };

export interface BriefAdmissionRecord {
  version: 1;
  reportVersion: 1;
  digest: string;
  findingFingerprints: string[];
  acknowledgement: BriefAdmissionAcknowledgement;
}

export interface BriefAdmissionVerification {
  report: BriefPreflightReport;
  status: 'valid' | 'missing' | 'digest_mismatch' | 'acknowledgement_missing';
}

const INSTRUMENT_DIRECTIVE = /(?:源码.{0,16}(?:必须|务必).{0,16}(?:有|出现|包含|调用|导入|引入|实例化|构造|使用))|(?:(?:必须|务必|应当|需要).{0,28}?(?:出现|含有|包含|调用|导入|引入|实例化|构造|使用))|(?:\b(?:must|shall|required\s+to)\s+(?:directly\s+)?(?:contain|include|import|call|invoke|instantiate|construct|use)\b)/i;
const CODE_SHAPED_TARGET = /`[^`\n]+`|(?:^|\s)[\w./-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|sh|ya?ml|json|toml|md)(?:\b|$)|\b(?:new\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b(?:[a-z]+[A-Z][A-Za-z0-9_$]*|[A-Z]{3,}[A-Za-z0-9_$]*)\b/;
// A bare package can be code-shaped only through its relationship to a module
// operation. Requiring adjacency avoids treating ordinary nouns as identifiers.
const BARE_MODULE_TARGET = /(?:\b(?:import|require)\s+(?!the\b|an?\b)["']?(?:@[a-z0-9][\w.-]*\/)?[a-z][a-z0-9]*(?:[-./][a-z0-9][a-z0-9._-]*)*["']?\s*(?=$|[.,;:!?，。；：！？)]|\band\b)|\b(?:@[a-z0-9][\w.-]*\/)?[a-z][a-z0-9]*(?:[-./][a-z0-9][a-z0-9._-]*)*\b\s*(?:的\s*(?:import|require|导入|引入|实例化)|(?:导入|引入|实例化)))/i;
const ILLUSTRATIVE_MARKER = /(?:例如|比如|举例|只是例子|并非判据|不是判据|可参考|故意写坏|断言告警|\be\.g\.|\bfor example\b|\bsuch as\b|\billustrative\b)/i;
const EXACT_MEANS_MARKER = /(?:该手段本身.{0,8}(?:是|作为).{0,8}判据|精确手段.{0,8}判据|替代手段不算|(?:必须|验收必须)包含(?:一次)?.{0,40}(?:走查|实测|测试|检查)|alternatives? do(?:es)? not count|exact (?:method|means).{0,12}criterion)/i;
const OBSERVABLE_PLACEMENT = /(?:显示|展示|呈现|出现在).{0,16}`\/[A-Za-z0-9_/-]+`/;
const STRUCTURAL_LINE = /^(?:---(?:\s|$)|#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|```|~~~|\*\*|__)/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * High-confidence warning for criteria that bind success to an implementation
 * instrument. It deliberately favors low noise over recall.
 */
export function lintInstrumentCriteria(text: string): CriterionLintWarning[] {
  const lines = text.split(/\r\n|\n|\r/);
  const warnings: CriterionLintWarning[] = [];
  let inFence = false;
  let illustrativeList = false;

  for (let index = 0; index < lines.length; index++) {
    const original = lines[index];
    const trimmed = original.trim();
    if (/^```|^~~~/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (ILLUSTRATIVE_MARKER.test(trimmed) && /[:：]\s*$/.test(trimmed)) {
      illustrativeList = true;
      continue;
    }
    if (illustrativeList) {
      if (!trimmed || /^[-*+]\s|^\d+[.)]\s/.test(trimmed)) continue;
      illustrativeList = false;
    }
    if (!trimmed || /^>/.test(trimmed) || /^["“].*["”](?:\s*[-—(（]|\s*$)/.test(trimmed)) continue;

    const normalized = trimmed.replace(/\*\*|__/g, '');
    if (
      ILLUSTRATIVE_MARKER.test(normalized)
      || EXACT_MEANS_MARKER.test(normalized)
      || OBSERVABLE_PLACEMENT.test(normalized)
    ) continue;
    if (
      !INSTRUMENT_DIRECTIVE.test(normalized)
      || !(CODE_SHAPED_TARGET.test(normalized) || BARE_MODULE_TARGET.test(normalized))
    ) continue;

    warnings.push({
      line: index + 1,
      excerpt: trimmed,
      risk: 'This wording makes a specific implementation instrument mandatory, so an acceptance gate may promote it into a hard assertion unrelated to the target property.',
      suggestion: 'State the observable property to prove. If the method is only illustrative, label it as an example rather than a criterion. If alternatives are forbidden, explicitly say that the exact method itself is the criterion.',
    });
  }
  return warnings;
}

function classifyInput(text: string): BriefPreflightReport['inputKind'] {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const nonEmpty = withoutBom.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
  if (nonEmpty.length !== 1) return 'brief';
  return STRUCTURAL_LINE.test(nonEmpty[0]) ? 'brief' : 'plain_text';
}

function findingFingerprint(input: Pick<BriefPreflightFinding, 'code' | 'level' | 'line' | 'excerpt'>): string {
  return sha256(JSON.stringify([
    input.code,
    input.level,
    input.line ?? null,
    input.excerpt ?? null,
  ]));
}

function makeFinding(
  finding: Omit<BriefPreflightFinding, 'fingerprint'>,
): BriefPreflightFinding {
  return { ...finding, fingerprint: findingFingerprint(finding) };
}

/**
 * Resolve the glob a stage-count floor will actually count, mirroring
 * `evaluateTerminalFloor`: the configured `stage_glob`, or
 * `<dir of the first declared path>/stage_*_verdict.md` when it is absent.
 */
function resolveFloorStageGlob(entry: { paths: string[]; stageGlob?: string }): string | undefined {
  if (entry.stageGlob) return entry.stageGlob;
  const first = entry.paths[0];
  if (!first) return undefined;
  const directory = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '.';
  return `${directory}/stage_*_verdict.md`;
}

/**
 * Nothing in the engine writes the files a stage-count floor counts — they exist only
 * when the brief itself tells a stage to write them. A fully arranged contract therefore
 * needs both an explicit glob and an authored write instruction for matching evidence.
 */
const ARTIFACT_WRITE_DIRECTIVE = /\b(?:write|writes|create|creates|produce|produces|generate|generates|emit|emits|save|saves)\b/i;
const ASSIGNED_PASSIVE_ARTIFACT_WRITE = /\b(?:(?:must|shall|should|will|needs?|is|are)\s+(?:to\s+)?be\s+(?:written|created|produced|generated|emitted|saved)|(?:written|created|produced|generated|emitted|saved)\s+by\s+(?:the\s+)?(?:[\w-]+\s+){0,3}(?:stage|phase|gate))\b/i;
const ASSIGNED_ARTIFACT_NOUN = /^(?:\s*(?:(?:[-*+]|\d+[.)])\s+))?(?:(?:the\s+)?(?:[\w-]+\s+){0,3}(?:stage|phase|gate)(?:\s+[\w.-]+){0,2}(?:'s)?\s*(?::|[-–—])?\s*)?(?:the\s+)?(?:(?:final|required|expected)\s+)?(?:deliverables?|outputs?|artifacts?|files\s+written)\s*(?::|[-–—]|(?:is|are|must|shall|should|will|needs?)\s+(?:to\s+)?(?:be\s+)?)\s*/i;
const NEGATED_ARTIFACT_WRITE = /\b(?:(?:do|does|must|shall|should|will)\s+not\s+(?:write|create|produce|generate|emit|save)|never\s+(?:write|create|produce|generate|emit|save)|no\s+(?:earlier|non-final|implementation|mid-pipeline)?\s*(?:stage|phase|gate)?\s*(?:may|must|should|will)?\s*(?:write|create|produce|generate|emit|save)|nothing\b.{0,24}\bwrites?\b|without\s+writing)\b/i;

function assignsArtifactWrite(line: string): boolean {
  return ARTIFACT_WRITE_DIRECTIVE.test(line)
    || ASSIGNED_PASSIVE_ARTIFACT_WRITE.test(line)
    || ASSIGNED_ARTIFACT_NOUN.test(line);
}

function artifactPattern(value: string): RegExp {
  const pattern = value
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^\\s`\'"()\\[\\]]*');
  return new RegExp(`${pattern}(?=$|[\\s\`'"()\\[\\],.;:])`);
}

function linesRequireArtifactWrite(lines: string[], pattern: RegExp): boolean {
  let listWritesArtifacts = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) listWritesArtifacts = false;
    if (/^(?:deliverables?|outputs?|artifacts?|files\s+written)\s*:\s*$/i.test(trimmed)) {
      listWritesArtifacts = true;
      continue;
    }
    if (!trimmed) continue;
    pattern.lastIndex = 0;
    if (!pattern.test(line)) {
      if (listWritesArtifacts && !/^[-*+]\s|^\d+[.)]\s/.test(trimmed)) listWritesArtifacts = false;
      continue;
    }
    if (NEGATED_ARTIFACT_WRITE.test(line)) continue;
    if (listWritesArtifacts || assignsArtifactWrite(line)) return true;
  }
  return false;
}

function briefRequiresFloorArtifact(brief: string, glob: string): boolean {
  // Search the instructions, not the frontmatter. A `stage_glob:` declaration matches its
  // own pattern, so including the frontmatter would make every explicitly configured floor
  // look arranged-for and leave the warn branch dead — caught by a reverse test, not review.
  return linesRequireArtifactWrite(briefBody(brief).split(/\r\n|\n|\r/), artifactPattern(glob));
}

function bodyLineOffset(brief: string): number {
  const body = briefBody(brief);
  return brief.slice(0, brief.indexOf(body)).split(/\r\n|\n|\r/).length - 1;
}

/** The brief minus a leading YAML frontmatter block, if present. */
function briefBody(brief: string): string {
  if (!brief.startsWith('---\n') && !brief.startsWith('---\r\n')) return brief;
  const end = brief.indexOf('\n---', brief.indexOf('\n') + 1);
  return end === -1 ? brief : brief.slice(brief.indexOf('\n', end + 1) + 1);
}

const HEADLINE_USAGE = /\b(?:headline|quoted?|quotable)\b/i;
const NUMERIC_RESULT = /\b(?:statistic|number|numeric|value|figure|estimate|metric|result|rate|percentage|percentile|basis points?|bps)\b/i;
const DISTRIBUTION_LOCATION = /(?:^|[^A-Za-z0-9])(?:percentile|quantile|rank|location|position)(?:$|[^A-Za-z0-9])|\bwhere\b.{0,40}\bsits?\b/i;
const PREREGISTRATION = /\b(?:pre[- ]?registr(?:ation|ations|er|ers|ered|ering)|preregistr(?:ation|ations|er|ers|ered|ering))\b/i;
const PREREGISTRATION_ARTIFACT = /\bpre[- _]?registr(?:ation|ations|er|ers|ered|ering)\b/i;
const RULE_NOUN = /\b(?:rule|rules|threshold|thresholds|criterion|criteria|cutoff|cutoffs|filter|filters|screen|screens|selection|selections)\b/i;
const RULE_FREEZE = /\b(?:freeze|freezes|freezing|frozen|lock|locks|locking|locked)\b/i;
const BEFORE_MEASUREMENT = /\bbefore\b.{0,80}\b(?:measur(?:e|es|ed|ement|ements|ing)|observ(?:e|es|ed|ation|ations|ing)|outcome|outcomes|result|results)\b/i;
const SELECTION_PROCEDURE_NOUN = /\b(?:rule|rules|threshold|thresholds|criterion|criteria|cutoff|cutoffs|filter|filters|screen|screens|selection|selections|protocol|protocols|signal|signals|grid|grids|parameter|parameters|construction|constructions)\b/i;
const BEFORE_OUTCOME_ACCESS = /\bbefore\b.{0,100}\b(?:measur(?:e|es|ed|ement|ements|ing)|observ(?:e|es|ed|ation|ations|ing)|outcomes?|results?|returns?|performance|prices?|evaluat(?:e|es|ed|ion|ions|ing)|tests?|testing|gold|comput(?:e|es|ed|ation|ing)|load(?:s|ed|ing)?|open(?:s|ed|ing)?)\b/i;
const FREEZE_THEN_MEASURE = /\b(?:freeze|freezes|freezing|frozen|lock|locks|locking|locked)\b.{0,100}\b(?:measur(?:e|es|ed|ing)|observ(?:e|es|ed|ing)|evaluat(?:e|es|ed|ing)|test(?:s|ed|ing)?|comput(?:e|es|ed|ing)|load(?:s|ed|ing)?|open(?:s|ed|ing)?)\b/i;
const DIRECT_RULE_COMMITMENT = /^(?:(?:d\d+|step\s+\d+|phase\s+\d+|signal|measurement|protocol|selection)\s*[\u2013\u2014:-]\s*)?(?:(?:before|prior\s+to)\b[^,;]{0,100},\s*)?(?:(?:first|next|then)\s*,?\s+)?(?:please\s*,?\s+)?(?:pre[- ]?register|preregister|freeze|lock|choose|select|set|define|declare|adopt)\b(?!\s+(?:no|zero|nothing)\b)/i;
const LABELED_FROZEN_RULE_COMMITMENT = /^(?:frozen|locked)\s+(?:(?:selection|screening|decision|eligibility|inclusion|exclusion)\s+)?(?:rule|rules|threshold|thresholds|criterion|criteria|cutoff|cutoffs|filter|filters|screen|screens|selection|selections)\s*:/i;
const TASK_OWNER_RULE_COMMITMENT = /^(?:(?:before|prior\s+to)\b[^,;]{0,100},\s*)?(?:(?:this|the)\s+(?:task|run|round|stage|phase)|we|you|(?:the\s+)?(?:(?:lead|assigned|responsible|implementing|measuring|validation)\s+)*(?:researcher|analyst|investigator|operator|agent|worker|team|author)|(?:the\s+)?(?:[\w-]+\s+){1,3}(?:stage|phase|gate))\s+(?:must|shall|will|needs?\s+to|(?:is|are)\s+(?:required\s+)?to)\s+(?:(?:first|then|also|directly|explicitly)\s+)*(?:pre[- ]?register|preregister|freeze|lock|choose|select|set|define|declare|adopt)\b(?!\s+(?:no|zero|nothing)\b)/i;
const PASSIVE_RULE_COMMITMENT = /^(?:(?:before|prior\s+to)\b[^,;]{0,100},\s*)?(?:(?:the|this|each|every|a|an)\s+)?(?:(?:final|chosen|declared|specified|candidate)\s+)*(?:(?:selection|screening|decision|eligibility|inclusion|exclusion)\s+)?(?:rule|rules|threshold|thresholds|criterion|criteria|cutoff|cutoffs|filter|filters|screen|screens|selection|selections)\s+(?:(?:must|shall|will|needs?\s+to)\s+be|(?:is|are)\s+(?:required\s+to\s+be|to\s+be))\s+(?:pre[- ]?registered|preregistered|frozen|locked|chosen|selected|set|defined|declared|adopted)\b/i;
const DIRECT_ARTIFACT_COMMITMENT = /^(?:(?:before|prior\s+to)\b[^,;]{0,100},\s*)?(?:please\s*,?\s+)?(?:write|create|record|produce|declare)\s+(?:(?:the|this|a|an|your|our|its)\s+)?(?:`[^`]*\bpre[- _]?registr(?:ation|ations|er|ers|ered|ering)\b[^`]*`|pre[- ]?registration\b(?!\s+(?:detector|check|lint|guide|documentation|test|fixture)\b))/i;
const TASK_OWNER_ARTIFACT_COMMITMENT = /^(?:(?:before|prior\s+to)\b[^,;]{0,100},\s*)?(?:(?:this|the)\s+(?:task|run|round|stage|phase)|we|you|(?:the\s+)?(?:(?:lead|assigned|responsible|implementing|measuring|validation)\s+)*(?:researcher|analyst|investigator|operator|agent|worker|team|author)|(?:the\s+)?(?:[\w-]+\s+){1,3}(?:stage|phase|gate))\s+(?:must|shall|will|needs?\s+to|(?:is|are)\s+(?:required\s+)?to)\s+(?:(?:first|then|also|directly|explicitly)\s+)*(?:write|create|record|produce|declare)\s+(?:(?:the|this|a|an|your|our|its)\s+)?(?:`[^`]*\bpre[- _]?registr(?:ation|ations|er|ers|ered|ering)\b[^`]*`|pre[- ]?registration\b(?!\s+(?:detector|check|lint|guide|documentation|test|fixture)\b))/i;
const ASSIGNED_PREREGISTRATION_ARTIFACT = /^(?:`[^`]*\bpre[- _]?registr(?:ation|ations|er|ers|ered|ering)\b[^`]*`|(?:the\s+|this\s+|your\s+|our\s+)?pre[- ]?registration(?:\s+(?:artifact|file|protocol))?)\s*,?\s+(?:to\s+be\s+)?(?:written|created|recorded|produced|fixed|locked)\b/i;
const QUOTED_SOURCE_ATTRIBUTION = /\b(?:legacy|prior|earlier|historical)\b.{0,60}\b(?:instruction|directive|requirement|passage|text|documentation)\b|\b(?:instruction|directive|requirement|passage|text|documentation)\b.{0,60}\b(?:legacy|prior|earlier|historical)\b|\b(?:quoted?|excerpt(?:ed)?)\b.{0,60}\b(?:from|according\s+to)\b|\b(?:from|according\s+to)\b.{0,60}\b(?:guide|brief|run|round|stage|source|document(?:ation)?)\b/i;
const NUMERIC_LITERAL = /(?:^|[^A-Za-z0-9_])[-+−]?\d[\d,.]*(?:\s*(?:%|bps?|basis\s+points?))?(?=$|[^A-Za-z0-9_])/i;
const OPERATOR_EXPECTATION = /\b(?:operator|author|user)(?:'s)?\b.{0,60}\b(?:expect(?:s|ed|ation)?|prior|provid(?:e|es|ed)|suppl(?:y|ies|ied)|gave|given|hand(?:s|ed)?|figure|number|value|estimate)\b|\b(?:our|my)\s+(?:expected|prior|reference)\s+(?:figure|number|value|estimate|result)\b|\bexpected\s+(?:result|value|figure|estimate|number)\b/i;
const DECISION_ILLUSTRATIVE = /\b(?:for example|illustrative(?:ly)?|e\.g\.)\b|(?:例如|比如|举例|只是例子|并非判据|不是判据)/i;

function decisionLintLines(brief: string): string[] {
  const lines = briefBody(brief).split(/\r\n|\n|\r/);
  let illustrativeList = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (DECISION_ILLUSTRATIVE.test(trimmed)) {
      illustrativeList = /[:：]\s*$/.test(trimmed);
      return '';
    }
    if (illustrativeList) {
      if (!trimmed || /^[-*+]\s|^\d+[.)]\s/.test(trimmed)) return '';
      illustrativeList = false;
    }
    return line;
  });
}

/**
 * Satisfaction is intentionally conservative: merely naming evidence, especially while
 * prohibiting it, is not a requirement to produce it. False positives are safer here than
 * accepting a plausible result whose decision-grade checks were explicitly omitted.
 */
function decisionRequirementLines(brief: string): string[] {
  return decisionLintLines(brief).map((line) => isNegatedRequirementLine(line) ? '' : line);
}

function decisionRequirementBody(brief: string): string {
  return decisionRequirementLines(brief).join('\n');
}

function firstEvidenceLine(brief: string, pattern: RegExp): { line: number; excerpt: string } | undefined {
  const offset = bodyLineOffset(brief);
  const lines = decisionRequirementLines(brief);
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? undefined : { line: offset + index + 1, excerpt: lines[index].trim() };
}

/**
 * Deliberately broad textual property: explicit “headline”/“quoted” language
 * plus a numeric-result noun means the value is intended for prominent reuse.
 */
function headlineStatisticEvidence(brief: string): { line: number; excerpt: string } | undefined {
  const body = decisionRequirementBody(brief);
  if (!HEADLINE_USAGE.test(body) || !NUMERIC_RESULT.test(body)) return undefined;
  return firstEvidenceLine(brief, HEADLINE_USAGE) ?? firstEvidenceLine(brief, NUMERIC_RESULT);
}

function hasHeadlineDistribution(brief: string): boolean {
  const body = decisionRequirementBody(brief);
  return /(?:^|[^A-Za-z0-9])mean(?:$|[^A-Za-z0-9])/i.test(body)
    && /(?:^|[^A-Za-z0-9])median(?:$|[^A-Za-z0-9])/i.test(body)
    && DISTRIBUTION_LOCATION.test(body);
}

interface DecisionCommitmentUnit {
  line: number;
  excerpt: string;
  attributedQuote: boolean;
}

interface DecisionCommitmentBlock extends DecisionCommitmentUnit {
  endLine: number;
  quoted: boolean;
}

function decisionCommitmentBlocks(brief: string): DecisionCommitmentBlock[] {
  const offset = bodyLineOffset(brief);
  const lines = decisionLintLines(brief);
  const blocks: DecisionCommitmentBlock[] = [];
  let current: DecisionCommitmentBlock | undefined;

  const flush = () => {
    if (current) blocks.push(current);
    current = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      flush();
      continue;
    }
    const quoted = /^(?:>\s*)+/.test(trimmed);
    const content = trimmed.replace(/^(?:>\s*)+/, '').trim();
    if (!content) {
      flush();
      continue;
    }

    const line = offset + index + 1;
    if (quoted) {
      if (!current?.quoted) {
        flush();
        const previous = blocks.at(-1);
        current = {
          line,
          endLine: line,
          excerpt: content,
          quoted: true,
          attributedQuote: Boolean(previous
            && line - previous.endLine <= 2
            && ((!previous.quoted && QUOTED_SOURCE_ATTRIBUTION.test(previous.excerpt))
              || (previous.quoted && previous.attributedQuote))),
        };
      } else {
        current.excerpt += ` ${content}`;
        current.endLine = line;
      }
      continue;
    }
    if (current?.quoted) flush();
    if (/^#{1,6}\s+/.test(content) || /^\|/.test(content)) {
      flush();
      blocks.push({ line, endLine: line, excerpt: content, quoted: false, attributedQuote: false });
      continue;
    }
    if (/^(?:[-*+]\s+|\d+[.)]\s+)/.test(content)) {
      flush();
      current = { line, endLine: line, excerpt: content, quoted: false, attributedQuote: false };
      continue;
    }
    if (current) {
      current.excerpt += ` ${content}`;
      current.endLine = line;
    } else {
      current = { line, endLine: line, excerpt: content, quoted: false, attributedQuote: false };
    }
  }
  flush();
  return blocks;
}

function decisionCommitmentUnits(brief: string): DecisionCommitmentUnit[] {
  return decisionCommitmentBlocks(brief).flatMap((block) => {
    const normalized = block.excerpt
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/\*\*|__/g, '')
      .trim();
    return normalized
      .split(/(?:[;；]+|(?<=[.!?])\s+|\s+(?:but|however)\s+)/i)
      .map((excerpt) => excerpt.trim())
      .filter(Boolean)
      .map((excerpt) => ({ line: block.line, excerpt, attributedQuote: block.attributedQuote }));
  });
}

function isPositiveRuleCommitment(unit: DecisionCommitmentUnit): boolean {
  return !unit.attributedQuote
    && (DIRECT_RULE_COMMITMENT.test(unit.excerpt)
      || TASK_OWNER_RULE_COMMITMENT.test(unit.excerpt)
      || PASSIVE_RULE_COMMITMENT.test(unit.excerpt)
      || LABELED_FROZEN_RULE_COMMITMENT.test(unit.excerpt));
}

function isAssignedPreregistrationArtifact(unit: DecisionCommitmentUnit): boolean {
  if (unit.attributedQuote
      || !PREREGISTRATION_ARTIFACT.test(unit.excerpt)
      || !BEFORE_OUTCOME_ACCESS.test(unit.excerpt)) {
    return false;
  }
  return ASSIGNED_PREREGISTRATION_ARTIFACT.test(unit.excerpt)
    || DIRECT_ARTIFACT_COMMITMENT.test(unit.excerpt)
    || TASK_OWNER_ARTIFACT_COMMITMENT.test(unit.excerpt);
}

function preregistrationEvidence(brief: string): { line: number; excerpt: string } | undefined {
  const units = decisionCommitmentUnits(brief);
  const body = units.map((unit) => unit.excerpt).join('\n');
  const explicit = PREREGISTRATION.test(body) && RULE_NOUN.test(body);
  const frozenBeforeMeasurement = RULE_FREEZE.test(body)
    && RULE_NOUN.test(body)
    && (BEFORE_MEASUREMENT.test(body) || BEFORE_OUTCOME_ACCESS.test(body) || FREEZE_THEN_MEASURE.test(body));
  if (!explicit && !frozenBeforeMeasurement) return undefined;

  const evidence = units.find((unit) => {
    if (explicit && isAssignedPreregistrationArtifact(unit)) return true;
    if (explicit
        && PREREGISTRATION.test(unit.excerpt)
        && SELECTION_PROCEDURE_NOUN.test(unit.excerpt)
        && isPositiveRuleCommitment(unit)) return true;
    return frozenBeforeMeasurement
      && RULE_FREEZE.test(unit.excerpt)
      && RULE_NOUN.test(unit.excerpt)
      && (BEFORE_OUTCOME_ACCESS.test(unit.excerpt) || FREEZE_THEN_MEASURE.test(unit.excerpt))
      && isPositiveRuleCommitment(unit);
  });
  return evidence ? { line: evidence.line, excerpt: evidence.excerpt } : undefined;
}

function operatorFigureEvidence(brief: string): { line: number; excerpt: string } | undefined {
  const offset = bodyLineOffset(brief);
  const lines = decisionRequirementLines(brief);
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + 2).join(' ');
    if (OPERATOR_EXPECTATION.test(window) && NUMERIC_LITERAL.test(window)) {
      return { line: offset + index + 1, excerpt: lines[index].trim() };
    }
  }
  return undefined;
}

function normalizedIgnoredPrefix(raw: string): string | undefined {
  const trimmed = raw.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!trimmed) return undefined;
  return normalizeBriefInputPath(trimmed) ?? normalizeBriefInputPath(`${trimmed}/`);
}

function pathCovers(declaration: string, path: string): boolean {
  return declaration === path || path.startsWith(`${declaration}/`);
}

function namedStageAssignment(brief: string): { line: number; excerpt: string } | undefined {
  const body = briefBody(brief);
  const offset = bodyLineOffset(brief);
  const lines = body.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+).*(?:\bstage\s+(?:\d+|[A-Za-z][\w-]*)|\b(?:implementation|verification|verify|qa|reality|final)\s+(?:stage|gate|phase))\b/i.test(trimmed)) {
      return { line: offset + index + 1, excerpt: trimmed };
    }
  }
  return undefined;
}

function declaresPerStageWritablePaths(brief: string): boolean {
  const body = briefBody(brief);
  return /\bwritable paths?\s*,?\s*by stage\b/i.test(body)
    || /\bper-stage\s+(?:writable paths?|write scopes?)\b/i.test(body)
    || /\b(?:stage|phase|gate)\s+[\w.-]+[^\n:]{0,40}\b(?:writable paths?|write scope)\s*:/i.test(body);
}

function feasibilityDistributionText(evaluation: ResearchFeasibilityEvaluation): string {
  const summary = evaluation.distribution;
  if (!summary) return '';
  const location = summary.location;
  return ` Structural distribution: n=${summary.sampleSize}, mean=${summary.mean}, median=${summary.median}, spread=${summary.spread}, selected ${summary.selectedStatistic}=${summary.selectedValue}, rank=${location.lowerRank}-${location.upperRank}/${location.of}, midrank percentile=${location.percentile}.`;
}

/** Inspect one exact brief string without reading or changing project state. */
export function inspectBrief(
  brief: string,
  context: BriefPreflightContext = {},
): BriefPreflightReport {
  const digest = sha256(brief);
  const inputKind = classifyInput(brief);
  const parsed = parseBriefFrontmatter(brief);
  const hasFrontmatterFence = brief.startsWith('---\n') || brief.startsWith('---\r\n');
  const frontmatter: BriefPreflightReport['frontmatter'] = parsed.frontmatterError
    ? { status: 'invalid', error: parsed.frontmatterError }
    : hasFrontmatterFence
      ? { status: 'valid' }
      : { status: 'absent' };
  const findings: BriefPreflightFinding[] = [];
  const add = (finding: Omit<BriefPreflightFinding, 'fingerprint'>) => findings.push(makeFinding(finding));

  if (inputKind === 'plain_text') {
    add({
      code: 'plain_text_input',
      level: 'warn',
      message: 'This is a single-line plain-text request, so no structured brief contract was available to validate. Use `/ship` to author a guarded brief or run `flowcrew rehearse <brief.md>` before launch.',
      acknowledgementRequired: true,
      risk: 'An ad-hoc request can omit boundaries, success criteria, or a safe terminal contract.',
      suggestion: 'Author a structured brief with headings or YAML frontmatter, then rehearse it.',
    });
  } else {
    add({
      code: 'structured_input',
      level: 'ok',
      message: 'Structured brief shape detected',
      acknowledgementRequired: false,
    });
  }

  for (const warning of lintInstrumentCriteria(brief)) {
    add({
      code: 'criterion_instrument_wording',
      level: 'warn',
      message: `Criteria lint at line ${warning.line}: “${warning.excerpt}”`,
      acknowledgementRequired: true,
      ...warning,
    });
  }

  if (frontmatter.status === 'invalid') {
    add({
      code: 'frontmatter_invalid',
      level: 'fail',
      message: `Frontmatter parsing failed: ${frontmatter.error}`,
      acknowledgementRequired: true,
    });
  } else {
    add({
      code: frontmatter.status === 'valid' ? 'frontmatter_valid' : 'frontmatter_absent',
      level: 'ok',
      message: frontmatter.status === 'valid' ? 'Frontmatter parsed successfully' : 'No YAML frontmatter declared',
      acknowledgementRequired: false,
    });
  }

  const headline = headlineStatisticEvidence(brief);
  if (headline && !hasHeadlineDistribution(brief)) {
    add({
      code: 'headline_distribution_missing',
      level: 'fail',
      message: 'A headline or quoted statistic must require the mean, median, and where the reported value sits in its own distribution.',
      acknowledgementRequired: true,
      ...headline,
      risk: 'A plausible tail value can be reported as representative even when the distribution has a different center or sign.',
      suggestion: 'Require the result to report its mean, median, and percentile, quantile, rank, or equivalent location in the same distribution.',
    });
  }

  const rc = parsed.research;
  const preregistration = preregistrationEvidence(brief);
  let researchFeasibility: ResearchFeasibilityEvaluation[] | undefined;
  if (parsed.researchFeasibilityError) {
    add({
      code: 'research_feasibility_invalid',
      level: 'fail',
      message: `The declared research.feasibility contract is invalid: ${parsed.researchFeasibilityError}`,
      acknowledgementRequired: true,
      ...(preregistration ?? {}),
      risk: 'A malformed structural model cannot support a pre-run feasibility decision and must not be silently ignored.',
      suggestion: 'Use one documented research.feasibility model with finite structural inputs, a positive hard_floor, and unique labelled rules.',
    });
  } else if (parsed.researchFeasibility) {
    researchFeasibility = evaluateResearchFeasibility(parsed.researchFeasibility);
    for (const evaluation of researchFeasibility) {
      const distribution = feasibilityDistributionText(evaluation);
      if (evaluation.decision === 'not_computable') {
        add({
          code: 'research_feasibility_not_computable',
          level: 'warn',
          message: `Research feasibility “${evaluation.label}” cannot be computed from pre-run structural quantities: ${evaluation.reason} No qualifying-member count was synthesized.`,
          acknowledgementRequired: true,
          ...(preregistration ?? {}),
          risk: 'The run may still discover that the rule is empty, but inventing an expectation would be less honest than carrying the uncertainty explicitly.',
          suggestion: 'Measure the named structural distribution before a later run, then replace not_computable with a computable model.',
        });
      } else if (evaluation.decision === 'fail') {
        add({
          code: 'research_feasibility_below_floor',
          level: 'fail',
          message: `Research feasibility “${evaluation.label}” is ${evaluation.displayQualifyingMemberCount}, below hard_floor=${evaluation.hardFloor}.${distribution}`,
          acknowledgementRequired: true,
          ...(preregistration ?? {}),
          risk: 'The pre-registered selection rule is structurally infeasible before any outcome is measured.',
          suggestion: 'Revise or drop the rule before opening outcomes; do not tune it after measurement starts.',
        });
      } else if (evaluation.decision === 'warn') {
        add({
          code: 'research_feasibility_tight',
          level: 'warn',
          message: `Research feasibility “${evaluation.label}” is ${evaluation.displayQualifyingMemberCount}: it meets hard_floor=${evaluation.hardFloor} but is below warn_below=${evaluation.warnBelow}.${distribution}`,
          acknowledgementRequired: true,
          ...(preregistration ?? {}),
          risk: 'The rule is feasible on its declared hard floor but has little structural margin.',
          suggestion: 'Proceed only if the tight rule is intentional; otherwise revise it before outcomes are opened.',
        });
      } else {
        add({
          code: 'research_feasibility_ok',
          level: 'ok',
          message: `Research feasibility “${evaluation.label}” is ${evaluation.displayQualifyingMemberCount}, meeting hard_floor=${evaluation.hardFloor}${evaluation.warnBelow === undefined ? '' : ` and warn_below=${evaluation.warnBelow}`}.${distribution}`,
          acknowledgementRequired: false,
          ...(preregistration ?? {}),
        });
      }
    }
  } else if (preregistration) {
    add({
      code: 'preregistration_feasibility_missing',
      level: 'fail',
      message: 'A rule frozen before outcome measurement must declare a machine-readable research.feasibility model that computes its expected qualifying-member count or explicitly states why the structural quantity is not computable.',
      acknowledgementRequired: true,
      ...preregistration,
      risk: 'A prose promise to calculate later can let a structurally empty rule consume a full measurement round.',
      suggestion: 'Declare research.feasibility with a numeric minimum in positive hard_floor and labelled rules using a computable structural model or an honest not_computable reason.',
    });
  }

  const operatorFigure = operatorFigureEvidence(brief);
  const requiredDecisionEvidence = decisionRequirementBody(brief);
  if (operatorFigure
      && (!/\bwithin_expected_range\b/.test(requiredDecisionEvidence)
        || !/\bmethod_was_not_adjusted_to_match_expectation\b/.test(requiredDecisionEvidence))) {
    add({
      code: 'operator_figure_anti_anchoring_missing',
      level: 'fail',
      message: 'A supplied operator expectation must require both `within_expected_range` and `method_was_not_adjusted_to_match_expectation`.',
      acknowledgementRequired: true,
      ...operatorFigure,
      risk: 'Agreement with a supplied number is indistinguishable from a method adjusted to reproduce that number.',
      suggestion: 'Add both exact anti-anchoring fields to the result contract and require independent computation before comparison.',
    });
  }

  const ignoredPrefixes = (context.gitignoredPathPrefixes ?? [])
    .map(normalizedIgnoredPrefix)
    .filter((path): path is string => Boolean(path));
  if (ignoredPrefixes.length > 0) {
    const declared = extractDeclaredBriefInputPaths(brief);
    for (const mention of extractBriefPathMentions(brief)) {
      if (!ignoredPrefixes.some((prefix) => pathCovers(prefix, mention.path))) continue;
      if (declared.some((path) => pathCovers(path, mention.path))) continue;
      add({
        code: 'gitignored_input_undeclared',
        level: 'warn',
        message: `Gitignored path \`${mention.path}\` is referenced but not declared in the leading frontmatter \`inputs:\` block.`,
        acknowledgementRequired: true,
        ...mention,
        risk: 'Prose and table references do not make an ignored source reachable in a new worktree, so setup can report zero checked inputs.',
        suggestion: `Declare \`${mention.path}\` under leading frontmatter \`inputs:\`; keep any explanatory prose in addition to that declaration.`,
      });
    }
  }

  if (hasRealityChecksHeading(brief)) {
    const declarations = parseChecksFromMarkdown(brief);
    if (!declarations.some((declaration) => declaration.kind !== 'invalid')) {
      const parserDiagnostic = declarations.find((declaration) => declaration.kind === 'invalid')?.diagnostic;
      add({
        code: 'reality_checks_empty_or_invalid',
        level: 'fail',
        message: `A \`## Reality checks\` section was declared but produced no valid checks${parserDiagnostic ? `: ${parserDiagnostic}` : '. Declare at least one valid check under `checks:`.'}`,
        acknowledgementRequired: true,
      });
    }
  }

  if (!rc) {
    add({
      code: 'research_absent',
      level: 'warn',
      message: 'No `research:` block (engineering brief) — static contract checks only; the research loop was not simulated',
      acknowledgementRequired: false,
    });
  } else {
    add({
      code: 'research_valid',
      level: 'ok',
      message: `research: policy=${rc.policy} baseline=${rc.baseline} result_file=${rc.resultFile ?? '(default)'}`,
      acknowledgementRequired: false,
    });
    if (!rc.confirm) {
      add({
        code: 'research_confirm_missing',
        level: 'warn',
        message: 'No `research.confirm` declared — a ship decision would be accepted without a data check',
        acknowledgementRequired: true,
      });
    } else {
      add({
        code: 'research_confirm_valid',
        level: 'ok',
        message: `Confirm command declared: ${rc.confirm.command}`,
        acknowledgementRequired: false,
      });
    }
    if (rc.stop?.beat === undefined) {
      add({
        code: 'research_ship_target_missing',
        level: 'warn',
        message: 'No `stop.beat` declared — a ship decision will never be proposed (ceiling-only exploration)',
        acknowledgementRequired: true,
      });
    }
    if (rc.stop?.maxRounds === undefined && rc.stop?.maxWallHours === undefined && rc.stop?.haltAfterNoImprovement === undefined) {
      add({
        code: 'research_stop_rule_missing',
        level: 'warn',
        message: 'No stop rule declared — the loop is limited only by `max_iterations`',
        acknowledgementRequired: true,
      });
    }
  }

  const terminalStates = parsed.terminalStates;
  if (!terminalStates || Object.keys(terminalStates).length === 0) {
    add({
      code: 'terminal_states_missing',
      level: 'warn',
      message: 'No `terminal_states` declared — terminal artifact paths have no contract',
      acknowledgementRequired: true,
    });
  } else {
    for (const [status, entry] of Object.entries(terminalStates)) {
      const floorParts = entry.floor ? [
        entry.floor.minAttemptedStages === undefined ? '' : `stages≥${entry.floor.minAttemptedStages}`,
        entry.floor.minWallMinutes === undefined ? '' : `wall≥${entry.floor.minWallMinutes} min`,
      ].filter(Boolean) : [];
      add({
        code: `terminal_state_${status}`,
        level: 'ok',
        message: `terminal ${status}: paths=[${entry.paths.join(', ')}]${floorParts.length ? ` floor(${floorParts.join(', ')})` : ''}`,
        acknowledgementRequired: false,
      });
      if (entry.floor?.minWallMinutes !== undefined && entry.floor.minWallMinutes > 10) {
        add({
          code: `terminal_wall_floor_too_high_${status}`,
          level: 'warn',
          message: `Terminal ${status} sets min_wall_minutes=${entry.floor.minWallMinutes}. Wall time is a clock gate, not evidence that enough work happened, so reuse of existing machinery can finish correctly and still be forced to wait or miss the terminal.`,
          acknowledgementRequired: true,
          risk: 'A correct efficient run can be mislabeled or held solely because it completed faster than the author estimated.',
          suggestion: 'Use at most 10 minutes as an anti-instant-quit guard and name the evidence that proves work coverage instead of encoding an expected duration.',
        });
      }
    }
    // A stage-count floor is only satisfiable if something writes the files it counts.
    // The previous reachability check below is gated on `stop.max_rounds`, which only a
    // `research:` brief has, so an engineering brief could declare a floor that can never
    // be met and still be reported `Contract ready` — trading "terminates too early" for
    // "cannot terminate", which costs the whole budget and mislabels the terminal.
    for (const [status, entry] of Object.entries(terminalStates)) {
      if (entry.floor?.minAttemptedStages === undefined) continue;
      // A research loop's ceiling floor never globs: `evaluateResearchCeilingFloor` counts
      // measured rounds, precisely so the brief need not arrange evidence files. Flagging it
      // here would fail `examples/hello-research.brief.md`, the project's own showcase.
      if (status === RUN_STATUS.CEILING_HIT && rc) continue;
      const glob = resolveFloorStageGlob(entry);
      const configured = entry.stageGlob !== undefined;
      if (!glob || (configured && briefRequiresFloorArtifact(brief, glob))) continue;
      const inferredButMentioned = !configured && briefRequiresFloorArtifact(brief, glob);
      add({
        code: `terminal_floor_uncountable_${status}`,
        // An explicit `stage_glob` with no writer is an acknowledged but unreachable pattern,
        // so it warns. Omitting the counted contract entirely is the stronger defect and fails.
        level: configured ? 'warn' : 'fail',
        message: configured
          ? `terminal ${status} floor counts fresh files matching stage_glob \`${glob}\`, but this brief never asks any stage to write such a file. Nothing in the engine writes them, so the count stays at 0 and \`${status}\` is unreachable.`
          : `terminal ${status} sets min_attempted_stages without an explicit stage_glob. The engine would infer \`${glob}\`${inferredButMentioned ? ', and the brief mentions a matching write' : ''}, but the counted evidence contract must be explicit and assigned to a stage so it cannot drift or remain unreachable.`,
        acknowledgementRequired: true,
        risk: configured
          ? 'The evidence count remains zero, so the declared terminal status cannot be reached even after the substantive work is complete.'
          : 'An implicit counting pattern can diverge from the files stages actually own, making the terminal status miscount evidence or become unreachable.',
        suggestion: `Set stage_glob explicitly to \`${glob}\` (or the intended pattern) and require a stage to write concrete matching evidence files; otherwise remove min_attempted_stages and gate on named evidence.`,
      });
    }
    const floor = terminalStates.ceiling_hit?.floor;
    if (floor?.minAttemptedStages !== undefined && rc?.stop?.maxRounds !== undefined
        && floor.minAttemptedStages > rc.stop.maxRounds) {
      add({
        code: 'terminal_floor_unreachable',
        level: 'fail',
        message: `Ceiling floor is unreachable: it requires at least ${floor.minAttemptedStages} rounds, but stop.max_rounds=${rc.stop.maxRounds}; termination could only force a floor-unmet submission`,
        acknowledgementRequired: true,
      });
    }
    if (floor?.minAttemptedStages !== undefined && rc?.stop?.haltAfterNoImprovement !== undefined
        && rc.stop.haltAfterNoImprovement < floor.minAttemptedStages) {
      add({
        code: 'terminal_floor_defers_early_stop',
        level: 'ok',
        message: `floor(${floor.minAttemptedStages}) > halt_after_no_improvement(${rc.stop.haltAfterNoImprovement}): an early ceiling decision will be deferred as intended`,
        acknowledgementRequired: false,
      });
    }
  }

  const stageAssignment = namedStageAssignment(brief);
  if (stageAssignment && !declaresPerStageWritablePaths(brief)) {
    add({
      code: 'stage_writable_paths_missing',
      level: 'warn',
      message: `Named implementation/gate stages are assigned, but the brief has no explicit per-stage writable-path mapping (first assignment at line ${stageAssignment.line}).`,
      acknowledgementRequired: true,
      ...stageAssignment,
      risk: 'Without stage-specific write boundaries, an earlier stage can create a later or terminal artifact and silently skip required work.',
      suggestion: 'Add an explicit “Writable paths, by stage” mapping; a generic statement that stages may write files is not a scope declaration.',
    });
  }

  return {
    version: 1,
    digest,
    inputKind,
    frontmatter,
    contractReady: !findings.some((finding) => finding.level === 'fail'),
    ...(researchFeasibility === undefined ? {} : { researchFeasibility }),
    findings,
    requiresAcknowledgement: findings.some((finding) => finding.acknowledgementRequired),
  };
}

function consequentialFingerprints(report: BriefPreflightReport): string[] {
  return report.findings
    .filter((finding) => finding.acknowledgementRequired)
    .map((finding) => finding.fingerprint)
    .sort();
}

export function createBriefAdmission(
  report: BriefPreflightReport,
  acknowledgement: BriefAdmissionAcknowledgement,
): BriefAdmissionRecord {
  if (report.requiresAcknowledgement && acknowledgement.kind === 'not_required') {
    throw new Error('The brief report requires explicit acknowledgement');
  }
  return {
    version: 1,
    reportVersion: report.version,
    digest: report.digest,
    findingFingerprints: consequentialFingerprints(report),
    acknowledgement,
  };
}

export function verifyBriefAdmission(
  brief: string,
  record: BriefAdmissionRecord | undefined,
  context: BriefPreflightContext = {},
): BriefAdmissionVerification {
  const report = inspectBrief(brief, context);
  return { report, status: admissionStatusForReport(record, report) };
}

function admissionStatusForReport(
  record: BriefAdmissionRecord | undefined,
  report: BriefPreflightReport,
): BriefAdmissionVerification['status'] {
  if (!record || record.version !== 1 || record.reportVersion !== report.version) return 'missing';
  if (record.digest !== report.digest) return 'digest_mismatch';
  const expectedFingerprints = consequentialFingerprints(report);
  const recordedFingerprints = Array.isArray(record.findingFingerprints)
    && record.findingFingerprints.every((fingerprint) => typeof fingerprint === 'string')
    ? [...record.findingFingerprints].sort()
    : [];
  // A project-aware caller can record contextual findings (for example, a path
  // ignored in that exact repository) that a later scheduler-level verifier
  // cannot re-derive without project context. Every finding visible to the
  // current verifier must still be covered; an already acknowledged superset
  // remains valid for project-agnostic replay of the same exact brief bytes.
  const recordedCounts = new Map<string, number>();
  for (const fingerprint of recordedFingerprints) {
    recordedCounts.set(fingerprint, (recordedCounts.get(fingerprint) ?? 0) + 1);
  }
  const findingsMatch = expectedFingerprints.every((fingerprint) => {
    const remaining = recordedCounts.get(fingerprint) ?? 0;
    if (remaining === 0) return false;
    recordedCounts.set(fingerprint, remaining - 1);
    return true;
  });
  if (!findingsMatch || !validAcknowledgement(record.acknowledgement, report.requiresAcknowledgement)) {
    return 'acknowledgement_missing';
  }
  return 'valid';
}

function validAcknowledgement(
  acknowledgement: BriefAdmissionAcknowledgement | undefined,
  required: boolean,
): boolean {
  if (!acknowledgement || typeof acknowledgement !== 'object') return false;
  if (acknowledgement.kind === 'not_required') return !required;
  if (acknowledgement.kind === 'explicit') {
    return (acknowledgement.source === 'cli_current_input_flag'
      || acknowledgement.source === 'cli_digest_flag'
      || acknowledgement.source === 'dashboard_receipt')
      && typeof acknowledgement.at === 'string'
      && acknowledgement.at.length > 0;
  }
  return acknowledgement.kind === 'derived'
    && acknowledgement.source === 'campaign_loop'
    && typeof acknowledgement.at === 'string'
    && acknowledgement.at.length > 0
    && /^[0-9a-f]{64}$/.test(acknowledgement.parentDigest)
    && acknowledgement.transformation === 'outer_loop_directive_v1';
}

export function canDeriveBriefAdmission(
  parent: BriefAdmissionRecord,
  parentReport: BriefPreflightReport,
  childReport: BriefPreflightReport,
): boolean {
  if (admissionStatusForReport(parent, parentReport) !== 'valid') return false;
  if (parentReport.contractReady && !childReport.contractReady) return false;
  const parentConsequential = new Set(parent.findingFingerprints);
  return consequentialFingerprints(childReport).every((fingerprint) => parentConsequential.has(fingerprint));
}

export function formatBriefPreflightReport(report: BriefPreflightReport): string {
  const mark = { ok: '✓', warn: '⚠', fail: '✗' } as const;
  const lines = [
    'Brief preflight',
    `Digest: ${report.digest}`,
    `Input: ${report.inputKind === 'plain_text' ? 'single-line plain text' : 'structured brief'}`,
    `Frontmatter: ${report.frontmatter.status}${report.frontmatter.error ? ` — ${report.frontmatter.error}` : ''}`,
    `Contract: ${report.contractReady ? 'ready' : 'problems found'}`,
    '',
  ];
  for (const finding of report.findings) {
    lines.push(`${mark[finding.level]} [${finding.code}] ${finding.message}`);
    if (finding.risk) lines.push(`  Risk: ${finding.risk}`);
    if (finding.suggestion) lines.push(`  Suggestion: ${finding.suggestion}`);
  }
  lines.push('', report.requiresAcknowledgement
    ? 'Review required: this exact brief has consequential warnings or contract problems.'
    : 'No consequential findings require acknowledgement.');
  return lines.join('\n');
}
