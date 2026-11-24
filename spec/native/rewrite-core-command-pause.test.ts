import { f, resetFixture, stage } from './fixtures/rewrite-core.js';
import { expect, it } from 'vitest';
import { runWorkflow } from '../../dist-rewrite/core/loop.js';
import type { CommandReceipt } from '../../dist-rewrite/contract/runtime.js';
import { commitCommand } from '../../dist-rewrite/records/state.js';
import { get } from '../fixtures/rewrite-state.js';
import { workflowFixture } from '../fixtures/rewrite-workflow.js';

// 'Measure' is declared with a dependency so its receipt stays valid while the tree is not touched; 'Late' has none.
const commands = [{ id: 'Measure', argv: ['fixture'], env: {}, inputs: [], required: false, dependsOn: ['src'] },
  { id: 'Late', argv: ['fixture'], env: {}, inputs: [], required: false }];
// Both commands run before a gate that is not the last one: the reuse rule must hold for a stage that is neither final nor required.
const graph = () => ({ stages: [stage('work'), { ...stage('progress', 'gate', ['work']), commands: ['Measure', 'Late'] }, stage('gate', 'gate', ['progress'])] });
/** A command phase in which `Late` ends in the way `ended` says; every other command passes. */
function drive(ended: (command: string) => Partial<CommandReceipt> | undefined) {
  const { ports, seen } = workflowFixture(f), ran: string[] = [];
  ports.command = async request => {
    ran.push(request.command.id);
    const base = { command: request.command.id, key: request.key, execution: { state: 'complete' as const, exit: 0 }, stdout: f.ref, stderr: f.ref,
      before: request.key.tree, after: request.key.tree, delta: f.ref, spent: { durationMs: 1 } };
    const { after: _a, delta: _d, ...unpinnedBase } = base;
    const change = ended(request.command.id);
    const receipt = (change && 'unpinned' in change ? { ...unpinnedBase, ...change } : { ...base, ...change }) as CommandReceipt;
    get(await commitCommand(f.execution, (await f.projection()).cursor, request.reservation, receipt));
    return { ok: true, value: receipt };
  };
  return { ports, seen, ran };
}
const run = (ports: ReturnType<typeof drive>['ports']) => runWorkflow({ writer: f.execution, scope: f.scope, ports, abort: new AbortController().signal });
const resume = async () => { const p = await f.projection();
  await f.append(f.control, [{ type: 'control_intent', intent: { id: 'Resume', kind: 'resume', run: 'Run', unit: f.launch.unit, expectedCursor: p.cursor } }]); };

// A declared output still changing after its command ended is that command's result: the run waits for an operator, keeps the
// receipt, and a resume runs only what lacks a passing receipt.
it('a command whose outputs could not be pinned parks the run at that command with the refusal, not as an unknown; resume runs only what has no passing receipt', async () => {
  await resetFixture({ commands }, graph());
  const first = drive(command => command === 'Late'
    ? { unpinned: { detail: 'Content changed during Git capture: /out/m01.json\n' } } : undefined);
  const parked = get(await run(first.ports));
  expect(parked).toMatchObject({ status: 'parked', reason: 'command_unfinished' });
  expect(parked.detail).toContain('Late ended (exit 0) but its outputs could not be pinned (Content changed during Git capture: /out/m01.json)');
  expect(first.ran).toEqual(['Measure', 'Late']);
  expect(first.seen.map(request => request.stage.id)).toEqual(['work']);   // no review of an unmeasured tree
  const p = await f.projection();
  expect(p.status).toBe('parked');
  expect(p.commands.map(command => command.command)).toEqual(['Measure', 'Late']);   // every reservation has its receipt
  expect(p.commands[1]).not.toHaveProperty('after');
  await resume();
  const second = drive(() => undefined);
  expect(get(await run(second.ports))).toMatchObject({ status: 'complete' });
  expect(second.ran).toEqual(['Late']);                       // Measure passed on unchanged inputs: not run again
});
