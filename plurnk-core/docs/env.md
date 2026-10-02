# env

Commands receive admitted ambient values, then workspace defaults, then your
worker's overrides. `list` shows the effective values and their origins.

## Workspace defaults

`"scope": "workspace"` on any verb manages the shared layer. These values
reach every worker's commands and newly started MCP servers, without depending
on which worker starts them:

```env (add)
{"scope":"workspace","alias":"NODE_ENV","definition":{"value":"production"}}
```

Omitting `scope` selects your worker. Its overrides do not configure shared MCPs.
Workspace changes affect subsequent launches; running processes keep their
existing environment.

## Your entries

`add` sets one variable for every command you run from now on. The name is the
alias, `{ "value": "…" }` the definition, used verbatim: no interpolation, no
escapes. It persists until you `remove` it. This is a registry, not a prefix —
`CARGO_TARGET_DIR=/tmp/x cargo build` sets a value for one command; `add` sets
it for all of them.

`disable` withdraws a name from your commands while keeping the entry listed;
`enable` restores it. For an ambient name that is how `CI=1` goes away for you
alone, without the operator changing anything. `remove` forgets your own entry;
a workspace or ambient name of the same alias reappears with its inherited value
and enabledness. Use `disable` when you want the name absent from commands.

Your worker overrides are yours: another worker's commands do not see them. A worker
you spawn starts with a copy of them — `list` shows those as inherited from
you — and its changes never reach yours. Workspace defaults remain shared, not copied.

## For one command, or for one child

The heading's `[metadata]` takes `env`. On a command fence it is that run's
environment, over your entries, and it is gone when the run ends:

```sh [{"env": {"RUST_LOG": "debug"}}]
cargo test
```

On `WORK` and `FORK` the same metadata is the child's starting environment: a
copy of your entries first, then each name here becomes its own. The complete
header-and-task examples are in `delegation.md`.

## `lifetime`: how long a command runs

The other field the heading's `[metadata]` takes on a command fence. Absent, the
run ends with the loop.

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

## Names you cannot set

`PLURNK_*` and provider credential names are plurnk's own and never reach a
command, so `add` refuses them and tells you why.

## Finding a name

`discover` lists the names installed packages declare that `env` may set, with
the declaring package as provenance and its comment as the summary. Undeclared,
non-reserved names are also allowed. Plurnk's own configuration and provider
credential names are excluded; READ `skill://plurnk/.env.defaults` for the full
configuration reference. Discovery shows declarations, not effective values.
