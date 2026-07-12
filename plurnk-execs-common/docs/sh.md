# sh

A shell command line, run via `sh -c`. Bare `EXEC` (no runtime tag) defaults to `sh`, so `<<EXEC:ls -la:EXEC` and `<<EXEC[sh]:ls -la:EXEC` are equivalent.

## Environment

The command runs with a **scoped** environment: the host daemon's own secrets — provider API keys and every `PLURNK_*` config var — are stripped before the child sees them, so `printenv` / `env` cannot read plurnk's credentials. The project's own environment passes through unchanged.

## Working directory

`EXEC[sh](./dir):…` runs in `./dir`. With no target the command runs in the session's project root — the same place the `file` scheme writes — so it finds files a prior `EDIT` just created, rather than the daemon's cwd.

## Channels

Output streams into two channels on the `exec://` entry: `#stdout` (default) and `#stderr` (both `text/stream`). A host-effecting command proposes for review before it runs; a read-only one runs without the review pause. The stream opens when the command concludes — for a quick command, right on your next turn (folded only while it still runs); READ the entry to revisit or slice it. A non-zero exit closes the entry with status 500, the message on `stderr`.

## Deadlines & polling — `<timeout, poll>`

For a long-running command, the `<L>` slot carries `<TIMEOUT_SECONDS, POLL_SECONDS>` (both seconds):

```
<<EXEC<1800>:npm run build:EXEC         hard-kill at 1800s; wake on completion
<<EXEC<1800,300>:npm run e2e:EXEC       bounded at 1800s + wake every 300s
<<EXEC<-1,300>:npm run test:EXEC        no deadline (-1) + wake every 300s
```

The **timeout** (first, required when the slot is used) bounds the run — at the deadline the command is killed. **`-1` declines a deadline** (unlimited); the run is still reaped when the loop ends, and you remain free to `KILL` it. The optional **poll** (second) wakes the loop on that cadence while the stream is open, so you can `READ` partial output and decide to wait or `KILL` — it never interrupts the command. A poll always requires a timeout (it's the second coordinate); bare `EXEC` with no slot runs to completion, bounded only by the loop.
