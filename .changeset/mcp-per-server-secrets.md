---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-modules": minor
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-mcp": minor
"@plurnk/plurnk-acp": minor
---

Add per-server encrypted MCP secret storage
(`{service,workspace}.mcp.secrets.{list,set,unset}`) with
`workspace > service > env` precedence, live connection refresh, diagnostic
redaction, and client-ownership protection against model mutations (#1590).
