/** Native dispatch transport parsing, admission and persistence; receives admission, declared-input and scope-disposition services. */
import { type BriefCriteriaArtifact } from '../../brief-criteria.js';
import { type DispatchAdmissionReport, applyFrameworkScopeReservations, collectTransitiveDependents, formatDispatchStageSchemaFailure, readBriefCriteriaForAdmission, resolveDispatchDependencies, shadowStageWithoutInvalidFields, validatedCriterionDischarges } from '../sched_admission/dispatch.js';
import { STAGE_STATUS, type StageStatus, type StoreState, isPendingStageStatus, resetStageLiveAttemptAliases, runDir, stageDir, writeRunState } from '../../store.js';
import { type StageConfig, StageConfigSchema, parseDispatchedStageConfig, refreshRunQueryState } from '../sched_admission/configuration.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inspectRealityCheckReachability } from '../sched_admission/reality-reads.js';
import { join } from 'node:path';
import { log } from '../sched_admission/shared.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { promoteAdmittedRealityChecks } from '../sched_admission/dispatch-retry.js';
import { recordAdmittedPlan } from '../../plan-revisions.js';
import { recordRunEvent } from '../../run-events.js';
import { readDispatchDocument } from '../../dispatch-document.js';
import { inspectRealityChecks, formatRealityCheckPreflightFindings, type RealityCheckPreflightReport } from '../../reality-check-preflight.js';
import { readRunValidationBaseline } from '../sched_settlement/gate-validation.js';
import { readShipSetupReadyValidationBaseline } from '../../ship-setup-record.js';

export interface DispatchInjectionServices {
  inspectDispatchAdmission: ReturnType<typeof import('../sched_admission/dispatch.js').createDispatchAdmission>;
  resolveDeclaredInputWriteBindings: import('../sched_admission/scope-services.js').DeclaredInputScopeServices['resolveDeclaredInputWriteBindings'];
  applyScopePlanningDispositions(runDirPath: string, iteration: number, rawDispatch: unknown, dispatched: StageConfig[]): void;
}

/** Planning-time check intent is evaluated identically before self-check and injection. */
export function inspectProposalRealityChecks(projectDir: string, runDirPath: string, rawDispatchText: string, brief: string): RealityCheckPreflightReport {
  const checksPath = join(runDirPath, 'reality_checks.md');
  const markdown = existsSync(checksPath) ? readFileSync(checksPath, 'utf8') : '';
  const artifactContracts: NonNullable<StageConfig['artifact_contract']>[] = [];
  try {
    for (const item of readDispatchDocument(rawDispatchText).stages) {
      const parsed = StageConfigSchema.safeParse(item);
      if (parsed.success && parsed.data.artifact_contract && !parsed.data.condition && !parsed.data.retry_to?.length) artifactContracts.push(parsed.data.artifact_contract);
    }
  } catch { /* Proposal inspection owns malformed dispatch diagnostics. */ }
  return inspectRealityChecks(brief, markdown, {
    validationBaseline: readRunValidationBaseline(runDirPath)?.baseline ?? readShipSetupReadyValidationBaseline(projectDir, brief),
    projectDir, artifactContracts,
  });
}

