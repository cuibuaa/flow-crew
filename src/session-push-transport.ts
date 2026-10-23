import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const FRONTEND_TIMEOUT_MS = 5_000;

/** Local app-server Unix sockets carry WebSocket JSON-RPC. Metadata requests
 * never resume a launcher or start a model turn. Bounds cover the handshake,
 * frame size and whole request, and the connection closes on every path. */
export async function codexRequest(
  socketPath: string, _codexHome: string | undefined, method: string, params: unknown,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const nonce = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`Codex ${method} timed out`)), FRONTEND_TIMEOUT_MS);
    const frame = (bytes: Buffer, opcode = 1) => {
      const mask = randomBytes(4);
      const header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
      header[0] = 0x80 | opcode;
      if (bytes.length < 126) header[1] = 0x80 | bytes.length;
      else { header[1] = 0x80 | 126; header.writeUInt16BE(bytes.length, 2); }
      socket.write(Buffer.concat([header, mask, Buffer.from(bytes.map((v, i) => v ^ mask[i % 4]))]));
    };
    const send = (message: unknown) => frame(Buffer.from(JSON.stringify(message)));
    const fragments: Buffer[] = [];
    let fragmentBytes = 0;
    socket.once('error', error => finish(error));
    socket.once('close', () => { if (!settled) finish(new Error('Codex socket closed without a response')); });
    socket.once('connect', () => socket.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ));
    socket.on('data', bytes => {
      try {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
        if (buffer.length > 4 * 1024 * 1024) throw new Error('Codex response exceeds limit');
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (buffer.length > 16 * 1024) throw new Error('Invalid WebSocket handshake'); return; }
          const header = buffer.subarray(0, end).toString('utf8');
          const accepted = header.split('\r\n').some(line => line.slice(0, line.indexOf(':')).toLowerCase() === 'sec-websocket-accept'
            && line.slice(line.indexOf(':') + 1).trim() === accept);
          if (!/^HTTP\/1\.[01] 101\b/u.test(header) || !accepted) throw new Error('Codex WebSocket handshake rejected');
          buffer = buffer.subarray(end + 4);
          upgraded = true;
          send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'flowcrew', title: 'FlowCrew', version: '1' } } });
        }
        while (buffer.length >= 2 && !settled) {
          const opcode = buffer[0] & 15;
          const final = Boolean(buffer[0] & 0x80);
          let size = buffer[1] & 127;
          let offset = 2;
          if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
          else if (size === 127) {
            if (buffer.length < 10) return;
            const big = buffer.readBigUInt64BE(2);
            if (big > 4n * 1024n * 1024n) throw new Error('Codex frame exceeds limit');
            size = Number(big); offset = 10;
          }
          if (buffer[1] & 0x80) throw new Error('Masked server frame');
          if (size > 4 * 1024 * 1024) throw new Error('Codex frame exceeds limit');
          if (buffer.length < offset + size) return;
          const body = buffer.subarray(offset, offset + size);
          buffer = buffer.subarray(offset + size);
          if (opcode === 8) throw new Error('Codex closed the WebSocket');
          if (opcode === 9) { frame(body, 10); continue; }
          if (opcode === 10) continue;
          if (opcode !== 0 && opcode !== 1) throw new Error('Unsupported WebSocket frame');
          fragments.push(body); fragmentBytes += body.length;
          if (fragmentBytes > 4 * 1024 * 1024) throw new Error('Codex message exceeds limit');
          if (!final) continue;
          const message = JSON.parse(Buffer.concat(fragments).toString('utf8'));
          fragments.length = 0; fragmentBytes = 0;
          if (message.method) continue; // Never answer a server approval request as if it were a receipt.
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) throw new Error(`Codex ${method}: ${JSON.stringify(message.error)}`);
          if (message.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method, params });
          } else finish(undefined, message.result);
        }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

export async function queueCodex(sessionId: string, message: string, codexHome?: string): Promise<string> {
  const result = await execFileAsync('codex', ['queue', '--thread', sessionId, '--message', message], {
    timeout: FRONTEND_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
  });
  return result.stdout.trim();
}

export async function sendClaude(socketPath: string, eventId: string, content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => socket.destroy(new Error('Claude inbox timed out')), FRONTEND_TIMEOUT_MS);
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
    socket.once('connect', () => {
      socket.end(`${JSON.stringify({ type: 'user', from: 'flowcrew', msg_id: eventId,
        message: { role: 'user', content } })}\n`, () => { resolve(); socket.destroy(); });
    });
  });
}

/** Existing operator notifier, when present. No Telegram credentials belong in
 * the engine. A failed/missing notifier remains retryable in the durable outbox. */
export async function notifyFallback(message: string, eventId: string): Promise<void> {
  await execFileAsync('notify', ['--source', 'flowcrew', '--dedup-key', eventId, message], {
    timeout: FRONTEND_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
}
