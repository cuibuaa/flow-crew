# Single author stages and retained budget handoffs

## 1. Removal, compatibility surface and size

Every new authoring stage has one author. An explicit structured `race` request is refused before unknown fields can be stripped, including nested fixed dispatch and direct scheduler admission. This prevents an old workflow from silently losing its intended execution model. Brief prose/frontmatter is accepted with a visible single-author notice in the invocation and an `execution_notice` record; prose has no reliable executable schema to reject selectively.

The comparison for removal is the starting main revision `10b844b61dc0a15ac8840f32c3ba386bf547770b`. The separately verified deployed runtime is used for upgrade and workload comparisons below. Counts include new specs and this report; binary deletion is separate. The final per-file counts and refreshed search inventory are in run-relative `stages/prove_and_report/evidence/change-numstat.tsv` and `line-counts.json`.

**Final text delta: +1762 / −3098; net -1336 lines (1336 net lines removed), across 76 changed files. Core source: +336 / −513, net -177. Specs: +1070 / −2343, net -1273. The PNG deletion is binary and excluded from text arithmetic.**

| Former location | Disposition |
|---|---|
| `src/race.ts` | Removed candidate selection, ordered competition and its public primitive. |
| `src/scheduler/sched_loop/stage-race.ts` | Removed candidate worktrees, child workflows, gated fallback, patch promotion and production of new competition records. |
| `src/scheduler/sched_loop/ordinary-stage.ts` | Removed competition routing; one ordinary adapter path remains. |
| `src/scheduler/sched_admission/configuration.ts` | Removed live fields and competition topology helpers. Refuse explicit requests. Separate recorded schemas retain historical markers. |
| `src/scheduler/sched_admission/dispatch.ts` | Removed competition admission. Explicit historical loading preserves archived workflows. Live dispatch uses refusal. |
| `src/plan-interface.ts` | Removed generation schema field and instructions. Only the recorded plan schema accepts historical fields. |
| `src/adapters/base.ts`, `src/scheduler/sched_loop/stage-batch.ts` | Removed new winner/gate projection production and `acceptedGates`. |
| `src/cli.ts`, `src/scheduler/sched_loop/launch.ts` | New launches refuse retired fields; continuation reads the archived contract. |
| `src/engine-continuation.ts`, `src/restart-recovery.ts` | Historical validation retains original plan digests and ownership evidence. Unknown consumers still cause safe refusal. |
| `src/plan-revisions.ts`, `src/store.ts` | Recorded types preserve immutable historical plans and accepted provenance. No candidate execution. |
| `src/worker.ts` | Names retained historical records/patches to the continuing author. No automatic selection or application. |
| `src/scheduler/sched_settlement/gate-verdict.ts` | Reads old `acceptedFrom` provenance; unfinished current slices cannot publish acceptance. |
| `config/agents/planner.yaml` | Removed all selection, competition and cost instructions. |
| `README.md`, `assets/architecture.svg`, `assets/architecture.png` | Removed advertising and obsolete diagrams; README uses Mermaid. Asset deletion was admitted in the implementation stage. |
| `guide/agent-protocol.md`, `guide/cli.md` | Removed live protocol/command documentation. Explain new admission and historical reading. |
| `guide/architecture.md`, `guide/configuration.md`, `guide/operations.md`, `config/defaults.yaml` | Document retained slices, clock meanings and settlement. Numeric defaults are unchanged. |
| `CHANGELOG.md` | Removed old feature advertising; records the replacement behavior. |
| `spec/planner-output-contract.test.ts` | Obsolete consumed-field expectations became explicit refusal tests. |
| `spec/race-legacy-ownership.test.ts` | Retained unknown-consumer, prior-boot and owned-consumer safety coverage with recorded schemas. |
| `spec/single-author-legacy.test.ts` | New refusal, generation/implementation absence, visible notice, serialized legacy continuation and public CLI continuation coverage. |
| `spec/stage-budget.test.ts` | Native delivery on both adapters; retention, closure, refusal/cancellation priority, gate boundaries, finite continuation, DAG/scope retention and timing. |
| `spec/continue-legacy-cancel.test.ts`, `spec/deployment-hold-history.test.ts` | Existing malformed/unknown-consumer refusal coverage remains. |
| `skills/`, `examples/`, `ui/src/`, other config/scripts/docs | Inspected; no live stage-competition field or instructions remain. Research candidates, ordinary concurrency races and historical artifact display have separate owners. |

Removed exclusively executable competition specs: `planner-race`, `race-artifact-inputs`, `race-artifact-links`, `race-duration`, `race-gate-fallback`, `race-git-failure`, `race-git-history`, `race-lifecycle-regressions`, `race-retry-inputs`, `race-symlink-paths`, `race-workflow-defaults`, `race-workflow`, `race`, and `stage-race-boundaries` (all under `spec/`, with `.test.ts` suffix). Their obsolete selection/worktree behavior was removed with its owner. General scope, artifact, Git, process and gate safety remain covered elsewhere.

Deadline/history/provider specs now expect retained normal slices instead of kill/failure/retry growth. The full suite also required changes to acceptance-audit, attempt-attribution, execution-default-source, negotiation, reevaluation-fix, research-generation, stage-record-correction and supervisor-abort-attribution expectations. They retain rejection history, usage, scope revalidation, legacy timeout recovery, exact deadline and cleanup assertions. Non-timing measurement fixtures use a budget with room for startup. Adapter allocations are checked against the authoritative nominal ledger and remaining time. New slices spend a second finite iteration at the same nominal budget. Low-level technical timeout growth remains tested for historical recovery. The parallel scope test retains overlap/restoration/attribution assertions using monotonic time because a wall-clock reversal invalidated its old measurement. The status-literal guard also caught two new comparisons, now using the existing constant.

