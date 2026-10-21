---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

An address at the daemon has one HTTP form:
`GET /agui/<workspace>/<worker>/entry?target=<address>` answers the channel
the address selects, read from that worker's perspective through
`ApplicationPort.readEntryChannel` ({§agui-entry-route},
{§methods-entry-channel-read}). A result's body, a turn's reasoning and a
message's words travel by reference at it. A log row names its worker,
`worker_name` beside `worker_id` ({§methods-log-entry-wire}).
