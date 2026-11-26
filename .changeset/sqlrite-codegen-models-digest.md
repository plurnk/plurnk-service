---
"@plurnk/plurnk-models": patch
"@plurnk/plurnk-digest": patch
---

Generate `@possumtech/sqlrite` statement and parameter typings (`SqlRite.d.ts`)
from SQL sources in `plurnk-models` and `plurnk-digest`, consolidate
`scripts/sqlrite-types.mjs` across all three SQLite packages, and encapsulate
`plurnk-models` SQLite access behind `CatalogStore` (#1585).
