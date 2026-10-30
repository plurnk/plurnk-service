# sh

The `sh` fence runs the body with `-c` in the shell its summary names: the
environment's `$SHELL`, or `/bin/sh` when that names no executable file. The body
reaches it character-perfect, whitespace included; write for that shell.

```sh <!-- the body is the script itself -->
printf 'hello\n' > hello.txt
wc -l hello.txt
```

A script target runs that script: `sh (greet.sh)` runs it with no arguments;
a nonempty body is tokenized by shell quoting and passed as its arguments
(plain words split on whitespace, quoted arguments stay whole, nothing is
expanded). The interpreter reads the script directly, so it needs no executable
bit; a script path authored inside a shell body still follows the kernel's
ordinary executable-bit rules. The same applies to local, `session://`, and
`skill://` script targets across every interpreter.

## Environment

The command receives a scoped environment: provider keys and every `PLURNK_*`
setting are stripped before the child starts, so `printenv` cannot read
plurnk's credentials, and the project's environment passes through, overlaid
with the `env` registry (`mcp:///plurnk_env.md`).

## Working directory

The working directory is the workspace project root, or in a workspace without
one the directory the shell would run in anyway. A directory in the `(target)`
slot overrides it for an inline body (`sh (packages/api)`); a receipt names the
directory, relative to the project root, only when the command ran elsewhere.

## Channels

An execution is a host effect, subject to approval. Output streams
under the receipt's `stream` address, such as `sh:///ab3d5678`: `#stdout` is
the default channel and `#stderr` the second; both are `text/stream`. While it
runs, the packet's `## Open Work` streams list reports each channel's size and
growth, and READ can inspect any range. On completion, the harness adds one
`_plurnk` READ per channel: the whole output when it fits the context budget,
otherwise a bodiless receipt naming its size, with the `range` extent and the
terminal exit status. READ a range of the observation's `path` for any part:

```READ (sh:///ab3d5678#stdout) <17,40>
```

The observation carries the `exitCode`; a nonzero one is the command's answer,
not a failure. Stdout and stderr are separate channels,
and a diagnostic may be on either. The `log:///…/sh` receipt's own body is the
program exactly as sent, never output. A receipt with a non-200 status and no
`stream` address ran nothing; its body is still the program, and its Problem
says why it was refused.

## Lifetime

The heading's `lifetime` metadata bounds the command's total runtime, not idle
time. This command is stopped after 30 seconds if it has not finished:

```sh [{"lifetime": "30s"}]
npm test
```

Expiry closes the stream with status 504. By contrast, `WAIT [30]` limits one
wait to 30 seconds without stopping the command. Without `lifetime`,
the command is loop-bound; see `env.md` for other lifetime values.
