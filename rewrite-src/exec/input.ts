import { putEvidence } from '../records/state.js';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AnswerSchema } from '../contract/answers.js';
import { parseBrief, idSchema, type Hash, type Ref, type Result } from '../contract/brief.js';
import { commandEvidenceLabel, currentCommandReceipts, gateReview, type CommandReceipt, type CommandReuse, type AttemptRequest } from '../contract/runtime.js';
import { changeSince, type ContentScope } from '../records/content.js';
import { readProjection } from '../records/state.js';
import { readEvidence, decodeRefusal } from '../records/evidence.js';

/** What one invocation receives: the role text as the system/developer instruction and everything else as one Markdown user message. */
export interface ComposedInput {
  readonly reusedCommands: readonly CommandReuse[];
  /** The user message, retained as evidence. */
  readonly input: Ref;
  /** The role text: judgment duties, supplied through the provider's own instruction channel. */
  readonly instruction: string;
  /** A gate's engine record of what it was supplied: the command receipts it was shown and the command history at that moment.
   * Settlement binds an accepted verdict to it. It is evidence, not model input. */
  readonly review?: Ref;
  /** The invocation's exclusive scratch directory; also holds the files the message points to. */
  readonly workspace: string;
  readonly schema: AnswerSchema;
  /** Characters the model receives, instruction plus message; the native schema is not counted. */
  readonly chars: number;
}

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
/** A code fence longer than any backtick run inside `text`, so the text cannot close it. */
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return `${fence}\n${text.trimEnd()}\n${fence}`;
}
const word = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
const list = <T>(values: readonly T[], line: (value: T) => string) => values.map(value => `- ${line(value)}`).join('\n');

/** The instruction an invocation receives: the shipped role text, then the role's own prompt, each trimmed and an empty one left out. */
export const roleInstruction = (shipped: string, prompt: string): string => [shipped, prompt].map(text => text.trim()).filter(Boolean).join('\n\n');

