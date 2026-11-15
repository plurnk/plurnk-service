---
"@plurnk/plurnk-service": patch
---

Settle each admitted execution statement across its own
`PLURNK_SERVICE_OPTIMISTIC_WAIT_MS` window in authored batch order, reconcile
workspace file membership and snapshots before subsequent resource operations in
the same turn, acknowledge inline-settled spawns without prematurely waking
`plurnk.wait`, and enter `SessionProcess` completion coalescing when a
pre-park sibling completion coincides with remaining live obligations (#1473).
