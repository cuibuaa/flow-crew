/** Public live-plan interface. Historical readers deliberately keep their own tolerant schemas. */
import { parseCommandArgs, commandUsage } from './cli-args.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { type Schema } from './reality-gate/checks/json-schema-match.js';
import { REALITY_CHECK_TYPES } from './reality-gate/types.js';

const strings: Schema = { type: 'array', items: { type: 'string' } };
export const PLAN_STAGE_SCHEMA: Schema = {
  type: 'object', required: ['id', 'role'], additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
    role: { type: 'string', minLength: 1 }, scope: strings, depends_on: strings,
    prompt_template: { type: 'string' }, task: { type: 'string' }, condition: { type: 'string' },
    is_gate: { type: 'boolean' }, retry_to: strings, criterion_refs: strings,
    skills: strings, dynamic_dispatch: { type: 'boolean' },
    // Optional output/input locations supply write capabilities and ownership metadata.
    artifact_contract: { type: 'object' },
  },
};
export const PLAN_SCHEMA: Schema = { type: 'object', required: ['stages'], additionalProperties: false, properties: {
  stages: { type: 'array', minItems: 1, items: PLAN_STAGE_SCHEMA },
  reality_checks: { type: 'array', items: { type: 'object', required: ['name', 'type', 'reads'], properties: {
    name: { type: 'string' }, type: { type: 'string', enum: [...REALITY_CHECK_TYPES] },
    reads: { type: 'array', items: { type: 'object' } },
    params: { type: 'object' }, advisory: { type: 'boolean' },
  } } },
} };

// Recorded readers retain historical metadata; generation describes consumed fields.
export const RECORDED_PLAN_STAGE_SCHEMA: Schema = { ...PLAN_STAGE_SCHEMA, properties: {
  ...PLAN_STAGE_SCHEMA.properties,
  race: { type: 'boolean' }, // Historical records only.
  dependency_reasons: { type: 'object', additionalProperties: { type: 'string' } },
  max_retries: { type: 'number' }, timeout_ms: {}, timeout_total_ms: {}, resources: {},
} };
export const RECORDED_PLAN_SCHEMA: Schema = { ...PLAN_SCHEMA, additionalProperties: true, properties: {
  stages: { ...PLAN_SCHEMA.properties!.stages, items: RECORDED_PLAN_STAGE_SCHEMA },
} };

export function renderPlanInterface(): string {
  return '# dispatch.yaml interface\n'
    + 'Write the complete plan to dispatch.yaml in this run directory as a JSON object {stages: [...], reality_checks?: [...]} or equivalent YAML. The planner owns this declared output; the engine admits it after the stage completes.\n'
    + JSON.stringify(PLAN_SCHEMA) + '\n'
    + 'Use PLAN_SCHEMA above for the plan shape and plan-check below for admission errors. '
    + 'Declare optional deterministic checks in reality_checks; omission inherits admitted checks, while [] clears them. '
    + 'A sibling fenced-YAML reality_checks.md remains a read alias for one release.';
}

/** Point the planner at the installed engine and the exact current admission context. */
export function renderPlannerAdmissionCheck(projectDir: string, runDir: string): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return '# Check draft admission before finishing\n'
    + 'Write your complete candidate to dispatch.yaml in this run directory. Before finishing, run:\n'
    + `${quote(process.execPath)} ${quote(cli)} plan-check --project ${quote(projectDir)} --run ${quote(runDir)} ${quote(join(runDir, 'dispatch.yaml'))}\n`
    + 'This read-only command runs the same admission code as the scheduler, using this run’s workflow, brief, criteria, prior discharges, inputs and reality_checks (or the historical reality_checks.md alias). '
    + 'It prints every diagnosable error together. Repair the candidate and check again within this planner attempt until pass is true (exit 0), then return your ordinary stage report. '
    + 'Do not write project deliverables while planning.';
}

