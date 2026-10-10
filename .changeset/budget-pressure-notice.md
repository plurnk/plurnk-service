---
"@plurnk/plurnk-service": minor
---

Warn the model before its context exceeds the budget: a packet above
`PLURNK_SERVICE_BUDGET_PRESSURE` that stays within its budget carries one
`budget_pressure` notice, "Context is at N% of budget. YOU MUST NOT exceed
budget.", its share taken from the Context gauge's own figures.
