---
"@plurnk/plurnk-service": minor
---

Text the model writes outside its fences, beside at least one fenced operation,
is its NOTE at that position: one NOTE per span between operations, frozen in
the emission, landed as a NOTE row, replayed with its turn, and told nothing
about; an echoed emission heading in that text is dropped, not annotated. A turn
that fences no operation keeps its text as the turn's outside source and stays
an empty turn with its one error row, which is the only thing the model hears of
it. The `outside_text` notice is gone.

The per-turn rule is the card's line, `YOU MUST emit at least one NOTE operation
with a complete status summary and at least one other operation per turn.`, and
the daemon's `continued_without_note` and `noted_without_operation` notices
quote it; both are notices at warn, never strikes.

A line scope on an emission row addresses its legend: the NOTEs on the selected
lines retire and the row stays; on a row with no legend lines the scope is
refused with `emission-curated-whole`, whose recovery names the unscoped KILL,
the one form that retires the row.

The opening survey begins by reading its own program (`READ
(ops://<worker>/<loop>/1)`), so the log carries one program verbatim and every
`ops://` turn is shown readable.
