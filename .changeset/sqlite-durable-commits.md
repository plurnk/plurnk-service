---
"@plurnk/plurnk-service": patch
---

Default database commits to FULL WAL synchronization through SqlRite 6.6.1.
Expose PLURNK_SERVICE_SQLITE_SYNCHRONOUS for explicit durability/performance choices,
apply it before migrations and startup writes, and diagnose invalid modes through
configuration checking.
