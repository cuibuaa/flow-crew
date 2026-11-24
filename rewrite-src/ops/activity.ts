import { isDeepStrictEqual } from 'node:util';
import type { Journal, Writer, CommandActivity } from '../contract/runtime.js';
import { ActivityWindow, sampleActivity, type ExecutionActivity } from '../host/process.js';
import { readProjection, readCommandActivity, readExecutionActivity, insertAdvisoryActivity } from '../records/state.js';

/** One advisory write owner for both observers. A poll never changes the journal cursor. */
export function activityRecorder(journal: Journal) {
  return (activity: ExecutionActivity): void => {
    try {
      const previous=readExecutionActivity(journal,activity);
      if (!previous.ok) throw new Error(previous.detail);
      const facts=({notice:_notice,sample,...value}:ExecutionActivity) => ({...value,...(sample ? {sample:{value:sample.value,progressAt:sample.progressAt}} : {})});
      if (previous.value && isDeepStrictEqual(facts(previous.value),facts(activity))) return;
      const saved=insertAdvisoryActivity(journal,activity);
      if (!saved.ok) throw new Error(saved.detail);
    } catch (error) { process.stderr.write(`Activity observation ignored: ${String(error)}\n`); }
  };
}
/** Lives with the controller on its existing publication cadence. */
export function commandActivityObserver(writer: Writer) {
  const record=activityRecorder(writer.journal);
  let pending: Promise<readonly CommandActivity[]> | undefined;
  return (at: number): Promise<readonly CommandActivity[]> => {
    // Publication also happens after commits: share an in-flight observation rather than overlap it.
    if (pending) return pending;
    pending = (async () => {
      const observations: CommandActivity[] = [];
      const current = readCommandActivity(writer.journal); if (!current.ok) return observations;
      const { commands, owners } = current.value;
      for (const item of commands) {
        const owner = commands.length === 1 && owners.length === 1 ? owners[0] : undefined;
        const projection=await readProjection(writer.journal);
        if (!projection.ok) continue;
        const previous=item.execution;
        const window=new ActivityWindow(previous?.sample);
        const state = window.observe(at, owner ? await sampleActivity(owner) : null);
        // The command may have closed while native observations were in flight.
        const fresh = readCommandActivity(writer.journal);
        if (!fresh.ok) return observations;
        const active = fresh.value.commands.find(command => command.identity === item.identity);
        const currentOwner = fresh.value.owners.find(candidate => candidate.authority === owner?.authority);
        if (active && currentOwner) {
          const declaration=projection.value.brief.declaration.commands.find(command=>command.id === item.reservation.identity);
          const activity:ExecutionActivity={invocation:item.reservation.invocation,source:'command',command:item.reservation.identity,stage:active.activity.stage,state:'current',
            lastEventAt:window.sample?.value.lastEventAt ?? previous?.lastEventAt ?? null,
            lastTool:declaration?.argv[0] ?? null,summary:`command ${item.reservation.identity}`,toolRunning:true,observation:state,...(window.sample ? {sample:window.sample} : {})};
          record(activity);
          const saved=readCommandActivity(writer.journal);
          const row=saved.ok ? saved.value.commands.find(command=>command.identity === item.identity)?.activity : undefined;
          if (row) observations.push(row);
        }
      }
      return observations;
    })().catch(() => [] as readonly CommandActivity[])
      .finally(() => { pending = undefined; });
    return pending;
  };
}
