# Planner admission measurement

The planner checks its draft against admission itself before returning its result. The existing read-only
`plan-check` command now uses the same proposal inspector as scheduler injection and accepts the exact run context.
This replaces its separate parser/validator path. The prompt points at this installation's absolute CLI path and
uses the existing writable `$TMPDIR` capability. There is no extra scheduler attempt, durable draft slot or copied
rule catalog. The command reports admission facts without echoing the candidate stages.

The retry prompt already carries every error in the admission report. Proposal inspection now continues over
parseable stages when other stages are malformed, checks reachability alongside other refusals, and retains all
Zod issues. The generalized two-stage terminal-owner reproduction produces eight errors in one pass: a non-sink
owner, a missing mandatory gate ancestor and six missing criterion-gate ancestors. Its original admission kernel
already provided these diagnostics; the regression exercises their availability through the planner's current-run
check. All four new tests fail on the frozen main tree: three checks reject the unsupported `--run` option, and
one loses schema issues after the eighth issue. All four pass with the change.

The final matched live comparison used main `b67efc4b49dba17a649f80d65834b912e99a0e4d` and the changed engine on
2026-10-10. Each arm ran only `runStage` for the planner three times, with the installed real Codex model
`gpt-6.1-sol`, high reasoning, a fresh ephemeral session and a private `FC_HOME`. The foreground adapter passed the
resolved system and stage prompts to `codex exec --ephemeral --json` and used the engine's native JSONL usage parser.
Both arms used identical brief text, an empty synthetic project, the same configured role names, a plan-only workflow,
canonical brief criteria, persisted terminal-state context and writable scratch. No workflow scheduler, daemon task
or proposed work stage was started. Each stage attempt ledger contains exactly one attempt; each model process
exited 0. Draft checks and any in-attempt repairs are included in the token totals.

The public reproduction is `spec/fixtures/planner-admission/brief.md`: three create-only outputs, terminal_states
naming the report, six numbered report criteria and one mandatory independent review gate. Final returned dispatches
were scored with the shared proposal inspector against that same brief, workflow and state. Input counts include
cached input as reported by the native CLI; these are token totals, not a price estimate.

| Arm | Trial | First-attempt admission | Input tokens | Output tokens | Total tokens |
| --- | ---: | --- | ---: | ---: | ---: |
| Main | 1 | pass | 408,304 | 10,137 | 418,441 |
| Main | 2 | pass | 317,031 | 13,262 | 330,293 |
| Main | 3 | pass | 393,591 | 9,994 | 403,585 |
| Changed | 1 | pass | 153,464 | 9,261 | 162,725 |
| Changed | 2 | pass | 272,052 | 10,548 | 282,600 |
| Changed | 3 | pass | 200,850 | 8,825 | 209,675 |
| Main total | 3 | 3/3 | 1,118,926 | 33,393 | 1,152,319 |
| Changed total | 3 | 3/3 | 626,366 | 28,634 | 655,000 |

Admission count stayed at 3/3; total tokens fell 43.2%. The baseline planners also discovered the existing checker.
This small, unseeded sample supports exposing the existing command to reduce discovery and diagnostic cost. It does
not establish a higher admission rate, statistical significance or a guarantee that future models will follow the
instruction. Regression tests establish that every validator remains accessible through the same code and that
complete diagnoses reach both self-check and retry prompts.

There were also three exploratory real-model calls per arm before the matched comparison. Their baseline omitted
persisted terminal-state context, and the initial checker instruction requested an unwritable run-root draft path.
That check caught the capability problem; the final instruction uses existing scratch instead. These trials were
excluded for the harness/context differences, before the matched comparison was run, and remain accounted for here:

| Exploratory arm | Calls | First-attempt admissions | Input tokens | Output tokens | Total tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial baseline | 3 | 2/3 | 473,886 | 22,709 | 496,595 |
| Initial changed prompt | 3 | 3/3 | 1,192,236 | 33,542 | 1,225,778 |

Across final and exploratory trials, 12 real-model planner calls spent 3,529,692 tokens. Setup failures before a model
was invoked are not model trials. There were no scheduler planning retries in either comparison.

Full-suite verification also exposed an existing negotiation fixture that allotted only 50 ms to real planner setup.
The same test failed on main before any work adapter call. Its adapter already supplies a synthetic timeout result,
so it now uses the suite's existing pinned setup budget while still asserting the configured retry and doubled budget.
This changes no engine timeout policy.
