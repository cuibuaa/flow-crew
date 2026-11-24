// All compatibility retirement belongs here; decoders retain their own live-field validation.
// A recorded plan, the stage definitions the stored timeline copied from it, a planner answer kept in a receipt, and a replacement plan carried by a recorded guide are read from history (the `recorded*` scopes, reached only from `journalPayload` and `projection`), where a gate once carried a planner-written instruction (`gateFields`). Every scope a write validator uses (`plan`, `attempt`, `commandReceipt`, `stageAnswer`) is strict, so a new write with the key is refused, not ignored.
const inventory = {
  journalPayload: { fields: [], children: { launch: 'launch', plan: 'admittedPlan', checkpoint: 'checkpoint',
    receipt: 'recordedReceipt', reservation: 'reservation', measured: 'setupEvidence', intent: 'intent', operation: 'operation' } },
  projection: { fields: [], children: { launch: 'launch', plan: 'admittedPlan', revisions: 'admittedPlan',
    received: 'recordedAttempt', attempts: 'recordedAttempt', commands: 'commandReceipt', reservations: 'reservation',
    checkpoints: 'checkpoint', lineage: 'lineage', timeline: 'timeline', intents: 'intent', operations: 'operation' } },
  launch: { fields: [], children: { plan: 'recordedPlan', setup: 'setupEvidence' } },
  admittedPlan: { fields: [], children: { plan: 'recordedPlan' } },
  reservation: { fields: [], children: { key: 'commandKey', receipt: 'commandReceipt' } },
  intent: { fields: [], children: { intervention: 'intervention' } },
  intervention: { fields: [], children: { replacement: 'recordedRevision' } },
  recordedRevision: { fields: [], children: { plan: 'recordedPlan' } },
  operation: { fields: [], children: { intent: 'intent' } },
  timeline: { fields: [], children: { stages: 'stageHistory' } },
  stageHistory: { fields: [], children: { definition: 'recordedStage' } },
  lineage: { fields: [], children: { receipt: 'commandReceipt', checkpoint: 'checkpoint' } },
  plan: { fields: ['observations'], children: { stages: 'stage' } },
  recordedPlan: { fields: ['observations'], children: { stages: 'recordedStage' } },
  stage: { fields: ['skills'] },
  recordedStage: { fields: ['skills'], gateFields: ['instruction'] },
  attempt: { fields: [], children: { answer: 'stageAnswer' } },
  recordedAttempt: { fields: [], children: { answer: 'recordedStageAnswer' } },
  stageAnswer: { fields: [], children: { answer: 'answer' } },
  answer: { fields: ['observations'], children: { plan: 'plan' } },
  recordedStageAnswer: { fields: [], children: { answer: 'recordedAnswer' } },
  recordedAnswer: { fields: ['observations'], children: { plan: 'recordedPlan' } },
  commandKey: { fields: ['observation'] },
  commandReceipt: { fields: ['observed'], children: { key: 'commandKey', answer: 'stageAnswer' } },
  recordedReceipt: { fields: ['observed'], children: { key: 'commandKey', answer: 'recordedStageAnswer' } },
  checkpoint: { fields: ['observed'] },
  brief: { fields: ['bounds'], children: { commands: 'command' } },
  command: { fields: ['unconfined'] },
  config: { fields: ['bounds', 'adapterInputLimitChars', 'sharedCaches', 'devices', 'providerHomes'] },
  owner: { fields: ['unconfined'] },
  processReceipt: { fields: ['grant'], children: { owner: 'owner' } },
  setupEvidence: { fields: ['nativeGrant'], children: { commands: 'commandReceipt' } },
  authority: { fields: ['purposes', 'providers', 'aliases'], children: { commands: 'commandContext', outputs: 'output' } },
  commandContext: { fields: ['grant'] },
  output: { fields: ['provision', 'mutation'] },
};
/** Discard retired keys without interpreting their values; unknown keys reach the receiving schema.
 * @param {unknown} value @param {keyof typeof inventory} scope @param {(line:string)=>void} [advisory]
 * @returns {any}
 */
export function ignoreRetired(value, scope, advisory) {
  /** @type {string[]} */
  const removed = [];
  /** @param {any} value @param {keyof typeof inventory} scope @param {string} prefix @returns {any} */
  const visit = (value, scope, prefix) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const entry = inventory[scope];
    const gateFields = /** @type {readonly string[]} */ ('gateFields' in entry && value.purpose === 'gate' ? entry.gateFields : []);
    return Object.fromEntries(Object.entries(value).flatMap(([key, value]) => {
      if (entry.fields.some(field => field === key) || gateFields.includes(key)) { removed.push(prefix + key); return []; }
      const children = /** @type {Record<string,keyof typeof inventory>} */ ('children' in entry ? entry.children : {});
      const child = Object.hasOwn(children, key) ? children[key] : undefined;
      if (child) value = Array.isArray(value) ? value.map((item, index) => visit(item, child, `${prefix}${key}[${index}].`))
        : visit(value, child, `${prefix}${key}.`);
      return [[key, value]];
    }));
  };
  const result = visit(value, scope, '');
  if (removed.length) advisory?.(`${removed.join(', ')}: retired and ignored; all authors/providers/commands run with host-account rights; these keys constrain nothing.`);
  return result;
}
