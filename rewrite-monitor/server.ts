import { observeStatus } from '../rewrite-src/host/identity.mjs';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RUN_STATUS_LAYOUT, parseRunStatusFile, type RunStatusFile } from '../rewrite-src/contract/runtime.js';
import { styles, symbols, script, runCard, summary, legend, needsYou, ended } from './view.js';

export interface MonitorConfig {
  readonly storeRoots: readonly string[];
  readonly host?: string;
  readonly port: number;
}
async function readStatus(directory: string, run: string): Promise<RunStatusFile | null> {
  try {
    const file = join(directory,run,RUN_STATUS_LAYOUT.fileName);
    if (!lstatSync(file).isFile()) return null;
    const parsed = parseRunStatusFile(JSON.parse(readFileSync(file,'utf8')));
    return parsed.ok && parsed.value.run === run ? await observeStatus(parsed.value) : null;
  } catch { return null; }
}
async function page(roots: readonly string[]): Promise<string> {
  const now = Date.now(), statuses: RunStatusFile[] = [];
  let unavailable = false;
  const stores = (await Promise.all(roots.map(async (root,index) => {
    let content: string;
    try {
      const directory = join(root,RUN_STATUS_LAYOUT.runsDirectory);
      const snapshots = await Promise.all(readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory())
        .map(async entry=>({run:entry.name,status:await readStatus(directory,entry.name)})));
      for (const item of snapshots) if (item.status) statuses.push(item.status);
      unavailable ||= snapshots.some(item=>!item.status);
      const rank = (s: RunStatusFile | null) => !s ? 3 : ended(s) ? 2 : needsYou(s) ? 0 : 1;
      snapshots.sort((a,b)=>rank(a.status)-rank(b.status) || a.run.localeCompare(b.run));
      let inEnded = false;
      content = snapshots.length ? snapshots.map(({run,status})=>{
        const heading = (!status || ended(status)) && !inEnded;
        inEnded ||= heading;
        return (heading ? '<p class="label" data-key="ended">Ended</p>' : '') + runCard(run,status,now,index+'-'+run);
      }).join('')
        : '<p class="empty">No run directories.</p>';
    } catch { unavailable = true; content = '<p class="empty">Store unavailable</p>'; }
    return `<section class="store" data-key="${index}" aria-label="Store ${index + 1}">${content}</section>`;
  }))).join('');
  const need = statuses.filter(needsYou).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${need ? '('+need+') ' : ''}FlowCrew</title><style>${styles}</style></head><body>${symbols}<div class="backdrop" aria-hidden="true"></div><div class="wrap"><header class="top"><div class="brand"><div class="logo" aria-hidden="true"><svg class="i"><use href="#i-logo"/></svg></div><h1>FlowCrew</h1></div><nav class="sum" id="sum" aria-label="Runs by state">${summary(statuses,now,unavailable)}</nav><div class="tools"><span class="live" id="poll-health" data-tip="Live · refreshes every 5 s" aria-label="Poll health" tabindex="0" role="img"></span><button type="button" class="iconbtn" id="help" aria-label="Legend" aria-expanded="false" data-tip="Legend"><svg class="i"><use href="#i-help"/></svg></button><button type="button" class="iconbtn" id="theme" aria-label="Light theme" data-tip="Light theme"><svg class="i"><use href="#i-sun"/></svg></button></div><div class="glass legend" id="legend" hidden>${legend}</div></header><main id="runs" style="display:grid;gap:14px;grid-template-columns:minmax(0,1fr)">${stores}</main></div><div class="tip" id="tip" role="tooltip" hidden></div><script>${script}</script></body></html>`;
}

/** Start the independent snapshot reader. The caller owns closing the returned server. */
export async function startMonitor(config: MonitorConfig): Promise<Server> {
  if (!config.storeRoots.length || config.storeRoots.some(root => !root.trim())) throw new Error('Supply at least one store root');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port');
  const host = config.host ?? '127.0.0.1';
  if (!host.trim()) throw new Error('Invalid host');
  const roots = [...new Set(config.storeRoots.map(root => resolve(root)))];
  const server = createServer(async (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; style-src-attr 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` };
    if (request.method !== 'GET') {
      response.writeHead(405, { ...headers, Allow: 'GET' }).end();
      return;
    }
    if (request.url?.split('?')[0] !== '/') {
      response.writeHead(404, headers).end();
      return;
    }
    const html = await page(roots);
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    response.end(html);
  });
  // Node routes tunnelling and protocol upgrades outside the request callback.
  for (const event of ['connect', 'upgrade'] as const) server.on(event, (request, socket) => {
    const code = request.method === 'GET' ? '404 Not Found' : '405 Method Not Allowed';
    socket.end(`HTTP/1.1 ${code}\r\nAllow: GET\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(config.port, host, () => {
      server.off('error', reject);
      resolveListening();
    });
  });
  return server;
}
