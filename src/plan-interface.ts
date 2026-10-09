/** Public live-plan interface. Historical readers deliberately keep their own tolerant schemas. */
import { validate, type Schema } from './reality-gate/checks/json-schema-match.js';

const strings: Schema = { type: 'array', items: { type: 'string' } };
export const PLAN_STAGE_SCHEMA: Schema = {
  type: 'object', required: ['id', 'role'], additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,19}$' },
    role: { type: 'string', minLength: 1 }, scope: strings, depends_on: strings,
    prompt_template: { type: 'string' }, task: { type: 'string' }, condition: { type: 'string' },
    is_gate: { type: 'boolean' }, retry_to: strings, criterion_refs: strings,
    skills: strings, dynamic_dispatch: { type: 'boolean' },
    // Optional output/input locations supply write capabilities and ownership metadata.
    artifact_contract: { type: 'object' },
    // Recorded field names remain accepted; dependency prose and retry policy are not required.
    dependency_reasons: { type: 'object', additionalProperties: { type: 'string' } },
    max_retries: { type: 'number' }, timeout_ms: {}, timeout_total_ms: {}, resources: {},
  },
};
export const PLAN_SCHEMA: Schema = { type: 'object', required: ['stages'], additionalProperties: true, properties: { stages: { type: 'array', minItems: 1, items: PLAN_STAGE_SCHEMA } } };

export function planStageErrors(value: unknown): string[] {
  return validate(value, PLAN_STAGE_SCHEMA, '$');
}

export function renderPlanInterface(): string {
  return '# dispatch.yaml interface\n'
    + 'Return a JSON object {stages: [...]}; the engine publishes it in dispatch.yaml for existing consumers. This executable interface replaces older compulsory planning boilerplate.\n'
    + JSON.stringify(PLAN_SCHEMA) + '\n'
    + 'Supply id, configured role, and the project-relative scope needed for writes. Missing scope is closed. '
    + 'Omitted depends_on means a root. Use edges only for real data dependencies; stage instructions supplement the injected full brief. '
    + 'Empty/omitted criterion_refs conservatively assign all brief criteria; nonempty subsets use exact brief_criteria.json IDs. '
    + 'Ordinary authored work needs a downstream independent gate. Existing-work audits may consist of gates with empty project scope, plus separate retry_to repairs. Scope amendments must preserve admission. '
    + 'The engine supplies empty artifact duties and each gate verdict when artifact_contract is omitted. '
    + 'Optional artifact contracts describe output/input locations for capabilities and ownership; they do not impose proof, replay or intermediate freshness duties. '
    + 'Write tech_solution.md only when a stage reads it. Write reality_checks.md only for useful independent hard properties; baseline validation is already enforced. '
    + 'Check a draft without launching: flowcrew plan-check --project <project> --brief <brief-file> <dispatch-file>. '
    + 'A sibling reality_checks.md is checked when present. Timeout/resource overrides remain retired.';
}

/** Read-only CLI route: no scheduler launch, reconciliation, adapter or service-manager calls. */
export async function cmdPlanCheck(args: string[]): Promise<number> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { tmpdir } = await import('node:os');
    const { buildRoleRegistry, createDispatchAdmission, loadWorkflow } = await import('./scheduler/sched_admission/dispatch.js');
  const { parseDispatchedStageConfig } = await import('./scheduler/sched_admission/configuration.js');
  const { firstDeclaredInputScopeConflict, resolveDeclaredInputWriteBindings } = await import('./scheduler/sched_scope/path-capabilities.js');
  const { readDispatchDocument } = await import('./dispatch-document.js');
  const { parseBriefFrontmatter } = await import('./scheduler/sched_admission/brief-contract.js');
  const { extractBriefCriteria } = await import('./brief-criteria.js');
  const { inspectRealityCheckReachability } = await import('./scheduler/sched_admission/reality-reads.js');
  const { inspectRealityChecks } = await import('./reality-check-preflight.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  let scratch: string | undefined;
  try {
    const options = new Map<string, string>();
    const files: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (['--project', '--brief'].includes(arg)) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
        options.set(arg, args[++i]);
      } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
      else files.push(arg);
    }
    if (!options.has('--brief') || files.length !== 1) throw new Error('Usage: flowcrew plan-check --project <project> --brief <brief-file> <dispatch-file>');
    const projectDir = resolve(options.get('--project') ?? process.cwd());
    const brief = readFileSync(resolve(options.get('--brief')!), 'utf8');
    const parsedBrief = parseBriefFrontmatter(brief);
    const workflowName = parsedBrief.research ? 'research' : 'default';
    const localAgents = resolve(projectDir, 'config', 'agents');
    const roles = buildRoleRegistry(existsSync(localAgents) ? localAgents : resolve(import.meta.dirname, '..', 'config', 'agents'));
    const localWorkflow = resolve(projectDir, 'config', 'workflows', `${workflowName}.yaml`);
    const baseStages = loadWorkflow(existsSync(localWorkflow) ? localWorkflow : resolve(import.meta.dirname, '..', 'config', 'workflows', `${workflowName}.yaml`)).config.stages;
    const items = readDispatchDocument(readFileSync(resolve(files[0]), 'utf8')).stages;
    if (items.length === 0) throw new Error('dispatch contains no stages');
    const dispatched = items.map(parseDispatchedStageConfig);
    const errors: string[] = [];
    const seen = new Set(baseStages.map(stage => stage.id));
    for (const stage of dispatched) {
      if (seen.has(stage.id)) errors.push(`${stage.id}: duplicate stage ID`);
      seen.add(stage.id);
      if (!roles.has(stage.role)) errors.push(`${stage.id}: unknown role ${JSON.stringify(stage.role)}`);
    }
    for (const error of [parsedBrief.frontmatterError, parsedBrief.researchPolicyError, parsedBrief.researchFeasibilityError]) if (error) errors.push(error);
    scratch = mkdtempSync(resolve(tmpdir(), 'fc-plan-check-'));
    const report = createDispatchAdmission(firstDeclaredInputScopeConflict)({
      dispatched, baseStages, dispatchStageId: baseStages.find(stage => stage.dynamic_dispatch)?.id ?? 'plan',
      criteria: extractBriefCriteria(brief), declaredInputs: resolveDeclaredInputWriteBindings(projectDir, brief),
      terminalStates: parsedBrief.terminalStates, research: parsedBrief.research, projectDir, runDir: scratch,
    });
    const checksPath = resolve(dirname(resolve(files[0])), 'reality_checks.md');
    const checks = existsSync(checksPath) ? readFileSync(checksPath, 'utf8') : '';
    errors.push(...report.errors, ...inspectRealityCheckReachability({ markdown: checks, projectDir, runDir: scratch, stages: [...baseStages, ...dispatched], terminalStates: parsedBrief.terminalStates, research: parsedBrief.research }));
    const preflight = inspectRealityChecks(brief, checks, { projectDir, artifactContracts: dispatched.flatMap(stage => stage.artifact_contract ? [stage.artifact_contract] : []) });
    errors.push(...preflight.refusingFindings.map(finding => finding.message));
    process.stdout.write(`${JSON.stringify({ ...report, errors, pass: errors.length === 0, stages: dispatched }, null, 2)}\n`);
    return errors.length ? 1 : 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ pass: false, errors: [error instanceof Error ? error.message : String(error)] })}\n`);
    return 1;
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}
