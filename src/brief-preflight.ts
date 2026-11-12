import { parseBriefFrontmatterDocument } from './brief-frontmatter.js';
import { createHash } from 'node:crypto';
import { parseBriefFrontmatter } from './scheduler.js';
import { entryWorkflow } from './scheduler/sched_admission/brief-contract.js';

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
  /** Retained wire enum; active inspection no longer classifies prose. */
  inputKind: 'brief' | 'plain_text';
  frontmatter: {
    status: 'absent' | 'valid' | 'invalid';
    error?: string;
  };
  contractReady: boolean;
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

/** Inspect one exact brief string without reading or changing project state. */
export function inspectBrief(
  brief: string,
): BriefPreflightReport {
  const digest = sha256(brief);
  const inputKind = 'brief';
  const parsed = parseBriefFrontmatter(brief);
  const document = parseBriefFrontmatterDocument(brief);
  const hasFrontmatterFence = document !== undefined;
  const frontmatter: BriefPreflightReport['frontmatter'] = document && parsed.frontmatterError
    ? { status: 'invalid', error: parsed.frontmatterError }
    : hasFrontmatterFence
      ? { status: 'valid' }
      : { status: 'absent' };
  const findings: BriefPreflightFinding[] = [];
  const add = (finding: Omit<BriefPreflightFinding, 'fingerprint'>) => findings.push(makeFinding(finding));
  const route = entryWorkflow(parsed);
  add({
    code: 'brief_workflow', level: route.error ? 'fail' : 'ok',
    message: `Entry workflow: ${route.workflow} (${route.reason})${route.error ? `; refused: ${route.error}` : ''}`,
    consequential: false,
  });

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
  if (parsed.researchPolicyError) add({ code: 'research_policy_invalid', level: 'fail', consequential: true,
    message: parsed.researchPolicyError, suggestion: 'Declare research-instrument/v1 with frozen roots, argv and a finite round budget.' });

  if (rc) add({ code: 'research_measurement_valid', level: 'ok', consequential: false,
    message: `Frozen project instrument: ${rc.protocol}; ${rc.budget.max_rounds} hard rounds` });

  const terminalStates = parsed.terminalStates;
  if (!terminalStates || Object.keys(terminalStates).length === 0) {
    if (!rc) add({
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
      if (rc) continue;
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

  }

  return {
    version: 1,
    digest,
    inputKind,
    frontmatter,
    contractReady: !findings.some((finding) => finding.level === 'fail'),
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
    `Input: ${report.inputKind === 'plain_text' ? 'single-line plain text' : 'brief text'}`,
    `Frontmatter: ${report.frontmatter.status}${report.frontmatter.error ? ` — ${report.frontmatter.error}` : ''}`,
    `Contract: ${report.contractReady ? 'ready' : 'problems found'}`,
    '',
  ];
  for (const finding of report.findings) {
    lines.push(`${mark[finding.level]} [${finding.code}] ${finding.message}`);
    if (finding.risk) lines.push(`  Risk: ${finding.risk}`);
    if (finding.suggestion) lines.push(`  Suggestion: ${finding.suggestion}`);
  }
  lines.push('', 'Warnings are advisory; malformed declarations refuse launch. Launch binds this exact brief digest.');
  return lines.join('\n');
}

/** Only malformed declarations can refuse; prose is opaque to admission. */
export function briefDeclarationFailures(_brief: string, report = inspectBrief(_brief)): BriefPreflightFinding[] {
  return report.findings.filter(finding => finding.level === 'fail'
    && finding.code === 'frontmatter_invalid');
}
