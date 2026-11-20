// Fake programs implement native envelopes; no provider or network is required.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const backend = process.argv[2], lines = createInterface({ input: process.stdin });
let resultEmitted = false;
const emit = event => {
  if (event.type === 'result') resultEmitted = true;
  const bytes = Buffer.from(JSON.stringify(event) + (event.type === 'result' && process.env.FINAL_WITHOUT_NEWLINE ? '' : '\n'));
  // Exercise a UTF-8 split as well as JSON-line boundaries on the real host stream.
  process.stdout.write(bytes.subarray(0, 11)); process.stdout.write(bytes.subarray(11));
};
let first = true, steered = false;
lines.on('line', text => {
  if (backend !== 'claude') return;
  const message = JSON.parse(text);
  // Like `--replay-user-messages`: the message is echoed once the provider takes it.
  emit({ type: 'user', message: message.message, parent_tool_use_id: null, isReplay: true });
  if (!first) { steered = message.message.content === 'Use steered answer'; return; }
  first = false;
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'synthetic secret' } }] } });
  setTimeout(() => {
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'synthetic secret' }] } });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: '你好 synthetic secret' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, structured_output: { answer: steered ? 'steered' : 'initial' } });
    if (process.env.FINAL_WITHOUT_NEWLINE) finish();
  }, 200);
});
lines.on('close', () => {
  if (backend === 'claude' && !resultEmitted) {
    writeFileSync(process.env.EXIT_MARKER, 'input-ended-before-result'); process.exit(2);
  }
  if (backend === 'codex') {
    emit({ type: 'item.started', item: { type: 'command_execution', id: 'tool', command: 'synthetic secret' } });
    setTimeout(() => {
      emit({ type: 'item.completed', item: { type: 'command_execution', id: 'tool', exit_code: 0 } });
      emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'initial' }) } });
      emit({ type: 'turn.completed' });
      setTimeout(finish, 200);
    }, 200);
  } else setTimeout(finish, 200);
});
function finish() { writeFileSync(process.env.EXIT_MARKER, 'exited'); process.exit(0); }
