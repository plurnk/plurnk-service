---
"@plurnk/plurnk-service": patch
---

A worker name lost to a concurrent claim is refused as `name-conflict` (409),
like any taken name, instead of escaping as an internal error.
