# sh

A shell command line, run via `sh -c`. Bare `EXEC` (no runtime tag) defaults to `sh`, so `<<EXEC:ls -la:EXEC` and `<<EXEC[sh]:ls -la:EXEC` are equivalent.

## Environment

The command runs with a **scoped** environment: the host daemon's own secrets — provider API keys and every `PLURNK_*` config var — are stripped before the child sees them, so `printenv` / `env` cannot read plurnk's credentials. The project's own environment passes through unchanged.

## Working directory

`EXEC[sh](./dir):…` runs in `./dir`. With no target the command runs in the session's project root — the same place the `file` scheme writes — so it finds files a prior `EDIT` just created, rather than the daemon's cwd.

## Channels

Output streams into two channels on the `exec://` entry: `#stdout` (default) and `#stderr` (both `text/stream`); `READ` the entry to see them. A host-effecting command proposes for review before it runs; a read-only one runs inline and returns its output the same turn. A non-zero exit closes the entry with status 500, the message on `stderr`.
