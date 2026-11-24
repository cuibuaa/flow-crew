// Fake Claude for guide-consumption accounting, over the shared provider protocol (which echoes consumed user messages).
// The first turn runs one tool: tool_use, a pause (the test writes its guide), tool_result, then a pause before the result.
//   MODE=in-turn          takes queued guides at the tool boundary (turn.boundary()), so the guide is consumed in this turn;
//   MODE=after-boundary   does not: a guide written after the boundary stays queued and runs as its own turn, which takes
//                         SECOND_TURN_MS and answers with the guide's `answer`;
//   MODE=exit-at-result   as after-boundary, but the provider exits right after its first result, leaving the guide unconsumed.
// Messages are JSON `{answer}`; a turn answers with the last message's `answer`.
import { providerProtocol } from './provider-protocol.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = event => new Promise(resolve => process.stdout.write(JSON.stringify(event) + '\n', resolve));
let turns = 0;
await providerProtocol('claude', async (message, turn) => {
  let answer = JSON.parse(message).answer;
  if (turns++ === 0) {
    await emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'true' } }] } });
    await pause(400);
    await emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: '' }] } });
    if (process.env.MODE === 'in-turn') { await pause(400); for (const guide of turn.boundary()) answer = JSON.parse(guide).answer; }
    else await pause(600);
  } else await pause(Number(process.env.SECOND_TURN_MS));
  await emit({ type: 'result', subtype: 'success', is_error: false, structured_output: { answer } });
  if (process.env.MODE === 'exit-at-result') process.exit(0);
});
