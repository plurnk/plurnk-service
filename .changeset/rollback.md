---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-service": minor
---

Rollback reverses a worker's settled file mutations after a log coordinate,
latest first, as the acting client's own operations:
`rollback({ workspaceId, workerId, clientWorkerId, to })` on the application
port, `workspace.rollback { to, workerId? }` for a client, and `RollbackReport`
naming what was restored, the rows skipped (no patch, or reversed already) and
where drift or a refusal stopped it (#880).
