---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

AG-UI: an accepted message is discoverable before its arrival (#1166).
`status.inbox` lists the accepted messages the bound Worker has not yet
observed; the snapshot carries the ones a client on the thread sent, with
`metadata.plurnk.published` false, and their arrival folds onto them; a
message Run admits its message before it presents anything, and no Run echoes
its input into a snapshot. Contracts and the service gain `readInbox`.
