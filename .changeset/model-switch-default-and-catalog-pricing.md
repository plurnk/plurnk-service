---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-models": minor
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-service": minor
---

Reset session reasoning effort to the target route's configured default on
model switches without an explicit effort, decouple child-model effort from the
parent session's effort, and expose catalog `cost` metadata alongside
`minInputPer1M`, `maxInputPer1M`, and `sort` (`selector`, `cost-asc`,
`cost-desc`, `context-desc`) filtering on `models.list` (#1587).
