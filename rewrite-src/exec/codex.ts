import { putEvidence } from '../records/state.js';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Adapter, BackendReply, BackendRequest, Ending } from '../contract/runtime.js';
import type { LiveInvocation } from '../contract/live.js';
import type { Ref, Result } from '../contract/brief.js';
import { validateRecordRef } from '../records/evidence.js';
import { invokeBackend, observeActivity, type TransportContext } from './transport.js';
import { readUsage } from './usage.js';

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
// The saved native corpus establishes success envelopes only. No error-code vocabulary is verified.
// Preserve unknown structured errors and park; protocol diagnostics never supply a retry classification.

// Lossless wire encoding of this contract's JSON Schema into Codex strict syntax.
// Optional fields become explicit presence/absence object variants, never nullable defaults.
function generationSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(generationSchema);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => key !== '$schema').map(([key, v]) => [key, generationSchema(v)]));
  if (source.oneOf) {
    const branches = source.oneOf as Record<string, unknown>[];
    const tags = branches.map(branch => object(object(branch.properties).purpose).const);
    if (tags.some(tag => typeof tag !== 'string') || new Set(tags).size !== tags.length
      || branches.some(branch => !Array.isArray(branch.required) || !branch.required.includes('purpose')))
      throw new Error('Unsupported non-disjoint oneOf');
    result.anyOf = result.oneOf; delete result.oneOf;
  }
  if (source.type === 'array' && Object.keys(object(object(source.items).not)).length === 0 && object(source.items).not !== undefined) {
    result.items = { type: 'string' }; result.maxItems = 0;
  }
  if (source.type !== 'object') return result;
  const required = Array.isArray(source.required) ? source.required as string[] : [];
  const properties = object(source.properties);
  const possible = Object.keys(properties).filter(key => object(properties[key]).not === undefined);
  if (required.some(key => !possible.includes(key))) throw new Error('Impossible required property');
  const optional = possible.filter(key => !required.includes(key));
  const variants: unknown[] = [];
  for (let mask = 0; mask < 2 ** optional.length; mask++) {
    const keys = [...required, ...optional.filter((_, bit) => Math.floor(mask / 2 ** bit) % 2 === 1)];
    variants.push({ ...result, properties: Object.fromEntries(keys.map(key => [key, object(result.properties)[key]])), required: keys });
  }
  return variants.length === 1 ? variants[0] : { anyOf: variants };
}

/** Translate one Codex exec stream, preserving native codes and bound schema bytes. */
export function createCodexAdapter(context: TransportContext): Adapter & LiveInvocation {
  return {
    async steer() { return 'refused'; },
    async invoke(request: BackendRequest): Promise<Result<BackendReply>> {
      if (request.role.backend !== 'codex') return { ok: false, kind: 'conflict', detail: 'Wrong adapter backend' };
      let wire: unknown;
      try { wire = generationSchema(request.schema); }
      catch (error) { return { ok: false, kind: 'invalid', detail: String(error) }; }
      const generation = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify(wire)));
      if (!generation.ok) return generation;
      const schema = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify(request.schema)));
      if (!schema.ok) return schema;
      const carrier = await validateRecordRef(context.journal, generation.value);
      if (!carrier.ok) return carrier;
      const schemaPath = resolve(request.scratch, 'schema-' + randomUUID() + '.json');
      try { await writeFile(schemaPath, JSON.stringify(wire), { flag: 'wx', mode: 0o444 }); }
      catch (error) { return { ok: false, kind: 'unavailable', detail: String(error) }; }
      const settings = request.preferences;
      const commandEvents: string[] = [];
      let answer: string | undefined;
      let terminal: { ending: Ending } = { ending: 'provider_unknown' };
      const native = await invokeBackend(request, {
        argv: ['codex', '--no-daemon', 'exec', '--ignore-user-config', '--json', '--ephemeral', '--ignore-rules', '--skip-git-repo-check',
          '--sandbox', 'danger-full-access', '-c', `developer_instructions=${JSON.stringify(request.instruction)}`,
          ...(settings.model ? ['--model', settings.model] : []),
          ...(settings.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`] : []),
          '--output-schema', schemaPath, '--', '-'],
        cwd: request.project, env: context.privateEnvironment, stdin: request.input,
        durationMs: request.durationMs,
      }, context, { event: event => {
        const item = object(event.item);
        if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') answer = item.text;
        if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') answer = event.content;
        const tool = ['command_execution', 'mcp_tool_call', 'collab_tool_call', 'web_search', 'file_change'].includes(String(item.type));
        if ((event.type === 'item.started' || event.type === 'item.completed') && item.type === 'command_execution')
          commandEvents.push(JSON.stringify(event));
        if (tool && (event.type === 'item.started' || event.type === 'item.completed'))
          observeActivity(request.live, event.type === 'item.started' ? 'tool-start' : 'tool-end', String(item.type));
        if (event.type === 'item.completed' && item.type === 'agent_message' || event.type === 'message' && event.role === 'assistant')
          observeActivity(request.live, 'message');
        if (event.type === 'turn.completed') terminal = { ending: 'delivered' };
        if (event.type === 'turn.failed' || event.type === 'error') terminal = { ending: 'provider_unknown' };
        if (event.type === 'turn.completed' || event.type === 'turn.failed') observeActivity(request.live, 'turn-end');
      } });
      if (!native.ok) return native;
      const process = native.value.process;
      const commands: Ref[] = [];
      for (const event of commandEvents) {
        const saved = await putEvidence(context.journal, new TextEncoder().encode(event));
        if (!saved.ok) return saved; commands.push(saved.value);
      }
      let answerBytes: Ref | undefined;
      if (answer !== undefined) {
        const saved = await putEvidence(context.journal, new TextEncoder().encode(answer));
        if (!saved.ok) return saved;
        answerBytes = saved.value;
      }
      let ending = terminal.ending;
      if (ending === 'delivered' && (answer === undefined || native.value.malformed)) ending = 'invalid_answer';
      if (process.exit !== 0 && ending === 'delivered') ending = 'provider_unknown';
      if (process.state === 'closure_unknown') ending = 'closure_unknown';
      else if (request.abort.aborted) ending = 'cancelled';
      const usage = await readUsage(context.journal, 'codex', [process.stdout]);
      const raw = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify({
        attempt: request.attempt, role: request.role, input: request.input, instruction: request.instruction, schema: schema.value, generationSchema: carrier.value,
        settings: settings, process, raw: native.value.raw, nativeCommands: commands, answerBytes,
      })));
      if (!raw.ok) return raw;
      return {
        ok: true, value: {
          raw: raw.value, exit: process.exit, signal: process.signal, ending, answerBytes,
          closure: process.state === 'closed' ? 'dead' : process.state === 'not_started' ? 'dead' : 'unknown',
          usage, nativeCommands: commands
        }
      };
    }
  };
}
