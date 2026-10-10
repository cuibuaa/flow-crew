# Independent acceptance of FlowCrew task 2319

Acceptance is **withheld pending an authenticated final-code measurement**. The repaired code, the rebase onto `dc606777150ef8143d7bba4dbc24baac2110c0b4`, and the independent regression checks pass. The prescribed live-model harness was attempted on the final code but exited 1 with HTTP 401 before its first comparison. Prior-code after figures below are retained as historical evidence and are not substituted for a final-code re-run.

The run output was first committed unchanged as `7d9e7cc`, then rebased as `24ce2b0`. Main’s candidate-A restatement, blind comparison, exact-digest acknowledgement translation, and embedded instruction are preserved. The original digest-admission regression now also checks preferred A’s continuation against its stored exact brief (18 race-command tests, direct exit 0). Continuation uses the corresponding candidate’s translated digest too. Independent fix `6c10a1b` keeps completed workflows with verified gates eligible when their final ordinary stage follows the gate. No push or merge into main was performed.

**Dependencies and limits that affect the figures and mechanisms**

- Candidate attempts overlap. Summed review/repair duration divided by race wall measures resource time, not critical-path savings. Moving the winner’s gate after comparison can increase elapsed time.
- Attempt ledgers contain all re-evaluations. Stage aggregates and nested invocations must reconcile but must not be counted again. Missing/partial provider usage changes the value of any token ratio.
- The historical harness reports candidate-stage tokens, omitting comparison usage; supervisor histories are absent. The new harness includes model comparison and gate output usage, two actual setups and scheduler/record overhead within the same entry/return boundary.
- Frozen author and repair snapshots cost zero model tokens and no model authoring time. These are bounded clamp workloads with live-model judgments, not full authoring races, billing estimates or SWE-bench savings. No population selection threshold was supplied, and none is invented.
- Previously the comparator saw completed, possibly repaired revisions. It now sees all ordinary authoring, including downstream work behind prerequisite gates, before deferrable final verification. Intermediate gates and repairs necessary to produce a full candidate are still payable for both candidates; a failed preferred candidate necessarily costs verification before fallback.
- A workflow ending after a prerequisite gate can already be complete by comparison. The independent fix accepts its effective passing gate facts rather than requiring an artificial park. Such a topology has no remaining final gate to save. Removing prerequisite verification would violate workflow dependencies or weaken the gate.
- The judge retains declared-output exclusion and the 120,000 JavaScript-string-unit diff cap. It receives the original task, not A’s additional authoring guidance or review history. Thus missing report text and truncated changes remain comparison limitations.
- The old uncertain-comparison fallback used repair counts available only after paying both gates. Stable A-then-B verification replaces it. Paired oracle evidence below is bounded evidence for this policy, not a statistical accuracy guarantee.
- Model execution needs authentication. The supplied implementation harness defaults to a Codex home under the old run. This acceptance uses an empty private home in the ignored worktree scratch area to avoid any writes under `~/.fc` or handling prohibited credential files. Authentication was unavailable there.

**1. Historical discarded review and repair**

The ten supplied races were independently recalculated from each `cand-race.json`, `result.json`, and the exact candidate `run-<id>.json`. Every attempt is counted once, classified by `is_gate` or `retry_to`, and reconciled against stage totals and harness usage. The independent accounting command exited 0; its receipt is `.cache/race-cost/history-independent.json`. The run’s unchanged historical accounting is reused from `stages/repair/evidence/history.json`.

