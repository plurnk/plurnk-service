---
"@plurnk/plurnk-service": patch
---

Keep catalog filtering, failure counts, and arrival checks in SQLite. Prune an
entry after channel deletion only if it is still empty at the write boundary.
