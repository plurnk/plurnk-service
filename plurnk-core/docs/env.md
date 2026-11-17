# env

Commands receive admitted ambient variables and cascaded runtime env files (`<project>/.agents/.env`, `$XDG_CONFIG_HOME/plurnk/env`, `~/.agents/.env`), then workspace defaults (`env:///NAME`), then session overrides (`env://<session>/NAME`).

| `env` arguments | Effect |
| --- | --- |
| `{}` | List effective variables, values, enabledness, and origins (`service`, `workspace`, `session`). |
| `{"discover": true}` | List settable variables declared by installed `.env.defaults` panels and `<project>/.env.example` (`"discover": "<query>"` or `{"discover": {"query"?: "...", "source"?: "..."}}` filters by name/comment or source). |
| `{"name": "NODE_ENV", "value": "production"}` | Set and enable a variable (verbatim string, no interpolation) for every subsequent command in this session. |
| `{"name": "CI", "enabled": false}` | Withdraw a variable (including an inherited ambient or workspace variable) from this session's commands without deleting the entry (`"enabled": true` restores it). |
| `{"name": "NODE_ENV", "remove": true}` | Remove this session's override and restore any inherited workspace or ambient value. |

- `env:///NAME` addresses workspace scope (`edit`/`kill` act on workspace defaults regardless of caller; returns `404` when `NAME` exists only in a session override). `env://<session>/NAME` addresses explicit overrides in `<session>` (`404` when `NAME` exists only in `env:///NAME`).
- Subprocesses (`sh`, `js`, `python3`) receive `$PLURNK_ENV` pointing to a scratch file; `KEY=VALUE` lines appended before exit are admitted into the caller's scope (`workspace` for `_plurnk`, `session` for model sessions).
- `PLURNK_*` and provider credential names are reserved and refused here; see `skill://plurnk/configuration/.env.defaults` for Plurnk settings and `mcp:///plurnk/mcp.json` for binding credentials to an MCP server via `${NAME}`.
