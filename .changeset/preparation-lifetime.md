---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-modules": minor
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-agui": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-a2a": patch
"@plurnk/plurnk-skills": patch
"@plurnk/plurnk-schedule": patch
---

Functionality preparation receives the host's cancellation signal. Shutdown
refuses new demand and joins complete workspace activation, cooling, and
publication before resource disposal, including activation started by an AG-UI
owner attachment. Adapters cancel preparation I/O without publishing cancellation
as an unavailable resource; candidate cleanup and an already-started publication
finish normally. Genuine preparation and cleanup failures remain observable
({§functionality-preparation-cancellation}, {§module-shutdown-order}).
