---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-acp": major
"@plurnk/plurnk-service": major
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-schedule": patch
---

Normalize all wire and ApplicationPort projections to camelCase (`LogEntryWire`,
`ApplicationStream`, `ApplicationSessionProjection`, `listWorkspaces`, and
`session.loops` `{ opening, continued, lifecycle, source }`), drop redundant
dual wire keys on `session/list`, `workspace.create`, and `workspace.attach`,
and rename the child-model config option, port methods, notification field, and
SQLite v29 schema column to `child` / `childModel` / `child_model_route_id`
(#1559).
