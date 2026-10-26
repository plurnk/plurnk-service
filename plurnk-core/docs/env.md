# env

Commands receive admitted ambient values, then workspace defaults, then your
session's overrides. `list` shows the effective values and their origins.

## Workspace defaults

`"scope": "workspace"` on any verb manages the shared layer. These values
reach every session's commands and newly started MCP servers, without depending
on which session starts them:

```plurnk (env)
{"verb":"add","scope":"workspace","alias":"NODE_ENV","definition":{"value":"production"}}
```

Omitting `scope` selects your session. Its overrides do not configure shared MCPs.
Workspace changes affect subsequent launches; running processes keep their
existing environment.

## Your entries

`add` declares and enables one variable for every command you run from now on. The name is the
alias, `{ "value": "…" }` the definition, used verbatim: no interpolation, no
escapes. It persists until you `remove` it. This is a registry, not a prefix —
`CARGO_TARGET_DIR=/tmp/x cargo build` sets a value for one command; `add` sets
it for all of them.

`replace` takes the same `{alias, definition}` to change a value, retaining its
enabledness. A new name is created enabled. Both verbs accept workspace scope.

`disable` withdraws a name from your commands while keeping the entry listed;
`enable` restores it. For an ambient name that is how `CI=1` goes away for you
alone, without the operator changing anything. `remove` forgets your own entry;
a workspace or ambient name of the same alias reappears with its inherited value
and enabledness. Use `disable` when you want the name absent from commands.

Your session overrides are yours: another session's commands do not see them. A session
you spawn starts with a copy of them — `list` shows those as inherited from
you — and its changes never reach yours. Workspace defaults remain shared, not copied.

## `lifetime`: how long a command runs

The heading's `[metadata]` takes `lifetime` on a command fence. Absent, the
run ends with the loop.

```sh [{"lifetime": "30m"}]
npm run e2e
```

```sh [{"lifetime": "detached"}]
npm run dev
```

A duration (`30s`, `30m`, `2h`) kills the command at that deadline. `detached`
outlives the loop: it runs until it exits or is KILLed. `turn` keeps the command
only through the current turn. WAIT's duration bounds the wait for inspection,
not the command's lifetime.

## Names managed elsewhere

`PLURNK_*` and provider credential names are reserved in `env` entries.
Plurnk configuration belongs in the environment cascade;
READ `skill://plurnk/.env.defaults` for its reference. An MCP definition can
explicitly bind an operator credential without adding it to every command's
environment; READ `workspace:///_plurnk/tools/plurnk/mcp.json` for that setup.

## Finding a name

`discover` lists the names installed packages declare that `env` may set, with
the declaring package as provenance and its comment as the summary. Undeclared,
non-reserved names are also allowed. Plurnk's own configuration and provider
credential names are excluded; READ `skill://plurnk/.env.defaults` for the full
configuration reference. Discovery shows declarations, not effective values.
