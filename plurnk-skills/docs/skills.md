# skills

An Agent Skill is a directory holding `SKILL.md` (`name` and `description` frontmatter, then instructions) and optional sibling references, scripts, and assets. Enabled skills appear at turn 0 as `skill://<name>/SKILL.md`; nothing is injected until read.

## Where skills come from

| Source | Root | Precedence |
| --- | --- | --- |
| `project` | `<project root>/.agents/skills/<name>/` | 1 (highest) |
| `plurnk` | `$XDG_CONFIG_HOME/plurnk/skills/<name>/` | 2 |
| `xdg-global` | `$XDG_CONFIG_HOME/agents/skills/<name>/` | 3 |
| `global` | `~/.agents/skills/<name>/` | 4 |
| `service` | Built-in service tree (`skill://plurnk/`) | 5 |

Environment definitions (`PLURNK_SKILLS_<alias>`) override filesystem roots, and the `skills` tool creates a workspace override above that:

```sh
PLURNK_SKILLS_code_review='{"source":"/srv/skills/code-review"}'
PLURNK_SKILLS_ENABLED=1
PLURNK_SKILLS_code_review_ENABLED=0
```

## Reading and authoring a skill

- Read instructions at `skill://<name>/SKILL.md` via `read` and list companion files via `find` (`{"path": "skill://<name>/**"}`).
- Run skill scripts with their runtime tool (`js`, `python3`, `sh`), for example `{"script": "skill://<name>/scripts/program.js", "args": ["..."]}`. `skill://` is read-only.
- Author or edit project skills at `.agents/skills/<name>/SKILL.md` via `edit` (or user-wide Plurnk skills across workspaces at `$XDG_CONFIG_HOME/plurnk/skills/<name>/SKILL.md`, `/learn --scope plurnk`); standard roots are rescanned before every turn and hot-loaded into `skill://<name>/`.

## Adding

| `skills` arguments | Effect |
| --- | --- |
| `{}` | List skills with status, provenance, and any Problem. |
| `{"alias": "sql-formatter"}` | Inspect one skill definition (read-only; `404` when absent). |
| `{"discover": "<source>"}` | Inspect a source (git `https`/`ssh` URL, `<server>:///skills`, folder, `SKILL.md`, or `.zip`/`.tar` archive) and return addable candidates without installing. |
| `{"alias": "sql-formatter", "source": "https://git.example/acme/skills.git", "ref"?: "main"}` | Bind and enable skill `alias` from `source` (optional git branch/tag `ref`). |
| `{"alias": "sql-formatter", "enabled": false}` | Disable (`false`) or re-enable (`true`) a skill without removing its definition. |
| `{"alias": "sql-formatter", "remove": true}` | Remove a workspace override and restore any inherited definition. |

- Local folders and `SKILL.md` paths stay live references; git, MCP, and archive sources materialize into workspace storage pinned to their commit or manifest digest.
