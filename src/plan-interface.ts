/** Public live-plan interface. Historical readers deliberately keep their own tolerant schemas. */
import { fileURLToPath } from 'node:url';
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
    + 'Return a JSON object {stages: [...]}; the engine publishes it in dispatch.yaml for existing consumers.\n'
    + JSON.stringify(PLAN_SCHEMA) + '\n'
    + 'Supply id, configured role, and the project-relative scope needed for writes. Missing scope is closed. '
    + 'Omitted depends_on means a root. Use edges only for real data dependencies; stage instructions supplement the injected full brief. '
    + 'Empty/omitted criterion_refs conservatively assign all brief criteria; nonempty subsets use exact brief_criteria.json IDs. '
    + 'Ordinary authored work needs a downstream independent gate. Existing-work audits may consist of gates with empty project scope, plus separate retry_to repairs. Scope amendments must preserve admission. '
    + 'The engine supplies empty artifact duties and each gate verdict when artifact_contract is omitted. '
    + 'Optional artifact contracts describe output/input locations for capabilities and ownership; they do not impose proof, replay or intermediate freshness duties. '
    + 'Put downstream analysis in stage instructions; human documents and their finalizer are needed only when the brief asks people to read them. The engine publishes run records and summary.md. Write reality_checks.md only for useful independent hard properties; baseline validation is already enforced. '
    + 'A sibling reality_checks.md is checked when present. Timeout/resource overrides remain retired.';
}

/** Point the planner at the installed engine and the exact current admission context. */
export function renderPlannerAdmissionCheck(projectDir: string, runDir: string): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return '# Check draft admission before finishing\n'
    + 'Save your complete candidate as "$TMPDIR/dispatch.json" in your writable scratch directory. Before returning it, run:\n'
    + `${quote(process.execPath)} ${quote(cli)} plan-check --project ${quote(projectDir)} --run ${quote(runDir)} "$TMPDIR/dispatch.json"\n`
    + 'This read-only command runs the same admission code as the scheduler, using this run’s workflow, brief, criteria, prior discharges, inputs and reality_checks.md. '
    + 'It prints every diagnosable error together. Repair the candidate and check again within this planner attempt until pass is true (exit 0), then return that checked candidate as your final JSON. '
    + 'Keep the candidate in scratch space; do not write project deliverables while planning.';
}

/** Read-only CLI route: no scheduler launch, reconciliation, adapter or service-manager calls. */
export async function cmdPlanCheck(args: string[]): Promise<number> {
  const { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } = await import('node:fs');
  const { resolve, dirname, join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { buildRoleRegistry, createDispatchAdmission, loadWorkflow } = await import('./scheduler/sched_admission/dispatch.js');
  const { firstDeclaredInputScopeConflict, resolveDeclaredInputWriteBindings } = await import('./scheduler/sched_scope/path-capabilities.js');
  const { parseBriefFrontmatter } = await import('./scheduler/sched_admission/brief-contract.js');
  const { extractBriefCriteria } = await import('./brief-criteria.js');
  const { inspectDispatchProposal } = await import('./scheduler/sched_policy/dispatch-injection.js');
  const { loadProjectDefaults } = await import('./config.js');
  let scratch: string | undefined;
  try {
    const options = new Map<string, string>();
    const files: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (['--project', '--brief', '--run'].includes(arg)) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
        options.set(arg, args[++i]);
      } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
      else files.push(arg);
    }
    if (options.has('--brief') === options.has('--run') || files.length !== 1) throw new Error('Usage: flowcrew plan-check --project <project> (--brief <brief-file> | --run <run-dir>) <dispatch-file>');
    const projectDir = resolve(options.get('--project') ?? process.cwd());
    const defaults = loadProjectDefaults(projectDir);
    const localAgents = resolve(projectDir, defaults.paths.agents);
    const roles = buildRoleRegistry(existsSync(localAgents) ? localAgents : resolve(import.meta.dirname, '..', 'config', 'agents'));
    let runDirPath: string;
    let state: import('./store.js').StoreState;
    let baseStages: import('./scheduler/sched_admission/configuration.js').StageConfig[];
    const errors: string[] = [];
    if (options.has('--run')) {
      runDirPath = resolve(options.get('--run')!);
      const { readArchivedRunStateFromDirectory } = await import('./store.js');
      state = readArchivedRunStateFromDirectory(runDirPath).state as import('./store.js').StoreState;
      baseStages = loadWorkflow(join(runDirPath, 'workflow.yaml')).config.stages;
    } else {
      const brief = readFileSync(resolve(options.get('--brief')!), 'utf8');
      const parsedBrief = parseBriefFrontmatter(brief);
      const workflowName = parsedBrief.research ? 'research' : 'default';
      const localWorkflow = resolve(projectDir, defaults.paths.workflows, `${workflowName}.yaml`);
      baseStages = loadWorkflow(existsSync(localWorkflow) ? localWorkflow : resolve(import.meta.dirname, '..', 'config', 'workflows', `${workflowName}.yaml`)).config.stages;
      scratch = mkdtempSync(resolve(tmpdir(), 'fc-plan-check-'));
      runDirPath = scratch;
      writeFileSync(join(scratch, 'task_brief.md'), brief);
      writeFileSync(join(scratch, 'brief_criteria.json'), JSON.stringify(extractBriefCriteria(brief)));
      const checksPath = resolve(dirname(resolve(files[0])), 'reality_checks.md');
      if (existsSync(checksPath)) copyFileSync(checksPath, join(scratch, 'reality_checks.md'));
      state = { stages: {}, terminalStates: parsedBrief.terminalStates, research: parsedBrief.research } as import('./store.js').StoreState;
      for (const error of [parsedBrief.frontmatterError, parsedBrief.researchPolicyError, parsedBrief.researchFeasibilityError]) if (error) errors.push(error);
    }
    const { report } = inspectDispatchProposal({
      inspectDispatchAdmission: createDispatchAdmission(firstDeclaredInputScopeConflict), resolveDeclaredInputWriteBindings,
    }, {
      rawDispatchText: readFileSync(resolve(files[0]), 'utf8'),
      dispatchStageId: baseStages.find(stage => stage.dynamic_dispatch)?.id ?? 'plan',
      roleRegistry: roles, sorted: baseStages, state, projectDir, runDirPath,
    });
    errors.push(...report.errors);
    process.stdout.write(`${JSON.stringify({ ...report, errors, pass: errors.length === 0 }, null, 2)}\n`);
    return errors.length ? 1 : 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ pass: false, errors: [error instanceof Error ? error.message : String(error)] })}\n`);
    return 1;
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}
