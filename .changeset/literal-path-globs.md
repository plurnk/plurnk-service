---
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-meta": patch
---

Preserve literal backslashes and escaped glob characters consistently in resource
selection, file-URL selectors, membership scans, inspection and SQL membership
checks. Use the standard glob engine instead of Node's fixed separator handling.
