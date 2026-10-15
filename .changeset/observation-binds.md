---
"@plurnk/plurnk-agui": minor
---

A passive observation, a synchronization Run or `/agui/connect` that does not
claim the worker, binds an existing workspace and worker and creates neither
({§agui-sync}); an owner's control connection binds as a message Run does. For
a passive observation a missing workspace is 404 `workspace-not-found`, and a
name that holds no model worker is 404 `worker-not-found`. A new
`forwardedProps.plurnk.worker` names the observed worker exactly, independent
of the `threadId`, read fresh on every Run; it belongs to observation alone,
and elsewhere it is 400 `worker-invalid`. The workspace's default worker,
bound by the `threadId` equal to its name, stays its own.
