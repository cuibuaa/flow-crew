/** The live plan's repair contract. Admission, generated schema and prompt share this owner. */
import type { Schema } from './reality-gate/checks/json-schema-match.js';
import type { StageConfig } from './scheduler/sched_admission/configuration.js';
import type { DispatchAdmissionError } from './scheduler/sched_admission/dispatch.js';

export const REPAIR_TOPOLOGY_SCHEMA: Schema = { anyOf: [
  { properties: { is_gate: { enum: [false] } } },
  { required: ['is_gate'], properties: { is_gate: { enum: [true] }, retry_to: { maxItems: 0 } } },
] };

export const REPAIR_TOPOLOGY_CONTRACT = 'Declare authors and independent gates. For engineering, a gate with exactly one direct ordinary author dependency and no other reviewed author ancestors before the nearest gates gets an engine-derived repair with that author\'s role, scope, skills, instructions and artifact contract, and both stages\' criterion obligations. Neither stage may have a condition, decision or dynamic dispatch; the author cannot itself be a repair. Dynamic planner ancestors do not count as authors. Otherwise declare an ordinary repair with depends_on and retry_to naming its gate. Explicit repairs are preserved; research gets no derived repair. Gates cannot declare retry_to. Repair rounds use the existing gate_retry_loops bound.';

export const REPAIR_TOPOLOGY_EXAMPLE = { stages: [
  { id: 'author', role: 'coder' },
  { id: 'review', role: 'qa', depends_on: ['author'], is_gate: true },
] };

/** The authors whose results a gate reviews: its non-gate ancestors up to the nearest gates, which review the rest. */
export function gateReviewedAuthorIds(gate: StageConfig, allStages: StageConfig[]): string[] {
  const byId = new Map(allStages.map(stage => [stage.id, stage]));
  const reviewed = new Set<string>();
  const queue = [...(gate.depends_on ?? [])];
  while (queue.length > 0) {
    const stage = byId.get(queue.shift()!);
    if (!stage || stage.is_gate || reviewed.has(stage.id)) continue;
    reviewed.add(stage.id);
    queue.push(...(stage.depends_on ?? []));
  }
  return [...reviewed];
}

/** Mutate only the proposed graph, before graph/authority/coverage admission. Idempotent on admitted plans. */
export function admitRepairTopology(dispatched: StageConfig[], baseStages: StageConfig[], research = false): DispatchAdmissionError[] {
  const all = [...baseStages, ...dispatched];
  const byId = new Map(all.map(stage => [stage.id, stage]));
  const errors: DispatchAdmissionError[] = [];
  const ordinary = (stage: StageConfig) => !stage.is_gate && !stage.dynamic_dispatch;
  const unconditional = (stage: StageConfig) => !stage.condition?.trim() && !stage.decision && !stage.dynamic_dispatch;
  for (const gate of dispatched.filter(stage => stage.is_gate)) {
    const reject = (message: string) => errors.push({ code: 'stage_retry_to', stageId: gate.id, field: 'retry_to', message });
    if (gate.retry_to?.length) {
      reject(`${gate.id}: gate stages cannot declare retry_to; declare author dependencies on the gate, or an ordinary repair with depends_on and retry_to naming the gate.`);
      continue;
    }
    if (research) continue;
    const declared = all.filter(stage => stage.retry_to?.includes(gate.id));
    const direct = gate.depends_on.filter(id => !byId.get(id)?.is_gate);
    const author = direct.length === 1 ? byId.get(direct[0]) : undefined;
    const authors = gateReviewedAuthorIds(gate, all).filter(id => !byId.get(id)!.dynamic_dispatch);
    if (!declared.length && authors.length === 1 && unconditional(gate) && author && ordinary(author) && unconditional(author) && !author.retry_to?.length) {
      const stem = `repair_${gate.id}`.slice(0, 64);
      let id = stem;
      for (let index = 1; byId.has(id); index++) {
        const suffix = `_${index}`;
        id = stem.slice(0, 64 - suffix.length) + suffix;
      }
      const repair: StageConfig = {
        ...structuredClone(author), id, depends_on: [gate.id], retry_to: [gate.id],
        dependency_reasons: undefined,
        criterion_refs: [...new Set([...author.criterion_refs, ...gate.criterion_refs])],
      };
      dispatched.push(repair);
      all.push(repair);
      byId.set(id, repair);
    } else if (!declared.some(ordinary)) {
      reject(`${gate.id}: missing repair route; derivation requires exactly one direct unconditional ordinary author, no other reviewed authors, and an unconditional gate. Otherwise declare an ordinary repair with retry_to: [${gate.id}], depends_on: [${gate.id}].`);
    }
  }
  return errors;
}
