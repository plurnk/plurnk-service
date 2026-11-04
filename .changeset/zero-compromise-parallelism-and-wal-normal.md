---
"@plurnk/plurnk-service": patch
---

Default `PLURNK_SERVICE_EXEC_CONCURRENCY` to `availableParallelism()`, default
`PLURNK_SERVICE_SQLITE_SYNCHRONOUS` to WAL `NORMAL`, omit workspace residency
requirement for session-scoped Functionality verbs (`session.env.*`), bound
boot-time executor probing to `availableParallelism()`, skip redundant
`GitMembership` overlay walks when no workspace members are enabled, parallelize
`PluginSources` `lstat` discovery, and coalesce concurrent `WorkspacePlugins.read`
calls (#1401).
