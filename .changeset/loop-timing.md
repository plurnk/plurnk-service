---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

A Run's status carries the latest Loop's timing: `claimedAt`, when it first
ran, and `terminatedAt`, when it concluded, both Unix milliseconds and null
until they happen ({§agui-status-timing}). A client that attaches to a running
Loop measures its elapsed time from the daemon's clock instead of restarting
it. `ApplicationLoopProjection` gains `claimedAt`
({§application-loop-observation}).
