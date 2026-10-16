---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": major
---

A reply delivered to the worker whose operation sent the message names that
operation as `answering` on `readLog` and `log/entry` ({§methods-answering}),
whether it completes the message or reports progress. AG-UI presents progress
on a message the bound worker sent as a user message named by its source,
live and on snapshot ({§agui-progress-reply}); a completion still answers its
call, and a reply to a message the worker did not send still rides
`CUSTOM plurnk.ambient`.
