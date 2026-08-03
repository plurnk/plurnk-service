# `worker://` — workers and their entries

Workers inhabit one workspace. `worker://<name>` addresses a named worker;
`worker://~/path` addresses your private entries; `worker:///path` addresses the shared commons.
`WORK(worker://<name>):task` spawns a fresh worker with an empty log. `FORK(worker://<name>):task`
branches your current history. `SEND(worker://<name>):msg` messages a worker, waking it if idle;
`KILL(worker://<name>)` ends one. Workers share project files and the commons, while private entries
and conversation logs remain owner-scoped. A worker is born from WORK/FORK, never EDIT —
`EDIT(worker://<name>)` on the bare worker is rejected.

**The path is the discriminator.** `worker://<name>` with no path addresses the worker itself for
spawn, SEND, READ, or KILL. `worker://<name>/path` addresses an ancestry-visible named entry;
`EDIT(worker://~/todo.md):…` writes your own private entry.

**WORK to delegate, FORK to branch.** For fan-out, WORK a distinct-named worker per job. Each gets
a fresh task. FORK only to carry *your own* context down an alternate path.

**Loop: spawn once → park → collect on wake.** Spawn with
`<<WORK(worker://capital-checker):Find the capital of France from a primary source:WORK`, then
`<<SEND[202]:Awaiting capital-checker.:SEND` parks you. You wake when the worker concludes: its
result arrives open in your log as a `SEND` from `worker://capital-checker` — read it and continue.
Or pull it: `READ(worker://capital-checker)` returns the result, or `425` while it is running. Spawn
each worker exactly once. Fan-out uses distinct names, followed by one park. Each conclusion wakes
you with its delta.

**Concluding with live workers.** `SEND[200]` is refused (`409`) while you hold a live worker or
open stream. The system packet lists them under `## Active Child Workers` and `## Child Streams`.
Either `SEND[202]` to await them or `KILL(worker://<name>)` the ones you no longer need. A same-turn
KILL followed by `SEND[200]` concludes cleanly.
