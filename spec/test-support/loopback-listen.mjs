import { Server, isIP } from 'node:net';

// These fixtures exercise dashboard lifecycle/API behavior on disposable roots.
// Keep the production host request visible: this fence is test routing, never
// evidence that the production dashboard enforces a network boundary.
const dashboardFixtures = new Set([
  'acceptance-gate.qa.test.ts', 'api/campaign-schema.test.ts',
  'campaign-page-api.test.ts', 'dashboard-approval.test.ts',
  'dashboard-campaign.test.ts', 'dashboard-task-lifecycle.test.ts',
  'dashboard-truthfulness.test.ts', 'engine-truthfulness.test.ts',
  'entry-guards.test.ts', 'replan-evidence-retention.test.ts',
  'signal-cli.test.ts', 'supervisor-usage.test.ts',
  'test-isolation.test.ts', 'ux-perf-dashboard-event.replay.ts',
]);
const key = Symbol.for('flowcrew.test.loopback-listen');

/** Install once per process; resolve the current fixture at each native call. */
export function installLoopbackListenFence(fixtureName) {
  if (process[key]) {
    process[key].fixtureName = fixtureName;
    return process[key];
  }
  const state = { fixtureName, requests: [], original: Server.prototype.listen };
  process[key] = state;
  Server.prototype.listen = function (...args) {
    const first = args[0];
    // Pathname sockets are a separate isolation responsibility. Do not change
    // their spelling or shorten their paths under this TCP listener policy.
    if (typeof first === 'string' && !/^\d+$/.test(first)) {
      return Reflect.apply(state.original, this, args);
    }
    const options = first !== null && typeof first === 'object' ? first : null;
    if (options && (options.fd !== undefined || options.handle !== undefined)) {
      throw new Error('Test listener policy cannot authenticate an inherited listener');
    }
    if (options?.path !== undefined && options.port === undefined) {
      return Reflect.apply(state.original, this, args);
    }
    const host = options ? options.host : typeof args[1] === 'string' ? args[1] : undefined;
    const port = options ? options.port : first;
    const fixture = typeof state.fixtureName === 'function' ? state.fixtureName() : state.fixtureName;
    const relativeFixture = String(fixture ?? '').replaceAll('\\', '/').split('/spec/').at(-1);
    const explicitLoopback = host === '::1' || (isIP(host ?? '') === 4 && host.startsWith('127.'));
    const stack = new Error().stack ?? '';
    const dashboardRequest = host === '0.0.0.0' && Number(port) === 0
      && dashboardFixtures.has(relativeFixture)
      && (/[\\/]fastify[\\/]lib[\\/]server\.js/.test(stack)
        // `start` probes its port before Fastify starts. The standalone CLI
        // lifecycle fixture owns both listeners; neither may bind wildcard.
        || (/portAvailable/.test(stack) && /[\\/]cli\.js/.test(stack)));
    if (!explicitLoopback && host !== 'localhost' && !dashboardRequest) {
      state.requests.push({ fixture: relativeFixture, requestedHost: host ?? null, actualHost: null, port, refused: true });
      throw new Error(`Test listener policy refuses non-loopback host ${String(host)}`);
    }
    const actualHost = explicitLoopback ? host : '127.0.0.1';
    state.requests.push({ fixture: relativeFixture, requestedHost: host ?? null, actualHost, port, refused: false });
    if (options) args[0] = { ...options, host: actualHost };
    else if (typeof args[1] === 'string') args[1] = actualHost;
    else args.splice(1, 0, actualHost);
    return Reflect.apply(state.original, this, args);
  };
  return state;
}

export function loopbackListenRequests() {
  return process[key]?.requests ?? [];
}
