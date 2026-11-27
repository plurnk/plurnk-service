---
"@plurnk/plurnk-modules": minor
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-mcp": minor
---

Add opt-in `secret: true` support on `service.env.{add,replace}` entries stored
encrypted outside SQLite via `ServiceSecretStore` (`env-secrets.enc`), omitted
from `workspace.env`, `session.env`, `env:///`, command execution, and
`plurnk-service share`, and expanded strictly via explicit `${NAME}` references
in operator-host and `service`-origin MCP servers with diagnostic redaction
(#1589).
