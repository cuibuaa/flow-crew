// Shared by native public acceptance and the installed-package smoke provider.
// Claude accepts each user message before EOF and remains open for the next turn, and (like `--replay-user-messages`)
// echoes each message back on stdout when it takes it into a turn: `{type:'user', message, parent_tool_use_id:null, isReplay:true}`.
// A turn may call `turn.boundary()` (a tool boundary) to take the messages queued so far in-turn; whatever is still queued when
// the turn returns starts the next turn, as Claude does. Codex exec consumes one prompt through EOF.
//
// The real engine gives a provider three things: the role text through the provider's own
// instruction option, the answer schema through the provider's own schema option, and a Markdown user message.
// `nativePrompt` reads exactly those and exposes the few facts the fixtures need.
import { readFileSync } from 'node:fs';

/** @param {'claude'|'codex'} backend @param {string} text the user message */
export function nativePrompt(backend, text) {
  const argv = process.argv, after = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1];
  const schema = JSON.parse(backend === 'claude' ? after('--json-schema') : readFileSync(after('--output-schema'), 'utf8'));
  const instruction = backend === 'claude' ? after('--append-system-prompt')
    : JSON.parse(String(argv.find(item => item.startsWith('developer_instructions='))).slice('developer_instructions='.length));
  /** @param {string} heading */
  const section = heading => text.split(/\n\n(?=## )/).find(part => part.startsWith(`## ${heading}\n`))?.slice(heading.length + 5);
  const results = (section('Command results') ?? '').split('\n').filter(Boolean).flatMap(line => {
    const match = /^- (\S+): (.+?), log (\S+?)(?: \(result of an earlier stage, (\S+)\))?$/.exec(line);
    return match ? [{ command: match[1], execution: match[2], log: match[3], earlierStage: match[4] }] : [];
  });
  const guidance = section('Operator guidance');
  return { text, instruction, schema, kind: schema.properties.kind.const,
    revision: schema.properties.answer?.properties?.baseRevision?.const,
    project: process.cwd(), workspace: String(process.env.TMPDIR), stage: { purpose: schema.properties.kind.const },
    commands: results, section, guidance: guidance === undefined ? [] : [{ text: guidance }],
    correction: section('Your previous answer was not accepted') };
}

/** @param {'claude'|'codex'} backend @param {(message:string, turn:{boundary():string[]})=>Promise<void>} respond a turn gets the user message text */
export async function providerProtocol(backend, respond) {
  if (backend === 'codex') {
    await respond(readFileSync(0, 'utf8'), { boundary: () => [] });
    return;
  }
  const { createInterface } = await import('node:readline');
  /** @type {{role:string,content:string}[]} */
  const queue = [];
  let closed = false, wake = () => { };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => { const event = JSON.parse(line); if (event.type === 'user' && event.message?.role === 'user') queue.push(event.message); wake(); });
  lines.on('close', () => { closed = true; wake(); });
  /** @param {{role:string,content:string}} message */
  const take = message => {
    console.log(JSON.stringify({ type: 'user', message, parent_tool_use_id: null, isReplay: true }));
    return message.content;
  };
  for (;;) {
    while (!queue.length && !closed) await new Promise(resolve => { wake = () => resolve(undefined); });
    if (!queue.length) return;
    await respond(take(/** @type {any} */ (queue.shift())), { boundary: () => queue.splice(0).map(take) });
  }
}
