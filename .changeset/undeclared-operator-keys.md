---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-providers": patch
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-a2a": patch
"@plurnk/plurnk-schedule": patch
"@plurnk/plurnk-skills": patch
---

A `PLURNK_*` key the operator's configuration file sets and no installed package
declares is named at startup and by `config check`; nothing is refused.
Each package panel declares the key families it reads by computed name, such as
`# PLURNK_MCP_<alias>=<definition>`.