The private incident input was read without copying its identifying text into public changes.

## 2. Delivery, retained inputs and all time bounds

The following dependencies were identified before relying on the constraints:

| Quantity/constraint | Unstated dependency and consequence |
|---|---|
| Trial timings | Responsive scheduling, bounded child retirement and deterministic local progress; measures engine control, not provider throughput. |
| Comparable benefit/cost | Same workload, budget, role/scope topology and validation recipe on deployed and candidate code; extra native turns are a real cost. |
| Both adapters | Actual native stdin must contain the instruction; an engine event alone is insufficient. Session support depends on captured same-attempt identity. |
| Deployed identity | Checkout HEAD can differ from deployed bytes. Manifest members and matching historical source must be verified. |
| Legacy fixtures | A positive recorded checkpoint needs known consumers. Synthetic old unsafe records cannot establish recoverability. |
| Isolation/storage | Source, writable dependencies, compiler outputs, caches and trial state are private. Suite scratch uses the configured command owner and its cleanup, because Unix sockets need short physical paths. |
| CPU/process ownership | Affinity must survive harness repinning and child launches; signals need the invocation marker and matching Linux start token. |
| Privacy | Original records stay private. Public examples use aliases and relative evidence names. Empty provider homes avoid credentials. |
| Validation totals | Depend on root/UI/UX inclusion and installed lockfile dependencies, not a selected test list. CI platform and image prerequisites are checked separately. |

For nominal stage budget **B**, finishing allocation **W = min(300000, max(1, floor(B/10))) ms**. Warning is due at `max(0, B − W − 5500)`; immutable hard limit is `max(B, W + 5500)`. The 5.5 seconds reserve covers the existing five-second TERM→KILL retirement and close observation. Under responsive scheduling and verified bounded retirement, W remains for finishing after retirement. Native delivery receipts record the actual remaining time. Starved scheduling or unverified closure is recorded honestly; it is not proof of delivery.

Default B remains three hours: warning at 2h54m54.5s, W five minutes, hard stop at three hours. A 20-second trial allocates W two seconds, warning at 12.5 seconds and hard stop at 20 seconds. Very short budgets warn immediately and have the explicit minimum hard limit above. No numeric default changed: `default_timeout_ms` now bounds a retained execution slice; `default_stage_idle_timeout_ms` still means observed silence; `default_validation_timeout_ms` still bounds each configured validation command.

The worker writes an attempt-bound scheduler guidance envelope, retires the current owned child through the existing control boundary, then reinvokes its production adapter with the wrap-up message and full duties. Codex receives stdin through `execWithStdin` (`codex exec`, or an attested same-attempt resume); Claude receives stdin through its native stream protocol with its system-prompt file. Missing/stale native sessions use the full current duties and file evidence. Both adapters are exercised through deterministic local native-protocol children. No live provider was contacted; CLI/provider version compatibility and real provider speed are outside this measurement.

The instruction says to stop new work, keep admitted files, return the normal structured result and name done/remaining duties. Cooperative JSON remains authored. Forced stop produces a typed engine retention handoff without inventing checks or gate acceptance. The next iteration receives the same project files, `stages/<stage>/output_attempt_N.md`, the prior execution log, attributed writes and a separate engine retention summary. Old budget notices are filtered out. Completed predecessors and the active admitted DAG survive; unfinished slices and consumers reopen. Retired dynamic plans stay history. No cross-stage session reuse is required.

| Limit / precedence | Outcome |
|---|---|
| Explicit command timeout / worker projection | Can bind before warning; commands exceeding the remaining execution allowance are interrupted through existing guidance. No clock extension. |
| Idle silence (default ten minutes; watchdog observes every 30 seconds) | Genuine lack of output/artifact/CPU/I/O/socket progress causes the existing attempt-bound abort, with one-second worker fallback. Warning does not reset progress. Idle remains a failure/abort. |
| Warning point above | Persistent finishing notice; retire current child and deliver a finishing turn. It does not renew the hard deadline. |
| Adapter timeout / retries / correction / backoff | Receive remaining hard time; parameter repair and 30/60/120-second backoff share the same owner. No retry or correction can renew it. |
| Hard limit above | TERM then bounded five-second escalation; closure observation has the 0.5-second cushion. Verified forced work is retained with exit 0 plus unfinished continuation. No closure certificate means refusal 125. |
| Parent/supervisor abort; engine/scope/monitor refusal | Remain authoritative over budget success. They cannot become a successful retained slice. |
| Claude post-result cleanup | Existing five-second cleanup remains bounded by the active execution/child retirement controls. |
| Post-author gate/check time | Competition no longer nests a gate behind an author on its clock. Independent gate stages get their own fresh budget. Configured pre-review commands share that gate clock; post-author validation has its own command bound. Partial gates cannot run post-author validation or publish acceptance. |
| Validation command (default 45 minutes) | Capped by an enclosing gate's remaining time/abort when present. Reaching it records validation failure/refusal; it never certifies acceptance. |
| Write monitor (30-second reconciliation; ten-minute scan deadline) | Independent integrity bound; failed monitoring or failed restoration refuses continuation. |
| Workflow iterations (default five) | Each retained slice spends an iteration. Cancel/resume cannot recycle a spent slice. Exhaustion is `incomplete`, files kept. |
| Repair rounds (default three), planner admission retries (two), technical retries (one) | Existing finite bounds remain. New budget continuation does not grow clocks; historical technical-timeout recovery keeps its old evidence and rules. |
| Research run wall ceiling, when configured | Prevents another retained slice at the boundary; it is not a universal mid-command interrupt. An engineering workflow has the iteration bound rather than a new global wall timer. |
| External command/invocation deadlines | Trials and checks have their own shorter timeout; this stage's immutable invocation deadline remains outside engine policy. |

