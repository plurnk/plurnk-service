# sh

A shell command line, run via `sh -c`. Bare `EXEC` (no runtime tag) defaults to `sh`, so `<|EXEC>ls -la<EXEC|>` and `<|EXEC[sh]>ls -la<EXEC|>` are equivalent.

## Environment

The command receives a **scoped** environment. Provider keys and every
`PLURNK_*` setting are stripped before the child starts, so `printenv` cannot
read plurnk's credentials. The project's environment passes through.

## Working directory

`EXEC[sh](./dir):…` runs in `./dir`. With no target, the command runs in the
workspace project root where file operations write—not in the daemon's own
working directory.

The target's filesystem type selects its role:

- A directory becomes the working directory.
- A file is the script to run. `<|EXEC[sh](greet.sh)|>` runs it with an
  empty stdin; a nonempty body becomes stdin.

The interpreter reads a targeted file directly, so it needs no executable bit.
A script path authored inside a shell body still follows the kernel's ordinary
executable-bit rules.

## Channels

Every shell invocation is host-effecting and proposes for review before it
runs. Output then streams under the emitted
`sh:///<loop>/<turn>/<sequence>` address: `#stdout` is the default channel and
`#stderr` is the second; both are `text/stream`. Running deltas stay folded and
the terminal delta opens on a later turn. READ the emitted address to revisit
or slice it. A nonzero exit closes with status 500; inspect both channels
because either may carry the useful diagnostic.

## Deadlines & polling — `<timeout, poll>`

For a long-running command, the `<L>` slot carries `<TIMEOUT_SECONDS, POLL_SECONDS>` (both seconds):

```plurnk
<|EXEC<1800>>npm run build<EXEC|>
<|EXEC<1800,300>>npm run e2e<EXEC|>
<|EXEC<-1,300>>npm run test<EXEC|>
<|EXEC<-1,0>>tail -f app.log<EXEC|>
```

The first coordinate is the timeout: a positive value kills at that deadline;
`-1` declines the per-operation deadline; `0` keeps the process only through
the current turn. Loop teardown still reaps surviving work. The optional
positive second coordinate fixes the poll cadence while a loop is parked on
the stream. With no explicit poll, the consumer uses exponential backoff so a
parked loop can inspect partial output and decide whether to wait or KILL. A
second coordinate of `0` disables timer polling for that stream; its eventual
closure still wakes the loop. Polling wakes the loop but never interrupts the
command.
