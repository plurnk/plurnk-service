---
"@plurnk/plurnk-agui": minor
---

A row's facts ride the standard metadata of what the row builds, live and on
snapshot alike ({§agui-plurnk-metadata}). That means a tool call, its result,
speech, and an arrival. `metadata.plurnk` is the row's durable `id`, `worker`,
`origin`, `source`, `signal`, `status` (the failure flag) and `attrs`, so a
standard client holds them without `plurnk.row`. The Run that submitted a
message, which already holds it, now receives its row's facts for it, as a
`TEXT_MESSAGE_START` and `TEXT_MESSAGE_END` without content.
