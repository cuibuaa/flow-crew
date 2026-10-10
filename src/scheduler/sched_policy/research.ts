/** Research artifact identity, round ingestion/advancement, confirmation and best-effort terminal hooks; file inventory, rollback settlement and campaign writer are supplied. */
import { type ResearchRound, evaluateResearch, evaluateResearchCeilingFloor } from '../../research-policy.js';
import { createHash } from 'node:crypto';
import { basename, join, dirname } from 'node:path';
import { lstatSync, readFileSync, copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { type Adapter } from '../../adapters/base.js';
import { RUN_STATUS, type StoreState, enforceRealityGateBeforeTerminal, writeRunState, type PostTerminateHook } from '../../store.js';
import { RUN_WIDE_GUIDANCE_TARGET } from '../../guidance.js';
import { generateRunSummary } from '../../run-summary.js';
import { log } from '../sched_admission/shared.js';
import { markLeftoverStagesSkipped, recordConfirmNotRun } from '../sched_admission/brief-contract.js';
import { recordRunEvent } from '../../run-events.js';
import { resolveResearchPaths } from '../../research-paths.js';
import { runAllChecks } from '../../reality-gate/index.js';
import { validate as validateResultSchema } from '../../reality-gate/checks/json-schema-match.js';
import { spawnEngineChild, withEngineCommandBoundary } from '../../write-boundary.js';
import { admittedTerminalOwner } from './terminal-ownership.js';
import { appendSchedulerGuidanceOnce, observeStableBlockage } from './guidance.js';

export interface ResearchAdvanceServices {
  listProjectFilesAt(projectDir: string, subdir: string): string[];
  settleFrameworkRollbackPath(projectDir: string, runDirPath: string, path: string): void;
  writeCampaignEntry(projectDir: string, state: StoreState): void;
}

const INTEGRITY_REJECTION_CEILING = 30;

interface ResearchMeasurementEvidenceIdentity {
  label: string;
  outcome: 'measured';
  normalizedSha256: string;
  sourceSha256: string;
  source: string;
}

interface ResearchJournalArtifact {
  rounds: ResearchRound[];
  /** Framework-owned identities for comparing distinct labels without treating
   * an equal headline score alone as reuse. The immutable consumed artifact is
   * retained separately at `source`. */
  measurementEvidence?: ResearchMeasurementEvidenceIdentity[];
}

function canonicalResearchEvidence(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalResearchEvidence).join(',')}]`;
  if (!value || typeof value !== 'object') return 'null';
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalResearchEvidence((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

export function normalizedResearchEvidenceDigest(round: Record<string, unknown>): string {
  const normalized = Object.fromEntries(
    Object.entries(round).filter(([key]) => key !== 'label'),
  );
  return createHash('sha256').update(canonicalResearchEvidence(normalized), 'utf8').digest('hex');
}

export async function runPostTerminateHook(
  hook: PostTerminateHook,
  ctx: {
    projectDir: string;
    runDir: string;
    runId: string;
    terminalStatus: string;
    verdictPath: string;
  },
): Promise<void> {
  const timeoutMs = (hook.timeoutSeconds ?? 300) * 1000;
  const hookEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    FC_PHASE: ctx.terminalStatus,
    FC_VERDICT_FILE: ctx.verdictPath,
    FC_RUN_DIR: ctx.runDir,
    FC_PROJECT_DIR: ctx.projectDir,
    FC_RUN_ID: ctx.runId,
    ...(hook.env ?? {}),
  };
  const args = hook.args ?? [];
  const logPath = join(ctx.runDir, 'post_terminate_hook.log');
  const startedAt = new Date().toISOString();

  await withEngineCommandBoundary({ projectDir: ctx.projectDir, runDir: ctx.runDir,
    stageId: '_terminal_hook',
  }, () => new Promise<void>((resolve) => {
    let settled = false;
    const { child, stop, boundaryError } = spawnEngineChild(hook.command, args, {
      cwd: ctx.projectDir,
      env: hookEnv,
    });
    const chunks: string[] = [
      `# post_terminate_hook log\n`,
      `started_at: ${startedAt}\n`,
      `command: ${hook.command}\n`,
      `args: ${JSON.stringify(args)}\n`,
      `timeout_seconds: ${hook.timeoutSeconds ?? 300}\n`,
      `\n--- stdout/stderr ---\n`,
    ];
    child.stdout?.on('data', (d) => chunks.push(d.toString()));
    child.stderr?.on('data', (d) => chunks.push(d.toString()));
    const timer = setTimeout(() => {
      if (settled) return;
      log.warn({ runId: ctx.runId, command: hook.command, timeoutMs }, 'post_terminate_hook exceeded timeout, killing');
      stop();
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn({ runId: ctx.runId, command: hook.command, err: String(err) }, 'post_terminate_hook spawn failed');
      try { writeFileSync(logPath, chunks.join('') + `\nspawn error: ${err}\n`, 'utf-8'); } catch { /* noop */ }
      resolve();
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const refusal = boundaryError();
      chunks.push(`\n--- exit ---\ncode: ${code}\nsignal: ${signal}\ncompleted_at: ${new Date().toISOString()}\n${refusal ? `boundary_refusal: ${refusal}\n` : ''}`);
      try { writeFileSync(logPath, chunks.join(''), 'utf-8'); } catch { /* noop */ }
      if (code !== 0 || refusal) {
        log.warn({ runId: ctx.runId, command: hook.command, exitCode: code, signal }, 'post_terminate_hook exited non-zero (best-effort, ignored)');
      } else {
        log.info({ runId: ctx.runId, command: hook.command }, 'post_terminate_hook completed');
      }
      resolve();
    });
  })).catch((error: unknown) => {
    const message = `ENGINE_WRITE_BOUNDARY_REFUSED: terminal hook was not executed: ${String(error)}`;
    log.warn({ runId: ctx.runId, message }, 'post_terminate_hook refused (best-effort, ignored)');
    writeFileSync(logPath, message + '\n', 'utf8');
  });
}