The first applicable earlier limit wins. Idle is earlier in the hung trials; the hard limit is earlier in the active-ignore trials. Timer/closure/refusal priority and research wall exhaustion also have deterministic regression and mutation coverage. Duration telemetry now counts each invocation once when a later turn is cancelled; monotonic `timeout.elapsedMs`, not summed provider durations, establishes the stage time bound.

## 3. Private daemon proofs and comparable workload

All evidence names below are relative to `stages/prove_and_report/`. `evidence/*.json` preserves exact private argv, direct exits, source identity, timing and original receipt roots. The public excerpts use run aliases and relative time from the work attempt. Original records remain under `build/trials/`.

The installed `~/bin/fc-trial` was read and preserved as `build/fc-trial.original.cjs`; its digest is in `evidence/harness-original.json`. Its defaults conflict with this task: cores 6–15, shared receipt storage, Claude-only fixture with an explicit Codex refusal, no progress/hang/budget controls, and same-source redeploy. `build/fc-trial.cjs` is a task-local CommonJS adaptation; `evidence/fc-trial.patch` includes the exact changes and native child fixture. It retains lifecycle/RPC, command receipts, restoration and marker/start-token ownership machinery; process-environment inspection is restricted to descendants and previously attested owned identities. Storage is canonicalized beneath the stage build root; a short admitted scratch alias is used for socket spelling. Configuration fixtures are applied only to private engine copies and restored. Root/UI dependencies and caches are private.

Builds, tests, lint, mutations and daemon trials run at `taskset -c 6-11 nice -n 19` with command deadlines. The first validation snapshot copy omitted that prefix; it only copied files. Suite scratch is allocated/retired by the existing configured global setup; manually forcing its physical storage under a long trial root caused socket failures, retained in the exploratory receipt. Docker validation uses the existing isolation recipe and a locally present image without network. The harness does not operate the operator daemon or any pre-existing run.

| Trial alias | Native receipt of wrap-up (ms) | First child closed (ms) | Settled result / retained work |
|---|---:|---:|---|
| cooperate-claude | 12782 | 12888 | budget_wrap_up; exit 0; unit 1 + unit 2 after continuation |
| cooperate-codex | 12803 | 12849 | budget_wrap_up; exit 0; unit 1 + unit 2 after continuation |
| ignore-claude | 12710 | 20056 | budget_forced_stop; exit 0; unit 1 + unit 2 after continuation |
| ignore-codex | 12830 | 20072 | budget_forced_stop; exit 0; unit 1 + unit 2 after continuation |
| hang-claude | none | 59204 | stage_abort; exit 137; unit 1 retained |
| hang-codex | none | 58792 | stage_abort; exit 137; unit 1 retained |

All four cooperative/forced trials consumed byte-identical prior output handoffs and `unit 1\n`, then produced `unit 1\nunit 2\n` in iteration 2. The independent gate retained its full 20,000 ms nominal budget; configured checks ran for 1,505–1,512 ms after unit 2 existed. The hung cases have a 120,000 ms budget, a 102,500 ms warning point, a 10,000 ms idle threshold and the unchanged 30-second observation cadence. Both idle aborts arrived around 59 seconds, with no wrap-up delivery. All eight trial cleanup receipts have zero remaining owned processes.

Sanitized record projections (relative observed timestamps; monotonic `timeout.elapsedMs` establishes bounds):

