---
"@plurnk/plurnk-contracts": patch
---

The AG-UI conformance kit's status snapshot carries every field the daemon
sends: `waitUntil`, `children` and `descendants`. `OperationResult` no longer
forbids a top-level `error` member by name; producer-owned members remain open,
and a failure carries one Problem.