/** Read-only CLI route: no scheduler launch, reconciliation, adapter or service-manager calls. */
export async function cmdPlanCheck(args: string[]): Promise<number> {
  const { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } = await import('./engine-fs.js');
  const { resolve, dirname, join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { admissionError, buildRoleRegistry, createDispatchAdmission, loadWorkflow } = await import('./scheduler/sched_admission/dispatch.js');
  const { parseBriefFrontmatter } = await import('./scheduler/sched_admission/brief-contract.js');
  const { extractBriefCriteria } = await import('./brief-criteria.js');
  const { inspectDispatchProposal } = await import('./scheduler/sched_policy/dispatch-injection.js');
  const { engineConfigDir } = await import('./config.js');
  let scratch: string | undefined;
  try {
    const parsed = parseCommandArgs('plan-check', args);
    if (parsed.help) { process.stdout.write(`${commandUsage('plan-check')}\n`); return 0; }
    const options = parsed.values;
    const files = parsed.positionals;
    if (options.has('--brief') === options.has('--run') || files.length !== 1) throw new Error(commandUsage('plan-check'));
    const projectDir = resolve(options.get('--project') ?? process.cwd());
    const roles = buildRoleRegistry(join(engineConfigDir, 'agents'));
    let runDirPath: string;
    let state: import('./store.js').StoreState;
    let baseStages: import('./scheduler/sched_admission/configuration.js').StageConfig[];
    const errors: import('./scheduler/sched_admission/dispatch.js').DispatchAdmissionError[] = [];
    if (options.has('--run')) {
      runDirPath = resolve(options.get('--run')!);
      const { readArchivedRunStateFromDirectory } = await import('./store.js');
      state = readArchivedRunStateFromDirectory(runDirPath).state as import('./store.js').StoreState;
      baseStages = loadWorkflow(join(runDirPath, 'workflow.yaml'), true).config.stages;
    } else {
      const brief = readFileSync(resolve(options.get('--brief')!), 'utf8');
      const parsedBrief = parseBriefFrontmatter(brief);
      const workflowName = parsedBrief.research ? 'research' : 'planner';
      baseStages = loadWorkflow(join(engineConfigDir, 'workflows', `${workflowName}.yaml`)).config.stages;
      scratch = mkdtempSync(resolve(tmpdir(), 'fc-plan-check-'));
      runDirPath = scratch;
      writeFileSync(join(scratch, 'task_brief.md'), brief);
      writeFileSync(join(scratch, 'brief_criteria.json'), JSON.stringify(extractBriefCriteria(brief)));
      const checksPath = resolve(dirname(resolve(files[0])), 'reality_checks.md');
      if (existsSync(checksPath)) copyFileSync(checksPath, join(scratch, 'reality_checks.md'));
      state = { stages: {}, terminalStates: parsedBrief.terminalStates, research: parsedBrief.research } as import('./store.js').StoreState;
      for (const error of [parsedBrief.frontmatterError, parsedBrief.researchPolicyError, parsedBrief.researchFeasibilityError]) if (error) errors.push(admissionError('brief_contract_invalid', error, 'frontmatter'));
    }
    const { report } = inspectDispatchProposal({
      inspectDispatchAdmission: createDispatchAdmission(),
    }, {
      rawDispatchText: readFileSync(resolve(files[0]), 'utf8'),
      dispatchStageId: baseStages.find(stage => stage.dynamic_dispatch)?.id ?? 'plan',
      roleRegistry: roles, sorted: baseStages, state, projectDir, runDirPath,
    });
    errors.push(...report.errors);
    process.stdout.write(`${JSON.stringify({ ...report, errors, pass: errors.length === 0 }, null, 2)}\n`);
    return errors.length ? 1 : 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ pass: false, errors: [{ code: 'plan_check_failed', message: error instanceof Error ? error.message : String(error), field: 'dispatch.yaml' }] })}\n`);
    return 1;
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}