```jsonl
{"alias":"cooperate-claude","source":"events.jsonl","type":"stage_wrap_up_requested","t_ms":12503,"stage":"work","attempt":1,"finishing_ms":2000}
{"alias":"cooperate-claude","source":"native invocations.jsonl","stage":"work","provider":"claude","wrap":true,"input_excerpt":"# Stage budget wrap-up\nTime is nearly up. Stop starting new work. Keep all admitted files. Finish safely and return your normal result with a concrete done/remaining handoff: what changed, evidence, unfinished duties and the next bounded action. Do not claim unfinished work or unrun checks passed. The next iteration continues these files."}
{"alias":"cooperate-claude","source":"stages/work/status.json","status":"complete","exitCode":0,"processSignal":null,"terminationCause":"budget_wrap_up","elapsedMs":12952,"childClosedAfterMs":12888,"forced":false}
{"alias":"cooperate-codex","source":"events.jsonl","type":"stage_wrap_up_requested","t_ms":12502,"stage":"work","attempt":1,"finishing_ms":2000}
{"alias":"cooperate-codex","source":"native invocations.jsonl","stage":"work","provider":"codex","wrap":true,"input_excerpt":"# Stage budget wrap-up\nTime is nearly up. Stop starting new work. Keep all admitted files. Finish safely and return your normal result with a concrete done/remaining handoff: what changed, evidence, unfinished duties and the next bounded action. Do not claim unfinished work or unrun checks passed. The next iteration continues these files."}
{"alias":"cooperate-codex","source":"stages/work/status.json","status":"complete","exitCode":0,"processSignal":null,"terminationCause":"budget_wrap_up","elapsedMs":12879,"childClosedAfterMs":12849,"forced":false}
{"alias":"ignore-claude","source":"events.jsonl","type":"stage_wrap_up_requested","t_ms":12502,"stage":"work","attempt":1,"finishing_ms":2000}
{"alias":"ignore-claude","source":"native invocations.jsonl","stage":"work","provider":"claude","wrap":true,"input_excerpt":"# Stage budget wrap-up\nTime is nearly up. Stop starting new work. Keep all admitted files. Finish safely and return your normal result with a concrete done/remaining handoff: what changed, evidence, unfinished duties and the next bounded action. Do not claim unfinished work or unrun checks passed. The next iteration continues these files."}
{"alias":"ignore-claude","source":"stages/work/status.json","status":"complete","exitCode":0,"processSignal":"SIGTERM","terminationCause":"budget_forced_stop","elapsedMs":20076,"childClosedAfterMs":20056,"forced":true}
{"alias":"ignore-codex","source":"events.jsonl","type":"stage_wrap_up_requested","t_ms":12502,"stage":"work","attempt":1,"finishing_ms":2000}
{"alias":"ignore-codex","source":"native invocations.jsonl","stage":"work","provider":"codex","wrap":true,"input_excerpt":"# Stage budget wrap-up\nTime is nearly up. Stop starting new work. Keep all admitted files. Finish safely and return your normal result with a concrete done/remaining handoff: what changed, evidence, unfinished duties and the next bounded action. Do not claim unfinished work or unrun checks passed. The next iteration continues these files."}
{"alias":"ignore-codex","source":"stages/work/status.json","status":"complete","exitCode":0,"processSignal":"SIGTERM","terminationCause":"budget_forced_stop","elapsedMs":20119,"childClosedAfterMs":20072,"forced":true}
{"alias":"hang-claude","source":"stage error and status","error":"aborted by engine: Watchdog ABORT verified for work attempt 1: no verified live/artifact/process progress for 30058ms (threshold 10000ms); active attempt 1; no verdict observed; no final output observed; no handoff observed; no current-attempt commit observed","status":"failed","exitCode":137,"terminationCause":"stage_abort","elapsedMs":59237,"remainingMs":60762}
{"alias":"hang-codex","source":"stage error and status","error":"aborted by engine: Watchdog ABORT verified for work attempt 1: no verified live/artifact/process progress for 30658ms (threshold 10000ms); active attempt 1; no verdict observed; no final output observed; no handoff observed; no current-attempt commit observed","status":"failed","exitCode":137,"terminationCause":"stage_abort","elapsedMs":59420,"remainingMs":60580}
{"alias":"repeat","source":"events.jsonl","type":"run_completed","t_ms":7630,"iteration":2,"detail":"Retained stage work needs continuation, but iteration budget is exhausted (2/2).","status":"incomplete","attempts":[{"status":"complete","exitCode":0,"budgetMs":10000},{"status":"complete","exitCode":0,"budgetMs":10000}],"gateAttempts":0}
```

The exact full handoff hashes, native inputs, check times and record mappings are in `evidence/runtime-summary.json`; `build/collect-evidence.cjs` asserts actual stdin delivery, at least W remaining at native receipt, retained bytes, exact handoff consumption, independent gate allocation, grace/idle separation and the finite bound.

These launches are real private daemons running compiled production adapters. The local children deliberately emit progress while ignoring wrap-up, or remain silent with no work, so grace and idle expiry can be distinguished. They are protocol/control proofs, not live-provider trials. A missing fixture in the installed harness was repaired; it was not evidence of an adapter limitation.

The bounded workload is identical on the deployed baseline and candidate: retain unit 1, respond to finishing when supported, consume the exact prior handoff/file in the next iteration, complete unit 2, and run the same 1.5-second configured check and independent gate. Both have B=20 seconds and two allowed iterations. The baseline is not given an invented cooperative signal. Its natural timeout is the control outcome. Comparison uses monotonic author elapsed time and direct terminal state; launch/setup and check time are also retained.

| Same bounded workload | Deployed baseline | Candidate |
|---|---:|---:|
| Nominal stage budget / iteration limit | 20,000 ms / 2 | 20,000 ms / 2 |
| Measured author elapsed (sum of monotonic slices) | 20072 ms | 13386 ms |
| Whole run elapsed (observed timestamps) | 21059 ms | 18582 ms |
| Native author calls | 1 | 3 |
| Outcome | incomplete; attempt exit 124; unit 1 kept, no handoff/continuation | complete; two normal retained executions; both units and handoff kept |

The measured benefit is successful retained continuation within less author elapsed time on this workload. The cost is two additional native child invocations and an additional spent iteration. Setup/check/startup costs are retained separately. This single deterministic comparison establishes control behavior; it makes no provider throughput, token-cost or statistical speed claim.

## 4. Deployed-generation continuation, including recorded competition

The deployed manifest generation and every backend/UI member were matched to the private baseline. Its historical source matches all manifest inputs. Four source files in the deployed checkout had drifted from that built generation; launching checkout HEAD would not prove the deployed version. `evidence/deployed-identity.json` records the individual hashes, source drift and matching private copies. No installed runtime or existing run was modified.

