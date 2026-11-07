import './test-support/policy-runtime.js';
import { describe, expect, it } from 'vitest';
import { renderPushEvent, type PushEvent } from '../src/session-push.js';

// Rebuilt from the stored 11/05 event and its structured request. Task title is
// the historical brief's heading; no title/target is extracted from event.detail.
export const historicalApproval: PushEvent = {
  version: 1,
  eventId: 'a036e19edae7fcc7cf8eb969d70dc1b9eb80199b65dd2b43a60cf7b41052455f',
  taskId: 2433, taskTitle: 'Decision graph: a declared graph whose next step is chosen at run time',
  runId: 'historical-run', launch: 1, attemptIndex: 1,
  kind: 'approval_parked', stageId: 'implement',
  createdAt: '2026-11-06T01:23:27.368Z', occurredAt: '2026-11-06T01:23:04.190Z',
  requestId: 'decision_graph_real_chooser_replays',
  requestTitle: 'Authorize eight one-shot real chooser replays',
  requestTarget: 'Configured Claude provider through the repository native ClaudeAdapter, using an isolated task-local provider context',
  target: { frontend: 'claude', sessionId: 'd9090818-02e5-4403-98c1-ae6e17f6fece', cwd: '/fixture/project', ledgerRoot: '/fixture/ledger' },
};
const root = '/fixture/fc';
const duties = ['This event is not acceptance.', 'Read the report and run state;',
  'For unfinished work or a failed attempt,', 'Deduplicate by event id:', 'Only after handling this event,'];
const historical = 'Status: complete. Last stage: review. Report: /fixture/fc/runs/run/summary.md';
const task = `FlowCrew #2433 ${historicalApproval.taskTitle}`;

describe('one structured push has separate human and agent renderings', () => {
  it.each([
    ['approval_parked', 'run event', historical],
    ['approval_attempt_suspended', 'run event', historical],
    ['attempt_failed', 'attempt failed', 'Stage: implement. Attempt: 1. Failure: provider_rate_limit.'],
    ['stage_failed', 'stage failed', 'Stage: implement. Attempt: 1. Failure: provider_rate_limit.'],
    ['run_status_changed', 'run status changed', 'Status: complete. Last stage: review. Report: /fixture/fc/runs/run/summary.md'],
    ['run_status_changed', 'run status changed', 'Status: running. Last stage: review. Report: /fixture/fc/runs/run/summary.md'],
    ['operator_wrap_up_required', 'wrap-up required', 'Status: complete. Last stage: review. Report: /fixture/fc/runs/run/summary.md'],
  ])('renders %s (%s; %s)', (kind, words, expected) => {
    const event = { ...historicalApproval, kind, failureIdentity: 'provider_rate_limit',
      runStatus: expected.startsWith('Status: running') ? 'running' : 'complete',
      lastStage: 'review', reportPath: '/fixture/fc/runs/run/summary.md' };
    const { human, agent } = renderPushEvent(event, root);
    expect(human).toBe(`${task}: ${words}. ${expected}`);
    expect(human).not.toMatch(/[a-f0-9]{64}/u);
    for (const value of ['see-run-state', 'see-task-state', '（本地记录）', '[redacted]', ...duties]) expect(human).not.toContain(value);
    expect(agent).toContain(`event=${event.eventId}`);
    for (const duty of duties) expect(agent).toContain(duty);
    expect(agent).toContain(`FC_HOME='/fixture/fc' flowcrew session-push ack --event ${event.eventId} --session 'd9090818-02e5-4403-98c1-ae6e17f6fece'`);
  });

  it('omits facts it does not know, including in the agent coordinates', () => {
    const event: PushEvent = { version: 1, eventId: 'b'.repeat(64), taskId: 1, taskTitle: 'Small task',
      runId: 'run', kind: 'operator_wrap_up_required', createdAt: '', occurredAt: '', target: historicalApproval.target };
    const result = renderPushEvent(event, root);
    expect(result.human).toBe('FlowCrew #1 Small task: wrap-up required.');
    expect(result.agent).not.toContain('see-');
    expect(result.agent).not.toContain('started=');
    expect(result.agent).not.toContain('attemptIndex=');
    expect(result.agent).not.toContain('launch=');
    expect(result.agent).not.toContain('stage=');
  });
});
