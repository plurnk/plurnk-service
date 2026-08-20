# `worker://` — workers and their entries

## Summary

Coordinate workers and manage shared or private workspace entries.

Workers inhabit one workspace. `worker://<name>` addresses a named worker; `worker://~` is the
current-worker control sigil; `worker://~/path` addresses your private entries; `worker:///path`
addresses the shared commons.
`## WORK0 (worker://<name>)` with a task body spawns a fresh worker with an empty log.
`## FORK0 (worker://<name>)` branches your current history. `## SEND0 (worker://<name>)`
with a message body wakes and messages a worker; `## KILL0 (worker://<name>)` ends one.
Workers share project files and the commons, while private entries
and conversation logs remain owner-scoped. A worker is born from WORK/FORK, never EDIT —
`## EDIT0 (worker://<name>)` on the bare worker is rejected.

**The path is the discriminator.** `worker://<name>` with no path addresses a literal worker name
for WORK, FORK, SEND, READ, or KILL; `worker://~` addresses the caller for SEND or KILL.
The control form is exact: a trailing slash, userinfo, port, query, fragment, or request metadata
is invalid rather than ignored.
`worker://<name>/path` addresses an ancestry-visible named entry; `## EDIT0 (worker://~/todo.md)`
with a body writes your own private entry.

**WORK to delegate, FORK to branch.** For fan-out, WORK a distinct-named worker per job. Each gets
a fresh task. FORK only to carry *your own* context down an alternate path.

**Loop: spawn once → park → collect on wake.** Spawn and park with:

```plurnk
## WORK0 (worker://capital-checker)
Find the capital of France from a primary source

## SEND0 [202]
Awaiting capital-checker.
```

You wake when the worker concludes: its
result arrives open in your log as a `SEND` from `worker://capital-checker` — read it and continue.
Or pull it with `## READ0 (worker://capital-checker)`; it returns the result, or `425` while running. Spawn
each worker exactly once. Fan-out uses distinct names, followed by one park. Each conclusion wakes
you with its delta.

**Concluding with live workers.** `## SEND0 [200]` is refused (`409`) while you hold a live worker or
open stream. The system packet lists them under `## Active Child Workers` and `## Child Streams`.
Either `## SEND0 [202]` to await them or `## KILL0 (worker://<name>)` the ones you no longer need.
A same-turn KILL followed by `## SEND0 [200]` concludes cleanly.