Each upgrade trial starts on that preserved deployed build, completes `done`, holds `work`, cancels through `flowcrew task cancel`, stops the private daemon, builds/deploys the candidate against the same private state, restarts and explicitly calls `flowcrew task resume`. Queuing is not completion: the harness waits for a new launch sequence, the same run's new attempt and that scheduler's actual exit receipt.

Read-only controller identity also agrees: the live deployed daemon build fingerprint matches the baseline private daemon, and this task’s checkpoint generation matches the deployed manifest (`evidence/deployed-controller-identity.json`).

Old manifest generation: `e65564a026920867d6025730d4ca5246a89eb95b11a2943696c430b661353c39`. Candidate generation: `5be81043155f340ee6cb39409334681e98f9768cd9a8898a4bf43288d752566b`. Both upgrade trials use these identities.

| Trial | Cancel | Stop | Candidate build/deploy | Explicit resume | Resumed scheduler |
|---|---:|---:|---:|---:|---:|
| upgrade | 0 | 0 | 0 | 0 | 0 |
| midrace | 0 | 0 | 0 | 0 | 0 |

Both runs finish `complete`, preserve the identical completed predecessor and admitted plan digest, retain `unit 1\n` and finish `unit 2\n`. Parent attempt histories are `[failed:143, complete:0]`; cancellation was the deployed engine’s `stopped / Cancelled by user` representation. The mid-competition checkpoint is version 2, its race record version 3, and B was live at cancellation. The exact original race record bytes survive. `evidence/upgrade-summary.json`, `upgrade.json` and `midrace.json` retain proof and command receipts.

```jsonl
{"alias":"midrace","source":"before checkpoint / retained race record","checkpointVersion":2,"raceRecordVersion":3,"recordedCandidate":"A","candidateBWasLive":true,"recordSha256":"840b314388453a74a4c40f9b7b30cd8bdf416300979a0efa3141710fe7f4d3ff"}
{"alias":"midrace","source":"native invocations.jsonl","kind":"legacy-candidate-consumed","bytes":"unit 1\n"}
{"alias":"midrace","source":"final run and scheduler exit","status":"complete","predecessorPreserved":true,"planDigestPreserved":true,"attempts":[{"status":"failed","exitCode":143},{"status":"complete","exitCode":0}],"schedulerExit":0}
```

The recorded competition trial deliberately lets A fail, preserving the deployed engine's version-3 race record, then holds B alive before cancellation. The continuing single author reads that exact record and the retained candidate file to finish the parent stage. The parent plan marker/digest and completed predecessor survive; attempts are settled as cancelled failure then normal completion. Candidate records remain historical evidence. Separate synthetic v1 fixtures with omitted/unknown consumers still refuse recovery; positive current-engine continuation does not waive that safety rule.

## 5. Guard mutations

`fc-trial mutate` runs each fault separately in a task-owned Git snapshot with tests fixed throughout that cycle. Each accepted mutation has: positive control exit 0; production mutation build exit 0; a named behavioral/structural assertion failing with test exit 1; original bytes/modes/timestamps/distributions/index/status restored; restored control exit 0. Tests are not changed to kill a mutant during its cycle. Initial survivors and invalid compile probes are retained under `evidence/diagnostics/` and are not counted as kills. Strengthened tests are separately frozen before a new control/mutation/restoration cycle.

The warning-interruption probe initially survived because the ordinary command boundary also carried guidance. An independent warning-boundary assertion now tests immediate interruption. The projection probe initially survived because final settlement repaired the projection; a child-closure assertion now checks durable history and projection before that later settlement. A refusal mutant initially lost TypeScript narrowing; the replacement removes the whole guarded action and must compile before its behavioral failure counts.

Mutation source refs, exact replacements, commands, named failures, direct per-check exits and cleanup are retained in `build/mutation*-plan.json`, `evidence/mutation-*.json` and their private trial roots. Removed-module/image and generation-schema assertions are intentionally structural; all control-flow mutants require their named behavioral failure.

**68/68 independent mutants killed**, with all four direct exit checks verified. The four removed-module/image checks assert absence; the other probes exercise input parsing or execution behavior. Full names and failure messages are retained in the summary.

