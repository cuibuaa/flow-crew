import type {RunStatusFile, RunStatus, StopReason} from '../../rewrite-src/contract/runtime.js';
export function wireStatus(run = 'RunOne', status: RunStatus = 'running', requester?: string): RunStatusFile {
  const reasons: Record<RunStatus,StopReason|null> = {preparing:null,refused:null,pending:null,running:null,parked:'attempt_failed',complete:'completed',
    accepted_blocked:'accepted_blocked',incomplete:'command_missing',failed:'gate_irreparable',escalated:'recovery_unknown',cancelled:'cancelled'};
  const stopReason = reasons[status];
  return {version:2,run,identity:{run,authority:'synthetic',runtime:{path:'runtime/.pin',sha256:'a'.repeat(64)}},
    ...(requester === undefined ? {} : {requester}), publishedAt:'2020-01-01T00:00:00.000Z',status,
    currentStage:status === 'running' ? 'WorkStage' : null,focus:['running','parked'].includes(status) ? 'WorkStage' : null,statusSince:3,journalCursor:7,stopReason,
    backstop:{rule:'C2',gateThreshold:3,failureThreshold:4,scope:'engine-outcomes',gateSuffix:0,failureSuffix:0,bestPassCount:null,
      segment:0,settlement:null,obligation:null,condition:null},step:{startedAt:null,elapsedMs:null},
    usage:{state:'unknown',raw:[],invocations:2,activeDurationMs:null},gates:[],
    attention:stopReason === null ? null : {reason:stopReason,detail:'Synthetic conclusion',condition:null},
    host:{readiness:'applied',interpretation:['Closure scope comes from the host receipt.']},
    notification:{session:requester === undefined ? 'unbound' : 'bound',
      scope:'persistent-status; optional bound-session wake',transport:'unobserved'}};
}
