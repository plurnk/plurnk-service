# sh

The `sh` fence runs the body via `sh -c`, character-perfect including whitespace.

```sh <!-- the body is the script itself -->
printf 'hello\n' > hello.txt
wc -l hello.txt
```

A script target runs that script: `sh (greet.sh)` runs it with an empty stdin;
a nonempty body becomes its stdin. The interpreter reads the script directly,
so it needs no executable bit; a script path authored inside a shell body still
follows the kernel's ordinary executable-bit rules. Script arguments go in
`[{"args": ["--release","two words"]}]`: each string is one literal argument,
without shell expansion. The target is a program, never a command and never a
directory; a target that is not a script is refused before anything runs. The
same options apply to local, `worker://`, and `skill://` script targets across
every interpreter.

## Environment

The command receives a scoped environment: provider keys and every `PLURNK_*`
setting are stripped before the child starts, so `printenv` cannot read
plurnk's credentials, and the project's environment passes through.
`[{"env": {"LC_ALL": "C"}}]` on the fence line sets variables for this run
alone, over the entries in the `env` registry (`env.md`); plurnk's own names
are refused by name.

## Working directory

The working directory is the workspace project root, or in a workspace without
one the directory the shell would run in anyway. `[{"cwd": "<directory>"}]` on
the fence line overrides it for its body; the receipt always names the
directory the command ran in.

## Channels

An execution is a host effect, admitted under the loop's policy. Output streams
under the receipt's `stream` address, such as `sh:///ab3d5678`: `#stdout` is
the default channel and `#stderr` the second; both are `text/stream`. While it
runs, the packet's `## Delegation` streams list reports each channel's size and
growth, and READ can inspect any range. On completion, the harness adds one
`_plurnk` READ per channel: its first page, `range` extent, and terminal exit
status. READ the observation's `path` for more; the `log:///…/READ` item holds
only its recorded page:

```READ (sh:///ab3d5678#stdout) <17,40>
```

A nonzero exit closes with status 500; stdout and stderr are separate channels,
and a diagnostic may be on either. The `log:///…/sh` receipt's own body is the
program exactly as sent, never output. A receipt with a non-200 status and no
`stream` address ran nothing; its body is still the program, and its Problem
says why it was refused.

## Lifetime

How long a command may run is one metadata field; absent, it ends with the loop.

```sh [{"lifetime": "30m"}]
npm run e2e
```

```sh [{"lifetime": "detached"}]
npm run dev
```

A duration (`30s`, `30m`, `2h`) kills the command at that deadline. `detached`
outlives the loop: it runs until it exits or is KILLed. `turn` keeps the command
only through the current turn. While a stream is live, observation wakes arrive
on the daemon's cadence and present it for inspection.

## Live input

`[{"stdin": "open"}]` keeps stdin open for later SENDs to the returned execution
address; `[{"eof": true}]` closes it. The worked example, including newline
framing, is on `node.md`.
