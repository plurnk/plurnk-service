---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-auth": minor
"@plurnk/plurnk-acp": minor
---

Add `PLURNK_AUTH_DELEGATES` and `canDelegateActor` bearer claim support so
authenticated bridges can attribute non-default exterior `_meta.plurnk.actor`
speakers while keeping ordinary users pinned to their JWT `sub` (#1566).
