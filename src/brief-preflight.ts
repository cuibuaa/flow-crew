import { parseBriefFrontmatterDocument, splitBriefFrontmatter } from './brief-frontmatter.js';
import { createHash } from 'node:crypto';
import { parseBriefFrontmatter } from './scheduler.js';
import { autoSelectedWorkflow } from './scheduler/sched_admission/brief-contract.js';
import { hasRealityChecksHeading, parseChecksFromMarkdown } from './reality-gate/index.js';
import { isNegatedRequirementLine, isNegatedRequirementMention } from './brief-negation.js';
import { extractBriefCriteria } from './brief-criteria.js';
import {
  evaluateResearchFeasibility,
  type ResearchFeasibilityEvaluation,
} from './research-feasibility.js';
import { assessResearchShipTarget } from './research-policy.js';
import { RUN_STATUS } from './store.js';

export interface BriefPreflightFinding {
  code: string;
  fingerprint: string;
  level: 'ok' | 'warn' | 'fail';
  message: string;
  consequential: boolean;
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
}

export type BriefAdmissionAcknowledgement =
  | { kind: 'not_required' }
  | {
      kind: 'explicit';
      source: 'cli_current_input_flag' | 'cli_digest_flag' | 'dashboard_receipt';
      at: string;
    };

export interface BriefAdmissionRecord {
  version: 1;
  digest: string;
  acknowledgement: BriefAdmissionAcknowledgement;
}

export interface BriefAdmissionVerification {
  digest: string;
  status: 'valid' | 'missing' | 'digest_mismatch';
}

const STRUCTURAL_LINE = /^(?:---(?:\s|$)|#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|```|~~~|\*\*|__)/;

type LogicalProseKind = 'prose' | 'heading' | 'list' | 'quote' | 'table' | 'boundary';

interface LogicalProseUnit {
  line: number;
  text: string;
  kind: LogicalProseKind;
}

/**
 * Fold Markdown soft wraps while retaining source lines and semantic
 * boundaries. Distinct paragraphs, headings, list items, quotes, tables, and
 * fenced/indented code never become one requirement merely because they are
 * adjacent in the source.
 */
function logicalProseUnits(lines: readonly string[]): LogicalProseUnit[] {
  const units: LogicalProseUnit[] = [];
  let current: LogicalProseUnit | undefined;
  let fence: { marker: '`' | '~'; length: number } | undefined;
  const flush = () => {
    if (current) units.push(current);
    current = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const fenceRun = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (!fence && fenceRun) {
      flush();
      fence = { marker: fenceRun[1][0] as '`' | '~', length: fenceRun[1].length };
      continue;
    }
    if (fence) {
      if (fenceRun
          && fenceRun[1][0] === fence.marker
          && fenceRun[1].length >= fence.length
          && fenceRun[2].trim().length === 0) {
        fence = undefined;
      }
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }

    const kind: LogicalProseKind = /^#{1,6}(?:\s|$)/.test(trimmed)
      ? 'heading'
      : /^(?:[-*+]\s+|\d+[.)]\s+)/.test(trimmed)
        ? 'list'
        : /^>/.test(trimmed)
          ? 'quote'
          : /^\|.*\|$/.test(trimmed)
            ? 'table'
            : /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed) || /^(?: {4}|\t)/.test(lines[index])
              ? 'boundary'
              : 'prose';

    if (kind === 'heading' || kind === 'table' || kind === 'boundary') {
      flush();
      units.push({ line: index + 1, text: trimmed, kind });
      continue;
    }
    if (kind === 'list') {
      flush();
      current = { line: index + 1, text: trimmed, kind };
      continue;
    }
    if (kind === 'quote') {
      if (current?.kind !== 'quote') flush();
      if (current) current.text += ` ${trimmed}`;
      else current = { line: index + 1, text: trimmed, kind };
      continue;
    }
    if (current && (current.kind === 'prose' || current.kind === 'list')) {
      current.text += ` ${trimmed}`;
    } else {
      flush();
      current = { line: index + 1, text: trimmed, kind: 'prose' };
    }
  }
  flush();
  return units;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

