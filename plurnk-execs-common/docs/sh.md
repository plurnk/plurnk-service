# sh

`plurnk.sh` runs the `command` with `-c` in the shell its summary names: the
environment's `$SHELL`, or `/bin/sh` when that names no executable file. The command
reaches it character-perfect, whitespace included; write for that shell.

await plurnk.sh({ command: "printf 'hello\\n' > hello.txt\nwc -l hello.txt" }); // the command is the script itself

A `script` runs that script: `await plurnk.sh({ script: "greet.sh" });` runs it with no arguments;
`args` (an array of argument strings or a shell-quoted string) is passed as its arguments
(plain words split on whitespace, quoted arguments stay whole, nothing is
expanded). The interpreter reads the script directly, so it needs no executable
bit; a script path authored inside a shell `command` still follows the kernel's
ordinary executable-bit rules. The same applies to local, `session://`, and
`skill://` script targets across every interpreter.

## Environment

The command receives a scoped environment: provider keys and every `PLURNK_*`
setting are stripped before the child starts, so `printenv` cannot read
plurnk's credentials, and the project's environment passes through, overlaid
with the `env` registry (`mcp:///plurnk/env.json`).

## Working directory

The working directory is the workspace project root, or in a workspace without
one the directory the shell would run in anyway. Setting `cwd` overrides it for
an inline command (`await plurnk.sh({ command: "npm test", cwd: "packages/api" });`); a receipt names the
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

await plurnk.read({ path: "sh:///ab3d5678#stdout", range: "17,40" });

The observation carries the `exitCode`; a nonzero one is the command's answer,
not a failure. Stdout and stderr are separate channels,
and a diagnostic may be on either. The `log:///…/sh` receipt's own body is the
program exactly as sent, never output. A receipt with a non-200 status and no
`stream` address ran nothing; its body is still the program, and its Problem
says why it was refused.
