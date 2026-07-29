# `log://` - your worker's event history

Every operation is recorded at `log:///<loop>/<turn>/<seq>`. The row identifies what happened and what came back. READ a row to retrieve its result body or apply a content matcher.

## Log and catalog

- **Log** - operations and results in order.
- **Catalog** - `FIND(scheme:///**)` lists the resources a scheme currently holds.

## Visibility

- **FOLD** hides an open row's body. The row and body persist, and the row remains listed.
- **OPEN** reveals a folded row's body.
- A row's `tokens` is the size of its body: its current packet weight when open and its OPEN cost when folded.

OPEN and FOLD change packet visibility, not history. Applying the current state again or targeting a bodyless row is a successful no-op.

## Deletion and capacity

KILL permanently erases a log row.

The Budget section reports the packet ceiling, usage, free capacity, rendered log weight by turn, and the largest currently open bodies. If a packet exceeds its ceiling, the engine folds only the newest turn boundary. It never selects older history by relevance. Continued overflow follows the reported recovery or hard-413 contract.
