---
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-meta": patch
---

Resolve bulk EDIT and resource KILL selectors before mutation, preserving
per-resource approvals, scopes, anchors and receipts. Require a single resolved
resource for each COPY/MOVE glob operand before changing either side. Keep
selected channels through fan-out and count concrete operations against
configured command limits.
