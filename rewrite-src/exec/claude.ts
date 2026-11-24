import { putEvidence } from '../records/state.js';
import type { Adapter, BackendReply, BackendRequest, Ending } from '../contract/runtime.js';
import type { SteerOutcome } from '../contract/live.js';
import type { Ref, Result } from '../contract/brief.js';
import { invokeBackend, observeActivity, type TransportContext } from './transport.js';
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
      const commandEvents: string[] = [], tools = new Map<string, string>();
      let answer: unknown, ended = false;
      let activeSession: Parameters<NonNullable<import('../host/process.js').InvocationIO['onReady']>>[0] | undefined;
      let terminal: { ending: Ending } = { ending: 'provider_unknown' };
      // Turn accounting, owned here. Claude acknowledges each stdin user message by re-emitting it (`--replay-user-messages`) when
      // it takes the message into a turn. At most ONE guide message is outstanding (written, not yet echoed): steered guides wait
      // in `buffer`, the whole buffer is written as one message when nothing is outstanding, and that message's echo delivers
      // every guide in it. Delivery therefore never depends on how Claude would merge or split several queued messages.
      // A guide is delivered at its echo, not at the write; Claude runs another turn for a written, unechoed message.
      type Guide = { text: string; settle: (outcome: SteerOutcome) => void };
      const buffer: Guide[] = [];
      let outstanding: { text: string; guides: Guide[] } | undefined;
      const settleAll = (outcome: SteerOutcome) => {
        for (const guide of [...outstanding?.guides ?? [], ...buffer.splice(0)]) guide.settle(outcome);
        outstanding = undefined;
      };
      const flush = async () => {
        if (outstanding || !buffer.length) return;
        const guides = buffer.splice(0), message = { text: guides.map(guide => guide.text).join('\n\n'), guides };
        outstanding = message;
        if (!await activeSession!.write(userMessage(message.text))) settleAll('ended');
      };
      const userMessage = (text: string) => new TextEncoder().encode(JSON.stringify({ type: 'user',
        message: { role: 'user', content: text } }) + '\n');
      const native = await invokeBackend(request, {
        argv: ['claude', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
          '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--append-system-prompt', request.instruction,
          '--permission-mode', 'bypassPermissions',
          ...(settings.model ? ['--model', settings.model] : []),
          ...(settings.effort ? ['--effort', settings.effort] : []), '--json-schema', JSON.stringify(wire)],
        cwd: request.project, env: context.privateEnvironment, stdin: request.input,
        durationMs: request.durationMs,
      }, context, {
        input: bytes => userMessage(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        onReady: session => {
          activeSession = session;
          if (ended) { session.end(); return; }
          request.live?.onLive?.({ async steer(text) {
            if (ended || request.abort.aborted) return 'ended';
            const settled = new Promise<SteerOutcome>(settle => buffer.push({ text, settle }));
            await flush();
            return await settled;
          } });
        },
        event: event => {
          const root = !event.parent_tool_use_id;
          const message = object(event.message);
          const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
          if (root && (event.type === 'assistant' && blocks.some(block => block.type === 'tool_use' && block.name === 'Bash')
            || event.type === 'user' && blocks.some(block => block.type === 'tool_result'))) commandEvents.push(JSON.stringify(event));
          for (const block of blocks) {
            if (event.type === 'assistant' && block.type === 'tool_use') {
              const tool = typeof block.name === 'string' ? block.name : 'tool';
              if (typeof block.id === 'string') tools.set(block.id, tool);
              observeActivity(request.live, 'tool-start', tool);
            }
            if (event.type === 'user' && block.type === 'tool_result') {
              const id = String(block.tool_use_id); observeActivity(request.live, 'tool-end', tools.get(id)); tools.delete(id);
            }
            if (event.type === 'assistant' && block.type === 'text') observeActivity(request.live, 'message');
          }
          if (event.type === 'user' && root && event.isReplay === true && typeof message.content === 'string') {
            if (outstanding?.text === message.content) {
              for (const guide of outstanding.guides) guide.settle('delivered');
              outstanding = undefined; void flush();
            }
          }
          if (event.type === 'result' && root) {
            if (event.subtype === 'success' && event.is_error === false) {
              terminal = { ending: 'delivered' }; answer = event.structured_output;
            } else { terminal = { ending: 'provider_unknown' }; answer = undefined; }
            // A result is terminal only when no guide message is outstanding (held guides imply one); otherwise the last result answers.
            if (!outstanding) { ended = true; activeSession?.end(); }
            observeActivity(request.live, 'turn-end');
          }
          if (event.type === 'error' && root) { terminal = { ending: 'provider_unknown' }; answer = undefined; }
        }
      }).finally(() => { ended = true; settleAll('ended'); });
      if (!native.ok) return native;
      const process = native.value.process;
      const commands: Ref[] = [];
      for (const event of commandEvents) {
        const saved = await putEvidence(context.journal, new TextEncoder().encode(event));
        if (!saved.ok) return saved; commands.push(saved.value);
      }
      let answerBytes: Ref | undefined;
      if (answer !== undefined) {
        const saved = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify(answer)));
        if (!saved.ok) return saved;
        answerBytes = saved.value;
      }
      let ending = terminal.ending;
      if (ending === 'delivered' && (answer === undefined || native.value.malformed)) ending = 'invalid_answer';
      // The host closed the owner after the terminal result without awaiting an exit: no exit status exists to contradict it.
      if (process.exit !== 0 && !process.closedAtTerminal && ending === 'delivered') ending = 'provider_unknown';
      if (process.state === 'closure_unknown') ending = 'closure_unknown';
      else if (request.abort.aborted) ending = 'cancelled';
      const usage = await readUsage(context.journal, 'claude', [process.stdout]);
      const raw = await putEvidence(context.journal, new TextEncoder().encode(JSON.stringify({
        attempt: request.attempt, role: request.role, input: request.input, instruction: request.instruction, schema: schema.value, generationSchema: generation.value,
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
