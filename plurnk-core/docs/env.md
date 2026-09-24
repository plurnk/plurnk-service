# env

Commands receive admitted ambient values, then workspace defaults, then your
worker's overrides. `list` shows the effective values and their origins.

## Workspace defaults

`"scope": "workspace"` on any verb manages the shared layer. These values
reach every worker's commands and newly started MCP servers, without depending
on which worker starts them:

````env (add)
{"scope":"workspace","alias":"NODE_ENV","definition":{"value":"production"}}
````

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
a workspace or ambient name of the same alias reappears, disabled, so removal never quietly
changes what your next command sees.

Your worker overrides are yours: another worker's commands do not see them. A worker
you spawn starts with a copy of them — `list` shows those as inherited from
you — and its changes never reach yours. Workspace defaults remain shared, not copied.

## For one command, or for one child

The heading's `[metadata]` takes `env`. On a command fence it is that run's
environment, over your entries, and it is gone when the run ends:

````sh [{"env": {"RUST_LOG": "debug"}}]
cargo test
````

On `WORK` and `FORK` the same metadata is the child's starting environment: a
copy of your entries first, then each name here becomes its own (`worker.md`).

## Names you cannot set

`PLURNK_*` and provider credential names are plurnk's own and never reach a
command, so `add` refuses them and tells you why.

## Finding a name

`discover` is this installation's configuration catalog: every knob an installed
package declares, with the declaring package as its provenance and its own
comment as the summary. It is not a permissions list — you may set any name —
it tells you which names have a consumer, and it is how you learn the name of a
value only the operator can supply. Such a value is referenced by its name; the
value itself never appears.
