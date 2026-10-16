---
"@plurnk/plurnk-agui": major
---

`CUSTOM plurnk.row` and `CUSTOM plurnk.send` are gone. A row's facts ride the
standard metadata of the part it builds ({§agui-plurnk-metadata}), a speech's
signal and status among them. A row that builds no part of the conversation
rides `CUSTOM plurnk.ambient` whole ({§agui-ambient}), and an emission the
daemon rejected now rides it too.
