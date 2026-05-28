# Campaigns and Run Memory

Campaigns group related runs so FlowCrew can learn across attempts instead of treating every task as isolated.

## Campaign Signals

Each run can record:

- outcome
- metric name and value
- approach summary
- failure reason
- regression or plateau signals
- dead-end approaches
- suggested pivots

When a campaign shows repeated failure or no meaningful improvement, the next planner receives that context and can switch strategy.

## Run Memory Graph

Each run can write `knowledge_graph.json` with nodes and edges.

Common node types:

| Type | Meaning |
|---|---|
| `goal` | The objective being pursued |
| `approach` | Strategy selected for the run |
| `finding` | Evidence discovered while working |
| `result` | Measured outcome |
| `insight` | Reusable lesson from a stage or iteration |
| `dead_end` | Failed or forbidden direction |
| `user_hint` | Human guidance to preserve |

Edges describe relationships such as:

- `explored_by`
- `supports`
- `contradicts`
- `depends_on`
- `measured_as`

## Why It Matters

Run memory lets you answer:

- Why did the agent choose this approach?
- What evidence supported the result?
- Which approaches already failed?
- What should the next run avoid?

For long campaigns, this is the difference between iteration and repetition.
