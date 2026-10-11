---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-schemes": minor
"@plurnk/plurnk-digest": minor
---

Replay each turn of the loop as the NOTEs it wrote, in the model's own voice:
one assistant message between the turn's emission record and its results,
holding every content NOTE whole and in order. Every other operation is omitted;
its receipt in the log is its record and the program stays readable at `ops://`.
A replayed turn's emission row carries the legend of its NOTEs, one numbered
line per NOTE with its `log:///` path and weight, and those NOTE rows render
nowhere else; retiring a NOTE row retires it from the replay too. A turn that is
not replayed, an earlier loop or a program omitted at the wall, shows its NOTEs
as ordinary rows: a NOTE's text is in the packet once, as replay or as row.
Preserve native attachments, cache-prefix stability, capacity accounting, and
historical request roles.

Expose message roles in packet section drafts. Preserve retained packet sections
and their content-addressed items when upgrading the database.

Add a readable, ordered request artifact and show each turn's input role
sequence in the digest, distinguishing assistant input history from newly
emitted output.
