import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { answerSchema } from '../../dist-rewrite/contract/answers.js';
import { composeInput } from '../../dist-rewrite/exec/input.js';
import * as host from '../../dist-rewrite/host/process.js';
import { runUnitEntry } from '../../dist-rewrite/ops/run.js';
import { readRunStatus } from '../../dist-rewrite/ops/status.js';
import { readEvents } from '../../dist-rewrite/records/state.js';
import { runServices } from '../fixtures/rewrite-run-services.js';
import { stateFixture, get, type StateFixture } from '../fixtures/rewrite-state.js';
vi.mock('../../dist-rewrite/host/process.js', async (original) => ({ ...await original<typeof import('../../dist-rewrite/host/process.js')>(),
 observeRun: vi.fn(), startRun: vi.fn(), stopRun: vi.fn() }));
let f: StateFixture, config = '';
beforeEach(async () => {
  f = await stateFixture();
  const observed = { unit: f.launch.unit, state: 'inactive' as const, owner: null, evidence: [], detail: 'fixture manager observation' };
  vi.mocked(host.observeRun).mockResolvedValue({ ok: true, value: observed });
  vi.mocked(host.startRun).mockResolvedValue({ ok: true, value: { ...observed, state: 'active' } });
  vi.mocked(host.stopRun).mockResolvedValue({ ok: true, value: observed });
  config = await mkdtemp(join(tmpdir(), 'fcrw-gate-config-'));
  await mkdir(join(config, 'roles'));
  await writeFile(join(config, 'roles', 'gate.md'), 'Review the work.\n');
});
afterEach(async () => { vi.clearAllMocks(); await f.close(); await rm(config, { recursive: true, force: true }); });

// A run prepared before setup recorded its base tree resumes with its own runtime copy; if a gate does run on one here, composing its input is
// refused. That refusal is an ordinary failed attempt: the loop's single error exit ends the run, it does not retry the stage.
it('a gate on a run that recorded no base tree parks the run at once, naming the cause and the remedy', async () => {
  await f.admit({ recordTree: false });
  expect((await f.projection()).launch.setup.tree).toBeUndefined();
  await f.append(f.control, [{ type: 'control_intent', intent: { id: 'Activation', kind: 'resume', run: 'Run', unit: f.launch.unit,
    expectedCursor: (await f.projection()).cursor } }]);
  await f.releaseClaims();
  const services = runServices(f), original = services.workflowPorts, composed: string[] = [];
  services.workflowPorts = (...args) => {
    const ports = original(...args), native = ports.attempt;
    ports.attempt = async request => {
      if (request.stage.purpose !== 'gate') return native(request);
      composed.push(request.stage.id);
      const input = await composeInput(request, answerSchema(request.context), f.scope, config, await f.tree());
      if (input.ok) throw new Error('a gate with no recorded base must not be composed');
      return input;
    };
    return ports;
  };
  const result = await runUnitEntry(f.location, f.launch.unit, services, new AbortController().signal);
  expect(result).toMatchObject({ ok: false, kind: 'conflict' });
  const detail = (result as { detail: string }).detail;
  expect(detail).toMatch(/recorded no base tree at setup.*Resume the run with the runtime copy it was started with/);

  // One gate input was composed, one invocation was paid for it, and the run is parked with the refusal as its reason: no retry, no backstop.
  expect(composed).toEqual(['gate']);
  const events = get(await readEvents(f.journal, 0)).map(event => event.payload);
  expect(events.filter(payload => payload.type === 'invocation_reserved' && payload.invocation.address.kind === 'stage'
    && payload.invocation.address.stage === 'gate')).toHaveLength(1);
  const projection = await f.projection();
  expect(projection).toMatchObject({ status: 'parked', conclusion: { status: 'parked', reason: 'recovery_unknown' } });
  expect(projection.conclusion?.detail).toContain(detail);
  expect(get(readRunStatus(f.location)).attention?.detail).toContain(detail);
});
