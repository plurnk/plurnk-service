---
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-personas": patch
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-schedule": patch
"@plurnk/plurnk-schemes-http": patch
---

Bound transient in-memory caches and reclaim memory on workspace cooling and
retention sweeps: evict `MembershipMaterialization` settled-stat caches and run
`PRAGMA shrink_memory` in `WorkspaceResidency` and `Retention`, LRU-bound
cold-workspace persona reads and `llms.txt` origin attempts, evict archived or
empty workspaces from `Scheduler` RAM, clean up `#configurationNotices` on MCP
teardown, switch `_search-exclusion` to a single-entry cache, and add a
repeatable `npm run bench:memory` footprint benchmark (#1579).
