---
"@plurnk/plurnk-service": patch
---

Prevent `DaemonLock` from self-deadlocking on stale same-PID lockfiles inside
restarted PID namespaces/containers (#1574) and redact embedded non-symbolic
credentials inside `PLURNK_MCP_<alias>` configuration overrides before
persisting to the lockfile or displaying in `config` (#1575).
