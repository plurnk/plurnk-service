---
"@plurnk/plurnk-mcp": minor
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-a2a": patch
"@plurnk/plurnk-skills": patch
"@plurnk/plurnk-service": minor
---

A workspace's MCP servers are prepared at once, so activation waits for the
slowest server rather than the sum of them ({§mcp-setup}). A family reports
the aliases it is preparing with `progress(aliases)`; the workspace's
preparation status lists each alias in flight from the time it began, and an
alias leaves as it settles ({§functionality-preparation-visibility}).