const NUMERIC_LITERAL = /(?:^|[^A-Za-z0-9_])[-+−]?\d[\d,.]*(?:\s*(?:%|bps?|basis\s+points?))?(?=$|[^A-Za-z0-9_])/i;
const OPERATOR_EXPECTATION = /\b(?:operator|author|user)(?:'s)?\b.{0,60}\b(?:expect(?:s|ed|ation)?|prior|provid(?:e|es|ed)|suppl(?:y|ies|ied)|gave|given|handed|hands\s+(?:us|me|you)|figure|number|value|estimate)\b|\b(?:our|my)\s+(?:expected|prior|reference)\s+(?:figure|number|value|estimate|result)\b|\bexpected\s+(?:result|value|figure|estimate|number)\b/i;
const DECISION_ILLUSTRATIVE = /\b(?:for example|illustrative(?:ly)?|e\.g\.)\b|(?:例如|比如|举例|只是例子|并非判据|不是判据)/i;

function decisionLintLines(brief: string): string[] {
  const lines = (splitBriefFrontmatter(brief)?.body ?? brief).split(/\r\n|\n|\r/);
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

function hasPositiveDecisionFieldRequirement(brief: string, field: string): boolean {
  const pattern = new RegExp(`\\b${field}\\b`, 'g');
  return logicalProseUnits(decisionLintLines(brief)).some((unit) => {
    for (const match of unit.text.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (!isNegatedRequirementMention(unit.text, start, start + match[0].length)) return true;
    }
    return false;
  });
}

function operatorFigureEvidence(brief: string): { line: number; excerpt: string } | undefined {
  const offset = splitBriefFrontmatter(brief)?.bodyLineOffset ?? 0;
  const lines = decisionLintLines(brief).map((line) => isNegatedRequirementLine(line) ? '' : line);
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + 2).join(' ');
    if (OPERATOR_EXPECTATION.test(window) && NUMERIC_LITERAL.test(window)) {
      return { line: offset + index + 1, excerpt: lines[index].trim() };
    }
  }
  return undefined;
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
): BriefPreflightReport {
  const digest = sha256(brief);
  const inputKind = classifyInput(brief);
  const parsed = parseBriefFrontmatter(brief);
  const document = parseBriefFrontmatterDocument(brief);
  const hasFrontmatterFence = document && (brief.startsWith('---\n') || brief.startsWith('---\r\n'));
  const frontmatter: BriefPreflightReport['frontmatter'] = document && parsed.frontmatterError
    ? { status: 'invalid', error: parsed.frontmatterError }
    : hasFrontmatterFence
      ? { status: 'valid' }
      : { status: 'absent' };
  const findings: BriefPreflightFinding[] = [];
  const add = (finding: Omit<BriefPreflightFinding, 'fingerprint'>) => findings.push(makeFinding(finding));
  const route = autoSelectedWorkflow(parsed);
  add({
    code: 'brief_workflow', level: route.error ? 'fail' : 'ok',
    message: `Workflow without --workflow: ${route.workflow} (${route.reason})${route.error ? `; refused: ${route.error}` : ''}`,
    consequential: false,
  });

  if (inputKind === 'plain_text') {
    add({
      code: 'plain_text_input',
      level: 'warn',
      message: 'This is a single-line plain-text request, so no structured brief contract was available to validate. Use `/ship` to author a guarded brief or run `flowcrew rehearse <brief.md>` before launch.',
      consequential: true,
      risk: 'An ad-hoc request can omit boundaries, success criteria, or a safe terminal contract.',
      suggestion: 'Author a structured brief with headings or YAML frontmatter, then rehearse it.',
    });
  } else {
    add({
      code: 'structured_input',
      level: 'ok',
      message: 'Structured brief shape detected',
      consequential: false,
    });
  }

  const extractedCriteria = extractBriefCriteria(brief);
  if (extractedCriteria.criteria.length === 0) {
    add({
      code: 'brief_criteria_missing',
      level: 'fail',
      message: 'No structurally extractable criterion was found under an explicit criteria/requirements/report contract heading.',
      consequential: false,
      risk: 'Planning and dispatch would otherwise iterate over an empty proof obligation and report readiness.',
      suggestion: 'Add at least one numbered criterion under an explicit contract heading.',
    });
  } else {
    add({
      code: 'brief_criteria_extracted',
      level: 'ok',
      message: `${extractedCriteria.criteria.length} structurally extractable criterion/criteria found`,
      consequential: false,
    });
  }

  if (frontmatter.status === 'invalid') {
    add({
      code: 'frontmatter_invalid',
      level: 'fail',
      message: `Frontmatter parsing failed: ${frontmatter.error}`,
      consequential: true,
      risk: 'Malformed frontmatter leaves machine-enforced inputs, validation, and terminal contracts unavailable.',
      suggestion: 'Fix the reported YAML syntax and rerun brief preflight before launch.',
    });
  } else {
    add({
      code: frontmatter.status === 'valid' ? 'frontmatter_valid' : 'frontmatter_absent',
      level: 'ok',
      message: frontmatter.status === 'valid' ? 'Frontmatter parsed successfully' : 'No YAML frontmatter declared',
      consequential: false,
    });
  }

  const rc = parsed.research;
  let researchFeasibility: ResearchFeasibilityEvaluation[] | undefined;
  if (parsed.researchPolicyError) {
    add({
      code: 'research_policy_invalid',
      level: 'fail',
      message: `research.policy is invalid: ${parsed.researchPolicyError}`,
      consequential: true,
      risk: 'An unrecognised policy silently becomes greedy_stack, whose keep/drop rule is measured against research.baseline; a brief that meant a different rule gets one it never chose and only finds out from the campaign\'s terminal decision.',
      suggestion: 'Set research.policy to greedy_stack, or omit it to take greedy_stack deliberately.',
    });
  }
  if (parsed.researchFeasibilityError) {
    add({
      code: 'research_feasibility_invalid',
      level: 'fail',
      message: `The declared research.feasibility contract is invalid: ${parsed.researchFeasibilityError}`,
      consequential: true,
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
          consequential: true,
          risk: 'The run may still discover that the rule is empty, but inventing an expectation would be less honest than carrying the uncertainty explicitly.',
          suggestion: 'Measure the named structural distribution before a later run, then replace not_computable with a computable model.',
        });
      } else if (evaluation.decision === 'fail') {
        add({
          code: 'research_feasibility_below_floor',
          level: 'fail',
          message: `Research feasibility “${evaluation.label}” is ${evaluation.displayQualifyingMemberCount}, below hard_floor=${evaluation.hardFloor}.${distribution}`,
          consequential: true,
          risk: 'The pre-registered selection rule is structurally infeasible before any outcome is measured.',
          suggestion: 'Revise or drop the rule before opening outcomes; do not tune it after measurement starts.',
        });
      } else if (evaluation.decision === 'warn') {
        add({
          code: 'research_feasibility_tight',
          level: 'warn',
          message: `Research feasibility “${evaluation.label}” is ${evaluation.displayQualifyingMemberCount}: it meets hard_floor=${evaluation.hardFloor} but is below warn_below=${evaluation.warnBelow}.${distribution}`,
          consequential: true,
          risk: 'The rule is feasible on its declared hard floor but has little structural margin.',
          suggestion: 'Proceed only if the tight rule is intentional; otherwise revise it before outcomes are opened.',
        });
      } else {
        add({
          code: 'research_feasibility_ok',
          level: 'ok',
          message: `Research feasibility “${evaluation.label}” is ${evaluation.displayQualifyingMemberCount}, meeting hard_floor=${evaluation.hardFloor}${evaluation.warnBelow === undefined ? '' : ` and warn_below=${evaluation.warnBelow}`}.${distribution}`,
          consequential: false,
        });
      }
    }
  }

  const suppliedNumbers = (document?.value as Record<string, unknown> | undefined)?.supplied_numbers;
  if (suppliedNumbers !== undefined && (!Array.isArray(suppliedNumbers)
      || !suppliedNumbers.every((value) => typeof value === 'number' && Number.isFinite(value)))) {
    add({
      code: 'supplied_numbers_invalid',
      level: 'fail',
      message: '`supplied_numbers` must be an array of finite YAML numbers (for example, [0, -112.89]); [] declares none.',
      consequential: true,
      suggestion: 'Use only finite YAML numbers in `supplied_numbers`, or remove the declaration if no numbers were supplied.',
    });
  }
  const hasSuppliedNumbers = Array.isArray(suppliedNumbers)
    && suppliedNumbers.length > 0;
  const operatorFigure = operatorFigureEvidence(brief);
  if ((hasSuppliedNumbers || operatorFigure)
      && (!hasPositiveDecisionFieldRequirement(brief, 'within_expected_range')
        || !hasPositiveDecisionFieldRequirement(brief, 'method_was_not_adjusted_to_match_expectation'))) {
    add({
      code: 'operator_figure_anti_anchoring_missing',
      level: hasSuppliedNumbers ? 'fail' : 'warn',
      message: 'A supplied operator expectation must require both `within_expected_range` and `method_was_not_adjusted_to_match_expectation`.',
      consequential: true,
      ...operatorFigure,
      risk: 'Agreement with a supplied number is indistinguishable from a method adjusted to reproduce that number.',
      suggestion: 'Add both exact anti-anchoring fields to the result contract and require independent computation before comparison.',
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
        consequential: true,
        risk: 'A declared but empty or malformed check block provides no deterministic evidence at the terminal gate.',
        suggestion: 'Fix the reported YAML declaration and add at least one valid item under `checks:`, or remove the section if no deterministic check is warranted.',
      });
    }
  }

  if (!rc) {
    add({
      code: 'research_absent',
      level: 'warn',
      message: 'No `research:` block (engineering brief) — static contract checks only; the research loop was not simulated',
      consequential: false,
      suggestion: 'Add a numeric-baseline `research:` block only when this task needs the metric loop; otherwise keep the engineering brief and rely on its static contract checks.',
    });
  } else {
    add({
      code: 'research_valid',
      level: 'ok',
      message: `research: policy=${rc.policy} baseline=${rc.baseline} result_file=${rc.resultFile ?? '(default)'}`,
      consequential: false,
    });
    const targetAssessment = assessResearchShipTarget(rc);
    if (targetAssessment.status === 'already_crossed') {
      add({
        code: 'research_ship_target_already_crossed',
        level: 'fail',
        message: `The declared ship target is already crossed: ${targetAssessment.reason}.`,
        consequential: true,
        risk: 'The first later round that is kept becomes ship-eligible even though it did not establish the intended target gain.',
        suggestion: `Choose a target strictly ${targetAssessment.bindings.higherIsBetter ? 'above' : 'below'} the baseline, or remove stop.beat for an explicit ceiling-only contract.`,
      });
    } else if (targetAssessment.status === 'unreachable') {
      add({
        code: 'research_ship_target_unreachable',
        level: 'fail',
        message: `The declared ship target cannot be exercised: ${targetAssessment.reason}.`,
        consequential: true,
        risk: 'Every schema-valid round is prevented from reaching ship, so the campaign can consume its full ceiling without a keepable shipping candidate.',
        suggestion: 'Bring stop.beat inside the declared result_schema and integrity bounds, or remove stop.beat for an explicit ceiling-only contract.',
      });
    }
    if (!rc.confirm) {
      add({
        code: 'research_confirm_missing',
        level: 'warn',
        message: 'No `research.confirm` declared — a ship decision would be accepted without a data check',
        consequential: true,
        risk: 'A metric improvement could be shipped without an independent data-level confirmation.',
        suggestion: 'Declare `research.confirm.command` and its required evidence, or remove research shipping as an allowed outcome.',
      });
    } else {
      add({
        code: 'research_confirm_valid',
        level: 'ok',
        message: `Confirm command declared: ${rc.confirm.command}`,
        consequential: false,
      });
    }
    if (rc.stop?.beat === undefined) {
      add({
        code: 'research_ship_target_missing',
        level: 'warn',
        message: 'No `stop.beat` declared — a ship decision will never be proposed (ceiling-only exploration)',
        consequential: true,
        risk: 'The loop can explore and terminate at its ceiling but has no numeric target that authorizes shipping.',
        suggestion: 'Declare a finite `research.stop.beat` target, or explicitly choose a ceiling-only exploration contract.',
      });
    }
    if (rc.stop?.maxRounds === undefined && rc.stop?.maxWallHours === undefined && rc.stop?.haltAfterNoImprovement === undefined) {
      add({
        code: 'research_stop_rule_missing',
        level: 'warn',
        message: 'No stop rule declared — the loop is limited only by `max_iterations`',
        consequential: true,
        risk: 'The research loop has no task-owned round, wall-time, or stagnation boundary.',
        suggestion: 'Add at least one of `stop.max_rounds`, `stop.max_wall_hours`, or `stop.halt_after_no_improvement`.',
      });
    }
  }

  const terminalStates = parsed.terminalStates;
  if (!terminalStates || Object.keys(terminalStates).length === 0) {
    add({
      code: 'terminal_states_missing',
      level: 'warn',
      message: 'No `terminal_states` declared — terminal artifact paths have no contract',
      consequential: true,
      risk: 'The scheduler cannot tie a successful terminal status to a named, inspectable artifact.',
      suggestion: 'Declare each allowed status under `terminal_states` with one or more project-relative artifact paths.',
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
        consequential: false,
      });
      if (entry.floor?.minWallMinutes !== undefined && entry.floor.minWallMinutes > 10) {
        add({
          code: `terminal_wall_floor_too_high_${status}`,
          level: 'warn',
          message: `Terminal ${status} sets min_wall_minutes=${entry.floor.minWallMinutes}. Wall time is a clock gate, not evidence that enough work happened, so reuse of existing machinery can finish correctly and still be forced to wait or miss the terminal.`,
          consequential: true,
          risk: 'A correct efficient run can be mislabeled or held solely because it completed faster than the author estimated.',
          suggestion: 'Use at most 10 minutes as an anti-instant-quit guard and name the evidence that proves work coverage instead of encoding an expected duration.',
        });
      }
    }
    // Research ceiling floors count measured rounds; other stage floors need
    // an explicit evidence pattern, independently of the brief's prose.
    for (const [status, entry] of Object.entries(terminalStates)) {
      if (entry.floor?.minAttemptedStages === undefined || entry.stageGlob !== undefined) continue;
      if (status === RUN_STATUS.CEILING_HIT && rc) continue;
      const first = entry.paths[0];
      if (!first) continue;
      const directory = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '.';
      const glob = `${directory}/stage_*_verdict.md`;
      add({
        code: `terminal_floor_uncountable_${status}`,
        level: 'fail',
        message: `terminal ${status} sets min_attempted_stages without an explicit stage_glob. The engine would infer \`${glob}\`, but the counted evidence contract must be explicit and assigned to a stage so it cannot drift or remain unreachable.`,
        consequential: true,
        risk: 'An implicit counting pattern can diverge from the files stages actually own, making the terminal status miscount evidence or become unreachable.',
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
        consequential: true,
        risk: 'No execution can both obey the maximum round count and satisfy the declared ceiling floor.',
        suggestion: 'Lower `terminal_states.ceiling_hit.floor.min_attempted_stages`, raise `research.stop.max_rounds`, or remove the conflicting floor.',
      });
    }
    if (floor?.minAttemptedStages !== undefined && rc?.stop?.haltAfterNoImprovement !== undefined
        && rc.stop.haltAfterNoImprovement < floor.minAttemptedStages) {
      add({
        code: 'terminal_floor_defers_early_stop',
        level: 'ok',
        message: `floor(${floor.minAttemptedStages}) > halt_after_no_improvement(${rc.stop.haltAfterNoImprovement}): an early ceiling decision will be deferred as intended`,
        consequential: false,
      });
    }
  }

  return {
    version: 1,
    digest,
    inputKind,
    frontmatter,
    contractReady: !findings.some((finding) => finding.level === 'fail'),
    ...(researchFeasibility === undefined ? {} : { researchFeasibility }),
    findings,
  };
}

export function createBriefAdmission(
  report: BriefPreflightReport,
  acknowledgement: BriefAdmissionAcknowledgement,
): BriefAdmissionRecord {
  return {
    version: 1,
    digest: report.digest,
    acknowledgement,
  };
}

export function verifyBriefAdmission(
  brief: string,
  record: BriefAdmissionRecord | undefined,
): BriefAdmissionVerification {
  const digest = sha256(brief);
  const status = !record || record.version !== 1
    ? 'missing'
    : record.digest === digest ? 'valid' : 'digest_mismatch';
  return { digest, status };
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
  lines.push('', 'Preflight findings are advisory; launch binds this exact brief digest.');
  return lines.join('\n');
}

/** Hard declaration refusals shared by launch and preparation commands. Other
 * report findings retain their existing acknowledgement/semantic-reader policy. */
export function briefDeclarationFailures(brief: string, report = inspectBrief(brief)): BriefPreflightFinding[] {
  const malformed = parseBriefFrontmatterDocument(brief)?.errorKind === 'yaml';
  return report.findings.filter(finding => finding.level === 'fail'
    && (finding.code === 'brief_criteria_missing' || (malformed && finding.code === 'frontmatter_invalid')));
}
