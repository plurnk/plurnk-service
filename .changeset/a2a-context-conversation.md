---
"@plurnk/plurnk-a2a": major
---

An A2A Context is one conversation: its worker holds every Task, and each Task
is one of that worker's loops, so a later Task sees the caller's earlier
messages and the replies to them. A Context runs one Task at a time; a new Task
while one is open is refused with `UNSUPPORTED_OPERATION`.
