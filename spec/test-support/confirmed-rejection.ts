import { GATE_OUTCOMES } from '../../src/scoped-audit-repair.js';
import type { Adapter } from '../../src/adapters/base.js';

/** Translate a historical fixture's own boolean answer to the current wire contract. */
export function currentGateAnswer(record: Record<string, any>): Record<string, any> {
  if (typeof record.pass !== 'boolean' || GATE_OUTCOMES.includes(record.outcome)) return record;
  const { pass, repairability, outcome: _legacyOutcome, ...answer } = record;
  return { ...answer, outcome: pass ? 'accepted'
    : repairability?.disposition === 'irreparable' ? 'rejected_irreparable' : 'rejected_repairable' };
}
export function currentGateAnswers(adapter: Adapter): Adapter {
  return { ...adapter, async run(prompt, role, opts) {
    const result = await adapter.run(prompt, role, opts);
    let record: Record<string, any>;
    try { record = JSON.parse(result.output); } catch { return result; }
    const answer = currentGateAnswer(record);
    return answer === record ? result : { ...result, output: JSON.stringify(answer) };
  } };
}

/** Existing synthetic scheduler scenarios explicitly opt into a fixture defect. */
export function withConfirmedRejections(adapter: Adapter, _timeoutMs?: number): Adapter {
  return currentGateAnswers({ ...adapter, async run(prompt, role, opts) {
    const result = await adapter.run(prompt, role, opts);
    let record: Record<string, any>;
    try { record = JSON.parse(result.output); } catch { return result; }
    if (record.pass !== false || record.audit_findings?.findings?.length) return result;
    record.audit_findings = { version: 1, findings: [{ id: 'fixture_defect', class: 'regression', paths: ['fixture'],
      reason: 'Scripted fixture defect.', criterion_ids: [], invalidates_plan: false, repair_role: 'coder' }] };
    return { ...result, output: JSON.stringify(record) };
  } });
}
