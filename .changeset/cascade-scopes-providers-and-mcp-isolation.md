---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-modules": minor
"@plurnk/plurnk-providers": minor
"@plurnk/plurnk-mcp": minor
"@plurnk/plurnk-skills": patch
"@plurnk/plurnk-personas": patch
"@plurnk/plurnk-schedule": minor
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-service": minor
---

Advertise per-family Functionality scopes (`policy.familyScopes`), retire
`service.schedule.*` and `service.members.*` as workspace-only families, add
`models.providers` and `config/changed` discrete notifications for live
provider onboarding, and isolate MCP `${NAME}` expansion from daemon provider
credentials and `PLURNK_*` secrets (#1588).
