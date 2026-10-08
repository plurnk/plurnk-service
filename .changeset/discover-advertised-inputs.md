---
"@plurnk/plurnk-modules": major
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": major
"@plurnk/plurnk-skills": major
"@plurnk/plurnk-schedule": major
"@plurnk/plurnk-mcp": major
"@plurnk/plurnk-a2a": major
---

A family's `discover` advertises only the inputs it serves. An adapter declares
`discovery.inputs` (and `emptyListsAll`), implements `discover` exactly when it
does, and the coordinator builds the discover input schema from that
declaration: any other input is refused 400 `arguments-invalid` by the shared
schema check, naming the field. A family without discovery has no `discover`
verb; MCP serves one only while `PLURNK_MCP_REGISTRY_URL` names a registry, and
contains an invalid registry setting. Members discovery takes `query` alone and
refuses a query naming no path or pattern as `query-invalid`; an empty env
discovery is the whole catalog and needs no body. The refusals
`query-unsupported`, `configuration-unsupported`, `source-unsupported`,
`registry-not-configured`, `query-required` and schedule's `source-required`
are gone.
