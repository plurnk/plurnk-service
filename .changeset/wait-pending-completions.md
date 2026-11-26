---
"@plurnk/plurnk-service": patch
---

Report `Pending results are ready. Continuing.` instead of
`Nothing is in flight. Continuing.` when `WAIT` runs while closed streams or
concluded children/replies still have undelivered terminal results queued for
the next turn boundary (#1584).
