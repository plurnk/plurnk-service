# env

Every command you run receives a composed environment, never the host's. The
ambient names are what the operator's ceiling admits; your own entries sit above
them, and both are yours to shape. `list` shows exactly what your next command
will see, each value with its origin.

## Your entries

`add` sets one variable for every command you run from now on. The name is the
alias, `{ "value": "…" }` the definition, used verbatim: no interpolation, no
escapes. It persists until you `remove` it. This is a registry, not a prefix —
`CARGO_TARGET_DIR=/tmp/x cargo build` sets a value for one command; `add` sets
it for all of them.

`disable` withdraws a name from your commands while keeping the entry listed;
`enable` restores it. For an ambient name that is how `CI=1` goes away for you
alone, without the operator changing anything. `remove` forgets your own entry;
an ambient name of the same alias reappears, disabled, so removal never quietly
changes what your next command sees.

Your entries are yours: another worker's commands do not see them.

## Names you cannot set

`PLURNK_*` and provider credential names are plurnk's own and never reach a
command, so `add` refuses them and tells you why.

## Finding a name

`discover` is this installation's configuration catalog: every knob an installed
package declares, with the declaring package as its provenance and its own
comment as the summary. It is not a permissions list — you may set any name —
it tells you which names have a consumer, and it is how you learn the name of a
value only the operator can supply. Refer to such a value by its name; you never
need to see it.
