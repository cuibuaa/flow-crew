import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RUN_STATUS_LAYOUT, parseRunStatusFile, withCurrentBoot, type RunStatusFile } from '../rewrite-src/contract/runtime.js';

export interface MonitorConfig {
  readonly cancel?: (location: {storeRoot: string; run: string}, snapshot: RunStatusFile) => Promise<{exit: number | null; stdout: string; stderr: string}>;
  readonly storeRoots: readonly string[];
  readonly host?: string;
  readonly port: number;
  readonly boot?: string;
}

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function age(publishedAt: string, now: number): string {
  const seconds = Math.floor((now - Date.parse(publishedAt)) / 1000);
  return seconds < 0 ? `${Math.abs(seconds)}s ahead of reader clock` : `${seconds}s ago`;
}

function readStatus(directory: string, run: string, boot?: string): RunStatusFile | null {
  try {
    const file = join(directory, run, RUN_STATUS_LAYOUT.fileName);
    if (!lstatSync(file).isFile()) return null;
    const parsed = parseRunStatusFile(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.ok && parsed.value.run === run ? withCurrentBoot(parsed.value, boot) : null;
  } catch {
    return null;
  }
}

function duration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  return minutes < 1 ? (milliseconds === 0 ? '0m' : '&lt;1m')
    : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function overviewRow(run: string, status: RunStatusFile | null, now: number): string {
  if (!status) return `<tr class="run-row unavailable" data-run-status="unavailable"><th>${escape(run)}</th>
    <td><span class="badge">unavailable</span></td><td>—</td><td>—</td><td>—</td></tr>`;
  return `<tr class="run-row ${status.status}" data-run-status="${status.status}"><th>${escape(run)}</th>
    <td><span class="badge">${escape(status.interruption?.detail ?? status.status)}</span></td><td>${escape(status.currentStage ?? '—')}</td>
    <td>${status.step.elapsedMs === null ? 'unknown' : duration(status.step.elapsedMs)}</td>
    <td><time datetime="${status.publishedAt}">${age(status.publishedAt, now)}</time></td></tr>`;
}

function runCard(run: string, status: RunStatusFile | null, now: number, store: number, control: boolean): string {
  if (!status) return `<article class="run unavailable" data-status="unavailable">
    <div class="run-heading"><h3>${escape(run)}</h3><span class="badge">unavailable</span></div>
    <p>Snapshot missing, unreadable or unsupported.</p></article>`;
  const gates = status.gates.map(gate => `<li><span class="scope">${gate.scope}</span>
    <strong>${escape(gate.stage)}</strong> <span>${gate.outcome}</span>
    ${gate.result === undefined ? '' : `<span class="result">Result: ${escape(gate.result)}</span>`}
    <small>attempt ${escape(gate.attempt)} · cursor ${gate.cursor}</small></li>`).join('');
  return `<article class="run ${status.status}" data-status="${status.status}">
    <div class="run-heading"><h3>${escape(run)}</h3><span class="badge">${escape(status.interruption?.detail ?? status.status)}</span></div>
    <div class="identity"><span>Requester <strong>${escape(status.requester ?? '—')}</strong></span>
      <span>Stage <strong>${escape(status.currentStage ?? '—')}</strong></span></div>
    <p>Step elapsed: ${status.step.elapsedMs === null ? 'unknown' : duration(status.step.elapsedMs)} · usage ${status.usage.state}</p>
    <p>C2: gate ${status.backstop.gateSuffix}/3 · failure ${status.backstop.failureSuffix}/4 · engine outcomes</p>
    <p>Host readiness: ${status.host.readiness}</p><p>${status.host.interpretation.map(escape).join('<br>')}</p>
    <p>${escape(status.attention?.detail ?? '')}</p>
    ${status.interruption ? `<p>${escape(status.interruption.detail)} · <code>${escape(status.interruption.resume)}</code></p>` : ''}
    ${status.reclaimed ? `<p>Evidence was reclaimed at ${escape(status.reclaimed.at)}. Deliveries: ${escape(status.reclaimed.delivery)}</p>` : ''}
    <button type="button" class="cancel" data-store="${store}" data-run="${escape(run)}" ${control ? '' : 'disabled'}>Cancel</button>
    ${control ? '' : '<span>Control executable unavailable</span>'}<p class="cancel-result" role="status"></p>
    <div class="gates"><span class="label">Gates</span>${gates ? `<ul>${gates}</ul>` : '<span>None published</span>'}</div>
    <footer><span>Stop: <strong>${escape(status.stopReason ?? '—')}</strong></span>
      <span>Published <time datetime="${status.publishedAt}" title="${status.publishedAt}">${age(status.publishedAt, now)}</time>
      · cursor ${status.journalCursor} · status since ${status.statusSince}</span></footer></article>`;
}

function storeSection(root: string, now: number, store: number, control: boolean, boot?: string): string {
  let content: string;
  try {
    const directory = join(root, RUN_STATUS_LAYOUT.runsDirectory);
    const runs = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => entry.name).sort();
    const snapshots = runs.map(run => ({ run, status: readStatus(directory, run, boot) }));
    content = runs.length ? `<div class="overview"><table><thead><tr><th>Run</th><th>Status</th><th>Stage</th><th>Step elapsed</th><th>Age</th></tr></thead>
      <tbody>${snapshots.map(({ run, status }) => overviewRow(run, status, now)).join('')}</tbody></table></div>
      <details class="run-details"><summary>Run details and gate evidence (${runs.length})</summary>
        <div class="run-list">${snapshots.map(({ run, status }) => runCard(run, status, now, store, control)).join('')}</div></details>`
      : '<p class="empty">No run directories.</p>';
  } catch {
    content = '<p class="empty unavailable">Store unavailable — run directory cannot be read.</p>';
  }
  return `<section class="store"><h2>${escape(root)}</h2>${content}</section>`;
}