| Guard/fault ID | Production location | Named regression |
|---|---|---|
| admit-stage | `src/scheduler/sched_admission/configuration.ts` | `single-author-legacy.test.ts`: S01 |
| admit-workflow | `src/scheduler/sched_admission/configuration.ts` | `single-author-legacy.test.ts`: S01 |
| admit-recursive | `src/scheduler/sched_admission/configuration.ts` | `single-author-legacy.test.ts`: S01 |
| admit-direct | `src/scheduler/sched_loop/launch.ts` | `single-author-legacy.test.ts`: S05 |
| live-iteration-schema | `src/scheduler/sched_admission/configuration.ts` | `stage-budget.test.ts`: B13 |
| live-iteration-launch | `src/scheduler/sched_loop/launch.ts` | `stage-budget.test.ts`: B33 |
| removed-race | `src/race.ts` | `single-author-legacy.test.ts`: S02 |
| removed-stage-race | `src/scheduler/sched_loop/stage-race.ts` | `single-author-legacy.test.ts`: S02 |
| removed-svg | `assets/architecture.svg` | `single-author-legacy.test.ts`: S02 |
| removed-png | `assets/architecture.png` | `single-author-legacy.test.ts`: S02 |
| generation-schema | `src/plan-interface.ts` | `single-author-legacy.test.ts`: S02 |
| recorded-schema | `src/scheduler/sched_admission/configuration.ts` | `single-author-legacy.test.ts`: S02 |
| recorded-dispatch | `src/scheduler/sched_admission/dispatch.ts` | `single-author-legacy.test.ts`: S04 |
| recorded-compatibility | `src/engine-continuation.ts` | `single-author-legacy.test.ts`: S04 |
| recorded-plan | `src/restart-recovery.ts` | `single-author-legacy.test.ts`: S04 |
| recorded-launch | `src/scheduler/sched_loop/launch.ts` | `single-author-legacy.test.ts`: S04 |
| recorded-resume-query | `src/scheduler/sched_loop/launch.ts` | `single-author-legacy.test.ts`: S04 |
| notice-prompt | `src/worker.ts` | `single-author-legacy.test.ts`: S03 |
| notice-record | `src/scheduler/sched_loop/run-workflow.ts` | `single-author-legacy.test.ts`: S03 |
| reserve-retirement | `src/attempt-deadline.ts` | `stage-budget.test.ts`: B18 / B26 |
| finishing-cap | `src/attempt-deadline.ts` | `stage-budget.test.ts`: B26 |
| finishing-ratio | `src/attempt-deadline.ts` | `stage-budget.test.ts`: B26 |
| hard-stop | `src/attempt-deadline.ts` | `stage-budget.test.ts`: B26 |
| arm-wrap-up | `src/worker.ts` | `stage-budget.test.ts`: B01 |
| durable-binding | `src/worker.ts` | `stage-budget.test.ts`: B01 |
| budget-reinvoke | `src/worker.ts` | `stage-budget.test.ts`: B01 |
| budget-abort | `src/worker.ts` | `stage-budget.test.ts`: B18 |
| forced-retention | `src/worker.ts` | `stage-budget.test.ts`: B03 |
| forced-handoff | `src/worker.ts` | `stage-budget.test.ts`: B03 |
| cooperative-json | `src/worker.ts` | `stage-budget.test.ts`: B17 |
| retained-home | `src/worker.ts` | `stage-budget.test.ts`: B02 |
| abort-priority | `src/worker.ts` | `stage-budget.test.ts`: B05 |
| refusal-priority | `src/worker.ts` | `stage-budget.test.ts`: B06 |
| unverified-close | `src/worker.ts` | `stage-budget.test.ts`: B14 |
| inner-refusal | `src/scheduler/sched_settlement/stage-execution.ts` | `stage-budget.test.ts`: B19 |
| history-marker | `src/store.ts` | `stage-budget.test.ts`: B09 |
| projection-marker | `src/store.ts` | `stage-budget.test.ts`: B36 |
| gate-carrier | `src/worker.ts` | `stage-budget.test.ts`: B17 |
| gate-rejection | `src/worker.ts` | `stage-budget.test.ts`: B04 |
| dependency-boundary | `src/scheduler/sched_admission/frontier.ts` | `stage-budget.test.ts`: B22 |
| gate-reader | `src/scheduler/sched_settlement/gate-verdict.ts` | `stage-budget.test.ts`: B22 |
| gate-evaluation | `src/scheduler/sched_settlement/gate-verdict.ts` | `stage-budget.test.ts`: B22 |
| gate-validation-identity | `src/scheduler/sched_settlement/gate-validation.ts` | `stage-budget.test.ts`: B27 |
| gate-validation-command | `src/scheduler/sched_settlement/gate-validation.ts` | `stage-budget.test.ts`: B27 |
| iteration-boundary | `src/scheduler/sched_loop/iteration.ts` | `stage-budget.test.ts`: B23 |
| terminal-boundary | `src/scheduler/sched_policy/terminal.ts` | `stage-budget.test.ts`: B24 |
| finite-boundary | `src/scheduler/sched_loop/workflow-loop.ts` | `stage-budget.test.ts`: B10 |
| research-boundary | `src/scheduler/sched_loop/workflow-loop.ts` | `stage-budget.test.ts`: B12 |
| resume-accounting | `src/scheduler/sched_loop/launch.ts` | `stage-budget.test.ts`: B11 |
| retain-dag | `src/scheduler/sched_loop/iteration-setup.ts` | `stage-budget.test.ts`: B09 / B21 |
| retired-dag | `src/scheduler/sched_loop/iteration-setup.ts` | `stage-budget.test.ts`: B20 |
| repair-boundaries | `src/scheduler/sched_loop/gate-loop.ts` | `stage-budget.test.ts`: B25 |
| stale-guidance | `src/guidance.ts` | `stage-budget.test.ts`: B09 |
| pending-marker | `src/store.ts` | `stage-budget.test.ts`: B28 / B11 |
| scope-author | `src/scheduler/sched_loop/stage-batch.ts` | `stage-budget.test.ts`: B31 work |
| scope-repair | `src/scheduler/sched_scope/stage-group.ts` | `stage-budget.test.ts`: B31 repair |
| settlement-clear | `src/store.ts` | `stage-budget.test.ts`: B29 |
| audit-history-clear | `src/store.ts` | `stage-budget.test.ts`: B30 |
| audit-projection-clear | `src/store.ts` | `stage-budget.test.ts`: B30 |
| result-sync | `src/worker.ts` | `stage-budget.test.ts`: B32 |
| timer-dispose | `src/attempt-deadline.ts` | `retry-attempt-deadline.test.ts`: R02 |
| durable-append | `src/worker.ts` | `stage-budget.test.ts`: B01 |
| adapter-remaining | `src/worker.ts` | `stage-budget.test.ts`: B18 |
| repend-clear | `src/store.ts` | `stage-budget.test.ts`: B09 |
| recorded-cli | `src/cli.ts` | `single-author-legacy.test.ts`: S06 |
| boundary-monitor-refusal | `src/worker.ts` | `stage-budget.test.ts`: B34 monitor |
| boundary-rollback-refusal | `src/worker.ts` | `stage-budget.test.ts`: B34 rollback |
| duration-count | `src/worker.ts` | `stage-budget.test.ts`: B35 |

