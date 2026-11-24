// Compile-only witness: none of the skeleton functions below is executed.
import type { Invocation, InvocationSite, RunLocation, SetupRequest, RunRef, Writer } from '../../rewrite-src/contract/runtime.js';
import type { ProcessPorts, ProcessPortsFactory } from '../../rewrite-src/host/process.js';
import { claim } from '../../rewrite-src/records/state.js';
import { openJournal, openWriter } from '../../rewrite-src/records/state.js';
import type { SetupContext } from '../../rewrite-src/ops/setup.js';
import type { RunServices } from '../../rewrite-src/ops/run.js';
import type { WorkflowPorts } from '../../rewrite-src/core/loop.js';
import type { InvocationRequest } from '../../rewrite-src/core/retry.js';
import type { TransportContext } from '../../rewrite-src/exec/transport.js';
import type { ContentScope } from '../../rewrite-src/records/content.js';
async function bindAfterClaim(location: RunLocation, unit: RunRef, factory: ProcessPortsFactory) {
  const owned = await claim(location.storeRoot + '/runs/' + location.run + '/execution', unit, { database: location.database,
   holder: location.storeRoot + '/runs/' + location.run });
  if (!owned.ok)
    return owned;
  const journal = await openJournal(location, 'create');
  if (!journal.ok)
    return journal;
  const writer = await openWriter(journal.value, owned.value, 'execution');
  if (!writer.ok)
    return writer;
  const process: ProcessPorts = factory(writer.value);
  return process;
}
function composeSetup(location: RunLocation, unit: RunRef, services: RunServices, briefBytes: Uint8Array,
 backend: SetupContext['backend']): SetupContext {
  return { briefBytes, backend, location, unit, configRoot: services.configRoot, configuration: services.configuration, environment: services.privateEnvironment };
}
function boundConsumers(writer: Writer, scope: ContentScope, services: RunServices, abort: AbortSignal) {
  const process = services.process(writer);
  const transport: TransportContext = { journal: writer.journal, process, privateEnvironment: services.privateEnvironment };
  const workflow = services.workflowPorts(scope, writer, process, abort);
  const publish: WorkflowPorts['publishStatus'] = workflow.publishStatus;
  const unknownElapsed: Parameters<typeof publish>[1] = null;
  return { transport, workflow, unknownElapsed };
}
function closedAddresses(run: RunLocation['run'], attempt: {
  stage: string;
  attempt: string;
  invocation: number;
}) {
  const stage: InvocationSite = { kind: 'stage', run, ...attempt };
  const setup: InvocationSite = { kind: 'setup', run };
  const final: InvocationSite = { kind: 'final', run };
  const timing = { activeInterval: 'interval' };
  const command = { id: 'check', key: { tree: 'a', declaration: 'b', inputHashes: [], context: 'c' } };
  const valid: InvocationRequest[] = [
    { ...timing, address: stage, charge: 'work' },
    ...[stage, setup, final].map(address => ({ ...timing, address, charge: 'command' as const, command })),
  ];
  // @ts-expect-error Model actions always belong to a real stage invocation.
  const invalidModel: InvocationRequest = { ...timing, address: setup, charge: 'work' };
  // @ts-expect-error A fourth invocation site is forbidden.
  const extraSite: InvocationSite = { kind: 'baseline', run };
  // @ts-expect-error Stage provenance is complete rather than an invented stage ID.
  const missingInvocation: InvocationSite = { kind: 'stage', run, stage: 'work' };
  // @ts-expect-error Non-stage sites cannot smuggle stage provenance.
  const fakeStage: InvocationSite = { kind: 'setup', run, stage: 'baseline' };
  // @ts-expect-error The durable invocation has the same restriction as the request.
  const invalidLease: Invocation = { charge: 'plan', address: final };
  return { valid, invalidModel, extraSite, missingInvocation, fakeStage, invalidLease };
}
function forbidPrematureBinding(bound: ProcessPorts, context: SetupContext, request: SetupRequest) {
  // @ts-expect-error A caller cannot provide a recorder bound to a nonexistent setup journal.
  const factory: ProcessPortsFactory = bound;
  const { configuration, ...missingAuthority } = context;
  // @ts-expect-error Setup receives explicit config to decide admission on the copy.
  const invalidContext: SetupContext = missingAuthority;
  const { configRoot, ...missingRoot } = context;
  // @ts-expect-error Setup cannot discover the configuration root.
  const invalidRoot: SetupContext = missingRoot;
  const { briefBytes, ...missingBytes } = context;
  // @ts-expect-error Setup cannot reconstruct exact approved bytes from parsed text.
  const invalidBytes: SetupContext = missingBytes;
  return { factory, invalidContext, invalidRoot, invalidBytes, configRoot, briefBytes, configuration, request };
}
void [bindAfterClaim, composeSetup, boundConsumers, closedAddresses, forbidPrematureBinding];
