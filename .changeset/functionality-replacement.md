---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-modules": minor
"@plurnk/plurnk-skills": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-schedule": patch
"@plurnk/plurnk-meta": patch
---

Add shared named definition replacement, retaining enabledness and preserving
the previous publication on refusal. Use it for repeated environment EDITs
and explicit child environment overrides, and reject fresh skill preparation
failures when their definitions change. Carry attempt-local admission data
through preparation without changing live state; schedule replacements and
retries affect timers and held delivery failures only after publication.
