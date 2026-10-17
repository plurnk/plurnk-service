---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-modules": patch
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-a2a": patch
"@plurnk/plurnk-skills": patch
"@plurnk/plurnk-schedule": patch
---

`FunctionalityPrepared` gains a required synchronous `publish()` returning an
undo. Candidate state goes live there, inside the coordinator's registry
commit, with no I/O; `commit()` is post-publication settlement; `abort()`
discards an unpublished candidate. The coordinator composes the adapter's undo
with its own view rollback. MCP consumes a pending OAuth candidate at publish,
so a callback replayed after publication is `404 oauth-not-pending` with no
window (#1155).