/** Compose the invocation's input. Machine records (hashes, refs, ids, receipts) stay in the records; the model gets prose, paths and files. */
export async function composeInput(request: AttemptRequest, schema: AnswerSchema, scope: ContentScope,
  configRoot: string, tree: Hash): Promise<Result<ComposedInput>> {
  const { address, stage, context, guidance } = request;
  if (![address.run, address.stage, address.attempt].every(id => idSchema.safeParse(id).success)
    || !Number.isSafeInteger(address.invocation) || address.invocation <= 0)
    return { ok: false, kind: 'invalid', detail: 'Invalid invocation identity' };
  if (address.run !== scope.layout.location.run || address.stage !== stage.id
    || stage.role !== request.role.id || context.purpose !== stage.purpose
    || context.revision !== request.plan.revision || request.brief.digest !== scope.brief.digest
    || !isDeepStrictEqual(request.brief, scope.brief)
    || !request.plan.plan.stages.some(value => isDeepStrictEqual(value, stage)))
    return { ok: false, kind: 'conflict', detail: 'Input address/context mismatch' };
  if (guidance?.length && stage.purpose === 'gate')
    return { ok: false, kind: 'conflict', detail: 'Independent gate cannot receive guidance' };
  const brief = await readEvidence(scope.journal, request.brief.bytes);
  if (!brief.ok) return brief;
  const declaration = parseBrief(brief.value);
  if (!declaration.ok) return declaration;
  // Exclusive invocation workspace: a paid call cannot be entered twice.
  const workspace = resolve(scope.layout.location.storeRoot, 'work', address.run, 'stages', address.stage, address.attempt,
    String(address.invocation));
  try { await mkdir(dirname(workspace), { recursive: true }); await mkdir(workspace); }
  catch (error) { return { ok: false, kind: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'conflict' : 'unavailable', detail: String(error) }; }
  try {
    const config = realpathSync(configRoot);
    const readPinned = (root: string, path: string) => {
      const physical = realpathSync(path);
      const rel = relative(root, physical);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Pinned input escapes its root');
      return decode(readFileSync(physical));
    };
    const read = async (ref: Ref) => {
      const bytes = await readEvidence(scope.journal, ref);
      if (!bytes.ok) throw new Error(bytes.detail);
      return decode(bytes.value);
    };
    const instruction = roleInstruction(readPinned(config, resolve(config, 'roles', `${stage.purpose}.md`)), request.role.prompt);
    const guides: string[] = [];
    for (const guide of guidance ?? []) guides.push(await read(guide.intervention.content));
    const projection = await readProjection(scope.journal);
    if (!projection.ok) return projection;
    const state = projection.value;
    const declared = declaration.value;
    const sections: string[] = [];
    const add = (heading: string, body: string) => sections.push(`## ${heading}\n\n${body}`);

    // The task, as written.
    const body = declared.body;
    sections.push((declared.title ? `# ${declared.title}\n\n` : '') + body + (body.endsWith('\n') ? '' : '\n'));
    add('Criteria', list(declared.criteria, item => `${item.id}: ${item.text}`));
    if (declared.results.length) add('Results', list(declared.results, item => `${item.id}: ${item.text}`));
    if (declared.inputs.length) add('Declared inputs', list(declared.inputs, item => `${item.path} (${item.kind}${item.frozen ? ', frozen' : ''})`));
    if (declared.outputs.length) add('Declared outputs', list(declared.outputs, item => `${item.path} (${item.kind}, ${item.existing})`));
    if (declared.commands.length) add('Declared commands', list(declared.commands, item => `${item.id}${item.required ? ' (required)' : ''}: `
      + [...Object.entries(item.env).map(([key, value]) => `${key}=${word(value)}`), ...item.argv.map(word)].join(' ')));
    if ('instruction' in stage) add('This stage', stage.instruction);

    // Where the model works, and how the task's paths map onto it.
    add('Working copy', `You work in \`${scope.layout.project}\`, a copy of the read-only source \`${state.launch.setup.project}\`; a path under the source`
      + ` in the task means the same relative path under the copy. Write scratch files only in \`${workspace}\`.`);

    if (stage.purpose === 'plan' && request.plan.plan.stages.some(item => item.id !== stage.id)) {
      const settled = new Set(context.settledStageIds ?? []);
      add('Current plan', list(request.plan.plan.stages, item => `${item.id}: ${item.purpose} by ${item.role}`
        + (item.after.length ? `, after ${item.after.join(', ')}` : '') + (settled.has(item.id) ? ', settled' : '')
        + (item.purpose === 'gate' && item.repair ? `, a repairable rejection runs ${item.repair.stage}` : '')));
      add('Roles', list(state.launch.roles, role => `${role.id}: ${role.description}`));
    }

    // Command results, as files the model can open.
    const { commands, reusedCommands } = request.commandReview ?? {
      commands: currentCommandReceipts(state.commands, stage, request.brief), reusedCommands: [] as CommandReuse[] };
    if (commands.length) {
      const lines: string[] = [];
      await mkdir(resolve(workspace, 'commands'));
      for (const receipt of new Map(commands.map(item => [item.command, item])).values()) {
        const path = resolve(workspace, 'commands', `${receipt.command}.log`);
        await writeFile(path, `exit: ${exitText(receipt)}\n--- stdout ---\n${await read(receipt.stdout)}\n--- stderr ---\n${await read(receipt.stderr)}\n`,
          { flag: 'wx' });
        const reuse = reusedCommands.find(item => item.receipt.command === receipt.command);
        const earlier = reuse && commandEvidenceLabel(reuse, address).reused ? ` (result of an earlier stage, ${reuse.source.stage})` : '';
        lines.push(`${receipt.command}: ${exitText(receipt)}, log ${path}${earlier}`);
      }
      add('Command results', list(lines, line => line));
    }

    // A gate is also shown the change since the base setup recorded, and what it was shown is recorded in the form settlement compares with
    // the evidence as it stands then.
    let review: Ref | undefined;
    if (stage.purpose === 'gate') {
      const base = state.launch.setup.tree;
      if (!base) return { ok: false, kind: 'conflict',
        detail: 'This run recorded no base tree at setup, so a gate here cannot show its change. Resume the run with the runtime copy it was started with.' };
      const recorded = await putEvidence(scope.journal, new TextEncoder().encode(JSON.stringify(gateReview(state, commands, reusedCommands))));
      if (!recorded.ok) return recorded;
      review = recorded.value;
      const patch = resolve(workspace, 'change.patch'), baseDirectory = resolve(workspace, 'base');
      const change = await changeSince(scope.journal, base, tree, patch, baseDirectory);
      if (!change.ok) return change;
      add('Change under review', `The base is the project as it was before any stage ran. Everything that differs from it is in \`${change.value.patch}\`:\n\n`
        + fenced(change.value.stat || 'No change.')
        + (change.value.unpatched ? `\n\nThe end of that file also lists ${change.value.unpatched} differences a patch cannot carry (modes, empty directories, special files).` : '')
        + `\n\nTo get a copy of the base in \`${baseDirectory}\`, run:\n\n${fenced(change.value.baseCommand)}`
        + '\n\nThe copy has file bytes, executable bits and symlinks only: other modes, empty directories and special files are missing, and a path component'
        + ' named `.git` or starting `.fcrw-` appears as `.fcrw-` followed by the hex of its name.'
        + (change.value.otherRoots.length ? `\n\nDeclared outputs outside the working copy also changed: ${change.value.otherRoots.join(', ')} (not in the patch).` : ''));
    }

    // What the previous gate found, for whoever repairs it.
    const rejection = [...state.transitions].reverse().find(item => item.outcome === 'rejected_repairable' && item.next === stage.id);
    const verdict = rejection && state.attempts.find(item => item.address.stage === rejection.stage && item.address.attempt === rejection.attempt)?.answer;
    if (verdict?.kind === 'gate') {
      const { answer } = verdict, failing = Object.entries(answer.criteria).filter(([, value]) => value.status === 'fail');
      add('Findings to address', `The independent review rejected the work: ${answer.reason}`
        + (answer.findings.length ? `\n\n${list(answer.findings, item => `${item.class}${item.paths.length ? ` in ${item.paths.join(', ')}` : ''}: ${item.reason}`
          + (item.criterionIds.length ? ` (criteria: ${item.criterionIds.join(', ')})` : ''))}` : '')
        + (failing.length ? `\n\nFailing criteria:\n\n${list(failing, ([id, value]) => `${id}: ${value.evidence}`)}` : ''));
    }

    // A refused or interrupted earlier answer from this same stage.
    const prior = state.attempts.filter(item => item.address.stage === stage.id).at(-1);
    if (prior && prior.ending !== 'delivered') {
      const refusals: string[] = [];
      for (const ref of prior.evidence.filter(ref => request.evidence.some(item => isDeepStrictEqual(item, ref)))) {
        const bytes = await readEvidence(scope.journal, ref);
        if (!bytes.ok) return bytes;
        const refusal = decodeRefusal(bytes.value);
        if (refusal) refusals.push(refusal.detail);
      }
      add('Your previous answer was not accepted',
        `Your previous attempt on this stage ended as ${prior.ending}.`
        + (refusals.length ? ` The refusal:\n\n${refusals.map(fenced).join('\n\n')}` : '')
        + (prior.answerRef ? `\n\nThat answer:\n\n${fenced(await read(prior.answerRef))}` : '')
        + '\n\nReturn a corrected answer.');
    }

    if (guides.length) add('Operator guidance', guides.join('\n\n'));
    const text = sections.join('\n\n');
    const input = await putEvidence(scope.journal, new TextEncoder().encode(text));
    if (!input.ok) return input;
    return { ok: true, value: { input: input.value, instruction, workspace, schema, chars: instruction.length + text.length, reusedCommands,
      ...(review ? { review } : {}) } };
  } catch (error) {
    return { ok: false, kind: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
}

const exitText = (receipt: CommandReceipt) => receipt.execution.state === 'complete' ? `exit ${receipt.execution.exit}`
  : `${receipt.execution.state} (${receipt.execution.reason})`;