/** The same read-only proposal inspection serves scheduler injection and planner self-checks. */
export function inspectDispatchProposal(
  services: Pick<DispatchInjectionServices, 'inspectDispatchAdmission' | 'resolveDeclaredInputWriteBindings'>,
  input: { rawDispatchText: string; dispatchStageId: string; roleRegistry: Map<string, { name: string; description: string }>;
    sorted: StageConfig[]; state: StoreState; projectDir: string; runDirPath: string; preflight?: RealityCheckPreflightReport },
): { report: DispatchAdmissionReport; dispatched: StageConfig[]; items: unknown } {
  const { inspectDispatchAdmission, resolveDeclaredInputWriteBindings } = services;
  const { rawDispatchText, dispatchStageId, roleRegistry, sorted, state, projectDir, runDirPath } = input;
  const briefPath = join(runDirPath, 'task_brief.md');
  const brief = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : state.taskDescription ?? '';
  const preflight = input.preflight ?? (brief.trim() ? inspectProposalRealityChecks(projectDir, runDirPath, rawDispatchText, brief) : undefined);
  const finish = (report: DispatchAdmissionReport, dispatched: StageConfig[], items: unknown) => {
    if (preflight?.refusingFindings.length) report.errors.push(formatRealityCheckPreflightFindings(preflight.refusingFindings));
    if (preflight) report.realityPreflight = preflight;
    report.pass = report.errors.length === 0;
    return { report, dispatched, items };
  };
  const proposalDigest = createHash('sha256').update(rawDispatchText, 'utf8').digest('hex');
  let items: unknown;
  let itemList: unknown[];
  try {
    const parsed = readDispatchDocument(rawDispatchText);
    items = parsed.document;
    itemList = parsed.stages;
  } catch (error) {
    const report: DispatchAdmissionReport = {
      version: 1,
      pass: false,
      checkedAt: new Date().toISOString(),
      errors: [`dispatch.yaml could not be parsed as YAML (${error instanceof Error ? error.message : String(error)})`],
      warnings: [],
      proposalDigest,
      terminalOwners: {},
    };
    return finish(report, [], undefined);
  }
  const dispatched: StageConfig[] = [];
  const skippedReasons: string[] = [];
  const schemaReasons: string[] = [];
  const seenIds = new Set<string>(sorted.map(s => s.id));
  for (let i = 0; i < itemList.length; i++) {
    const item = structuredClone(itemList[i]) as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') {
      skippedReasons.push(`${i}: stage item must be an object`);
      continue;
    }
    if (seenIds.has(item.id as string)) {
      skippedReasons.push(`${item.id}: duplicate stage ID; rename this stage to a unique ID and update its dependency references`);
      continue;
    }
    if (!roleRegistry.has(item.role as string)) {
      skippedReasons.push(`${item.id}: unknown role "${item.role}"; replace it with one of the available configured roles`);
      continue;
    }
    // Map task: to prompt_template:
    if (item.task && !item.prompt_template) {
      item.prompt_template = item.task;
      delete item.task;
    }
    try {
      dispatched.push(parseDispatchedStageConfig(item));
      seenIds.add(item.id as string);
    } catch (error) {
      const diagnostic = formatDispatchStageSchemaFailure(error);

      const shadow = shadowStageWithoutInvalidFields(item, error);
      if (shadow) {
        dispatched.push(shadow);
        seenIds.add(item.id as string);
        schemaReasons.push(`${item.id}: ${diagnostic}`);
      } else {
        skippedReasons.push(`${item.id}: ${diagnostic}`);
      }
    }
  }
  if (itemList.length === 0) skippedReasons.push('dispatch contains no stages');

  resolveDispatchDependencies(dispatched, dispatchStageId);
  let criteria: BriefCriteriaArtifact | undefined;
  try {
    criteria = readBriefCriteriaForAdmission(runDirPath);
  } catch (error) {
    const report: DispatchAdmissionReport = {
      version: 1,
      pass: false,
      checkedAt: new Date().toISOString(),
      errors: [...skippedReasons, ...schemaReasons, error instanceof Error ? error.message : String(error)],
      warnings: [],
      proposalDigest,
      terminalOwners: {},
    };
    return finish(report, [], undefined);
  }
  // A process-bound brief admission makes zero criteria a launch contract.
  // Direct library fixtures from before that contract may still exercise DAG
  // mechanics without manufacturing criterion coverage.
  const effectiveCriteria = criteria?.criteria.length === 0 && !state.briefAdmission
    ? undefined
    : criteria;
  const exactBriefPath = join(runDirPath, 'task_brief.md');
  const declaredInputs = existsSync(exactBriefPath)
    ? resolveDeclaredInputWriteBindings(projectDir, readFileSync(exactBriefPath, 'utf-8'))
    : [];
  const admission = inspectDispatchAdmission({
    dispatched,
    baseStages: sorted,
    dispatchStageId,
    terminalStates: state.terminalStates,
    research: state.research,
    criteria: effectiveCriteria,
    criterionDischarges: validatedCriterionDischarges(runDirPath, state, effectiveCriteria?.briefDigest),
    declaredInputs,
    projectDir,
    runDir: runDirPath,
  });
  admission.proposalDigest = proposalDigest;
  const checksPath = join(runDirPath, 'reality_checks.md');
  if (existsSync(checksPath)) {
    admission.errors.push(...inspectRealityCheckReachability({
      markdown: readFileSync(checksPath, 'utf-8'),
      projectDir,
      runDir: runDirPath,
      stages: dispatched,
      terminalStates: state.terminalStates,
      research: state.research,
    }));
  }
  admission.errors.unshift(...skippedReasons, ...schemaReasons);
  return finish(admission, dispatched, items);
}