| Race | Delivered | Loser output / all recorded output | Token share | Loser review+repair seconds / race wall | Duration share |
|---|---|---:|---:|---:|---:|
| race-ae-11510-1 | B | 7,643 / 60,090 | 12.72% | 269.748 / 1299.000 | 20.77% |
| race-ae-12325-1 | B | 5,280 / 20,143 | 26.21% | 162.761 / 406.600 | 40.03% |
| race-ae-8548-1 | A | 27,186 / 71,701 | 37.92% | 816.683 / 1246.500 | 65.52% |
| race-ae-9229-1 | B | 19,184 / 47,197 | 40.65% | 615.461 / 961.700 | 64.00% |
| race-ae-9461-1 | B | 4,184 / 32,458 | 12.89% | 138.796 / 584.800 | 23.73% |
| race-af-11510-1 | A | 20,461 / 68,673 | 29.79% | 658.473 / 1384.700 | 47.55% |
| race-af-12325-1 | A | 2,911 / 19,460 | 14.96% | 101.438 / 444.300 | 22.83% |
| race-af-8548-1 | A | 46,599 / 132,111 | 35.27% | 1637.625 / 2329.900 | 70.29% |
| race-af-9229-1 | B | 2,700 / 20,816 | 12.97% | 99.500 / 449.200 | 22.15% |
| race-af-9461-1 | A | 3,382 / 34,269 | 9.87% | 118.911 / 674.100 | 17.64% |
| **Total** | | **139,530 / 506,918** | **27.53%** | **4619.396 / 9780.800** | **47.23%** |

There are 33 partial-usage attempts and 12 unknown native invocations nested within the attempt ledgers. Numerical totals reconcile, but this does not establish complete provider cost. Token-share mean/median are 23.33%/20.59%; duration-share mean/median are 39.45%/31.88%. Ten races are two repeats of five SWE-bench tasks, all direct workflows with complete candidates. Their supplied metadata does not contain candidate diffs or independent benchmark correctness labels.

**2. Change and paired workload measurements**

The scheduler reuses DAG reachability to defer only gates that unlock no remaining ordinary authors (`src/scheduler/sched_loop/stage-batch.ts:30`). Race compares the candidates in both orders, resumes the preferred exact run through normal admission/gating/repair, and tries the other only after failure (`src/cli-race.ts:134`, `src/cli-race.ts:158`). Gate checks are fresh before delivery (`src/cli-race.ts:165`). Existing repair-round artifacts preserve budget and archive coordinates across a hold (`src/scheduler/sched_loop/gate-loop.ts:40`); no new repair counter or workflow profile was added.

The following figures reuse the run’s **pre-change baseline** and record its **post-repair, pre-rebase after** measurement. Baseline code is preserved at `stages/repair/evidence/baseline-project` and was measured unchanged; baseline provenance is `77a60b0`. The after orchestration changed during this rebase and acceptance fix, so those after figures are historical only. They are not accepted final-code figures.

| Frozen workload | Reused baseline output tokens | Baseline wall s | Delivered / gate | Prior-code after output tokens | Prior-code after wall s | Delivered / gate |
|---|---:|---:|---|---:|---:|---|
| normal-a | 880 | 57.335 | A / pass | 353 | 41.854 | A / pass |
| normal-b | 854 | 53.661 | B / pass | 341 | 41.819 | B / pass |
| repair | 1148 | 58.445 | A / pass | 763 | 60.810 | A / pass |
| staged-normal-a | 1292 | 74.972 | A / pass | 809 | 55.431 | A / pass |
| staged-normal-b | 1322 | 70.056 | B / pass | 823 | 54.803 | B / pass |
| staged-prerequisite-repair | 1675 | 71.133 | A / pass | 1086 | 67.614 | A / pass |
| **Total** | **7171** | **385.602** | 6/6 gated | **4175** | **322.331** | 6/6 gated |

These retained measurements used live model gate/comparison calls and actual ship-setup/scheduler execution, with two independently passing criterion results per delivery and an independently re-executed exhaustive 105-input clamp oracle. The three staged cases start with equal or repairable prefixes; distinguishing code exists only at `finish`. Direct losers execute no final review or repair after the change. Staged losers still execute prerequisite review, while their final review and repair are omitted. The prior repaired sample reduced recorded output by 41.78% and wall by 16.41%; its `repair` case was 4.05% slower. These percentages apply to that prior version and sample only.

Evidence roots for the table are the read-only original run’s `stages/repair/evidence/before-retry1/measurements.json`, `after-final/measurements.json`, and `workload-summary.json`. Those two successful phases spent 11,346 recorded model output tokens. An earlier aborted baseline phase spent 792 known output tokens plus one unknown-usage call, and is not silently counted as zero or filtered by outcome.

The requested implementation harness and its original `workload.json` were copied by name into `.cache/race-cost/implement/`; source and workload bytes were unchanged. It was attempted on final code with this exact command:

