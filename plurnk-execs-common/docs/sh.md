# sh

A bare `EXEC` is the shell. The body is the command line, run via `sh -c`,
character-perfect including whitespace. `[sh]` names the shell explicitly.

## Environment

The command receives a **scoped** environment. Provider keys and every
`PLURNK_*` setting are stripped before the child starts, so `printenv` cannot
read plurnk's credentials. The project's environment passes through.

## Working directory

The working directory is the workspace project root — where file operations
write — or, in a workspace without one, the directory the shell would run in
anyway. A `{cwd=<directory>}` block on the heading overrides it for its body:

```example
### EXEC0 {cwd=./dir}
pwd
```

The receipt always names the directory the command ran in.

A script target runs that script: `### EXEC0 (greet.sh)` runs it with an empty
stdin; a nonempty body becomes its stdin. The interpreter reads the script
directly, so it needs no executable bit; a script path authored inside a shell
body still follows the kernel's ordinary executable-bit rules.

The target is a program — a script — never a command and never a directory. A
target that is not a script is refused before anything runs.

## Channels

Every shell invocation is host-effecting and proposes for review before it
runs. Output then streams under the emitted
`sh:///<loop>/<turn>/<sequence>` address: `#stdout` is the default channel and
`#stderr` is the second; both are `text/stream`. While it runs, Child Streams
reports each channel's size and growth and READ can inspect any range. On
completion, one terminal delta becomes visible. A nonzero exit closes with
status 500; inspect both channels
because either may carry the useful diagnostic.

## Deadlines & polling — `<timeout, poll>`

For a long-running command, the `<L>` slot carries `<TIMEOUT_SECONDS, POLL_SECONDS>` (both seconds):

```example
### EXEC0 <1800>
npm run build

### EXEC0 <1800,300>
npm run e2e

### EXEC0 <-1,300>
npm run test

### EXEC0 <-1,0>
tail -f app.log
```

The first coordinate is the timeout: a positive value kills at that deadline;
`-1` declines the deadline and the process outlives the loop — it runs until it
exits or you KILL it, so a server you must leave running takes `<-1>`; `0` keeps
the process only through the current turn. Anything without `-1` is reaped when
the loop ends. The optional
positive second coordinate fixes the poll cadence while a loop is parked on
the stream. With no explicit poll, the consumer uses exponential backoff so a
parked loop can inspect partial output and decide whether to wait or KILL. A
second coordinate of `0` disables timer polling for that stream; its eventual
closure still wakes the loop. Polling wakes the loop but never interrupts the
command.
