import { stageLiveLogPath } from '../../stage-live-log.js';
// Boundary: adapt an admitted stage to a race whose candidate gates own acceptance.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from '../../engine-fs.js';
import { type Adapter, withRunProcessOwnership } from '../../adapters/base.js';
import type { AttemptDeadlineClock } from '../../attempt-deadline.js';
import { sumInvocationUsage } from '../../invocation-usage.js';
import { runRace } from '../../race.js';
import { RUN_STATUS, type StoreState, readStageOutput, reserveRun, runDir, updateRunState } from '../../store.js';
import { parseCondition } from '../../condition.js';
import { artifactActivation } from '../../artifact-declarations.js';
import { buildDependencyContext } from '../../handoff.js';
import { guidanceForExecution, guidanceForStageFromText, parseGuidanceLedger, readGuidanceForStage, readOperatorCriterionRulings, renderGuidanceDelivery, renderGuidanceEnvelope } from '../../guidance.js';
import { buildRetryPreamble } from '../sched_admission/dispatch-retry.js';
import { createSchedulerTechnicalRetryState, prepareSchedulerTechnicalAttempt, stageInitialTimeout } from '../sched_settlement/stage-execution.js';
import { type StageConfig, type WorkflowConfig, WorkflowConfigSchema, raceCandidateStages } from '../sched_admission/configuration.js';
import { stageScopeOwnsPath } from '../sched_admission/dispatch.js';
import { parseBriefFrontmatter } from '../sched_admission/brief-contract.js';
import { extractDeclaredBriefInputPaths } from '../../ship-inputs.js';
import { scopeBriefCriteria } from '../../brief-criteria.js';
import { collectGateRuntimeFacts, type GateRuntimeFacts } from '../sched_settlement/gate-recovery.js';
import { runWorkflow } from './run-workflow.js';

/** Deleting the CLI cannot isolate stage writes or integrate a winner. This adapter
 * replaces its launch/setup plumbing, while the worker retains settlement and scope enforcement. */
