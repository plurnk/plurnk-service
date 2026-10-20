---
"@plurnk/plurnk-agui": minor
---

A Run that submits nothing may name the interrupts its client holds,
`forwardedProps.plurnk.interrupts`: it does not present those gates again, waits
on them, and finishes with `RUN_FINISHED` success when one settles, or at once
when one is no longer pending, so every view of a worker converges on one
decision ({§agui-held-interrupts}).
