---
"@plurnk/plurnk-service": patch
---

Enforce `PLURNK_MEMBERS_AUTO_ADD` as a monotonic ceiling key in `ConfigPolicy`
so a host-level `PLURNK_MEMBERS_AUTO_ADD=0` lockout cannot be widened to `1`
via `service.config.set` (#1595).
