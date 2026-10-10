# Independent acceptance of FlowCrew task 2319

Acceptance is **PASS on the reported bounded evidence**. The authenticated before/after pair reran the supplied three-case workload against the preserved baseline and final code `7505e0b` in one session. All six deliveries passed independent live-model gates and the exhaustive clamp oracle; recorded output decreased **51.07%** and summed case wall decreased **15.88%**. The repaired code, rebase onto `dc606777150ef8143d7bba4dbc24baac2110c0b4` and independent regressions pass. Historical staged measurements do not substitute for this final-code pair.

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
- Model authentication now uses the user's Codex home in place, while explicit CLI arguments match the original stage's model and high effort and disable MCP/multi-agent integrations. Runtime writes remain in temporary storage; native usage covers every completed model call in the accepted pair.

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

The supplied implementation harness was rerun sequentially, **before then after in one session**, on its unchanged three-case `workload.json`. The preserved baseline race source matches `77a60b0` byte-for-byte apart from its relocated store import. The after phase imports final `src/cli-race.ts` at `7505e0b`, including the rebase and independent completion fix. As the supplied harness specifies, both phases share the final scheduler and actual built ship-setup CLI; the imported race orchestration is the code variable. No staged extension was rerun or substituted for this pair.

| Frozen workload | Before output tokens | Before wall s | Delivered / gate | Final-code after output tokens | After wall s | Delivered / gate |
|---|---:|---:|---|---:|---:|---|
| normal-a | 713 | 62.455 | A / pass | 294 | 37.031 | A / pass |
| normal-b | 806 | 54.344 | B / pass | 262 | 39.154 | B / pass |
| repair | 956 | 51.441 | A / pass | 655 | 65.336 | A / pass |
| **Total** | **2,475** | **168.239** | **3/3 gated** | **1,211** | **141.521** | **3/3 gated** |

Recorded output fell **51.07%** and summed case wall fell **15.88%** on this pair. `repair` was 27.01% slower. All six deliveries passed both model-reviewed criteria and the separately executed exhaustive **105-input** clamp oracle. The baseline pays both candidates' final gates and necessary repairs before comparison; final code compares authored snapshots first and pays only the selected candidate's final gate/repair on these cases. Per-call receipts and stage calls remain in the raw results. This is one sequential paired sample: provider variability, cache warmth and measurement order can affect tokens and wall time. It establishes bounded review/comparison cost payback, not full authoring savings or population selection accuracy.

Raw harness results are committed as `docs/race-cost/measurements/before.json` and `docs/race-cost/measurements/after.json`. They retain every case's delivery record, gate verdict, executable oracle, authored/repaired snapshots, calls, timing receipts and native `turn.completed` usage. Metadata records the shared session `44e821f8-3e26-491d-a177-300334acaf66`, CLI version `codex-cli 0.162.0`, exact model arguments, workload and source hashes, final revision and timestamps. Harness/environment hashes and settings were checked equal across the pair. Raw per-call prompts, JSONL events, final responses and stderr remain in `.cache/race-cost/implement/authenticated-verified-before/` and `authenticated-verified-after/`; direct phase receipts are `.cache/race-cost/authenticated/pair-receipts.json`. **Both phase exit codes: 0.**

Authentication used the user's **`CODEX_HOME=/home/qian/.codex` in place**, explicitly set by `RACE_COST_MODEL_HOME`. No credential file was manually opened, copied or printed. The original implementation invocation record confirms model `gpt-6.1-sol`; both phases use that model and effort **high**. `--ignore-user-config` avoids the home's effort-max, MCP, multi-agent and service-tier settings; the explicit empty MCP table and app/plugin feature disables also prevent default remote MCP clients. Both phases use the same CLI, inherited host network, CPU affinity 2–5, private fixture-store/home construction and shared temporary model runtime. Model execution is ephemeral and read-only, with shell snapshots disabled.

The session command was:

```sh
unshare -Urm python3 .cache/race-cost/authenticated/namespace.py python3 .cache/race-cost/authenticated/run-pair.py
```

The runner creates one shared temporary runtime/session and invokes, sequentially for `PHASE=before` then `PHASE=after`:

```sh
RACE_COST_MODEL_HOME=/home/qian/.codex RACE_COST_RUNTIME="$RUNTIME" RACE_COST_SESSION="$SESSION" \
  taskset -c 2-5 python3 .cache/race-cost/authenticated/write-boundary.py \
  node --import tsx .cache/race-cost/implement/measure.ts "$PHASE" "authenticated-verified-$PHASE"
```

Every live model call uses the following exact flags (its scratch directory is cwd, `prompt.txt` is stdin, and `last.txt` is its explicit output path):

