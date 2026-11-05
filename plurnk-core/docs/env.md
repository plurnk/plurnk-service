# env

Commands receive admitted ambient values, then workspace defaults, then your
session's overrides. `list` shows the effective values and their origins.

## Workspace defaults

`"scope": "workspace"` on any verb manages the shared layer. These values
reach every session's commands and newly started MCP servers, without depending
on which session starts them:

await plurnk.env({ scope: "workspace", alias: "NODE_ENV", value: "production" });

Omitting `scope` selects your session. Its overrides do not configure shared MCPs.
Workspace changes affect subsequent launches; running processes keep their
existing environment.

## Your entries

`add` declares and enables one variable for every command you run from now on. The name is the
alias, `value` the exact string, used verbatim: no interpolation, no
escapes. It persists until you `remove` it. This is a registry, not a prefix —
`CARGO_TARGET_DIR=/tmp/x cargo build` sets a value for one command; `add` sets
it for all of them.

`replace` takes the same `{alias, value}` to change a value, retaining its
enabledness. A new name is created enabled. Both verbs accept workspace scope.

`disable` withdraws a name from your commands while keeping the entry listed;
`enable` restores it. For an ambient name that is how `CI=1` goes away for you
alone, without the operator changing anything. `remove` forgets your own entry;
a workspace or ambient name of the same alias reappears with its inherited value
and enabledness. Use `disable` when you want the name absent from commands.

Your session overrides are yours: another session's commands do not see them. A session
you spawn starts with a copy of them — `list` shows those as inherited from
you — and its changes never reach yours. Workspace defaults remain shared, not copied.

## Command execution and waiting

Commands run with the session's active environment variables in the project root (or an explicit `cwd`):

await plurnk.sh({ command: "npm run e2e" });

await plurnk.sh({ command: "npm run dev" });

`plurnk.wait`'s duration (`seconds`) bounds the wait for inspection while a command or child session runs.

## Names managed elsewhere

`PLURNK_*` and provider credential names are reserved in `env` entries.
Plurnk configuration belongs in the environment cascade;
read `skill://plurnk/configuration/.env.defaults` for its reference. An MCP definition can
explicitly bind an operator credential without adding it to every command's
environment; read `mcp:///plurnk/mcp.json` for that setup.

## Finding a name

`discover` lists the names installed packages declare that `env` may set, with
the declaring package as provenance and its comment as the summary. Undeclared,
non-reserved names are also allowed. Plurnk's own configuration and provider
credential names are excluded; read `skill://plurnk/configuration/.env.defaults` for the full
configuration reference. Discovery shows declarations, not effective values.