const styles = `
:root{color-scheme:light dark;--bg:#f3f5f9;--panel:#fff;--ink:#172339;--muted:#526077;--line:#dce2ed;--track:#e4e9f1;--accent:#315ee8;--good:#087b57;--warn:#986000;--bad:#bd304b}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#101722;--panel:#192332;--ink:#e5ecf7;--muted:#aab8cd;--line:#33435b;--track:#2c3a4f;--accent:#89a9ff;--good:#6cdbb4;--warn:#f1c06f;--bad:#ff92a7}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#101722;--panel:#192332;--ink:#e5ecf7;--muted:#aab8cd;--line:#33435b;--track:#2c3a4f;--accent:#89a9ff;--good:#6cdbb4;--warn:#f1c06f;--bad:#ff92a7}
:root[data-theme="light"]{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif}body>header,main{max-width:1400px;margin:auto;padding:24px}body>header{display:flex;justify-content:space-between;gap:16px;align-items:center;padding-bottom:0}h1{font-size:25px;margin:0}p{color:var(--muted);margin:6px 0}button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:9px 14px;cursor:pointer}button:focus-visible{outline:3px solid var(--accent)}h2{color:var(--muted);font-size:13px;font-weight:500;overflow-wrap:anywhere;margin:0 0 14px}.store{margin:0 0 28px}.run-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:16px;align-items:start}.run{--tone:var(--muted);background:var(--panel);border:1px solid var(--line);border-top:4px solid var(--tone);border-radius:12px;padding:18px;min-width:0}.run-row{--tone:var(--muted)}.running{--tone:var(--accent)}.complete{--tone:var(--good)}.parked,.accepted_blocked,.incomplete,.escalated{--tone:var(--warn)}.failed{--tone:var(--bad)}.run-heading{display:flex;gap:12px;align-items:start;justify-content:space-between}h3{font-size:17px;margin:0;overflow-wrap:anywhere}.badge{color:var(--tone);border:1px solid currentColor;border-radius:20px;padding:2px 9px;font-size:12px;white-space:nowrap}.identity{display:flex;gap:8px 22px;flex-wrap:wrap;margin:14px 0;color:var(--muted);overflow-wrap:anywhere}strong{color:var(--ink);font-weight:600}.certainty,.label{font-size:12px;color:var(--muted)}.bound{margin:10px 0}.bound>div{display:flex;justify-content:space-between;gap:10px;font-size:12px}meter{display:block;width:100%;height:12px;accent-color:var(--tone)}meter::-webkit-meter-bar{background:var(--track);border:0}meter::-webkit-meter-optimum-value{background:var(--tone)}meter::-moz-meter-bar{background:var(--tone)}.gates{border-top:1px solid var(--line);padding-top:12px;margin-top:16px;font-size:12px}.gates>span+span{margin-left:10px;color:var(--muted)}ul{margin:6px 0 0;padding:0;list-style:none}li{padding:5px 0;overflow-wrap:anywhere}.scope{color:var(--accent);margin-right:7px}.result{display:inline-block;margin-left:8px;font-weight:600}small{display:block;color:var(--muted)}footer{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:11px;border-top:1px solid var(--line);margin-top:12px;padding-top:10px}.empty{padding:20px;border:1px dashed var(--line);border-radius:10px}.overview{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap;font-size:12px}tbody tr:last-child>*{border-bottom:0}tbody th{max-width:320px;overflow:hidden;text-overflow:ellipsis}thead th{color:var(--muted);font-weight:500}.tightest{min-width:170px}.tightest span{font-size:11px;color:var(--muted)}.tightest meter{height:8px}.run-details{margin-top:12px}.run-details summary{cursor:pointer;color:var(--muted);padding:4px 0 12px}#refresh-error{color:var(--warn)}[hidden]{display:none!important}@media(max-width:560px){body>header,main{padding:16px}h1{font-size:21px}.run{padding:14px}}
`;

