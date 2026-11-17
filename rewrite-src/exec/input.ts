import { putEvidence } from '../records/state.js';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AnswerSchema } from '../contract/answers.js';
import { parseBrief, idSchema, type Ref, type Result } from '../contract/brief.js';
import type { AttemptRequest } from '../contract/runtime.js';
import { readCheckpoint, type ContentScope } from '../records/content.js';
import { readProjection } from '../records/state.js';
import { readEvidence, evidenceReader } from '../records/evidence.js';

/** Exact recorded prompt/schema pair and measured input size. */
export interface ComposedInput {
  readonly input: Ref;
  readonly schema: AnswerSchema;
  readonly chars: number;
}

/** Compose and preserve complete inputs; provider context limits are native outcomes. */
export async function composeInput(request: AttemptRequest, schema: AnswerSchema, scope: ContentScope,
  configRoot: string): Promise<Result<ComposedInput>> {
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
  const evidence: Ref[] = [];
  try {
    const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    for (const ref of request.evidence) {
      const bytes = await readEvidence(scope.journal, ref);
      if (!bytes.ok) return bytes;
      // Evidence can be binary. Only its authenticated locator is prompt input.
      evidence.push(ref);
    }
    const checkpoints = [];
    for (const id of context.checkpointIds) {
      const checkpoint = await readCheckpoint(scope.journal, id);
      if (!checkpoint.ok) return checkpoint;
      if (checkpoint.value.state !== 'safe' || checkpoint.value.brief !== request.brief.digest
        || checkpoint.value.address.run !== address.run)
        return { ok: false, kind: 'conflict', detail: 'Unavailable safe checkpoint' };
      const manifest = await readEvidence(scope.journal, checkpoint.value.manifest);
      if (!manifest.ok) return manifest;
      checkpoints.push(checkpoint.value);
    }
    if (stage.baseCheckpoint && !checkpoints.some(value => value.id === stage.baseCheckpoint))
      return { ok: false, kind: 'conflict', detail: 'Stage base is outside the schema context' };
    const config = realpathSync(configRoot);
    const runtime = realpathSync(resolve(config, '..'));
    const readPinned = async (root: string, path: string) => {
      const physical = realpathSync(path);
      const rel = relative(root, physical);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Pinned input escapes its root');
      return decode(readFileSync(physical));
    };
    const purpose = await readPinned(config, resolve(config, 'roles', `${stage.purpose}.md`));
    const skills = [];
    for (const id of stage.skills) {
      if (!idSchema.safeParse(id).success) return { ok: false, kind: 'invalid', detail: 'Invalid skill identity' };
      skills.push({ id, text: await readPinned(runtime, resolve(runtime, 'skills', id, 'SKILL.md')) });
    }
    const guides = [];
    for (const guide of guidance ?? []) {
      const bytes = await readEvidence(scope.journal, guide.intervention.content);
      if (!bytes.ok) return bytes;
      guides.push({ ...guide, text: decode(bytes.value) });
    }
    // Supply the admitted grammar and opaque body; original bytes remain evidence.
    const workspace = resolve(scope.layout.location.storeRoot, 'work', address.run, 'stages', address.stage, address.attempt,
      String(address.invocation));
    const projection = await readProjection(scope.journal);
    if (!projection.ok) return projection;
    const text = JSON.stringify({
      purpose, role: request.role, project: scope.layout.project, evidenceRoot: scope.journal.root,
        evidenceReader: await evidenceReader(scope.journal), workspace, brief: declaration.value,
      address, stage, revision: request.plan.revision, invocation: request.invocation, context,
        schema: schema.json,
      commands: projection.value.commands, lineage: projection.value.lineage, skills, evidence, checkpoints, guidance: guides
    });
    const chars = text.length;
    const input = await putEvidence(scope.journal, new TextEncoder().encode(text));
    if (!input.ok) return input;
    return { ok: true, value: { input: input.value, schema, chars } };
  } catch (error) {
    return { ok: false, kind: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
}
