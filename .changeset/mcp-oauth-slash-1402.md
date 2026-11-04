---
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-acp": patch
"@plurnk/plurnk-service": patch
---

Handle `/mcp oauth <alias> [callback-url]` in `parseFamilyCommand` and
`executeSlashCommand` via `workspace.mcp.oauth.begin` and
`workspace.mcp.oauth.complete` (#1402).
