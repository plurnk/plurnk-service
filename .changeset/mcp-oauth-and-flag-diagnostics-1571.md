---
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-service": patch
---

Settle model `authorization-required` Functionality mutations immediately with
their `202` JSON handoff body (terminal `200` execution status), preserve
in-flight dynamic-loopback MCP OAuth pending attempts across unchanged
re-enable, surface bounded secret-redacted `diagnostic` details on
`oauth-callback-invalid` Problems (#1571), and reject non-boolean `enabled` and
non-`true` `remove` control flags with field-specific `400 arguments-invalid`
diagnostics (#1572).
