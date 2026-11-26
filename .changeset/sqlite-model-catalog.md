---
"@plurnk/plurnk-models": minor
"@plurnk/plurnk-service": patch
---

Store the Models.dev catalog in read-only SQLite via `@possumtech/sqlrite`
(`catalog.db` and `$XDG_CACHE_HOME/plurnk/models.db`) instead of eager JSON
snapshots, add indexed `listProviders()`, `listCatalogProviders()`, and
`queryCatalog()`, and back model catalog discovery with SQLite queries (#1576).
