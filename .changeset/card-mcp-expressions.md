---
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-parser": minor
"@plurnk/plurnk-execs": minor
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-acp": patch
"@plurnk/plurnk-providers": minor
"@plurnk/plurnk-schemes": patch
"@plurnk/plurnk-mimetypes-text-markdown": patch
"@plurnk/plurnk-digest": patch
"@plurnk/plurnk-meta": patch
"@plurnk/plurnk-service": patch
---

Unify model-facing syntax, parser diagnostics, Problem codes, and teaching on MCP
expressions (`<mcp>.<tool>({}) // aside`), renaming `PlurnkParser.NO_VALID_EXPRESSION`,
`ToolInputSchema.expression`, `ToolResources.expression`, `hasCompleteExpressionContent`,
and `invalid-expression-syntax`, and aligning Turn-0 MCP catalog asides (#1475).
