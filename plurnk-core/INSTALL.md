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

Use `plurnk-service config` for paths and precedence, `config edit` to edit the
user file, and `config check` to validate it. An old `~/.plurnk` is not read
implicitly; `plurnk-service paths migrate` relocates it with the daemon stopped.

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
Plugin settings remain environment/configuration values; they do not extend the
service CLI. Boolean flags use `1` and `0`. An empty value is not an unset value;
the owning declaration specifies its meaning.

## Choose the right scope

| Change | Owner and effect |
| --- | --- |
| Startup defaults or installed plugin configuration | The daemon's environment cascade. A remote client's shell does not change it. |
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
service-provided skills. These roots are read-only configuration inputs;
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
Configuration provenance names the definition's environment key or discovered
`SKILL.md` path, not a dotenv file or shadowed history. Local overrides are
workspace-owned; removing one exposes its current inherited source again.
