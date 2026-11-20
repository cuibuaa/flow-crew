import { join } from 'node:path';
import type { RunServices } from '../../dist-rewrite/ops/run.js';
import { appendEvents, putEvidence, readEvents, recordOperation, storeEvidence } from '../../dist-rewrite/records/state.js';
import { readEvidence } from '../../dist-rewrite/records/evidence.js';
import { workflowFixture } from './rewrite-workflow.js';
import { get, type StateFixture } from './rewrite-state.js';
export function runServices(f: StateFixture): RunServices {
  return { configuration: f.configuration, unitContext: f.unitContext, configRoot: f.configRoot, privateEnvironment: { PATH: '/usr/bin' },
    process: writer => ({ streamRoot: writer.journal.root, scratch: join(f.root, 'tmp'),
     operation: request => recordOperation(writer.journal, 'construct', request), storeEvidence: source => storeEvidence(writer.journal,
     source), putEvidence: bytes => putEvidence(writer.journal, bytes), readEvidence: ref => readEvidence(writer.journal, ref),
     recordProcess: async (payload) => appendEvents(writer, get(await readEvents(writer.journal, 0)).length, [payload]) }),
    workflowPorts: () => workflowFixture(f).ports };
}
