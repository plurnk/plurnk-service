---
"@plurnk/plurnk-contracts": patch
"@plurnk/plurnk-parser": patch
"@plurnk/plurnk-schemes": patch
"@plurnk/plurnk-service": patch
---

Preserve ECMAScript `\|` literal-pipe semantics in regex matchers, coerce
single-line `/` code literals on `plurnk.edit` under RENO, reject unanchored
empty-matching regex patterns on `plurnk.edit` with `422 pattern-empty-match`,
make `Slicer.lineMarkerEditBatch` and `editReceipt` linear-time with `[first,
last]` boundary compaction across synchronous and proposed edits, strip
internal `attrs` from serialized `rx` payloads, and guard entry/file/log payload
sizes against SQLite's 100 MiB content ceiling (#1474).
