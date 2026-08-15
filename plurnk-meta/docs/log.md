# `log://` - your worker's event history

Every operation is recorded at `log:///<loop>/<turn>/<seq>`. The row identifies what happened and what came back. READ one exact row to retrieve its result body; use FIND to match across rows.

## Log and catalog

- **Log** - operations and results in order.
- **Catalog** - `## FIND0 (scheme:///**)` lists the resources a scheme currently holds.

## Visibility

- **FOLD** hides an open row's body. The row and body persist, and the row remains listed.
- **OPEN** reveals a folded row's body.
- A row's `tokens` is the size of its body: its current packet weight when open and its OPEN cost when folded.

OPEN and FOLD change packet visibility, not history. Applying the current state again or targeting a bodyless row is a successful no-op.

## Deletion and capacity

KILL permanently erases a log row.

The Budget section reports the packet ceiling, usage, percentage, and free capacity; negative
free capacity adds one curation alarm. Each log row exposes its curation weight as `tokens`. If a packet
exceeds the gauge, the engine records a nonterminal 413 Problem, folds eligible open rows from
the newest turn boundary, and tags them `overflow`; it never selects older history by relevance.
Remaining ruler debt may proceed when the request fits the hard context envelope; otherwise a
separate terminal 413 stops admission before generation.
