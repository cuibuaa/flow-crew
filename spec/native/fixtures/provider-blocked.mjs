// Fake Claude whose Bash tool is blocked on a pipe that never ends: the provider emits its terminal result and then,
// like Claude Code waiting for its tool, never exits while that descendant lives. It speaks the shared provider protocol.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { providerProtocol } from './provider-protocol.mjs';
const tool = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
writeFileSync(process.env.TOOL_PID, String(tool.pid));
tool.on('exit', () => process.exit(0));
await providerProtocol('claude', async message => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { answer: JSON.parse(message).answer } }));
});