```sh
CODEX_HOME=/home/qian/.codex codex exec --json --ignore-user-config --ephemeral \
  -s read-only --skip-git-repo-check -m gpt-6.1-sol \
  -c 'model_reasoning_effort="high"' -c 'features.multi_agent=false' -c 'mcp_servers={}' \
  -c 'features.apps=false' -c 'features.plugins=false' -c 'features.remote_plugin=false' \
  -c 'features.shell_snapshot=false' -c "sqlite_home=\"$RUNTIME/sqlite\"" -c "log_dir=\"$RUNTIME/log\"" \
  -o "$SCRATCH/last.txt" -
```

Model-call HOME/USERPROFILE use the private fixture home; TMPDIR and XDG cache/data/state paths use the shared temporary runtime. A private **mount-only** namespace retains host networking and hides the user's CLI runtime identity and CLI temporary directory behind fresh temporary storage; the original identity file is never opened. Inherited Linux Landlock rules limit mutations to this worktree, temporary storage and `/dev/null`. This also blocks writes under `~/.fc` and to the original Codex home. Codex's model-cache write warnings were nonfatal and are retained in stderr; model calls authenticated and completed. No Chrome or MCP server was started, and no FlowCrew process or daemon was signaled.

The successful pair spent **3,686 model output tokens** in **26 completed model calls**: before **2,475**, after **1,211**. Native usage also records **388,122 input tokens**, including **316,160 cached input tokens** (a subset, not an additional token charge); input plus output is **391,808** recorded tokens. Frozen authors/repairs spend zero model tokens. These are usage receipts, not billing estimates.

The original empty-home HTTP 401 attempt remains in `.cache/race-cost/measure-final.log`. Setup attempts in this follow-up failed first at MCP-config parsing, then at a blocked runtime-identity write, and then at provider routing in an accidentally isolated network namespace. Their logs/receipts are retained as `config-preflight-failed`, `boundary-preflight-failed`, `trace-preflight-failed` and `offline-preflight-failed` under `.cache/race-cost/authenticated/`. They produced no completed-turn usage and no complete paired measurement; no failed attempt is treated as a zero-token successful race. Only the successful pair above is used for acceptance. Earlier six-case pre-rebase figures remain historical in the original run's evidence, not current final-code measurements.

**3. Comparison inputs and independent choice evidence**

Comparison text is the unchanged original brief plus both complete ordinary-authoring diffs, including new files, excluding declared outputs and truncating each at the existing cap (`src/cli-race.ts:135`, `src/cli-race.ts:216`). It is asked as A/B and B/A with unchanged instructions (`src/cli-race.ts:57`, `src/cli-race.ts:140`). Both answers must agree after label mapping; invalid, missing, repeated-order and position-driven answers use stable author order followed by independent gating (`src/cli-race.ts:45`).

An independent final-selector replay on the exact twelve recorded authored/repaired pairs exited 0:

```sh
timeout 60s node --import tsx .cache/race-cost/selection-independent.ts
```

Twelve pairs, byte-identical comparison prompts in both orders, zero executable-oracle regressions, zero model calls/tokens. Old complete eligibility on authored snapshots is hypothetical in this replay; old repair counts come from the measured baseline. In the repaired `normal-b` and `staged-normal-b` pairs, the old selector chooses B and the new fallback chooses A, but both revisions pass every oracle input. On the five authored pairs with exactly one correct candidate, both selectors choose the correct candidate. The `repair` authored pair has no passing snapshot, so it establishes repair/final gating rather than correctness preference. Receipt: `.cache/race-cost/selection-independent.json`.

The rejected-prefix regression is independently covered by `spec/race-workflow.test.ts:141`: A and B initially agree, differ only after their prerequisite review, both finish before comparison, and only the preferred candidate executes the final gate. Both winning directions pass. The prerequisite-repair, preserved-round and exhausted-budget cases are at `spec/race-workflow.test.ts:172`, `:183`, and `:196`. The additional completion regression is at `spec/race-workflow.test.ts:159`: the supported DAG completes after its gate and final author; both finished diffs are compared and the preferred effectively gated candidate is delivered without repeated execution.

Before the independent completion fix, the new regression command exited 1 (`expected 1 to be +0`); after the fix the full targeted command exited 0 with 5 files and 66 tests. Raw receipts: `.cache/race-cost/complete-regression-before.log` and `targeted-fixed.log`. The authenticated final-code direct workload is now measured in item 2. No general population accuracy claim, full model-authoring savings, default-supervisor cost or live dynamic-planner/research cost is established.

**4. Net lines and architecture**

`git diff dc60677 --numstat -- src spec config` gives:

| Tree | Added | Deleted | Net |
|---|---:|---:|---:|
| src | 137 | 57 | +80 |
| spec | 354 | 48 | +306 |
| config | 0 | 0 | 0 |

The report itself is outside these trees. Source additions reuse parked-run continuation, normal gate facts, DAG reachability and durable repair artifacts. They replace routine loser final verification, newest-run discovery and repair-count preference. One internal hold flag and one internal quick argument remain. This is an explicit source-growth exception to AGENTS.md, supported by the authenticated final-code paired output/wall savings in item 2 and the passing scheduler regressions. No additional workflow, gate implementation, credential route or isolation mode was introduced.

