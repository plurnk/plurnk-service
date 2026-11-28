---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-parser": minor
"@plurnk/plurnk-auth": minor
"@plurnk/plurnk-mcp": minor
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-service": minor
---

Separate exterior actor durable identity (`id` / OIDC `sub`) from human
presentation (`handle`, optional `name`) across OIDC claim extraction,
`_meta.plurnk.actor` and client `plurnk.send`, `message://<session>/<handle>_<seq>`
key allocation, model packet rows (`## Log` and `## Open Work`), `LogEntryWire`
`repliedToActors`, and symmetric `actorProfile` / `actorProfiles` metadata on
ACP incoming and reply `session/update` events (#1586, #1600).
