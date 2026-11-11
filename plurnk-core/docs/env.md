# env

Commands receive admitted ambient variables, then workspace defaults, then session overrides.

| Call | Effect |
| --- | --- |
| `plurnk.env({})` | List effective variables, values, enabledness, and origins (`service`, `workspace`, `session`). |
| `plurnk.env({ discover: true })` | List settable variables declared by installed `.env.defaults` panels (`discover: "<query>"` or `{ discover: { query?, source? } }` filters by name/comment or package). |
| `plurnk.env({ name: "NODE_ENV", value: "production" })` | Set and enable a variable (verbatim string, no interpolation) for every subsequent command in this session. |
| `plurnk.env({ name: "CI", enabled: false })` | Withdraw a variable (including an inherited ambient or workspace variable) from this session's commands without deleting the entry (`enabled: true` restores it). |
| `plurnk.env({ name: "NODE_ENV", remove: true })` | Remove this session's override and restore any inherited workspace or ambient value. |

plurnk.env({ name: "NODE_ENV", value: "production" })

- Session overrides are private to this session; spawned children start with a copy (`inherited`), and their changes do not affect the parent. Workspace defaults (`scope: "workspace"`) are shared.
- `PLURNK_*` and provider credential names are reserved and refused here; see `skill://plurnk/configuration/.env.defaults` for Plurnk settings and `mcp:///plurnk/mcp.json` for binding credentials to an MCP server via `${NAME}`.

## Command execution and waiting

Commands run with the session's active environment in the project root (or `cwd`):

plurnk.sh({ text: "npm run e2e" })

plurnk.sh({ text: "npm run dev" })

`plurnk.wait`'s `seconds` bounds the wait while a command or child session runs.