**Clause-by-clause independent verdict**

| Clause | Verdict | Evidence |
|---|---|---|
| Two independent candidates of the brief; preferred delivery | PASS | `src/cli-race.ts:113`, `:122`, `:140`, `:174`; `spec/race.test.ts:70`, `:178` |
| Deliver only a change passing independent gates | PASS | Effective gate facts at `src/cli-race.ts:166`, `:212`; oracle-backed scheduler tests at `spec/race-workflow.test.ts:115`, `:207` |
| Comparison at least as reliable | PASS on the bounded same-pair evidence; population claim unmeasured | Twelve-pair replay exit 0, unchanged two-order prompts, downstream-distinction regression at `spec/race-workflow.test.ts:141`; authenticated final-code three-case gates/oracles pass in item 2 |
| Avoid discarded loser review/repair | PASS for deferrable final work; prerequisite/fallback expenditure retained | `spec/race-workflow.test.ts:115`, `:141`, `:172`, `:159`; mandatory prerequisites cannot be removed without compromising full comparison inputs |
| Preferred candidate fails: gated alternative or reason none passed | PASS | `spec/race-workflow.test.ts:219`, `:226`; `spec/race.test.ts:114`, `:121`, `:130` |
| Each assigned criterion and supplied score independently meets its line | PASS | Omitted criterion and score-zero false-pass regressions: `spec/race-workflow.test.ts:233`, `:239`; existing gate readers remain unchanged |
| Text-only comparison in both orders | PASS | `src/cli-race.ts:57`, `:140`, `:229`; `spec/race.test.ts:70`, `:96`; byte-identical replay prompts |
| Read-only ~/.fc; no prohibited files or process signals | PASS | Only named brief/review/evidence/config and project copies were read; no credential files manually opened/copied/printed; Codex authenticates in place with original runtime identity hidden; writes confined to worktree/temp; no FlowCrew processes signaled |
| Isolation and credential protection do not weaken | PASS | Unchanged ship-setup and sandbox/stage paths; unchanged gate readers; `src/cli-race.ts:113`, `:212`, `:216`, `:229`; approval parks remain ineligible (`spec/race-workflow.test.ts:245`) |
| Review attempt 1: comparison before distinguishing author work | RESOLVED | `stage-batch.ts:30` retains prerequisite gates; both finishing authors appear in the comparison in both winner directions; targeted 66-test command exit 0; completed-after-gate case additionally fixed |
| Report item 1: per-race and pooled accounting | PASS | Table and independent ten-race reconciliation exit 0 |
| Report item 2: paired final-code output tokens, wall, delivery and gate | PASS | Authenticated same-session before/after raw results committed; both direct exits 0; 6/6 gates and exhaustive oracles pass; model usage reconciles |
| Report item 3: inputs and same-pair choice evidence | PASS, bounded | Twelve-pair replay exit 0 and scheduler regressions; no population threshold invented |
| Report item 4: net lines in src/spec/config | PASS | Exact current-main numstat above |
| Report item 5: full configured validation after last report write | PASS | Four direct exit codes 0 and 243 files / 2746 tests; commands repeated after the final report write as recorded below |

**5. Configured validation and direct exits**

The full configured set passes. Every command below is repeated after this report’s final tracked write and before the follow-up commit. Direct subprocess return codes and full logs for that repetition are retained in `.cache/race-cost/authenticated/validation/receipts.json` and its adjacent logs. The accepted model pair is the successful authenticated run in item 2; failed setup attempts remain separate evidence.

| Command | Direct exit code | Result |
|---|---:|---|
| `taskset -c 2-5 npm run build` | 0 | Backend and transactional UI build |
| `taskset -c 2-5 npm run build:ui` | 0 | Full configured UI build |
| `taskset -c 2-5 npm run lint` | 0 | Zero errors; 12 existing warnings |
| `taskset -c 2-5 npm test` | 0 | **243 files and 2746 tests passed** |

The initial targeted attempts exited 1 at the stale-dist guard before test execution; rebuilding resolved that guard. The intentionally failing completion regression exited 1 before its production fix. The independent selection replay exited 0, the fixed five-file targeted check exited 0 (66 tests), and the strengthened restatement/continuation spec exited 0 (18 tests).

The final verification also parses both committed measurement JSON files and checks `test -s docs/race-cost/report.md`, `git merge-base --is-ancestor dc60677 HEAD`, a follow-up commit after `7505e0b`, and an empty `git status --porcelain`. Build, UI build, lint and test are invoked in full with the requested CPU affinity, following the report’s last tracked write; no production or report files are modified after those checks.

All acceptance work is confined to branch `race-cost`, this worktree and temporary directories. Historical evidence under `/home/qian/.fc/runs/2026-10-10T17-53-28-1b2bd5` remains read-only. The report is committed by this independent acceptance task because the original FlowCrew run ended before its terminal report stage.
