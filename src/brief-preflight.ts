import { createHash } from 'node:crypto';
import { parseBriefFrontmatter } from './scheduler.js';
import { RUN_STATUS } from './store.js';
import { hasRealityChecksHeading, parseChecksFromMarkdown } from './reality-gate/index.js';

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
  findings: BriefPreflightFinding[];
  requiresAcknowledgement: boolean;
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
 * when the brief itself tells a stage to write them. So a floor whose glob matches no
 * path the brief ever mentions can never be satisfied, and the run cannot reach that
 * terminal status at all. Asking whether the brief mentions such a path is the cheapest
 * check that distinguishes "declared and arranged for" from "declared and unreachable".
 */
function briefMentionsFloorArtifact(brief: string, glob: string): boolean {
  const pattern = glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^\\s`\'"()\\[\\]]*');
  // Search the instructions, not the frontmatter. A `stage_glob:` declaration matches its
  // own pattern, so including the frontmatter would make every explicitly configured floor
  // look arranged-for and leave the warn branch dead — caught by a reverse test, not review.
  return new RegExp(pattern).test(briefBody(brief));
}

/** The brief minus a leading YAML frontmatter block, if present. */
function briefBody(brief: string): string {
  if (!brief.startsWith('---\n') && !brief.startsWith('---\r\n')) return brief;
  const end = brief.indexOf('\n---', brief.indexOf('\n') + 1);
  return end === -1 ? brief : brief.slice(brief.indexOf('\n', end + 1) + 1);
}

/** Inspect one exact brief string without reading or changing project state. */
export function inspectBrief(brief: string): BriefPreflightReport {
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

  const rc = parsed.research;
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
      if (!glob || briefMentionsFloorArtifact(brief, glob)) continue;
      const configured = entry.stageGlob !== undefined;
      add({
        code: `terminal_floor_uncountable_${status}`,
        // An explicit `stage_glob` is the author taking responsibility for the pattern, so
        // it warns; relying on the inferred pattern while never asking for those files is
        // the actual defect signature, so it fails.
        level: configured ? 'warn' : 'fail',
        message: `terminal ${status} floor counts fresh files matching ${configured ? 'stage_glob' : 'the inferred stage_glob'} \`${glob}\`, but this brief never asks any stage to write such a file. Nothing in the engine writes them, so the count stays at 0 and \`${status}\` is unreachable. Either use \`min_wall_minutes\` alone — that is a hard gate on elapsed time — or require those files in the brief and set \`stage_glob\` explicitly.`,
        acknowledgementRequired: true,
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

  return {
    version: 1,
    digest,
    inputKind,
    frontmatter,
    contractReady: !findings.some((finding) => finding.level === 'fail'),
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
): BriefAdmissionVerification {
  const report = inspectBrief(brief);
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
  const findingsMatch = expectedFingerprints.length === recordedFingerprints.length
    && expectedFingerprints.every((fingerprint, index) => fingerprint === recordedFingerprints[index]);
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