## 6. Complete configured validation after the final project write

Required checks come from `package.json`, root/UI Vitest configuration, `CONTRIBUTING.md` and `.github/workflows/ci.yml`: combined engine/UI build, full root test population including UI and UX replays, then lint. The alternate baseline-population and UX-only scripts are not substitutes for `npm test`. The isolated validation copy has identical project bytes, private dependencies and freshly built `dist`, because tests do not automatically consume a separate output root.

The report's totals were drafted from preceding direct receipts. All project writes, including this report, are frozen before the final complete set. Exact argv, source manifest, start/end times, direct exits and populations are in `evidence/final-validation.json` and its logs; the final evidence audit checks agreement without editing the project.

| Final command, in the isolated identical source copy | Direct exit | Totals |
|---|---:|---|
| `npm run build` | 0 | 241 inputs, 394 backend outputs; both UI type checks; 67 Vite modules |
| `npm test` (JSON/default reporters only, no selection/exclusion) | 0 | 308 files, 3,709 tests passed; zero failures/skips |
| `npm run lint -- --format json` | 0 | 197 files, zero errors, 17 warnings |

The root population includes all 10 rendered `.test.tsx` files / 120 tests, including the standalone UI configuration’s 3 files / 58 tests, and all 5 recorded UX replay files / 58 tests. These are subsets of the full total, not extra executions. Node is v22.22.2. Commands are bounded through the adapted harness; `final-validation.json` records the direct build/test/lint exits, source identity and timing. The final full run also invokes the existing Docker isolation recipe with a local image, `--pull=never`, network disabled, inherited CPU set and nice 19 inside the container. The no-service-manager CI selection is repeated after the freeze (5 files / 49 tests), with the three manager commands absent and procfs present.

CI's additional Linux isolation and no-service-manager checks are considered separately. macOS requires another host; cold installation/clone/publishing jobs require external installation or network effects and were not run here. No sudo, global installation, provider request, shared daemon mutation or operator operator credential read was used. Every owned trial process is closed before delivery; original private records and receipts remain for review.


## Run retention

Per-stage workspaces previously accumulated extracted corpora, experiment directories and
superseded attempts for the lifetime of the store. One compaction policy now serves settled
scheduler waves, terminal publication/finally, daemon startup and `flowcrew prune`. It replaces
unconditional terminal scratch removal: `failed`, `incomplete` and `stopped` are terminal in
the lifecycle table but can continue, so their invocation scratch must survive. No new run
status, retention timer, daemon service or artifact protocol was added. Existing process-fate
helpers share a small module using the existing ownership probes, rather than pulling
recovery's configuration graph into the store. The original recovery exports remain available. The additional policy is necessary to distinguish disposable workspace members
from evidence and continuation inputs; deleting a whole directory could not provide that
guarantee.

Only `stages/<stage>/build/`, `stages/<stage>/scratch/` and final invocation `scratch/` are
candidates. A stage must be complete, without continuation, and its execution ledger must
match the run projection. Cleanup follows joined children, monitors, audits and retry
settlement. Unfinished stages, deployment/approval holds and uncertain ownership preserve
work. Offline apply requires a terminal run, proven controller/command absence and the same
run-state lock used by launch, resume and cancellation. Missing/malformed checkpoints,
unknown historical consumers, inconsistent ledgers and unreadable contracts never authorize
removal. Retention sends no process signals.

| Retained material | Consumer that still needs it |
| --- | --- |
| Workflow, dispatch, admitted plans, run/history records, ownership and attempt ledgers | Resume, cancellation, scheduler admission and audit attribution |
| Every attempt output/log, structured result, verdict, gate archives and validation/constraint records | Continuation prompts, retries, independent review and audit |
| Project changes, patches, declared products below the workspace root, all declared reads | Delivery, downstream stages and later gate retries |
| Reports, evidence, handoffs and portable tarballs/bundles, including nested workspace copies | Report readers, portable review and dashboard links |
| Unfinished stage work and invocation scratch for resumable outcomes | Actual continuation of stopped/incomplete/failed work |
| Summary, progress, events, invocation inputs and artifact directory roots | Dashboard detail, output, summary and query projections |

Exact evidence paths remain at their original location at any size. Small scripts,
configurations and results are also kept when named in retained reports/evidence, or at the
workspace root, up to **1 MiB per file**. This preserves reproducibility inputs and small
measurements while preventing an ambiguous prose filename mention from pinning a multi-gigabyte
corpus. Reports and structured evidence supply path references; execution logs/native inputs
remain durable without treating every old command's working directory as an evidence
citation. Symlinks and their workspace targets are protected. No auth or credential contents
are opened by retention. The policy intentionally preserves required artifacts rather than
promising an absolute store quota.

