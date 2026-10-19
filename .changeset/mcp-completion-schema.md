---
"@plurnk/plurnk-mcp": patch
---

A completion's parameters are read through the protocol's own schema
(`@modelcontextprotocol/core`, now a dependency); a malformed request is
refused with the schema's issues.