export function createResearchAdvancer(services: ResearchAdvanceServices) {
  const { listProjectFilesAt, settleFrameworkRollbackPath, writeCampaignEntry } = services;

  function researchRoundEvidenceLink(
    projectDir: string,
    reportDir: string,
    round: { label?: string; result?: number; evidence?: unknown },
    startedMs: number,
  ): string | undefined {
    if (typeof round.evidence === 'string' && round.evidence.trim()) return round.evidence.trim();
    if (!round.label || typeof round.result !== 'number') return undefined;
    const expectedLabel = round.label;
    const expectedResult = round.result;
    const candidates = listProjectFilesAt(projectDir, reportDir).filter((path) => basename(path) === 'evidence.json');
    const matches = candidates.filter((path) => {
      try {
        const absolute = join(projectDir, path);
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || stat.mtimeMs < startedMs) return false;
        const pending: unknown[] = [JSON.parse(readFileSync(absolute, 'utf-8'))];
        let sawLabel = false;
        let sawResult = false;
        let visited = 0;
        while (pending.length > 0 && visited++ < 100_000) {
          const value = pending.pop();
          if (value === expectedLabel) sawLabel = true;
          if (value === expectedResult) sawResult = true;
          if (sawLabel && sawResult) return true;
          if (Array.isArray(value)) {
            for (const item of value) pending.push(item);
          } else if (value && typeof value === 'object') {
            for (const item of Object.values(value)) pending.push(item);
          }
        }
        return false;
      } catch { return false; }
    });
    return matches.length === 1 ? matches[0] : undefined;
  }

  async function tryAdvanceResearch(
    state: StoreState,
    ctx: { projectDir: string; runId: string; runDirPath: string; iteration: number; adapter: Adapter },
  ): Promise<StoreState | null> {
    const rc = state.research;
    if (!rc) return null;
    const researchPaths = resolveResearchPaths(rc);
    const resultRel = researchPaths.resultFile;
    const resultAbs = join(ctx.projectDir, resultRel);
    const noCandidateAbs = `${resultAbs}.no_candidate.json`;
    
    const startedMs = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
    const fresh = (path: string): boolean => {
      try { return existsSync(path) && statSync(path).mtimeMs >= startedMs; } catch { return false; }
    };
    const freshResult = fresh(resultAbs);
    const freshNoCandidate = fresh(noCandidateAbs);
    if (!freshResult && !freshNoCandidate) return null;
    const digestSources = (paths: readonly string[]): string => {
      const hash = createHash('sha256');
      for (const path of [...paths].sort()) {
        hash.update(path === resultAbs ? resultRel : `${resultRel}.no_candidate.json`, 'utf8');
        try { hash.update(readFileSync(path)); } catch { hash.update('<unreadable>', 'utf8'); }
      }
      return hash.digest('hex');
    };
    const rejectRoundInput = (kind: string, detail: string, sources: readonly string[]): null => {
      const evidenceDigest = digestSources(sources);
      try {
        writeFileSync(join(ctx.runDirPath, 'research_round_input_error.json'), `${JSON.stringify({
          error: detail,
          kind,
          resultFile: resultRel,
          noCandidateFile: `${resultRel}.no_candidate.json`,
          evidenceDigest,
        }, null, 2)}\n`, 'utf-8');
      } catch { /* non-critical */ }
      observeStableBlockage({
        runDirPath: ctx.runDirPath,
        kind: 'research_round_input',
        detail: kind,
        evidenceDigest,
        threshold: state.campaignTriggers?.repeatedFailureAfter,
      });
      appendSchedulerGuidanceOnce(
        ctx.runDirPath,
        RUN_WIDE_GUIDANCE_TARGET,
        `[research-round-input:${kind}:${evidenceDigest}]`,
        `${detail} Correct or replace the named round artifact; the framework will not invent missing fields or silently choose between conflicting files.`,
      );
      return null;
    };
    if (freshResult && freshNoCandidate) {
      return rejectRoundInput(
        'ambiguous_measured_and_no_candidate',
        'Ambiguous research round: both the measured result and no-candidate sidecar are fresh.',
        [resultAbs, noCandidateAbs],
      );
    }
    const sourceAbs = freshNoCandidate ? noCandidateAbs : resultAbs;
    let round: { label?: string; result?: number; outcome?: string; status?: string; reason?: string; evidence?: unknown };
    try {
      round = JSON.parse(readFileSync(sourceAbs, 'utf-8'));
    } catch {
      return rejectRoundInput('malformed_json', `Research round artifact ${sourceAbs} is not valid JSON.`, [sourceAbs]);
    }
    const noCandidate = freshNoCandidate;
    if (typeof round.label !== 'string' || !round.label.trim()) {
      return rejectRoundInput('missing_label', 'Research round artifacts require a non-empty string label.', [sourceAbs]);
    }
    if (noCandidate) {
      // Recover only the exact, unambiguous `status`/`outcome` transposition.
      // The expensive producer has already completed; all other malformed
      // shapes still take the normal refusal path below.
      if (round.outcome === undefined
          && round.status === 'no_candidate'
          && typeof round.reason === 'string'
          && round.reason.trim()) {
        round.outcome = 'no_candidate';
        const repairedAt = new Date().toISOString();
        try {
          writeFileSync(join(ctx.runDirPath, 'research_round_contract_repair.json'), `${JSON.stringify({
            version: 1,
            repairedAt,
            kind: 'no_candidate_status_alias',
            source: `${resultRel}.no_candidate.json`,
            fromField: 'status',
            toField: 'outcome',
            value: 'no_candidate',
          }, null, 2)}\n`, 'utf-8');
        } catch { /* the journal and event still carry the recovery */ }
        recordRunEvent(ctx.projectDir, ctx.runId, {
          type: 'research_round_contract_repaired',
          runId: ctx.runId,
          timestamp: repairedAt,
          iteration: ctx.iteration,
          files: [`${resultRel}.no_candidate.json`],
          detail: 'normalized the unambiguous no-candidate discriminator from status to outcome before ingestion',
          source: 'scheduler',
        });
      }
      if (round.outcome !== 'no_candidate' || typeof round.reason !== 'string' || !round.reason.trim()) {
        return rejectRoundInput(
          'invalid_no_candidate_shape',
          'The no-candidate sidecar requires outcome="no_candidate", a non-empty label, and a non-empty reason.',
          [sourceAbs],
        );
      }
    } else if (typeof round.result !== 'number' || !Number.isFinite(round.result)) {
      return rejectRoundInput('invalid_measured_result', 'A measured research result requires a finite numeric result.', [sourceAbs]);
    }
    const measuredResult = noCandidate ? undefined : round.result;
    const sourceEvidenceDigest = digestSources([sourceAbs]);
    const roundEvidenceLink = noCandidate
      ? undefined
      : researchRoundEvidenceLink(ctx.projectDir, researchPaths.reportDir, round, startedMs);

    // Journal lives in the run dir (framework-owned, agent-unreachable).
    const journalPath = join(ctx.runDirPath, 'research_journal.json');
    const journal: ResearchJournalArtifact = { rounds: [], measurementEvidence: [] };
    if (existsSync(journalPath)) {
      try {
        const parsed = JSON.parse(readFileSync(journalPath, 'utf-8')) as ResearchJournalArtifact;
        if (parsed && Array.isArray(parsed.rounds)) journal.rounds = parsed.rounds;
        if (parsed && Array.isArray(parsed.measurementEvidence)) {
          journal.measurementEvidence = parsed.measurementEvidence.filter((entry) => (
            entry
            && typeof entry.label === 'string'
            && entry.outcome === 'measured'
            && typeof entry.normalizedSha256 === 'string'
            && typeof entry.sourceSha256 === 'string'
            && typeof entry.source === 'string'
          ));
        }
      } catch { /* reset on corruption */ }
    }
    const label = round.label.trim();
    // A shared latest-result path is mutable, but journal labels are immutable
    // round identities. Re-submitting an already-journaled identity is a stable
    // blockage, not another budget-consuming round.
    const duplicate = journal.rounds.some((r) => r.label === label);
    if (duplicate) {
      observeStableBlockage({
        runDirPath: ctx.runDirPath,
        kind: 'research_round_duplicate',
        detail: `duplicate research round label ${label}`,
        evidenceDigest: sourceEvidenceDigest,
        threshold: state.campaignTriggers?.repeatedFailureAfter,
      });
      appendSchedulerGuidanceOnce(
        ctx.runDirPath,
        RUN_WIDE_GUIDANCE_TARGET,
        `[research-round-duplicate:${label}]`,
        `Research round label ${JSON.stringify(label)} is already journaled and is an immutable identity. Use a fresh label for a genuinely new measurement; do not rewrite an earlier round by changing the shared result file.`,
      );
      return null;
    }

    const measurementEvidenceDigest = noCandidate
      ? undefined
      : normalizedResearchEvidenceDigest(round as Record<string, unknown>);
    const reusedEvidence = measurementEvidenceDigest === undefined
      ? undefined
      : journal.measurementEvidence?.find((entry) => entry.normalizedSha256 === measurementEvidenceDigest);
    if (reusedEvidence) {
      return rejectRoundInput(
        'research_round_evidence_reused',
        `Research round ${JSON.stringify(label)} is indistinguishable from already-journaled ${JSON.stringify(reusedEvidence.label)} after removing only the mutable label (evidence ${measurementEvidenceDigest}). Equal headline scores are allowed, but a new round must carry independently distinguishable measurement evidence.`,
        [sourceAbs],
      );
    }

    const rejectGate = async (reason: string, message: string): Promise<StoreState | null> => {
      const rejPath = join(ctx.runDirPath, 'research_integrity_rejections.json');
      let rejData: Record<string, number> = {};
      if (existsSync(rejPath)) { try { rejData = JSON.parse(readFileSync(rejPath, 'utf-8')); } catch { /* reset */ } }
      rejData[reason] = (rejData[reason] || 0) + 1;
      const totalRej = Object.values(rejData).reduce((s, n) => s + (n || 0), 0);
      try { writeFileSync(rejPath, JSON.stringify(rejData, null, 2), 'utf-8'); } catch { /* non-critical */ }
      observeStableBlockage({
        runDirPath: ctx.runDirPath,
        kind: 'research_integrity',
        detail: `research integrity rejection: ${reason}`,
        evidenceDigest: sourceEvidenceDigest,
        threshold: state.campaignTriggers?.repeatedFailureAfter,
      });
      try { unlinkSync(sourceAbs); } catch { /* non-critical */ }
      appendSchedulerGuidanceOnce(
        ctx.runDirPath,
        RUN_WIDE_GUIDANCE_TARGET,
        `[research-integrity:${reason}:${label}=${measuredResult}]`,
        message,
      );
      log.warn({ runId: ctx.runId, reason, label, result: measuredResult, total_rejections: totalRej }, 'Research round rejected by integrity gate');
      
      const maxRej = Math.max(rc.stop?.maxRounds ?? 24, INTEGRITY_REJECTION_CEILING);
      if (totalRej >= maxRej) {
        const terminalPath = state.terminalStates?.[RUN_STATUS.CEILING_HIT]?.paths?.[0];
        const terminalOwner = terminalPath
          ? admittedTerminalOwner(ctx.runDirPath, terminalPath)
          : undefined;
        if (terminalPath && terminalOwner) {
          const terminalReason = `Research ceiling: ${totalRej} integrity-gate rejections (reasons: ${Object.keys(rejData).join(',')})`;
          writeFileSync(join(ctx.runDirPath, 'research_decision.json'), `${JSON.stringify({
            version: 1,
            decision: 'stop_ceiling',
            terminalStatus: RUN_STATUS.CEILING_HIT,
            terminalPath,
            terminalOwner,
            reason: terminalReason,
            integrityRejectionCeiling: true,
          }, null, 2)}\n`, 'utf-8');
          mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
          writeFileSync(join(ctx.runDirPath, 'signals', 'research_terminal_ready.json'), `${JSON.stringify({
            version: 1,
            decision: 'stop_ceiling',
            terminalStatus: RUN_STATUS.CEILING_HIT,
            terminalPath,
            terminalOwner,
            reason: terminalReason,
          }, null, 2)}\n`, 'utf-8');
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            terminalOwner,
            `[research-terminal-ready:integrity-${totalRej}]`,
            `The mechanically settled research decision is stop_ceiling after ${totalRej} integrity rejections. Read research_decision.json and write exactly ${terminalPath}; do not write any other terminal path.`,
            Object.keys(state.stages),
          );
          recordConfirmNotRun(ctx.runDirPath, rc.confirm, RUN_STATUS.CEILING_HIT);
          return null;
        }
        state.status = 'ceiling_hit';
        // FIX D — non-ship terminal: record any brief-declared confirm as not-run (observability).
        recordConfirmNotRun(ctx.runDirPath, rc.confirm, state.status);
        state.completedAt = new Date().toISOString();
        const gate = await enforceRealityGateBeforeTerminal(ctx.projectDir, ctx.runId, state, state.status);
        
        if (!gate.allowed) { writeCampaignEntry(ctx.projectDir, gate.state); return gate.state; }
        writeRunState(ctx.projectDir, ctx.runId, state);
        writeCampaignEntry(ctx.projectDir, state);
        recordRunEvent(ctx.projectDir, ctx.runId, { type: 'run_completed', runId: ctx.runId, timestamp: state.completedAt, iteration: ctx.iteration, detail: `Research ceiling: ${totalRej} integrity-gate rejections (reasons: ${Object.keys(rejData).join(',')})` });
        await generateRunSummary(ctx.projectDir, ctx.runId, ctx.adapter).catch(() => { /* non-critical */ });
        return state;
      }
      try {
        mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
        writeFileSync(join(ctx.runDirPath, 'signals', 'research_continue.json'), JSON.stringify({ round: journal.rounds.length, runningBest: rc.baseline, timestamp: new Date().toISOString(), rejected_reason: reason, rejected_label: label }), 'utf-8');
      } catch { /* non-critical */ }
      return null;
    };

    const ig = rc.integrity;
    const roundFields = round as Record<string, unknown>;

    // Gate #0: output-contract — round_result must match the brief's declared research.result_schema.
    // Single-sourced: the SAME schema is injected to the planner ({result_schema}); the engine treats
    // it as an opaque JSON Schema. This is what stops plan-time checks and execute-time output drifting.
    if (rc.resultSchema && !noCandidate) {
      const schemaErrs = validateResultSchema(round, rc.resultSchema, '$');
      if (schemaErrs.length) {
        return rejectGate('schema_mismatch',
          `Rejected '${label}': round_result violates the brief-declared research.result_schema — ${schemaErrs.slice(0, 5).join('; ')}. Write EXACTLY the declared fields (don't invent or omit), then re-measure.`);
      }
    }

    // Gate #1: no-op (result == baseline within tolerance) — generic; on unless disabled.
    if (ig?.noop !== false && !noCandidate) {
      const noopEps = Math.max(1e-4, Math.abs(rc.baseline) * 1e-5);
      if (Math.abs(measuredResult! - rc.baseline) <= noopEps) {
        return rejectGate('noop',
          `Rejected '${label}' = ${measuredResult}: equals baseline (${rc.baseline}) within tolerance — the change did nothing (no-op/proxy). Implement a direction that genuinely alters behavior and re-measure.`);
      }
    }

    // Gate #2: cross-run variance (result_std/|mean| too high → unstable/lucky). Generic, default 0.30.
    const stdField = (round as { result_std?: number }).result_std;
    const meanReference = measuredResult;  // measured result is the mean by convention
    const maxStdRatio = ig?.maxStdRatio ?? 0.30;
    if (!noCandidate && typeof stdField === 'number' && Math.abs(meanReference!) > 1e-6) {
      const stdRatio = Math.abs(stdField) / Math.abs(meanReference!);
      if (stdRatio > maxStdRatio) {
        const r = await rejectGate('unstable',
          `Rejected '${label}' = ${measuredResult}: result_std/mean = ${stdRatio.toFixed(2)} > ${maxStdRatio} — cross-run variance too high to trust the mean. Reduce variance (more seeds/runs) before reporting.`);
        if (r) return r; else return null;
      }
    }

    // Gate #3: brief-declared numeric floors. The engine knows nothing about the field
    // names; a brief declares e.g. field_floors: { worst_case_score: 50 }.
    for (const [field, min] of Object.entries(noCandidate ? {} : (ig?.fieldFloors ?? {}))) {
      const v = roundFields[field];
      if (typeof v === 'number' && v < min) {
        const r = await rejectGate(`field_floor_${field}`,
          `Rejected '${label}' = ${measuredResult}: ${field} = ${v} < ${min} (brief-declared floor).`);
        if (r) return r; else return null;
      }
    }

    // Gate #4: brief-declared "must be zero" fields, e.g. reject_if_positive: [failure_count].
    for (const field of noCandidate ? [] : (ig?.rejectIfPositive ?? [])) {
      const v = roundFields[field];
      if (typeof v === 'number' && v > 0) {
        const r = await rejectGate(`nonzero_${field}`,
          `Rejected '${label}' = ${measuredResult}: ${field} = ${v} > 0 (brief mandates 0 for this field).`);
        if (r) return r; else return null;
      }
    }

    // Gate #5: outlier cap (implausible improvement). Generic, default factor 5.
    //   (a) baseline ≈ 0 → a relative ceiling is undefined; skip (else it rejects everything).
    //   (b) DIRECTIONAL — only an implausible IMPROVEMENT is suspect; a big loss is a valid result.
    const baseAbs = Math.abs(rc.baseline);
    const higherIsBetter = rc.higherIsBetter !== false;
    const outlierFactor = ig?.outlierFactor ?? 5;
    const tooGood = !noCandidate && (higherIsBetter
      ? measuredResult! > baseAbs * outlierFactor
      : measuredResult! < -(baseAbs * outlierFactor));
    if (!noCandidate && baseAbs > 1e-9 && tooGood) {
      const r = await rejectGate('outlier_too_high',
        `Rejected '${label}' = ${measuredResult}: implausibly far beyond ${outlierFactor}× baseline (${rc.baseline}) in the improving direction — likely numerical explosion, data leakage, overfit, or a units bug. Verify the calculation and reproduce before trusting.`);
      if (r) return r; else return null;
    }

    journal.rounds.push({
      label,
      outcome: noCandidate ? 'no_candidate' : 'measured',
      ...(noCandidate
        ? { reason: round.reason!.trim(), ...(round.evidence === undefined ? {} : { evidence: round.evidence }) }
        : { result: measuredResult!, ...(roundEvidenceLink === undefined ? {} : { evidence: roundEvidenceLink }) }),
      resultStd: (round as { result_std?: number }).result_std,
      wallHoursCumulative: (Date.now() - startedMs) / 3600000,
    });
    if (measurementEvidenceDigest !== undefined) {
      const roundNumber = journal.rounds.length;
      journal.measurementEvidence ??= [];
      journal.measurementEvidence.push({
        label,
        outcome: 'measured',
        normalizedSha256: measurementEvidenceDigest,
        sourceSha256: sourceEvidenceDigest,
        source: `research_round_${roundNumber}_consumed.json`,
      });
    }
    try { writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
    
    try {
      const manifestPath = join(ctx.projectDir, researchPaths.manifestFile);
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({ runId: ctx.runId, rounds: journal.rounds }, null, 2) + '\n', 'utf-8');
      settleFrameworkRollbackPath(ctx.projectDir, ctx.runDirPath, researchPaths.manifestFile);
    } catch { /* non-critical */ }

    const evalResult = evaluateResearch(rc, journal.rounds);
    try { writeFileSync(join(ctx.runDirPath, 'research_decision.json'), JSON.stringify(evalResult, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }

    // Keep an immutable consumed copy immediately. A shipping round's mutable
    // result stays readable only through its confirm command; the journal label
    // already prevents a crash in this interval from counting the round twice.
    const consumedPath = join(ctx.runDirPath, `research_round_${journal.rounds.length}_${noCandidate ? 'no_candidate_' : ''}consumed.json`);
    const confirmNeedsResult = evalResult.decision === 'ship' && Boolean(rc.confirm) && !noCandidate;
    try {
      if (confirmNeedsResult) copyFileSync(sourceAbs, consumedPath);
      else renameSync(sourceAbs, consumedPath);
    } catch { /* non-critical */ }

    log.info({ runId: ctx.runId, iteration: ctx.iteration, label, result: measuredResult, outcome: noCandidate ? 'no_candidate' : 'measured', runningBest: evalResult.runningBest, decision: evalResult.decision }, 'Research round evaluated');
    const roundSummary = noCandidate
      ? `Research round '${label}' reported no acting candidate (${round.reason})`
      : `Research round '${label}' = ${measuredResult}`;

    if (evalResult.decision === 'continue') {
      // Steer the next iteration: tell the agent the running-best + kept set and
      // ask for the next direction. Idempotent marker per round.
      const marker = `[research-advance:round-${journal.rounds.length}]`;
      const nextRound = journal.rounds.length + 1;
      appendSchedulerGuidanceOnce(
        ctx.runDirPath,
        RUN_WIDE_GUIDANCE_TARGET,
        marker,
        `${roundSummary} (running-best ${evalResult.runningBest}, kept: ${evalResult.keptLabels.join(', ') || 'none'}). Decision: CONTINUE.\n`
          + `▶ START ROUND ${nextRound} — a NEW, genuinely DIFFERENT mechanism. Do NOT reuse, rename, or lightly re-tune the previous round's plan or candidate; a within-noise tweak will NOT count as an improvement (it must beat running-best by more than its standard error) and will burn the ceiling budget. Build on the kept stack, implement the new direction, then write its measured result to ${resultRel}.`,
      );
      
      try {
        mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
        writeFileSync(join(ctx.runDirPath, 'signals', 'research_continue.json'), JSON.stringify({ round: journal.rounds.length, runningBest: evalResult.runningBest, timestamp: new Date().toISOString() }), 'utf-8');
      } catch { /* non-critical */ }
      return null;
    }

    // ship | stop_ceiling → terminate the run via a framework-owned status.
    let terminalDecision: 'ship' | 'stop_ceiling' = evalResult.decision === 'ship' ? 'ship' : 'stop_ceiling';
    let finalEval = evalResult;

    if (terminalDecision === 'ship' && rc.confirm) {
      let confirmReport: { pass: boolean; results: Array<{ details: string }> };
      try {
        confirmReport = await runAllChecks(
          [{ name: 'research_confirm', type: 'exec-script-exit-zero', reads: rc.confirm.reads ?? [], params: { script: rc.confirm.command, timeout_seconds: rc.confirm.timeoutSeconds ?? 300 } }],
          { taskDir: ctx.runDirPath, projectDir: ctx.projectDir },
        );
      } catch (err) {
        confirmReport = { pass: false, results: [{ details: `confirm command threw: ${err instanceof Error ? err.message : String(err)}` }] };
      }
      // The confirm command has settled. Consume the mutable slot even on a
      // refusal, so the next iteration cannot observe the same round as new.
      try { unlinkSync(sourceAbs); } catch { /* duplicate journal identity still prevents a replay */ }
      try { writeFileSync(join(ctx.runDirPath, 'research_confirm.json'), JSON.stringify({ ...confirmReport, command: rc.confirm.command, requires: rc.confirm.requires }, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
      if (!confirmReport.pass) {
        const detail = confirmReport.results.map((r) => r.details).join('; ') || 'confirm command did not exit 0';
        log.warn({ runId: ctx.runId, command: rc.confirm.command, detail }, 'Confirm gate FAILED — candidate unconfirmed; excluding round and re-evaluating');
        
        const lastRound = journal.rounds[journal.rounds.length - 1];
        if (lastRound) lastRound.confirmFailed = true;
        try { writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
        try {
          writeFileSync(join(ctx.projectDir, researchPaths.manifestFile), JSON.stringify({ runId: ctx.runId, rounds: journal.rounds }, null, 2) + '\n', 'utf-8');
          settleFrameworkRollbackPath(ctx.projectDir, ctx.runDirPath, researchPaths.manifestFile);
        } catch { /* non-critical */ }
        finalEval = evaluateResearch(rc, journal.rounds);
        finalEval.reason = `confirm gate failed on '${label}' (${detail}) — candidate excluded from kept stack | ${finalEval.reason}`;
        try { writeFileSync(join(ctx.runDirPath, 'research_decision.json'), JSON.stringify(finalEval, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
        if (finalEval.decision === 'continue') {
          const marker = `[research-confirm-fail:round-${journal.rounds.length}]`;
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            RUN_WIDE_GUIDANCE_TARGET,
            marker,
            `Round '${label}' = ${measuredResult} FAILED the confirm gate: ${detail}. The candidate is UNCONFIRMED and has been excluded from the kept stack (running-best ${finalEval.runningBest}).\n`
              + `▶ START ROUND ${journal.rounds.length + 1} — a NEW, genuinely DIFFERENT mechanism (do not re-tune the failed candidate; fix what the confirm gate named only if a distinct mechanism addresses it). Write its measured result to ${resultRel}.`,
          );
          try {
            mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
            writeFileSync(join(ctx.runDirPath, 'signals', 'research_continue.json'), JSON.stringify({ round: journal.rounds.length, runningBest: finalEval.runningBest, confirmFailed: label, timestamp: new Date().toISOString() }), 'utf-8');
          } catch { /* non-critical */ }
          log.info({ runId: ctx.runId, label, decision: finalEval.decision }, 'Confirm-failed candidate excluded — research budget remains, continuing loop');
          return null;
        }
        terminalDecision = 'stop_ceiling';
      } else {
        log.info({ runId: ctx.runId, command: rc.confirm.command }, 'Confirm gate PASSED — ship confirmed');
      }
    }

    if (terminalDecision === 'stop_ceiling') {
      const ceilingEntry = state.terminalStates?.['ceiling_hit'];
      const elapsedMinutes = (Date.now() - startedMs) / 60000;
      const floorCheck = evaluateResearchCeilingFloor(ceilingEntry?.floor, journal.rounds.length, elapsedMinutes);
      if (!floorCheck.passed) {
        const stop = rc.stop ?? {};
        const budgetRemains = (stop.maxRounds === undefined || journal.rounds.length < stop.maxRounds)
          && (stop.maxWallHours === undefined || (elapsedMinutes / 60) < stop.maxWallHours);
        if (budgetRemains) {
          const marker = `[research-floor:round-${journal.rounds.length}]`;
          appendSchedulerGuidanceOnce(
            ctx.runDirPath,
            RUN_WIDE_GUIDANCE_TARGET,
            marker,
            `A ceiling was proposed (${finalEval.reason}) but the brief's ceiling floor is unmet: ${floorCheck.reason}.\n`
              + `▶ START ROUND ${journal.rounds.length + 1} — a NEW direction from the brief's portfolio. Write its measured result to ${resultRel}.`,
          );
          try {
            mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
            writeFileSync(join(ctx.runDirPath, 'signals', 'research_continue.json'), JSON.stringify({ round: journal.rounds.length, runningBest: finalEval.runningBest, floorDeferred: floorCheck.reason, timestamp: new Date().toISOString() }), 'utf-8');
          } catch { /* non-critical */ }
          // The floor owns the effective decision. Leaving a durable
          // `stop_ceiling` fact here makes the conditional finalizer eligible at
          // the start of the next iteration, before the extra round just required.
          finalEval.decision = 'continue';
          finalEval.reason = `${finalEval.reason} | ceiling deferred: floor unmet (${floorCheck.reason})`;
          try { writeFileSync(join(ctx.runDirPath, 'research_decision.json'), JSON.stringify(finalEval, null, 2) + '\n', 'utf-8'); } catch { /* non-critical */ }
          log.warn({ runId: ctx.runId, reason: floorCheck.reason }, 'Ceiling floor unmet — NOT terminating; steering next research round');
          return null;
        }
        finalEval.reason = `${finalEval.reason} | WARNING: ceiling committed with floor unmet (${floorCheck.reason}) — hard round/wall budget exhausted`;
      }
    }

    const policyTerminalStatus = terminalDecision === 'ship' ? RUN_STATUS.SHIPPED : RUN_STATUS.CEILING_HIT;
    const policyTerminalPath = state.terminalStates?.[policyTerminalStatus]?.paths?.[0];
    const policyTerminalOwner = policyTerminalPath
      ? admittedTerminalOwner(ctx.runDirPath, policyTerminalPath)
      : undefined;
    if (policyTerminalOwner) {
      
      try {
        writeFileSync(join(ctx.runDirPath, 'research_decision.json'), `${JSON.stringify({
          ...finalEval,
          decision: terminalDecision,
          terminalStatus: policyTerminalStatus,
          terminalPath: policyTerminalPath,
          terminalOwner: policyTerminalOwner,
        }, null, 2)}\n`, 'utf-8');
        mkdirSync(join(ctx.runDirPath, 'signals'), { recursive: true });
        writeFileSync(join(ctx.runDirPath, 'signals', 'research_terminal_ready.json'), `${JSON.stringify({
          version: 1,
          decision: terminalDecision,
          terminalStatus: policyTerminalStatus,
          terminalPath: policyTerminalPath,
          terminalOwner: policyTerminalOwner,
          reason: finalEval.reason,
        }, null, 2)}\n`, 'utf-8');
        const lastRound = journal.rounds.at(-1);
        const lastConsumed = join(ctx.runDirPath, `research_round_${journal.rounds.length}_consumed.json`);
        if (lastRound?.outcome !== 'no_candidate' && !existsSync(resultAbs) && existsSync(lastConsumed)) {
          copyFileSync(lastConsumed, resultAbs);
        }
      } catch { /* terminal owner will expose missing decision evidence */ }
      appendSchedulerGuidanceOnce(
        ctx.runDirPath,
        policyTerminalOwner,
        `[research-terminal-ready:${journal.rounds.length}:${terminalDecision}]`,
        `The mechanically settled research decision is ${terminalDecision}. Read research_decision.json and write exactly the matching declared terminal artifact ${policyTerminalPath}; do not write any other terminal path.`,
        Object.keys(state.stages),
      );
      return null;
    }

    // Legacy/static workflows without an admitted terminal owner retain the
    // framework-authored terminal path for compatibility.
    state.status = policyTerminalStatus;
    // FIX D — if confirm was declared but this is a non-ship terminal, record that it was not run
    // (the confirm gate above only writes research_confirm.json on a ship). Observability only.
    if (terminalDecision !== 'ship') recordConfirmNotRun(ctx.runDirPath, rc.confirm, state.status);
    state.completedAt = new Date().toISOString();
    // Engine bug #3 (event-drift audit): the research loop terminates the run between
    // iterations, so stages dispatched for the current iteration (verify_*/fix_*) can be
    // left 'pending' forever in run.json. Mark them skipped with the reason, honestly.
    markLeftoverStagesSkipped(state, `research loop terminated (${state.status}) before this stage ran`);
    
    const declaredPath = state.terminalStates?.[state.status]?.paths?.[0];
    if (declaredPath) state.terminalArtifact = declaredPath.split('/').pop();
    
    try {
      const lastConsumed = join(ctx.runDirPath, `research_round_${journal.rounds.length}_consumed.json`);
      if (!existsSync(resultAbs) && existsSync(lastConsumed)) copyFileSync(lastConsumed, resultAbs);
    } catch { /* non-critical */ }

    const reportBody = `# Research ${terminalDecision === 'ship' ? 'Ship' : 'Ceiling'} Report\n\n`
      + `Decision: ${terminalDecision}\n`
      + `Running-best: ${finalEval.runningBest}\n`
      + `Baseline: ${rc.baseline}\n`
      + `Kept directions: ${finalEval.keptLabels.join(', ') || 'none'}\n`
      + `Reason: ${finalEval.reason}\n\n`
      + `## Rounds\n` + journal.rounds.map((r) => r.outcome === 'no_candidate'
        ? `- ${r.label}: no candidate (${r.reason ?? 'no reason recorded'})`
        : `- ${r.label}: ${r.result}${r.confirmFailed ? ' (confirm gate FAILED — unconfirmed)' : ''}`).join('\n') + '\n';
    let wroteDeclaredCandidate = false;
    try {
      if (declaredPath) {
        const declaredAbs = join(ctx.projectDir, declaredPath);
        if (!existsSync(declaredAbs)) {
          mkdirSync(dirname(declaredAbs), { recursive: true });
          writeFileSync(declaredAbs, `> Engine-authored terminal candidate; acceptance remains subject to the declared reality checks.\n\n${reportBody}`, 'utf-8');
          wroteDeclaredCandidate = true;
        }
      }
    } catch (error) {
      log.warn({ runId: ctx.runId, error }, 'Could not materialize the research terminal candidate before reality verification');
    }
    const gate = await enforceRealityGateBeforeTerminal(ctx.projectDir, ctx.runId, state, state.status);
    // GAP-1: write a campaign jsonl row on the reality_gate_failed downgrade too, so the
    // outer loop sees the truthful terminal status (not a silent return with no envelope).
    if (!gate.allowed) {
      const quarantine = (source: string, label: string): void => {
        if (!existsSync(source)) return;
        try { renameSync(source, join(ctx.runDirPath, `reality_rejected_${label}`)); } catch { /* preserve evidence in place if move fails */ }
      };
      if (wroteDeclaredCandidate && declaredPath) quarantine(join(ctx.projectDir, declaredPath), declaredPath.split('/').pop() ?? 'terminal_candidate');
      writeCampaignEntry(ctx.projectDir, gate.state);
      return gate.state;
    }
    writeRunState(ctx.projectDir, ctx.runId, state);
    writeCampaignEntry(ctx.projectDir, state);
    recordRunEvent(ctx.projectDir, ctx.runId, {
      type: 'run_completed',
      runId: ctx.runId,
      timestamp: state.completedAt,
      iteration: ctx.iteration,
      detail: `Research ${terminalDecision}: ${finalEval.reason}`,
    });
    log.info({ runId: ctx.runId, decision: terminalDecision, runningBest: finalEval.runningBest }, 'Research loop terminated');
    await generateRunSummary(ctx.projectDir, ctx.runId, ctx.adapter).catch(() => { /* non-critical */ });
    return state;
  }

  return { tryAdvanceResearch };
}
