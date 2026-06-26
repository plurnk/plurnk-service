# `run://` — sibling agent runs

Sister agent runs in this session. `run://.` is you; `run://<name>` is a sibling. `EDIT(run://name):prompt` SPAWNS a new sibling seeded with that prompt; `SEND(run://name):msg` messages a sibling, waking it if idle; `COPY(run://.):prompt` FORKS — branches a run with your log so far, then continues it with the prompt; `KILL(run://name)` ENDS a sibling. Siblings share this session's files and entries; only the conversation log is private to each.

The slash count is the discriminator: **control** addresses the run by NAME as authority — `run://name`, two slashes, no path. **Storage** addresses an entry — `run://name/path` reads a sibling's private scratch, `run:///path` (three slashes, empty authority) writes your own. So `EDIT(run://worker):…` spawns a worker; `EDIT(run:///todo.md):…` writes a note to your own scratch.
