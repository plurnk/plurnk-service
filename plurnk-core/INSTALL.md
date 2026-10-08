# Configuring plurnk-service

Each package's `.env.defaults` is its authoritative configuration reference.
`plurnk-service config defaults` prints the complete installed catalog, including
comments and optional examples. Inside Plurnk, READ
`skill://plurnk/.env.defaults` for the same catalog. Neither exposes effective
environment values or creates another configuration file.

## Install and locate

```sh
npm install -g @plurnk/plurnk-service
plurnk-service migrate
plurnk-service start
```

First start seeds the user's configuration once. No model ships active;
[choose a model route](https://github.com/plurnk/plurnk-service/blob/main/plurnk-providers/README.md#configure-a-model) before starting a model loop.

For an explicitly shared Linux daemon, the npm package includes an example
[systemd user unit](./plurnk.service). Its comments cover manual installation,
executable paths, environment, and logs. Installing the package never installs
or enables the unit.

| Resource | Default location |
| --- | --- |
| User configuration | `$XDG_CONFIG_HOME/plurnk/.env` (`~/.config/plurnk/.env`) |
| Operating policy | `$XDG_CONFIG_HOME/plurnk/AGENTS.md` |
| Database | `$XDG_DATA_HOME/plurnk/plurnk.db` (`~/.local/share/plurnk/plurnk.db`) |
| Project / global Agent Skills | `.agents/skills/` / `~/.agents/skills/` |
| Plurnk-only Agent Skills | `$XDG_CONFIG_HOME/plurnk/skills/` |
| Project / global MCP servers | `.agents/mcp.json` / `~/.agents/mcp.json` |
| Plurnk-only MCP servers | `$XDG_CONFIG_HOME/plurnk/mcp.json` |

Use `plurnk-service config` for paths and precedence, `config edit` to edit the
user file, and `config check` to validate it.

Invalid optional configuration stays visible without removing the repair environment.
`config check` is strict; ordinary startup keeps unrelated capabilities and client
inspection available. Model providers are constructed and verified on selection or
first use, not on startup. An invalid default never selects a different model:
choose a valid model in the client or correct the daemon's configuration.

## Backup and restore

The database holds worker history and workspace state. Its default path is in
the table above; `PLURNK_SERVICE_DB_PATH` overrides it, and
`PLURNK_SERVICE_STATE_ROOT` relocates the default. Back up the actual daemon's
database, not a different client's default.

Use SQLite's consistent-copy operation while the daemon is running **or** stopped
({§share-snapshot}). Copying only a live `.db` can omit committed data still in
its `-wal` file; copying those files separately is not a consistent snapshot.
This example uses Node, already required by Plurnk, and the default XDG path.
Choose a new destination for each backup:

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

Keep backups private: they include prompts, reasoning, and recorded tool output.
Back up project files, configuration, and extension-owned files separately; a
database snapshot does not copy them. `plurnk-service share` produces diagnostic
artifacts from a temporary snapshot and then removes that snapshot; it is not
a substitute for this backup.

To restore, stop the daemon and retain its old database and any `-wal`/`-shm`
sidecars together. Copy the backup to a fresh working path, select that path with
`PLURNK_SERVICE_DB_PATH`, and start the same or a newer compatible service version.
Do not overwrite a live database or pair a restored file with old sidecars.

## Precedence

Highest priority first ({§operator-config-precedence}):

| Source | Rule |
| --- | --- |
| Service CLI flags | Explicit values win over all environment layers. |
| Initial shell environment | Preserved over files. |
| `--env-file` / `--env-file-if-exists` | Repeatable; later files win. The optional form skips absent files. |
| `--config=<path>` | One explicit service configuration file. |
| `$XDG_CONFIG_HOME/plurnk/.env` | User configuration. |
| Installed packages' `.env.defaults` | Set-if-unset floor; duplicate key ownership fails boot. |

A working directory's `.env` belongs to that directory's application and is never read. A project's
variables reach its commands through the workspace environment (`/env import .env`).

For a service-owned variable, strip `PLURNK_`, lowercase, and replace `_` with
`-` to obtain its CLI flag: `PLURNK_SERVICE_MAX_TURNS` → `--service-max-turns`.
Extension settings remain environment/configuration values; they do not extend the
service CLI. Boolean flags use `1` and `0`. An empty value is not an unset value;
the owning declaration specifies its meaning.

## Choose the right scope

| Change | Owner and effect |
| --- | --- |
| Startup defaults or installed extension configuration | The daemon's environment cascade. A remote client's shell does not change it. |
| Model, reasoning, child model | Worker selections persist. Set them through client controls; changing a startup default does not retarget an existing Worker. |
| MCPs, skills, outbound agents, schedules, membership | Workspace Functionality: list, discover, add, enable, disable, remove. Workers share the workspace's current selection. |
| Command environment | `env` manages worker overrides or workspace defaults. It does not reconfigure the daemon; running processes keep their launch environment. |
| External capabilities | Service policy is a ceiling; workspace policy can narrow it for every worker. Hiding a doc does not grant or revoke authority. |
| Proposal review / YOLO | Decides who accepts or rejects an admitted operation. Automatic acceptance never overrides capability or resource permissions. |
| File creation and membership | Separate policies. Creating an out-of-root file, admitting a new file, and editing an existing member are distinct decisions. |
| User-facing behavior | Operating policy; use configuration for runtime controls. |

The [`@plurnk/plurnk-providers` README](https://github.com/plurnk/plurnk-service/blob/main/plurnk-providers/README.md#configure-a-model) covers alias tuning, reasoning and output
budgets, local endpoints, caching, and connectivity; the
[model chapter](skill://plurnk/references/models.md) is what a model is told.
The defaults catalog groups the remaining settings by their owning subsystem:
permissions, loop limits, residency, execution, context, indexing, MCP, A2A,
hooks, HTTP, and content handling. Search the catalog for that subsystem instead
of relying on a second list of knobs here.

For file-access questions, inspect the generated
[members reference](worker:///_plurnk/plurnk/members.md) alongside the file
creation/membership defaults. Client controls inspect effective capabilities;
a model cannot widen their ceiling by changing its policy prose.

## Skills

Project names shadow Plurnk-only names, then user-global names, then
service-provided skills. Agent Plugin skills join the same scope after standalone
skills; npm bundles follow user-global roots. These are read-only configuration inputs;
external edits appear at the next turn. Plurnk's own skill uses the same READ,
discovery, and workspace enablement as other skills.

`skills (add)` binds a source to this workspace, never installs into those roots.
Local folders and `SKILL.md` files stay live references, with supporting files in
place. Git/archive sources become workspace-owned copies retained across enable
and restart until the source definition changes. `remove` forgets the workspace
binding without deleting its source. READ is not execution; running a skill's
script follows ordinary proposal policy. The [skills reference](worker:///_plurnk/plurnk/skills.md)
covers discovery, source forms, and Git refs.

## Resource definitions

Supported standard sources, environment declarations, and live workspace changes
feed the same family. Whole definitions replace lower definitions; omitted fields
never inherit. Workspace overrides win over environment declarations, which win
over discovered sources. Independent behavior controls cascade separately.

```dotenv
PLURNK_MCP_docs={"name":"docs","type":"streamable-http","url":"https://docs.example/mcp"}
PLURNK_MCP_ENABLED=1
PLURNK_MCP_docs_ENABLED=0
```

MCP, skills, outbound A2A, schedule, and members use this same naming pattern;
their `.env.defaults` entries describe each family's definition and controls.
Aliases use lowercase names, with `_` encoding `-`; skills retain their standard
Unicode and digit-leading names. An empty definition is invalid, not a disable
instruction. A control may precede the resource it will govern.

| Action | Effect |
| --- | --- |
| Declare in configuration | Supply an inherited definition, enabled by default unless a control disables it. No workspace writes. |
| `list` | Inspect the effective definition, ownership (`origin`), winning configuration input (`provenance`), enabledness, and runtime readiness without starting it. |
| `discover` | Return inert candidates; nothing is added or enabled. |
| `add` | Persist a workspace override and prepare it through the ordinary authorization policy. |
| `disable` / `enable` | Change availability without forgetting the definition or updating fetched skill copies. |
| `remove` | Forget the local override and restore the inherited definition and enabledness. Use `disable` to suppress an inherited entry. |

Use the environment cascade for daemon/CI defaults and the subsystem actions for
live workspace changes. A declared or enabled resource never bypasses capability
or proposal policy. Unavailable resources retain their exact Problem in `list`.
Configuration provenance names the definition's environment key, discovered
`SKILL.md` path, or MCP JSON file and JSON Pointer, not a dotenv file or shadowed history. Local overrides are
workspace-owned; removing one exposes its current inherited source again.

## Extensions

An extension is native Plurnk code of one kind, declared once: under `plurnk` in an npm
package's `package.json`, or under `extensions.ai.plurnk` in a standard
[Agent Plugin](https://agent-plugins.org/specification)'s `plugin.json`, beside the plugin's
portable skills and MCP servers. Its kind's framework loads it with that kind's lifetime. A
module joins the daemon lifecycle:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example-plugin",
  "extensions": { "ai.plurnk": { "kind": "module", "module": "ai.plurnk/plugin.js" } }
}
```

An npm package declares the same module in its own manifest, naming an export subpath so the
package's export conditions select its entry:

```json
{
  "name": "@example/plurnk-module",
  "exports": { "./module": "./dist/module.js" },
  "plurnk": { "kind": "module", "module": "./module" }
}
```

Modules load at startup from installed npm packages and selected user roots:
`$XDG_CONFIG_HOME/plurnk/plugins/` before `~/.agents/plugins/`, then npm. The manifest name
identifies a plugin across those sources. Project plugins never load native code into the daemon.
`PLURNK_SERVICE_ROOTS` selects the directory roots; `PLURNK_EXTENSIONS_TRUSTED_ONLY` governs
extension imports, using the npm package name when present or the plugin name otherwise.
Other extension kinds (executors, schemes, providers, mimetypes and HTTP materializers)
require npm installation and retain their own loading behavior.

A module exports a lifecycle object or a no-argument factory: `setup` registers what it
contributes, `start` opens its ingress, `stop` drains its producers, and `close` releases its
registrations and observers. Extension files and the optional configuration panel live under
`ai.plurnk/`; its `.env.defaults` joins the ordinary floor. npm owns dependencies and delivery,
not a second extension declaration. [Extending Plurnk](skill://plurnk/references/extensibility.md)
covers every integration surface and links each kind's contract.