const script = `
document.addEventListener('click', async event => {
  const button = event.target.closest('.cancel');
  if (!button || button.disabled) return;
  const result = button.parentElement.querySelector('.cancel-result');
  button.disabled = true;
  try {
    const response = await fetch('/cancel/' + button.dataset.store + '/' + encodeURIComponent(button.dataset.run), {method:'POST'});
    result.textContent = await response.text();
    if (!response.ok) result.textContent = 'Cancel failed: ' + result.textContent;
  } catch (error) { result.textContent = 'Cancel unavailable: ' + error.message; }
  finally { button.disabled = false; }
});
const theme = document.getElementById('theme');
theme.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  theme.setAttribute('aria-pressed', String(!dark));
});
function updateAges() {
  document.querySelectorAll('time[datetime]').forEach(time => {
    const seconds = Math.floor((Date.now() - Date.parse(time.dateTime)) / 1000);
    time.textContent = seconds < 0 ? Math.abs(seconds) + 's ahead of reader clock' : seconds + 's ago';
  });
}
async function poll() {
  try {
    const response = await fetch('/', {method:'GET', cache:'no-store'});
    if (!response.ok) throw new Error('Refresh unavailable');
    const next = new DOMParser().parseFromString(await response.text(), 'text/html');
    document.getElementById('runs').replaceChildren(...next.getElementById('runs').childNodes);
    document.getElementById('refresh-error').hidden = true;
    updateAges();
  } catch {
    document.getElementById('refresh-error').hidden = false;
  } finally {
    setTimeout(poll, 5000);
  }
}
updateAges();
setInterval(updateAges, 1000);
setTimeout(poll, 5000);
`;

function page(roots: readonly string[], control: boolean, boot?: string): string {
  const now = Date.now();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>FlowCrew · Run monitor</title>
    <style>${styles}</style></head><body><header><div><h1>FlowCrew <span>Run monitor</span></h1>
    <p>Polls every 5s · Cancel uses the FlowCrew CLI</p>
    <p>Published facts only. Snapshot age does not establish liveness.</p>
    <p id="refresh-error" role="status" hidden>Refresh unavailable — showing previous snapshot.</p></div>
    <button id="theme" type="button" aria-label="Toggle dark theme">Light / dark</button></header>
    <main id="runs">${roots.map((root, index) => storeSection(root, now, index, control, boot)).join('')}</main><script>${script}</script></body></html>`;
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
      'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` };
    if (request.method === 'POST' && request.url?.startsWith('/cancel/')) {
      const origin = request.headers.origin;
      if (!origin || origin !== `http://${request.headers.host}`) { response.writeHead(403, headers).end('Same origin required'); return; }
      const parts = request.url.split('/');
      const store = Number(parts[2]), run = parts[3];
      if (parts.length !== 4 || !/^(0|[1-9][0-9]*)$/.test(parts[2]) || !roots[store]
        || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(run)) { response.writeHead(400, headers).end('Invalid configured run'); return; }
      const status = readStatus(join(roots[store], RUN_STATUS_LAYOUT.runsDirectory), run);
      if (!status) { response.writeHead(404, headers).end('Run unavailable'); return; }
      if (!config.cancel) { response.writeHead(503, headers).end('Control executable unavailable'); return; }
      try {
        const result = await config.cancel({storeRoot:roots[store],run}, status);
        response.writeHead(result.exit === 0 ? 200 : 409, {...headers,'Content-Type':'text/plain; charset=utf-8'})
          .end(`CLI exit ${result.exit ?? 'unknown'}\n${result.stdout}${result.stderr}`);
      } catch (error) { response.writeHead(503, headers).end(String(error)); }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
      return;
    }
    if (request.url?.split('?')[0] !== '/') {
      response.writeHead(404, headers).end();
      return;
    }
    const html = page(roots, !!config.cancel, config.boot);
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    response.end(request.method === 'HEAD' ? undefined : html);
  });
  // Node routes tunnelling and protocol upgrades outside the request callback.
  for (const event of ['connect', 'upgrade'] as const) server.on(event, (request, socket) => {
    const code = request.method === 'GET' || request.method === 'HEAD' ? '404 Not Found' : '405 Method Not Allowed';
    socket.end(`HTTP/1.1 ${code}\r\nAllow: GET, HEAD\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
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
