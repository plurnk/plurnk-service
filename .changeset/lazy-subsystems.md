---
"@plurnk/plurnk-mimetypes": minor
"@plurnk/plurnk-schemes": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-auth": patch
"@plurnk/plurnk-service": patch
---

Decouple `@plurnk/plurnk-mimetypes/runtime` from eager structural query
toolkits (`json-p3`, `@xmldom/xmldom`, `xpath`), lazy-load `@plurnk/plurnk-digest`
and `EvidenceReader` in daemon/CLI share paths, lazy-load `OidcVerifier` (`jose`)
in `@plurnk/plurnk-auth`, and defer `@modelcontextprotocol/client` / `server` /
`core` inside `@plurnk/plurnk-mcp` until MCP connections or `/mcp` requests
actually run (#1578).
