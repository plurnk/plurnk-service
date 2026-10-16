---
"@plurnk/plurnk-agui": minor
---

A row's facts ride the standard metadata of what the row builds, live and on
snapshot alike ({§agui-plurnk-metadata}). That means a tool call, its result,
speech, and an arrival. `metadata.plurnk` is the row's durable `id`, its log
`coordinate`, `worker`, `origin`, `op`, `source`, `signal`, `status` (the
failure flag) and `attrs`, so a standard client holds them without
`plurnk.row`. Speech, which holds only its body, also carries its heading's
`aside` and the row's `receipt`. The Run that submitted a message, which
already holds it, now receives its row's facts for it, as a
`TEXT_MESSAGE_START` and `TEXT_MESSAGE_END` without content.

A bodiless WAIT is an ordinary tool call, its receipt the result, live and on
snapshot; a WAIT that carries a body still speaks it. Every call that opens no
obligation is answered by its receipt.
