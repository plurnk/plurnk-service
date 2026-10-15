---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": minor
---

Each alias `providers.list` returns, and the snapshot's `plurnk.providers`, is the
route a worker seeded from that alias gets: `alias`, `provider`, `model` and, when
the model has an effort dimension, the alias's configured `effort` with
`effortSource: "default"`, exactly what that worker reads back
({§agui-provider-routes}). A client presents a worker no act has created yet with
the active alias's route, its effort included, and creates nothing to learn it.
