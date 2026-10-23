/** Native dispatch transport parsing, admission and persistence; receives admission, declared-input and scope-disposition services. */
import { type BriefCriteriaArtifact } from '../../brief-criteria.js';
import { type DispatchAdmissionReport, type DispatchAdmissionError, admissionError, collectTransitiveDependents, formatDispatchStageSchemaFailure, readBriefCriteriaForAdmission, resolveDispatchDependencies, shadowStageWithoutInvalidFields, validatedCriterionDischarges } from '../sched_admission/dispatch.js';
import { STAGE_STATUS, type StageStatus, type StoreState, isPendingStageStatus, resetStageLiveAttemptAliases, runDir, stageDir, writeRunState } from '../../store.js';
import { type StageConfig, parseDispatchedStageConfig, refreshRunQueryState } from '../sched_admission/configuration.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from '../../engine-fs.js';
import { existsSync, readFileSync } from 'node:fs';
import { inspectRealityCheckReachability } from '../sched_admission/reality-reads.js';
import { join } from 'node:path';
import { log } from '../sched_admission/shared.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { promoteAdmittedRealityChecks } from '../sched_admission/dispatch-retry.js';
import { recordAdmittedPlan } from '../../plan-revisions.js';
import { recordRunEvent } from '../../run-events.js';
import { readDispatchDocument } from '../../dispatch-document.js';
import { parseRealityChecks } from '../../reality-gate/index.js';
import { ZodError } from 'zod';

export interface DispatchInjectionServices {
  inspectDispatchAdmission: ReturnType<typeof import('../sched_admission/dispatch.js').createDispatchAdmission>;
}

