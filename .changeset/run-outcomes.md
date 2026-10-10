---
"@plurnk/plurnk-execs": minor
"@plurnk/plurnk-execs-common": patch
"@plurnk/plurnk-service": minor
---

Treat a command's exit code as its answer: a subprocess that exits resolves
200 with its `exitCode`, zero or not, with no Problem, so a failing test run or
a `grep` that matched nothing no longer appears in Errors. A process ended by
a signal nobody sent it is a `terminated-by-signal` failure.

Report a failed execution once: its status and Problem ride one conclusion
row, and its other channel rows are plain reads. A stream stopped by its
holder's own KILL concludes 200 instead of a 499 cancellation; a cancellation
the holder did not ask for keeps its 499. A tool named as a shell command is
core's `404 program-is-a-tool` receipt.