The CLI defaults to dry-run. `flowcrew prune --dry-run --json` reports each eligible run's
candidate bytes, file list and kept paths/reasons. `--run <run-id>` selects one; `--apply`
recomputes under the run lock. Bulk mode preserves refused/uninitialized entries; targeted
refusal exits nonzero. Dry-run takes no store lock and writes no index, manifest, alias or
store file. Byte counts are logical lengths; hardlinks, filesystem compression and metadata
can change the free-space result. Operations and CLI guides document the command and policy.

The unchanged synthetic R19/R20 workload has **3,072 disposable bytes before compaction,
zero afterward**, with byte-identical run/workflow records and a second apply reclaiming zero.
R30 observes automatic cleanup before a successor executes, retains nested evidence and
patches, and reads actual dashboard detail/output/summary routes successfully afterward.
R31 actually resumes each of failed/incomplete/stopped after predecessor cleanup, consumes
the retained unfinished workspace and invocation scratch, and preserves prior attempt ledgers.
The native scratch-lifetime and parallel-isolation fixtures also retain their independent
provider/concurrency assertions under the new evidence policy.

Named guards in `spec/run-retention.test.ts` cover status/ownership (R01–R08, R25–R28,
R41/R45), unfinished work and holds (R09–R11/R33), declared consumers/products (R12/R13,
R16/R37/R40/R46/R47), references and symlinks (R14/R15/R17/R18/R29/R34–R36/R38/R39/R42–R44/R48/R49),
and dry-run/apply/CLI behavior (R19–R24). Each unsafe condition has a named behavioral
assertion. Additional review reproductions first demonstrated the citation/ownership defects
before their fixes; source changes were made after recording those failing controls.

### Read-only operator-store observation

On October 16 local time (metadata observation **2026-10-17 02:09:39 UTC**), the worktree's
built CLI ran with `FC_HOME` selecting `~/.fc`, CPU affinity **6–11**, nice **19**, and exactly
`prune --dry-run --json`. No apply, history deletion, daemon mutation or process signal was
used there. Private receipts remain in ignored worktree files
`.tmp_retention-store-dry-run.json` and `.tmp_retention-store-sizes.json`; the latter only
counts directory-entry metadata and does not open payload files.

The dry-run would reclaim **0 bytes**: **43** runs were eligible, **15** refused (7 nonterminal,
5 unsettled and 3 with possibly live process ownership), and **4,449** uninitialized entries
were preserved. All remaining stage build areas occurred in running runs. The incident's
131 GB historical observation therefore is not the current reclaimable amount. The current
initialized-run inventory held **49,041,651,997 logical bytes**. The largest ten runs below
are ordered by observed stored bytes; every eligible run also ties at zero reclaimable bytes.
Aliases replace private run identifiers. Live runs can change during this read-only inventory.

| Size rank alias | Status | Observed logical bytes | Dry-run reclaim bytes | Disposition |
| --- | --- | ---: | ---: | --- |
| largest-01 | running | 34,449,075,993 | 0 | Refused: nonterminal |
| largest-02 | running | 3,734,185,100 | 0 | Refused: nonterminal |
| largest-03 | complete | 2,310,278,064 | 0 | Refused: process ownership |
| largest-04 | complete | 2,193,183,346 | 0 | Refused: process ownership |
| largest-05 | stopped | 1,642,042,351 | 0 | Refused: unsettled attempts |
| largest-06 | running | 396,266,691 | 0 | Refused: nonterminal |
| largest-07 | ceiling_hit | 249,609,972 | 0 | Eligible; durable material retained |
| largest-08 | escalated | 233,325,699 | 0 | Eligible; durable material retained |
| largest-09 | complete | 204,090,885 | 0 | Eligible; durable material retained |
| largest-10 | stopped | 196,169,158 | 0 | Refused: unsettled attempts |


Final focused validation passed **9 files / 165 tests**, including **101 guard/CLI cases**
and **4 scheduler/resume/dashboard cases**. Build passed; lint passed with **0 errors and
17 existing warnings**. The later review regressions were recorded against the preceding
source (10 failures and one already-safe case), then passed with the fixes. Common Markdown
angle destinations, extensionless sibling links, link titles, literal punctuation and relative
links through declared report aliases now have separate named cases.

An isolated frozen pre-final-review variant killed **17/17 successfully compiled independent
faults** through named behavioral failures: terminal status, scheduler/controller liveness,
stage continuation, resumable scratch, declared paths, exact citations/size cutoff, durable
categories, no-follow/ledger agreement, read-only planning, CLI default, settled-stage hook,
relative references, durable symlink targets and saved-token validity. Two compile-invalid
probes were excluded, not counted as kills. Both restored controls built and passed all
**87** retention tests present in that snapshot. Receipts are in ignored
`.tmp_retention_mutations/summary.json`; these mutation results do not claim coverage of the
later citation fixes, which have their own reproductions and final passing tests.

The required clean-tree/build/lint/full-test pipeline is run after committing this report;
its direct output and exit are retained in `.retention-verify.log`. No live-provider or
private-daemon trial is needed for this filesystem lifecycle change. Native adapter fixtures,
real scheduler continuation and actual dashboard routes exercise its affected boundaries.
Normal build/test scratch uses the permitted system temporary directory, never a worktree
`TMPDIR`. All owned mutation processes finished before final verification. No deployed
checkout, distribution or daemon was modified, and the operator store was never pruned.