/** The same read-only proposal inspection serves scheduler injection and planner self-checks. */
export function inspectDispatchProposal(
  services: Pick<DispatchInjectionServices, 'inspectDispatchAdmission'>,
  input: { rawDispatchText: string; dispatchStageId: string; roleRegistry: Map<string, { name: string; description: string }>;
    sorted: StageConfig[]; state: StoreState; projectDir: string; runDirPath: string },
): { report: DispatchAdmissionReport; dispatched: StageConfig[]; items: unknown } {
  const { inspectDispatchAdmission } = services;
  const { rawDispatchText, dispatchStageId, roleRegistry, sorted, state, projectDir, runDirPath } = input;
  const finish = (report: DispatchAdmissionReport, dispatched: StageConfig[], items: unknown) => {
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
      errors: [admissionError('dispatch_yaml_invalid', `dispatch.yaml could not be parsed as YAML (${error instanceof Error ? error.message : String(error)})`, 'dispatch.yaml')],
      warnings: [],
      proposalDigest,
      terminalOwners: {},
    };
    return finish(report, [], undefined);
  }
  const dispatched: StageConfig[] = [];
  const skippedReasons: DispatchAdmissionError[] = [];
  const schemaReasons: DispatchAdmissionError[] = [];
  const seenIds = new Set<string>(sorted.map(s => s.id));
  for (let i = 0; i < itemList.length; i++) {
    const item = structuredClone(itemList[i]) as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') {
      skippedReasons.push(admissionError('stage_schema_invalid', `${i}: stage item must be an object`, 'stages'));
      continue;
    }
    if (seenIds.has(item.id as string)) {
      skippedReasons.push(admissionError('stage_id_duplicate', `${item.id}: duplicate stage ID; rename this stage to a unique ID and update its dependency references`, 'id', String(item.id)));
      continue;
    }
    if (!roleRegistry.has(item.role as string)) {
      skippedReasons.push(admissionError('stage_role_unknown', `${item.id}: unknown role "${item.role}"; replace it with one of the available configured roles`, 'role', String(item.id)));
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
      const schemaErrors = (error instanceof ZodError ? error.issues.map(issue => ({
        field: issue.path.map((key, index) => {
          if (typeof key !== 'number') return key;
          const parent = issue.path.slice(0, index).reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[String(part)], item);
          const member = (parent as unknown[] | undefined)?.[key];
          return typeof member === 'object' && member !== null
            ? ((member as Record<string, unknown>).path ?? (member as Record<string, unknown>).id ?? 'item')
            : typeof member === 'string' ? member : 'item';
        }).join('.') || 'stage', error: new ZodError([issue]),
      })) : [{ field: 'stages', error }]).map(issue =>
        admissionError('stage_schema_invalid', `${item.id}: ${formatDispatchStageSchemaFailure(issue.error)}`, issue.field, String(item.id)));

      const shadow = shadowStageWithoutInvalidFields(item, error);
      if (shadow) {
        dispatched.push(shadow);
        seenIds.add(item.id as string);
        schemaReasons.push(...schemaErrors);
      } else {
        skippedReasons.push(...schemaErrors);
      }
    }
  }
  if (itemList.length === 0) skippedReasons.push(admissionError('dispatch_stages_empty', 'dispatch contains no stages', 'stages'));

  resolveDispatchDependencies(dispatched, dispatchStageId);
  let criteria: BriefCriteriaArtifact | undefined;
  try {
    criteria = readBriefCriteriaForAdmission(runDirPath);
  } catch (error) {
    const report: DispatchAdmissionReport = {
      version: 1,
      pass: false,
      checkedAt: new Date().toISOString(),
      errors: [...skippedReasons, ...schemaReasons, admissionError('brief_criteria_invalid', error instanceof Error ? error.message : String(error), 'criteria')],
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
  const admission = inspectDispatchAdmission({
    dispatched,
    baseStages: sorted,
    dispatchStageId,
    terminalStates: state.terminalStates,
    research: state.research,
    criteria: effectiveCriteria,
    criterionDischarges: validatedCriterionDischarges(runDirPath, state, effectiveCriteria?.briefDigest),
    projectDir,
    runDir: runDirPath,
  });
  admission.proposalDigest = proposalDigest;
  const checksPath = join(runDirPath, 'reality_checks.md');
  const typedChecks = items && typeof items === 'object' && 'reality_checks' in items
    ? parseRealityChecks(items.reality_checks) : undefined;
  if (typedChecks || existsSync(checksPath)) {
    admission.errors.push(...inspectRealityCheckReachability({
      ...(typedChecks ? { checks: typedChecks } : { markdown: readFileSync(checksPath, 'utf-8') }),
      projectDir,
      runDir: runDirPath,
      stages: dispatched,
      terminalStates: state.terminalStates,
      research: state.research,
    }).map(message => admissionError('reality_check_invalid', message, 'reality_checks')));
  }
  admission.errors.unshift(...skippedReasons, ...schemaReasons);
  return finish(admission, dispatched, items);
}

export function createDispatchInjector(services: DispatchInjectionServices) {

  function injectDispatchedStages(
    dispatchStageId: string,
    roleRegistry: Map<string, { name: string; description: string }>,
    sorted: StageConfig[],
    state: StoreState,
    projectDir: string,
    runId: string,
    inspectOnly = false,
  ): StageConfig[] {
    // Read dispatch.yaml from run dir
    const runDirPath = runDir(projectDir, runId);
    const emitAdmissionRejection = (report: DispatchAdmissionReport): void => {
      recordRunEvent(projectDir, runId, {
        type: 'admission_rejected', runId, timestamp: report.checkedAt,
        stageId: dispatchStageId, detail: report.errors.map(error => error.message).join('; '),
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
      rawDispatchText, dispatchStageId, roleRegistry, sorted, state, projectDir, runDirPath,
    });
    if (!publishAdmission(admission)) {
      log.warn({ errors: admission.errors }, 'Dynamic dispatch refused before any proposed stage was injected');
      return [];
    }


    // Inspection stops before every state/workflow mutation.
    if (inspectOnly) return dispatched;


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
    // Dispatch topology and reachability have now been admitted as
    // one proposal. Only at this boundary may candidate check bytes replace the
    // prior scheduler-owned snapshot.
    // Keep the existing admitted snapshot and terminal reader as the sole durable
    // check channel; new planners no longer author or parse Markdown fences.
    if (items && typeof items === 'object' && 'reality_checks' in items) {
      writeFileSync(join(runDirPath, 'reality_checks.md'), `## Reality checks\n${stringifyYaml({ checks: parseRealityChecks(items.reality_checks) })}`, 'utf-8');
    }
    promoteAdmittedRealityChecks(runDirPath, state);

    writeRunState(projectDir, runId, state);

    return dispatched;
  }

  return { injectDispatchedStages };
}
