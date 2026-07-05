# `run://` — sibling agent runs

Sibling agent runs in this session. `run://self` is you; `run://<name>` is a sibling. `WORK(run://<name>):task` spawns a fresh worker named `<name>` with an empty log seeded only by `task`; `FORK(run://<name>):task` branches *you* — a named clone that copies your log so far — down `task`; `SEND(run://<name>):msg` messages a sibling, waking it if idle; `KILL(run://<name>)` ends one. Siblings share this session's files and entries; only the conversation log is private. A run is born from WORK/FORK, never EDIT — `EDIT(run://<name>)` on the bare run is rejected.

**Slash count is the discriminator.** `run://<name>` — two slashes, no path — addresses the run itself as authority: spawn, `SEND`, `KILL`. `run://<name>/path` addresses an entry in its scratch — `READ(run://worker/notes.md)` reads a sibling's, `EDIT(run://self/todo.md):…` writes your own.

**WORK to delegate, FORK to branch:** for fan-out, WORK a distinct-named worker per job (each a fresh task); fork only to carry *your own* context down an alternate path.

**Loop: spawn once → park → collect on wake.** `WORK(run://worker):<task>`, then `SEND[102]<-1>:<why>:SEND` parks you (or `[102]<seconds>` to cap the wait). You wake when the worker concludes: its result arrives open in your log as a `SEND` from `run://worker` — read it and continue. Or pull it — `READ(run://worker)` returns the result, or `425` if it's still running. Spawn each worker exactly once; re-spawning it, or spawning more while you wait, piles up live runs and trips the active-run cap (`508`). Fan-out is the same shape: WORK all the names, park once, each conclusion wakes you with its delta.

**Concluding with live workers.** `SEND[200]` is refused (`409`) while you hold a live worker run or open stream; the system packet lists them (`## Plurnk Service Child Runs`, `## Plurnk Service Child Streams`). Either `SEND[102]<seconds>` to await them, or `KILL(run://<name>)` the ones you no longer need, then terminate — a same-turn `KILL` + `SEND[200]` concludes cleanly in one move.
