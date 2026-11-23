---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-schedule": patch
"@plurnk/plurnk-service": minor
---

Erase retired `rule: null` and raw string `run` schedule forms from
`@plurnk/plurnk-contracts`, share canonical `ScheduledToolCall`,
`ScheduledStepReceipt`, `ScheduleStatus`, `tokenizeSlashArgs`,
`formatScheduleInspect`, `formatScheduleStepReceipts`, and `SCHEDULE_ADD_FLAGS`
across contracts, schedule, and ACP, and align `/schedule` ACP slash dispatch
with quote-preserving tokenization, `show`/`inspect`, and per-step receipts
(#1558).
