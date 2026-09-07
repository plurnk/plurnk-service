# `worker://` — workers and their entries

## Summary

Coordinate workers and manage shared or private workspace entries.

Workers inhabit one workspace. The authority selects a worker; a path selects
an entry rather than controlling that worker.

| Address | Meaning | Model access |
| --- | --- | --- |
| `worker://reviewer` | Named worker | WORK/FORK create; SEND messages; READ collects; KILL terminates. |
| `worker://~` | Current worker | SEND or KILL. |
| `worker://~/notes.md` | Your own entry | Read and write. |
| `worker://reviewer/notes.md` | Named worker's entry | Any worker in the workspace can READ; named spaces are read-only. |
| `worker:///notes.md` | Shared commons entry | Read and write. |

Workers share project files and the commons. Own-space entries have separate
ownership, not secrecy from other workers in the workspace; conversation logs
remain owner-scoped. `_plurnk/` entries are generated and read-only even in your
own space. EDIT creates or changes an entry, never a worker.

Control addresses contain only scheme and authority: no trailing slash,
userinfo, port, query, fragment, or `{metadata}` modifier.

**WORK to delegate, FORK to branch.** WORK starts a fresh log with your task
prompt; FORK copies your history and own-space entries, then diverges. Both
share the project filesystem. Give simultaneous jobs distinct names; use SEND
to give an existing worker a follow-up task.

**Continue or wait.** You can keep doing useful work with `### SEND0 (NEXT)`
while children run. Use WAIT when you need their results before proceeding:

```example
### WORK0 (worker://capital-checker)
Find the capital of France from a primary source

### SEND0 (WAIT)
Awaiting capital-checker.
```

WAIT accepts `<timeout,poll>` in whole minutes. It continues the same task;
neither a deadline nor a poll repeats a message or command.

| Scope | Wake condition |
| --- | --- |
| Omitted / `<-1>` | Existing work completes or a message arrives; inherit open streams' polling. |
| `<60>` | Also wake after at most 60 minutes, even without other work. |
| `<-1,60>` | Also wake after 60 minutes to observe; no wait deadline. |
| `<60,0>` | Deadline or an event; no periodic stream observation. |

A wake ends that wait. Submit another WAIT to wait again. Waking retains the
task's prompts and turn allowance; NEXT continues immediately, TERM concludes,
and FAIL abandons the task. An untimed WAIT with no remaining work concludes.

Each child task's conclusion reaches its parent automatically as a log `SEND` from
`worker://capital-checker`, waking a waiting parent. Success includes the body;
failure preserves its status and Problem. `### READ0 (worker://capital-checker)`
collects the same result explicitly. While the child is running it returns
`425`; submitting NEXT then waits for delivery rather than polling.
A result does not imply that every task in that worker has finished.

**Concluding with live workers.** `### SEND0 (TERM)` is refused (`409`) while you hold a live worker or
open stream. The packet lists them under `## Active Child Workers` and `## Child Streams`.
Either `### SEND0 (WAIT)` to await them or `### KILL0 (worker://<name>)` the ones you no longer need.
KILL settles before the turn's disposition; other live work or unobserved
results can still prevent TERM.
