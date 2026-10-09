# Campaigns and Run Memory

Campaigns group related runs so FlowCrew can learn across attempts instead of treating every task as isolated.

## Campaign Signals

Each run can record:

- outcome
- metric name and value
- approach summary
- failure reason
- regression or plateau signals
- suggested pivots

When a campaign shows repeated failure or no meaningful improvement, the next planner receives that context and can switch strategy.

## Campaign ledger

The planner's prompt carries a compact ledger of the directions the campaign has already
tried: each round label from the campaign's research journals (`research_journal.json`) with
the best result measured for it, deduped across runs, and an instruction not to re-propose the
same mechanism. `--campaign-context=skip` drops the verbose prior-run block but keeps this
ledger.

The campaign page names the best measurement per metric, or says plainly when there isn't
enough evidence to name one, in its "Research measurements" panel.

## Why It Matters

Run memory lets you answer:

- Why did the agent choose this approach?
- What evidence supported the result?
- Which approaches already failed?
- What should the next run avoid?

For long campaigns, this is the difference between iteration and repetition.
