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
choose a model route before starting a model loop. The version-1 database
baseline is disposable during development.

| Resource | Default location |
| --- | --- |
| User configuration | `$XDG_CONFIG_HOME/plurnk/.env` (`~/.config/plurnk/.env`) |
| Operating policy | `$XDG_CONFIG_HOME/plurnk/AGENTS.md` |
| Database | `$XDG_DATA_HOME/plurnk/plurnk.db` (`~/.local/share/plurnk/plurnk.db`) |
| Project configuration | `.env` in the service's working directory |
| Project / global Agent Skills | `.agents/skills/` / `~/.agents/skills/` |

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
| `./.env` | Service working-directory configuration. |
| `$XDG_CONFIG_HOME/plurnk/.env` | User configuration. |
| Installed packages' `.env.defaults` | Set-if-unset floor; duplicate key ownership fails boot. |

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
| MCPs, skills, agents | Worker Functionality: list, discover, add, enable, disable, remove. Children inherit their parent's effective selection. |
| External capabilities | Service policy is a ceiling; workspace, Worker, and loop layers can narrow it. Hiding a doc does not grant or revoke authority. |
| Proposal review / YOLO | Decides who accepts or rejects an admitted operation. Automatic acceptance never overrides capability or resource permissions. |
| File creation and membership | Separate policies. Creating an out-of-root file, admitting a new file, and editing an existing member are distinct decisions. |
| User-facing behavior | Operating policy; use configuration for runtime controls. |

The [model chapter](skill://plurnk/references/models.md) covers alias tuning,
reasoning and output budgets, local endpoints, caching, and connectivity.
The defaults catalog groups the remaining settings by their owning subsystem:
permissions, loop limits, residency, execution, context, indexing, MCP, A2A,
hooks, HTTP, and content handling. Search the catalog for that subsystem instead
of relying on a second list of knobs here.

For file-access questions, inspect the generated
[members reference](worker://~/_plurnk/plurnk/members.md) alongside the file
creation/membership defaults. Client controls inspect effective capabilities;
a model cannot widen their ceiling by changing its policy prose.

## Skills

Project names shadow global names, which shadow service-provided skills.
Plurnk's own skill uses the same discovery, READ, and per-Worker enablement as
installed skills. It is not copied into a universal root.

Clients use `worker.skills.{list,discover,add,enable,disable,remove}`; models use
the generated `EXEC [skills]` interface. `discover` returns candidates without
installation. `add` installs through the standard skills CLI into the chosen
project or global scope; `remove` uninstalls a Worker-origin installation.
Service-provided entries can be disabled, not uninstalled through that action.
An external installer changes the available catalog at the next turn.

Project installation is local to that project. Global installation intentionally
shares the skill with other compatible agents using `~/.agents/skills/`.
Supporting files stay in their original tree, including script siblings.
READ is not execution, and EXEC still follows ordinary proposal policy.
