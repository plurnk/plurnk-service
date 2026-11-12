# Configuring plurnk-service

## Summary

Configure the settings cascade (`.env`), persistence, permissions, skills, personas, systemd, and nginx.

Each package's `.env.defaults` owns its declared keys. Inspect the complete catalog via `plurnk-service config defaults` or `skill://plurnk/configuration/.env.defaults`.

## Install and daemon lifecycle

```sh
npm install -g --ignore-scripts @plurnk/plurnk-service   # add --omit=optional for the lean microkernel without web UI, OTel SDK, or optional leaves
plurnk-service migrate
plurnk-service start
plurnk-service reload   # validate and hot-reload ~/.config/plurnk/.env in place
plurnk-service stop     # stop the running daemon and wait for exit
```

First start seeds `~/.config/plurnk/.env` and `AGENTS.md` once; `plurnk` autostarts this daemon when none listens (`PLURNK_CLIENT_AUTOSTART=0` disables). No model ships active — run `plurnk onboard` or [configure a model route](https://github.com/plurnk/plurnk-service/blob/main/plurnk-providers/README.md#configure-a-model).

### Linux `systemd --user` & `nginx`

Templates ship in `@plurnk/plurnk-service`: [`plurnk.service`](./plurnk.service) (`skill://plurnk/configuration/plurnk.service`) and [`plurnk.nginx.conf`](./plurnk.nginx.conf) (`skill://plurnk/configuration/plurnk.nginx.conf`).

| Concern | Rule |
| --- | --- |
| User unit (`~/.config/systemd/user/plurnk.service`) | Inherits `~/.config/environment.d/*.conf` (`0600`) for provider API keys without copying secrets into `~/.config/plurnk/.env`. Run `loginctl enable-linger "$USER"` to survive logout. |
| Hot-reload vs. restart | `.env`, `.env.local`, and `--config` reload automatically at turn/model/capability/`/health` boundaries or via `plurnk-service reload` / `systemctl --user reload plurnk`. Listener/storage/auth keys (`PLURNK_HOST`, `PLURNK_PORT`, `PLURNK_SERVICE_DB_PATH`, `PLURNK_SERVICE_STATE_ROOT`, `PLURNK_SERVICE_SQLITE_*`, `PLURNK_AUTH`, `PLURNK_SECRET`) and `environment.d` require `restart`. |
| Network exposure | Set `PLURNK_HOST=0.0.0.0` on a trusted LAN; front untrusted networks with [`plurnk.nginx.conf`](./plurnk.nginx.conf) (TLS, headers, rate limits) and `PLURNK_AUTH_ISSUER`. `/health` and `/healthz` answer `200` `{"status":"pass"}` (`503` while starting). |

### XDG & discovery paths

| Surface | Locations |
| --- | --- |
| User settings | `$XDG_CONFIG_HOME/plurnk/.env`, `.env.local` (`~/.config/plurnk/.env`) |
| Operating policy | `$XDG_CONFIG_HOME/plurnk/AGENTS.md` (`.local.md`), `$XDG_CONFIG_HOME/agents/AGENTS.md`, `~/.agents/AGENTS.md` |
| Database & autostart log | `$XDG_DATA_HOME/plurnk/plurnk.db` · `$XDG_STATE_HOME/plurnk/service.log` |
| Agent Skills | `.agents/skills/`, `$XDG_CONFIG_HOME/plurnk/skills/`, `$XDG_CONFIG_HOME/agents/skills/`, `~/.agents/skills/` |
| MCP servers | `.agents/mcp.json`, `$XDG_CONFIG_HOME/plurnk/mcp.json`, `$XDG_CONFIG_HOME/agents/mcp.json`, `~/.agents/mcp.json` |
| Personas | `.agents/personas/`, `$XDG_CONFIG_HOME/plurnk/personas/`, `$XDG_CONFIG_HOME/agents/personas/`, `~/.agents/personas/` |
| Agent Plugins | `.agents/plugins/`, `$XDG_CONFIG_HOME/plurnk/plugins/`, `$XDG_CONFIG_HOME/agents/plugins/`, `~/.agents/plugins/`, npm |

### `plurnk-service config` commands

| Subcommand | Behavior |
| --- | --- |
| `config` | Daemon status, systemd unit scope, paths, precedence, non-default overrides, and stale-file restart notice. |
| `config show [--json]` | Every resolved key, redacted effective value, and winning source layer. |
| `config defaults` | Complete commented `.env.defaults` catalog across all installed `@plurnk/*` packages. |
| `config edit` | Open `$XDG_CONFIG_HOME/plurnk/.env` in `$EDITOR`. |
| `config check` | Strictly validate settings, configured route credentials, env/dotenv credential conflicts, and undeclared `PLURNK_*` keys offline. |

## Precedence

Highest priority first (working-directory `.env` is never read into daemon config; pass project env via `/env import .env`):

1. Service CLI flags (`PLURNK_SERVICE_MAX_TURNS` → `--service-max-turns`; booleans `1`/`0`)
2. Initial shell environment
3. `--env-file` / `--env-file-if-exists` (repeatable; later wins)
4. `--config=<path>`
5. `$XDG_CONFIG_HOME/plurnk/.env.local`
6. `$XDG_CONFIG_HOME/plurnk/.env`
7. Installed `@plurnk/*` packages' `.env.defaults` floor

Host TLS CAs (`NODE_USE_SYSTEM_CA=0` opts out), `NODE_EXTRA_CA_CERTS`, and `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` apply across providers, HTTP schemes, remote MCP, and OTLP.

## Backup and restore

Use SQLite `VACUUM INTO` (safe while the daemon is running or stopped; never copy `.db` without consistent WAL handling):

```sh
(
  umask 077
  node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    try { db.prepare("VACUUM INTO ?").run(process.argv[2]); }
    finally { db.close(); }
  ' "${XDG_DATA_HOME:-$HOME/.local/share}/plurnk/plurnk.db" "$HOME/plurnk-backup.db"
)
```

- **Restore:** `plurnk-service stop`, keep old `.db`/`-wal`/`-shm` aside together, copy the backup to a fresh path (`PLURNK_SERVICE_DB_PATH`), and start the same or newer service. Project files, `.env`, and interactive MCP OAuth grants restore/reauthorize separately; schedules rearm from the present.
- **Durability & retention:** `PLURNK_SERVICE_SQLITE_SYNCHRONOUS` defaults to `NORMAL` (`FULL` syncs every commit; see `skill://plurnk/packages/@plurnk/plurnk-service/SPEC.md`). `PLURNK_SERVICE_RETAIN_*` expires historical packet/call payloads without erasing messages, receipts, or referenced attachments. `plurnk-service share` writes diagnostic digests, not restorable backups.

## Manual and shell completions

Relative to `$(npm root -g)/@plurnk/plurnk-service`:

| Artifact | Installation |
| --- | --- |
| `dist/man/plurnk-service.1` | Copy to `~/.local/share/man/man1/` or open with `man`. |
| `dist/completions/plurnk-service.bash` | Source from `~/.bashrc`. |
| `dist/completions/_plurnk-service` | Copy to a Zsh `fpath` directory before `compinit`. |
| `dist/completions/plurnk-service.fish` | Copy to `~/.config/fish/completions/`. |

## Scope & Functionality families

| Scope | Surface |
| --- | --- |
| Daemon defaults & extensions | Environment cascade ([provider tuning](https://github.com/plurnk/plurnk-service/blob/main/plurnk-providers/README.md#configure-a-model); model reference at `skill://plurnk/models.md`). |
| Session model, effort, child model | Persisted per session via client controls (`/model`, `/effort`, `/child`). |
| Workspace Functionality (`mcp`, `skills`, `personas`, `schedule`, `members`, `env`) | Shared actions: `list`, `discover`, `add`, `replace`, `enable`, `disable`, `remove`. Whole definitions replace lower layers: workspace overrides > `PLURNK_<FAMILY>_<alias>` env > project `.agents/` > `$XDG_CONFIG_HOME/plurnk/` > global `~/.agents/` > Agent Plugins (`mcp:///plurnk/skills.json`, `mcp:///plurnk/members.json`). |
| Capabilities & proposals | Service `PLURNK_SERVICE_CAPABILITIES` is a subtractive ceiling narrowed by workspace policy; YOLO/proposal posture (`PLURNK_SERVICE_PROPOSALS`) governs consent, never capability boundaries. |
| Plugins & extensions | Portable [Agent Plugins](https://agent-plugins.org/specification) (`plugin.json`) carry `skills/`, `personas/`, and `mcp.json` across `PLURNK_SERVICE_ROOTS` with zero in-process code. First-party `@plurnk/*` extensions and modules compose statically ([ARCHITECTURE.md § Extensibility](https://github.com/plurnk/plurnk-service/blob/main/ARCHITECTURE.md#extensibility), `skill://plurnk/extensibility.md`). |
