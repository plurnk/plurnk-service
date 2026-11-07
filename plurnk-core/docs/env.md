# env

Commands receive admitted ambient values, then workspace defaults, then your
session's overrides. Calling `await plurnk.env({});` lists the effective values and their origins.

## Your entries

Adding an entry (`{ name, value }`) declares and enables one variable for every command you run from now on. `name` is the
variable name, `value` the exact string, used verbatim: no interpolation, no
escapes. It persists until you remove it (`{ name, remove: true }`). This is a registry, not a prefix —
`CARGO_TARGET_DIR=/tmp/x cargo build` sets a value for one command; `plurnk.env` sets
it for all of them:

await plurnk.env({ name: "NODE_ENV", value: "production" });

Passing `{ name, value }` for an existing name updates its value while retaining its
enabledness. A new name is created enabled.

Passing `{ name, enabled: false }` withdraws a name from your commands while keeping the entry listed;
`{ name, enabled: true }` restores it. For an ambient name that is how `CI=1` goes away for you
alone, without the operator changing anything. Passing `{ name, remove: true }` forgets your own entry;
a workspace or ambient name of the same variable reappears with its inherited value
and enabledness. Use `enabled: false` when you want the name absent from commands.

Your session overrides are yours: another session's commands do not see them. A session
you spawn starts with a copy of them — `plurnk.env({})` shows those as inherited from
you — and its changes never reach yours. Workspace defaults remain shared, not copied.

## Command execution and waiting

Commands run with the session's active environment variables in the project root (or an explicit `cwd`):

await plurnk.sh({ code: "npm run e2e" });

await plurnk.sh({ code: "npm run dev" });

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
