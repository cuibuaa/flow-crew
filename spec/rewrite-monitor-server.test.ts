import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { METHODS } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import ts from 'typescript';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { startMonitor } from '../rewrite-monitor/server.js';
import { parseRunStatusFile,type RunStatusFile } from '../rewrite-src/contract/runtime.js';
import { wireStatus } from './fixtures/rewrite-status.js';
// Exercise the real handlers and their Node bind arguments without opening a network service.
vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return { ...actual, createServer: (handler: any) => {
      const server = actual.createServer(handler);
      server.listen = vi.fn((port, host, ready) => {
        server.address = () => ({ address: host, port, family: 'IPv4' });
        ready();
        return server;
      }) as typeof server.listen;
      server.close = ((done: any) => { done(); return server; }) as typeof server.close;
      return server;
    } };
});
const reasons = {
  pending: null, running: null, parked: 'attempt_failed', complete: 'completed',
  accepted_blocked: 'accepted_blocked', incomplete: 'command_missing', failed: 'gate_irreparable',
  escalated: 'recovery_unknown', cancelled: 'cancelled',
} as const;
const states = Object.keys(reasons) as Array<keyof typeof reasons>;
function status(run: string, state: keyof typeof reasons = 'running'): RunStatusFile {
  return {
    ...wireStatus(run,state,'frontend:session_A'),publishedAt:'2001-01-01T00:00:00Z',currentStage:['running','parked'].includes(state) ? 'work_A' : null,
    gates: [
      { stage: 'progress_A', attempt: 'attempt_A', scope: 'progress', outcome: 'accepted',
        answer: { path: 'evidence/progress.json', sha256: 'a'.repeat(64) }, cursor: 1 },
      ...(['accepted', 'accepted_blocked', 'rejected_repairable', 'rejected_irreparable'] as const)
        .map((outcome, index) => ({ stage: 'delivery_A', attempt: `attempt_${index}`, scope: 'delivery' as const,
        outcome, result: `label_${index}`, answer: { path: 'evidence/final.json', sha256: 'b'.repeat(64) }, cursor: 2 })),
    ],
    stopReason: reasons[state], journalCursor: 8, statusSince: 3,
  };
}
function put(root: string, run: string, value: unknown): void {
  const directory = join(root, 'runs', run);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'status.json'), JSON.stringify(value));
}
function get(server: Server, method = 'GET', path = '/', headers = {}): Promise<{
  code: number | undefined;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
}> {
  return new Promise(resolveResponse => {
    const request = { method, url: path, headers };
    if (method === 'CONNECT' || 'Upgrade' in headers) {
      server.emit(method === 'CONNECT' ? 'connect' : 'upgrade', request, { end: (raw: string) => {
          const lines = raw.split('\r\n'), code = Number(lines[0].split(' ')[1]);
          const parsed = Object.fromEntries(lines.slice(1).filter(line => line.includes(':'))
            .map(line => { const at = line.indexOf(':'); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]; }));
          resolveResponse({ code, headers: parsed, body: '' });
        } });
    }
    else {
      let code: number, resultHeaders: Record<string, string>;
      const response = { writeHead: (status: number, values: Record<string, string>) => {
          code = status;
          resultHeaders = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
          return response;
        }, end: (body = '') => resolveResponse({ code, headers: resultHeaders, body }) };
      server.emit('request', request, response);
    }
  });
}
function inventory(root: string): unknown[] {
  return readdirSync(root).sort().map(name => {
    const file = join(root, name);
    const info = lstatSync(file);
    return info.isDirectory() ? [name, inventory(file)]
      : [name, info.mtimeMs, createHash('sha256').update(readFileSync(file)).digest('hex')];
  });
}
describe('independent read-only monitor', () => {
  let temporary: string;
  let roots: string[];
  let servers: Server[];
  let windows: JSDOM[];
  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), 'rewrite-monitor-'));
    roots = [join(temporary, 'store_A'), join(temporary, 'store_B')];
    for (const root of roots)
      mkdirSync(join(root, 'runs'), { recursive: true });
    servers = [];
    windows = [];
  });
  afterEach(async () => {
    for (const dom of windows)
      dom.window.close();
    await Promise.all(servers.map(server => new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
      server.closeAllConnections();
    })));
    rmSync(temporary, { recursive: true, force: true });
  });
  async function start(storeRoots = roots, host?: string): Promise<Server> {
    const server = await startMonitor({ storeRoots, port: 0, host });
    servers.push(server);
    return server;
  }
  function dom(html: string): JSDOM {
    const result = new JSDOM(html);
    windows.push(result);
    return result;
  }
  it('interprets a changed boot without a CLI or database and keeps the snapshot bytes unchanged', async () => {
    const value = status('BootChanged');
    put(roots[0], 'BootChanged', { ...value, host: { ...value.host, boot: 'recorded-boot' } });
    const before = inventory(roots[0]);
    const server = await startMonitor({ storeRoots: roots, port: 0, boot: 'current-boot' }); servers.push(server);
    const response = await get(server);
    expect(response.body).toContain('<span class="badge">interrupted by restart</span>');
    expect(response.body).toContain('flowcrew resume BootChanged');
    expect(inventory(roots[0])).toEqual(before);
  });
  it('renders persisted restart instructions and reclaimed evidence without changing snapshots', async () => {
    put(roots[0], 'Restarted', { ...status('Restarted'), interruption: { detail: 'interrupted by restart', resume: 'flowcrew resume Restarted' } });
    put(roots[0], 'Reclaimed', { ...status('Reclaimed', 'complete'), reclaimed: {
      at: '2030-01-01T00:00:00Z', delivery: join(roots[0], 'deliveries', 'Reclaimed') } });
    const before = inventory(roots[0]), server = await start();
    const response = await get(server);
    expect(response.body).toContain('<span class="badge">interrupted by restart</span>');
    expect(response.body).toContain('flowcrew resume Restarted');
    expect(response.body).toContain('Evidence was reclaimed at 2030-01-01T00:00:00Z');
    expect(inventory(roots[0])).toEqual(before);
  });
  it('lists every lifecycle and gate outcome across two roots with published facts and usage meters', async () => {
    for (const state of states) {
      const value = status(`run_${state}`, state);
      expect(parseRunStatusFile(value).ok).toBe(true);
      put(roots[0], value.run, value);
    }
    put(roots[1], 'run_running', { ...status('run_running', 'complete'), requester: 'other:session' });
    const response = await get(await start());
    expect(response.code).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const document = dom(response.body).window.document;
    const stores = document.querySelectorAll('.store');
    expect(stores).toHaveLength(2);
    expect(stores[0].querySelector('h2')!.textContent).toBe(roots[0]);
    expect(stores[1].textContent).toContain('other:session');
    expect(document.querySelectorAll('.run')).toHaveLength(10);
    for (const state of states) {
      const card = stores[0].querySelector(`[data-status="${state}"]`)!;
      expect(card.querySelector('h3')!.textContent).toBe(`run_${state}`);
      expect(card.textContent).toContain('frontend:session_A');
      expect(card.textContent).toContain(reasons[state] ?? 'Stop: —');
      expect(card.textContent).toContain(state === 'running' || state === 'parked' ? 'work_A' : 'Stage —');
      expect(card.textContent).toContain('Step elapsed: unknown');
      expect(card.textContent).toContain('C2: gate 0/3');
      expect(card.querySelectorAll('meter')).toHaveLength(0);
      expect(card.querySelectorAll('.scope')[0].textContent).toBe('progress');
      expect(card.querySelectorAll('.scope')[1].textContent).toBe('delivery');
      for (const [index, outcome] of ['accepted', 'accepted_blocked', 'rejected_repairable', 'rejected_irreparable'].entries()) {
        expect(card.textContent).toContain(outcome);
        expect(card.textContent).toContain(`Result: label_${index}`);
      }
      expect(card.querySelector('time')!.dateTime).toBe('2001-01-01T00:00:00Z');
      expect(card.querySelector('time')!.textContent).toMatch(/^\d+s ago$/);
    }
    expect(document.querySelector('[data-status="running"] .badge')!.textContent).toBe('running');
    expect(document.body.textContent).toContain('Snapshot age does not establish liveness.');
  });
  it('shows missing, malformed, invalid, future-version and mismatched snapshots as unavailable without journal recovery', async () => {
    const cases = [
      ['missing', undefined], ['malformed', undefined], ['invalid', {}],
      ['future', { ...status('future'), version: 3 }],
      ['contradiction', { ...status('contradiction', 'complete'), stopReason: null }],
      ['mismatch', status('another_run')],
    ] as const;
    for (const [run, value] of cases) {
      mkdirSync(join(roots[0], 'runs', run));
      if (value !== undefined)
        put(roots[0], run, value);
      writeFileSync(join(roots[0], 'runs', run, 'journal.jsonl'), 'ignored, never reconstructed');
    }
    writeFileSync(join(roots[0], 'runs', 'malformed', 'status.json'), '{');
    writeFileSync(join(roots[0], 'runs', 'not_a_directory'), '{}');
    mkdirSync(join(roots[0], 'runs', 'missing', 'nested_run'));
    const response = await get(await start());
    expect(response.code).toBe(200);
    const document = dom(response.body).window.document;
    expect([...document.querySelectorAll('.run h3')].map(node => node.textContent).sort()).toEqual(cases.map(([run]) => run).sort());
    expect(document.querySelectorAll('[data-status="unavailable"]')).toHaveLength(cases.length);
    expect(document.querySelectorAll('meter, time')).toHaveLength(0);
  });
  it('keeps missing stores visible, does not create them, and distinguishes an empty store', async () => {
    const missing = join(temporary, 'absent');
    const before = inventory(temporary);
    const response = await get(await start([roots[0], missing]));
    const document = dom(response.body).window.document;
    expect(document.querySelectorAll('.store')).toHaveLength(2);
    expect(document.body.textContent).toContain('No run directories.');
    expect(document.body.textContent).toContain('Store unavailable');
    expect(inventory(temporary)).toEqual(before);
  });
  it('displays future timestamps as clock skew and zero usage without changing the published status', async () => {
    put(roots[0], 'future_clock', { ...wireStatus('future_clock'), publishedAt: '2099-01-01T00:00:00Z', gates: [] });
    const document = dom((await get(await start())).body).window.document;
    expect(document.querySelector('.badge')!.textContent).toBe('running');
    expect(document.querySelector('time')!.textContent).toMatch(/^\d+s ahead of reader clock$/);
    expect(document.querySelector('.run')!.textContent).toContain('Requester —');
    expect(document.querySelector('.run')!.textContent).toContain('None published');
    expect([...document.querySelectorAll('meter')].every(meter => meter.value === 0)).toBe(true);
  });
  it('refuses every other supported HTTP method on every route and leaves store bytes and mtimes intact', async () => {
    put(roots[0], 'run_A', status('run_A'));
    const before = inventory(temporary);
    const server = await start();
    expect(server.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
    for (const method of METHODS.filter(method => method !== 'GET' && method !== 'HEAD')) {
      for (const path of ['/', '/cancel']) {
        const response = await get(server, method, path);
        expect(response.code, `${method} ${path}`).toBe(405);
        expect(response.headers.allow).toBe('GET, HEAD');
        expect(response.body).toBe('');
      }
    }
    for (const path of ['/', '/?refresh=1']) {
      const head = await get(server, 'HEAD', path);
      expect(head.code).toBe(200);
      expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
      expect(head.body).toBe('');
      expect((await get(server, 'GET', path)).code).toBe(200);
    }
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/status.json', '/cancel', '/runs/run_A/status.json', '/../../status.json']) {
        expect((await get(server, method, path)).code).toBe(404);
      }
    }
    expect((await get(server, 'POST', '/', { Connection: 'Upgrade', Upgrade: 'websocket' })).code).toBe(405);
    expect((await get(server, 'GET', '/', { Connection: 'Upgrade', Upgrade: 'websocket' })).code).toBe(404);
    expect(inventory(temporary)).toEqual(before);
  });
  it('rereads atomic publications, then reports deletion unavailable, without persisting reader state', async () => {
    put(roots[0], 'run_A', status('run_A'));
    const server = await start();
    expect(dom((await get(server)).body).window.document.querySelector('.badge')!.textContent).toBe('running');
    const directory = join(roots[0], 'runs', 'run_A');
    writeFileSync(join(directory, 'status.next'), JSON.stringify(status('run_A', 'complete')));
    renameSync(join(directory, 'status.next'), join(directory, 'status.json'));
    expect(dom((await get(server)).body).window.document.querySelector('.badge')!.textContent).toBe('complete');
    rmSync(join(directory, 'status.json'));
    expect(dom((await get(server)).body).window.document.querySelector('.badge')!.textContent).toBe('unavailable');
  });
  it('escapes untrusted directory/root text and refuses symlink snapshots and non-immediate directory aliases', async () => {
    const unsafeRoot = join(temporary, '<store>&"');
    const unsafeRun = '<img src=x onerror=alert(1)>';
    mkdirSync(join(unsafeRoot, 'runs', unsafeRun), { recursive: true });
    put(unsafeRoot, 'linked_status', status('linked_status'));
    renameSync(join(unsafeRoot, 'runs', 'linked_status', 'status.json'), join(temporary, 'outside.json'));
    symlinkSync(join(temporary, 'outside.json'), join(unsafeRoot, 'runs', 'linked_status', 'status.json'));
    symlinkSync(join(unsafeRoot, 'runs', unsafeRun), join(unsafeRoot, 'runs', 'linked_run'));
    const response = await get(await start([unsafeRoot]));
    const document = dom(response.body).window.document;
    expect(document.querySelector('h2')!.textContent).toBe(unsafeRoot);
    expect([...document.querySelectorAll('h3')].map(node => node.textContent)).toEqual([unsafeRun, 'linked_status']);
    expect(document.querySelectorAll('.run.unavailable')).toHaveLength(2);
    expect(document.querySelectorAll('img, a')).toHaveLength(0);
    expect(document.querySelector('button')!.id).toBe('theme');
    const csp = response.headers['content-security-policy'] as string;
    for (const element of document.querySelectorAll('script, style')) {
      const hash = createHash('sha256').update(element.textContent!).digest('base64');
      expect(csp).toContain(`'sha256-${hash}'`);
    }
    expect(csp).toContain("form-action 'none'");
  });
  it('polls with GET, preserves the last facts on failure and updates their age', async () => {
    put(roots[0], 'run_A', status('run_A'));
    const server = await start();
    const first = (await get(server)).body;
    put(roots[0], 'run_A', status('run_A', 'complete'));
    const second = (await get(server)).body;
    const timeouts: Array<() => Promise<void>> = [];
    const intervals: Array<() => void> = [];
    const calls: unknown[] = [];
    let refreshFails = false;
    const browser = new JSDOM(first, { runScripts: 'dangerously', beforeParse(window) {
        window.matchMedia = (() => ({ matches: false })) as typeof window.matchMedia;
        window.setTimeout = ((callback: () => Promise<void>) => { timeouts.push(callback); return 1; }) as typeof window.setTimeout;
        window.setInterval = ((callback: () => void) => { intervals.push(callback); return 1; }) as typeof window.setInterval;
        window.fetch = async (...args) => {
          calls.push(args);
          if (refreshFails)
            throw new Error('Unavailable');
          return { ok: true, text: async () => second } as Response;
        };
      } });
    windows.push(browser);
    const document = browser.window.document;
    const theme = document.querySelector('button')!;
    theme.click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    theme.click();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(timeouts).toHaveLength(1);
    await timeouts.shift()!();
    expect(calls).toEqual([['/', { method: 'GET', cache: 'no-store' }]]);
    expect(document.querySelector('.badge')!.textContent).toBe('complete');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('#refresh-error')!.hasAttribute('hidden')).toBe(true);
    refreshFails = true;
    await timeouts.shift()!();
    expect(document.querySelector('#refresh-error')!.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('.badge')!.textContent).toBe('complete');
    const time = document.querySelector('time')!;
    time.textContent = 'old text';
    intervals[0]();
    expect(time.textContent).toMatch(/^\d+s ago$/);
    expect(timeouts).toHaveLength(1);
  });
  it('validates explicit roots, host and port and accepts an explicit listen host', async () => {
    for (const config of [
      { storeRoots: [], port: 0 }, { storeRoots: [''], port: 0 },
      { storeRoots: roots, port: -1 }, { storeRoots: roots, port: 65536 },
      { storeRoots: roots, port: 1.5 }, { storeRoots: roots, port: 0, host: '' },
    ])
      await expect(startMonitor(config)).rejects.toThrow();
    const server = await start(roots, '127.0.0.2');
    expect(server.listen).toHaveBeenCalledWith(0, '127.0.0.2', expect.any(Function));
    expect((await get(server)).code).toBe(200);
  });
});
it('reads canonical snapshots through monitor modules and permits the installed CLI port', () => {
  const root = resolve(import.meta.dirname, '..');
  const monitor = join(root, 'rewrite-monitor');
  for (const file of readdirSync(monitor).filter(file => file.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, readFileSync(join(monitor, file), 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node)) {
        const reference = (node.moduleSpecifier as ts.StringLiteral).text;
        if (file === 'server.ts') expect(reference).not.toBe('node:child_process');
        const bindings = node.importClause?.namedBindings;
        expect(bindings && ts.isNamedImports(bindings), file).toBe(true);
        const names = bindings &&
         ts.isNamedImports(bindings) ? bindings.elements.map(element => (element.propertyName ?? element.name).text) : [];
        if (reference === '../rewrite-src/contract/runtime.js') {
          expect(names.every(name => ['RunStatusFile', 'parseRunStatusFile', 'RUN_STATUS_LAYOUT', 'withCurrentBoot'].includes(name))).toBe(true);
        }
        else if (reference === '../rewrite-src/host/process.js') {
          expect(file).toBe('cli.ts');
          expect(names).toEqual(['ownIdentity']); // Read-only host observation belongs in trusted composition, never the HTTP reader.
        }
        else if (reference.startsWith('.')) {
          expect(dirname(resolve(monitor, reference))).toBe(monitor);
        }
        else {
          expect(reference.startsWith('node:'), reference).toBe(true);
        }
      }
      if (ts.isCallExpression(node)) {
        expect(node.expression.kind === ts.SyntaxKind.ImportKeyword).toBe(false);
        expect(ts.isIdentifier(node.expression) && node.expression.text === 'require').toBe(false);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
