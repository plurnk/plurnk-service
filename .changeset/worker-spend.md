---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

A Run's status carries `spend`: every settled provider request of the bound
worker and its descendants since the worker began ({§agui-status-spend}). It
replaces `descendants`, which counted only the children's spend during the
current loop, so a client that attaches to a worker shows what the worker has
cost so far rather than what one connection watched. The application port's
`workerAccounting({ workspaceId, workerId })` replaces `descendantAccounting`
({§methods-worker-accounting}).
