---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-acp": patch
---

Settle ended loop mailboxes atomically in SQLite with nullable `response_id`
`'DOWN'` `499` completions across all sender schemes, re-queue unreceived
follow-ups onto recovery loops, enforce open-loop and terminal-completion
baseline guards, and expose `ApplicationPort.readOpenMessages` as the single
open-message authority (#1467).
