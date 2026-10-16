---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-modules": major
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-service": minor
---

Name the action scope that binds no workspace `daemon`, consistently in discovery,
module declarations, application contexts, and dispatch. Modules and clients must
use the new scope spelling. Workspace names remain mutable labels, distinct from
IDs and project folders; automatic names cannot consist only of digits.
