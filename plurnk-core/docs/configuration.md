# Configuration

## Summary

Environment cascade (`.env`), XDG discovery paths, workspace Functionality families, capability and proposal policy, `plurnk-service` CLI, `systemd`/`nginx` templates, and database durability.

## Precedence and reload

Higher layers override lower layers; each installed `@plurnk/*` package owns its declared keys in `skill://plurnk/configuration/.env.defaults`:

1. Service CLI flags (`PLURNK_SERVICE_MAX_TURNS` → `--service-max-turns`; booleans `1`/`0`)
2. Initial shell environment (provider API keys and `PLURNK_SECRET` / `PLURNK_PASS` live here or in `~/.config/environment.d/*.conf`)
3. `--env-file` / `--env-file-if-exists` (repeatable; later wins)
4. `--config=<path>`
5. `$XDG_CONFIG_HOME/plurnk/.env.local`
6. `$XDG_CONFIG_HOME/plurnk/.env`
7. Installed `@plurnk/*` packages' `.env.defaults` floor (`skill://plurnk/configuration/.env.defaults`)

- A working-directory `.env` never configures the daemon; session and workspace command variables live in the `env` tool (`mcp:///plurnk/env.json`).
- `$XDG_CONFIG_HOME/plurnk/.env`, `.env.local`, `--config`, and `--env-file*` hot-reload when their file signature changes or on `plurnk-service reload` (`SIGHUP`). Bind-time keys (`PLURNK_HOST`, `PLURNK_PORT`, `PLURNK_SERVICE_DB_PATH`, `PLURNK_SERVICE_STATE_ROOT`, `PLURNK_SERVICE_SQLITE_*`, `PLURNK_AUTH`, `PLURNK_SECRET`) keep their boot values until daemon restart.
- Host TLS CAs (`NODE_USE_SYSTEM_CA`, `NODE_EXTRA_CA_CERTS`) and `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` apply across providers, HTTP schemes, remote MCP, and OTLP.

## XDG and discovery paths

| Surface | Locations |
| --- | --- |
| User settings | `$XDG_CONFIG_HOME/plurnk/.env`, `.env.local` (`~/.config/plurnk/.env`) |
| Operating policy | `$XDG_CONFIG_HOME/plurnk/AGENTS.md` (`.local.md`), `$XDG_CONFIG_HOME/agents/AGENTS.md`, `~/.agents/AGENTS.md`, `<project>/AGENTS.md` (`.local.md`), `session://<session>/AGENTS.md` |
| Database & autostart log | `$XDG_DATA_HOME/plurnk/plurnk.db` · `$XDG_STATE_HOME/plurnk/service.log` (`PLURNK_SERVICE_STATE_ROOT` relocates `{data,state,cache,runtime}`; `PLURNK_SERVICE_DB_PATH` overrides the database path) |
| Agent Skills | `.agents/skills/`, `$XDG_CONFIG_HOME/plurnk/skills/`, `$XDG_CONFIG_HOME/agents/skills/`, `~/.agents/skills/` |
| MCP servers | `.agents/mcp.json`, `$XDG_CONFIG_HOME/plurnk/mcp.json`, `$XDG_CONFIG_HOME/agents/mcp.json`, `~/.agents/mcp.json` |
| Personas | `.agents/personas/`, `$XDG_CONFIG_HOME/plurnk/personas/`, `$XDG_CONFIG_HOME/agents/personas/`, `~/.agents/personas/` |
| Agent Plugins | `.agents/plugins/`, `$XDG_CONFIG_HOME/plurnk/plugins/`, `$XDG_CONFIG_HOME/agents/plugins/`, `~/.agents/plugins/`, npm |

Files owned by other agents (`CLAUDE.md`, `.cursor*`, `.windsurf*`, `SOUL.md`) are not read automatically.

## Scope and Functionality families

| Scope | Surface |
| --- | --- |
| Model routes & generation | `PLURNK_MODEL_<alias>` route declarations, `PLURNK_MODEL`, and `PLURNK_MODEL_CHILD`; session model, effort, and child model persist per session (`skill://plurnk/configuration/models.md`). |
| Workspace Functionality (`mcp`, `skills`, `personas`, `schedule`, `members`, `env`) | Operated via `mcp:///plurnk/<family>.json` tools (`list`, `discover`, `add`, `replace`, `enable`, `disable`, `remove`). Whole definitions override lower layers: workspace overrides > `PLURNK_<FAMILY>_<alias>` env > project `.agents/` > `$XDG_CONFIG_HOME/plurnk/` > global `~/.agents/` > Agent Plugins. |
| Capabilities & proposals | `PLURNK_SERVICE_CAPABILITIES` sets the subtractive capability ceiling narrowed by workspace policy; `PLURNK_SERVICE_PROPOSALS` and `PLURNK_SERVICE_EFFECT_{HOST,READ,PURE}` govern proposal review versus automatic admission. |
| Plugins & extensions | Portable `plugin.json` bundles (`skills/`, `personas/`, `mcp.json`) across `PLURNK_SERVICE_ROOTS`, ACP v2 `/acp` clients, `/notifications` SSE consumers, and first-party `@plurnk/*` extensions (`skill://plurnk/configuration/extensibility.md`). |

## Daemon CLI, templates, and durability

| Surface | Behavior |
| --- | --- |
| `plurnk-service config` | Daemon status from the database lock (PID, ACP/`/health` URLs, auth posture, live model route, overrides, and `restartRequired` notices), systemd unit scope, and template paths. |
| `plurnk-service config show [--json]` | Every resolved key, redacted effective value, and winning source layer. |
| `plurnk-service config defaults` | Commented `.env.defaults` catalog across all installed `@plurnk/*` packages. |
| `plurnk-service config check` | Offline validation of settings, configured route credentials, env/dotenv credential drift, and undeclared `PLURNK_*` keys. |
| `plurnk-service migrate` / `start` / `reload` / `stop` | Schema migration, foreground daemon start, hot-reload of `.env` layers, and graceful shutdown. |
| Templates | `skill://plurnk/configuration/plurnk.service` (`~/.config/systemd/user/plurnk.service`, reading `0600` `~/.config/environment.d/*.conf`) and `skill://plurnk/configuration/plurnk.nginx.conf` (TLS reverse proxy with `PLURNK_AUTH=1` and `PLURNK_AUTH_ISSUER`; `/health` and `/healthz` return `200` `{"status":"pass"}` when ready, `503` while starting). |
| Backup & retention | SQLite `VACUUM INTO '<backup.db>'` writes a consistent snapshot while running or stopped. `PLURNK_SERVICE_SQLITE_SYNCHRONOUS` sets WAL sync mode; `PLURNK_SERVICE_RETAIN_*` bounds historical packet/response payload retention while keeping messages, receipts, and referenced attachments; `plurnk-service share` exports diagnostic digests, not restorable backups. |
