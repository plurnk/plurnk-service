---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-agui": minor
---

`status.streams` lists the streams the bound Worker holds open, each with its
identity, lifetime, the row that opened it, and every channel's state, written
or not, so a client attaching mid-execution finds a silent one; it is
republished as `STATE_DELTA /plurnk/status/streams` when it changes
({§agui-status-streams}). `ApplicationPort.readStreams` reads it
({§methods-worker-streams}). `stream/event`'s `contentLength` counts Unicode
code points.