```sh
RACE_COST_MODEL_HOME="$PWD/.cache/race-cost/model-home" timeout --kill-after=10s 1800s taskset -c 2-5 node --import tsx .cache/race-cost/implement/measure.ts after final
```

**Direct exit: 1.** The first model comparison returned HTTP 401 “Missing bearer or basic authentication”. No completed-turn usage or complete race measurement was produced; no model output was generated, and billed input/output usage has no provider receipt. This is a failed measurement attempt, not a zero-token race or a passing measurement. The failure is retained in `.cache/race-cost/measure-final.log`; the harness’s private temporary store is recorded there. Model authentication is the remaining prerequisite for item 2. No rerun of the staged extension is claimed.

**3. Comparison inputs and independent choice evidence**

Comparison text is the unchanged original brief plus both complete ordinary-authoring diffs, including new files, excluding declared outputs and truncating each at the existing cap (`src/cli-race.ts:135`, `src/cli-race.ts:216`). It is asked as A/B and B/A with unchanged instructions (`src/cli-race.ts:57`, `src/cli-race.ts:140`). Both answers must agree after label mapping; invalid, missing, repeated-order and position-driven answers use stable author order followed by independent gating (`src/cli-race.ts:45`).

An independent final-selector replay on the exact twelve recorded authored/repaired pairs exited 0:

```sh
timeout 60s node --import tsx .cache/race-cost/selection-independent.ts
```

Twelve pairs, byte-identical comparison prompts in both orders, zero executable-oracle regressions, zero model calls/tokens. Old complete eligibility on authored snapshots is hypothetical in this replay; old repair counts come from the measured baseline. In the repaired `normal-b` and `staged-normal-b` pairs, the old selector chooses B and the new fallback chooses A, but both revisions pass every oracle input. On the five authored pairs with exactly one correct candidate, both selectors choose the correct candidate. The `repair` authored pair has no passing snapshot, so it establishes repair/final gating rather than correctness preference. Receipt: `.cache/race-cost/selection-independent.json`.

The rejected-prefix regression is independently covered by `spec/race-workflow.test.ts:141`: A and B initially agree, differ only after their prerequisite review, both finish before comparison, and only the preferred candidate executes the final gate. Both winning directions pass. The prerequisite-repair, preserved-round and exhausted-budget cases are at `spec/race-workflow.test.ts:172`, `:183`, and `:196`. The additional completion regression is at `spec/race-workflow.test.ts:159`: the supported DAG completes after its gate and final author; both finished diffs are compared and the preferred effectively gated candidate is delivered without repeated execution.

Before the independent completion fix, the new regression command exited 1 (`expected 1 to be +0`); after the fix the full targeted command exited 0 with 5 files and 66 tests. Raw receipts: `.cache/race-cost/complete-regression-before.log` and `targeted-fixed.log`. No general population accuracy claim, new live judgment on final code, full model-authoring savings, default-supervisor cost or live dynamic-planner/research cost is established.

**4. Net lines and architecture**

`git diff dc60677 --numstat -- src spec config` gives:

| Tree | Added | Deleted | Net |
|---|---:|---:|---:|
| src | 137 | 57 | +80 |
| spec | 354 | 48 | +306 |
| config | 0 | 0 | 0 |

The report itself is outside these trees. Source additions reuse parked-run continuation, normal gate facts, DAG reachability and durable repair artifacts. They replace routine loser final verification, newest-run discovery and repair-count preference. One internal hold flag and one internal quick argument remain. This is an explicit source-growth exception to AGENTS.md, supported by the prior paired savings and the passing scheduler regressions; final-model cost payback is not yet independently accepted because the required rerun failed authentication. No additional workflow, gate implementation, credential route or isolation mode was introduced.

**Clause-by-clause independent verdict**