export function stageRaceAdapter(input: {
  stage: StageConfig; stages: StageConfig[]; adapter: Adapter; agentsDir: string;
  projectDir: string; runDirPath: string; state: StoreState; skills?: string;
  defaults?: WorkflowConfig['defaults'];
  attemptDeadlineClockFactory?: () => AttemptDeadlineClock;
}): Adapter {
  const execute: Adapter['run'] = async (_prompt, role, opts) => {
    const candidateStages = raceCandidateStages(input.stage, input.stages);
    const candidateIds = new Set(candidateStages.map(stage => stage.id));
    const externalIds = [...new Set(candidateStages.flatMap(stage => [
      ...stage.depends_on, ...(stage.condition ? [parseCondition(stage.condition).stageId] : []),
    ]).filter(id => !candidateIds.has(id)))];
    const scratch = mkdtempSync(join(tmpdir(), 'flowcrew-stage-race-'));
    const targets: [string, string] = [join(scratch, 'a'), join(scratch, 'b')];
    const recordPath = join(opts.runDir, 'stages', input.stage.id, `race_${opts.attemptIndex ?? 1}.json`);
    const progress = (text: string) => appendFileSync(stageLiveLogPath(opts.runDir, opts.stageId, opts.attemptIndex, opts.attemptStartedAt), `${text}\n`);
    // Outside this child graph, settled predicates become snapshot facts.
    const freezeArtifact = <T extends { when?: Parameters<typeof artifactActivation>[0] }>(artifact: T): T[] => {
      if (!artifact.when || candidateIds.has(artifact.when.stage)) return [artifact];
      const activation = artifactActivation(artifact.when, input.state.stages);
      if (activation === 'unknown') throw new Error(`Race input requires settled ${artifact.when.stage}.${artifact.when.field}`);
      return activation === 'inactive' ? [] : [{ ...artifact, when: undefined }];
    };
    const states = new Map<string, StoreState>();
    const gateFacts = new Map<string, GateRuntimeFacts>();
    const workflows = new Map<string, ReturnType<typeof WorkflowConfigSchema.parse>>();
    const baselines = new Map<string, string>();
    const usage = () => sumInvocationUsage([...states.values()].flatMap(state => Object.values(state.stages)
      .flatMap(stage => stage.attempts ?? [])));
    const brief = readFileSync(join(input.runDirPath, 'task_brief.md'), 'utf8');
    // Child gates retain every criterion they will settle in the parent, including
    // review duties for settled ancestors. Authoring keeps its own narrower goal.
    const parsed = parseBriefFrontmatter(brief);
    const inputs = extractDeclaredBriefInputPaths(brief);
    const candidateRefs = [...new Set(candidateStages.filter(stage => stage.id === input.stage.id || stage.is_gate)
      .flatMap(stage => stage.criterion_refs))];
    const childBody = scopeBriefCriteria(parsed.stripped, candidateRefs);
    const candidateBody = scopeBriefCriteria(parsed.stripped, input.stage.criterion_refs);
    const candidateBrief = `---\n${stringify({ inputs })}---\n${childBody}`;
    // Let the child scheduler compile its own execution identity and obligations.
    const authoredTemplate = input.stage.prompt_template?.trim() ? input.stage.prompt_template : candidateBody;
    const candidatePrompt = authoredTemplate.replaceAll(brief.trim(), () => candidateBody.trim())
      .replaceAll(parsed.stripped.trim(), () => candidateBody.trim())
      + (input.stage.prompt_template?.trim() ? '' : '\nProject: {project}');
    const parentStatus = input.state.stages[input.stage.id];
    const retries = parentStatus?.retries ?? 0;
    const prepared = retries > 0 ? prepareSchedulerTechnicalAttempt(createSchedulerTechnicalRetryState(
      stageInitialTimeout(), parentStatus, true)) : undefined;
    const retryPreamble = prepared ? buildRetryPreamble(retries, prepared.budgetMs,
      input.runDirPath, input.stage.id, prepared.retryContext) : '';
    // Guidance keeps its parent binding as evidence, rather than becoming an
    // instruction for an unrelated child execution with the same numeric index.
    const ledger = join(input.runDirPath, 'supervisor_guidance.md');
    const rulings = readOperatorCriterionRulings(input.runDirPath, candidateRefs);
    const rulingIds = new Set(rulings.map(entry => entry.id));
    const canonicalGuidance = existsSync(ledger) ? parseGuidanceLedger(readFileSync(ledger, 'utf8'))
      .filter(entry => entry.attemptIndex === undefined || rulingIds.has(entry.id)) : [];
    const childReadableGuidance = new Set(canonicalGuidance
      .filter(entry => entry.attemptIndex === undefined || entry.attemptIndex === 1).map(entry => entry.id));
    const parentGuidance = (stage: StageConfig) => {
      const status = input.state.stages[stage.id];
      const attemptIndex = stage.id === input.stage.id ? opts.attemptIndex ?? 1 : (status?.attempts?.at(-1)?.index ?? 0) + 1;
      const entries = readGuidanceForStage(input.runDirPath, stage.id, attemptIndex);
      const receipt = join(input.runDirPath, 'stages', stage.id, 'guidance_consumed.md');
      if (existsSync(receipt)) for (const prior of status?.attempts ?? []) {
        for (const entry of guidanceForStageFromText(readFileSync(receipt, 'utf8'), stage.id, prior.index)) {
          if (!entries.some(current => current.id === entry.id)) entries.push(entry);
        }
      }
      return renderGuidanceDelivery(guidanceForExecution(entries, attemptIndex)
        .filter(entry => !childReadableGuidance.has(entry.id)));
    };
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (target: string, args: string[], stdin?: string, index?: string) => execFileSync('git', args,
      { cwd: target, input: stdin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: index ? { ...gitEnv, GIT_INDEX_FILE: index } : gitEnv });
    const contained = (path: string) => path !== '..' && !path.startsWith('../') && !isAbsolute(path);
    const projectRelative = (source: string, target: string) => relative(source, target).split(sep).join('/');
    const links = new Map<string, Map<string, { original: string; private: string }>>();
    const copyProject = (source: string, destination: string, copies = new Map<string, string>()) => {
      // Each transfer replaces one snapshot; another transfer's aliases must
      // never bind this one to a retired candidate or stale published files.
      if (!copies.size) rmSync(destination, { recursive: true, force: true });
      const sourceRoot = realpathSync(source); copies.set(sourceRoot, destination);
      const copiedLinks = new Map<string, { original: string; private: string }>(); links.set(destination, copiedLinks);
      cpSync(sourceRoot, destination, { recursive: true, verbatimSymlinks: true, filter: (path, target) => {
        const name = projectRelative(sourceRoot, path);
        if (name.split('/').some(part => part === '.git' || part === '.fc')) return false;
        if (!lstatSync(path).isSymbolicLink()) return true;
        const link = readlinkSync(path), referent = projectRelative(sourceRoot, resolve(dirname(path), link));
        let privateTarget = join(destination, referent);
        if (!contained(referent)) {
          const physical = realpathSync(path), copied = copies.get(physical);
          if (!copied) { copyProject(physical, target, copies); return false; }
          privateTarget = copied;
        }
        const privateLink = relative(dirname(target), privateTarget) || '.';
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(privateLink, target);
        copiedLinks.set(name, { original: links.get(source)?.get(name)?.original ?? link, private: privateLink });
        return false;
      } });
    };
    // Compare logical link blobs in a disposable index. The author's index and
    // HEAD stay private, even when a later gate or repair runs git reset.
    const projectTree = (target: string, tree: string) => {
      const index = join(scratch, 'projection.index'); rmSync(index, { force: true });
      git(target, ['read-tree', tree], undefined, index);
      for (const entry of git(target, ['ls-files', '--stage', '-z'], undefined, index).split('\0')) {
        if (!entry.startsWith('120000 ')) continue;
        const path = entry.slice(entry.indexOf('\t') + 1), blob = entry.split(' ')[1];
        const value = git(target, ['cat-file', 'blob', blob]), inputLink = links.get(target)?.get(path);
        let logical = inputLink && value === inputLink.private ? inputLink.original : value;
        if (logical === value && isAbsolute(value)) {
          const referent = projectRelative(target, resolve(dirname(join(target, path)), value));
          if (contained(referent)) logical = join(input.projectDir, referent);
        }
        if (logical !== value) git(target, ['update-index', '--cacheinfo', '120000', git(target, ['hash-object', '-w', '--stdin'], logical).trim(), path], undefined, index);
      }
      return git(target, ['write-tree'], undefined, index).trim();
    };
    // Ignored project artifacts travel as patch bytes, never as committed or
    // staged branch content. Only this disposable index bypasses ignore rules.
    const stageTree = (target: string) => {
      git(target, ['add', '-A']);
      const index = join(scratch, 'stage.index'); rmSync(index, { force: true });
      git(target, ['read-tree', git(target, ['write-tree']).trim()], undefined, index);
      const ignored = git(target, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], undefined, index)
        .split('\0').filter(path => path && stageScopeOwnsPath(input.stage, path));
      if (ignored.length) git(target, ['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], ignored.join('\0') + '\0', index);
      return projectTree(target, git(target, ['write-tree'], undefined, index).trim());
    };
    const changeTrees = (target: string) => [baselines.get(target)!, stageTree(target)];
    const diff = (target: string) => git(target, ['diff', '--binary', ...changeTrees(target)]);
    const run = async (target: string, existingRunId: string) => {
      const workflow = workflows.get(target)!;
      const state = await withRunProcessOwnership(target, existingRunId, () => runWorkflow(workflow, stringify(workflow), target, input.adapter, new Map(),
        input.skills, input.agentsDir, existingRunId, candidateBrief, false, undefined, false,
        undefined, input.attemptDeadlineClockFactory), opts.abortSignal, () => progress('Verified candidate live, artifact or process progress.'));
      states.set(target, state);
      if (state.status === RUN_STATUS.COMPLETE || state.status === RUN_STATUS.PARKED) {
        // A completed candidate must have a readable change for integration.
        // Reject a broken candidate through the existing unsuccessful-run path.
        try { diff(target); } catch (error) {
          const failed = updateRunState(target, existingRunId, current => {
            current.status = RUN_STATUS.STOPPED;
            current.failureReason = `Candidate change unreadable: ${error instanceof Error ? error.message : String(error)}`;
            current.completedAt = new Date().toISOString();
          });
          states.set(target, failed);
          return { code: 1, output: failed.failureReason! };
        }
        return { code: 0, output: state.status };
      }
      return { code: 1, output: state.status };
    };
    try {
      // Freeze predecessor inputs once; a fallback must not inherit A's writes
      // or concurrent parent edits. Create each candidate only when attempted.
      const snapshot = join(scratch, 'input');
      copyProject(input.projectDir, snapshot);
      const code = await runRace({ targets, recordPath }, {
        run: async (target, _label, instruction) => {
          if (opts.abortSignal?.aborted) throw new Error('Race cancelled before authoring');
          copyProject(snapshot, target);
          git(target, ['init', '-q']);
          git(target, ['add', '-A']);
          git(target, ['-c', 'user.name=FlowCrew', '-c', 'user.email=flowcrew@example.invalid', 'commit', '-qm', 'Stage input', '--allow-empty']);
          // Authors may commit their work; integration uses the frozen input.
          baselines.set(target, stageTree(target));
          const reservation = reserveRun(target);
          // Own-stage output is retry evidence, never an inherited execution ledger.
          const carriers = ['gate_contract.json', `stages/${input.stage.id}/output.md`,
            ...externalIds.flatMap(id => [`stages/${id}/status.json`, `stages/${id}/output.md`, `verdict_${id}.json`])];
          for (const path of carriers) {
            const source = join(input.runDirPath, path);
            if (!existsSync(source)) continue;
            const destination = join(reservation.runDirPath, path);
            mkdirSync(dirname(destination), { recursive: true }); cpSync(source, destination);
          }
          if (canonicalGuidance.length) writeFileSync(join(reservation.runDirPath, 'supervisor_guidance.md'),
            canonicalGuidance.map(renderGuidanceEnvelope).join('\n\n'));
          const stages = candidateStages.map(stage => {
            const guidance = parentGuidance(stage);
            const context = buildDependencyContext({ dependsOn: stage.depends_on.filter(id => !candidateIds.has(id)),
              handoffVisibility: role.handoff_visibility, projectDir: target, runId: reservation.runId, runDir: reservation.runDirPath });
            return { ...stage, race: false,
            criterion_refs: stage.criterion_refs.filter(ref => candidateRefs.includes(ref)),
            depends_on: stage.depends_on.filter(id => candidateIds.has(id)),
            condition: stage.id === input.stage.id ? undefined : stage.condition,
            artifact_contract: stage.artifact_contract && { ...stage.artifact_contract,
              produces: stage.artifact_contract.produces.flatMap(freezeArtifact),
              reads: stage.artifact_contract.reads.flatMap(freezeArtifact).map(read => read.source.kind === 'stage' && !candidateIds.has(read.source.stage)
                ? { ...read, source: { kind: 'input' as const } } : read),
            },
            prompt_template: (stage.id === input.stage.id ? `${retryPreamble}\n\n${instruction}${context}\n\n${candidatePrompt}\n\n${guidance}`
              : `${stage.prompt_template?.trim() || childBody}${context}\n\n${guidance}`)
              ?.replaceAll(input.projectDir, target).replaceAll(input.runDirPath, reservation.runDirPath),
            };
          });
          workflows.set(target, WorkflowConfigSchema.parse({ name: 'race_candidate', defaults: { ...input.defaults, max_iterations: 1 }, stages }));
          // Framework carriers belong to the child identity and are published by its scheduler.
          for (const artifact of candidateStages.flatMap(stage => stage.artifact_contract?.reads ?? []).filter(read => read.root === 'run' && !['run.json', 'task_brief.md'].includes(read.path))) {
            const source = join(input.runDirPath, artifact.path);
            if (!existsSync(source)) continue;
            const destination = join(reservation.runDirPath, artifact.path);
            mkdirSync(dirname(destination), { recursive: true });
            copyProject(source, destination);
          }
          return run(target, reservation.runId);
        },
        readRun: target => {
          const state = states.get(target); if (!state) return undefined;
          const stages = workflows.get(target)!.stages;
          const facts = collectGateRuntimeFacts(stages, state, target, state.runId);
          gateFacts.set(target, facts);
          return { runId: state.runId, status: state.status,
            gatePassed: facts.allPass,
            repairs: stages.filter(stage => stage.retry_to?.length).reduce((count, stage) => count + (state.stages[stage.id]?.attempts?.length ?? 0), 0),
            failureReason: state.failureReason };
        },
        write: (path, text) => writeFileSync(path, text), out: progress,
      });
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      // Retain attempted patches after removing private copies.
      for (const candidate of record.candidates) {
        const { target, label } = candidate;
        try {
          writeFileSync(join(dirname(recordPath), `candidate_${opts.attemptIndex ?? 1}_${label.toLowerCase()}.patch`), diff(target));
        } catch (error) {
          const patchError = error instanceof Error ? error.message : String(error);
          candidate.patchError = patchError;
          progress(`Race: could not retain candidate ${label} patch: ${patchError}`);
        }
      }
      writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      if (code !== 0 || !record.chosenTarget || opts.abortSignal?.aborted) return { output: record.decision.reason, exitCode: 1, duration_ms: 0, ...usage() };
      const winner = record.chosenTarget as string, winnerState = states.get(winner)!;
      const paths = git(winner, ['diff', '--name-only', '-z', ...changeTrees(winner)]).split('\0').filter(Boolean);
      if (paths.some(path => !stageScopeOwnsPath(input.stage, path))) throw new Error('Race winner exceeded the admitted author scope');
      const patch = diff(winner);
      if (patch) {
        git(input.projectDir, ['apply', '--check', '--binary', '-'], patch);
        git(input.projectDir, ['apply', '--binary', '-'], patch);
      }
      const acceptedGates = Object.fromEntries(gateFacts.get(winner)!.evaluations.map(gate =>
        [gate.id, { runId: winnerState.runId, verdict: gate.effectiveVerdict! }]));
      // Promote the accepted gates' products for ordinary dependency readers;
      // their acceptance belongs to the child, not a fabricated parent attempt.
      const products = candidateStages.flatMap(stage => [
        ...(stage.artifact_contract?.produces ?? []),
        ...['output.md', 'metric.json'].map(name => ({ root: 'run', path: `stages/${stage.id}/${name}` })),
      ]);
      for (const artifact of products) {
        if (artifact.root !== 'run') continue;
        const source = join(runDir(winner, winnerState.runId), artifact.path);
        if (!existsSync(source)) continue;
        const destination = join(opts.runDir, artifact.path);
        mkdirSync(dirname(destination), { recursive: true });
        copyProject(source, destination);
      }
      return { output: readStageOutput(winner, winnerState.runId, input.stage.id), exitCode: 0, duration_ms: 0,
        acceptedGates, writes: paths, writeAttribution: 'structured', ...usage() };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), exitCode: 1, duration_ms: 0, ...usage() };
    } finally {
      // A parked candidate is historical evidence, not a resumable operator choice.
      for (const [target, state] of states) if (state.status === RUN_STATUS.PARKED) updateRunState(target, state.runId, current => {
        current.status = RUN_STATUS.STOPPED; current.failureReason = 'Stage race retired this candidate';
        current.completedAt = new Date().toISOString();
      });
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  return { async run(...args) {
    const started = performance.now();
    const result = await execute(...args);
    // Include authoring, verification, integration and private-copy retirement.
    return { ...result, duration_ms: Math.round(performance.now() - started) };
  } };
}
