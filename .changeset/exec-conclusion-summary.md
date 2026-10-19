---
"@plurnk/plurnk-service": patch
---

An execution's `stream/concluded` summary sizes only the channels its executor
declares and reads how it ended from the settled result: `completed`, with any
exit code, for a success, and the Problem's title in lowercase for a failure
({§exec-conclusion-summary}).
