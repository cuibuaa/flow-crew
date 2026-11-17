import { putEvidence } from '../records/state.js';
import type { Adapter, BackendReply, BackendRequest, Ending } from '../contract/runtime.js';
import type { Ref, Result } from '../contract/brief.js';
import { readEvidence } from '../records/evidence.js';
import { invokeBackend, type TransportContext } from './transport.js';
import { readUsage } from './usage.js';

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
// The saved native corpus establishes success envelopes only. No error-code vocabulary is verified.
// Preserve unknown structured errors and park; protocol diagnostics never supply a retry classification.

/** Translate one fresh Claude print stream; only structured_output is an answer. */
export function createClaudeAdapter(context: TransportContext): Adapter {
  return {
    async invoke(request: BackendRequest): Promise<Result<BackendReply>> {
      if (request.role.backend !== 'claude') return { ok: false, kind: 'conflict', detail: 'Wrong adapter backend' };
      const schema = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify(request.schema)));
      if (!schema.ok) return schema;
      const wire = Object.fromEntries(Object.entries(request.schema).filter(([key]) => key !== '$schema'));
      const generation = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify(wire)));
      if (!generation.ok) return generation;
      const settings = request.preferences;
      const native = await invokeBackend(request, {
        argv: ['claude', '--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
          '--setting-sources', '', '--strict-mcp-config', '--permission-mode', 'bypassPermissions',
          ...(settings.model ? ['--model', settings.model] : []),
          ...(settings.effort ? ['--effort', settings.effort] : []), '--json-schema', JSON.stringify(wire)],
        cwd: request.project, env: context.privateEnvironment, stdin: request.input,
        writableRoots: request.writableRoots, durationMs: request.durationMs,
      }, context);
      if (!native.ok) return native;
      const process = native.value.process;
      const bytes = await readEvidence(context.journal, process.stdout);
      if (!bytes.ok) return bytes;
      const commands: Ref[] = [];
      let answer: unknown;
      let terminal: { ending: Ending; resetAt?: string } = { ending: 'provider_unknown' };
      let malformed = false;
      try {
        for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes.value).split('\n')) {
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try { event = object(JSON.parse(line)); } catch { malformed = true; continue; }
          if (event.parent_tool_use_id) continue;
          const message = object(event.message);
          const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
          if (event.type === 'assistant' && blocks.some(block => block.type === 'tool_use' && block.name === 'Bash')
            || event.type === 'user' && blocks.some(block => block.type === 'tool_result')) {
            const ref = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify(event)));
            if (!ref.ok) return ref;
            commands.push(ref.value);
          }
          if (event.type === 'result') {
            if (event.subtype === 'success' && event.is_error === false) {
              terminal = { ending: 'delivered' }; answer = event.structured_output;
            } else { terminal = { ending: 'provider_unknown' }; answer = undefined; }
          }
          if (event.type === 'error') { terminal = { ending: 'provider_unknown' }; answer = undefined; }
        }
      } catch { malformed = true; }
      let answerBytes: Ref | undefined;
      if (answer !== undefined) {
        const saved = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify(answer)));
        if (!saved.ok) return saved;
        answerBytes = saved.value;
      }
      let ending = terminal.ending;
      if (ending === 'delivered' && (answer === undefined || malformed)) ending = 'invalid_answer';
      if (process.exit !== 0 && ending === 'delivered') ending = 'provider_unknown';
      if (process.grant !== 'applied') ending = 'isolation_failure';
      else if (process.state === 'closure_unknown') ending = 'closure_unknown';
      else if (request.abort.aborted) ending = 'cancelled';
      else if (request.durationMs !== undefined && process.signal !== null && process.durationMs >= request.durationMs) ending = 'duration';
      const usage = await readUsage(context.journal, 'claude', [process.stdout]);
      const raw = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify({
        attempt: request.attempt, role: request.role, input: request.input, schema: schema.value, generationSchema: generation.value,
        settings: settings, process, raw: native.value.raw, nativeCommands: commands, answerBytes,
      })));
      if (!raw.ok) return raw;
      return {
        ok: true, value: {
          raw: raw.value, exit: process.exit, signal: process.signal, ending, answerBytes,
          closure: process.state === 'closed' ? 'dead' : process.state === 'not_started' ? 'dead' : 'unknown',
          usage, nativeCommands: commands, ...terminal.resetAt !== undefined ? { resetAt: terminal.resetAt } : {}
        }
      };
    }
  };
}
