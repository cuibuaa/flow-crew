# Zero-token rehearsal

`flowcrew rehearse` is a pre-flight test for the contract between a brief and
the engine. It runs the real scheduler in temporary directories against a
deterministic scripted adapter, so it launches no model or agent CLI and spends
no tokens.

```bash
flowcrew rehearse examples/hello-research.brief.md
flowcrew rehearse path/to/brief.md --static-only
flowcrew rehearse path/to/brief.md --keep
```

The normal success footer is:

```text
✅ Contract ready
```

Warnings do not change the zero exit code. A contract failure prints `✗` and
exits nonzero.

The static section is the same transport-neutral inspection used by `quick`
and the Dashboard. It reports the exact input digest, input shape, frontmatter
status, contract readiness, and every criterion finding. It also says whether
live admission needs an explicit acknowledgement. That acknowledgement policy
does not turn `rehearse` into a denial gate: rehearsal keeps its diagnostic
exit contract, while live entrances may continue after the findings are shown
and the caller makes an explicit exact-input choice.

## Criterion wording lint

The static pass also warns when a sentence combines all three high-confidence
signals of an instrument-shaped criterion: mandatory language, an implementation
verb such as import/call/instantiate, and a code-shaped target such as an inline
code span, filename, call expression, API identifier, or a bare package name
directly bound to a module operation (for example, `must import jsdom`). The
warning prints the original line, explains that a gate may promote the means to
a hard assertion, and suggests rewriting it as an observable property or
marking the means as an example. The listed verbs and target shapes describe
the rule; they are not an exhaustive phrase blacklist.

Fenced code, quoted evidence, explicit example lists, and sentences marked
“这是例子，不是判据” (or equivalent English example wording) are excluded to
keep the signal quiet. This deliberately trades recall for low noise: an
instrument requirement split across distant lines may be missed. Conversely, a
real compatibility or security constraint that truly requires one exact API can
still look risky. Make that intent unambiguous by saying the exact means itself
is the criterion and alternatives do not count. A non-software sentence such as
“cargo must import goods” is another known false positive because a bare noun
after mandatory `import` is indistinguishable from an unquoted package name;
briefs should describe the observable data transfer instead. Criterion findings
remain warnings; they never turn an otherwise successful rehearsal into a
failure.

## What it validates

The static pass checks that:

- YAML frontmatter parses;
- a `research` block exposes its policy, baseline, result path, stop rules, and
  optional confirmation command;
- declared terminal statuses have paths and readable floor settings; and
- `terminal_states.ceiling_hit.floor.min_attempted_stages` is reachable under
  `research.stop.max_rounds`.

For a research brief, the default simulated pass then exercises the actual
scheduler and file pipeline:

1. a scripted planner writes a schema-valid `dispatch.yaml`;
2. scripted measurement stages write the configured `round_result` payload;
3. the engine validates `result_schema` and declared integrity floors, consumes
   each round, and journals it;
4. a synthetic decoy crosses `stop.beat`, forcing the ship path through
   `research.confirm`;
5. declining rounds drive the stop rules toward a ceiling and exercise any
   declared ceiling floor;
6. the rehearsal checks that the resulting terminal artifact exists and that
   no stage remains silently pending.

This proves terminal-path handling, confirmation wiring, stop-rule and floor
reachability, and the `round_result` pipeline. It also catches a result path the
engine never consumes, a schema or integrity rule that rejects every generated
round, and a confirmation path that never runs.

## What it does not validate

Rehearsal does **not validate research quality**. The scripted adapter has no
opinion about whether a proposed direction is novel, whether a metric is
scientifically sound, whether evidence generalizes, or whether a live agent can
perform the work. Synthetic values only prove that the control paths are wired.

It also does not prove that external services or real datasets will be
available during a live run. A confirmation command that unexpectedly succeeds
against the empty rehearsal project is reported as a warning because it may be
vacuous; the operator still has to inspect the command's assertion.

## Isolation and command safety

The command creates a disposable project and FlowCrew state directory, points
the store at that temporary state, and removes both unless `--keep` is passed.
It does not write into the project containing the brief.

`research.confirm.command` is nevertheless real shell text: the scheduler runs
it from the disposable project during the ship-path probe. Review an untrusted
brief before rehearsing it, or use `--static-only` to parse the contract without
executing the scheduler or confirmation command.

Engineering briefs are valid input. Without a `research` block, rehearsal runs
the static contract checks, emits a warning, and skips the research simulation.