| Clause | Verdict | Evidence |
|---|---|---|
| Two independent candidates of the brief; preferred delivery | PASS | `src/cli-race.ts:113`, `:122`, `:140`, `:174`; `spec/race.test.ts:70`, `:178` |
| Deliver only a change passing independent gates | PASS | Effective gate facts at `src/cli-race.ts:166`, `:212`; oracle-backed scheduler tests at `spec/race-workflow.test.ts:115`, `:207` |
| Comparison at least as reliable | PASS on the bounded same-pair evidence; population claim unmeasured | Twelve-pair replay exit 0, unchanged two-order prompts, downstream-distinction regression at `spec/race-workflow.test.ts:141`; final live rerun still missing |
| Avoid discarded loser review/repair | PASS for deferrable final work; prerequisite/fallback expenditure retained | `spec/race-workflow.test.ts:115`, `:141`, `:172`, `:159`; mandatory prerequisites cannot be removed without compromising full comparison inputs |
| Preferred candidate fails: gated alternative or reason none passed | PASS | `spec/race-workflow.test.ts:219`, `:226`; `spec/race.test.ts:114`, `:121`, `:130` |
| Each assigned criterion and supplied score independently meets its line | PASS | Omitted criterion and score-zero false-pass regressions: `spec/race-workflow.test.ts:233`, `:239`; existing gate readers remain unchanged |
| Text-only comparison in both orders | PASS | `src/cli-race.ts:57`, `:140`, `:229`; `spec/race.test.ts:70`, `:96`; byte-identical replay prompts |
| Read-only ~/.fc; no prohibited files or process signals | PASS | Only named brief/review/evidence/config and project copies were read; harness copied into ignored scratch and uses a private store/home; no FlowCrew run was launched outside authorized harness/test fixtures |
| Isolation and credential protection do not weaken | PASS | Unchanged ship-setup and sandbox/stage paths; unchanged gate readers; `src/cli-race.ts:113`, `:212`, `:216`, `:229`; approval parks remain ineligible (`spec/race-workflow.test.ts:245`) |
| Review attempt 1: comparison before distinguishing author work | RESOLVED | `stage-batch.ts:30` retains prerequisite gates; both finishing authors appear in the comparison in both winner directions; targeted 66-test command exit 0; completed-after-gate case additionally fixed |
| Report item 1: per-race and pooled accounting | PASS | Table and independent ten-race reconciliation exit 0 |
| Report item 2: paired final-code output tokens, wall, delivery and gate | INCOMPLETE | Prior-code evidence retained; prescribed final-code harness exit 1 / HTTP 401, no complete final race receipt |
| Report item 3: inputs and same-pair choice evidence | PASS, bounded | Twelve-pair replay exit 0 and scheduler regressions; no population threshold invented |
| Report item 4: net lines in src/spec/config | PASS | Exact current-main numstat above |
| Report item 5: full configured validation after last report write | PASS | Four direct exit codes 0 and 243 files / 2746 tests; commands repeated after the final report write as recorded below |

**5. Configured validation and direct exits**

The full configured set passes. The table was finalized from the passing preparatory commands, then every command is repeated after this report’s final write and commit. Final direct subprocess return codes and full logs are retained in `.cache/race-cost/final-validation/receipts.json` and its adjacent logs; the completion message confirms that repetition. No acceptance is claimed for the failed live-model rerun.

| Command | Direct exit code | Result |
|---|---:|---|
| `taskset -c 2-5 npm run build` | 0 | Backend and transactional UI build |
| `taskset -c 2-5 npm run build:ui` | 0 | Full configured UI build |
| `taskset -c 2-5 npm run lint` | 0 | Zero errors; 12 existing warnings |
| `taskset -c 2-5 npm test` | 0 | **243 files and 2746 tests passed** |

The initial targeted attempts exited 1 at the stale-dist guard before test execution; rebuilding resolved that guard. The intentionally failing completion regression exited 1 before its production fix. The independent selection replay exited 0, the fixed five-file targeted check exited 0 (66 tests), and the strengthened restatement/continuation spec exited 0 (18 tests).

The final verification also checks `test -s docs/race-cost/report.md`, `git merge-base --is-ancestor dc60677 HEAD`, and an empty `git status --porcelain`. Build, UI build, lint and test are invoked in full with the requested CPU affinity, following the report’s last tracked write; no production or report files are modified after those checks.

All acceptance work is confined to branch `race-cost`, this worktree and temporary directories. Historical evidence under `/home/qian/.fc/runs/2026-10-10T17-53-28-1b2bd5` remains read-only. The report is committed by this independent acceptance task because the original FlowCrew run ended before its terminal report stage.