export function createDispatchInjector(services: DispatchInjectionServices) {
  const { applyScopePlanningDispositions } = services;

  function injectDispatchedStages(
    dispatchStageId: string,
    roleRegistry: Map<string, { name: string; description: string }>,
    sorted: StageConfig[],
    state: StoreState,
    projectDir: string,
    runId: string,
    inspectOnly = false,
    preflight?: RealityCheckPreflightReport,
  ): StageConfig[] {
    // Read dispatch.yaml from run dir
    const runDirPath = runDir(projectDir, runId);
    const emitAdmissionRejection = (report: DispatchAdmissionReport): void => {
      recordRunEvent(projectDir, runId, {
        type: 'admission_rejected', runId, timestamp: report.checkedAt,
        stageId: dispatchStageId, detail: report.errors.join('; '),
        source: 'scheduler', level: 'warning',
      });
    };
    const publishAdmission = (report: DispatchAdmissionReport): boolean => {
      report.pass = report.pass && report.errors.length === 0;
      writeFileSync(join(runDirPath, 'dispatch_admission.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
      if (!report.pass) emitAdmissionRejection(report);
      return report.pass;
    };
    const dispatchPath = join(runDirPath, 'dispatch.yaml');
    if (!existsSync(dispatchPath)) return [];

    let rawDispatchText: string;
    try {
      rawDispatchText = readFileSync(dispatchPath, 'utf-8');
    } catch {
      return [];
    }
    const { report: admission, dispatched, items } = inspectDispatchProposal(services, {
      rawDispatchText, dispatchStageId, roleRegistry, sorted, state, projectDir, runDirPath, preflight,
    });
    if (!publishAdmission(admission)) {
      log.warn({ errors: admission.errors }, 'Dynamic dispatch refused before any proposed stage was injected');
      return [];
    }

    applyFrameworkScopeReservations(dispatched, admission.frameworkReservedScopes);

    // A preflight refusal still receives a complete admission observation. This
    // dry path stops before every state/workflow mutation, so no proposed stage
    // can run until both validators accept the same effective candidate pair.
    if (inspectOnly) return dispatched;

    applyScopePlanningDispositions(runDirPath, state.currentIteration ?? 1, items, dispatched);

    for (const s of dispatched) {
      mkdirSync(stageDir(projectDir, runId, s.id), { recursive: true });
      if (!state.stages[s.id]) {
        const pending: StageStatus = { status: STAGE_STATUS.PENDING, retries: 0 };
        if (state.stageEvidence?.some((entry) => entry.stageId === s.id)) {
          resetStageLiveAttemptAliases(projectDir, runId, s.id, pending);
        }
        state.stages[s.id] = pending;
      }
    }

    // Mark static stages that transitively depend on dispatch stage as skipped
    const transitive = collectTransitiveDependents(dispatchStageId, sorted);
    for (const id of transitive) {
      if (state.stages[id] && isPendingStageStatus(state.stages[id].status)) {
        state.stages[id] = { status: STAGE_STATUS.SKIPPED, retries: 0 };
        log.info({ stage: id }, 'Skipped (replaced by dispatched stages)');
      }
    }

    // Add dispatched stages to sorted list
    sorted.push(...dispatched);

    // Update stored workflow.yaml
    const wfPath = join(runDir(projectDir, runId), 'workflow.yaml');
    try {
      const wfRaw = readFileSync(wfPath, 'utf-8');
      const wfParsed = parseYaml(wfRaw) ?? {};
      if (!Array.isArray(wfParsed.stages)) wfParsed.stages = [];
      wfParsed.stages.push(...dispatched);
      writeFileSync(wfPath, stringifyYaml(wfParsed), 'utf-8');
    } catch { /* best effort */ }

    // Readers of the admitted dispatch (including verdict controls) need the
    // same derived criterion and artifact facts as workflow/state readers.
    writeFileSync(dispatchPath, stringifyYaml(Array.isArray(items) ? dispatched : { ...items as object, stages: dispatched }), 'utf-8');
    state.dispatchedStages = dispatched;
    refreshRunQueryState(state, sorted);
    recordAdmittedPlan(state, sorted, runDirPath, 'Initial dispatch admitted', true, admission);
    // Dispatch topology, reachability, and preflight have now been admitted as
    // one proposal. Only at this boundary may candidate check bytes replace the
    // prior scheduler-owned snapshot.
    promoteAdmittedRealityChecks(runDirPath, state);

    writeRunState(projectDir, runId, state);

    return dispatched;
  }

  return { injectDispatchedStages };
}
